"use strict";

/* Config */
const API = "https://api.modrinth.com";
const UA = `${navigator.userAgent} @github/rvnka/modrinth-collection-downloader`;
const REPO_URL = "https://github.com/rvnka/modrinth-collection-downloader";
const MAX_RETRIES = 3;
const RESOLVE_CONCURRENCY = 6;
const DOWNLOAD_CONCURRENCY = 3;
const DOWNLOAD_DELAY_MS = 300;
const FETCH_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const STORAGE_KEY = "modrinth-downloader-prefs";

const LOADER_AGNOSTIC_TYPES = new Set(["resourcepack", "shader", "datapack"]);
const EXCLUDED_PROJECT_TYPES = new Set(["minecraft_java_server"]);
const PROJECT_FOLDERS = {
  mod: "mods",
  plugin: "plugins",
  resourcepack: "resourcepacks",
  shader: "shaderpacks",
  datapack: "datapacks",
  modpack: "modpacks",
};
const ZIP_CDNS = [
  "https://cdn.hopjs.net/npm/jszip@3.10.1/dist/jszip.min.js",
  "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
];

/* DOM & state */
const els = {};
document.querySelectorAll("[id]").forEach((el) => (els[el.id] = el));

const state = {
  jobs: [],
  tags: {
    versions: [],
    loaders: [],
    projectTypes: []
  },
  resolving: false,
  aborted: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n, l = 2) => String(n).padStart(l, "0");
