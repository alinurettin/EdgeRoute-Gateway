class GatewayRouter {
  constructor() {
    this.routes = new Map();
    this.rrIndexes = new Map();
  }
  registerRoute(prefix, upstreams = [], rewrite = '') {
    this.routes.set(prefix, { upstreams, rewrite });
    this.rrIndexes.set(prefix, 0);
  }
  resolve(requestPath) {
    for (const [prefix, config] of this.routes.entries()) {
      if (requestPath.startsWith(prefix)) {
        const idx = this.rrIndexes.get(prefix);
        const upstream = config.upstreams[idx % config.upstreams.length];
        this.rrIndexes.set(prefix, idx + 1);
        const rewrittenPath = requestPath.replace(prefix, config.rewrite || '');
        return { matched: true, upstream, rewrittenPath };
      }
    }
    return { matched: false };
  }
}
module.exports = GatewayRouter;