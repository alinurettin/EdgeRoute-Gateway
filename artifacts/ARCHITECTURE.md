# 🏛️ Technical Architecture Document: EdgeRoute-Gateway
**Version:** 2.0.0  
**Domain:** Layer 7 Ingress Gateway & Load Balancer  
**Architect:** 7-Agent SDLC Principal Software Architect  

---

## 1. System Topology & Architecture

```mermaid
flowchart TD
    subgraph Clients [Inbound Traffic & Admin Console]
        Browser["🖥️ Dark-Mode Dashboard (Port 6011)"]
        PublicClient["📱 Web & Mobile Clients"]
        AdminCLI["⚙️ CI/CD & Service Discovery API"]
    end

    subgraph GatewayProcess [EdgeRoute-Gateway Process]
        Dispatcher["⚡ HTTP Dispatcher & JSON Body Parser"]
        Coordinator["🧠 EdgeRouteGateway Coordinator"]
        
        subgraph RoutingCore [Routing Subsystem]
            Trie["🌲 RadixTrieRouter (O(K) Segment Matching)"]
        end

        subgraph BalancingCore [Balancing Subsystem]
            RR["🔄 Round-Robin"]
            WRR["⚖️ Smooth Weighted Round-Robin"]
            LC["⚡ Least Connections"]
            Ring["🍩 Ketama Consistent Hash Ring"]
        end

        subgraph HealthCore [Resilience & Telemetry]
            Circuit["🛡️ Circuit Breaker (3-Failure Trip)"]
            Telemetry["📊 EMA Latency Tracker"]
        end

        SSE["📡 SSE Live Event Hub"]
    end

    subgraph UpstreamPools [Backend Microservice Clusters]
        AuthSvc["🔐 Auth Cluster (8001)"]
        PaySvc["💳 Payment Cluster (9001)"]
        SearchSvc["🔍 Search Cluster (7001)"]
    end

    PublicClient --> Dispatcher
    Browser --> Dispatcher
    AdminCLI --> Dispatcher
    Dispatcher --> Coordinator
    Coordinator --> Trie
    Trie --> Coordinator
    Coordinator --> BalancingCore
    BalancingCore --> HealthCore
    HealthCore --> AuthSvc & PaySvc & SearchSvc
    Coordinator -->|Routing Deltas| SSE
    SSE -->|text/event-stream| Browser
```

---

## 2. Core Architectural Subsystems

### 2.1 `RadixTrieRouter` (`src/engine.js`)
- Decomposes URLs into slash-separated tokens.
- Parameterized nodes (`:param`) dynamically populate request parameter dictionaries.
- Wildcard nodes (`*path`) absorb remaining URL paths for proxy passthrough.

### 2.2 Adaptive Load Balancers (`src/engine.js`)
- **`ROUND_ROBIN`**: Increments atomic route counter mod healthy upstreams count.
- **`WEIGHTED_ROUND_ROBIN`**: Smooth Nginx algorithm distributing traffic evenly over time according to configured weight capacities.
- **`CONSISTENT_HASH`**: Ketama 32-bit ring mapping clients to virtual nodes for persistent caching and session stickiness.

### 2.3 Circuit Breaker & Health Probing (`src/engine.js`)
- Each `UpstreamNode` maintains failure counters and exponential moving average (EMA) latencies.
- Three consecutive errors automatically quarantine an upstream, protecting clients from cascading timeouts.

### 2.4 Path Rewriting & Header Enrichment (`src/engine.js`)
- Automatically strips defined prefixes (e.g. `/api/v1`) before forwarding.
- Injects standard proxy headers (`X-Request-ID`, `X-Forwarded-For`, `X-Forwarded-Proto`).