const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val >= 100 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function parseCollectionInput(raw) {
  const match = raw.trim().match(/modrinth\.com\/collection\/([^/?#]+)/i);
  return match ? match[1] : raw.trim();
}

function splitExt(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

function uniquePath(dir, filename, used) {
  const [stem, ext] = splitExt(filename);
  const base = dir ? `${dir}/${filename}` : filename;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 1;
  let candidate;
  do {
    candidate = dir ? `${dir}/${stem} (${n})${ext}` : `${stem} (${n})${ext}`;
    n++;
  } while (used.has(candidate));
  used.add(candidate);
  return candidate;
}

/* Preferences (local only, never uploaded) */
function savePrefs() {
  try {
    const prefs = {
      loader: els.loader.value,
      mcVersion: els.mcVersion.value,
      channels: [...document.querySelectorAll(".channel-chk:checked")].map((c) => c.value),
      depAuto: els.depAuto.checked,
      depReq: els.depReq.checked,
      depOpt: els.depOpt.checked,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (_) {
    /* storage may be unavailable; not critical */
  }
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch (_) {
    return {};
  }
}

/* Activity log */
const MAX_LOG_ENTRIES = 500;
const Logger = (() => {
  const entries = [];
  const listeners = [];
  let seq = 0;

  function record(level, category, message) {
    const entry = {
      id: ++seq,
      level,
      category,
      message,
      time: new Date()
    };
    entries.push(entry);
    if (entries.length > MAX_LOG_ENTRIES) entries.shift();
    listeners.forEach((fn) => fn(entry));
  }
  return {
    info: (c, m) => record("info", c, m),
    network: (c, m) => record("network", c, m),
    warn: (c, m) => record("warn", c, m),
    error: (c, m) => record("error", c, m),
    getAll: () => entries,
    clear: () => (entries.length = 0),
    subscribe: (fn) => listeners.push(fn),
  };
})();

const LogPanel = (() => {
  let emptyEl = els.logEmpty;

  function onNewEntry(entry) {
    if (emptyEl) {
      emptyEl.remove();
      emptyEl = null;
    }
    const row = document.createElement("li");
    row.className = "log-entry";
    row.innerHTML = `
      <time class="log-time">${fmtTime(entry.time)}</time>
      <span class="log-lvl lvl-${entry.level}">${entry.level.toUpperCase()}</span>
      <code class="log-cat">[${entry.category}]</code>
      <span class="log-msg"></span>`;
    row.querySelector(".log-msg").textContent = entry.message;
    els.logBody.appendChild(row);
    els.logCount.textContent = String(Logger.getAll().length);
    els.logBody.scrollTop = els.logBody.scrollHeight;
  }

  function clear() {
    Logger.clear();
    els.logBody.innerHTML = "";
    els.logCount.textContent = "0";
    const li = document.createElement("li");
    li.className = "empty-note";
    li.textContent = "No activity recorded yet.";
    els.logBody.appendChild(li);
    emptyEl = li;
  }

  function exportText() {
    return Logger.getAll()
      .map((e) => `[${e.time.toISOString()}] [${e.level.toUpperCase()}] [${e.category}] ${e.message}`)
      .join("\n");
  }

  function init() {
    Logger.subscribe(onNewEntry);
    els.logClearBtn.addEventListener("click", clear);
    els.logCopyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(exportText());
        Logger.info("ui", "Log copied to clipboard");
      } catch (_) {
        console.log(exportText());
        Logger.info("ui", "Clipboard unavailable - log printed to console instead");
      }
    });
  }
  return {
    init
  };
})();

/* Modrinth API client */
async function apiGet(path, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = performance.now();
    try {
      const res = await fetch(API + path, {
        headers: {
          Accept: "application/json",
          "User-Agent": UA
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const ms = Math.round(performance.now() - startedAt);

      if (res.status === 429) {
        const wait = Number(res.headers.get("Retry-After")) || 5;
        Logger.warn("api", `Rate limited - waiting ${wait}s (${label})`);
        await sleep(wait * 1000);
        continue;
      }
      if (res.status === 410) throw new Error("This Modrinth API version is deprecated (HTTP 410)");
      if (!res.ok) throw new Error("HTTP " + res.status);

      Logger.network("api", `200 OK ${ms}ms · ${label}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      const reason = err.name === "TimeoutError" ? "timeout" : err.message || "network error";
      Logger.warn("api", `Attempt ${attempt}/${MAX_RETRIES} failed · ${label} · ${reason}`);
      if (attempt < MAX_RETRIES) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastErr || new Error("Request failed");
}

/** Bulk-fetch project metadata in one call - the documented /v2/projects endpoint. */
async function apiGetProjects(ids) {
  if (!ids.length) return [];
  const query = new URLSearchParams({
    ids: JSON.stringify(ids)
  });
  const list = await apiGet(`/v2/projects?${query}`, `${ids.length} project(s)`);
  return Array.isArray(list) ? list : [];
}

async function apiGetProjectVersions(projectId, loader, mcVersion, loaderAgnostic) {
  const params = new URLSearchParams();
  if (loader && !loaderAgnostic) params.set("loaders", JSON.stringify([loader]));
  params.set("game_versions", JSON.stringify([mcVersion]));
  const versions = await apiGet(`/v2/project/${encodeURIComponent(projectId)}/version?${params}`, "versions");
  return Array.isArray(versions) ? versions : [];
}

async function poolMap(items, limit, fn) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length && !state.aborted) {
      const item = items[cursor++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({
    length: Math.min(limit, items.length)
  }, worker));
}

/* Tag data (versions / loaders / project types) */
function visibleVersions() {
  const wanted = new Set();
  if (els.vRelease.checked) wanted.add("release");
  if (els.vSnapshot.checked) wanted.add("snapshot");
  if (els.vBeta.checked) wanted.add("beta");
  if (els.vAlpha.checked) wanted.add("alpha");
  return state.tags.versions.filter((v) => wanted.has(v.version_type));
}

function renderVersionSelect() {
  const list = visibleVersions();
  const previous = els.mcVersion.value;
  els.mcVersion.innerHTML = "";
  if (!list.length) {
    els.mcVersion.innerHTML = '<option value="">No versions selected</option>';
    return;
  }
  for (const v of list) {
    const opt = document.createElement("option");
    opt.value = v.version;
    opt.textContent = v.version + (v.major ? " · Major" : "");
    els.mcVersion.appendChild(opt);
  }
  els.mcVersion.value = list.some((v) => v.version === previous) ? previous : list[0].version;
}

function splitLoadersByType() {
  const mod = [],
    plugin = [];
  for (const l of state.tags.loaders) {
    const types = l.supported_project_types || [];
    if (types.includes("plugin")) plugin.push(l.name);
    else if (types.includes("mod")) mod.push(l.name);
  }
  return {
    mod,
    plugin
  };
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function populateLoaderSelect() {
  const {
    mod,
    plugin
  } = splitLoadersByType();
  els.loader.innerHTML = '<option value="" disabled selected hidden>Select a mod/plugin loader...</option>';
  const addGroup = (label, names) => {
    if (!names.length) return;
    const group = document.createElement("optgroup");
    group.label = label;
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = capitalize(name);
      group.appendChild(opt);
    }
    els.loader.appendChild(group);
  };
  addGroup("Mod loaders", mod);
  addGroup("Plugin / server loaders", plugin);
}

function populateProjectTypeToggles() {
  els.projectTypeToggles.innerHTML = "";
  for (const type of state.tags.projectTypes) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" class="ptype-chk" value="${type}" checked /> ${capitalize(type)}`;
    els.projectTypeToggles.appendChild(label);
  }
}

async function loadTags() {
  try {
    Logger.info("tags", "Loading versions, loaders and project types...");
    const [versions, loaders, types] = await Promise.all([
      apiGet("/v2/tag/game_version", "game versions"),
      apiGet("/v2/tag/loader", "loaders"),
      apiGet("/v2/tag/project_type", "project types"),
    ]);
    state.tags.versions = Array.isArray(versions) ? versions : [];
    state.tags.loaders = Array.isArray(loaders) ? loaders : [];
    state.tags.projectTypes = Array.isArray(types) ? types.filter((t) => !EXCLUDED_PROJECT_TYPES.has(t)) : [];

    renderVersionSelect();
    populateLoaderSelect();
    populateProjectTypeToggles();
    applyStoredPrefs();

    Logger.info(
      "tags",
      `Loaded ${state.tags.versions.length} versions · ${state.tags.loaders.length} loaders · ${state.tags.projectTypes.length} project types`,
    );
  } catch (err) {
    Logger.error("tags", `Failed to load app data: ${err.message}`);
    els.mcVersion.innerHTML = '<option value="">Failed to load - reload the page</option>';
  }
}

function applyStoredPrefs() {
  const prefs = loadPrefs();
  if (prefs.loader && [...els.loader.options].some((o) => o.value === prefs.loader)) {
    els.loader.value = prefs.loader;
  }
  if (prefs.mcVersion && [...els.mcVersion.options].some((o) => o.value === prefs.mcVersion)) {
    els.mcVersion.value = prefs.mcVersion;
  }
  if (Array.isArray(prefs.channels) && prefs.channels.length) {
    document.querySelectorAll(".channel-chk").forEach((c) => (c.checked = prefs.channels.includes(c.value)));
  }
  if (typeof prefs.depAuto === "boolean") els.depAuto.checked = prefs.depAuto;
  if (typeof prefs.depReq === "boolean") els.depReq.checked = prefs.depReq;
  if (typeof prefs.depOpt === "boolean") els.depOpt.checked = prefs.depOpt;
  els.depSubRow.classList.toggle("off", !els.depAuto.checked);
}

/* Collection resolution */
function showError(message, focusEl) {
  els.formError.hidden = false;
  els.formError.textContent = message;
  if (focusEl) focusEl.focus();
}

function hideError() {
  els.formError.hidden = true;
  els.formError.textContent = "";
}

function makeJob(id, isDependency, pinnedVersionId) {
  return {
    id,
    status: "pending",
    statusLabel: "Pending",
    title: id,
    projectType: "mod",
    isDependency: !!isDependency,
    pinnedVersionId: pinnedVersionId || null,
  };
}

function loaderIsPlugin(loader) {
  if (!loader) return false;
  const tag = state.tags.loaders.find((l) => l.name === loader);
  return !!tag && (tag.supported_project_types || []).includes("plugin");
}

function classifyProjectType(project, loader) {
  const rawType = project.project_type || "mod";
  if (rawType !== "mod") return rawType;
  return loaderIsPlugin(loader) ? "plugin" : "mod";
}

function pickBestVersion(versions, acceptedChannels) {
  const inChannel = versions.filter((v) => acceptedChannels.has(v.version_type));
  if (!inChannel.length) return null;
  const releases = inChannel.filter((v) => v.version_type === "release");
  return (releases.length ? releases : inChannel)[0];
}

function isPinnedCompatible(version, project, opts) {
  const loaders = version.loaders || [];
  const gameVersions = version.game_versions || [];
  const agnostic = LOADER_AGNOSTIC_TYPES.has(project.project_type);
  const loaderOk = agnostic || !loaders.length || loaders.includes(opts.loader);
  const gameOk = !gameVersions.length || gameVersions.includes(opts.mcVersion);
  return loaderOk && gameOk;
}

async function searchBestVersion(job, project, opts) {
  const loaderAgnostic = LOADER_AGNOSTIC_TYPES.has(project.project_type);
  let versions = await apiGetProjectVersions(job.id, opts.loader, opts.mcVersion, loaderAgnostic);
  if (!versions.length && project.project_type === "modpack") {
    const fallback = await apiGetProjectVersions(job.id, "", opts.mcVersion, true);
    versions = fallback.filter((v) => {
      const loaders = v.loaders || [];
      return !loaders.length || loaders.includes(opts.loader);
    });
    if (versions.length) {
      Logger.warn("resolve", `${job.title}: matched a modpack version without a ${opts.loader} loader filter`);
    }
  }
  if (!versions.length) return [null, "No matching version"];
  const best = pickBestVersion(versions, opts.channels);
  return [best || null, best ? "" : "No matching channel"];
}

async function resolveJob(job, opts, projectCache, enqueue) {
  const project = projectCache.get(job.id) || (await fetchProjectSingle(job.id, projectCache));
  if (!project) {
    job.status = "fail";
    job.statusLabel = "Not found";
    return;
  }
  job.title = project.title || job.id;
  job.iconUrl = project.icon_url || null;
  job.projectType = classifyProjectType(project, opts.loader);

  if (!job.isDependency && opts.allowedTypes && !opts.allowedTypes.has(job.projectType)) {
    job.status = "skipped";
    job.statusLabel = "Filtered out";
    return;
  }

  try {
    let bestVersion;
    let statusLabel = "";
    if (job.pinnedVersionId) {
      const pinned = await apiGet(`/v2/version/${encodeURIComponent(job.pinnedVersionId)}`, `pinned: ${job.title}`);
      if (isPinnedCompatible(pinned, project, opts)) {
        bestVersion = pinned;
      } else {
        Logger.warn(
          "resolve",
          `${job.title}: pinned version does not match ${opts.loader} ${opts.mcVersion} - searching for a compatible one`,
        );
        [bestVersion, statusLabel] = await searchBestVersion(job, project, opts);
      }
    } else {
      [bestVersion, statusLabel] = await searchBestVersion(job, project, opts);
    }

    if (!bestVersion) {
      job.status = "fail";
      job.statusLabel = statusLabel || "No matching version";
      return;
    }

    const file = (bestVersion.files || []).find((f) => f.primary) || (bestVersion.files || [])[0];
    if (!file) {
      job.status = "fail";
      job.statusLabel = "No downloadable file";
      return;
    }

    job.status = "ready";
    job.statusLabel = bestVersion.version_type === "release" ? "Ready" : `Ready (${bestVersion.version_type})`;
    job.filename = file.filename;
    job.url = file.url;
    job.size = file.size || 0;
    job.versionNumber = bestVersion.version_number;

    if (opts.depAuto) {
      for (const dep of bestVersion.dependencies || []) {
        const wanted =
          (dep.dependency_type === "required" && opts.depReq) ||
          (dep.dependency_type === "optional" && opts.depOpt);
        if (!wanted || !dep.project_id) continue;
        enqueue(dep.project_id, true, dep.version_id || null);
      }
    }
  } catch (err) {
    job.status = "fail";
    job.statusLabel = "Fetch failed";
    Logger.error("resolve", `${job.title}: ${err.message}`);
  }
}

async function fetchProjectSingle(id, projectCache) {
  try {
    const project = await apiGet(`/v2/project/${encodeURIComponent(id)}`, `project: ${id}`);
    if (project && project.id) {
      projectCache.set(id, project);
      return project;
    }
  } catch (err) {
    Logger.error("resolve", `Could not load project ${id}: ${err.message}`);
  }
  return null;
}

function collectFormOptions() {
  const allowedTypes = new Set(
    [...els.projectTypeToggles.querySelectorAll(".ptype-chk:checked")].map((c) => c.value),
  );
  return {
    mcVersion: els.mcVersion.value,
    loader: els.loader.value,
    allowedTypes: allowedTypes.size ? allowedTypes : null,
    channels: new Set([...document.querySelectorAll(".channel-chk:checked")].map((c) => c.value)),
    depAuto: els.depAuto.checked,
    depReq: els.depReq.checked,
    depOpt: els.depOpt.checked,
  };
}

function renderCollectionInfo(collection, count) {
  const icon = collection.icon_url ?
    `<img src="${collection.icon_url}" alt="" loading="lazy" />` :
    "";
  els.collectionInfo.innerHTML = `${icon}
    <div>
      <strong></strong>
      <span></span>
    </div>`;
  els.collectionInfo.querySelector("strong").textContent = collection.name || "Untitled collection";
  els.collectionInfo.querySelector("span").textContent = `${count} project${count === 1 ? "" : "s"}`;
}

function setResolvingUI(isResolving) {
  state.resolving = isResolving;
  els.formFields.disabled = isResolving;
  els.fetchBtn.disabled = isResolving;
  els.fetchBtn.innerHTML = isResolving ? '<span class="spinner"></span>Fetching...' : "Fetch Collection";
  els.progressBar.hidden = !isResolving;
  updateCancelVisibility();
  updateStats();
}

function updateCancelVisibility() {
  els.cancelBtn.hidden = !(state.resolving || downloadController);
}

async function resolveCollection() {
  const collectionId = parseCollectionInput(els.collectionId.value);
  if (!collectionId) return showError("Please enter a Collection ID or URL.", els.collectionId);
  if (!els.mcVersion.value) return showError("Please select a Minecraft version.", els.mcVersion);
  if (!els.loader.value) return showError("Please select a mod/plugin loader.", els.loader);
  hideError();
  savePrefs();

  state.aborted = false;
  setResolvingUI(true);
  setProgress(0);

  try {
    Logger.info("collection", `Fetching collection ${collectionId}...`);
    const collection = await apiGet(`/v3/collection/${encodeURIComponent(collectionId)}`, `collection: ${collectionId}`);
    const ids = Array.isArray(collection.projects) ? collection.projects : [];

    state.jobs = [];
    els.resultCard.hidden = false;
    renderCollectionInfo(collection, ids.length);

    if (!ids.length) {
      Logger.warn("collection", "This collection has no projects.");
      renderItems();
      updateStats();
      return;
    }

    // Fully utilize the bulk /v2/projects endpoint: one request for every project
    // already in the collection, instead of N individual lookups.
    Logger.info("collection", `Bulk-fetching metadata for ${ids.length} project(s)...`);
    const bulkProjects = await apiGetProjects(ids);
    const projectCache = new Map(bulkProjects.map((p) => [p.id, p]));

    const known = new Set();
    const enqueue = (id, isDependency, pinnedVersionId) => {
      if (known.has(id)) return;
      known.add(id);
      const job = makeJob(id, isDependency, pinnedVersionId);
      state.jobs.push(job);
      queue.push(job);
    };

    const queue = [];
    ids.forEach((id) => enqueue(id, false, null));
    renderSkeletons(ids.length);
    updateStats();
    Logger.info("collection", `"${collection.name || collectionId}" · ${ids.length} project(s) queued`);

    const opts = collectFormOptions();
    let done = 0;
    let peakTotal = 0;
    const total = () => state.jobs.length;

    const tick = () => {
      done++;
      peakTotal = Math.max(peakTotal, total());
      setProgress((done / Math.max(1, peakTotal)) * 100);
      queueRender();
    };

    await poolMap(queue, RESOLVE_CONCURRENCY, async (job) => {
      await resolveJob(job, opts, projectCache, enqueue);
      tick();
    });

    // New dependency jobs may have been enqueued mid-flight; drain those too.
    while (queue.length && !state.aborted) {
      const job = queue.shift();
      await resolveJob(job, opts, projectCache, enqueue);
      tick();
    }

    if (state.aborted) {
      for (const job of state.jobs) {
        if (job.status === "pending") {
          job.status = "skipped";
          job.statusLabel = "Cancelled";
        }
      }
      Logger.warn("collection", "Resolution cancelled by user.");
    } else {
      const readyCount = state.jobs.filter((j) => j.status === "ready").length;
      Logger.info("resolve", `Resolved ${readyCount}/${state.jobs.length} file(s)`);
    }
    renderItems();
    updateStats();
  } catch (err) {
    showError(`Something went wrong: ${err.message}`);
    Logger.error("collection", err.message);
  } finally {
    setResolvingUI(false);
  }
}

/* Rendering */
const ICONS = {
  check: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8m0-8l-8 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  pulse: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 9l3-4 2.5 6L10 6l4 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  puzzle: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M7.5 3V2a1.5 1.5 0 0 1 3 0v1h2a1 1 0 0 1 1 1v2h-1a1.5 1.5 0 0 0 0 3h1v2a1 1 0 0 1-1 1H9.5v1a1.5 1.5 0 0 1-3 0v-1H4a1 1 0 0 1-1-1V7h1a1.5 1.5 0 0 0 0-3H4V4a1 1 0 0 1 1-1h2.5z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tray: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 10l4 4 4-4m-4 4V4m-6 13h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  dl: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5V10.5m0 0L5 7.5m3 3l3-3M3.5 13h9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const BADGE_ICONS = {
  ready: ICONS.check,
  done: ICONS.check,
  fail: ICONS.x,
  pending: ICONS.pulse
};

let animateItemsIn = false;
let renderQueued = false;

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderItems();
    updateStats();
  });
}

function renderSkeletons(count) {
  els.items.innerHTML = "";
  animateItemsIn = true;
  if (!count) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < Math.min(count, 8); i++) {
    const row = document.createElement("li");
    row.className = "skeleton-row";
    row.innerHTML = `<span class="sk-img"></span>
      <div><div class="sk-line"></div><div class="sk-line short"></div></div>
      <span class="sk-badge"></span>`;
    frag.appendChild(row);
  }
  els.items.appendChild(frag);
}

function renderItems() {
  els.items.innerHTML = "";
  if (!state.jobs.length) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.innerHTML = `${ICONS.tray}<span>No projects to show.</span>`;
    els.items.appendChild(li);
    return;
  }
  const animate = animateItemsIn;
  animateItemsIn = false;
  const frag = document.createDocumentFragment();
  state.jobs.forEach((job, index) => {
    const row = document.createElement("li");
    row.className = "item";
    if (animate) row.style.animationDelay = `${Math.min(index * 0.03, 0.5)}s`;

    if (job.iconUrl) {
      const img = document.createElement("img");
      img.src = job.iconUrl;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => img.remove());
      row.appendChild(img);
    }

    const title = document.createElement("span");
    title.className = "item-title";
    if (job.isDependency) {
      const mark = document.createElement("span");
      mark.className = "dep-mark";
      mark.title = "Dependency of another project";
      mark.innerHTML = `${ICONS.puzzle}<span>dep</span>`;
      title.appendChild(mark);
    }
    title.appendChild(document.createTextNode(job.title));
    row.appendChild(title);

    const sub = document.createElement("small");
    sub.className = "item-sub";
    sub.textContent = [job.projectType, job.versionNumber, job.size && formatBytes(job.size)]
      .filter(Boolean)
      .join(" · ");
    row.appendChild(sub);

    const badgeClass = {
      ready: "b-ready",
      done: "b-done",
      fail: "b-fail",
      skipped: "b-skip",
      pending: "b-pending"
    } [
      job.status
    ] || "b-pending";
    const badge = document.createElement("span");
    badge.className = "badge " + badgeClass;
    const icon = BADGE_ICONS[job.status];
    badge.innerHTML = (icon || "") + `<span>${job.statusLabel || job.status}</span>`;
    row.appendChild(badge);

    if (job.status === "ready" && !state.resolving && !downloadController) {
      const dlBtn = document.createElement("button");
      dlBtn.type = "button";
      dlBtn.className = "item-dl";
      dlBtn.title = `Download ${job.filename}`;
      dlBtn.setAttribute("aria-label", `Download ${job.title}`);
      dlBtn.innerHTML = ICONS.dl;
      dlBtn.addEventListener("click", () => downloadOne(job));
      row.appendChild(dlBtn);
    }

    frag.appendChild(row);
  });
  els.items.appendChild(frag);
}

function updateStats() {
  const jobs = state.jobs;
  const ready = jobs.filter((j) => j.status === "ready" || j.status === "done").length;
  const failed = jobs.filter((j) => j.status === "fail").length;
  const skipped = jobs.filter((j) => j.status === "skipped").length;
  els.downloadAllBtn.disabled = ready === 0 || state.resolving;
  els.downloadZipBtn.disabled = ready === 0 || state.resolving;

  els.stats.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const [label, num] of [
      ["Ready", ready],
      ["Failed", failed],
      ["Skipped", skipped],
      ["Total", jobs.length]
    ]) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `<dt>${label}</dt><dd>${num}</dd>`;
    frag.appendChild(wrapper);
  }
  els.stats.appendChild(frag);
}

