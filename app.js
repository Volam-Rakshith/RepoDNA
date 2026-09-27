/* RepoDNA — public GitHub repository microscope
 * All analysis is calculated in-browser from public GitHub REST API responses.
 */
const API_ROOT = "https://api.github.com";
const CACHE_TTL = 5 * 60 * 1000;
const MAX_TREE_FILES = 2200;
const state = {
  scanId: 0,
  repo: null,
  owner: "",
  name: "",
  tree: [],
  files: [],
  languages: {},
  commits: [],
  contributors: [],
  branches: [],
  releases: [],
  tags: [],
  manifests: [],
  manifestData: [],
  warnings: [],
  rateRemaining: null,
  dimensions: [],
  analysis: null,
  churn: null,
  growth: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const els = {
  landing: $("#landing"), loading: $("#loading"), workspace: $("#workspace"),
  form: $("#scan-form"), input: $("#repo-input"), landingError: $("#landing-error"),
  loadingTitle: $("#loading-title"), loadingDetail: $("#loading-detail"), loadingStep: $("#loading-step-number"), loadingProgress: $("#loading-progress"),
  errorModal: $("#error-modal"), errorMessage: $("#error-message"), errorAction: $("#error-action"),
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, n));
const esc = (value = "") => String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
const number = (value) => new Intl.NumberFormat("en-US").format(value || 0);
const percent = (value, digits = 1) => `${Number(value || 0).toFixed(digits)}%`;
const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};
const formatDate = (value, options = {month:"short", day:"numeric", year:"numeric"}) => value ? new Intl.DateTimeFormat("en-US", options).format(new Date(value)) : "unknown";
const formatShortDate = value => formatDate(value, {month:"short", day:"numeric", year:"2-digit"});
const relativeDate = value => {
  if (!value) return "unknown";
  const delta = Date.now() - new Date(value).getTime();
  const days = Math.floor(delta / 86400000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
};
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function parseRepoInput(raw) {
  let value = String(raw || "").trim();
  if (!value) throw new Error("Paste a GitHub repository URL or use the owner/repository format.");
  if (!/^https?:\/\//i.test(value) && !/^github\.com\//i.test(value)) value = `https://github.com/${value}`;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url;
  try { url = new URL(value); } catch { throw new Error("That does not look like a valid GitHub repository address."); }
  if (url.hostname.toLowerCase() !== "github.com" && url.hostname.toLowerCase() !== "www.github.com") {
    throw new Error("RepoDNA only accepts repositories hosted on github.com.");
  }
  const parts = url.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
  if (parts.length !== 2) throw new Error("Use a repository URL like github.com/owner/repository — not an issue, pull request, or profile URL.");
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new Error("The owner or repository name contains unsupported characters.");
  return { owner, name, full: `${owner}/${name}` };
}

class GithubError extends Error {
  constructor(message, status, payload = {}) { super(message); this.status = status; this.payload = payload; }
}

function isCacheablePath(path) {
  return !/\/git\/trees\//.test(path) && !/\/commits\/[^?]+$/.test(path) && !/\/stats\//.test(path);
}
function readCached(path) {
  if (!isCacheablePath(path)) return null;
  try {
    const item = JSON.parse(sessionStorage.getItem(`reprodna:${path}`) || "null");
    return item && Date.now() - item.saved < CACHE_TTL ? item.value : null;
  } catch { return null; }
}
function writeCached(path, value) {
  if (!isCacheablePath(path)) return;
  try { sessionStorage.setItem(`reprodna:${path}`, JSON.stringify({ saved: Date.now(), value })); } catch { /* storage is optional */ }
}

async function githubFetch(path, options = {}) {
  const cached = readCached(path);
  if (cached !== null) return cached;
  const response = await fetch(`${API_ROOT}${path}`, {
    ...options,
    // Keep the request CORS-simple. GitHub's public API accepts this media type without OAuth or custom headers.
    headers: { Accept: "application/vnd.github+json", ...(options.headers || {}) },
  });
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining !== null) {
    const value = Number(remaining);
    state.rateRemaining = state.rateRemaining === null ? value : Math.min(state.rateRemaining, value);
  }
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const fallback = response.status === 403 ? "GitHub's public API rate limit may have been reached." : `GitHub returned HTTP ${response.status}.`;
    throw new GithubError(payload?.message || fallback, response.status, payload || {});
  }
  writeCached(path, payload);
  return payload;
}

async function githubStatsFetch(path) {
  const response = await fetch(`${API_ROOT}${path}`, { headers: { Accept: "application/vnd.github+json" } });
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining !== null) {
    const value = Number(remaining);
    state.rateRemaining = state.rateRemaining === null ? value : Math.min(state.rateRemaining, value);
  }
  let payload = null; try { payload = await response.json(); } catch { /* no body */ }
  if (response.status === 202) return { deferred: true, data: null };
  if (!response.ok) throw new GithubError(payload?.message || `GitHub returned HTTP ${response.status}.`, response.status, payload || {});
  return { deferred: false, data: payload };
}

function setLoading(step, title, detail, progress) {
  els.loadingStep.textContent = String(step).padStart(2, "0");
  els.loadingTitle.textContent = title;
  els.loadingDetail.textContent = detail;
  els.loadingProgress.style.width = `${progress}%`;
}

function showLandingError(message) { els.landingError.textContent = message; els.landingError.hidden = false; }
function clearLandingError() { els.landingError.hidden = true; els.landingError.textContent = ""; }
function showLoading() { els.landing.hidden = true; els.workspace.hidden = true; els.loading.hidden = false; }
function showWorkspace() { els.loading.hidden = true; els.landing.hidden = true; els.workspace.hidden = false; window.scrollTo({ top: 0, behavior: "instant" }); }
function showLanding() { els.loading.hidden = true; els.workspace.hidden = true; els.landing.hidden = false; }

