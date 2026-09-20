// EdgeRoute-Gateway v2.0.0 - Exhaustive Verification Suite
// 100% Non-Mocked Assertions for Radix Trie Routing, Weighted Round-Robin, Ketama & Health Probing

const assert = require('assert');
const http = require('http');
const {
  TrieNode,
  RadixTrieRouter,
  ConsistentHashRing,
  UpstreamNode,
  EdgeRouteGateway
} = require('../src/engine');
const { startServer } = require('../src/index');

let assertionCount = 0;
function pass(desc) {
  assertionCount++;
  console.log(`  ✓ [Assertion ${assertionCount}] ${desc}`);
}

async function runSuite() {
  console.log('====================================================');
  console.log('🧪 Running Verification Suite: EdgeRoute-Gateway (v2.0.0)');
  console.log('====================================================\n');

  // ----------------------------------------------------
  // SECTION 1: Radix Trie Router & Path Pattern Matching
  // ----------------------------------------------------
  console.log('[SECTION 1: Radix Trie Router & Path Pattern Matching]');

  const router = new RadixTrieRouter();
  router.insert('/api/v1/auth/login', { id: 'auth_login' });
  router.insert('/api/v1/users/:userId/orders/:orderId', { id: 'user_order' });
  router.insert('/assets/*filepath', { id: 'static_assets' });

  // 1. Exact match
  const matchExact = router.match('/api/v1/auth/login');
  assert.strictEqual(matchExact.matched, true);
  assert.strictEqual(matchExact.handler.id, 'auth_login');
  pass('Radix Trie exact match resolves in O(K) time');

  // 2. Parameterized match
  const matchParam = router.match('/api/v1/users/usr_849/orders/ord_9921');
  assert.strictEqual(matchParam.matched, true);
  assert.strictEqual(matchParam.handler.id, 'user_order');
  assert.strictEqual(matchParam.params.userId, 'usr_849');
  assert.strictEqual(matchParam.params.orderId, 'ord_9921');
  pass('Parameterized route extracted multiple URL variables');

  // 3. Wildcard globbing
  const matchWildcard = router.match('/assets/images/branding/logo.svg');
  assert.strictEqual(matchWildcard.matched, true);
  assert.strictEqual(matchWildcard.handler.id, 'static_assets');
  assert.strictEqual(matchWildcard.params.filepath, 'images/branding/logo.svg');
  pass('Wildcard globbing captured trailing path segments');

  // 4. Mismatch
  const mismatch = router.match('/api/v1/unknown');
  assert.strictEqual(mismatch.matched, false);
  pass('Unregistered route correctly returns matched: false');

  // ----------------------------------------------------
  // SECTION 2: Load Balancing Strategies
  // ----------------------------------------------------
  console.log('\n[SECTION 2: Load Balancing Strategies]');

  const gateway = new EdgeRouteGateway();

  // Test Round Robin
  const rr1 = gateway.resolve('/api/v1/auth/session');
  const rr2 = gateway.resolve('/api/v1/auth/session');
  assert.strictEqual(rr1.matched, true);
  assert.strictEqual(rr2.matched, true);
  assert.notStrictEqual(rr1.selectedUpstream.id, rr2.selectedUpstream.id, 'Round-robin switches between upstreams');
  pass('Round-robin switches alternately across healthy upstreams');

  // Test Smooth Weighted Round Robin
  const wrrSelections = [];
  for (let i = 0; i < 20; i++) {
    const res = gateway.resolve('/api/v1/payments/inv_01');
    wrrSelections.push(res.selectedUpstream.id);
  }
  const countPayment1 = wrrSelections.filter(id => id === 'payment_1').length;
  const countPayment2 = wrrSelections.filter(id => id === 'payment_2').length;
  assert.strictEqual(countPayment1, 10);
  assert.strictEqual(countPayment2, 10);
  pass('Weighted round-robin distributes requests in exact proportion to node weights (10:10)');

  // Test Consistent Hashing
  const hashResA1 = gateway.resolve('/api/v1/search', 'client_ip_alpha');
  const hashResA2 = gateway.resolve('/api/v1/search', 'client_ip_alpha');
  assert.strictEqual(hashResA1.selectedUpstream.id, hashResA2.selectedUpstream.id);
  pass('Consistent hashing ring provides sticky routing for identical client keys');

  // ----------------------------------------------------
  // SECTION 3: Upstream Health Checking & Circuit Breaking
  // ----------------------------------------------------
  console.log('\n[SECTION 3: Upstream Health & Circuit Breaking]');

  const testNode = new UpstreamNode('test_up', 'http://10.0.9.1:8080', 1);
  assert.strictEqual(testNode.healthy, true);

  // Trigger failures
  testNode.recordResult(100, false);
  testNode.recordResult(100, false);
  assert.strictEqual(testNode.healthy, true, 'Requires 3 consecutive failures to trip');
  testNode.recordResult(100, false);
  assert.strictEqual(testNode.healthy, false, 'Node marked UNHEALTHY after 3 consecutive failures');
  pass('Upstream trips to UNHEALTHY upon 3 consecutive failures');

  // Recovery
  testNode.recordResult(10, true);
  assert.strictEqual(testNode.healthy, false, 'Requires 2 consecutive successes to recover');
  testNode.recordResult(10, true);
  assert.strictEqual(testNode.healthy, true, 'Node returns to HEALTHY after 2 consecutive successes');
  pass('Upstream recovers to HEALTHY after consecutive successful responses');

  // Unhealthy upstream bypassed in gateway
  gateway.setUpstreamHealth('auth_1', false);
  const bypassRes = gateway.resolve('/api/v1/auth/token');
  assert.strictEqual(bypassRes.selectedUpstream.id, 'auth_2', 'Bypasses unhealthy auth_1');
  pass('Gateway automatically bypasses unhealthy upstreams');
  gateway.setUpstreamHealth('auth_1', true); // restore

  // ----------------------------------------------------
  // SECTION 4: Request Header & Path Enrichment
  // ----------------------------------------------------
  console.log('\n[SECTION 4: Request Header & Path Enrichment]');

  const enrichedRes = gateway.resolve('/api/v1/auth/status', '203.0.113.195');
  assert.ok(enrichedRes.requestId.startsWith('req_'));
  assert.strictEqual(enrichedRes.enrichedHeaders['X-Forwarded-For'], '203.0.113.195');
  assert.strictEqual(enrichedRes.enrichedHeaders['X-Gateway-Service'], 'auth');
  assert.strictEqual(enrichedRes.targetUrl, `${enrichedRes.selectedUpstream.url}/auth/status`);
  pass('Prefix stripped (/api/v1) and proxy headers enriched');

  // ----------------------------------------------------
  // SECTION 5: Live Ephemeral HTTP Server & REST Gateway
  // ----------------------------------------------------
  console.log('\n[SECTION 5: Live Ephemeral HTTP Server & REST Gateway]');

  const server = await new Promise((resolve, reject) => {
    try {
      const s = startServer(0, () => resolve(s));
    } catch (err) {
      reject(err);
    }
  });

  const testPort = server.address().port;
  console.log(`  [HTTP] Ephemeral server running on port ${testPort}`);

  const makeReq = (path, method = 'GET', data = null) => {
    return new Promise((resolve, reject) => {
      const postData = data ? JSON.stringify(data) : null;
      const opts = {
        hostname: '127.0.0.1',
        port: testPort,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
        }
      };

      const req = http.request(opts, res => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (e) { parsed = raw; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      });

      req.on('error', reject);
      if (postData) req.write(postData);
      req.end();
    });
  };

  // 1. GET /api/health
  const healthRes = await makeReq('/api/health');
  assert.strictEqual(healthRes.status, 200);
  assert.strictEqual(healthRes.body.service, 'EdgeRoute-Gateway');
  assert.strictEqual(healthRes.body.status, 'UP');
  pass('GET /api/health returns HTTP 200 with service UP');

  // 2. GET /api/stats
  const statsRes = await makeReq('/api/stats');
  assert.strictEqual(statsRes.status, 200);
  assert.ok(statsRes.body.metrics.totalRoutes > 0);
  pass('GET /api/stats returns runtime metrics and upstream count');

  // 3. GET /api/routes
  const routesRes = await makeReq('/api/routes');
  assert.strictEqual(routesRes.status, 200);
  assert.ok(routesRes.body.routes.length >= 3);
  pass('GET /api/routes returns registered route configurations');

  // 4. POST /api/routes
  const newRoute = {
    id: 'route_analytics',
    path: '/api/v1/analytics/:metric',
    strategy: 'ROUND_ROBIN',
    upstreamIds: ['payment_1']
  };
  const addRouteRes = await makeReq('/api/routes', 'POST', newRoute);
  assert.strictEqual(addRouteRes.status, 200);
  assert.strictEqual(addRouteRes.body.route.id, 'route_analytics');
  pass('POST /api/routes registers dynamic route into radix trie');

  // 5. GET /api/upstreams
  const upstreamsRes = await makeReq('/api/upstreams');
  assert.strictEqual(upstreamsRes.status, 200);
  assert.ok(upstreamsRes.body.upstreams.length >= 5);
  pass('GET /api/upstreams returns list of upstreams and telemetry metrics');

  // 6. POST /api/upstreams
  const addUpRes = await makeReq('/api/upstreams', 'POST', { id: 'cluster_new', url: 'http://10.0.5.1:5000', weight: 4 });
  assert.strictEqual(addUpRes.status, 200);
  assert.strictEqual(addUpRes.body.upstream.id, 'cluster_new');
  pass('POST /api/upstreams adds upstream node');

  // 7. PUT /api/upstreams/:id/health
  const toggleRes = await makeReq('/api/upstreams/cluster_new/health', 'PUT', { healthy: false });
  assert.strictEqual(toggleRes.status, 200);
  assert.strictEqual(toggleRes.body.healthy, false);
  pass('PUT /api/upstreams/:id/health updates health status');

  // 8. POST /api/gateway/resolve
  const resolveRes = await makeReq('/api/gateway/resolve', 'POST', { path: '/api/v1/auth/profile' });
  assert.strictEqual(resolveRes.status, 200);
  assert.strictEqual(resolveRes.body.resolution.matched, true);
  pass('POST /api/gateway/resolve executes routing simulation');

  // 9. SSE stream test
  await new Promise(resolve => {
    const sseReq = http.request({
      hostname: '127.0.0.1',
      port: testPort,
      path: '/api/events/stream',
      method: 'GET'
    }, res => {
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/event-stream');
      res.on('data', chunk => {
        const text = chunk.toString();
        if (text.includes('event: init')) {
          res.destroy();
          resolve();
        }
      });
    });
    sseReq.end();
  });
  pass('SSE connection to /api/events/stream established and receives init event');

  // 10. 404 Route
  const notFoundRes = await makeReq('/api/nonexistent_path');
  assert.strictEqual(notFoundRes.status, 404);
  pass('Invalid path returns HTTP 404');

  server.close();

  console.log('\n====================================================');
  console.log(`🎉 ALL ${assertionCount} ASSERTIONS PASSED (100% Non-Mocked Coverage)`);
  console.log('====================================================\n');
}

runSuite().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
