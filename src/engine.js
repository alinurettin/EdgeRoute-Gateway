// EdgeRoute-Gateway v2.0.0 - Layer 7 Dynamic Reverse Proxy & Adaptive Load Balancer
// Radix Tree Trie Router, Smooth Weighted Round-Robin, Ketama Consistent Hashing & Health Probing

const crypto = require('crypto');

/**
 * Trie Node for Parameterized Radix Routing
 */
class TrieNode {
  constructor(part = '', isParam = false, paramName = '') {
    this.part = part;
    this.isParam = isParam;
    this.paramName = paramName;
    this.isWildcard = false;
    this.children = new Map(); // string -> TrieNode
    this.paramChild = null;
    this.wildcardChild = null;
    this.handler = null; // Route configuration
  }
}

/**
 * High-Performance Radix Trie Router supporting :param and *wildcard
 */
class RadixTrieRouter {
  constructor() {
    this.root = new TrieNode();
    this.routeCount = 0;
  }

  insert(pattern, routeConfig) {
    const segments = pattern.split('/').filter(s => s.length > 0);
    let current = this.root;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];

      if (seg.startsWith(':')) {
        const pName = seg.substring(1);
        if (!current.paramChild) {
          current.paramChild = new TrieNode(seg, true, pName);
        }
        current = current.paramChild;
      } else if (seg.startsWith('*')) {
        const wName = seg.substring(1) || 'wildcard';
        if (!current.wildcardChild) {
          const wNode = new TrieNode(seg, false, wName);
          wNode.isWildcard = true;
          current.wildcardChild = wNode;
        }
        current = current.wildcardChild;
        break; // Wildcard consumes remainder of path
      } else {
        if (!current.children.has(seg)) {
          current.children.set(seg, new TrieNode(seg));
        }
        current = current.children.get(seg);
      }
    }

    current.handler = routeConfig;
    this.routeCount++;
  }

  match(path) {
    const segments = path.split('/').filter(s => s.length > 0);
    const params = {};
    let current = this.root;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];

      // 1. Exact match
      if (current.children.has(seg)) {
        current = current.children.get(seg);
        continue;
      }

      // 2. Parameter match (:param)
      if (current.paramChild) {
        current = current.paramChild;
        params[current.paramName] = seg;
        continue;
      }

      // 3. Wildcard match (*path)
      if (current.wildcardChild) {
        current = current.wildcardChild;
        params[current.paramName] = segments.slice(i).join('/');
        return { matched: true, handler: current.handler, params };
      }

      return { matched: false, handler: null, params: {} };
    }

    if (current && current.handler) {
      return { matched: true, handler: current.handler, params };
    }

    // Check trailing wildcard
    if (current && current.wildcardChild) {
      params[current.wildcardChild.paramName] = '';
      return { matched: true, handler: current.wildcardChild.handler, params };
    }

    return { matched: false, handler: null, params: {} };
  }
}

/**
 * Consistent Hash Ring (Ketama Algorithm) with Virtual Nodes
 */
class ConsistentHashRing {
  constructor(virtualNodes = 60) {
    this.virtualNodes = virtualNodes;
    this.ring = []; // sorted array of { hash, upstreamId }
  }

  hash(key) {
    const hex = crypto.createHash('md5').update(String(key)).digest('hex').substring(0, 8);
    return parseInt(hex, 16);
  }

