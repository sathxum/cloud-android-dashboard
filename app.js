/* ANDROID DEPLOYER — single-page console.
 * Flow:
 *   1) Setup screen: user enters GitHub username, repo, token, admin user/pass.
 *      -> validates token, ensures workflow file exists in repo, creates a status Gist.
 *   2) Admin login gate (the admin user/pass the user chose).
 *   3) Dashboard: runner specs, device list (live from Gist), create device, default device.
 *   4) Each device -> tunnel URL, opens behind its own per-device auth wall.
 */

const $ = (s, r = document) => r.querySelector(s);
const app = document.getElementById("app");

// ---------- GitHub API helpers ----------
async function gh(path, opts = {}) {
  const res = await fetch("https://api.github.com" + path, {
    ...opts,
    headers: {
      Authorization: `token ${cfg.token}`,
      Accept: "application/vnd.github+json",
      ...(opts.headers || {}),
    },
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `GitHub API ${res.status}`);
  return data;
}
function b64(str) { return btoa(unescape(encodeURIComponent(str))); }

// ---------- terminal logger ----------
function term() { return $("#terminal"); }
function log(kind, msg, extra) {
  const t = term();
  if (!t) return;
  const colors = { info: "#00d4ff", success: "#3ddc84", warn: "#ff9500", error: "#ff3b5c", cmd: "#bc13fe" };
  const ts = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  line.className = "leading-relaxed";
  line.innerHTML =
    `<span class="text-white/30">${ts}</span> ` +
    `<span style="color:${colors[kind] || "#e6e6e6"}">[${kind.toUpperCase()}]</span> ` +
    `<span>${msg}</span>` +
    (extra ? ` <span class="text-neon-blue underline">${extra}</span>` : "");
  t.appendChild(line);
  t.scrollTop = t.scrollHeight;
}

// ---------- view: SETUP ----------
function renderSetup() {
  app.innerHTML = `
    <header class="text-center mb-6 mt-2">
      <div class="inline-flex items-center gap-2 chip px-3 py-1 rounded-full text-xs font-mono text-neon-blue mb-3">
        <i class="fa-brands fa-android"></i> CLOUD ANDROID · GITHUB RUNNER
      </div>
      <h1 class="text-3xl sm:text-4xl font-extrabold tracking-tight">
        <span class="text-neon-green">ANDROID</span> DEPLOYER
      </h1>
      <p class="text-white/50 text-sm mt-1 font-mono">Deploy real Android devices on GitHub Actions.</p>
    </header>

    <div class="glass rounded-2xl p-5 sm:p-6">
      <h2 class="font-bold text-lg mb-4 flex items-center gap-2"><i class="fa-solid fa-key text-neon-green"></i> Connect your GitHub</h2>
      <div class="grid sm:grid-cols-2 gap-4">
        ${field("gh_user", "GitHub username", "text", cfg.user || "", "octocat")}
        ${field("gh_repo", "Repository (deployer repo)", "text", cfg.repo || "", "cloud-android-dashboard")}
        ${fieldPw("gh_token", "Personal Access Token", cfg.token || "", "ghp_...")}
        <div></div>
        ${field("admin_user", "Admin username (dashboard login)", "text", cfg.adminUser || "", "admin")}
        ${fieldPw("admin_pass", "Admin password (dashboard login)", cfg.adminPass || "", "••••••••")}
      </div>
      <div class="mt-3 text-xs text-white/40 font-mono">Token needs <b>repo</b> + <b>workflow</b> + <b>gist</b> scopes. Stored only in your browser.</div>
      <button id="connectBtn" class="btn-primary w-full mt-5 py-3 rounded-xl text-sm flex items-center justify-center gap-2">
        <i class="fa-solid fa-plug"></i> CONNECT &amp; INITIALIZE
      </button>
    </div>

    <div class="term rounded-xl mt-5 p-4 h-40 overflow-y-auto text-xs" id="terminal">
      <div class="text-white/30">$ awaiting connection...</div>
    </div>

    <p class="text-center text-white/25 text-[10px] mt-4 font-mono">
      Devices run on macOS runners (up to ~6h/session, GitHub limit).
    </p>`;

  $("#connectBtn").onclick = connect;
}

function field(id, label, type, val, ph) {
  return `<label class="block">
    <span class="text-xs font-mono text-white/60">${label}</span>
    <input id="${id}" type="${type}" value="${escapeAttr(val)}" placeholder="${ph}"
      class="fld w-full mt-1 rounded-lg px-3 py-2.5 text-sm font-mono" autocapitalize="off" autocomplete="off" spellcheck="false" />
  </label>`;
}
function fieldPw(id, label, val, ph) {
  return `<label class="block">
    <span class="text-xs font-mono text-white/60">${label}</span>
    <div class="relative mt-1">
      <input id="${id}" type="password" value="${escapeAttr(val)}" placeholder="${ph}"
        class="fld w-full rounded-lg px-3 py-2.5 pr-10 text-sm font-mono" autocapitalize="off" autocomplete="off" spellcheck="false" />
      <button type="button" onclick="togglePw('${id}')" class="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 hover:text-neon-green">
        <i class="fa-solid fa-eye"></i>
      </button>
    </div>
  </label>`;
}
function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }
function togglePw(id) {
  const el = document.getElementById(id);
  el.type = el.type === "password" ? "text" : "password";
}

