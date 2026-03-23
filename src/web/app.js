const STAGE_ORDER = [
  "analysis",
  "shot_planning",
  "asset_generation",
  "frame_generation",
  "video_generation",
  "shot_generation",
  "assembly",
];

const MAX_EVENTS = 300;
const POLL_INTERVAL_MS = 2_500;
const REFRESH_DEBOUNCE_MS = 220;

// Cache the last rendered HTML to avoid DOM rebuilds when content hasn't changed
let lastStageOutputHtml = null;

const state = {
  runs: [],
  activeRunId: null,
  activeRun: null,
  assetsById: new Map(),
  events: [],
  eventSource: null,
  pollTimer: null,
  refreshTimer: null,
  directives: {},  // { [target]: { target, directive, createdAt, updatedAt } }
};

const elements = {
  runView: getElement("run-view"),
  createView: getElement("create-view"),
  newRunButton: getElement("new-run-button"),
  createRunForm: getElement("create-run-form"),
  storyText: getElement("story-text"),
  createRunButton: getElement("create-run-button"),
  tabNewStory: getElement("tab-new-story"),
  tabImportVideo: getElement("tab-import-video"),
  panelNewStory: getElement("panel-new-story"),
  panelImportVideo: getElement("panel-import-video"),
  importVideoForm: getElement("import-video-form"),
  importVideoUrl: getElement("import-video-url"),
  importVideoFile: getElement("import-video-file"),
  importVideoButton: getElement("import-video-button"),
  reviewModeCheckbox: getElement("review-mode-checkbox"),
  runSelect: getElement("run-select"),
  refreshRunsButton: getElement("refresh-runs-button"),
  runId: getElement("run-id"),
  runStatus: getElement("run-status"),
  runStage: getElement("run-stage"),
  runProgress: getElement("run-progress"),
  runOutput: getElement("run-output"),
  runVideoBackend: getElement("run-video-backend"),
  runError: getElement("run-error"),
  connectionStatus: getElement("connection-status"),
  stageList: getElement("stage-list"),
  reviewAwaiting: getElement("review-awaiting"),
  reviewContinueState: getElement("review-continue-state"),
  reviewPendingCount: getElement("review-pending-count"),
  reviewLockMessage: getElement("review-lock-message"),
  instructionForm: getElement("instruction-form"),
  instructionText: getElement("instruction-text"),
  instructionStage: getElement("instruction-stage"),
  submitInstructionButton: getElement("submit-instruction-button"),
  continueButton: getElement("continue-button"),
  retryButton: getElement("retry-button"),
  deleteRunButton: getElement("delete-run-button"),
  eventsList: getElement("events-list"),
  stageOutputSection: getElement("stage-output-section"),
  stageOutput: getElement("stage-output"),
  lightboxOverlay: getElement("lightbox-overlay"),
  lightboxImage: getElement("lightbox-image"),
  lightboxClose: getElement("lightbox-overlay").querySelector(".lightbox-close"),
};

function getElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element;
}

function showRunView() {
  elements.runView.style.display = "";
  elements.createView.style.display = "none";
}

function showCreateView() {
  elements.runView.style.display = "none";
  elements.createView.style.display = "";
}

function formatStageLabel(stage) {
  return stage.replace(/_/g, " ");
}

function formatTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function escapeHtml(text) {
  if (typeof text !== "string") {
    return "";
  }
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function findAsset(key) {
  for (const asset of state.assetsById.values()) {
    if (asset.key === key) return asset;
  }
  return null;
}

function formatReferenceType(type) {
  if (type === "character") return "char";
  if (type === "location") return "loc";
  return "cont";
}

function buildFrameReferenceSummary(asset) {
  const references = Array.isArray(asset?.references) ? asset.references : [];
  if (references.length === 0) {
    return "";
  }
  const summary = references
    .filter((reference) => reference && typeof reference.name === "string" && typeof reference.type === "string")
    .map((reference) => `${escapeHtml(reference.name)} (${escapeHtml(formatReferenceType(reference.type))})`)
    .join(", ");

  return summary ? `<p class="shot-asset-refs">Refs: ${summary}</p>` : "";
}

function collectShotReferenceAssets(shot) {
  const references = [];
  const charactersPresent = Array.isArray(shot?.charactersPresent) ? shot.charactersPresent : [];

  for (const charName of charactersPresent) {
    if (typeof charName !== "string" || charName.length === 0) continue;

    const frontAsset = findAsset(`character:${charName}:front`);
    const angleAsset = findAsset(`character:${charName}:angle`);

    if (frontAsset?.previewUrl) {
      references.push({
        name: charName,
        subtype: "front",
        previewUrl: frontAsset.previewUrl,
      });
    }

    if (angleAsset?.previewUrl) {
      references.push({
        name: charName,
        subtype: "angle",
        previewUrl: angleAsset.previewUrl,
      });
    }
  }

  if (typeof shot?.location === "string" && shot.location.length > 0) {
    const locationAsset = findAsset(`location:${shot.location}:front`);
    if (locationAsset?.previewUrl) {
      references.push({
        name: shot.location,
        subtype: "location",
        previewUrl: locationAsset.previewUrl,
      });
    }
  }

  return references;
}

function isRunActivelyExecuting(run) {
  return Boolean(run) && (run.status === "queued" || run.status === "running");
}

function isRunReviewSafe(run) {
  return Boolean(run) && run.status === "awaiting_review" && Boolean(run.review?.awaitingUserReview);
}

function isStageGenerating(stage) {
  return isRunActivelyExecuting(state.activeRun) && state.activeRun.currentStage === stage;
}

function isImportRun(run) {
  return Boolean(run) && run.mode === "import";
}

function setReviewLockMessage(message, tone = "locked") {
  elements.reviewLockMessage.textContent = message;
  elements.reviewLockMessage.classList.remove("lock-message-locked", "lock-message-ready");
  elements.reviewLockMessage.classList.add(tone === "ready" ? "lock-message-ready" : "lock-message-locked");
}


function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function showAssetUploadNotification(assetKey) {
  // Remove any existing notification
  const existing = document.querySelector(".asset-upload-notification");
  if (existing) existing.remove();

  const notification = document.createElement("div");
  notification.className = "asset-upload-notification";
  notification.innerHTML = `
    <span>✅ Asset updated (<strong>${escapeHtml(assetKey)}</strong>). Frames using this reference may need regeneration.</span>
    <button class="notification-dismiss" title="Dismiss">✕</button>
  `;
  notification.querySelector(".notification-dismiss").addEventListener("click", () => {
    notification.remove();
  });
  // Auto-dismiss after 8 seconds
  setTimeout(() => notification.remove(), 8000);

  // Insert at top of stage output section
  const target = elements.stageOutputSection;
  if (target) {
    target.prepend(notification);
  }
}


function setGlobalError(message) {
  if (!message) {
    elements.runError.textContent = "";
    elements.runError.classList.add("hidden");
    return;
  }
  elements.runError.textContent = message;
  elements.runError.classList.remove("hidden");
}

function openLightbox(src) {
  elements.lightboxImage.src = src;
  elements.lightboxOverlay.classList.add("lightbox-visible");
}

function closeLightbox() {
  elements.lightboxOverlay.classList.remove("lightbox-visible");
  elements.lightboxImage.src = "";
}

function setConnectionStatus(value) {
  elements.connectionStatus.textContent = value;
}

async function requestJson(url, options = {}) {
  const config = { ...options };
  const headers = new Headers(config.headers ?? {});
  if (config.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  config.headers = headers;

  const response = await fetch(url, config);
  const raw = await response.text();
  let parsed = {};
  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON response from ${url}`);
    }
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed.error === "string"
        ? parsed.error
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return parsed;
}

function populateInstructionStageSelect() {
  const currentValue = elements.instructionStage.value;
  elements.instructionStage.replaceChildren();

  // Add empty "all stages" option
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "All stages";
  elements.instructionStage.append(emptyOption);

  const stages = getStagesForBackend(state.activeRun);
  for (const stage of stages) {
    const option = document.createElement("option");
    option.value = stage;
    option.textContent = formatStageLabel(stage);
    elements.instructionStage.append(option);
  }

  // Restore previous selection if still valid
  if (stages.includes(currentValue)) {
    elements.instructionStage.value = currentValue;
  }
}

function renderRunSelect() {
  const current = state.activeRunId;
  elements.runSelect.replaceChildren();

  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = state.runs.length > 0 ? "Select a run..." : "No runs found";
  elements.runSelect.append(emptyOption);

  for (const run of state.runs) {
    const option = document.createElement("option");
    option.value = run.id;
    const label = run.name || run.id.slice(0, 8) + "...";
    option.textContent = `${label} (${run.status})`;
    elements.runSelect.append(option);
  }

  if (current && state.runs.some((run) => run.id === current)) {
    elements.runSelect.value = current;
  } else {
    elements.runSelect.value = "";
  }
}

function getStagesForBackend(run) {
  const isGrok = run?.options?.videoBackend === "grok";
  return STAGE_ORDER.filter((stage) => {
    if (isGrok && (stage === "frame_generation" || stage === "video_generation")) return false;
    if (!isGrok && stage === "shot_generation") return false;
    return true;
  });
}

function renderStageProgress() {
  elements.stageList.replaceChildren();
  const run = state.activeRun;
  const importMode = isImportRun(run);
  const importProtectedStages = ["analysis", "shot_planning"];
  const stages = getStagesForBackend(run);

  for (const stage of stages) {
    const item = document.createElement("li");
    const stageLabel = formatStageLabel(stage);
    item.textContent = stageLabel;

    if (!run) {
      item.classList.add("stage-pending");
    } else if (run.completedStages.includes(stage)) {
      item.classList.add("stage-complete");
      item.textContent += " - complete";

      // Add redo button for completed stages (hidden for import-protected stages)
      if (!(importMode && importProtectedStages.includes(stage))) {
        const redoBtn = document.createElement("button");
        redoBtn.className = "redo-button";
        redoBtn.textContent = "Redo";
        redoBtn.disabled = isRunActivelyExecuting(run);
        redoBtn.onclick = () => handleRedoClick(stage);
        item.append(" ", redoBtn);
      }
    } else if (run.currentStage === stage) {
      item.classList.add("stage-current");
      item.textContent += " - current";

      // Show Stop button when actively executing, Resume button when stopped
      if (isRunActivelyExecuting(run)) {
        const stopBtn = document.createElement("button");
        stopBtn.className = "stop-button";
        stopBtn.textContent = "Stop";
        stopBtn.onclick = () => handleStopClick();
        item.append(" ", stopBtn);
      } else if (run.status === "stopped" || run.status === "failed") {
        const resumeBtn = document.createElement("button");
        resumeBtn.className = "resume-button";
        resumeBtn.textContent = "Resume";
        resumeBtn.onclick = () => handleRetryClick();
        item.append(" ", resumeBtn);
      }

      // Allow redo for current stage (hidden for import-protected stages)
      if (!(importMode && importProtectedStages.includes(stage))) {
        const redoBtn = document.createElement("button");
        redoBtn.className = "redo-button";
        redoBtn.textContent = "Redo";
        redoBtn.onclick = () => handleRedoClick(stage);
        item.append(" ", redoBtn);
      }
    } else {
      item.classList.add("stage-pending");
      item.textContent += " - pending";
    }

    elements.stageList.append(item);
  }
}

function renderStatusBadge(status) {
  const badge = document.createElement("span");
  badge.className = `status status-${status}`;
  badge.textContent = formatStageLabel(status);
  elements.runStatus.replaceChildren(badge);
}

function renderRunName(run, force = false) {
  const container = elements.runId;
  // Don't clobber an active rename input during poll-driven re-renders
  if (!force && container.querySelector(".run-name-input")) return;
  container.replaceChildren();

  const nameSpan = document.createElement("span");
  nameSpan.className = "run-name-display";
  nameSpan.textContent = run.name || run.id.slice(0, 8) + "...";
  nameSpan.title = "Click to rename";
  nameSpan.style.cursor = "pointer";

  const idSpan = document.createElement("span");
  idSpan.className = "run-id-small";
  idSpan.textContent = ` (${run.id.slice(0, 8)})`;

  nameSpan.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "run-name-input";
    input.value = run.name || "";
    input.placeholder = "Enter run name...";
    input.maxLength = 60;
    let saving = false;

    const close = () => {
      if (saving) return;
      saving = true;
      renderRunName(run, true);
    };

    const save = async () => {
      if (saving) return;
      saving = true;
      const newName = input.value.trim();
      if (!newName || newName === run.name) {
        renderRunName(run, true);
        return;
      }
      try {
        await requestJson(`/runs/${encodeURIComponent(run.id)}/rename`, {
          method: "POST",
          body: JSON.stringify({ name: newName }),
        });
        run.name = newName;
        const matchingRun = state.runs.find(r => r.id === run.id);
        if (matchingRun) matchingRun.name = newName;
        renderRunSelect();
      } catch (error) {
        setGlobalError(`Failed to rename: ${error.message}`);
      }
      renderRunName(run, true);
    };

    input.addEventListener("blur", () => save());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); save(); }
      if (e.key === "Escape") { e.preventDefault(); close(); }
    });

    container.replaceChildren(input, idSpan);
    input.focus();
    input.select();
  });

  container.append(nameSpan, idSpan);
}

function renderRunDetails() {
  const run = state.activeRun;
  if (!run) {
    elements.runId.textContent = "-";
    elements.runStatus.textContent = "idle";
    elements.runStage.textContent = "-";
    elements.runProgress.textContent = "0 / 6 (0%)";
    elements.runOutput.textContent = "-";
    elements.runVideoBackend.value = "veo";
    elements.runVideoBackend.disabled = true;
    document.getElementById("run-aspect-ratio").textContent = "-";
    elements.reviewAwaiting.textContent = "no";
    elements.reviewContinueState.textContent = "no";
    elements.reviewPendingCount.textContent = "0";
    elements.reviewModeCheckbox.checked = false;
    elements.reviewModeCheckbox.disabled = true;
    elements.submitInstructionButton.disabled = true;
    elements.instructionText.disabled = true;
    elements.instructionStage.disabled = true;
    elements.continueButton.disabled = true;
    elements.retryButton.disabled = true;
    elements.deleteRunButton.disabled = true;
    setReviewLockMessage("Select a run to inspect review control lock state.");
    populateInstructionStageSelect();
    renderStageProgress();
    return;
  }

  elements.reviewModeCheckbox.checked = Boolean(run.options?.reviewMode);
  elements.reviewModeCheckbox.disabled = false;

  renderStatusBadge(run.status);
  renderRunName(run);
  elements.runStage.textContent = formatStageLabel(run.currentStage);
  elements.runProgress.textContent = `${run.progress.completed} / ${run.progress.total} (${run.progress.percent}%)`;
  elements.runOutput.textContent = run.outputDir;
  elements.runVideoBackend.value = run.options?.videoBackend || "veo";
  elements.runVideoBackend.disabled = false;
  document.getElementById("run-aspect-ratio").textContent = run.options?.aspectRatio || "16:9";
  setGlobalError(run.error ? `Run error: ${run.error}` : "");

  const awaiting = Boolean(run.review?.awaitingUserReview);
  const continueRequested = Boolean(run.review?.continueRequested);
  const pendingCount = Number(run.review?.pendingInstructionCount ?? 0);

  elements.reviewAwaiting.textContent = awaiting ? "yes" : "no";
  elements.reviewContinueState.textContent = continueRequested ? "yes" : "no";
  elements.reviewPendingCount.textContent = String(pendingCount);

  const reviewSafe = isRunReviewSafe(run);
  const canAddInstructions = reviewSafe || run.status === "stopped" || run.status === "failed";
  elements.submitInstructionButton.disabled = !canAddInstructions;
  elements.instructionText.disabled = !canAddInstructions;
  elements.instructionStage.disabled = !canAddInstructions;
  elements.continueButton.disabled = !reviewSafe || continueRequested;

  if (isRunActivelyExecuting(run)) {
    setReviewLockMessage(
      "Review controls are locked while this run is executing (queued/running). Stop the run to add instructions.",
    );
    elements.retryButton.disabled = true;
  } else if (run.status === "stopped") {
    elements.retryButton.disabled = false;
    setReviewLockMessage(
      "Run stopped. Add instructions for the current stage, then Resume to continue.",
      "ready",
    );
  } else if (run.status === "failed") {
    elements.retryButton.disabled = false;
    setReviewLockMessage(
      "Run failed. Add instructions for the current stage, then Retry to resume.",
      "ready",
    );
  } else if (reviewSafe) {
    elements.retryButton.disabled = true;
    if (continueRequested) {
      setReviewLockMessage(
        "Run is in review-safe state. Continue has already been requested; you can still submit instructions.",
        "ready",
      );
    } else {
      setReviewLockMessage(
        "Run is in review-safe state. Submit instructions or continue to the next stage.",
        "ready",
      );
    }
  } else {
    elements.retryButton.disabled = true;
    setReviewLockMessage(
      `Review controls are unavailable while status is \"${formatStageLabel(run.status)}\". Controls unlock when status returns to \"awaiting review\" (including after interrupt).`,
    );
  }

  // Delete is available when the run is not actively executing
  elements.deleteRunButton.disabled = isRunActivelyExecuting(run);

  // Show/hide Analyze Pacing button based on whether we have videos
  const analyzePacingBtn = document.getElementById("analyze-pacing-btn");
  if (analyzePacingBtn) {
    const hasVideos = run.completedStages?.includes("video_generation") ||
                      run.completedStages?.includes("shot_generation") ||
                      run.completedStages?.includes("assembly");
    analyzePacingBtn.style.display = hasVideos ? "" : "none";
  }

  populateInstructionStageSelect();
  renderStageProgress();

  // Restore pacing results if available from server state
  if (run.pacingAnalysis && run.pacingAnalysis.length > 0) {
    showPacingResults(run.pacingAnalysis);
  }
}

