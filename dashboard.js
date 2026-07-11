/* Cloud Android — Control Center UI.
 * Talks to the gateway server (same origin, behind admin Basic-Auth).
 * Features: live device grid, animated boot phases, live per-device log stream,
 * real runner specs, session countdown, create/restart/stop, toasts.
 */
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const api = async (path, opts = {}) => {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.status === 204 ? {} : res.json();
};

// ---------- toasts ----------
function toast(msg, kind = "info") {
  const c = { info: "border-brand-blue text-brand-blue", success: "border-brand-green text-brand-green", error: "border-brand-red text-brand-red", warn: "border-brand-orange text-brand-orange" }[kind];
  const el = document.createElement("div");
  el.className = `glass ${c} border-l-2 rounded-lg px-4 py-2.5 text-sm shadow-xl animate-slideUp max-w-xs`;
  el.innerHTML = `<i class="fa-solid ${kind === "success" ? "fa-check" : kind === "error" ? "fa-triangle-exclamation" : "fa-circle-info"} mr-2"></i>${msg}`;
  $("#toasts").appendChild(el);
  setTimeout(() => { el.style.transition = ".3s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 3800);
}

// ---------- state ----------
let specs = null, devices = [], openLogs = null, pollTimer = null;
const SESSION_MAX = 6 * 3600 * 1000; // ~6h GitHub limit
let sessionStart = Date.now();

const PHASES = ["downloading image", "creating AVD", "booting emulator", "starting screen mirror"];
function phasePct(d) {
  if (d.status === "online") return 100;
  const i = PHASES.indexOf(d.phase);
  return i < 0 ? 6 : Math.min(95, 15 + i * 22);
}
function fmtDur(ms) {
  if (!ms || ms < 0) return "0s";
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${ss}s` : `${ss}s`;
}

// ---------- shell ----------
function shell() {
  app.innerHTML = `
    <header class="flex flex-wrap items-center justify-between gap-3 mb-6">
      <div class="flex items-center gap-3">
        <div class="w-11 h-11 rounded-xl grid place-items-center bg-gradient-to-br from-brand-green to-brand-blue text-black text-xl"><i class="fa-brands fa-android"></i></div>
        <div>
          <h1 class="text-xl font-extrabold leading-tight">Cloud Android <span class="text-brand-green">Control Center</span></h1>
          <p class="text-white/40 text-xs font-mono" id="sessionLine">session starting…</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button id="termBtn" class="btn btn-ghost px-4 py-2.5 rounded-xl text-sm text-white/70"><i class="fa-solid fa-terminal mr-2"></i>Terminal</button>
        <button id="newBtn" class="btn btn-primary px-4 py-2.5 rounded-xl text-sm"><i class="fa-solid fa-plus mr-2"></i>New device</button>
        <button id="logoutBtn" class="btn btn-ghost px-3 py-2.5 rounded-xl text-sm text-white/70"><i class="fa-solid fa-power-off"></i></button>
      </div>
    </header>

    <section id="specs" class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6"></section>

    <div class="flex items-center justify-between mb-3">
      <h2 class="font-bold text-lg flex items-center gap-2"><i class="fa-solid fa-mobile-screen-button text-brand-green"></i> Devices <span id="devCount" class="text-white/40 text-sm font-mono"></span></h2>
      <button id="refreshBtn" class="btn btn-ghost px-3 py-1.5 rounded-lg text-xs font-mono text-white/60"><i class="fa-solid fa-rotate mr-1"></i>refresh</button>
    </div>
    <section id="grid" class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4"></section>`;

  $("#newBtn").onclick = openCreate;
  $("#termBtn").onclick = openTerminal;
  $("#refreshBtn").onclick = () => poll(true);
  $("#logoutBtn").onclick = () => { document.cookie = ""; location.reload(); };
  renderSpecs();
  renderGrid();
}

// ---------- specs cards ----------
function specCard(icon, label, val, sub, color = "text-brand-green") {
  return `<div class="glass rounded-xl p-4">
    <div class="flex items-center gap-2 text-white/45 text-[11px] font-mono uppercase tracking-wide"><i class="fa-solid ${icon} ${color}"></i> ${label}</div>
    <div class="text-lg font-bold mt-1 truncate">${val}</div>
    <div class="text-white/35 text-[11px] font-mono">${sub}</div>
  </div>`;
}
function renderSpecs() {
  const el = $("#specs"); if (!el) return;
  if (!specs) { el.innerHTML = Array(4).fill(`<div class="glass rounded-xl p-4 h-[86px] skeleton animate-shimmer"></div>`).join(""); return; }
  const online = devices.filter(d => d.status === "online").length;
  el.innerHTML = [
    specCard("fa-microchip", "Runner", (specs.os || "macos").toUpperCase(), `${specs.cores} vCPU · Apple Silicon`),
    specCard("fa-memory", "Runner RAM", `${(specs.ram_mb / 1024).toFixed(0)} GB`, "shared host pool", "text-brand-blue"),
    specCard("fa-hard-drive", "Free disk", `${(specs.disk_free_mb / 1024).toFixed(0)} GB`, "for AVDs & images", "text-brand-purple"),
    specCard("fa-signal", "Devices online", `${online}/${devices.length || 0}`, "live now", online ? "text-brand-green" : "text-white/40"),
  ].join("");
}

// ---------- device grid ----------
function statusPill(d) {
  const map = {
    online: ["text-brand-green", "bg-brand-green/15", "online"],
    pending: ["text-brand-orange", "bg-brand-orange/15", d.phase || "booting"],
    offline: ["text-white/40", "bg-white/5", "offline"],
    error: ["text-brand-red", "bg-brand-red/15", "error"],
  };
  const [tc, bg, label] = map[d.status] || map.pending;
  return `<span class="inline-flex items-center gap-1.5 ${tc} ${bg} px-2 py-0.5 rounded-full text-[11px] font-mono">
    <span class="w-1.5 h-1.5 rounded-full bg-current ${d.status === "pending" ? "animate-pulseDot" : ""}"></span>${label}</span>`;
}
function deviceCard(d) {
  const online = d.status === "online";
  const pct = phasePct(d);
  return `<div class="glass glass-hover rounded-2xl p-4 transition animate-slideUp" data-dev="${d.name}">
    <div class="flex items-start justify-between gap-2">
      <div class="flex items-center gap-3 min-w-0">
        <div class="w-11 h-11 rounded-xl grid place-items-center ${online ? "bg-brand-green/15 text-brand-green" : "bg-white/5 text-white/40"} shrink-0"><i class="fa-brands fa-android text-lg"></i></div>
        <div class="min-w-0">
          <div class="font-bold truncate">${d.name}</div>
          <div class="text-[11px] font-mono text-white/40 truncate">API ${d.api} · ${d.profile || "pixel_6"} · ${d.ram_mb}MB · ${d.storage_mb}MB · ${d.cores}c</div>
        </div>
      </div>
      ${statusPill(d)}
    </div>

    ${!online ? `<div class="mt-3">
      <div class="flex justify-between text-[10px] font-mono text-white/40 mb-1"><span>${d.phase || "queued"}</span><span>${fmtDur(d.bootElapsed)}</span></div>
      <div class="h-1.5 rounded-full bg-white/8 overflow-hidden"><div class="prog h-full rounded-full" style="width:${pct}%"></div></div>
    </div>` : `<div class="mt-3 flex items-center gap-4 text-[11px] font-mono text-white/45">
      <span><i class="fa-solid fa-clock text-brand-green"></i> up ${fmtDur(d.uptime)}</span>
    </div>`}

    <div class="flex gap-2 mt-4">
      <button data-open="${d.name}" ${online ? "" : "disabled"} class="btn ${online ? "btn-primary" : "btn-ghost opacity-50 cursor-not-allowed"} flex-1 px-3 py-2 rounded-lg text-xs"><i class="fa-solid fa-up-right-from-square mr-1"></i>Open screen</button>
      <button data-logs="${d.name}" class="btn btn-ghost px-3 py-2 rounded-lg text-xs text-white/70"><i class="fa-solid fa-terminal"></i></button>
      <button data-restart="${d.name}" class="btn btn-ghost px-3 py-2 rounded-lg text-xs text-brand-orange"><i class="fa-solid fa-rotate-right"></i></button>
      <button data-stop="${d.name}" class="btn btn-ghost px-3 py-2 rounded-lg text-xs text-brand-red"><i class="fa-solid fa-trash"></i></button>
    </div>

    <div data-logbox="${d.name}" class="hidden mt-3 term rounded-lg p-3 h-40 overflow-y-auto text-[11px]"></div>
  </div>`;
}
function renderGrid() {
  const el = $("#grid"); if (!el) return;
  $("#devCount").textContent = devices.length ? `(${devices.length})` : "";
  if (!devices.length) {
    el.innerHTML = `<div class="glass rounded-2xl p-10 text-center text-white/40 sm:col-span-2 lg:col-span-3">
      <i class="fa-solid fa-mobile-screen text-4xl mb-3 text-white/15"></i>
      <p class="font-mono text-sm">No devices yet.</p>
      <button onclick="openCreate()" class="btn btn-primary mt-4 px-4 py-2 rounded-lg text-xs"><i class="fa-solid fa-plus mr-1"></i>Create your first device</button>
    </div>`;
    return;
  }
  el.innerHTML = devices.map(deviceCard).join("");
  el.querySelectorAll("[data-open]").forEach(b => b.onclick = () => window.open(`/${b.dataset.open}/`, "_blank"));
  el.querySelectorAll("[data-logs]").forEach(b => b.onclick = () => toggleLogs(b.dataset.logs));
  el.querySelectorAll("[data-restart]").forEach(b => b.onclick = () => restartDevice(b.dataset.restart));
  el.querySelectorAll("[data-stop]").forEach(b => b.onclick = () => stopDevice(b.dataset.stop));
  // keep open log box visible after re-render
  if (openLogs) { const box = $(`[data-logbox="${openLogs}"]`); if (box) { box.classList.remove("hidden"); renderLogs(openLogs); } }
}

// ---------- live logs ----------
function toggleLogs(name) {
  const box = $(`[data-logbox="${name}"]`);
  if (!box) return;
  if (openLogs === name && !box.classList.contains("hidden")) { box.classList.add("hidden"); openLogs = null; return; }
  document.querySelectorAll("[data-logbox]").forEach(b => b.classList.add("hidden"));
  box.classList.remove("hidden"); openLogs = name; renderLogs(name);
}
async function renderLogs(name) {
  const box = $(`[data-logbox="${name}"]`); if (!box) return;
  try {
    const { logs } = await api(`/api/devices/${name}/logs`);
    const col = { info: "#00d4ff", success: "#3ddc84", warn: "#ff9500", error: "#ff3b5c", cmd: "#8b5cf6" };
    box.innerHTML = (logs || []).map(l =>
      `<div><span class="text-white/25">${new Date(l.t).toLocaleTimeString()}</span> <span style="color:${col[l.kind] || "#cbd5e1"}">${l.msg}</span></div>`
    ).join("") || `<div class="text-white/25">no logs yet…</div>`;
    box.scrollTop = box.scrollHeight;
  } catch (e) { box.innerHTML = `<div class="text-brand-red">log error: ${e.message}</div>`; }
}

// ---------- actions ----------
async function restartDevice(name) {
  try { await api(`/api/devices/${name}/restart`, { method: "POST" }); toast(`Restarting ${name}…`, "warn"); poll(true); }
  catch (e) { toast(e.message, "error"); }
}
async function stopDevice(name) {
  if (!confirm(`Stop & remove device "${name}"?`)) return;
  try { await api(`/api/devices/${name}`, { method: "DELETE" }); toast(`Removed ${name}`, "success"); poll(true); }
  catch (e) { toast(e.message, "error"); }
}

// ---------- create modal ----------
function openCreate() {
  const dlg = document.createElement("dialog");
  dlg.className = "glass rounded-2xl p-0 w-[92vw] max-w-lg text-white";
  const rnd = Math.random().toString(36).slice(2, 8);
  dlg.innerHTML = `
    <form method="dialog">
      <div class="p-5 border-b border-white/10 flex items-center justify-between">
        <h3 class="font-bold text-lg"><i class="fa-solid fa-plus text-brand-green mr-2"></i>New Android device</h3>
        <button value="cancel" class="text-white/40 hover:text-white"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="p-5 grid sm:grid-cols-2 gap-4">
        ${inp("c_name", "Device name (URL: /name)", "text", "phone-" + rnd)}
        ${sel("c_profile", "Hardware profile", ["pixel_6", "pixel_4", "pixel_xl", "Nexus 6", "Nexus 10"])}
        ${sel("c_api", "Android version", ["30 (11)", "31 (12)", "33 (13)", "34 (14)"], "34 (14)")}
        ${inp("c_cores", "CPU cores", "number", "4")}
        ${inp("c_ram", "RAM (MB)", "number", "4096")}
        ${inp("c_storage", "Storage (MB)", "number", "10240")}
        ${inp("c_user", "Device access user", "text", "user")}
        ${inp("c_pass", "Device access pass", "text", rnd + "x")}
      </div>
      <div class="px-5 pb-2 flex gap-2">
        <button type="button" id="c_quick" class="btn btn-ghost flex-1 py-2 rounded-lg text-xs text-brand-green"><i class="fa-solid fa-bolt mr-1"></i>Quick default (4GB/10GB)</button>
      </div>
      <div class="p-5 flex gap-2 border-t border-white/10 mt-2">
        <button value="cancel" class="btn btn-ghost flex-1 py-2.5 rounded-lg text-sm">Cancel</button>
        <button type="button" id="c_deploy" class="btn btn-primary flex-1 py-2.5 rounded-lg text-sm"><i class="fa-solid fa-rocket mr-1"></i>Deploy</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.querySelector("#c_quick").onclick = () => {
    dlg.querySelector("#c_cores").value = 4; dlg.querySelector("#c_ram").value = 4096;
    dlg.querySelector("#c_storage").value = 10240;
  };
  dlg.querySelector("#c_deploy").onclick = async () => {
    const g = (id) => dlg.querySelector("#" + id).value.trim();
    const body = {
      name: g("c_name"), profile: g("c_profile").replace(/\s*\(.*\)/, ""),
      api: (g("c_api").match(/^\d+/) || ["34"])[0], cores: +g("c_cores"), ram_mb: +g("c_ram"),
      storage_mb: +g("c_storage"), auth_user: g("c_user"), auth_pass: g("c_pass"),
    };
    if (!body.name || !body.auth_user || !body.auth_pass) return toast("Name, user & pass required", "error");
    try {
      await api("/api/devices", { method: "POST", body: JSON.stringify(body) });
      toast(`Deploying ${body.name} — access ${body.auth_user}/${body.auth_pass}`, "success");
      dlg.close(); poll(true);
    } catch (e) { toast(e.message, "error"); }
  };
}
function inp(id, label, type, val) {
  return `<label class="block"><span class="text-[11px] font-mono text-white/55">${label}</span>
    <input id="${id}" type="${type}" value="${val || ""}" class="fld w-full mt-1 rounded-lg px-3 py-2 text-sm font-mono" autocapitalize="off" autocomplete="off" spellcheck="false"/></label>`;
}
function sel(id, label, opts, def) {
  return `<label class="block"><span class="text-[11px] font-mono text-white/55">${label}</span>
    <select id="${id}" class="fld w-full mt-1 rounded-lg px-3 py-2 text-sm font-mono">${opts.map(o => `<option ${o === def ? "selected" : ""}>${o}</option>`).join("")}</select></label>`;
}

// ---------- macOS terminal ----------
function openTerminal() {
  const dlg = document.createElement("dialog");
  dlg.className = "glass rounded-2xl p-0 w-[92vw] max-w-3xl text-white";
  dlg.innerHTML = `
    <div class="flex items-center justify-between px-4 py-3 border-b border-white/10">
      <div class="flex items-center gap-2 text-sm font-semibold"><i class="fa-solid fa-terminal text-brand-green"></i> macOS runner terminal</div>
      <button value="cancel" class="text-white/40 hover:text-white"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div id="tout" class="term rounded-none px-4 py-3 h-[52vh] overflow-y-auto text-xs whitespace-pre-wrap"><div class="text-white/30">Type a command and press Enter. Runs on the GitHub runner. 60s limit per command.</div></div>
    <div class="flex items-center gap-2 px-3 py-2.5 border-t border-white/10">
      <span class="text-brand-green font-mono text-xs">$</span>
      <input id="tin" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="e.g. sw_vers ; adb devices ; ls" class="fld flex-1 rounded-lg px-3 py-2 text-xs font-mono" />
      <button id="trun" class="btn btn-primary px-3 py-2 rounded-lg text-xs"><i class="fa-solid fa-play"></i></button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.addEventListener("close", () => dlg.remove());

  const out = dlg.querySelector("#tout");
  const inp = dlg.querySelector("#tin");
  const hist = []; let hi = -1;
  const write = (html) => { const d = document.createElement("div"); d.innerHTML = html; out.appendChild(d); out.scrollTop = out.scrollHeight; };

  async function run() {
    const cmd = inp.value.trim();
    if (!cmd) return;
    hist.push(cmd); hi = hist.length;
    write(`<span class="text-brand-blue">$ ${cmd.replace(/</g, "&lt;")}</span>`);
    inp.value = ""; inp.disabled = true;
    try {
      const r = await api("/api/exec", { method: "POST", body: JSON.stringify({ cmd }) });
      if (r.out) write(`<span class="text-white/80">${r.out.replace(/</g, "&lt;")}</span>`);
      if (r.err) write(`<span class="text-brand-orange">${r.err.replace(/</g, "&lt;")}</span>`);
      if (r.killed) write(`<span class="text-brand-red">[timed out after 60s]</span>`);
      write(`<span class="text-white/25">exit ${r.code} · ${r.cwd}</span>`);
    } catch (e) {
      write(`<span class="text-brand-red">error: ${e.message}</span>`);
    } finally {
      inp.disabled = false; inp.focus();
    }
  }
  dlg.querySelector("#trun").onclick = run;
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
    else if (e.key === "ArrowUp") { if (hi > 0) { hi--; inp.value = hist[hi] || ""; } }
    else if (e.key === "ArrowDown") { if (hi < hist.length - 1) { hi++; inp.value = hist[hi] || ""; } else { hi = hist.length; inp.value = ""; } }
  });
  setTimeout(() => inp.focus(), 100);
}

// ---------- polling ----------
async function poll(verbose) {
  try {
    const [sp, dv] = await Promise.all([
      specs ? Promise.resolve({ specs }) : api("/api/specs").then(s => ({ specs: s })),
      api("/api/devices"),
    ]);
    if (sp.specs) specs = sp.specs;
    devices = dv.devices || [];
    renderSpecs(); renderGrid(); updateSession();
    if (openLogs) renderLogs(openLogs);
    if (verbose) toast("Refreshed", "info");
  } catch (e) { if (verbose) toast(e.message, "error"); }
}
function updateSession() {
  const left = SESSION_MAX - (Date.now() - sessionStart);
  const el = $("#sessionLine");
  if (el) el.innerHTML = left > 0
    ? `<i class="fa-solid fa-circle text-brand-green text-[7px] mr-1 animate-pulseDot"></i>live · ~${fmtDur(left)} of runner time left`
    : `<span class="text-brand-orange">session expiring — redeploy soon</span>`;
}

// ---------- boot ----------
shell();
poll(true);
pollTimer = setInterval(() => poll(false), 5000);
setInterval(updateSession, 1000);
window.openCreate = openCreate;