function setProgress(pct) {
  els.progressBar.value = Math.max(0, Math.min(100, pct));
}

/* Downloads */
let downloadController = null;
let lastDownloadTrigger = 0;
const isAbort = (err) => err && err.name === "AbortError";

function beginDownload() {
  downloadController = new AbortController();
  updateCancelVisibility();
}

function endDownload() {
  downloadController = null;
  updateCancelVisibility();
}

function makeDownloadSignal() {
  const inner = new AbortController();
  const onAbort = () => inner.abort(new DOMException("Aborted", "AbortError"));
  if (downloadController) downloadController.signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => inner.abort(new DOMException("Timeout", "TimeoutError")), DOWNLOAD_TIMEOUT_MS);
  return {
    signal: inner.signal,
    done: () => {
      clearTimeout(timer);
      if (downloadController) downloadController.signal.removeEventListener("abort", onAbort);
    }
  };
}

async function fetchBinary(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const guard = makeDownloadSignal();
    try {
      const res = await fetch(url, { signal: guard.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const blob = await res.blob();
      if (!blob.size) throw new Error("Empty response");
      return blob;
    } catch (err) {
      lastErr = err;
      if (isAbort(err)) throw err;
      Logger.warn("download", `Attempt ${attempt}/${MAX_RETRIES} failed (${url}) - retrying`);
      if (attempt < MAX_RETRIES) await sleep(600);
    } finally {
      guard.done();
    }
  }
  throw lastErr;
}

async function triggeredDownload(blob, filename) {
  const wait = Math.max(0, lastDownloadTrigger + DOWNLOAD_DELAY_MS - performance.now());
  if (wait > 0) await sleep(wait);
  lastDownloadTrigger = performance.now();
  downloadBlob(blob, filename);
}

async function downloadOne(job) {
  if (job.status !== "ready" || downloadController) return;
  Logger.info("download", `Downloading ${job.filename}...`);
  beginDownload();
  els.progressBar.hidden = false;
  setProgress(0);
  try {
    const blob = await fetchBinary(job.url);
    await triggeredDownload(blob, job.filename);
    job.status = "done";
    job.statusLabel = "Done";
    Logger.info("download", `${job.filename} - done (${formatBytes(blob.size)})`);
  } catch (err) {
    if (isAbort(err)) {
      Logger.warn("download", `${job.filename}: download cancelled`);
    } else {
      job.status = "fail";
      job.statusLabel = "Download failed";
      Logger.error("download", `${job.filename}: ${err.message}`);
    }
  } finally {
    endDownload();
    els.progressBar.hidden = true;
    renderItems();
    updateStats();
  }
}

async function downloadAll() {
  const targets = state.jobs.filter((j) => j.status === "ready");
  if (!targets.length || downloadController) return;
  Logger.info("download", `Downloading ${targets.length} file(s)...`);
  beginDownload();
  els.downloadAllBtn.disabled = true;
  els.downloadZipBtn.disabled = true;
  els.progressBar.hidden = false;
  setProgress(0);

  let done = 0;
  let cancelled = false;
  await poolMap(targets, DOWNLOAD_CONCURRENCY, async (job) => {
    try {
      const blob = await fetchBinary(job.url);
      await triggeredDownload(blob, job.filename);
      job.status = "done";
      job.statusLabel = "Done";
      Logger.info("download", `${job.filename} - done (${formatBytes(blob.size)})`);
    } catch (err) {
      if (isAbort(err)) {
        cancelled = true;
        Logger.warn("download", `${job.filename}: download cancelled`);
      } else {
        job.status = "fail";
        job.statusLabel = "Download failed";
        Logger.error("download", `${job.filename}: ${err.message}`);
      }
    } finally {
      done++;
      setProgress((done / targets.length) * 100);
    }
  });

  if (cancelled) {
    Logger.warn("download", `Downloading cancelled - ${state.jobs.filter((j) => j.status === "done").length} file(s) completed`);
  }
  endDownload();
  els.progressBar.hidden = true;
  renderItems();
  updateStats();
}

async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  for (const src of ZIP_CDNS) {
    try {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error("failed to load " + src));
        document.head.appendChild(script);
      });
      if (window.JSZip) return window.JSZip;
    } catch (err) {
      Logger.warn("zip", err.message);
    }
  }
  throw new Error("JSZip could not be loaded from any CDN");
}