function createEventEntry({ level = "info", title, message, timestamp }) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    level,
    title,
    message,
    timestamp: timestamp || new Date().toISOString(),
  };
}

function appendEvent(entry) {
  state.events.unshift(entry);
  if (state.events.length > MAX_EVENTS) {
    state.events.length = MAX_EVENTS;
  }
  renderEvents();
}

function renderEvents() {
  elements.eventsList.replaceChildren();

  if (state.events.length === 0) {
    const empty = document.createElement("li");
    empty.className = "event-info";
    empty.textContent = "No events yet.";
    elements.eventsList.append(empty);
    return;
  }

  for (const eventEntry of state.events) {
    const item = document.createElement("li");
    item.className = eventEntry.level === "error" ? "event-error" : "event-info";

    const title = document.createElement("p");
    title.className = "event-title";
    title.textContent = eventEntry.title;
    item.append(title);

    const message = document.createElement("p");
    message.className = "event-message";
    message.textContent = eventEntry.message;
    item.append(message);

    const time = document.createElement("p");
    time.className = "event-time";
    time.textContent = formatTimestamp(eventEntry.timestamp);
    item.append(time);

    elements.eventsList.append(item);
  }
}

function renderStoryDocument() {
  // Re-render the story document to show newly arrived assets
  // This is called when new assets arrive via SSE or polling
  void fetchAndRenderStageOutput({ silent: true });
}

function scheduleRunRefresh() {
  if (state.refreshTimer) {
    return;
  }
  state.refreshTimer = window.setTimeout(() => {
    state.refreshTimer = null;
    void refreshRun({ silent: true });
  }, REFRESH_DEBOUNCE_MS);
}

async function refreshRun({ silent = false } = {}) {
  if (!state.activeRunId) {
    return;
  }
  const runId = state.activeRunId;

  try {
    const run = await requestJson(`/runs/${encodeURIComponent(runId)}`);
    if (state.activeRunId !== runId) {
      return;
    }
    state.activeRun = run;
    renderRunDetails();
    void fetchDirectives();
    void fetchAndRenderStageOutput({ silent });
  } catch (error) {
    if (!silent) {
      setGlobalError(`Failed to fetch run: ${error.message}`);
    }
  }
}

async function refreshAssets({ silent = false } = {}) {
  if (!state.activeRunId) {
    return;
  }
  const runId = state.activeRunId;

  try {
    const response = await requestJson(`/runs/${encodeURIComponent(runId)}/assets`);
    if (state.activeRunId !== runId) {
      return;
    }
    const nextAssets = new Map();
    const assets = Array.isArray(response.assets) ? response.assets : [];
    for (const asset of assets) {
      if (asset && typeof asset.id === "string") {
        nextAssets.set(asset.id, asset);
      }
    }
    state.assetsById = nextAssets;
    renderStoryDocument();
  } catch (error) {
    if (!silent) {
      setGlobalError(`Failed to fetch assets: ${error.message}`);
    }
  }
}


