// Queue Pipeline UI

const API = '';  // same origin
const state = {
  runs: [],
  activeRunId: null,
  queues: { llm: null, image: null, video: null },
  graph: null,
  eventSource: null,
  currentView: 'queue',
  runStatus: null, // 'running' | 'pausing' | 'stopped' | 'completed' | 'failed'
  runStartTime: null, // earliest startedAt across all items (ms)
};

let elapsedInterval = null;

// Track original inputs for form dirty comparison
var _originalInputs = null;

// --- DOM helpers ---
const $ = (id) => document.getElementById(id);

function playVideo(container, videoSrc) {
  const video = document.createElement('video');
  video.src = videoSrc;
  video.controls = true;
  video.autoplay = true;
  video.className = container.dataset.videoClass || 'inline-video';
  video.addEventListener('ended', () => {
    container.innerHTML = container.dataset.thumbnailHtml;
    container.onclick = () => playVideo(container, videoSrc);
  });
  container.dataset.thumbnailHtml = container.innerHTML;
  container.innerHTML = '';
  container.appendChild(video);
  container.onclick = null;
}
window.playVideo = playVideo;
const $$ = (sel) => document.querySelectorAll(sel);

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupRunSelector();
  setupPlayPause();
  setupCreateDialog();
  setupDetailPanel();
  setupGraphControls();
  loadRuns();
});

// --- View tabs ---
function setupTabs() {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const view = tab.dataset.view;
      state.currentView = view;
      $$('.view').forEach(v => v.classList.remove('active'));
      $(`${view}-view`).classList.add('active');
      if (view === 'graph' && state.graph) renderGraph();
    });
  }
}

// --- Run selector ---
function setupRunSelector() {
  $('run-select').addEventListener('change', (e) => {
    const runId = e.target.value;
    if (runId) selectRun(runId);
  });
}

async function loadRuns() {
  try {
    const res = await fetch(`${API}/api/runs`);
    const data = await res.json();
    state.runs = data.runs;
    const sel = $('run-select');
    sel.innerHTML = '<option value="">— select run —</option>';
    for (const run of state.runs) {
      const opt = document.createElement('option');
      opt.value = run.id;
      opt.textContent = run.name || run.id.slice(0, 8);
      sel.appendChild(opt);
    }
    // Preserve active selection, or auto-select most recent
    if (state.activeRunId && state.runs.some(r => r.id === state.activeRunId)) {
      sel.value = state.activeRunId;
    } else if (state.runs.length > 0) {
      const latest = state.runs[state.runs.length - 1];
      sel.value = latest.id;
      selectRun(latest.id);
    }
  } catch (e) {
    console.error('Failed to load runs:', e);
  }
}

async function selectRun(runId) {
  state.activeRunId = runId;
  state.runStartTime = null;
  clearElapsedInterval();
  $('run-select').value = runId;
  disconnectSSE();
  await Promise.all([fetchQueues(), fetchGraph(), fetchRunStatus()]);
  connectSSE(runId);
}