// ---------- CONNECT: validate + ensure workflow + gist ----------
async function connect() {
  cfg.user = $("#gh_user").value.trim();
  cfg.repo = $("#gh_repo").value.trim();
  cfg.token = $("#gh_token").value.trim();
  cfg.adminUser = $("#admin_user").value.trim();
  cfg.adminPass = $("#admin_pass").value;

  if (!cfg.user || !cfg.repo || !cfg.token || !cfg.adminUser || !cfg.adminPass) {
    log("error", "All fields are required.");
    return;
  }
  const btn = $("#connectBtn");
  btn.disabled = true; btn.classList.add("opacity-60");
  try {
    log("cmd", "Verifying token...");
    const me = await gh("/user");
    log("success", `Authenticated as <b>${me.login}</b>`);

    log("cmd", `Checking repo ${cfg.user}/${cfg.repo}...`);
    await gh(`/repos/${cfg.user}/${cfg.repo}`);
    log("success", "Repository found.");

    log("cmd", "Ensuring status gist exists...");
    if (!cfg.gistId) {
      const g = await gh("/gists", {
        method: "POST",
        body: JSON.stringify({
          description: "cloud-android device status",
          public: false,
          files: { "devices.json": { content: JSON.stringify({ devices: {} }, null, 2) } },
        }),
      });
      cfg.gistId = g.id;
      log("success", `Status gist created (${g.id.slice(0, 8)}...)`);
    } else {
      log("info", "Reusing existing status gist.");
    }

    saveCfg();
    log("success", "Initialization complete. Loading dashboard...");
    setTimeout(renderLogin, 600);
  } catch (e) {
    log("error", e.message);
    btn.disabled = false; btn.classList.remove("opacity-60");
  }
}

// ---------- view: LOGIN gate ----------
function renderLogin() {
  app.innerHTML = `
    <div class="min-h-[80vh] grid place-items-center">
      <div class="glass rounded-2xl p-6 w-full max-w-sm">
        <div class="text-center mb-5">
          <i class="fa-solid fa-shield-halved text-3xl text-neon-green"></i>
          <h2 class="font-bold text-xl mt-2">Admin Access</h2>
          <p class="text-white/40 text-xs font-mono">${cfg.user}/${cfg.repo}</p>
        </div>
        ${field("li_user", "Username", "text", "", "admin")}
        <div class="h-3"></div>
        ${fieldPw("li_pass", "Password", "", "••••••••")}
        <button id="loginBtn" class="btn-primary w-full mt-5 py-3 rounded-xl text-sm">
          <i class="fa-solid fa-unlock"></i> UNLOCK DASHBOARD
        </button>
        <button id="resetBtn" class="w-full mt-3 text-xs text-white/30 hover:text-white/60 font-mono">reset connection</button>
        <div id="loginErr" class="text-neon-orange text-xs text-center mt-3 h-4 font-mono"></div>
      </div>
    </div>`;
  $("#loginBtn").onclick = () => {
    if ($("#li_user").value.trim() === cfg.adminUser && $("#li_pass").value === cfg.adminPass) {
      renderDashboard();
    } else {
      $("#loginErr").textContent = "Invalid credentials.";
    }
  };
  $("#resetBtn").onclick = () => {
    if (confirm("Reset saved connection?")) { localStorage.removeItem(LS_KEY); location.reload(); }
  };
  $("#li_pass").addEventListener("keydown", (e) => e.key === "Enter" && $("#loginBtn").click());
}