function buildPartialImportHtml(importAnalysisProgress) {
  // Collect frame and video assets from the asset map
  const shotMap = new Map(); // shotNumber → { start, end, video }
  for (const asset of state.assetsById.values()) {
    const key = asset.key;
    if (!key) continue;
    let match;
    match = key.match(/^frame:([0-9]+):(start|end)$/);
    if (match) {
      const num = Number(match[1]);
      const entry = shotMap.get(num) || {};
      entry[match[2]] = asset;
      shotMap.set(num, entry);
      continue;
    }
    match = key.match(/^video:([0-9]+)$/);
    if (match) {
      const num = Number(match[1]);
      const entry = shotMap.get(num) || {};
      entry.video = asset;
      shotMap.set(num, entry);
    }
  }

  // Build a lookup for analysis progress by shot number
  const analysisMap = new Map();
  if (Array.isArray(importAnalysisProgress)) {
    for (const item of importAnalysisProgress) {
      if (item && typeof item.shotNumber === "number") {
        analysisMap.set(item.shotNumber, item);
      }
    }
  }

  if (shotMap.size === 0 && analysisMap.size === 0) return "";

  const totalShots = Math.max(shotMap.size, analysisMap.size);
  const analyzedCount = analysisMap.size;

  let html = `<div class="stage-output-header">`;
  html += `<h3>Import in Progress</h3>`;
  if (analyzedCount > 0 && analyzedCount < totalShots) {
    html += `<p class="muted">Extracted ${totalShots} shot${totalShots !== 1 ? "s" : ""} — analyzed ${analyzedCount} of ${totalShots}…</p>`;
  } else if (analyzedCount >= totalShots && totalShots > 0) {
    html += `<p class="muted">Extracted ${totalShots} shot${totalShots !== 1 ? "s" : ""} — analysis complete</p>`;
  } else {
    html += `<p class="muted">Extracted ${totalShots} shot${totalShots !== 1 ? "s" : ""} — analyzing…</p>`;
  }
  html += `</div>`;

  // Merge shot numbers from both maps
  const allShotNumbers = new Set([...shotMap.keys(), ...analysisMap.keys()]);
  const sorted = [...allShotNumbers].sort((a, b) => a - b);

  html += `<div class="stage-output-section">`;
  html += `<h4>Extracted Frames</h4>`;
  html += `<div class="import-shots-grid">`;
  for (const shotNum of sorted) {
    const assets = shotMap.get(shotNum) || {};
    const analysis = analysisMap.get(shotNum);

    html += `<div class="import-shot-card">`;
    html += `<p class="shot-asset-label">Shot ${shotNum}</p>`;
    html += `<div class="shot-assets">`;
    if (assets.start && assets.start.previewUrl) {
      html += `<div class="shot-asset-item">`;
      html += `<p class="shot-asset-label">Start</p>`;
      html += `<img src="${escapeHtml(assets.start.previewUrl)}" alt="Start Frame" class="inline-thumbnail" />`;
      html += `</div>`;
    }
    if (assets.end && assets.end.previewUrl) {
      html += `<div class="shot-asset-item">`;
      html += `<p class="shot-asset-label">End</p>`;
      html += `<img src="${escapeHtml(assets.end.previewUrl)}" alt="End Frame" class="inline-thumbnail" />`;
      html += `</div>`;
    }
    if (assets.video && assets.video.previewUrl) {
      html += `<div class="shot-asset-item">`;
      html += `<p class="shot-asset-label">Video</p>`;
      html += `<video src="${escapeHtml(assets.video.previewUrl)}" class="inline-video" controls preload="metadata"></video>`;
      html += `</div>`;
    }
    html += `</div>`;

    // Render analysis descriptions if available
    if (analysis) {
      html += `<div class="import-shot-analysis">`;
      if (analysis.composition) {
        html += `<p class="import-analysis-field"><span class="import-analysis-label">Composition:</span> ${escapeHtml(analysis.composition)}</p>`;
      }
      if (analysis.actionPrompt) {
        html += `<p class="import-analysis-field"><span class="import-analysis-label">Action:</span> ${escapeHtml(analysis.actionPrompt)}</p>`;
      }
      if (analysis.startFramePrompt) {
        html += `<p class="import-analysis-field"><span class="import-analysis-label">Start Frame:</span> ${escapeHtml(analysis.startFramePrompt)}</p>`;
      }
      if (analysis.endFramePrompt) {
        html += `<p class="import-analysis-field"><span class="import-analysis-label">End Frame:</span> ${escapeHtml(analysis.endFramePrompt)}</p>`;
      }
      html += `</div>`;
    } else {
      html += `<div class="import-shot-analysis import-shot-analysis-pending">`;
      html += `<p class="muted">Awaiting analysis…</p>`;
      html += `</div>`;
    }

    html += `</div>`;
  }
  html += `</div>`;
  html += `</div>`;

  return html;
}