// --- Create run ---
function setupCreateDialog() {
  $('new-run-btn').addEventListener('click', () => $('create-dialog').showModal());
  $('cancel-create').addEventListener('click', () => $('create-dialog').close());
  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('story-input').value.trim();
    if (!text) return;
    const aspectRatio = $('aspect-ratio-select').value;
    try {
      const res = await fetch(`${API}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyText: text, options: { aspectRatio } }),
      });
      const run = await res.json();
      $('story-input').value = '';
      $('aspect-ratio-select').value = '16:9';
      $('create-dialog').close();
      await loadRuns();
      selectRun(run.id);
    } catch (e) {
      console.error('Failed to create run:', e);
    }
  });
}

// --- Play/Pause ---
function setupPlayPause() {
  $('play-pause-btn').addEventListener('click', togglePlayPause);
}

async function togglePlayPause() {
  if (!state.activeRunId) return;
  const btn = $('play-pause-btn');
  btn.disabled = true;
  try {
    if (state.runStatus === 'running') {
      await fetch(`${API}/api/runs/${state.activeRunId}/stop`, { method: 'POST' });
    } else if (state.runStatus === 'stopped' || state.runStatus === 'pausing') {
      await fetch(`${API}/api/runs/${state.activeRunId}/resume`, { method: 'POST' });
    }
  } catch (e) {
    console.error('Play/pause failed:', e);
  } finally {
    btn.disabled = false;
  }
}

async function fetchRunStatus() {
  if (!state.activeRunId) return;
  try {
    const res = await fetch(`${API}/api/runs/${state.activeRunId}`);
    const data = await res.json();
    updateRunStatus(data.status);
  } catch (e) { console.error('fetchRunStatus:', e); }
}

function updateRunStatus(status) {
  state.runStatus = status;
  const btn = $('play-pause-btn');
  const badge = $('run-status-badge');

  if (!state.activeRunId) {
    btn.style.display = 'none';
    badge.style.display = 'none';
    return;
  }

  // Show badge
  badge.style.display = '';
  badge.textContent = status;
  badge.className = `run-status-badge ${status}`;

  // Show play/pause button for running/stopped/pausing states
  if (status === 'running' || status === 'stopped' || status === 'pausing') {
    btn.style.display = '';
    btn.textContent = status === 'running' ? '⏸' : '▶';
    btn.title = status === 'running' ? 'Pause pipeline' : 'Resume pipeline';
    btn.className = `play-pause-btn ${status === 'running' ? 'running' : 'stopped'}`;
  } else {
    btn.style.display = 'none';
  }
}

function showToast(message, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// --- SSE ---
function connectSSE(runId) {
  disconnectSSE();
  const es = new EventSource(`${API}/api/runs/${runId}/events`);
  state.eventSource = es;
  $('sse-status').textContent = 'connecting';
  $('sse-status').className = 'sse-badge disconnected';

  es.onopen = () => {
    $('sse-status').textContent = 'connected';
    $('sse-status').className = 'sse-badge connected';
  };
  es.onerror = () => {
    $('sse-status').textContent = 'disconnected';
    $('sse-status').className = 'sse-badge disconnected';
  };
  es.addEventListener('item_started', () => { fetchQueues(); fetchGraph(); });
  es.addEventListener('item_completed', () => { fetchQueues(); fetchGraph(); });
  es.addEventListener('item_failed', () => { fetchQueues(); fetchGraph(); });
  es.addEventListener('run_status', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.payload && data.payload.status) {
        updateRunStatus(data.payload.status);
      }
    } catch {}
    loadRuns(); fetchQueues(); fetchGraph();
  });
  es.addEventListener('pipeline_paused', (e) => {
    try {
      const data = JSON.parse(e.data);
      updateRunStatus('stopped');
      const reason = data.payload && data.payload.reason ? data.payload.reason : 'Pipeline paused';
      showToast(reason, 'warning');
    } catch {}
    loadRuns(); fetchQueues(); fetchGraph();
  });
  es.addEventListener('item_retried', () => { fetchQueues(); fetchGraph(); });
  es.addEventListener('item_redo', () => { fetchQueues(); fetchGraph(); });
  es.addEventListener('item_cancelled', () => { fetchQueues(); fetchGraph(); });
  // Generic message fallback
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'item_started' || data.type === 'item_completed' || data.type === 'item_failed' || data.type === 'item_redo' || data.type === 'item_cancelled' || data.type === 'item_retried') {
        fetchQueues();
        fetchGraph();
      } else if (data.type === 'run_status') {
        if (data.payload && data.payload.status) updateRunStatus(data.payload.status);
        loadRuns(); fetchQueues(); fetchGraph();
      } else if (data.type === 'pipeline_paused') {
        updateRunStatus('stopped');
        const reason = data.payload && data.payload.reason ? data.payload.reason : 'Pipeline paused';
        showToast(reason, 'warning');
        loadRuns(); fetchQueues(); fetchGraph();
      }
    } catch {}
  };
}

function disconnectSSE() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  $('sse-status').textContent = 'disconnected';
  $('sse-status').className = 'sse-badge disconnected';
}

// --- Fetch data ---
async function fetchQueues() {
  if (!state.activeRunId) return;
  try {
    const res = await fetch(`${API}/api/runs/${state.activeRunId}/queues`);
    const data = await res.json();
    // Server returns { runId, queues: [QueueSnapshot, ...] }
    const queuesArray = data.queues;
    if (Array.isArray(queuesArray)) {
      for (const q of queuesArray) state.queues[q.queue] = q;
    }
    renderQueues();
  } catch (e) { console.error('fetchQueues:', e); }
}

async function fetchGraph() {
  if (!state.activeRunId) return;
  try {
    const res = await fetch(`${API}/api/runs/${state.activeRunId}/graph`);
    const graphData = await res.json();
    state.graph = graphData.graph;
    if (state.currentView === 'graph') renderGraph();
  } catch (e) { console.error('fetchGraph:', e); }
}

// --- Duration formatting ---
function fmtDuration(seconds) {
  const s = Math.floor(seconds);
  if (s < 0) return '0s';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// --- ETA computation ---
function getAllItems() {
  const items = [];
  for (const qName of ['llm', 'image', 'video']) {
    const q = state.queues[qName];
    if (!q) continue;
    for (const group of [q.inProgress, q.pending, q.completed, q.failed, q.superseded, q.cancelled]) {
      if (group) items.push(...group);
    }
  }
  return items;
}

function computeETA() {
  const allItems = getAllItems();
  if (allItems.length === 0) return null;

  // Compute average processing time per type from completed items
  const completedByType = {};
  const videoTimings = []; // { elapsed, durationSeconds }
  for (const item of allItems) {
    if (item.status !== 'completed' || !item.startedAt || !item.completedAt) continue;
    const elapsed = (new Date(item.completedAt).getTime() - new Date(item.startedAt).getTime()) / 1000;
    if (elapsed <= 0) continue;

    if (item.type === 'generate_video') {
      const dur = item.inputs?.shot?.durationSeconds;
      if (dur && dur > 0) {
        videoTimings.push({ elapsed, durationSeconds: dur });
      }
    }

    if (!completedByType[item.type]) completedByType[item.type] = [];
    completedByType[item.type].push(elapsed);
  }

  // Average time per type
  const avgByType = {};
  for (const [type, times] of Object.entries(completedByType)) {
    avgByType[type] = times.reduce((a, b) => a + b, 0) / times.length;
  }

  // Average time per duration-second for video items
  let avgTimePerDurSec = null;
  if (videoTimings.length > 0) {
    const rates = videoTimings.map(v => v.elapsed / v.durationSeconds);
    avgTimePerDurSec = rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  // Estimate remaining time per queue (queues run in parallel)
  const perQueueRemaining = {};
  for (const qName of ['llm', 'image', 'video']) {
    const q = state.queues[qName];
    if (!q) continue;
    const remaining = [...(q.inProgress || []), ...(q.pending || [])];
    let queueEst = 0;
    let hasEstimate = false;
    for (const item of remaining) {
      if (item.type === 'generate_video' && avgTimePerDurSec !== null) {
        const dur = item.inputs?.shot?.durationSeconds || 0;
        queueEst += avgTimePerDurSec * dur;
        hasEstimate = true;
      } else if (avgByType[item.type]) {
        queueEst += avgByType[item.type];
        hasEstimate = true;
      }
      // If no data for this type yet, skip (don't estimate)
    }
    if (hasEstimate) perQueueRemaining[qName] = queueEst;
  }

  const estimates = Object.values(perQueueRemaining);
  if (estimates.length === 0) return null;
  // Queues run in parallel, so ETA is the max
  return Math.max(...estimates);
}

// --- Elapsed interval management ---
function clearElapsedInterval() {
  if (elapsedInterval !== null) {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
  }
}

function updateElapsedDisplay() {
  if (!state.runStartTime) return;
  const now = Date.now();
  const elapsedSec = (now - state.runStartTime) / 1000;

  // Gather current totals
  let totalItems = 0, completedItems = 0;
  for (const qName of ['llm', 'image', 'video']) {
    const q = state.queues[qName];
    if (!q) continue;
    const groups = [q.inProgress, q.pending, q.completed, q.failed, q.superseded, q.cancelled];
    for (const g of groups) { if (g) totalItems += g.length; }
    completedItems += (q.completed || []).length;
  }
  if (totalItems === 0) return;

  const pct = Math.round((completedItems / totalItems) * 100);
  const allDone = completedItems === totalItems;
  const eta = allDone ? null : computeETA();

  let text = `${completedItems} / ${totalItems} items completed (${pct}%) · Elapsed: ${fmtDuration(elapsedSec)}`;
  if (allDone) {
    // No ETA needed
  } else if (eta !== null) {
    text += ` · ETA: ~${fmtDuration(eta)}`;
  } else {
    text += ` · ETA: calculating…`;
  }

  $('progress-text').textContent = text;
}

function startElapsedInterval() {
  clearElapsedInterval();
  elapsedInterval = setInterval(updateElapsedDisplay, 1000);
}

// --- Render queues ---
function renderQueues() {
  let totalItems = 0, completedItems = 0;
  let earliestStart = null;

  for (const qName of ['llm', 'image', 'video']) {
    const q = state.queues[qName];
    const container = $(`${qName}-items`);
    const countEl = $(`${qName}-count`);
    if (!q) { container.innerHTML = ''; countEl.textContent = '0'; continue; }

    const groups = [
      { label: 'In Progress', items: q.inProgress || [], status: 'in_progress' },
      { label: 'Pending', items: q.pending || [], status: 'pending' },
      { label: 'Completed', items: q.completed || [], status: 'completed' },
      { label: 'Failed', items: q.failed || [], status: 'failed' },
      { label: 'Superseded', items: q.superseded || [], status: 'superseded' },
      { label: 'Cancelled', items: q.cancelled || [], status: 'cancelled' },
    ];

    const allItems = groups.flatMap(g => g.items);
    const done = (q.completed || []).length;
    totalItems += allItems.length;
    completedItems += done;
    countEl.textContent = `${done}/${allItems.length}`;

    // Find earliest startedAt
    for (const item of allItems) {
      if (item.startedAt) {
        const t = new Date(item.startedAt).getTime();
        if (earliestStart === null || t < earliestStart) earliestStart = t;
      }
    }

    let html = '';
    for (const group of groups) {
      if (group.items.length === 0) continue;
      html += `<div class="status-group-label">${group.label} (${group.items.length})</div>`;
      for (const item of group.items) {
        html += renderQueueItem(item);
      }
    }
    container.innerHTML = html;

    // Attach click handlers
    for (const el of container.querySelectorAll('.q-item')) {
      el.addEventListener('click', () => showDetail(el.dataset.id));
    }
    for (const btn of container.querySelectorAll('[data-action]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleAction(btn.dataset.action, btn.dataset.id);
      });
    }
  }

  // Track run start time
  if (earliestStart !== null) {
    state.runStartTime = earliestStart;
  }

  // Progress bar
  const pct = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;
  if (totalItems > 0) {
    const allDone = completedItems === totalItems;
    const elapsedSec = state.runStartTime ? (Date.now() - state.runStartTime) / 1000 : 0;
    let text = `${completedItems} / ${totalItems} items completed (${pct}%)`;
    if (state.runStartTime) {
      text += ` · Elapsed: ${fmtDuration(elapsedSec)}`;
      if (allDone) {
        clearElapsedInterval();
      } else {
        const eta = computeETA();
        if (eta !== null) {
          text += ` · ETA: ~${fmtDuration(eta)}`;
        } else {
          text += ` · ETA: calculating…`;
        }
        // Start ticking if not already
        if (elapsedInterval === null) startElapsedInterval();
      }
    }
    $('progress-text').textContent = text;
  } else {
    clearElapsedInterval();
    $('progress-text').textContent = 'No run selected';
  }
  $('progress-fill').style.width = `${pct}%`;

  // Assembly check
  checkAssembly();
}

// Get the media file path from item outputs based on item type
function getMediaPath(item) {
  if (!item.outputs) return null;
  // generate_frame outputs: { startPath, endPath }
  if (item.type === 'generate_frame') return item.outputs.startPath || null;
  // generate_asset outputs: { key, path }
  if (item.type === 'generate_asset') return item.outputs.path || null;
  // generate_video outputs: { path, duration, ... }
  if (item.type === 'generate_video') return item.outputs.path || null;
  // assemble outputs: { path }
  if (item.type === 'assemble') return item.outputs.path || null;
  return null;
}

function getItemDescription(item) {
  let desc = null;
  if (item.type === 'generate_frame') desc = item.inputs?.shot?.startFramePrompt;
  else if (item.type === 'generate_video') desc = item.inputs?.shot?.actionPrompt;
  else if (item.type === 'generate_asset') desc = item.inputs?.description;
  else if (item.type === 'artifact') {
    const at = item.inputs?.artifactType;
    if (at === 'character') desc = item.inputs?.physicalDescription;
    else if (at === 'location' || at === 'object') desc = item.inputs?.visualDescription;
    else if (at === 'scene') desc = item.inputs?.narrativeSummary;
    else if (at === 'pacing') desc = item.inputs?.artStyle;
  }
  if (!desc) return null;
  return desc.length > 80 ? desc.slice(0, 80) + '…' : desc;
}

function renderQueueItem(item) {
  const highClass = item.priority === 'high' ? ' high-priority' : '';
  const vBadge = item.version > 1 ? `<span class="badge badge-version">v${item.version}</span>` : '';
  const priBadge = item.priority === 'high' ? '<span class="badge badge-high">⚡ high</span>' : '';
  const typeName = item.type === 'artifact' && item.inputs?.artifactType
    ? item.inputs.artifactType
    : item.type.replace(/_/g, ' ');

  let actions = '';
  if (item.status === 'failed') {
    actions = `<button data-action="retry" data-id="${item.id}" class="primary">↻ Retry</button>`;
  } else if (item.status === 'pending' || item.status === 'in_progress') {
    actions = `<button data-action="cancel" data-id="${item.id}" class="danger">✕ Cancel</button>`;
  }

  let output = '';
  if (item.outputs && item.status === 'completed') {
    const mediaPath = getMediaPath(item);
    if (mediaPath) {
      const src = `${API}/api/runs/${state.activeRunId}/media/${mediaPath}`;
      if (item.type === 'generate_video') {
        const thumbUrl = item.inputs && item.inputs.startFramePath ? `${API}/api/runs/${state.activeRunId}/media/${item.inputs.startFramePath}` : '';
        if (thumbUrl) {
          output = `<div class="q-item-output"><div class="video-thumbnail" data-video-class="inline-video" onclick="playVideo(this, '${src}')"><img src="${thumbUrl}" alt="Video thumbnail" /><div class="play-overlay">▶</div></div></div>`;
        } else {
          output = `<div class="q-item-output"><div class="video-thumbnail video-thumbnail-no-img" data-video-class="inline-video" onclick="playVideo(this, '${src}')"><div class="play-overlay">▶</div></div></div>`;
        }
      } else if (item.type === 'assemble') {
        output = `<div class="q-item-output"><div class="video-thumbnail" data-video-class="inline-video" onclick="playVideo(this, '${src}')"><div class="play-overlay">▶</div></div></div>`;
      } else {
        output = `<div class="q-item-output"><img src="${src}" loading="lazy" /></div>`;
      }
    }
  }

  const retryBadge = item.retryCount > 0 ? `<span class="badge badge-retry">↻${item.retryCount}</span>` : '';

  return `<div class="q-item${highClass}" data-id="${item.id}">
    <div class="q-item-header">
      <span class="q-item-type">${typeName}</span>
      <span class="badge badge-${item.status}">${item.status}</span>
      ${priBadge}${vBadge}${retryBadge}
    </div>
    <div class="q-item-key">${item.itemKey}</div>
    ${(() => { const d = getItemDescription(item); return d ? `<div class="q-item-desc">${d}</div>` : ''; })()}
    ${output}
    ${actions ? `<div class="q-item-actions">${actions}</div>` : ''}
  </div>`;
}

function checkAssembly() {
  const section = $('assembly-section');
  // Check if there's an assembly item that's completed
  for (const qName of ['llm', 'image', 'video']) {
    const q = state.queues[qName];
    if (!q) continue;
    for (const item of (q.completed || [])) {
      if (item.type === 'assemble' && item.outputs && item.outputs.path) {
        const src = `${API}/api/runs/${state.activeRunId}/media/${item.outputs.path}`;
        const container = $('final-video-container');
        container.innerHTML = `<div class="video-thumbnail video-thumbnail-final" data-video-class="assembly-video" onclick="playVideo(this, '${src}')"><div class="play-overlay play-overlay-large">▶</div></div>`;
        section.style.display = 'block';
        return;
      }
    }
  }
  section.style.display = 'none';
}

// --- Graph rendering (simple layered layout) ---
const NODE_W = 140, NODE_H = 40, PAD_X = 40, PAD_Y = 60;
const STATUS_COLORS = {
  pending: '#6b7280', in_progress: '#4f8ff7', completed: '#34d399',
  failed: '#f87171', cancelled: '#6b7280', superseded: '#fb923c',
};

function setupGraphControls() {
  $('hide-superseded').addEventListener('change', () => renderGraph());
  $('fit-graph').addEventListener('click', () => renderGraph());
}

function renderGraph() {
  if (!state.graph) return;
  const hideSuperseded = $('hide-superseded').checked;
  let { nodes, edges } = state.graph;

  if (hideSuperseded) {
    const hidden = new Set(nodes.filter(n => n.status === 'superseded').map(n => n.id));
    nodes = nodes.filter(n => !hidden.has(n.id));
    edges = edges.filter(e => !hidden.has(e.from) && !hidden.has(e.to));
  }

  // Topological layering
  const layers = computeLayers(nodes, edges);
  const positions = layoutNodes(layers, nodes);

  const svgW = Math.max(600, (Math.max(...Object.values(positions).map(p => p.x)) || 0) + NODE_W + PAD_X * 2);
  const svgH = Math.max(400, (Math.max(...Object.values(positions).map(p => p.y)) || 0) + NODE_H + PAD_Y * 2);

  const svg = $('graph-svg');
  svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
  svg.style.width = `${svgW}px`;
  svg.style.height = `${svgH}px`;

  let html = `<defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
    <polygon points="0 0, 8 3, 0 6" fill="${STATUS_COLORS.pending}" />
  </marker></defs>`;

  // Edges
  for (const edge of edges) {
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to) continue;
    const x1 = from.x + NODE_W / 2, y1 = from.y + NODE_H;
    const x2 = to.x + NODE_W / 2, y2 = to.y;
    const cy1 = y1 + (y2 - y1) * 0.4, cy2 = y1 + (y2 - y1) * 0.6;
    html += `<path class="graph-edge" d="M${x1},${y1} C${x1},${cy1} ${x2},${cy2} ${x2},${y2}" />`;
  }

  // Nodes
  for (const node of nodes) {
    const pos = positions[node.id];
    if (!pos) continue;
    const color = STATUS_COLORS[node.status] || STATUS_COLORS.pending;
    const supClass = node.status === 'superseded' ? ' superseded' : '';
    const label = node.type.replace(/_/g, ' ').slice(0, 18);
    const vLabel = node.version > 1 ? ` v${node.version}` : '';
    html += `<g class="graph-node${supClass}" data-id="${node.id}" transform="translate(${pos.x},${pos.y})">
      <rect width="${NODE_W}" height="${NODE_H}" fill="${color}22" stroke="${color}" />
      <text x="${NODE_W/2}" y="16" text-anchor="middle" font-size="11">${label}${vLabel}</text>
      <text x="${NODE_W/2}" y="30" text-anchor="middle" font-size="9" fill="${STATUS_COLORS.pending}">${node.itemKey.slice(0, 22)}</text>
    </g>`;
  }

  svg.innerHTML = html;

  // Click handlers
  for (const el of svg.querySelectorAll('.graph-node')) {
    el.addEventListener('click', () => showDetail(el.dataset.id));
  }
}

function computeLayers(nodes, edges) {
  const inDeg = {};
  const adj = {};
  for (const n of nodes) { inDeg[n.id] = 0; adj[n.id] = []; }
  for (const e of edges) {
    if (inDeg[e.to] !== undefined) inDeg[e.to]++;
    if (adj[e.from]) adj[e.from].push(e.to);
  }

  const layers = [];
  const assigned = new Set();
  let remaining = nodes.map(n => n.id);

  while (remaining.length > 0) {
    const layer = remaining.filter(id => {
      if (assigned.has(id)) return false;
      // All predecessors assigned?
      const preds = edges.filter(e => e.to === id).map(e => e.from);
      return preds.every(p => assigned.has(p) || !remaining.includes(p));
    });
    if (layer.length === 0) { // cycle breaker
      layers.push([remaining[0]]);
      assigned.add(remaining[0]);
      remaining = remaining.slice(1);
      continue;
    }
    layers.push(layer);
    for (const id of layer) assigned.add(id);
    remaining = remaining.filter(id => !assigned.has(id));
  }
  return layers;
}

function layoutNodes(layers, nodes) {
  const positions = {};
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    const totalW = layer.length * NODE_W + (layer.length - 1) * PAD_X;
    const startX = PAD_X;
    for (let ni = 0; ni < layer.length; ni++) {
      positions[layer[ni]] = {
        x: startX + ni * (NODE_W + PAD_X),
        y: PAD_Y + li * (NODE_H + PAD_Y),
      };
    }
  }
  return positions;
}


// --- Detail panel ---
function setupDetailPanel() {
  $('close-detail').addEventListener('click', closeDetail);
}

function closeDetail() {
  $('detail-panel').classList.remove('open');
}

function findItem(itemId) {
  for (const qName of ['llm', 'image', 'video']) {
    const q = state.queues[qName];
    if (!q) continue;
    for (const group of [q.inProgress, q.pending, q.completed, q.failed, q.superseded, q.cancelled]) {
      if (!group) continue;
      const found = group.find(i => i.id === itemId);
      if (found) return found;
    }
  }
  return null;
}

function showDetail(itemId) {
  const item = findItem(itemId);
  if (!item) return;

  const panel = $('detail-panel');
  const content = $('detail-content');

  const typeName = item.type.replace(/_/g, ' ');
  const vBadge = item.version > 1 ? `<span class="badge badge-version">v${item.version}</span>` : '';
  const priBadge = item.priority === 'high' ? `<span class="badge badge-high">⚡ high</span>` : '';

  let actionsHtml = '';
  if (item.status === 'failed') {
    actionsHtml = `<button class="primary" onclick="handleAction('retry','${item.id}')">↻ Retry</button>`;
  } else if (item.status === 'pending' || item.status === 'in_progress') {
    actionsHtml = `
      <button class="danger" onclick="handleAction('cancel','${item.id}')">✕ Cancel</button>`;
  }

  let outputHtml = '';
  if (item.outputs && Object.keys(item.outputs).length > 0) {
    const mediaPath = getMediaPath(item);
    if (mediaPath) {
      const src = `${API}/api/runs/${state.activeRunId}/media/${mediaPath}`;
      if (item.type === 'generate_video' || item.type === 'assemble') {
        const thumbUrl = item.type === 'generate_video' && item.inputs && item.inputs.startFramePath
          ? `${API}/api/runs/${state.activeRunId}/media/${item.inputs.startFramePath}` : '';
        if (thumbUrl) {
          outputHtml = `<div class="video-thumbnail" data-video-class="detail-video" onclick="playVideo(this, '${src}')"><img src="${thumbUrl}" alt="Video thumbnail" /><div class="play-overlay play-overlay-large">▶</div></div>`;
        } else {
          outputHtml = `<div class="video-thumbnail video-thumbnail-final" data-video-class="detail-video" onclick="playVideo(this, '${src}')"><div class="play-overlay play-overlay-large">▶</div></div>`;
        }
      } else {
        outputHtml = `<img src="${src}" style="max-width:100%;border-radius:6px;" />`;
      }
    }
    outputHtml += `<pre>${JSON.stringify(item.outputs, null, 2)}</pre>`;
  }

  const retryInfo = item.retryCount > 0 ? `<div class="detail-section"><h3>Retries</h3><span class="badge badge-retry">${item.retryCount}/3</span></div>` : '';

  // Store original inputs for dirty tracking
  _originalInputs = item.inputs ? JSON.parse(JSON.stringify(item.inputs)) : {};

  content.innerHTML = `
    <div class="detail-section">
      <h2 style="margin:0 0 0.5rem">${typeName} ${vBadge} ${priBadge}</h2>
      <span class="badge badge-${item.status}" style="font-size:0.85rem">${item.status}</span>
    </div>
    <div class="detail-section">
      <h3>Item Key</h3>
      <code>${item.itemKey}</code>
    </div>
    <div class="detail-section">
      <h3>Queue</h3>
      <code>${item.queue}</code>
    </div>
    <div class="detail-section">
      <h3>Timestamps</h3>
      <div style="font-size:0.8rem;color:var(--muted)">
        Created: ${fmtTime(item.createdAt)}<br/>
        Started: ${fmtTime(item.startedAt)}<br/>
        Completed: ${fmtTime(item.completedAt)}
      </div>
    </div>
    ${retryInfo}
    ${item.error ? `<div class="detail-section"><h3>Error</h3><pre style="color:var(--red)">${esc(item.error)}</pre></div>` : ''}
    <div class="detail-section">
      <h3>Inputs</h3>
      ${renderInputForm(item.inputs || {}, item.id, item.status === 'pending' || item.status === 'completed' || item.status === 'failed', item.status)}
    </div>
    ${outputHtml ? `<div class="detail-section"><h3>Outputs</h3>${outputHtml}</div>` : ''}
    ${actionsHtml ? `<div class="detail-actions">${actionsHtml}</div>` : ''}
  `;

  panel.classList.add('open');
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString();
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// --- Actions ---
// Make handleAction global for onclick attributes
window.handleAction = handleAction;

async function handleAction(action, itemId) {
  if (!state.activeRunId) return;
  const base = `${API}/api/runs/${state.activeRunId}/items/${itemId}`;

  try {
    if (action === 'retry') {
      await fetch(`${base}/retry`, { method: 'POST' });
      await Promise.all([fetchQueues(), fetchGraph()]);
      closeDetail();
    } else if (action === 'redo') {
      await fetch(`${base}/redo`, { method: 'POST' });
      await Promise.all([fetchQueues(), fetchGraph()]);
      closeDetail();
    } else if (action === 'cancel') {
      await fetch(`${base}/cancel`, { method: 'POST' });
      await Promise.all([fetchQueues(), fetchGraph()]);
      closeDetail();
    }
  } catch (e) {
    console.error(`Action ${action} failed:`, e);
  }
}

// --- Form-based input editor ---

function camelToLabel(key) {
  // Special cases
  if (key === 'durationSeconds') return 'Duration (seconds)';
  // General camelCase → Title Case
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, c => c.toUpperCase())
    .trim();
}

function renderInputForm(inputs, itemId, editable, itemStatus) {
  if (!inputs || Object.keys(inputs).length === 0) {
    return '<div style="color:var(--muted);font-size:0.8rem">No inputs</div>';
  }
  const fields = renderFormFields(inputs, '', editable);
  const isRedo = itemStatus === 'completed' || itemStatus === 'failed';
  const btnLabel = isRedo ? 'Save & Redo' : 'Save Changes';
  const saveBtn = editable
    ? `<button class="save-inputs-btn" id="save-inputs-btn" data-item-status="${itemStatus || ''}" onclick="saveInputForm('${itemId}')">${btnLabel}</button>`
    : '';
  return `<div class="input-form" id="input-form">${fields}${saveBtn}</div>`;
}

function renderFormFields(obj, prefix, editable) {
  let html = '';
  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    const label = camelToLabel(key);

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Nested object → collapsible group
      const inner = renderFormFields(value, fieldPath, editable);
      html += `<div class="input-group" id="group-${fieldPath}">
        <div class="input-group-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="chevron">▼</span> ${label}
        </div>
        <div class="input-group-body">${inner}</div>
      </div>`;
    } else {
      html += renderSingleField(fieldPath, label, value, editable);
    }
  }
  return html;
}

function renderSingleField(fieldPath, label, value, editable) {
  const dataAttr = `data-field="${fieldPath}"`;

  if (typeof value === 'boolean') {
    if (editable) {
      return `<div class="input-field">
        <div class="checkbox-row">
          <input type="checkbox" ${dataAttr} ${value ? 'checked' : ''} onchange="markInputDirty()"/>
          <span class="input-label">${label}</span>
        </div>
      </div>`;
    }
    return `<div class="input-field">
      <span class="input-label">${label}</span>
      <span class="readonly-value">${value ? '✓ Yes' : '✗ No'}</span>
    </div>`;
  }

  if (typeof value === 'number') {
    if (editable) {
      return `<div class="input-field">
        <span class="input-label">${label}</span>
        <input type="number" ${dataAttr} value="${value}" step="any" oninput="markInputDirty()"/>
      </div>`;
    }
    return `<div class="input-field">
      <span class="input-label">${label}</span>
      <span class="readonly-value">${value}</span>
    </div>`;
  }

  if (Array.isArray(value)) {
    const strVal = value.join(', ');
    if (editable) {
      return `<div class="input-field">
        <span class="input-label">${label}</span>
        <input type="text" ${dataAttr} data-type="array" value="${esc(strVal)}" oninput="markInputDirty()"/>
      </div>`;
    }
    return `<div class="input-field">
      <span class="input-label">${label}</span>
      <span class="readonly-value">${esc(strVal) || '—'}</span>
    </div>`;
  }

  // String or null/undefined
  const strValue = value == null ? '' : String(value);
  const isLong = strValue.length > 100;

  if (editable) {
    if (value == null) {
      return `<div class="input-field">
        <span class="input-label">${label}</span>
        <input type="text" ${dataAttr} data-type="nullable" value="" disabled placeholder="null" />
      </div>`;
    }
    if (isLong) {
      return `<div class="input-field">
        <span class="input-label">${label}</span>
        <textarea ${dataAttr} oninput="markInputDirty()">${esc(strValue)}</textarea>
      </div>`;
    }
    return `<div class="input-field">
      <span class="input-label">${label}</span>
      <input type="text" ${dataAttr} value="${esc(strValue)}" oninput="markInputDirty()"/>
    </div>`;
  }

  // Read-only
  if (isLong) {
    return `<div class="input-field">
      <span class="input-label">${label}</span>
      <div class="readonly-value" style="white-space:pre-wrap;word-break:break-word;max-height:120px;overflow-y:auto">${esc(strValue)}</div>
    </div>`;
  }
  return `<div class="input-field">
    <span class="input-label">${label}</span>
    <span class="readonly-value">${esc(strValue) || '—'}</span>
  </div>`;
}

function markInputDirty() {
  const btn = document.getElementById('save-inputs-btn');
  if (btn) btn.classList.add('visible');
}

function collectFormValues(original, prefix) {
  const result = {};
  for (const [key, value] of Object.entries(original)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = collectFormValues(value, fieldPath);
    } else {
      const el = document.querySelector(`[data-field="${fieldPath}"]`);
      if (!el) { result[key] = value; continue; }

      if (typeof value === 'boolean') {
        result[key] = el.checked;
      } else if (typeof value === 'number') {
        result[key] = parseFloat(el.value) || 0;
      } else if (Array.isArray(value)) {
        result[key] = el.value.split(',').map(s => s.trim()).filter(Boolean);
      } else if (value == null) {
        result[key] = value; // keep null
      } else {
        result[key] = el.value;
      }
    }
  }
  return result;
}

window.markInputDirty = markInputDirty;

window.saveInputForm = async function(itemId) {
  if (!_originalInputs || !state.activeRunId) return;
  const inputs = collectFormValues(_originalInputs, '');
  const btn = document.getElementById('save-inputs-btn');
  const itemStatus = btn ? btn.dataset.itemStatus : '';
  const isRedo = itemStatus === 'completed' || itemStatus === 'failed';
  if (btn) { btn.textContent = isRedo ? 'Redoing...' : 'Saving...'; btn.disabled = true; }

  try {
    if (isRedo) {
      // Call redo endpoint with the edited inputs
      const res = await fetch(`${API}/api/runs/${state.activeRunId}/items/${itemId}/redo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs }),
      });
      const data = await res.json();
      await Promise.all([fetchQueues(), fetchGraph()]);
      // Show the newly created item
      if (data.newItem && data.newItem.id) {
        showDetail(data.newItem.id);
      } else {
        closeDetail();
      }
    } else {
      // Edit pending item in place
      await fetch(`${API}/api/runs/${state.activeRunId}/items/${itemId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs }),
      });
      await Promise.all([fetchQueues(), fetchGraph()]);
      showDetail(itemId);
    }
  } catch (e) {
    console.error('Save failed:', e);
    if (btn) { btn.textContent = isRedo ? 'Save & Redo' : 'Save Changes'; btn.disabled = false; }
  }
};