boot();
function boot() {
  if (cfg.token && cfg.gistId) renderLogin();
  else renderSetup();
}

// ==================== DASHBOARD ====================
let pollTimer = null;

async function renderDashboard() {
  app.innerHTML = `
    <header class="flex items-center justify-between mb-5 mt-1">
      <div>
        <h1 class="text-2xl font-extrabold"><span class="text-neon-green">ANDROID</span> Console</h1>
        <p class="text-white/40 text-xs font-mono">${cfg.user}/${cfg.repo}</p>
      </div>
      <div class="flex gap-2">
        <button id="refreshBtn" class="chip px-3 py-2 rounded-lg text-xs font-mono text-neon-blue"><i class="fa-solid fa-rotate"></i></button>
        <button id="logoutBtn" class="glass px-3 py-2 rounded-lg text-xs font-mono text-white/60"><i class="fa-solid fa-power-off"></i></button>
      </div>
    </header>

    <div class="grid sm:grid-cols-3 gap-3 mb-5" id="specsRow">
      ${specCard("fa-microchip", "RUNNER", "macOS-13 x64", "GitHub-hosted")}
      ${specCard("fa-memory", "RAM / DEVICE", "as configured", "exact, not shared")}
      ${specCard("fa-clock", "SESSION", "≤ 6h", "per GitHub limit")}
    </div>

    <div class="flex gap-2 mb-4">
      <button id="tabDevices" class="tab-active neon-border px-4 py-2 rounded-lg text-sm font-mono flex-1">Devices</button>
      <button id="tabCreate" class="glass px-4 py-2 rounded-lg text-sm font-mono flex-1 text-white/60">+ Create</button>
    </div>

    <div id="panel"></div>

    <div class="term rounded-xl mt-5 p-4 h-36 overflow-y-auto text-xs" id="terminal">
      <div class="text-white/30">$ dashboard ready.</div>
    </div>`;

  $("#logoutBtn").onclick = renderLogin;
  $("#refreshBtn").onclick = () => pollStatus(true);
  $("#tabDevices").onclick = showDevices;
  $("#tabCreate").onclick = showCreate;

  showDevices();
  pollStatus(true);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => pollStatus(false), 15000);
}

function specCard(icon, label, big, sub) {
  return `<div class="glass rounded-xl p-4">
    <div class="flex items-center gap-2 text-white/50 text-xs font-mono"><i class="fa-solid ${icon} text-neon-green"></i> ${label}</div>
    <div class="text-lg font-bold mt-1">${big}</div>
    <div class="text-white/40 text-[11px] font-mono">${sub}</div>
  </div>`;
}

function setTab(active) {
  $("#tabDevices").className = "px-4 py-2 rounded-lg text-sm font-mono flex-1 " + (active === "devices" ? "tab-active neon-border" : "glass text-white/60");
  $("#tabCreate").className = "px-4 py-2 rounded-lg text-sm font-mono flex-1 " + (active === "create" ? "tab-active neon-border" : "glass text-white/60");
}

// ---------- Devices panel ----------
function showDevices() {
  setTab("devices");
  renderDeviceList();
}

function renderDeviceList() {
  const panel = $("#panel");
  if (!panel) return;
  const devs = Object.values(devicesState.devices || {});
  if (!devs.length) {
    panel.innerHTML = `<div class="glass rounded-xl p-8 text-center text-white/40">
      <i class="fa-solid fa-mobile-screen text-3xl mb-3 text-white/20"></i>
      <p class="font-mono text-sm">No devices yet. Create one to deploy an Android device.</p>
    </div>`;
    return;
  }
  panel.innerHTML = devs.map(deviceCard).join("");
  devs.forEach((d) => {
    const open = document.getElementById("open-" + cssId(d.name));
    if (open) open.onclick = () => openDevice(d);
  });
}

function cssId(s) { return String(s).replace(/[^a-z0-9]/gi, "_"); }