async function fetchAndRenderStageOutput({ silent = false } = {}) {
  if (!state.activeRunId) {
    elements.stageOutputSection.style.display = "none";
    return;
  }
  const runId = state.activeRunId;

  try {
    const response = await requestJson(`/runs/${encodeURIComponent(runId)}/state`);
    if (state.activeRunId !== runId) {
      return;
    }

    const { storyAnalysis, itemDirectives } = response;
    // Update directives from state endpoint (avoids separate fetch)
    if (itemDirectives) {
      state.directives = itemDirectives;
    }
    // Build the unified story document HTML
    let html = "";

    if (!storyAnalysis) {
      // No story analysis yet — render any available assets (import progress)
      html = buildPartialImportHtml(response.importAnalysisProgress);
      if (!html) {
        elements.stageOutputSection.style.display = "none";
        return;
      }
      if (html !== lastStageOutputHtml) {
        elements.stageOutput.innerHTML = html;
        lastStageOutputHtml = html;
      }
      elements.stageOutputSection.style.display = "";
      return;
    }

    // Title and art style
    html += `<div class="stage-output-header">`;
    html += `<h3>${escapeHtml(storyAnalysis.title)}</h3>`;
    html += `<p class="muted">Art Style: ${escapeHtml(storyAnalysis.artStyle)}</p>`;
    html += `</div>`;

    // Characters with inline images
    if (storyAnalysis.characters && storyAnalysis.characters.length > 0) {
      html += `<div class="stage-output-section">`;
      html += `<h4>Characters</h4>`;
      html += `<table class="stage-output-table">`;
      html += `<thead><tr><th>Name</th><th>Description</th><th>Age Range</th><th>Images</th></tr></thead>`;
      html += `<tbody>`;
      for (const char of storyAnalysis.characters) {
        const charDescTarget = `analysis:character:${char.name}`;
        const charDescDirective = state.directives[charDescTarget];
        const descClass = charDescDirective ? " desc-edited" : "";
        html += `<tr>`;
        html += `<td><strong>${escapeHtml(char.name)}</strong></td>`;
        const charEditBtn = isImportRun(state.activeRun) ? "" : `<button class="editable-desc-btn" data-edit-target="${escapeHtml(charDescTarget)}" data-edit-current="${escapeHtml(char.physicalDescription)}" title="Edit description">✏️</button>`;
        html += `<td><span class="${descClass}">${escapeHtml(char.physicalDescription)}</span>${charEditBtn}</td>`;
        html += `<td>${escapeHtml(char.ageRange)}</td>`;

        // Look up character images
        const frontAsset = findAsset(`character:${char.name}:front`);
        const angleAsset = findAsset(`character:${char.name}:angle`);
        let imagesHtml = "";
        const showCharacterSpinners = isStageGenerating("asset_generation");

        const charRedoItemDisabled = isRunActivelyExecuting(state.activeRun) ? " disabled" : "";
        const isRunning = isRunActivelyExecuting(state.activeRun);
        if (frontAsset || angleAsset || showCharacterSpinners) {
          imagesHtml += `<div class="character-images">`;
          if (frontAsset && frontAsset.previewUrl) {
            const frontKey = `character:${char.name}:front`;
            const frontVersions = state.activeRun?.assetVersions?.[frontKey];
            const selectedFrontVersion = state.activeRun?.selectedAssetVersions?.[frontKey] ?? (frontVersions?.length ?? 1);
            imagesHtml += `<div class="asset-upload-wrapper">`;
            imagesHtml += `<img src="${escapeHtml(frontAsset.previewUrl)}" alt="Front" class="inline-thumbnail" />`;
            imagesHtml += `<button class="asset-upload-btn" data-asset-key="${escapeHtml(frontKey)}" title="Upload replacement image">📷</button>`;
            imagesHtml += buildAssetVersionSelector(frontKey, frontVersions, selectedFrontVersion, isRunning);
            imagesHtml += `</div>`;
          } else if (showCharacterSpinners) {
            imagesHtml += `<div class="spinner-placeholder spinner-image"><div class="spinner-circle"></div><div class="spinner-label">Generating…</div></div>`;
          }
          if (angleAsset && angleAsset.previewUrl) {
            const angleKey = `character:${char.name}:angle`;
            const angleVersions = state.activeRun?.assetVersions?.[angleKey];
            const selectedAngleVersion = state.activeRun?.selectedAssetVersions?.[angleKey] ?? (angleVersions?.length ?? 1);
            imagesHtml += `<div class="asset-upload-wrapper">`;
            imagesHtml += `<img src="${escapeHtml(angleAsset.previewUrl)}" alt="Angle" class="inline-thumbnail" />`;
            imagesHtml += `<button class="asset-upload-btn" data-asset-key="${escapeHtml(angleKey)}" title="Upload replacement image">📷</button>`;
            imagesHtml += buildAssetVersionSelector(angleKey, angleVersions, selectedAngleVersion, isRunning);
            imagesHtml += `</div>`;
          } else if (showCharacterSpinners) {
            imagesHtml += `<div class="spinner-placeholder spinner-image"><div class="spinner-circle"></div><div class="spinner-label">Generating…</div></div>`;
          }
          if ((frontAsset && frontAsset.previewUrl) || (angleAsset && angleAsset.previewUrl)) {
            imagesHtml += `<button class="redo-item-button" data-redo-type="asset" data-redo-asset-key="character:${escapeHtml(char.name)}:front"${charRedoItemDisabled} title="Retry images for ${escapeHtml(char.name)}">↻</button>`;
            imagesHtml += buildDirectiveControls(`asset:character:${char.name}:front`, isRunActivelyExecuting(state.activeRun));
          }
          imagesHtml += `</div>`;
        }
        html += `<td>${imagesHtml}</td>`;
        html += `</tr>`;
      }
      html += `</tbody></table>`;
      html += `</div>`;
    }

    // Locations with inline images
    if (storyAnalysis.locations && storyAnalysis.locations.length > 0) {
      html += `<div class="stage-output-section">`;
      html += `<h4>Locations</h4>`;
      html += `<table class="stage-output-table">`;
      html += `<thead><tr><th>Name</th><th>Description</th><th>Image</th></tr></thead>`;
      html += `<tbody>`;
      for (const loc of storyAnalysis.locations) {
        const locDescTarget = `analysis:location:${loc.name}`;
        const locDescDirective = state.directives[locDescTarget];
        const locDescClass = locDescDirective ? " desc-edited" : "";
        html += `<tr>`;
        html += `<td><strong>${escapeHtml(loc.name)}</strong></td>`;
        const locEditBtn = isImportRun(state.activeRun) ? "" : `<button class="editable-desc-btn" data-edit-target="${escapeHtml(locDescTarget)}" data-edit-current="${escapeHtml(loc.visualDescription)}" title="Edit description">✏️</button>`;
        html += `<td><span class="${locDescClass}">${escapeHtml(loc.visualDescription)}</span>${locEditBtn}</td>`;

        // Look up location image
        const locAsset = findAsset(`location:${loc.name}:front`);
        const locRedoItemDisabled = isRunActivelyExecuting(state.activeRun) ? " disabled" : "";
        let locImageHtml = "";
        if (locAsset && locAsset.previewUrl) {
          const locKey = `location:${loc.name}:front`;
          const locVersions = state.activeRun?.assetVersions?.[locKey];
          const selectedLocVersion = state.activeRun?.selectedAssetVersions?.[locKey] ?? (locVersions?.length ?? 1);
          locImageHtml = `<div class="asset-upload-wrapper">`;
          locImageHtml += `<img src="${escapeHtml(locAsset.previewUrl)}" alt="Location" class="inline-thumbnail" />`;
          locImageHtml += `<button class="asset-upload-btn" data-asset-key="${escapeHtml(locKey)}" title="Upload replacement image">📷</button>`;
          locImageHtml += buildAssetVersionSelector(locKey, locVersions, selectedLocVersion, isRunActivelyExecuting(state.activeRun));
          locImageHtml += `</div>`;
          locImageHtml += `<button class="redo-item-button" data-redo-type="asset" data-redo-asset-key="${escapeHtml(locKey)}"${locRedoItemDisabled} title="Retry image for ${escapeHtml(loc.name)}">↻</button>`;
          locImageHtml += buildDirectiveControls(`asset:${locKey}`, isRunActivelyExecuting(state.activeRun));
        } else if (isStageGenerating("asset_generation")) {
          locImageHtml = `<div class="spinner-placeholder spinner-image"><div class="spinner-circle"></div><div class="spinner-label">Generating…</div></div>`;
        }
        html += `<td>${locImageHtml}</td>`;
        html += `</tr>`;
      }
      html += `</tbody></table>`;
      html += `</div>`;
    }

    // Objects with inline images
    if (storyAnalysis.objects && storyAnalysis.objects.length > 0) {
      html += `<div class="stage-output-section">`;
      html += `<h4>Objects</h4>`;
      html += `<table class="stage-output-table">`;
      html += `<thead><tr><th>Name</th><th>Description</th><th>Image</th></tr></thead>`;
      html += `<tbody>`;
      for (const obj of storyAnalysis.objects) {
        const objDescTarget = `analysis:object:${obj.name}`;
        const objDescDirective = state.directives[objDescTarget];
        const objDescClass = objDescDirective ? " desc-edited" : "";
        html += `<tr>`;
        html += `<td><strong>${escapeHtml(obj.name)}</strong></td>`;
        const objEditBtn = isImportRun(state.activeRun) ? "" : `<button class="editable-desc-btn" data-edit-target="${escapeHtml(objDescTarget)}" data-edit-current="${escapeHtml(obj.visualDescription)}" title="Edit description">✏️</button>`;
        html += `<td><span class="${objDescClass}">${escapeHtml(obj.visualDescription)}</span>${objEditBtn}</td>`;

        // Look up object image
        const objAsset = findAsset(`object:${obj.name}:front`);
        const objRedoItemDisabled = isRunActivelyExecuting(state.activeRun) ? " disabled" : "";
        let objImageHtml = "";
        if (objAsset && objAsset.previewUrl) {
          const objKey = `object:${obj.name}:front`;
          const objVersions = state.activeRun?.assetVersions?.[objKey];
          const selectedObjVersion = state.activeRun?.selectedAssetVersions?.[objKey] ?? (objVersions?.length ?? 1);
          objImageHtml = `<div class="asset-upload-wrapper">`;
          objImageHtml += `<img src="${escapeHtml(objAsset.previewUrl)}" alt="Object" class="inline-thumbnail" />`;
          objImageHtml += `<button class="asset-upload-btn" data-asset-key="${escapeHtml(objKey)}" title="Upload replacement image">📷</button>`;
          objImageHtml += buildAssetVersionSelector(objKey, objVersions, selectedObjVersion, isRunActivelyExecuting(state.activeRun));
          objImageHtml += `</div>`;
          objImageHtml += `<button class="redo-item-button" data-redo-type="asset" data-redo-asset-key="${escapeHtml(objKey)}"${objRedoItemDisabled} title="Retry image for ${escapeHtml(obj.name)}">↻</button>`;
          objImageHtml += buildDirectiveControls(`asset:${objKey}`, isRunActivelyExecuting(state.activeRun));
        } else if (isStageGenerating("asset_generation")) {
          objImageHtml = `<div class="spinner-placeholder spinner-image"><div class="spinner-circle"></div><div class="spinner-label">Generating…</div></div>`;
        }
        html += `<td>${objImageHtml}</td>`;
        html += `</tr>`;
      }
      html += `</tbody></table>`;
      html += `</div>`;
    }

    // Scenes with shots and inline assets
    if (storyAnalysis.scenes && storyAnalysis.scenes.length > 0) {
      html += `<div class="stage-output-section">`;
      html += `<h4>Scenes</h4>`;
      for (const scene of storyAnalysis.scenes) {
        html += `<div class="scene-block">`;
        html += `<h5>Scene ${scene.sceneNumber}: ${escapeHtml(scene.title)}</h5>`;
        html += `<p class="muted">${escapeHtml(scene.narrativeSummary)}</p>`;
        html += `<p class="muted"><em>Location: ${escapeHtml(scene.location)} • Duration: ${scene.estimatedDurationSeconds}s</em></p>`;

        // Show shots if they exist and are populated
        if (scene.shots && scene.shots.length > 0) {
          html += `<table class="stage-output-table scene-shots-table">`;
          html += `<thead><tr><th>Shot</th><th>Composition</th><th>Duration</th><th>Dialogue</th></tr></thead>`;
          html += `<tbody>`;
          for (const shot of scene.shots) {
            const dialogue = shot.dialogue ? escapeHtml(shot.dialogue) : "<em>—</em>";
            const isGrok = state.activeRun?.options?.videoBackend === "grok";
            html += `<tr>`;
            html += `<td>${shot.shotNumber}</td>`;
            html += `<td>${escapeHtml(shot.composition)}</td>`;
            html += `<td>${shot.durationSeconds}s</td>`;
            html += `<td>${dialogue}</td>`;
            html += `</tr>`;

            // Add collapsible prompts row
            const promptFields = [
              { label: "Start Frame Prompt", value: shot.startFramePrompt, targetKey: `shot:${shot.shotNumber}:start_frame_prompt` },
              ...(!isGrok ? [{ label: "End Frame Prompt", value: shot.endFramePrompt, targetKey: `shot:${shot.shotNumber}:end_frame_prompt` }] : []),
              { label: "Action Prompt", value: shot.actionPrompt, targetKey: `shot:${shot.shotNumber}:action_prompt` },
              { label: "Camera Direction", value: shot.cameraDirection, targetKey: `shot:${shot.shotNumber}:camera_direction` },
              { label: "Sound Effects", value: shot.soundEffects, targetKey: `shot:${shot.shotNumber}:sound_effects` },
            ];
            const shotReferenceAssets = collectShotReferenceAssets(shot);
            const hasAnyPrompt = promptFields.some(f => f.value);
            if (hasAnyPrompt || shotReferenceAssets.length > 0) {
              html += `<tr class="shot-prompts-row"><td colspan="4">`;
              html += `<details class="shot-prompts-details">`;
              html += `<summary class="shot-prompts-summary">Prompts ▸</summary>`;
              html += `<div class="shot-prompts-content">`;
              for (const field of promptFields) {
                const val = field.value ? escapeHtml(field.value) : "—";
                const promptDirective = state.directives[field.targetKey];
                const editedClass = promptDirective ? " shot-prompt-value-edited" : "";
                html += `<div class="shot-prompt-field">`;
                html += `<span class="shot-prompt-label">${field.label}<button class="shot-prompt-edit-btn" data-prompt-target="${escapeHtml(field.targetKey)}" data-prompt-current="${escapeHtml(field.value || "")}" title="Edit ${field.label}">✏️</button></span>`;
                html += `<span class="shot-prompt-value${editedClass}">${val}</span>`;
                html += `</div>`;
              }
              if (shotReferenceAssets.length > 0) {
                html += `<div class="shot-prompt-field">`;
                html += `<span class="shot-prompt-label">References</span>`;
                html += `<div class="shot-references">`;
                for (const reference of shotReferenceAssets) {
                  html += `<div class="shot-ref-item">`;
                  html += `<img src="${escapeHtml(reference.previewUrl)}" alt="${escapeHtml(reference.name)} ${escapeHtml(reference.subtype)} reference" class="inline-thumbnail shot-ref-thumbnail" />`;
                  html += `<span class="shot-ref-label">${escapeHtml(reference.name)} (${escapeHtml(reference.subtype)})</span>`;
                  html += `</div>`;
                }
                html += `</div>`;
                html += `</div>`;
              }
              const promptSent = state.activeRun?.videoPromptsSent?.[shot.shotNumber];
              if (promptSent) {
                html += `<div class="shot-prompt-field">`;
                html += `<span class="shot-prompt-label">Prompt Sent to API</span>`;
                html += `<span class="shot-prompt-value">${escapeHtml(promptSent)}</span>`;
                html += `</div>`;
              }
              html += `</div>`;
              html += `</details>`;
              html += `</td></tr>`;
            }

            // Add shot assets row below the shot
            const startFrameAsset = findAsset(`frame:${shot.shotNumber}:start`);
            const endFrameAsset = findAsset(`frame:${shot.shotNumber}:end`);
            const videoAsset = findAsset(`video:${shot.shotNumber}`);
            const showFrameSpinners = isStageGenerating("frame_generation") || isStageGenerating("shot_generation");
            const showVideoSpinners = isStageGenerating("video_generation") || isStageGenerating("shot_generation");

            const redoItemDisabled = isRunActivelyExecuting(state.activeRun) ? " disabled" : "";

            if (startFrameAsset || endFrameAsset || videoAsset || showFrameSpinners || showVideoSpinners) {
              const isRunning = isRunActivelyExecuting(state.activeRun);
              const startFrameVersions = state.activeRun?.frameVersions?.[shot.shotNumber]?.start;
              const endFrameVersions = state.activeRun?.frameVersions?.[shot.shotNumber]?.end;
              const videoVersions = state.activeRun?.videoVersions?.[shot.shotNumber];
              const selectedStartVersion = state.activeRun?.selectedVersions?.frames?.[shot.shotNumber]?.start ?? (startFrameVersions?.length || 0);
              const selectedEndVersion = state.activeRun?.selectedVersions?.frames?.[shot.shotNumber]?.end ?? (endFrameVersions?.length || 0);
              const selectedVideoVersion = state.activeRun?.selectedVersions?.videos?.[shot.shotNumber] ?? (videoVersions?.length || 0);

              html += `<tr><td colspan="4">`;
              html += `<div class="shot-assets">`;
              if (startFrameAsset && startFrameAsset.previewUrl) {
                html += `<div class="shot-asset-item">`;
                html += `<p class="shot-asset-label">Start Frame</p>`;
                html += `<img src="${escapeHtml(startFrameAsset.previewUrl)}" alt="Start Frame" class="inline-thumbnail" />`;
                html += buildVersionSelector(shot.shotNumber, "frame", "start", startFrameVersions, selectedStartVersion, isRunning);
                html += `<div class="shot-asset-controls">`;
                html += `<button class="redo-item-button" data-redo-type="start_frame" data-redo-shot="${shot.shotNumber}"${redoItemDisabled} title="Retry start frame">↻</button>`;
                html += buildDirectiveControls(`shot:${shot.shotNumber}:start_frame`, isRunning);
                html += `</div>`;
                html += `</div>`;
              } else if (showFrameSpinners) {
                html += `<div class="shot-asset-item">`;
                html += `<p class="shot-asset-label">Start Frame</p>`;
                html += `<div class="spinner-placeholder spinner-image"><div class="spinner-circle"></div><div class="spinner-label">Generating…</div></div>`;
                html += `</div>`;
              }
              if (!isGrok) {
                if (endFrameAsset && endFrameAsset.previewUrl) {
                  html += `<div class="shot-asset-item">`;
                  html += `<p class="shot-asset-label">End Frame</p>`;
                  html += `<img src="${escapeHtml(endFrameAsset.previewUrl)}" alt="End Frame" class="inline-thumbnail" />`;
                  html += buildVersionSelector(shot.shotNumber, "frame", "end", endFrameVersions, selectedEndVersion, isRunning);
                  html += `<div class="shot-asset-controls">`;
                  html += `<button class="redo-item-button" data-redo-type="end_frame" data-redo-shot="${shot.shotNumber}"${redoItemDisabled} title="Retry end frame">↻</button>`;
                  html += buildDirectiveControls(`shot:${shot.shotNumber}:end_frame`, isRunning);
                  html += `</div>`;
                  html += `</div>`;
                } else if (showFrameSpinners) {
                  html += `<div class="shot-asset-item">`;
                  html += `<p class="shot-asset-label">End Frame</p>`;
                  html += `<div class="spinner-placeholder spinner-image"><div class="spinner-circle"></div><div class="spinner-label">Generating…</div></div>`;
                  html += `</div>`;
                }
              }
              if (videoAsset && videoAsset.previewUrl) {
                html += `<div class="shot-asset-item">`;
                html += `<p class="shot-asset-label">Video</p>`;
                html += `<video src="${escapeHtml(videoAsset.previewUrl)}" class="inline-video" controls preload="metadata"></video>`;
                html += buildVersionSelector(shot.shotNumber, "video", null, videoVersions, selectedVideoVersion, isRunning);
                html += `<div class="shot-asset-controls">`;
                html += `<button class="redo-item-button" data-redo-type="video" data-redo-shot="${shot.shotNumber}"${redoItemDisabled} title="Retry video">↻</button>`;
                html += buildDirectiveControls(`shot:${shot.shotNumber}:video`, isRunning);
                html += `</div>`;
                html += `</div>`;
              } else if (showVideoSpinners) {
                const pct = state.videoProgress?.[shot.shotNumber];
                const progressText = pct !== undefined ? `Generating… ${pct}%` : "Generating…";
                html += `<div class="shot-asset-item">`;
                html += `<p class="shot-asset-label">Video</p>`;
                html += `<div class="spinner-placeholder spinner-video"><div class="spinner-circle"></div><div class="spinner-label" data-video-progress-shot="${shot.shotNumber}">${progressText}</div></div>`;
                html += `</div>`;
              }
              html += `</div>`;
              html += `</td></tr>`;
            }
          }
          html += `</tbody></table>`;
        }

        html += `</div>`;
      }
      html += `</div>`;
    }

    // Final video section (if assembly is complete or in progress)
    const finalVideoAsset = findAsset("final.mp4");
    const showFinalVideoSpinner = isStageGenerating("assembly");
    if (finalVideoAsset && finalVideoAsset.previewUrl) {
      html += `<div class="stage-output-section final-video-section">`;
      html += `<h4>Final Video</h4>`;
      html += `<video src="${escapeHtml(finalVideoAsset.previewUrl)}" class="final-video" controls preload="metadata"></video>`;
      html += `<div class="final-video-actions">`;
      html += `<button class="btn btn-secondary reassemble-btn" data-run-id="${escapeHtml(runId)}">↻ Reassemble</button>`;
      html += `</div>`;
      html += `</div>`;
    } else if (showFinalVideoSpinner) {
      html += `<div class="stage-output-section final-video-section">`;
      html += `<h4>Final Video</h4>`;
      html += `<div class="spinner-placeholder spinner-video"><div class="spinner-circle"></div><div class="spinner-label">Generating…</div></div>`;
      html += `</div>`;
    }

    // Only update innerHTML if the HTML has changed
    if (html !== lastStageOutputHtml) {
      elements.stageOutput.innerHTML = html;
      lastStageOutputHtml = html;
    }
    elements.stageOutputSection.style.display = "";
  } catch (error) {
    if (!silent) {
      setGlobalError(`Failed to fetch stage output: ${error.message}`);
    }
    elements.stageOutputSection.style.display = "none";
  }
}

function disconnectEventStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  setConnectionStatus("disconnected");
}

function handleRunEvent(type, messageEvent, source) {
  if (state.eventSource !== source) {
    return;
  }

  try {
    if (type === "connected") {
      const payload = JSON.parse(messageEvent.data);
      appendEvent(
        createEventEntry({
          title: "Event stream connected",
          message: `Run ${payload.runId}`,
          timestamp: payload.timestamp,
        }),
      );
      return;
    }

    const event = JSON.parse(messageEvent.data);
    const payload =
      event && typeof event.payload === "object" && event.payload !== null
        ? event.payload
        : {};
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString();

    switch (type) {
      case "run_status": {
        const status = typeof payload.status === "string" ? payload.status : "unknown";
        const error = typeof payload.error === "string" ? payload.error : "";
        appendEvent(
          createEventEntry({
            title: "Run status",
            message: error ? `${status}: ${error}` : status,
            level: status === "failed" ? "error" : "info",
            timestamp,
          }),
        );
        scheduleRunRefresh();
        void fetchAndRenderStageOutput({ silent: true });
        break;
      }
      case "stage_transition": {
        appendEvent(
          createEventEntry({
            title: "Stage transition",
            message: `${formatStageLabel(String(payload.from ?? "-"))} -> ${formatStageLabel(String(payload.to ?? "-"))}`,
            timestamp,
          }),
        );
        scheduleRunRefresh();
        break;
      }
      case "stage_completed": {
        appendEvent(
          createEventEntry({
            title: "Stage completed",
            message: formatStageLabel(String(payload.stage ?? "-")),
            timestamp,
          }),
        );
        scheduleRunRefresh();
        void fetchAndRenderStageOutput({ silent: true });
        break;
      }
      case "asset_generated": {
        const asset = payload.asset;
        if (asset && typeof asset.id === "string") {
          state.assetsById.set(asset.id, asset);
          renderStoryDocument();
          appendEvent(
            createEventEntry({
              title: "Asset generated",
              message: String(asset.key ?? asset.id),
              timestamp,
            }),
          );
        }
        break;
      }
      case "log": {
        const message = typeof payload.message === "string" ? payload.message : "Log event";
        const level = payload.level === "error" ? "error" : "info";
        appendEvent(
          createEventEntry({
            title: "Log",
            message,
            level,
            timestamp,
          }),
        );
        // Track video generation progress per shot
        const progressMatch = message.match(/\[(video_generation|shot_generation)\] Shot (\d+): (\d+)% complete/);
        if (progressMatch) {
          const shotNum = Number(progressMatch[2]);
          const pct = Number(progressMatch[3]);
          state.videoProgress = state.videoProgress || {};
          state.videoProgress[shotNum] = pct;
          // Update spinner in-place without waiting for re-render
          const label = document.querySelector(`[data-video-progress-shot="${shotNum}"]`);
          if (label) label.textContent = `Generating… ${pct}%`;
        }

        // Track pacing analysis / apply progress
        if (message.startsWith("[pacing]")) {
          const progressEl = document.getElementById("pacing-progress");
          const analyzeBtn = document.getElementById("analyze-pacing-btn");
          const applyBtn = document.getElementById("apply-pacing-btn");

          if (progressEl) {
            // Strip the [pacing] prefix for display
            progressEl.textContent = message.replace(/^\[pacing\]\s*/, "");
            progressEl.style.display = "";
          }

          // Detect completion of analysis or apply
          if (message.includes("All regenerations complete")) {
            const pacingSection = document.getElementById("pacing-section");
            if (pacingSection) pacingSection.style.display = "none";
          }
          if (message.includes("Analysis complete") || message.includes("All regenerations complete")) {
            if (progressEl) {
              // Keep the completion message visible briefly, then hide
              setTimeout(() => { progressEl.style.display = "none"; }, 5000);
            }
            if (analyzeBtn) {
              analyzeBtn.disabled = false;
              analyzeBtn.textContent = "Analyze Pacing";
            }
            if (applyBtn) {
              applyBtn.disabled = false;
              applyBtn.textContent = "Apply Pacing Changes";
            }
            // Refresh run to pick up updated pacingAnalysis / regenerated videos
            scheduleRunRefresh();
          }
        }
        break;
      }
      default:
        break;
    }
  } catch (error) {
    appendEvent(
      createEventEntry({
        title: "Event parse error",
        message: error instanceof Error ? error.message : "Unable to parse event payload",
        level: "error",
      }),
    );
  }
}

function connectEventStream() {
  disconnectEventStream();
  if (!state.activeRunId) {
    return;
  }

  const runId = encodeURIComponent(state.activeRunId);
  const source = new EventSource(`/runs/${runId}/events`);
  state.eventSource = source;
  setConnectionStatus("connecting");

  source.addEventListener("open", () => {
    if (state.eventSource === source) {
      setConnectionStatus("connected");
    }
  });

  source.addEventListener("error", () => {
    if (state.eventSource === source) {
      setConnectionStatus("reconnecting");
    }
  });

  for (const eventType of [
    "connected",
    "run_status",
    "stage_transition",
    "stage_completed",
    "asset_generated",
    "log",
  ]) {
    source.addEventListener(eventType, (event) => {
      handleRunEvent(eventType, event, source);
    });
  }
}

