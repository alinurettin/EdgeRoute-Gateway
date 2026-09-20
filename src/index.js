// EdgeRoute-Gateway v2.0.0 - Production HTTP Server & Gateway Controller
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { EdgeRouteGateway } = require('./engine');

const gateway = new EdgeRouteGateway();
const PORT = parseInt(process.env.PORT, 10) || 6011;
const publicDir = path.join(__dirname, '..', 'public');
const startTime = Date.now();

function requestHandler(req, res) {
  const reqUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = reqUrl.pathname;

  // CORS Headers
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
    });
    return res.end();
  }

  // SSE Live Stream Endpoint
  if (req.method === 'GET' && pathname === '/api/events/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 3000\n\n');

    const initData = JSON.stringify({
      type: 'INIT',
      metrics: gateway.metrics(),
      timestamp: Date.now()
    });
    res.write(`event: init\ndata: ${initData}\n\n`);

    gateway.subscribe(res);
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const jsonRes = (statusCode, data) => {
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(data));
    };

    // 1. Health API
    if (pathname === '/api/health') {
      return jsonRes(200, {
        status: 'UP',
        service: 'EdgeRoute-Gateway',
        version: '2.0.0',
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        timestamp: new Date().toISOString()
      });
    }

    // 2. Stats & Telemetry API
    if (pathname === '/api/stats') {
      return jsonRes(200, {
        success: true,
        service: 'EdgeRoute-Gateway',
        version: '2.0.0',
        metrics: gateway.metrics()
      });
    }

    // 3. List Routes API
    if (req.method === 'GET' && pathname === '/api/routes') {
      return jsonRes(200, {
        success: true,
        routes: Array.from(gateway.routes.values())
      });
    }

    // 4. Register Route API
    if (req.method === 'POST' && pathname === '/api/routes') {
      try {
        const data = JSON.parse(body || '{}');
        const route = gateway.registerRoute(data);
        return jsonRes(200, { success: true, route });
      } catch (err) {
        return jsonRes(400, { success: false, error: err.message });
      }
    }

    // 5. List Upstreams API
    if (req.method === 'GET' && pathname === '/api/upstreams') {
      return jsonRes(200, {
        success: true,
        upstreams: Array.from(gateway.upstreams.values()).map(u => ({
          id: u.id,
          url: u.url,
          weight: u.weight,
          healthy: u.healthy,
          activeConnections: u.activeConnections,
          totalRequests: u.totalRequests,
          totalErrors: u.totalErrors,
          avgLatencyMs: u.avgLatencyMs
        }))
      });
    }

    // 6. Add Upstream API
    if (req.method === 'POST' && pathname === '/api/upstreams') {
      try {
        const data = JSON.parse(body || '{}');
        const node = gateway.addUpstream(data.id, data.url, data.weight || 1);
        return jsonRes(200, { success: true, upstream: node });
      } catch (err) {
        return jsonRes(400, { success: false, error: err.message });
      }
    }

    // 7. Toggle Upstream Health API
    const healthToggleMatch = pathname.match(/^\/api\/upstreams\/([^/]+)\/health$/);
    if (req.method === 'PUT' && healthToggleMatch) {
      try {
        const upstreamId = healthToggleMatch[1];
        const data = JSON.parse(body || '{}');
        const healthy = data.healthy !== undefined ? Boolean(data.healthy) : true;
        gateway.setUpstreamHealth(upstreamId, healthy);
        return jsonRes(200, { success: true, upstreamId, healthy });
      } catch (err) {
        return jsonRes(400, { success: false, error: err.message });
      }
    }

    // 8. Gateway Resolve Route API (Simulator)
    if (req.method === 'POST' && pathname === '/api/gateway/resolve') {
      try {
        const data = JSON.parse(body || '{}');
        const reqPath = data.path || '/';
        const clientKey = data.clientKey || '192.168.1.100';
        const resolution = gateway.resolve(reqPath, clientKey);

        if (resolution.matched && resolution.selectedUpstream) {
          // Simulate latency recording
          const fakeLatency = Math.floor(2 + Math.random() * 8);
          gateway.recordRequestFinished(resolution.selectedUpstream.id, fakeLatency, true);
        }

        return jsonRes(200, { success: true, resolution });
      } catch (err) {
        return jsonRes(400, { success: false, error: err.message });
      }
    }

    // 9. Static Web UI Files
    let filePath = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8'
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
      return res.end(fs.readFileSync(filePath));
    }

    jsonRes(404, { error: 'Endpoint not found' });
  });
}

function startServer(portToUse = PORT, callback) {
  const server = http.createServer(requestHandler);
  server.listen(portToUse, callback);
  return server;
}

if (require.main === module) {
  startServer(PORT, () => {
    console.log(`⚡ EdgeRoute-Gateway v2.0.0 live at http://localhost:${PORT}`);
  });
}

module.exports = { startServer, gateway };
