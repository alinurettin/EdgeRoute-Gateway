// EdgeRoute-Gateway v2.0.0 Interactive Studio Controller

let routesCache = [];
let upstreamsCache = [];
let eventSource = null;

document.addEventListener('DOMContentLoaded', () => {
  setupSSE();
  fetchInitialData();
  setupEventListeners();
});

// Setup Server-Sent Events (SSE)
function setupSSE() {
  const badge = document.getElementById('sseBadge');
  if (eventSource) eventSource.close();

  eventSource = new EventSource('/api/events/stream');

  eventSource.onopen = () => {
    badge.textContent = 'SSE: CONNECTED';
    badge.className = 'badge badge-active';
  };

  eventSource.onerror = () => {
    badge.textContent = 'SSE: DISCONNECTED';
    badge.className = 'badge badge-danger';
  };

  eventSource.addEventListener('upstream_health_changed', () => {
    fetchUpstreams();
  });

  eventSource.addEventListener('upstream_telemetry', () => {
    fetchUpstreams();
  });

  eventSource.addEventListener('route_registered', () => {
    fetchRoutes();
  });
}

// Fetch Initial Data
async function fetchInitialData() {
  await Promise.all([fetchRoutes(), fetchUpstreams()]);
}

// Fetch Routes
async function fetchRoutes() {
  try {
    const res = await fetch('/api/routes');
    const data = await res.json();
    if (data.success && data.routes) {
      routesCache = data.routes;
      renderRoutes(routesCache);
      document.getElementById('valRoutesCount').textContent = routesCache.length;
    }
  } catch (err) {
    console.error('Failed to fetch routes:', err);
  }
}

// Fetch Upstreams
async function fetchUpstreams() {
  try {
    const res = await fetch('/api/upstreams');
    const data = await res.json();
    if (data.success && data.upstreams) {
      upstreamsCache = data.upstreams;
      renderUpstreams(upstreamsCache);
      updateUpstreamMetrics(upstreamsCache);
    }
  } catch (err) {
    console.error('Failed to fetch upstreams:', err);
  }
}

// Render Routes Table
function renderRoutes(routes) {
  const tbody = document.getElementById('routesTableBody');
  if (!routes || routes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No routes registered.</td></tr>';
    return;
  }

  tbody.innerHTML = routes.map(r => {
    let stratBadge = 'badge-info';
    if (r.strategy === 'WEIGHTED_ROUND_ROBIN') stratBadge = 'badge-active';
    else if (r.strategy === 'CONSISTENT_HASH') stratBadge = 'badge-warning';

    const upstreamsList = (r.upstreamIds || []).map(u => `<code>${escapeHtml(u)}</code>`).join(', ');
    const headersList = Object.entries(r.headersToAdd || {}).map(([k, v]) => `<div><small>${escapeHtml(k)}: ${escapeHtml(v)}</small></div>`).join('');

    return `
      <tr>
        <td><strong><code>${escapeHtml(r.id)}</code></strong></td>
        <td><code>${escapeHtml(r.path)}</code></td>
        <td><span class="badge ${stratBadge}">${escapeHtml(r.strategy)}</span></td>
        <td>${upstreamsList}</td>
        <td><small class="text-muted">${escapeHtml(r.stripPrefix || 'None')}</small></td>
        <td>${headersList || '<small class="text-muted">None</small>'}</td>
      </tr>
    `;
  }).join('');
}