async function loadRuns() {
  try {
    const response = await requestJson("/runs");
    state.runs = Array.isArray(response.runs) ? response.runs : [];
    renderRunSelect();
    setGlobalError("");
  } catch (error) {
    setGlobalError(`Failed to load runs: ${error.message}`);
    return;
  }

  const hasActive = state.activeRunId && state.runs.some((run) => run.id === state.activeRunId);
  if (hasActive) {
    return;
  }

  if (state.runs.length === 0) {
    state.activeRunId = null;
    state.activeRun = null;
    state.assetsById = new Map();
    state.events = [];
    disconnectEventStream();
    renderEvents();
    renderStoryDocument();
    renderRunDetails();
    localStorage.removeItem("storytovideo_activeRunId");
    showCreateView();
    return;
  }

  showRunView();

  // Try to restore saved run from localStorage
  const savedRunId = localStorage.getItem("storytovideo_activeRunId");
  if (savedRunId && state.runs.some((run) => run.id === savedRunId)) {
    await setActiveRun(savedRunId);
    return;
  }

  // If saved run doesn't exist, clean up stale localStorage entry
  if (savedRunId) {
    localStorage.removeItem("storytovideo_activeRunId");
  }

  // Fall back to most recent run
  await setActiveRun(state.runs[0].id);
}

async function setActiveRun(runId) {
  if (!runId) {
    state.activeRunId = null;
    localStorage.removeItem("storytovideo_activeRunId");
    return;
  }

  const changed = runId !== state.activeRunId;
  state.activeRunId = runId;
  elements.runSelect.value = runId;
  localStorage.setItem("storytovideo_activeRunId", runId);

  if (changed) {
    state.assetsById = new Map();
    state.events = [];
    state.directives = {};
    lastStageOutputHtml = null; // Clear cached HTML when switching runs
    renderStoryDocument();
    renderEvents();
  }

  await Promise.all([refreshRun(), refreshAssets(), fetchDirectives()]);
  connectEventStream();
}

async function handleCreateRunSubmit(event) {
  event.preventDefault();
  const storyText = elements.storyText.value.trim();
  if (!storyText) {
    setGlobalError("Story text is required.");
    return;
  }

  const videoBackend = document.getElementById("video-backend").value;
  const aspectRatio = document.getElementById("aspect-ratio").value;

  elements.createRunButton.disabled = true;
  try {
    const run = await requestJson("/runs", {
      method: "POST",
      body: JSON.stringify({
        storyText,
        options: {
          reviewMode: false,
          videoBackend,
          aspectRatio,
        },
      }),
    });
    elements.storyText.value = "";
    await loadRuns();
    await setActiveRun(run.id);
    appendEvent(
      createEventEntry({
        title: "Run created",
        message: run.id,
      }),
    );
    setGlobalError("");
    showRunView();
  } catch (error) {
    setGlobalError(`Failed to create run: ${error.message}`);
  } finally {
    elements.createRunButton.disabled = false;
  }
}

async function handleImportVideoSubmit(event) {
  event.preventDefault();
  const url = elements.importVideoUrl.value.trim();
  const file = elements.importVideoFile.files[0];

  if (!url && !file) {
    setGlobalError("Provide a video URL or select a file to import.");
    return;
  }

  elements.importVideoButton.disabled = true;
  try {
    let run;
    if (url) {
      run = await requestJson("/runs/import", {
        method: "POST",
        body: JSON.stringify({ videoSource: url }),
      });
    } else {
      const formData = new FormData();
      formData.append("file", file);
      // Use fetch directly for FormData (no Content-Type header — browser sets boundary)
      const response = await fetch("/runs/import/upload", {
        method: "POST",
        body: formData,
      });
      const raw = await response.text();
      if (!response.ok) {
        let msg = `${response.status} ${response.statusText}`;
        try { const parsed = JSON.parse(raw); if (parsed.error) msg = parsed.error; } catch {}
        throw new Error(msg);
      }
      run = raw.trim().length > 0 ? JSON.parse(raw) : {};
    }

    elements.importVideoUrl.value = "";
    elements.importVideoFile.value = "";
    await loadRuns();
    await setActiveRun(run.id);
    appendEvent(
      createEventEntry({
        title: "Video imported",
        message: run.id,
      }),
    );
    setGlobalError("");
    showRunView();
  } catch (error) {
    setGlobalError(`Failed to import video: ${error.message}`);
  } finally {
    elements.importVideoButton.disabled = false;
  }
}


async function handleSubmitInstruction(event) {
  event.preventDefault();
  if (!state.activeRunId) {
    setGlobalError("No active run selected.");
    return;
  }
  if (!state.activeRun) {
    setGlobalError("Run state is unavailable. Refresh and try again.");
    return;
  }
  if (isRunActivelyExecuting(state.activeRun)) {
    setGlobalError(
      "Review controls are locked while run is executing. Stop the run first.",
    );
    renderRunDetails();
    return;
  }

  const canAddInstructions = isRunReviewSafe(state.activeRun)
    || state.activeRun.status === "stopped"
    || state.activeRun.status === "failed";
  if (!canAddInstructions) {
    setGlobalError("Run is not in a state that accepts instructions.");
    renderRunDetails();
    return;
  }

  const instruction = elements.instructionText.value.trim();
  if (!instruction) {
    setGlobalError("Instruction is required.");
    return;
  }

  const payload = { instruction };
  const stage = elements.instructionStage.value;
  if (stage) {
    payload.stage = stage;
  }

  elements.submitInstructionButton.disabled = true;
  try {
    const response = await requestJson(
      `/runs/${encodeURIComponent(state.activeRunId)}/instructions`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    elements.instructionText.value = "";
    appendEvent(
      createEventEntry({
        title: "Instruction submitted",
        message: `${response.stage} (${response.instructionCount})`,
        timestamp: response.submittedAt,
      }),
    );
    setGlobalError("");
  } catch (error) {
    setGlobalError(`Failed to submit instruction: ${error.message}`);
  } finally {
    renderRunDetails();
  }
}

async function handleContinueClick() {
  if (!state.activeRunId) {
    setGlobalError("No active run selected.");
    return;
  }
  if (!state.activeRun) {
    setGlobalError("Run state is unavailable. Refresh and try again.");
    return;
  }
  if (isRunActivelyExecuting(state.activeRun)) {
    setGlobalError(
      'Review controls are locked while run is executing. Interrupt and wait for status "awaiting review".',
    );
    renderRunDetails();
    return;
  }
  if (!isRunReviewSafe(state.activeRun)) {
    setGlobalError('Run is not in review-safe state. Controls unlock when status is "awaiting_review".');
    renderRunDetails();
    return;
  }

  elements.continueButton.disabled = true;
  try {
    const response = await requestJson(
      `/runs/${encodeURIComponent(state.activeRunId)}/continue`,
      {
        method: "POST",
        body: "{}",
      },
    );
    const decision =
      response &&
      typeof response === "object" &&
      response.decision &&
      typeof response.decision === "object"
        ? response.decision
        : null;

    if (decision && typeof decision.stage === "string") {
      appendEvent(
        createEventEntry({
          title: "Continue requested",
          message: `${decision.stage} (${decision.instructionCount ?? 0})`,
          timestamp: typeof decision.decidedAt === "string" ? decision.decidedAt : undefined,
        }),
      );
    } else {
      const message =
        response && typeof response.message === "string"
          ? response.message
          : "Continue request accepted";
      appendEvent(
        createEventEntry({
          title: "Continue status",
          message,
        }),
      );
    }
    await refreshRun();
    setGlobalError("");
  } catch (error) {
    setGlobalError(`Failed to continue run: ${error.message}`);
  } finally {
    renderRunDetails();
  }
}

async function handleRetryClick() {
  if (!state.activeRunId) {
    setGlobalError("No active run selected.");
    return;
  }
  if (!state.activeRun || (state.activeRun.status !== "failed" && state.activeRun.status !== "stopped")) {
    setGlobalError("Only failed or stopped runs can be resumed.");
    return;
  }

  elements.retryButton.disabled = true;
  try {
    await requestJson(`/runs/${encodeURIComponent(state.activeRunId)}/retry`, {
      method: "POST",
      body: "{}",
    });
    appendEvent(
      createEventEntry({
        title: "Run retry",
        message: "Retrying from last checkpoint",
      }),
    );
    setGlobalError("");
  } catch (error) {
    setGlobalError(`Failed to retry run: ${error.message}`);
  } finally {
    renderRunDetails();
  }
}

async function handleRedoClick(stage) {
  if (!state.activeRunId) {
    setGlobalError("No active run selected.");
    return;
  }
  if (!state.activeRun) {
    setGlobalError("No active run data available.");
    return;
  }

  try {
    await requestJson(`/runs/${encodeURIComponent(state.activeRunId)}/redo?stage=${stage}`, {
      method: "POST",
      body: "{}",
    });
    appendEvent(
      createEventEntry({
        title: "Redo stage",
        message: `Redoing from stage: ${formatStageLabel(stage)}`,
      }),
    );
    setGlobalError("");
  } catch (error) {
    setGlobalError(`Failed to redo stage: ${error.message}`);
  } finally {
    renderRunDetails();
  }
}

async function handleRedoItem(type, shotNumber, assetKey) {
  if (!state.activeRunId) {
    setGlobalError("No active run selected.");
    return;
  }
  if (!state.activeRun) {
    setGlobalError("No active run data available.");
    return;
  }

  try {
    const body = type === "asset" ? { type, assetKey } : { type, shotNumber };
    await requestJson(`/runs/${encodeURIComponent(state.activeRunId)}/redo-item`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const labelMap = { start_frame: "start frame", end_frame: "end frame", video: "video", asset: "asset" };
    const label = labelMap[type] || type;
    const message =
      type === "asset"
        ? `Retrying asset: ${assetKey}`
        : `Retrying ${label} for shot ${shotNumber}`;
    appendEvent(
      createEventEntry({
        title: `Redo ${label}`,
        message,
      }),
    );
    setGlobalError("");
  } catch (error) {
    setGlobalError(`Failed to redo item: ${error.message}`);
  } finally {
    renderRunDetails();
  }
}

async function fetchDirectives() {
  if (!state.activeRunId) return;
  try {
    const response = await requestJson(`/runs/${encodeURIComponent(state.activeRunId)}/directives`);
    state.directives = response.directives || {};
  } catch {
    state.directives = {};
  }
}

async function handleSetDirective(target, directive) {
  if (!state.activeRunId) {
    setGlobalError("No active run selected.");
    return;
  }
  try {
    await requestJson(`/runs/${encodeURIComponent(state.activeRunId)}/directive`, {
      method: "POST",
      body: JSON.stringify({ target, directive }),
    });
    appendEvent(
      createEventEntry({
        title: "Directive set",
        message: `${target}: ${directive}`,
      }),
    );
    setGlobalError("");
    await fetchDirectives();
    await refreshRun();
  } catch (error) {
    setGlobalError(`Failed to set directive: ${error.message}`);
  }
}

async function handleClearDirective(target) {
  if (!state.activeRunId) {
    setGlobalError("No active run selected.");
    return;
  }
  try {
    await requestJson(`/runs/${encodeURIComponent(state.activeRunId)}/directive`, {
      method: "DELETE",
      body: JSON.stringify({ target }),
    });
    appendEvent(
      createEventEntry({
        title: "Directive cleared",
        message: target,
      }),
    );
    setGlobalError("");
    await fetchDirectives();
    lastStageOutputHtml = null;
    void fetchAndRenderStageOutput({ silent: true });
  } catch (error) {
    setGlobalError(`Failed to clear directive: ${error.message}`);
  }
}

function buildDirectiveControls(target, disabled) {
  const existing = state.directives[target];
  let html = "";
  const disabledAttr = disabled ? " disabled" : "";

  // Directive button (✏️)
  html += `<button class="directive-button" data-directive-target="${escapeHtml(target)}"${disabledAttr} title="Add directive for ${escapeHtml(target)}">✏️</button>`;

  // Badge if directive exists
  if (existing) {
    html += `<span class="directive-badge" data-directive-target="${escapeHtml(target)}" title="${escapeHtml(existing.directive)}">📝</span>`;
  }

  return html;
}

function buildVersionSelector(shotNumber, type, subtype, versions, selectedVersion, isRunning) {
  if (!versions || versions.length <= 1) return "";
  const disabled = isRunning ? " disabled" : "";
  return `
    <div class="version-selector">
      <button class="version-nav version-prev" data-shot="${shotNumber}" data-type="${type}" data-subtype="${subtype || ''}" data-direction="prev"${disabled}>◀</button>
      <span class="version-label">v${selectedVersion}/${versions.length}</span>
      <button class="version-nav version-next" data-shot="${shotNumber}" data-type="${type}" data-subtype="${subtype || ''}" data-direction="next"${disabled}>▶</button>
    </div>
  `;
}

function buildAssetVersionSelector(assetKey, versions, selectedVersion, isRunning) {
  if (!versions || versions.length <= 1) return "";
  const disabled = isRunning ? " disabled" : "";
  return `
    <div class="version-selector">
      <button class="asset-version-nav version-prev" data-asset-key="${escapeHtml(assetKey)}" data-direction="prev"${disabled}>◀</button>
      <span class="version-label">v${selectedVersion}/${versions.length}</span>
      <button class="asset-version-nav version-next" data-asset-key="${escapeHtml(assetKey)}" data-direction="next"${disabled}>▶</button>
    </div>
  `;
}

function handleStopClick() {
  if (!state.activeRunId) {
    setGlobalError("No active run selected.");
    return;
  }

  // Optimistically update UI immediately
  if (state.activeRun) {
    state.activeRun.status = "stopped";
  }
  appendEvent(
    createEventEntry({
      title: "Stop pipeline",
      message: "Pipeline stop requested",
    }),
  );
  setGlobalError("");
  renderRunDetails();
  renderStageProgress();

  // Fire the stop request without blocking the UI
  requestJson(`/runs/${encodeURIComponent(state.activeRunId)}/stop`, {
    method: "POST",
    body: "{}",
  }).catch(() => {
    // Fetch failed — refresh to get the real state from the backend
    void refreshRun();
  });
}


function startPollingFallback() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }
  state.pollTimer = window.setInterval(() => {
    if (!state.activeRunId) {
      return;
    }
    void refreshRun({ silent: true });
    void refreshAssets({ silent: true });
  }, POLL_INTERVAL_MS);
}