async function downloadZip() {
  const targets = state.jobs.filter((j) => j.status === "ready" || j.status === "done");
  if (!targets.length || downloadController) return;

  beginDownload();
  els.downloadAllBtn.disabled = true;
  els.downloadZipBtn.disabled = true;
  els.progressBar.hidden = false;
  setProgress(0);

  let JSZip;
  try {
    Logger.info("zip", "Loading ZIP library...");
    JSZip = await loadJSZip();
  } catch (err) {
    Logger.error("zip", `ZIP unavailable: ${err.message}. Use Download All instead.`);
    endDownload();
    els.progressBar.hidden = true;
    renderItems();
    updateStats();
    return;
  }

  const zip = new JSZip();
  const usedPaths = new Set();
  let done = 0;
  let cancelled = false;
  Logger.info("zip", `Fetching ${targets.length} file(s) into memory...`);
  await poolMap(targets, DOWNLOAD_CONCURRENCY, async (job) => {
    try {
      const buffer = await (await fetchBinary(job.url)).arrayBuffer();
      const folder = PROJECT_FOLDERS[job.projectType] || "";
      zip.file(uniquePath(folder, job.filename, usedPaths), buffer, {
        binary: true
      });
      job.status = "done";
      job.statusLabel = "Done";
    } catch (err) {
      if (isAbort(err)) {
        cancelled = true;
        Logger.warn("zip", `${job.filename}: download cancelled`);
      } else {
        job.status = "fail";
        job.statusLabel = "Download failed";
        Logger.error("zip", `${job.filename}: ${err.message}`);
      }
    } finally {
      done++;
      setProgress((done / targets.length) * 100);
    }
  });

  if (!cancelled) {
    try {
      const blob = await zip.generateAsync({
        type: "blob"
      });
      downloadBlob(blob, `modrinth-collection-${Date.now()}.zip`);
      Logger.info("zip", `ZIP ready: ${formatBytes(blob.size)} - downloading`);
    } catch (err) {
      Logger.error("zip", `Failed to build ZIP: ${err.message}`);
    }
  } else {
    Logger.warn("zip", "ZIP cancelled - no archive built");
  }

  endDownload();
  els.progressBar.hidden = true;
  renderItems();
  updateStats();
}