function friendlyError(error) {
  if (error instanceof GithubError) {
    if (error.status === 404) return { message: "GitHub could not find a public repository at that address.", action: "Check the owner and repository spelling. Private repositories and deleted repositories look the same to GitHub's public API." };
    if (error.status === 403 || error.status === 429) return { message: "GitHub's public API rate limit is currently unavailable for this scan.", action: "Wait a little and try again. RepoDNA does not ask for OAuth or require a paid API key." };
    if (error.status === 451) return { message: "GitHub declined this request due to a legal or regional restriction.", action: "Try another public repository." };
    return { message: error.message || "GitHub returned an unexpected response.", action: "The repository may be unavailable or the network may have interrupted the scan." };
  }
  if (error?.name === "TypeError" || /fetch/i.test(error?.message || "")) return { message: "The network connection to GitHub failed.", action: "Check your connection, browser extensions, or GitHub status, then retry. Nothing was uploaded by RepoDNA." };
  return { message: error?.message || "The scan could not be completed.", action: "Try a different public repository." };
}
function openError(error) {
  const result = friendlyError(error);
  els.errorMessage.textContent = result.message;
  els.errorAction.textContent = result.action;
  els.errorModal.hidden = false;
}
function closeError() { els.errorModal.hidden = true; }

function noteWarning(text) { if (!state.warnings.includes(text)) state.warnings.push(text); }
function updateRateBadge() { $("#rate-limit-badge").textContent = state.rateRemaining === null ? "API budget —" : `API budget ${state.rateRemaining} left`; }

async function scanRepository(parsed) {
  const id = ++state.scanId;
  Object.assign(state, { repo: null, owner: parsed.owner, name: parsed.name, tree: [], files: [], languages: {}, commits: [], contributors: [], branches: [], releases: [], tags: [], manifests: [], manifestData: [], warnings: [], rateRemaining: null, dimensions: [], analysis: null, churn: null, growth: null });
  showLoading();
  try {
    setLoading(1, "Opening the specimen…", "Requesting public repository metadata.", 8);
    const repo = await githubFetch(`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`);
    if (id !== state.scanId) return;
    if (repo.private) throw new GithubError("This repository is private.", 404);
    state.repo = repo;
    setLoading(2, "Mapping the outer shell…", "Reading languages, branches, releases, and the file tree in parallel.", 23);
    const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`;
    const requests = await Promise.allSettled([
      githubFetch(`${base}/languages`),
      githubFetch(`${base}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`),
      githubFetch(`${base}/commits?per_page=100`),
      githubFetch(`${base}/contributors?per_page=10&anon=true`),
      githubFetch(`${base}/branches?per_page=15`),
      githubFetch(`${base}/releases?per_page=8`),
      githubFetch(`${base}/tags?per_page=8`),
    ]);
    if (id !== state.scanId) return;
    const [languages, treeResponse, commits, contributors, branches, releases, tags] = requests.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const labels = ["language statistics", "file tree", "commit sample", "contributors", "branches", "releases", "tags"];
      if (result.reason?.status === 403 || result.reason?.status === 429) noteWarning("GitHub rate-limited part of this scan; the missing signals are left blank.");
      else if (index === 1) noteWarning("GitHub did not return the recursive file tree; structure metrics are incomplete.");
      else noteWarning(`${labels[index]} could not be loaded.`);
      return null;
    });
    state.languages = languages || {};
    state.tree = treeResponse?.tree || [];
    if (treeResponse?.truncated) noteWarning("GitHub marked the file tree as truncated. Counts and structure metrics use the returned subset.");
    state.files = state.tree.filter(item => item.type === "blob").map(item => ({ path: item.path, size: item.size || 0, sha: item.sha })).slice(0, MAX_TREE_FILES);
    if ((treeResponse?.tree || []).filter(item => item.type === "blob").length > MAX_TREE_FILES) noteWarning(`This repository has more than ${number(MAX_TREE_FILES)} files in the scan window; the explorer shows the first ${number(MAX_TREE_FILES)} returned files.`);
    state.commits = Array.isArray(commits) ? commits : [];
    state.contributors = Array.isArray(contributors) ? contributors : [];
    state.branches = Array.isArray(branches) ? branches : [];
    state.releases = Array.isArray(releases) ? releases : [];
    state.tags = Array.isArray(tags) ? tags : [];
    setLoading(3, "Reading its grammar…", "Detecting manifests, configuration, documentation, and testing signals.", 45);
    const manifestPaths = detectManifestPaths(state.files);
    state.manifests = manifestPaths;
    state.manifestData = await fetchManifestData(parsed, repo.default_branch, manifestPaths.slice(0, 5));
    if (id !== state.scanId) return;
    setLoading(4, "Computing the signature…", "Converting public evidence into reproducible, inspectable signals.", 72);
    state.analysis = buildAnalysis();
    state.dimensions = buildDimensions(state.analysis);
    renderAll();
    setLoading(5, "Specimen ready.", "The profile is calculated in your browser from the returned public data.", 100);
    await sleep(280);
    showWorkspace();
    updateRateBadge();
    const repoParam = `${state.owner}/${state.name}`;
    const url = new URL(window.location.href); url.searchParams.set("repo", repoParam); history.replaceState({}, "", url);
  } catch (error) {
    console.error("RepoDNA scan failed", error);
    if (id !== state.scanId) return;
    els.loading.hidden = true;
    showLanding();
    openError(error);
  }
}

function detectManifestPaths(files) {
  const known = ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "pyproject.toml", "requirements.txt", "Pipfile", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "Gemfile", "composer.json", "mix.exs", "pubspec.yaml"];
  return files.filter(file => known.includes(file.path.split("/").pop()) || /^\.ruby-version$/.test(file.path.split("/").pop())).map(file => file.path).sort((a, b) => {
    const aRoot = a.split("/").length, bRoot = b.split("/").length;
    return aRoot - bRoot || a.localeCompare(b);
  }).slice(0, 8);
}
async function fetchManifestData(parsed, branch, paths) {
  const results = await Promise.all(paths.map(async path => {
    try {
      const branchPath = String(branch).split("/").map(encodeURIComponent).join("/");
      const url = `https://raw.githubusercontent.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}/${branchPath}/${path.split("/").map(encodeURIComponent).join("/")}`;
      const response = await fetch(url);
      if (!response.ok) return null;
      return { path, text: (await response.text()).slice(0, 180000) };
    } catch { return null; }
  }));
  return results.filter(Boolean);
}