function bindEvents() {
  elements.newRunButton.addEventListener("click", () => {
    showCreateView();
  });

  elements.createRunForm.addEventListener("submit", (event) => {
    void handleCreateRunSubmit(event);
  });

  elements.importVideoForm.addEventListener("submit", (event) => {
    void handleImportVideoSubmit(event);
  });

  // Update default aspect ratio when video backend changes in the create form
  document.getElementById("video-backend").addEventListener("change", (e) => {
    const ar = document.getElementById("aspect-ratio");
    if (e.target.value === "comfy") {
      ar.value = "1:1";
    } else {
      ar.value = "16:9";
    }
  });

  // Tab switching between New Story and Import Video
  elements.tabNewStory.addEventListener("click", () => {
    elements.tabNewStory.classList.add("create-tab-active");
    elements.tabImportVideo.classList.remove("create-tab-active");
    elements.panelNewStory.style.display = "";
    elements.panelImportVideo.style.display = "none";
  });

  elements.tabImportVideo.addEventListener("click", () => {
    elements.tabImportVideo.classList.add("create-tab-active");
    elements.tabNewStory.classList.remove("create-tab-active");
    elements.panelImportVideo.style.display = "";
    elements.panelNewStory.style.display = "none";
  });

  elements.runSelect.addEventListener("change", (event) => {
    const target = event.target;
    const runId = target.value;
    if (!runId) {
      return;
    }
    void setActiveRun(runId);
  });

  elements.refreshRunsButton.addEventListener("click", () => {
    void loadRuns();
  });

  elements.instructionForm.addEventListener("submit", (event) => {
    void handleSubmitInstruction(event);
  });

  elements.continueButton.addEventListener("click", () => {
    void handleContinueClick();
  });

  elements.retryButton.addEventListener("click", () => {
    void handleRetryClick();
  });

  elements.deleteRunButton.addEventListener("click", async () => {
    if (!state.activeRunId) return;
    const run = state.runs.find(r => r.id === state.activeRunId);
    const label = run?.name || state.activeRunId.slice(0, 8);
    if (!confirm(`Delete run "${label}"? This removes it from the list but does not delete output files.`)) return;
    try {
      await requestJson(`/runs/${encodeURIComponent(state.activeRunId)}`, {
        method: "DELETE",
      });
      state.runs = state.runs.filter(r => r.id !== state.activeRunId);
      state.activeRunId = null;
      state.activeRun = null;
      renderRunSelect();
      renderRunDetails();
      appendEvent(createEventEntry({ title: "Run deleted", message: `Deleted run ${label}` }));
    } catch (error) {
      setGlobalError(`Failed to delete run: ${error.message}`);
    }
  });

  elements.reviewModeCheckbox.addEventListener("change", async () => {
    if (!state.activeRunId) return;
    try {
      await requestJson(`/runs/${encodeURIComponent(state.activeRunId)}/review-mode`, {
        method: "POST",
        body: JSON.stringify({ reviewMode: elements.reviewModeCheckbox.checked }),
      });
    } catch (error) {
      setGlobalError(`Failed to update review mode: ${error.message}`);
      // Revert checkbox on failure
      elements.reviewModeCheckbox.checked = !elements.reviewModeCheckbox.checked;
    }
  });

  elements.runVideoBackend.addEventListener("change", async () => {
    if (!state.activeRunId) return;
    const previous = state.activeRun?.options?.videoBackend || "veo";
    try {
      await requestJson(`/runs/${encodeURIComponent(state.activeRunId)}/video-backend`, {
        method: "POST",
        body: JSON.stringify({ videoBackend: elements.runVideoBackend.value }),
      });
      // Update local state and re-render stages for the new backend
      if (state.activeRun?.options) {
        state.activeRun.options.videoBackend = elements.runVideoBackend.value;
      }
      populateInstructionStageSelect();
      renderStageProgress();
    } catch (error) {
      setGlobalError(`Failed to update video backend: ${error.message}`);
      elements.runVideoBackend.value = previous;
    }
  });

  window.addEventListener("beforeunload", () => {
    disconnectEventStream();
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
    }
  });

  // Lightbox: delegated click on thumbnails
  document.body.addEventListener("click", (event) => {
    const thumbnail = event.target.closest(".inline-thumbnail");
    if (thumbnail && thumbnail.src) {
      openLightbox(thumbnail.src);
    }
  });

  // Lightbox: close on × button
  elements.lightboxClose.addEventListener("click", (event) => {
    event.stopPropagation();
    closeLightbox();
  });

  // Lightbox: close on backdrop click (but not on the image itself)
  elements.lightboxOverlay.addEventListener("click", (event) => {
    if (event.target === elements.lightboxOverlay) {
      closeLightbox();
    }
  });

  // Lightbox: close on Escape key
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.lightboxOverlay.classList.contains("lightbox-visible")) {
      closeLightbox();
    }
  });

  // Per-item redo: delegated click on retry buttons
  document.body.addEventListener("click", (event) => {
    const btn = event.target.closest(".redo-item-button");
    if (btn && !btn.disabled) {
      const type = btn.dataset.redoType;
      if (type === "asset") {
        const assetKey = btn.dataset.redoAssetKey;
        if (assetKey) {
          handleRedoItem(type, undefined, assetKey);
        }
      } else {
        const shotNumber = Number(btn.dataset.redoShot);
        if (type && !Number.isNaN(shotNumber)) {
          handleRedoItem(type, shotNumber);
        }
      }
    }
  });

  // Reassemble: delegated click on reassemble button
  document.body.addEventListener("click", async (event) => {
    const btn = event.target.closest(".reassemble-btn");
    if (!btn) return;

    const runId = btn.dataset.runId;
    btn.disabled = true;
    btn.textContent = "Reassembling...";

    try {
      const resp = await fetch(`/runs/${runId}/reassemble`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) {
        alert(data.error || "Failed to start reassembly");
      }
      // The UI will auto-update via polling when assembly completes
    } catch (err) {
      alert("Failed to start reassembly: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "↻ Reassemble";
    }
  });

  // Asset upload: delegated click on upload buttons
  document.body.addEventListener("click", (event) => {
    const btn = event.target.closest(".asset-upload-btn");
    if (!btn) return;
    const assetKey = btn.dataset.assetKey;
    if (!assetKey) return;

    // Create and trigger a file input
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const base64 = await readFileAsBase64(file);
        await requestJson(`/runs/${encodeURIComponent(state.activeRunId)}/upload-asset`, {
          method: "POST",
          body: JSON.stringify({ key: assetKey, imageData: base64 }),
        });
        // Show notification
        showAssetUploadNotification(assetKey);
        // Refresh assets and re-render
        lastStageOutputHtml = null;
        await refreshAssets({ silent: true });
        await fetchAndRenderStageOutput({ silent: true });
      } catch (error) {
        setGlobalError(`Failed to upload asset: ${error.message}`);
      } finally {
        fileInput.remove();
      }
    });
    document.body.appendChild(fileInput);
    fileInput.click();
  });


  // Version navigation: ◀ ▶ buttons (video/frame)
  document.body.addEventListener("click", async (event) => {
    const btn = event.target.closest(".version-nav");
    if (!btn || btn.disabled || btn.classList.contains("asset-version-nav")) return;

    const { shot, type, subtype, direction } = btn.dataset;
    const shotNum = parseInt(shot);
    const runId = state.activeRunId;
    if (!runId) return;

    const versions = type === "video"
      ? state.activeRun?.videoVersions?.[shotNum]
      : state.activeRun?.frameVersions?.[shotNum]?.[subtype];
    if (!versions) return;

    const currentVersion = type === "video"
      ? (state.activeRun?.selectedVersions?.videos?.[shotNum] ?? versions.length)
      : (state.activeRun?.selectedVersions?.frames?.[shotNum]?.[subtype] ?? versions.length);

    let newVersion = currentVersion;
    if (direction === "prev" && currentVersion > 1) newVersion--;
    if (direction === "next" && currentVersion < versions.length) newVersion++;
    if (newVersion === currentVersion) return;

    try {
      await requestJson(`/runs/${encodeURIComponent(runId)}/select-version`, {
        method: "POST",
        body: JSON.stringify({ shotNumber: shotNum, type, subtype: subtype || undefined, version: newVersion }),
      });
      // Update local state and re-render
      lastStageOutputHtml = null;
      scheduleRunRefresh();
    } catch (error) {
      setGlobalError(`Failed to select version: ${error.message}`);
    }
  });

  // Asset version navigation: ◀ ▶ buttons
  document.body.addEventListener("click", async (event) => {
    const btn = event.target.closest(".asset-version-nav");
    if (!btn || btn.disabled) return;

    const { assetKey, direction } = btn.dataset;
    const runId = state.activeRunId;
    if (!runId || !assetKey) return;

    const versions = state.activeRun?.assetVersions?.[assetKey];
    if (!versions) return;

    const currentVersion = state.activeRun?.selectedAssetVersions?.[assetKey] ?? versions.length;

    let newVersion = currentVersion;
    if (direction === "prev" && currentVersion > 1) newVersion--;
    if (direction === "next" && currentVersion < versions.length) newVersion++;
    if (newVersion === currentVersion) return;

    try {
      await requestJson(`/runs/${encodeURIComponent(runId)}/select-version`, {
        method: "POST",
        body: JSON.stringify({ type: "asset", key: assetKey, version: newVersion }),
      });
      lastStageOutputHtml = null;
      scheduleRunRefresh();
    } catch (error) {
      setGlobalError(`Failed to select asset version: ${error.message}`);
    }
  });

  // Directive button: open inline input
  document.body.addEventListener("click", (event) => {
    const btn = event.target.closest(".directive-button");
    if (!btn || btn.disabled) return;
    const target = btn.dataset.directiveTarget;
    if (!target) return;

    // Check if input already exists next to this button
    const parent = btn.parentElement;
    if (parent.querySelector(".directive-inline")) return;

    const existing = state.directives[target];
    const wrapper = document.createElement("div");
    wrapper.className = "directive-inline";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "e.g. darker lighting, more ominous";
    if (existing) input.value = existing.directive;

    const applyBtn = document.createElement("button");
    applyBtn.className = "directive-apply";
    applyBtn.textContent = "Apply";
    applyBtn.type = "button";

    wrapper.append(input);
    wrapper.append(applyBtn);

    if (existing) {
      const clearBtn = document.createElement("button");
      clearBtn.className = "directive-clear";
      clearBtn.textContent = "×";
      clearBtn.type = "button";
      clearBtn.title = "Clear directive";
      clearBtn.addEventListener("click", () => {
        wrapper.remove();
        void handleClearDirective(target);
      });
      wrapper.append(clearBtn);
    }

    const submitDirective = () => {
      const val = input.value.trim();
      if (!val) return;
      wrapper.remove();
      void handleSetDirective(target, val);
    };

    applyBtn.addEventListener("click", submitDirective);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitDirective();
      }
      if (e.key === "Escape") {
        wrapper.remove();
      }
    });

    parent.append(wrapper);
    input.focus();
  });

  // Directive badge: click to edit existing directive
  document.body.addEventListener("click", (event) => {
    const badge = event.target.closest(".directive-badge");
    if (!badge) return;
    const target = badge.dataset.directiveTarget;
    if (!target) return;
    // Trigger the directive button click to open the input
    const parent = badge.parentElement;
    const directiveBtn = parent.querySelector(`.directive-button[data-directive-target="${target}"]`);
    if (directiveBtn) directiveBtn.click();
  });

  // Shot prompt edit button: make prompt editable
  document.body.addEventListener("click", (event) => {
    const btn = event.target.closest(".shot-prompt-edit-btn");
    if (!btn) return;
    const target = btn.dataset.promptTarget;
    const current = btn.dataset.promptCurrent || "";
    const field = btn.closest(".shot-prompt-field");
    if (!field) return;

    const valueSpan = field.querySelector(".shot-prompt-value");
    if (!valueSpan || valueSpan.querySelector("textarea")) return;

    const textarea = document.createElement("textarea");
    textarea.className = "shot-prompt-textarea";
    textarea.value = current;
    valueSpan.textContent = "";
    valueSpan.append(textarea);
    textarea.focus();

    const save = () => {
      const val = textarea.value.trim();
      if (val && val !== current) {
        void handleSetDirective(target, val);
      } else {
        lastStageOutputHtml = null;
        void fetchAndRenderStageOutput({ silent: true });
      }
    };

    textarea.addEventListener("blur", save);
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        textarea.removeEventListener("blur", save);
        save();
      }
      if (e.key === "Escape") {
        textarea.removeEventListener("blur", save);
        lastStageOutputHtml = null;
        void fetchAndRenderStageOutput({ silent: true });
      }
    });
  });

  // Editable description button: click to edit character/location descriptions
  document.body.addEventListener("click", (event) => {
    const btn = event.target.closest(".editable-desc-btn");
    if (!btn) return;
    const target = btn.dataset.editTarget;
    const current = btn.dataset.editCurrent || "";
    const td = btn.closest("td");
    if (!td) return;

    // Check if already editing
    if (td.querySelector(".directive-inline")) return;

    const wrapper = document.createElement("div");
    wrapper.className = "directive-inline";

    const input = document.createElement("input");
    input.type = "text";
    input.value = current;
    input.placeholder = "New description...";

    const applyBtn = document.createElement("button");
    applyBtn.className = "directive-apply";
    applyBtn.textContent = "Apply";
    applyBtn.type = "button";

    wrapper.append(input);
    wrapper.append(applyBtn);

    const existing = state.directives[target];
    if (existing) {
      const clearBtn = document.createElement("button");
      clearBtn.className = "directive-clear";
      clearBtn.textContent = "×";
      clearBtn.type = "button";
      clearBtn.title = "Clear directive";
      clearBtn.addEventListener("click", () => {
        wrapper.remove();
        void handleClearDirective(target);
      });
      wrapper.append(clearBtn);
    }

    const submitDesc = () => {
      const val = input.value.trim();
      if (!val || val === current) {
        wrapper.remove();
        return;
      }
      wrapper.remove();
      void handleSetDirective(target, val);
    };

    applyBtn.addEventListener("click", submitDesc);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitDesc();
      }
      if (e.key === "Escape") {
        wrapper.remove();
      }
    });

    td.append(wrapper);
    input.focus();
  });
}