  rebuild(upstreamList) {
    this.ring = [];
    for (const u of upstreamList) {
      if (!u.healthy) continue;
      for (let i = 0; i < this.virtualNodes; i++) {
        const vKey = `${u.id}#vnode_${i}`;
        const h = this.hash(vKey);
        this.ring.push({ hash: h, upstreamId: u.id });
      }
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  getUpstream(key, upstreamsMap) {
    if (this.ring.length === 0) return null;
    const h = this.hash(key);

    // Binary search on ring continuum
    let low = 0;
    let high = this.ring.length - 1;
    let idx = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.ring[mid].hash >= h) {
        idx = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    if (low >= this.ring.length) idx = 0; // Wrap around ring
    const winnerId = this.ring[idx].upstreamId;
    return upstreamsMap.get(winnerId) || null;
  }
}

/**
 * Upstream Node Definition & Telemetry
 */
class UpstreamNode {
  constructor(id, url, weight = 1) {
    this.id = id;
    this.url = url;
    this.weight = weight;
    this.currentWeight = 0;
    this.healthy = true;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.activeConnections = 0;
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.avgLatencyMs = 0;
  }

  recordResult(latencyMs, success = true) {
    this.totalRequests++;
    if (success) {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses++;
      if (!this.healthy && this.consecutiveSuccesses >= 2) {
        this.healthy = true;
      }
    } else {
      this.totalErrors++;
      this.consecutiveSuccesses = 0;
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= 3) {
        this.healthy = false;
      }
    }

    // Exponential moving average latency
    if (this.totalRequests === 1) this.avgLatencyMs = latencyMs;
    else this.avgLatencyMs = parseFloat(((this.avgLatencyMs * 0.8) + (latencyMs * 0.2)).toFixed(2));
  }
}

/**
 * Dynamic Reverse Proxy Gateway Coordinator
 */
class EdgeRouteGateway {
  constructor() {
    this.router = new RadixTrieRouter();
    this.routes = new Map(); // id -> route definition
    this.upstreams = new Map(); // id -> UpstreamNode
    this.hashRing = new ConsistentHashRing(40);
    this.rrCounters = new Map(); // routeId -> integer
    this.subscribers = new Set();
    this.totalRoutedRequests = 0;
    this.startTime = Date.now();

    this.seedBaselineGateway();
  }

  seedBaselineGateway() {
    // 1. Register default upstreams
    this.addUpstream('auth_1', 'http://10.0.1.10:8001', 5);
    this.addUpstream('auth_2', 'http://10.0.1.11:8001', 3);
    this.addUpstream('payment_1', 'http://10.0.2.20:9001', 10);
    this.addUpstream('payment_2', 'http://10.0.2.21:9001', 10);
    this.addUpstream('search_cluster', 'http://10.0.3.30:7001', 1);

    // 2. Register baseline routes
    this.registerRoute({
      id: 'route_auth',
      path: '/api/v1/auth/*path',
      strategy: 'ROUND_ROBIN',
      upstreamIds: ['auth_1', 'auth_2'],
      stripPrefix: '/api/v1',
      headersToAdd: { 'X-Gateway-Service': 'auth' }
    });

    this.registerRoute({
      id: 'route_payments',
      path: '/api/v1/payments/:invoiceId',
      strategy: 'WEIGHTED_ROUND_ROBIN',
      upstreamIds: ['payment_1', 'payment_2'],
      stripPrefix: '',
      headersToAdd: { 'X-Gateway-Service': 'billing' }
    });

    this.registerRoute({
      id: 'route_search',
      path: '/api/v1/search',
      strategy: 'CONSISTENT_HASH',
      upstreamIds: ['search_cluster', 'auth_1'],
      stripPrefix: '',
      headersToAdd: { 'X-Gateway-Service': 'search' }
    });
  }

  addUpstream(id, url, weight = 1) {
    const node = new UpstreamNode(id, url, weight);
    this.upstreams.set(id, node);
    this.rebuildHashRing();
    return node;
  }

  removeUpstream(id) {
    this.upstreams.delete(id);
    this.rebuildHashRing();
  }

  setUpstreamHealth(id, healthy) {
    const u = this.upstreams.get(id);
    if (u) {
      u.healthy = healthy;
      this.rebuildHashRing();
      this.broadcastEvent('upstream_health_changed', { id, healthy });
    }
  }

  rebuildHashRing() {
    this.hashRing.rebuild(Array.from(this.upstreams.values()));
  }

  registerRoute(config) {
    if (!config.id || !config.path) {
      throw new Error('Route requires id and path');
    }

    const routeDef = {
      id: config.id,
      path: config.path,
      strategy: config.strategy || 'ROUND_ROBIN', // 'ROUND_ROBIN', 'WEIGHTED_ROUND_ROBIN', 'LEAST_CONNECTIONS', 'CONSISTENT_HASH'
      upstreamIds: config.upstreamIds || [],
      stripPrefix: config.stripPrefix || '',
      headersToAdd: config.headersToAdd || {},
      createdAt: Date.now()
    };

    this.routes.set(config.id, routeDef);
    this.router.insert(config.path, routeDef);
    this.rrCounters.set(config.id, 0);

    this.broadcastEvent('route_registered', routeDef);
    return routeDef;
  }