// Render Upstreams Grid
function renderUpstreams(upstreams) {
  const container = document.getElementById('upstreamsList');
  if (!upstreams || upstreams.length === 0) {
    container.innerHTML = '<span class="text-muted">No upstreams configured.</span>';
    return;
  }

  container.innerHTML = upstreams.map(u => {
    const statusClass = u.healthy ? 'healthy' : 'unhealthy';
    const statusBadge = u.healthy 
      ? '<span class="badge badge-active">HEALTHY</span>'
      : '<span class="badge badge-danger">UNHEALTHY</span>';

    return `
      <div class="upstream-card ${statusClass}">
        <div class="up-head">
          <span>${escapeHtml(u.id)} (Weight: ${u.weight})</span>
          ${statusBadge}
        </div>
        <div class="up-url">${escapeHtml(u.url)}</div>
        <div class="up-stats">
          <span>Reqs: ${u.totalRequests}</span>
          <span>Avg: ${u.avgLatencyMs || 0}ms</span>
          <span>Errors: ${u.totalErrors}</span>
        </div>
        <div style="margin-top:4px;">
          <button class="btn btn-sm ${u.healthy ? 'btn-danger' : 'btn-success'}" onclick="toggleHealth('${u.id}', ${!u.healthy})">
            ${u.healthy ? 'Simulate Outage' : 'Recover Node'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// Update Top Metrics
function updateUpstreamMetrics(upstreams) {
  const total = upstreams.length;
  const healthy = upstreams.filter(u => u.healthy).length;
  document.getElementById('valHealthyUpstreams').textContent = `${healthy} / ${total}`;

  let totalReqs = 0;
  let totalLatency = 0;
  let countWithLatency = 0;

  for (const u of upstreams) {
    totalReqs += u.totalRequests;
    if (u.avgLatencyMs > 0) {
      totalLatency += u.avgLatencyMs;
      countWithLatency++;
    }
  }

  document.getElementById('valRoutedCount').textContent = totalReqs;
  const avg = countWithLatency > 0 ? (totalLatency / countWithLatency).toFixed(1) : '0.0';
  document.getElementById('valAvgLatency').textContent = `${avg}ms`;
}

// Toggle Upstream Health
async function toggleHealth(upstreamId, newHealth) {
  try {
    const res = await fetch(`/api/upstreams/${upstreamId}/health`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ healthy: newHealth })
    });
    const data = await res.json();
    if (data.success) {
      fetchUpstreams();
    }
  } catch (err) {
    alert('Error updating health: ' + err.message);
  }
}

// Event Listeners
function setupEventListeners() {
  // Resolve Form Submit
  document.getElementById('resolveForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const reqPath = document.getElementById('inputPath').value.trim();
    const clientKey = document.getElementById('inputClientIp').value.trim();

    try {
      const res = await fetch('/api/gateway/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: reqPath, clientKey })
      });
      const data = await res.json();

      const out = document.getElementById('resolutionBox');
      if (data.success && data.resolution) {
        const r = data.resolution;
        if (!r.matched) {
          out.innerHTML = `<span class="danger">❌ No route matched for "${escapeHtml(reqPath)}"</span>`;
          return;
        }

        if (r.error) {
          out.innerHTML = `<span class="danger">⚠️ ${escapeHtml(r.error)}</span>`;
          return;
        }

        const paramsList = Object.entries(r.params || {}).map(([k, v]) => `<span class="res-pill">${escapeHtml(k)}: ${escapeHtml(v)}</span>`).join('');
        const headersHtml = Object.entries(r.enrichedHeaders || {}).map(([k, v]) => `<div>${escapeHtml(k)}: ${escapeHtml(v)}</div>`).join('');

        out.innerHTML = `
          <div><strong>Target Destination:</strong></div>
          <div class="res-url">🚀 ${escapeHtml(r.targetUrl)}</div>
          <div style="margin-top:6px;">
            <span class="res-pill">Upstream: ${escapeHtml(r.selectedUpstream.id)}</span>
            <span class="res-pill">Strategy: ${escapeHtml(r.strategy)}</span>
            <span class="res-pill">ReqID: ${escapeHtml(r.requestId)}</span>
          </div>
          ${paramsList ? `<div style="margin-top:6px;"><strong>Extracted Params:</strong> ${paramsList}</div>` : ''}
          <div style="margin-top:8px; font-size:0.75rem; color:var(--text-muted);">
            <strong>Injected Headers:</strong>
            ${headersHtml}
          </div>
        `;

        fetchUpstreams();
      }
    } catch (err) {
      document.getElementById('resolutionBox').innerHTML = `<span class="danger">Error: ${escapeHtml(err.message)}</span>`;
    }
  });

  // Preset Buttons
  document.getElementById('btnQuickAuth').addEventListener('click', () => {
    document.getElementById('inputPath').value = '/api/v1/auth/tokens/refresh';
    document.getElementById('resolveForm').dispatchEvent(new Event('submit'));
  });

  document.getElementById('btnQuickPayment').addEventListener('click', () => {
    const randId = 'inv_' + Math.floor(10000 + Math.random() * 90000);
    document.getElementById('inputPath').value = `/api/v1/payments/${randId}`;
    document.getElementById('resolveForm').dispatchEvent(new Event('submit'));
  });

  document.getElementById('btnQuickSearch').addEventListener('click', () => {
    document.getElementById('inputPath').value = '/api/v1/search';
    document.getElementById('resolveForm').dispatchEvent(new Event('submit'));
  });

  document.getElementById('btnRefreshUpstreams').addEventListener('click', () => {
    fetchUpstreams();
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