/* Init */
function initGithubLink() {
  if (!REPO_URL) return;
  els.githubLink.href = REPO_URL;
  els.githubLink.hidden = false;
}

function init() {
  LogPanel.init();
  initGithubLink();

  [els.vRelease, els.vSnapshot, els.vBeta, els.vAlpha].forEach((cb) => {
    cb.addEventListener("change", () => {
      if (![els.vRelease, els.vSnapshot, els.vBeta, els.vAlpha].some((c) => c.checked)) {
        els.vRelease.checked = true;
        Logger.warn("versions", "Re-enabled Releases - at least one channel must be shown");
      }
      renderVersionSelect();
    });
  });

  const channelCbs = [...document.querySelectorAll(".channel-chk")];
  channelCbs.forEach((cb) => {
    cb.addEventListener("change", () => {
      if (!channelCbs.some((c) => c.checked)) {
        cb.checked = true;
        Logger.warn("channels", "Re-enabled - at least one release channel must be accepted");
      }
    });
  });

  els.depAuto.addEventListener("change", () => {
    els.depSubRow.classList.toggle("off", !els.depAuto.checked);
  });

  els.collectionId.addEventListener("input", hideError);
  els.appForm.addEventListener("submit", (e) => {
    e.preventDefault();
    resolveCollection();
  });
  els.cancelBtn.addEventListener("click", () => {
    state.aborted = true;
    if (downloadController) downloadController.abort();
  });
  els.downloadAllBtn.addEventListener("click", downloadAll);
  els.downloadZipBtn.addEventListener("click", downloadZip);

  loadTags();
}

init();