function deviceCard(d) {
  const online = d.status === "online" && d.url;
  return `<div class="glass rounded-xl p-4 mb-3">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg grid place-items-center ${online ? "bg-neon-green/15 text-neon-green" : "bg-white/5 text-white/30"}">
          <i class="fa-brands fa-android"></i>
        </div>
        <div>
          <div class="font-bold">${d.name}</div>
          <div class="text-xs font-mono ${online ? "text-neon-green" : "text-white/40"}">
            <i class="fa-solid fa-circle text-[7px] align-middle"></i> ${d.status || "pending"}
          </div>
        </div>
      </div>
      <button id="open-${cssId(d.name)}" ${online ? "" : "disabled"}
        class="btn-primary px-4 py-2 rounded-lg text-xs ${online ? "" : "opacity-40 cursor-not-allowed"}">
        <i class="fa-solid fa-up-right-from-square"></i> Open
      </button>
    </div>
    ${d.url ? `<div class="mt-2 text-[11px] font-mono text-white/40 truncate">${d.url}</div>` : ""}
  </div>`;
}

function openDevice(d) {
  // Device is served behind its own auth wall (device user/pass). Open the URL.
  window.open(d.url, "_blank");
}

// ---------- Create panel ----------
function showCreate() {
  setTab("create");
  const panel = $("#panel");
  panel.innerHTML = `
    <div class="glass rounded-xl p-5">
      <div class="grid sm:grid-cols-2 gap-4">
        ${field("d_name", "Device name (URL slug)", "text", "", "pixel-1")}
        ${selectField("d_profile", "Hardware profile", ["pixel_6", "pixel_4", "pixel_xl", "Nexus 6", "Nexus 10 (tablet)"], "pixel_6")}
        ${selectField("d_api", "Android version", ["30 (11)", "31 (12)", "33 (13)", "34 (14)"], "31 (12)")}
        ${field("d_cores", "CPU cores", "number", "4", "4")}
        ${field("d_ram", "RAM (MB)", "number", "4096", "4096")}
        ${field("d_storage", "Storage (MB)", "number", "10240", "10240")}
        ${field("d_user", "Device access username", "text", "", "user")}
        ${fieldPw("d_pass", "Device access password", "", "••••••••")}
      </div>

      <div class="mt-4 glass rounded-lg p-3 neon-border">
        <div class="text-xs font-mono text-white/60 mb-2"><i class="fa-solid fa-network-wired text-neon-blue"></i> Access URL / Tunnel</div>
        <div class="flex gap-2">
          <label class="flex-1 flex items-center gap-2 fld rounded-lg px-3 py-2 text-sm cursor-pointer">
            <input type="radio" name="tunnel" value="cloudflare" checked /> <span>Cloudflare (free, no token)</span>
          </label>
          <label class="flex-1 flex items-center gap-2 fld rounded-lg px-3 py-2 text-sm cursor-pointer">
            <input type="radio" name="tunnel" value="ngrok" /> <span>Ngrok (token)</span>
          </label>
        </div>
        <div id="ngrokWrap" class="mt-3 hidden">
          ${fieldPw("d_ngrok", "Ngrok auth token", cfg.ngrokToken || "", "2...")}
        </div>
      </div>

      <div class="flex gap-2 mt-5">
        <button id="defaultBtn" class="glass neon-border px-4 py-3 rounded-xl text-sm font-mono text-neon-green flex-1">
          <i class="fa-solid fa-bolt"></i> Quick default (4GB / 10GB)
        </button>
        <button id="deployBtn" class="btn-primary px-4 py-3 rounded-xl text-sm flex-1">
          <i class="fa-solid fa-rocket"></i> DEPLOY DEVICE
        </button>
      </div>
    </div>`;

  document.querySelectorAll('input[name="tunnel"]').forEach((r) =>
    r.addEventListener("change", () => {
      $("#ngrokWrap").classList.toggle("hidden", document.querySelector('input[name="tunnel"]:checked').value !== "ngrok");
    })
  );
  $("#defaultBtn").onclick = fillDefault;
  $("#deployBtn").onclick = deployDevice;
}

function selectField(id, label, opts, def) {
  return `<label class="block">
    <span class="text-xs font-mono text-white/60">${label}</span>
    <select id="${id}" class="fld w-full mt-1 rounded-lg px-3 py-2.5 text-sm font-mono">
      ${opts.map((o) => `<option ${o === def ? "selected" : ""}>${o}</option>`).join("")}
    </select>
  </label>`;
}

function rand(n) { return Math.random().toString(36).slice(2, 2 + n); }
function fillDefault() {
  $("#d_name").value = "test-" + rand(4);
  $("#d_cores").value = "4";
  $("#d_ram").value = "4096";
  $("#d_storage").value = "10240";
  $("#d_user").value = "user_" + rand(4);
  $("#d_pass").value = rand(10);
  log("info", `Default device prepared: user=${$("#d_user").value} pass=${$("#d_pass").value}`);
}