function buildAnalysis() {
  const repo = state.repo || {};
  const files = state.files;
  const paths = files.map(file => file.path);
  const dirs = new Set();
  let maxDepth = 0;
  let totalBytes = 0;
  files.forEach(file => { totalBytes += file.size || 0; const parts = file.path.split("/"); maxDepth = Math.max(maxDepth, parts.length - 1); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/")); });
  const folderNames = [...dirs].map(path => path.split("/").pop().toLowerCase());
  const rootFiles = paths.filter(path => !path.includes("/"));
  const readme = paths.find(path => /^readme(?:\.[^/]+)?$/i.test(path.split("/").pop()));
  const docsDir = paths.some(path => /^(docs?|documentation)\//i.test(path));
  const markdownCount = paths.filter(path => /\.(md|mdx|rst|adoc)$/i.test(path)).length;
  const testPaths = paths.filter(path => /(^|\/)(__tests__|tests?|spec)($|\/)/i.test(path) || /(?:^|[._-])(test|spec)(?:[._-]|$)/i.test(path));
  const testConfig = paths.filter(path => /(?:jest|vitest|mocha|pytest|tox|karma|cypress|playwright|phpunit|rspec|junit)/i.test(path.split("/").pop()));
  const workflowCount = paths.filter(path => /^\.github\/workflows\/[^/]+/i.test(path)).length;
  const ciFiles = paths.filter(path => /^\.github\/workflows\//i.test(path) || /^\.circleci\//i.test(path) || /^buildkite/i.test(path) || /^(Dockerfile|docker-compose[^/]*|\.travis\.yml|azure-pipelines\.yml)$/i.test(path.split("/").pop()));
  const configFiles = paths.filter(path => /(^|\/)(\.github|\.devcontainer|\.circleci)(\/|$)/i.test(path) || /(?:^|\/)(?:Dockerfile|docker-compose[^/]*|vite\.config|next\.config|tsconfig|eslint|prettier|webpack|rollup|astro\.config|tailwind\.config|Makefile|\.editorconfig|\.nvmrc)(?:\.|$)/i.test(path.split("/").pop())).slice(0, 24);
  const languageEntries = Object.entries(state.languages).sort((a, b) => b[1] - a[1]);
  const languageTotal = languageEntries.reduce((sum, [, bytes]) => sum + bytes, 0);
  const dominantLanguage = languageEntries[0]?.[0] || "Unknown";
  const dominantShare = languageTotal ? languageEntries[0][1] / languageTotal : 0;
  const commitDates = state.commits.map(commit => commit.commit?.author?.date || commit.commit?.committer?.date).filter(Boolean).map(date => new Date(date)).sort((a, b) => a - b);
  const firstSampleDate = commitDates[0] || null;
  const lastSampleDate = commitDates[commitDates.length - 1] || null;
  const sampleDays = firstSampleDate && lastSampleDate ? Math.max(1, (lastSampleDate - firstSampleDate) / 86400000) : 0;
  const commitsPerWeek = sampleDays ? state.commits.length / sampleDays * 7 : 0;
  const created = repo.created_at ? new Date(repo.created_at) : null;
  const ageYears = created ? Math.max(0, (Date.now() - created.getTime()) / (365.25 * 86400000)) : null;
  const dependencyGroups = parseDependencies();
  const dependencyCount = dependencyGroups.reduce((sum, group) => sum + group.items.length, 0);
  const indicators = detectIndicators(paths, dependencyGroups);
  const recentCommitDate = commitDates[commitDates.length - 1] || (repo.pushed_at ? new Date(repo.pushed_at) : null);
  const topContributorShare = state.contributors[0]?.contributions && state.commits.length ? state.contributors[0].contributions / Math.max(1, state.contributors.reduce((sum, item) => sum + (item.contributions || 0), 0)) : null;
  return {
    paths, rootFiles, dirs: [...dirs], maxDepth, totalBytes, fileCount: files.length, folderCount: dirs.size,
    readme, docsDir, markdownCount, testPaths, testConfig, workflowCount, ciFiles, configFiles,
    languageEntries, languageTotal, dominantLanguage, dominantShare, commitDates, firstSampleDate, lastSampleDate, sampleDays, commitsPerWeek, commits: state.commits,
    created, ageYears, dependencyGroups, dependencyCount, manifestData: state.manifestData, manifests: state.manifests, indicators, recentCommitDate, topContributorShare,
    hasLicense: Boolean(repo.license?.spdx_id || paths.some(path => /^license(?:\.|$)/i.test(path.split("/").pop()))),
    tagsCount: state.tags.length, releaseCount: state.releases.length, contributorCount: state.contributors.length,
    branchCount: state.branches.length,
  };
}

function parseDependencies() {
  const groups = [];
  for (const manifest of state.manifestData) {
    const path = manifest.path;
    const base = path.split("/").pop();
    const items = [];
    const add = (name, section = "runtime") => { const clean = String(name || "").trim().replace(/^['"]|['"]$/g, ""); if (clean && !items.some(item => item.name === clean)) items.push({ name: clean, section }); };
    try {
      if (/package\.json$/i.test(base)) {
        const json = JSON.parse(manifest.text);
        ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].forEach(section => Object.keys(json[section] || {}).forEach(name => add(name, section.replace("Dependencies", ""))));
      } else if (/requirements\.txt$/i.test(base) || /^Pipfile$/i.test(base)) {
        manifest.text.split(/\r?\n/).forEach(line => { const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*(?:[<>=!~].*)?$/); if (match) add(match[1]); });
      } else if (/pyproject\.toml$/i.test(base)) {
        const matches = manifest.text.match(/^[\s-]*["']?([A-Za-z0-9_.-]+)(?:[<>=!~][^"']*)?["']?[, ]*$/gm) || [];
        matches.slice(0, 80).forEach(line => { const match = line.match(/([A-Za-z][A-Za-z0-9_.-]+)(?:[<>=!~]|$)/); if (match && !/^(name|version|description|requires-python|python)$/i.test(match[1])) add(match[1]); });
      } else if (/^go\.mod$/i.test(base)) {
        manifest.text.split(/\r?\n/).forEach(line => { const match = line.match(/^\s*(?:[a-z0-9][^\s]+)\s+v[\w.-]+/i); if (match) add(match[1]); });
      } else if (/^Cargo\.toml$/i.test(base)) {
        const sectionMatch = manifest.text.match(/\[dependencies\]([\s\S]*?)(?=\n\[|$)/i); (sectionMatch?.[1] || "").split(/\r?\n/).forEach(line => { const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/); if (match) add(match[1]); });
      } else if (/^(Gemfile|composer\.json|pom\.xml|build\.gradle)$/i.test(base)) {
        const matches = manifest.text.match(/(?:["'])([A-Za-z0-9_./:@-]{2,})(?:["'])/g) || [];
        matches.slice(0, 45).forEach(item => add(item.replace(/["']/g, "")));
      }
    } catch { /* malformed manifests are shown as present, not guessed */ }
    if (items.length || /(?:package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle)/i.test(base)) groups.push({ path, base, items: items.slice(0, 24) });
  }
  return groups;
}

function detectIndicators(paths, dependencyGroups) {
  const names = paths.map(path => path.toLowerCase().split("/").pop());
  const dependencyNames = dependencyGroups.flatMap(group => group.items.map(item => item.name.toLowerCase()));
  const signals = [];
  const has = regex => names.some(name => regex.test(name));
  const dep = regex => dependencyNames.some(name => regex.test(name));
  const add = (label, detail, basis) => signals.push({ label, detail, basis });
  if (dep(/^react$|react-dom/) || has(/^react\.config/)) add("React", "component UI runtime", "package manifest");
  if (dep(/^next$|nextjs/) || has(/^next\.config/)) add("Next.js", "React application framework", "package manifest / config");
  if (dep(/^vue$|vue-router/) || has(/^vue\.config/)) add("Vue", "frontend framework", "package manifest / config");
  if (dep(/^svelte$|@sveltejs/) || has(/^svelte\.config/)) add("Svelte", "component compiler", "package manifest / config");
  if (dep(/^vite$/) || has(/^vite\.config/)) add("Vite", "frontend build tool", "package manifest / config");
  if (dep(/express|fastify|koa|hono/)) add("Node server", "server runtime signal", "package manifest");
  if (dep(/django|flask|fastapi/)) add("Python web", "web framework signal", "package manifest");
  if (dep(/tailwindcss/) || has(/^tailwind\.config/)) add("Tailwind", "utility CSS system", "package manifest / config");
  if (has(/^dockerfile$|^docker-compose/)) add("Docker", "containerization", "repository file");
  if (paths.some(path => /^\.github\/workflows\//.test(path))) add("GitHub Actions", "CI/CD workflows", "workflow files");
  if (has(/^terraform|\.tf$/)) add("Terraform", "infrastructure as code", "repository files");
  if (has(/^storybook|\.storybook$/)) add("Storybook", "component workbench", "repository files");
  return signals.slice(0, 12);
}

function buildDimensions(a) {
  const coverage = a.languageTotal ? 1 : 0;
  const tech = clamp(Math.round((a.dominantShare * 62 + Math.min(1, a.indicators.length / 5) * 38) * coverage));
  const architecture = clamp(Math.round(Math.min(1, a.folderCount / 26) * 58 + Math.min(1, a.maxDepth / 8) * 27 + (a.rootFiles.length > 2 ? 15 : 0)));
  const activity = clamp(Math.round(Math.min(1, a.commitsPerWeek / 12) * 100));
  const dependency = clamp(Math.round(Math.min(1, a.dependencyCount / 36) * 72 + Math.min(1, a.manifestData.length / 3) * 28));
  const documentation = clamp(Math.round((a.readme ? 42 : 0) + (a.docsDir ? 28 : 0) + Math.min(30, a.markdownCount * 4)));
  const testing = clamp(Math.round((a.testPaths.length ? 54 : 0) + (a.testConfig.length ? 26 : 0) + Math.min(20, a.testPaths.length * 2)));
  const evolution = clamp(Math.round((a.ageYears === null ? 0 : Math.min(36, a.ageYears * 9)) + Math.min(39, a.commitsPerWeek * 4) + Math.min(25, (a.releaseCount + a.tagsCount) * 3)));
  const collaboration = clamp(Math.round(Math.min(55, a.contributorCount * 9) + Math.min(25, a.branchCount * 2) + (a.topContributorShare === null ? 0 : Math.max(0, 20 - a.topContributorShare * 20))));
  return [
    { id: "technology", label: "Technology", short: a.dominantLanguage, score: tech, type: "calculated", inputs: [`${a.languageEntries.length || 0} language buckets`, `${a.indicators.length} toolchain indicators`, a.dominantLanguage === "Unknown" ? "language endpoint unavailable" : `${percent(a.dominantShare * 100)} ${a.dominantLanguage}`], formula: "dominant language share + detected stack signals", caveat: "Language bytes come from GitHub's language classifier; a language mix is not a maintainability rating." },
    { id: "architecture", label: "Architecture", short: `${a.folderCount} folders`, score: architecture, type: "calculated", inputs: [`${a.fileCount} files observed`, `${a.maxDepth} max path depth`, `${a.rootFiles.length} root files`], formula: "directory breadth + path depth + root surface", caveat: "Topology is a structural proxy. It does not understand runtime boundaries or module quality." },
    { id: "activity", label: "Activity", short: `${a.commitsPerWeek.toFixed(1)} / wk`, score: activity, type: "calculated", inputs: [`${a.commits.length} latest commits sampled`, a.sampleDays ? `${Math.round(a.sampleDays)} day sample span` : "sample span unavailable", `last push ${relativeDate(a.recentCommitDate)}`], formula: "sampled commits normalized to a 12-per-week reference", caveat: "This is a recent sample, not the repository's lifetime commit rate." },
    { id: "dependency", label: "Dependency", short: `${a.dependencyCount} declared`, score: dependency, type: "observed", inputs: [`${a.manifestData.length} manifests read`, `${a.dependencyCount} names parsed`, a.manifests.length ? `${a.manifests.length} manifest files found` : "no known manifest found"], formula: "declared dependency count + manifest coverage", caveat: "Lockfiles and optional groups can change what is visible. Names are read from public manifest text." },
    { id: "documentation", label: "Documentation", short: a.readme ? "README found" : "README missing", score: documentation, type: "observed", inputs: [a.readme ? `README: ${a.readme}` : "no README detected", a.docsDir ? "docs directory found" : "no docs directory detected", `${a.markdownCount} Markdown / markup files`], formula: "README + docs directory + markup file presence", caveat: "Presence is observable; content quality is deliberately not scored." },
    { id: "testing", label: "Testing", short: a.testPaths.length ? `${a.testPaths.length} test paths` : "no test paths", score: testing, type: "observed", inputs: [`${a.testPaths.length} test-like paths`, `${a.testConfig.length} test configs`, `${a.workflowCount} workflow files`], formula: "test paths + test configuration signals", caveat: "File naming reveals intent, not test coverage or whether tests pass." },
    { id: "evolution", label: "Evolution", short: a.ageYears === null ? "age unavailable" : `${a.ageYears.toFixed(1)} years`, score: evolution, type: "inferred", inputs: [a.created ? `created ${formatShortDate(a.created)}` : "creation date unavailable", `${a.releaseCount} releases / ${a.tagsCount} tags returned`, a.sampleDays ? `${Math.round(a.sampleDays)} days of recent commits` : "commit sample span unavailable"], formula: "repository age + sampled cadence + public markers", caveat: "Historical growth is opt-in because GitHub may defer its statistics endpoint." },
    { id: "collaboration", label: "Collaboration", short: `${a.contributorCount} contributors`, score: collaboration, type: "calculated", inputs: [`${a.contributorCount} contributor rows returned`, `${a.branchCount} branch rows returned`, a.topContributorShare === null ? "contribution share unavailable" : `top visible contributor: ${percent(a.topContributorShare * 100)}`], formula: "visible contributors + branch surface + contribution spread", caveat: "GitHub paginates contributors and anonymous contributions can be incomplete." },
  ];
}

function renderAll() {
  renderRepoHeader(); renderWarnings(); renderStats(); renderSignature(); renderEvidence(); renderExplorer(); renderEvolution(); updateRateBadge();
}
function renderRepoHeader() {
  const repo = state.repo, a = state.analysis;
  $("#repo-breadcrumb").textContent = `${state.owner}/${state.name}`;
  $("#repo-title").textContent = repo.name;
  $("#repo-description").textContent = repo.description || "No public description supplied.";
  $("#repo-avatar").textContent = (repo.name || "R").slice(0, 1).toUpperCase();
  $("#scan-timestamp").textContent = new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
  $("#last-push").textContent = relativeDate(repo.pushed_at);
  const chips = [repo.language, repo.license?.spdx_id, repo.default_branch ? `branch:${repo.default_branch}` : null, repo.archived ? "archived" : null].filter(Boolean);
  $("#repo-chips").innerHTML = chips.map((chip, i) => `<span class="chip ${i === 0 ? "accent" : ""}">${esc(chip)}</span>`).join("") || `<span class="chip">metadata incomplete</span>`;
}
function renderWarnings() {
  const warnings = [...state.warnings];
  if (!state.analysis.languageTotal) warnings.push("Language statistics were unavailable; technology mix is shown as incomplete.");
  if (!state.manifestData.length && state.manifests.length) warnings.push("Manifest files were found but could not be read from the public raw endpoint.");
  $("#warning-stack").innerHTML = warnings.length ? warnings.map(text => `<div class="warning"><b>NOTE</b>${esc(text)}</div>`).join("") : "";
}
function renderStats() {
  const a = state.analysis, repo = state.repo;
  const stats = [
    ["FILES OBSERVED", number(a.fileCount), `${a.totalBytes ? formatBytes(a.totalBytes) : "tree sizes unavailable"} · GitHub size ${repo.size ? formatBytes(repo.size * 1024) : "—"}`],
    ["PRIMARY LANGUAGE", a.dominantLanguage, a.languageTotal ? `${percent(a.dominantShare * 100)} of classified bytes` : "not returned"],
    ["COMMIT SAMPLE", number(state.commits.length), a.sampleDays ? `${Math.round(a.sampleDays)} day window` : "public sample"],
    ["REPOSITORY AGE", a.ageYears === null ? "—" : `${a.ageYears.toFixed(1)} yr`, repo.created_at ? `created ${formatShortDate(repo.created_at)}` : "date unavailable"],
    ["LICENSE", repo.license?.spdx_id || (a.hasLicense ? "file found" : "not detected"), repo.archived ? "archived repository" : `${number(repo.stargazers_count)} stars · ${number(repo.forks_count)} forks`],
  ];
  $("#stat-strip").innerHTML = stats.map(([label, value, note]) => `<div class="stat-cell"><span class="stat-label">${esc(label)}</span><strong class="stat-value">${esc(value)}</strong><span class="stat-note">${esc(note)}</span></div>`).join("");
}

function radarPoint(cx, cy, radius, index, count, value) {
  const angle = -Math.PI / 2 + index * (Math.PI * 2 / count);
  const r = radius * value / 100;
  return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
}
function renderSignature() {
  const svg = $("#dna-chart"), dims = state.dimensions, count = dims.length, cx = 340, cy = 270, radius = 190;
  const lines = [];
  for (let ring = 1; ring <= 4; ring++) {
    const pts = Array.from({length: count}, (_, i) => radarPoint(cx, cy, radius * ring / 4, i, count, 100));
    lines.push(`<polygon points="${pts.map(p => p.join(",")).join(" ")}" fill="none" stroke="rgba(151,172,207,.16)" stroke-width="1" />`);
  }
  dims.forEach((dim, i) => {
    const [x, y] = radarPoint(cx, cy, radius, i, count, 100);
    lines.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="rgba(151,172,207,.14)" stroke-width="1" />`);
    const angle = -Math.PI / 2 + i * (Math.PI * 2 / count); const tx = cx + Math.cos(angle) * (radius + 35); const ty = cy + Math.sin(angle) * (radius + 35);
    const anchor = Math.abs(tx - cx) < 10 ? "middle" : tx < cx ? "end" : "start";
    lines.push(`<text x="${tx}" y="${ty}" fill="#8795ad" font-size="10" font-family="SFMono-Regular,Consolas,monospace" letter-spacing="1.2" text-anchor="${anchor}" dominant-baseline="middle">${esc(dim.label.toUpperCase())}</text>`);
  });
  const points = dims.map((dim, i) => radarPoint(cx, cy, radius, i, count, dim.score));
  lines.push(`<polygon points="${points.map(p => p.join(",")).join(" ")}" fill="rgba(98,228,242,.15)" stroke="#62e4f2" stroke-width="2" stroke-linejoin="round" />`);
  dims.forEach((dim, i) => {
    const [x, y] = points[i]; const [ax, ay] = radarPoint(cx, cy, radius, i, count, 100);
    lines.push(`<line x1="${x}" y1="${y}" x2="${ax}" y2="${ay}" stroke="rgba(98,228,242,.16)" stroke-dasharray="2 4" />`);
    lines.push(`<g class="radar-node" data-dimension="${dim.id}" tabindex="0" role="button" aria-label="Inspect ${esc(dim.label)} dimension"><circle cx="${x}" cy="${y}" r="7" fill="#08121f" stroke="${dim.type === "observed" ? "#62e4f2" : dim.type === "inferred" ? "#b7ed73" : "#a98cff"}" stroke-width="2"/><circle cx="${x}" cy="${y}" r="3" fill="${dim.type === "observed" ? "#62e4f2" : dim.type === "inferred" ? "#b7ed73" : "#a98cff"}"/><title>${esc(dim.label)} · ${dim.score}/100 signal</title></g>`);
  });
  lines.push(`<circle cx="${cx}" cy="${cy}" r="33" fill="rgba(8,13,24,.91)" stroke="rgba(98,228,242,.35)"/><text x="${cx}" y="${cy - 2}" text-anchor="middle" fill="#edf3ff" font-size="10" font-family="SFMono-Regular,Consolas,monospace" letter-spacing="1.2">DNA</text><text x="${cx}" y="${cy + 12}" text-anchor="middle" fill="#52627c" font-size="8" font-family="SFMono-Regular,Consolas,monospace">SIGNAL</text>`);
  svg.innerHTML = `<title id="dna-chart-title">Repository DNA signature</title><desc id="dna-chart-desc">Eight normalized signals. This is not a quality score.</desc>${lines.join("")}`;
  $("#dimension-list").innerHTML = dims.map(dim => `<div class="dimension-item" data-dimension="${dim.id}" tabindex="0" role="button"><span class="dimension-dot"></span><div><span class="dimension-name">${esc(dim.label)}</span><span class="dimension-signal">${esc(dim.short)}</span></div><strong class="dimension-value">${dim.score}</strong></div>`).join("");
  bindDimensionEvents();
  showDimension(dims[0].id);
}
function bindDimensionEvents() {
  $$('[data-dimension]').forEach(el => { el.addEventListener("click", () => showDimension(el.dataset.dimension)); el.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showDimension(el.dataset.dimension); } }); });
}
function showDimension(id) {
  const dim = state.dimensions.find(item => item.id === id); if (!dim) return;
  $$(".dimension-item").forEach(item => item.classList.toggle("active", item.dataset.dimension === id));
  const drawer = $("#insight-drawer");
  drawer.innerHTML = `<span class="drawer-kicker">${esc(dim.type.toUpperCase())} SIGNAL / ${dim.score} OF 100</span><h3 class="drawer-title">${esc(dim.label)}</h3><p>${esc(dim.caveat)}</p><div class="drawer-tags">${dim.inputs.map(input => `<span class="drawer-tag">${esc(input)}</span>`).join("")}</div><p class="muted-note" style="margin-top:10px">Formula: ${esc(dim.formula)}</p>`;
}

function renderEvidence() {
  const a = state.analysis, repo = state.repo;
  const cards = [
    ["OBSERVED / TREE", a.fileCount ? number(a.fileCount) : "—", a.totalBytes ? `${formatBytes(a.totalBytes)} returned in file sizes` : "file sizes unavailable", a.fileCount ? "returned" : "incomplete"],
    ["OBSERVED / ACTIVITY", state.commits.length ? number(state.commits.length) : "—", a.sampleDays ? `latest sample spans ${Math.round(a.sampleDays)} days` : "commit dates unavailable", state.commits.length ? "sampled" : "unavailable"],
    ["CALCULATED / CADENCE", a.commitsPerWeek ? `${a.commitsPerWeek.toFixed(1)}/wk` : "—", "from the returned commit sample", a.sampleDays ? "derived" : "needs dates"],
    ["INFERRED / SURFACE", a.indicators.length ? `${a.indicators.length} signals` : "none", "toolchain patterns from names + manifests", a.indicators.length ? "inferred" : "no signal"],
  ];
  $("#evidence-grid").innerHTML = cards.map(([label, value, note, status]) => `<article class="evidence-card"><span class="evidence-label">${esc(label)}</span><strong>${esc(value)}</strong><p>${esc(note)}</p><span class="evidence-status">● ${esc(status)}</span></article>`).join("");
}

function buildTreeModel(files) {
  const root = { name: "", folders: new Map(), files: [] };
  files.forEach(file => {
    const parts = file.path.split("/"); let node = root;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) node.files.push({ ...file, name: part });
      else { if (!node.folders.has(part)) node.folders.set(part, { name: part, folders: new Map(), files: [] }); node = node.folders.get(part); }
    });
  });
  return root;
}
function renderTree() {
  const query = ($( "#tree-search").value || "").toLowerCase().trim();
  const files = query ? state.files.filter(file => file.path.toLowerCase().includes(query)) : state.files;
  $("#tree-count").textContent = `${number(files.length)} files`;
  const root = buildTreeModel(files);
  const renderNode = (node, depth = 0) => {
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    const filesHere = node.files.sort((a, b) => a.name.localeCompare(b.name));
    return [...folders.map(folder => `<details class="tree-group" ${depth < (query ? 4 : 1) ? "open" : ""}><summary><span class="tree-folder-name">${esc(folder.name)}/</span></summary><div class="tree-children">${renderNode(folder, depth + 1)}</div></details>`), ...filesHere.map(file => `<div class="tree-file"><span class="tree-file-name" title="${esc(file.path)}">${esc(file.name)}</span><span class="tree-file-size">${formatBytes(file.size)}</span></div>`)].join("");
  };
  $("#file-tree").innerHTML = files.length ? renderNode(root) : `<div class="empty">No paths match this filter.</div>`;
}
function renderExplorer() {
  const a = state.analysis;
  $("#tree-meta").textContent = `${number(a.fileCount)} files · ${number(a.folderCount)} folders · ${formatBytes(a.totalBytes)} returned`;
  renderTree();
  const largestFiles = state.files.slice().sort((x, y) => y.size - x.size).slice(0, 8);
  const largestSize = largestFiles[0]?.size || 1;
  $("#largest-files").innerHTML = largestFiles.map((file, i) => `<div class="rank-row"><span class="rank-number">${String(i + 1).padStart(2, "0")}</span><div class="rank-file"><span class="rank-name" title="${esc(file.path)}">${esc(file.path)}</span><span class="rank-bar"><i style="width:${Math.max(3, file.size / largestSize * 100)}%"></i></span></div><span class="rank-size">${formatBytes(file.size)}</span></div>`).join("") || `<div class="empty">File sizes were not returned.</div>`;
  const languageEntries = a.languageEntries.slice(0, 8);
  $("#language-bars").innerHTML = languageEntries.length ? languageEntries.map(([language, bytes]) => `<div class="language-row"><div class="language-label"><span>${esc(language)}</span><b>${percent(bytes / a.languageTotal * 100)}</b></div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, bytes / a.languageTotal * 100)}%"></div></div></div>`).join("") : `<div class="empty">GitHub did not return language byte counts.</div>`;
  $("#signals-list").innerHTML = [...a.indicators.map(signal => `<div class="signal-item"><b><i></i>${esc(signal.label)}</b><span>${esc(signal.detail)} · ${esc(signal.basis)}</span></div>`), ...a.configFiles.slice(0, 10).map(path => `<div class="signal-item"><b><i></i>${esc(path.split("/").pop())}</b><span>configuration file · ${esc(path)}</span></div>`)].slice(0, 12).join("") || `<div class="empty">No known toolchain or configuration indicators were detected.</div>`;
  $("#dependencies-list").innerHTML = a.dependencyGroups.length ? a.dependencyGroups.map(group => `<div class="dependency-group"><span class="dependency-manifest">${esc(group.path)}</span><span class="dependency-count">${number(group.items.length)} parsed names</span><div class="dependency-tags">${(group.items.length ? group.items : [{name:"manifest present; no names parsed"}]).slice(0, 12).map(item => `<span class="dep-tag">${esc(item.name)}</span>`).join("")}</div></div>`).join("") : `<div class="empty">No supported package manifest was readable in the returned tree.</div>`;
}

function renderEvolution() {
  const a = state.analysis, repo = state.repo;
  $("#commit-sample-note").textContent = state.commits.length ? `${number(state.commits.length)} latest public commits · ${a.sampleDays ? `${Math.round(a.sampleDays)} day span` : "dates incomplete"}` : "No commit sample returned.";
  renderCommitTimeline();
  const milestones = [
    repo.created_at ? ["Repository born", formatDate(repo.created_at), "observed creation timestamp"] : null,
    repo.pushed_at ? ["Latest public push", `${formatDate(repo.pushed_at)} · ${relativeDate(repo.pushed_at)}`, "observed repository metadata"] : null,
    repo.default_branch ? ["Default branch", repo.default_branch, "observed repository metadata"] : null,
    a.branchCount ? ["Branch rows", number(a.branchCount), "public branch rows returned (paginated)" ] : null,
    a.dominantLanguage !== "Unknown" ? ["Language snapshot", a.dominantLanguage, "historical language changes are not requested from the public API"] : null,
    repo.license?.spdx_id ? ["License", repo.license.spdx_id, "observed repository metadata"] : a.hasLicense ? ["License marker", "file detected", "path observation only"] : null,
    state.releases[0] ? ["Latest release", state.releases[0].tag_name || state.releases[0].name || "untitled", state.releases[0].published_at ? formatDate(state.releases[0].published_at) : "date unavailable"] : null,
  ].filter(Boolean);
  $("#milestones").innerHTML = milestones.length ? milestones.map(([title, value, note]) => `<div class="milestone"><i></i><div><b>${esc(title)} <span style="color:var(--cyan)">${esc(value)}</span></b><span>${esc(note)}</span></div></div>`).join("") : `<div class="empty">No public milestones were returned.</div>`;
  $("#growth-status").textContent = "not loaded";
  $("#growth-chart").innerHTML = `<div class="deferred-state"><span class="deferred-icon">⌁</span><span>Request historical additions and deletions when you want the deeper read.</span></div>`;
}
function renderCommitTimeline() {
  const container = $("#commit-timeline"), commits = state.commits.map(commit => ({ date: commit.commit?.author?.date || commit.commit?.committer?.date, message: commit.commit?.message?.split("\n")[0] || "commit", author: commit.author?.login || commit.commit?.author?.name || "unknown" })).filter(item => item.date).sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!commits.length) { container.innerHTML = `<div class="empty">Commit dates were not returned by GitHub.</div>`; return; }
  const min = new Date(commits[0].date).getTime(), max = new Date(commits[commits.length - 1].date).getTime(), span = Math.max(1, max - min), width = 780, height = 155;
  const dots = commits.map((commit, index) => { const x = 20 + ((new Date(commit.date).getTime() - min) / span) * (width - 40); const y = 80 - Math.min(48, (index % 5) * 8); return `<circle cx="${x.toFixed(1)}" cy="${y}" r="${index % 9 === 0 ? 3.8 : 2.5}" fill="#62e4f2" opacity="${index % 9 === 0 ? .95 : .52}"><title>${esc(formatDate(commit.date))} · ${esc(commit.message)} · ${esc(commit.author)}</title></circle>`; }).join("");
  const start = formatShortDate(commits[0].date), end = formatShortDate(commits[commits.length - 1].date);
  container.innerHTML = `<svg class="timeline-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Recent commit timeline"><line x1="20" y1="80" x2="760" y2="80" stroke="rgba(151,172,207,.25)"/><line x1="20" y1="35" x2="20" y2="121" stroke="rgba(151,172,207,.12)"/><line x1="760" y1="35" x2="760" y2="121" stroke="rgba(151,172,207,.12)"/>${dots}<text x="20" y="143" fill="#52627c" font-size="10" font-family="SFMono-Regular,Consolas,monospace">${esc(start)}</text><text x="760" y="143" text-anchor="end" fill="#52627c" font-size="10" font-family="SFMono-Regular,Consolas,monospace">${esc(end)}</text></svg>`;
}

async function loadChurn() {
  const button = $("#load-churn"); button.disabled = true; button.textContent = "Reading commits…";
  try {
    const commits = state.commits.slice(0, 15);
    if (!commits.length) throw new Error("No recent commits were returned.");
    const details = await Promise.all(commits.map(commit => githubFetch(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.name)}/commits/${encodeURIComponent(commit.sha)}`).catch(() => null)));
    const areaCounts = new Map(); let seen = 0;
    details.filter(Boolean).forEach(detail => (detail.files || []).forEach(file => { const parts = file.filename.split("/"); const area = parts.length > 1 ? `${parts[0]}/` : parts[0]; areaCounts.set(area, (areaCounts.get(area) || 0) + 1); seen++; }));
    state.churn = [...areaCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (!state.churn.length) throw new Error("GitHub returned no file lists for the sampled commits.");
    const max = state.churn[0][1];
    $("#churn-content").innerHTML = `<div class="muted-note" style="margin-bottom:16px">Derived from file lists attached to ${details.filter(Boolean).length} of the latest ${commits.length} commits. Areas are top-level path buckets, not a lifetime history.</div><div class="churn-chart">${state.churn.map(([area, count]) => `<div class="churn-column"><div class="churn-bar-wrap"><div class="churn-bar" style="height:${Math.max(4, count / max * 100)}%" title="${count} changed files"></div></div><strong title="${esc(area)}">${esc(area)}</strong><span>${number(count)} file hits</span></div>`).join("")}</div>`;
    button.textContent = "Loaded";
  } catch (error) {
    $("#churn-content").innerHTML = `<div class="warning"><b>NOTE</b>${esc(error.message || "File-level churn could not be loaded.")} No change surface has been invented.</div>`;
    button.disabled = false; button.textContent = "Retry file churn";
  }
  updateRateBadge();
}

async function loadGrowth() {
  const button = $("#load-growth"), status = $("#growth-status"); button.disabled = true; button.textContent = "Requesting stats…"; status.textContent = "loading";
  try {
    const result = await githubStatsFetch(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.name)}/stats/code_frequency`);
    if (result.deferred || !Array.isArray(result.data) || !result.data.length) {
      status.textContent = "GitHub deferred";
      $("#growth-chart").innerHTML = `<div class="warning"><b>NOTE</b>GitHub has not prepared historical code-frequency statistics for this repository yet. RepoDNA leaves this chart empty rather than estimating growth.</div>`;
      button.disabled = false; button.textContent = "Retry growth history"; updateRateBadge(); return;
    }
    state.growth = result.data;
    renderGrowth(result.data);
    status.textContent = `${result.data.length} weeks returned`; button.disabled = false; button.textContent = "Reload growth history";
  } catch (error) {
    status.textContent = "unavailable"; $("#growth-chart").innerHTML = `<div class="warning"><b>NOTE</b>${esc(error.message || "Historical code growth could not be loaded.")} No value was invented.</div>`; button.disabled = false; button.textContent = "Retry growth history";
  }
  updateRateBadge();
}
function renderGrowth(data) {
  const points = data.slice(-52).map(item => ({ date: new Date(item[0] * 1000), add: item[1] || 0, del: Math.abs(item[2] || 0) }));
  const max = Math.max(1, ...points.map(item => Math.max(item.add, item.del))); const width = 820, height = 190; const barWidth = (width - 40) / Math.max(1, points.length);
  const bars = points.map((item, i) => { const x = 20 + i * barWidth; const ah = item.add / max * 120, dh = item.del / max * 120; return `<rect x="${x.toFixed(1)}" y="${138 - ah}" width="${Math.max(1, barWidth - 1)}" height="${Math.max(1, ah)}" rx="1" fill="rgba(98,228,242,.72)"><title>${esc(formatShortDate(item.date))}: +${number(item.add)} additions</title></rect><rect x="${x.toFixed(1)}" y="${142}" width="${Math.max(1, barWidth - 1)}" height="${Math.max(1, dh)}" rx="1" fill="rgba(169,140,255,.56)"><title>${esc(formatShortDate(item.date))}: -${number(item.del)} deletions</title></rect>`; }).join("");
  const first = points[0]?.date, last = points[points.length - 1]?.date;
  $("#growth-chart").innerHTML = `<div class="muted-note" style="margin-bottom:7px"><span style="color:var(--cyan)">■ additions</span> &nbsp; <span style="color:var(--violet)">■ deletions</span> · last ${points.length} weeks returned</div><svg class="growth-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Weekly code additions and deletions">${bars}<line x1="20" y1="140" x2="800" y2="140" stroke="rgba(151,172,207,.25)"/><text x="20" y="181" fill="#52627c" font-size="10" font-family="SFMono-Regular,Consolas,monospace">${esc(formatShortDate(first))}</text><text x="800" y="181" text-anchor="end" fill="#52627c" font-size="10" font-family="SFMono-Regular,Consolas,monospace">${esc(formatShortDate(last))}</text></svg>`;
}

function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function chartSvgString() {
  const svg = $("#dna-chart").cloneNode(true); svg.setAttribute("xmlns", "http://www.w3.org/2000/svg"); svg.setAttribute("width", "1200"); svg.setAttribute("height", "990"); return `<?xml version="1.0" encoding="UTF-8"?>${new XMLSerializer().serializeToString(svg)}`;
}
function exportSvg() { downloadBlob(new Blob([chartSvgString()], {type: "image/svg+xml;charset=utf-8"}), `${slug(state.owner + "-" + state.name)}-reprodna.svg`); }
function exportPng() {
  const svgText = chartSvgString(); const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 990; const ctx = canvas.getContext("2d"); ctx.fillStyle = "#0a111e"; ctx.fillRect(0, 0, canvas.width, canvas.height); const image = new Image(); image.onload = () => { ctx.drawImage(image, 0, 0); canvas.toBlob(blob => downloadBlob(blob, `${slug(state.owner + "-" + state.name)}-reprodna.png`), "image/png"); }; image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
}
async function copyShare() {
  const url = new URL(window.location.href); url.searchParams.set("repo", `${state.owner}/${state.name}`); const text = url.toString();
  try { await navigator.clipboard.writeText(text); } catch { window.prompt("Copy this shareable analysis URL", text); }
  [$("#copy-share"), $("#copy-share-2")].forEach(button => { const original = button.innerHTML; button.textContent = "✓ Copied"; setTimeout(() => button.innerHTML = original, 1400); });
}

els.form.addEventListener("submit", event => { event.preventDefault(); clearLandingError(); let parsed; try { parsed = parseRepoInput(els.input.value); } catch (error) { showLandingError(error.message); els.input.focus(); return; } scanRepository(parsed); });
$(".example-repo").addEventListener("click", () => { els.input.value = "vercel/next.js"; els.input.focus(); });
$("#new-scan").addEventListener("click", () => { state.scanId++; closeError(); showLanding(); els.input.value = ""; window.scrollTo({top:0, behavior:"smooth"}); });
$("#cancel-scan").addEventListener("click", () => { state.scanId++; showLanding(); });
$("#close-error").addEventListener("click", closeError); $("#try-again").addEventListener("click", () => { closeError(); showLanding(); els.input.focus(); });
$("#tree-search").addEventListener("input", renderTree); $("#load-churn").addEventListener("click", loadChurn); $("#load-growth").addEventListener("click", loadGrowth); $("#export-svg").addEventListener("click", exportSvg); $("#export-png").addEventListener("click", exportPng); $("#copy-share").addEventListener("click", copyShare); $("#copy-share-2").addEventListener("click", copyShare);
window.addEventListener("keydown", event => { if (event.key === "Escape") closeError(); });

const initialRepo = new URLSearchParams(window.location.search).get("repo");
if (initialRepo) { els.input.value = initialRepo; try { scanRepository(parseRepoInput(initialRepo)); } catch (error) { showLandingError(error.message); } }