  /**
   * Resolves an inbound HTTP request URL path and selects the optimal upstream
   */
  resolve(requestPath, clientKey = '127.0.0.1') {
    const match = this.router.match(requestPath);
    if (!match.matched) {
      return { matched: false, error: 'No matching route in radix trie' };
    }

    const route = match.handler;
    const healthyUpstreams = (route.upstreamIds || [])
      .map(uid => this.upstreams.get(uid))
      .filter(u => u && u.healthy);

    if (healthyUpstreams.length === 0) {
      return {
        matched: true,
        routeId: route.id,
        error: '503 Service Unavailable: No healthy upstreams in target pool'
      };
    }

    let selectedUpstream = null;

    // Load Balancing Strategy Dispatch
    if (route.strategy === 'ROUND_ROBIN') {
      const idx = this.rrCounters.get(route.id) || 0;
      selectedUpstream = healthyUpstreams[idx % healthyUpstreams.length];
      this.rrCounters.set(route.id, idx + 1);
    } else if (route.strategy === 'WEIGHTED_ROUND_ROBIN') {
      // Smooth Weighted Round-Robin (Nginx Algorithm)
      let totalWeight = 0;
      let maxNode = null;

      for (const node of healthyUpstreams) {
        node.currentWeight += node.weight;
        totalWeight += node.weight;
        if (!maxNode || node.currentWeight > maxNode.currentWeight) {
          maxNode = node;
        }
      }

      if (maxNode) {
        maxNode.currentWeight -= totalWeight;
        selectedUpstream = maxNode;
      } else {
        selectedUpstream = healthyUpstreams[0];
      }
    } else if (route.strategy === 'LEAST_CONNECTIONS') {
      selectedUpstream = healthyUpstreams.reduce((min, cur) => 
        cur.activeConnections < min.activeConnections ? cur : min, healthyUpstreams[0]);
    } else if (route.strategy === 'CONSISTENT_HASH') {
      selectedUpstream = this.hashRing.getUpstream(clientKey, this.upstreams) || healthyUpstreams[0];
    } else {
      selectedUpstream = healthyUpstreams[0];
    }

    // Path rewriting
    let targetPath = requestPath;
    if (route.stripPrefix && targetPath.startsWith(route.stripPrefix)) {
      targetPath = targetPath.substring(route.stripPrefix.length) || '/';
    }

    // Request ID & Header Enrichment
    const requestId = 'req_' + crypto.randomBytes(6).toString('hex');
    const enrichedHeaders = Object.assign({
      'X-Request-ID': requestId,
      'X-Forwarded-For': clientKey,
      'X-Forwarded-Proto': 'http',
      'X-Proxy-Gateway': 'EdgeRoute-Gateway/2.0'
    }, route.headersToAdd || {});

    this.totalRoutedRequests++;

    return {
      matched: true,
      requestId,
      routeId: route.id,
      strategy: route.strategy,
      params: match.params,
      selectedUpstream: {
        id: selectedUpstream.id,
        url: selectedUpstream.url,
        weight: selectedUpstream.weight,
        activeConnections: selectedUpstream.activeConnections
      },
      targetUrl: `${selectedUpstream.url}${targetPath}`,
      enrichedHeaders
    };
  }

  recordRequestFinished(upstreamId, latencyMs, success = true) {
    const u = this.upstreams.get(upstreamId);
    if (u) {
      u.recordResult(latencyMs, success);
      this.broadcastEvent('upstream_telemetry', {
        upstreamId: u.id,
        healthy: u.healthy,
        totalRequests: u.totalRequests,
        avgLatencyMs: u.avgLatencyMs
      });
    }
  }

  subscribe(res) {
    this.subscribers.add(res);
    res.on('close', () => this.subscribers.delete(res));
  }

  broadcastEvent(eventType, payload) {
    const data = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.subscribers) {
      try { res.write(data); } catch (e) { this.subscribers.delete(res); }
    }
  }

  metrics() {
    return {
      totalRoutes: this.routes.size,
      totalUpstreams: this.upstreams.size,
      healthyUpstreams: Array.from(this.upstreams.values()).filter(u => u.healthy).length,
      totalRoutedRequests: this.totalRoutedRequests,
      subscribers: this.subscribers.size,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000)
    };
  }
}

module.exports = {
  TrieNode,
  RadixTrieRouter,
  ConsistentHashRing,
  UpstreamNode,
  EdgeRouteGateway
};