async function deployDevice() {
  const name = $("#d_name").value.trim();
  const cores = $("#d_cores").value.trim();
  const ram = $("#d_ram").value.trim();
  const storage = $("#d_storage").value.trim();
  const user = $("#d_user").value.trim();
  const pass = $("#d_pass").value;
  const api = ($("#d_api").value.match(/^\d+/) || ["31"])[0];
  const profile = $("#d_profile").value.replace(/\s*\(.*\)/, "").trim();
  const tunnel = document.querySelector('input[name="tunnel"]:checked').value;
  const ngrok = $("#d_ngrok") ? $("#d_ngrok").value.trim() : "";

  if (!name || !user || !pass) { log("error", "Device name, username and password are required."); return; }
  if (tunnel === "ngrok" && !ngrok) { log("error", "Ngrok token required for ngrok tunnel."); return; }
  if (tunnel === "ngrok") { cfg.ngrokToken = ngrok; saveCfg(); }

  const btn = $("#deployBtn");
  btn.disabled = true; btn.classList.add("opacity-60");
  showDevices(); // switch to devices view to watch it come up

  try {
    log("cmd", `Ensuring workflow '${WORKFLOW_FILE}' in repo...`);
    await ensureWorkflow();

    log("cmd", `Dispatching device '${name}' (API ${api}, ${profile}, ${ram}MB / ${storage}MB / ${cores} cores)...`);
    await gh(`/repos/${cfg.user}/${cfg.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: "POST",
      body: JSON.stringify({
        ref: cfg.defaultBranch || "main",
        inputs: {
          device_name: name, android_api: api, device_profile: profile,
          ram_mb: ram, storage_mb: storage, cores: cores,
          auth_user: user, auth_pass: pass, tunnel, ngrok_token: ngrok,
          status_gist_id: cfg.gistId,
        },
      }),
    });

    // seed local state so it appears immediately as 'pending'
    devicesState.devices[name] = { name, status: "pending", url: "", updated: new Date().toISOString() };
    renderDeviceList();
    log("success", `Deploy triggered for '${name}'. Booting on runner (this takes a few minutes)...`);
    log("info", `Access → user: ${user} · pass: ${pass}`);
  } catch (e) {
    log("error", e.message);
  } finally {
    btn.disabled = false; btn.classList.remove("opacity-60");
  }
}

// Push the workflow + scripts into the repo if not present (self-bootstrapping).
async function ensureWorkflow() {
  const repoInfo = await gh(`/repos/${cfg.user}/${cfg.repo}`);
  cfg.defaultBranch = repoInfo.default_branch || "main";
  saveCfg();
  const path = `.github/workflows/${WORKFLOW_FILE}`;
  try {
    await gh(`/repos/${cfg.user}/${cfg.repo}/contents/${path}?ref=${cfg.defaultBranch}`);
    return; // already exists
  } catch {
    log("warn", "Workflow not found in repo — pushing it now...");
  }
  // Fetch the workflow + scripts bundled next to this page and commit them.
  const files = {
    [path]: await (await fetch("workflow/android-device.yml")).text(),
    ".github/scripts/auth-proxy.js": await (await fetch("workflow/auth-proxy.js")).text(),
    ".github/scripts/report-status.js": await (await fetch("workflow/report-status.js")).text(),
  };
  for (const [p, content] of Object.entries(files)) {
    await gh(`/repos/${cfg.user}/${cfg.repo}/contents/${p}`, {
      method: "PUT",
      body: JSON.stringify({ message: `add ${p}`, content: b64(content), branch: cfg.defaultBranch }),
    });
    log("success", `Committed ${p}`);
  }
}

// ---------- live status polling from gist ----------
async function pollStatus(verbose) {
  if (!cfg.gistId) return;
  try {
    const g = await gh(`/gists/${cfg.gistId}`);
    const raw = g.files?.["devices.json"]?.content || '{"devices":{}}';
    const remote = JSON.parse(raw);
    // merge (keep locally-seeded pending devices until runner overwrites)
    devicesState.devices = { ...devicesState.devices, ...remote.devices };
    if ($("#tabDevices")?.classList.contains("tab-active")) renderDeviceList();
    if (verbose) log("info", "Status refreshed.");
  } catch (e) {
    if (verbose) log("warn", "Could not read status gist: " + e.message);
  }
}