// ---------------------------------------------------------------------------
// Pacing Analysis UI
// ---------------------------------------------------------------------------

function showPacingResults(results) {
  const section = document.getElementById("pacing-section");
  const container = document.getElementById("pacing-results");
  const applyBtn = document.getElementById("apply-pacing-btn");
  if (!section || !container) return;

  if (!results || results.length === 0) {
    container.innerHTML = "<p class='muted'>No pacing data available.</p>";
    section.style.display = "";
    if (applyBtn) applyBtn.style.display = "none";
    return;
  }

  let html = `<table class="pacing-table">
    <thead><tr>
      <th>Shot</th><th>Current</th><th>Recommended</th><th>Savings</th><th>Confidence</th><th>Reason</th>
    </tr></thead><tbody>`;

  let hasActionable = false;
  for (const r of results) {
    const savings = (r.currentDuration - r.recommendedDuration).toFixed(1);
    const actionable = parseFloat(savings) >= 1 && r.confidence !== "low";
    if (actionable) hasActionable = true;
    const rowClass = actionable ? "pacing-row-actionable" : "";
    html += `<tr class="${rowClass}">
      <td>${r.shotNumber}</td>
      <td>${r.currentDuration}s</td>
      <td>${r.recommendedDuration}s</td>
      <td>${savings}s</td>
      <td><span class="pacing-confidence pacing-confidence-${r.confidence}">${r.confidence}</span></td>
      <td>${escapeHtml(r.reason || "")}</td>
    </tr>`;
  }
  html += "</tbody></table>";

  container.innerHTML = html;
  section.style.display = "";

  if (applyBtn) {
    applyBtn.style.display = hasActionable ? "" : "none";
  }
}

async function handleAnalyzePacingClick() {
  if (!state.activeRunId) return;
  const btn = document.getElementById("analyze-pacing-btn");
  const progressEl = document.getElementById("pacing-progress");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Analyzing…";
  }
  if (progressEl) {
    progressEl.textContent = "Starting analysis...";
    progressEl.style.display = "";
  }

  try {
    await requestJson(`/runs/${encodeURIComponent(state.activeRunId)}/analyze-pacing`, {
      method: "POST",
      body: "{}",
    });
    // Server returns immediately; results arrive via SSE events.
    // The run_status event at the end triggers a refresh which picks up pacingAnalysis.
    appendEvent(createEventEntry({ title: "Pacing analysis", message: "Analysis started in background" }));
  } catch (error) {
    setGlobalError(`Pacing analysis failed: ${error.message}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Analyze Pacing";
    }
    if (progressEl) {
      progressEl.style.display = "none";
    }
  }
  // Button stays disabled until analysis completes (detected via SSE log events)
}

async function handleApplyPacingClick() {
  if (!state.activeRunId) return;
  const btn = document.getElementById("apply-pacing-btn");
  const progressEl = document.getElementById("pacing-progress");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Applying…";
  }
  if (progressEl) {
    progressEl.textContent = "Starting regeneration...";
    progressEl.style.display = "";
  }

  try {
    const data = await requestJson(`/runs/${encodeURIComponent(state.activeRunId)}/apply-pacing`, {
      method: "POST",
      body: "{}",
    });
    appendEvent(createEventEntry({
      title: "Apply pacing",
      message: data.message || "Regeneration started in background",
    }));
    setGlobalError("");
  } catch (error) {
    setGlobalError(`Apply pacing failed: ${error.message}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Apply Pacing Changes";
    }
    if (progressEl) {
      progressEl.style.display = "none";
    }
  }
  // Button stays disabled until regeneration completes (detected via SSE log events)
}

function initialize() {
  populateInstructionStageSelect();
  renderStageProgress();
  renderEvents();
  renderStoryDocument();
  renderRunDetails();
  bindEvents();
  startPollingFallback();
  void loadRuns();

  // Pacing button handlers
  const analyzePacingBtn = document.getElementById("analyze-pacing-btn");
  if (analyzePacingBtn) {
    analyzePacingBtn.addEventListener("click", () => void handleAnalyzePacingClick());
  }
  const applyPacingBtn = document.getElementById("apply-pacing-btn");
  if (applyPacingBtn) {
    applyPacingBtn.addEventListener("click", () => void handleApplyPacingClick());
  }
}

initialize();
