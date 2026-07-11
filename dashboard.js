/* Cloud Android dashboard UI — talks to the gateway server API.
 * The dashboard itself is already behind admin Basic-Auth (served by the gateway),
 * so API calls just use same-origin credentials.
 */
const $ = (s, r = document) => r.querySelector(s);
const app = document.getElementById("app");
let devices = [];
let specs = {};

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

function fld(id, label, type, val, ph) {
  return `<label class="block"><span class="text-xs font-mono text-white/60">${label}</span>
    <input id="${id}" type="${type}" value="${val ?? ""}" placeholder="${ph || ""}"
      class="fld w-full mt-1 rounded-lg px-3 py-2.5 text-sm font-mono" autocapitalize="off" autocomplete="off" spellcheck="false"/></label>`;
}
function sel(id, label, opts, def) {
  return `<label class="block"><span class="text-xs font-mono text-white/60">${label}</span>
    <select id="${id}" class="fld w-full mt-1 rounded-lg px-3 py-2.5 text-sm font-mono">
      ${opts.map((o) => `<option ${o === def ? "selected" : ""}>${o}</option>`).join("")}</select></label>`;
}

async function render() {
  try { specs = await api("/api/specs"); } catch {}
  try { devices = (await api("/api/devices")).devices || []; } catch {}
  app.innerHTML = `
    <header class="flex items-center justify-between mb-5 mt-1">
      <div>
        <h1 class="text-2xl font-extrabold"><span class="text-neon-green">CLOUD</span> ANDROID</h1>
        <p class="text-white/40 text-xs font-mono">gateway dashboard</p>
      </div>
      <button id="refresh" class="chip px-3 py-2 rounded-lg text-xs font-mono text-neon-blue"><i class="fa-solid fa-rotate"></i></button>
    </header>

    <div class="grid sm:grid-cols-3 gap-3 mb-5">
      ${specCard("fa-microchip","RUNNER OS", (specs.os||"—"), "GitHub-hosted")}
      ${specCard("fa-memory","HOST RAM", (specs.ram_mb? specs.ram_mb+" MB":"—"), (specs.cores||"—")+" cores")}
      ${specCard("fa-hard-drive","DISK FREE", (specs.disk_free_mb? Math.round(specs.disk_free_mb/1024)+" GB":"—"), "on runner")}
    </div>

    <div class="flex gap-2 mb-4">
      <button id="tDev" class="tab-active neon-border px-4 py-2 rounded-lg text-sm font-mono flex-1">Devices</button>
      <button id="tNew" class="glass px-4 py-2 rounded-lg text-sm font-mono flex-1 text-white/60">+ Create</button>
    </div>
    <div id="panel"></div>`;

  $("#refresh").onclick = render;
  $("#tDev").onclick = showDevices;
  $("#tNew").onclick = showCreate;
  showDevices();
}

function specCard(icon, label, big, sub) {
  return `<div class="glass rounded-xl p-4">
    <div class="flex items-center gap-2 text-white/50 text-xs font-mono"><i class="fa-solid ${icon} text-neon-green"></i> ${label}</div>
    <div class="text-lg font-bold mt-1">${big}</div><div class="text-white/40 text-[11px] font-mono">${sub}</div></div>`;
}
function setTab(t) {
  $("#tDev").className = "px-4 py-2 rounded-lg text-sm font-mono flex-1 " + (t === "dev" ? "tab-active neon-border" : "glass text-white/60");
  $("#tNew").className = "px-4 py-2 rounded-lg text-sm font-mono flex-1 " + (t === "new" ? "tab-active neon-border" : "glass text-white/60");
}

function showDevices() {
  setTab("dev");
  const panel = $("#panel");
  if (!devices.length) {
    panel.innerHTML = `<div class="glass rounded-xl p-8 text-center text-white/40">
      <i class="fa-solid fa-mobile-screen text-3xl mb-3 text-white/20"></i>
      <p class="font-mono text-sm">No devices yet. Create one.</p></div>`;
    return;
  }
  panel.innerHTML = devices.map(card).join("");
  devices.forEach((d) => {
    const o = document.getElementById("open-" + d.name); if (o) o.onclick = () => window.open("/" + d.name + "/", "_blank");
    const x = document.getElementById("del-" + d.name); if (x) x.onclick = () => delDevice(d.name);
  });
}

function card(d) {
  const online = d.status === "online";
  return `<div class="glass rounded-xl p-4 mb-3">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg grid place-items-center ${online ? "bg-neon-green/15 text-neon-green" : "bg-white/5 text-white/30"}"><i class="fa-brands fa-android"></i></div>
        <div>
          <div class="font-bold">${d.name}</div>
          <div class="text-xs font-mono ${online ? "text-neon-green" : "text-white/40"}"><i class="fa-solid fa-circle text-[7px]"></i> ${d.status}</div>
        </div>
      </div>
      <div class="flex gap-2">
        <button id="del-${d.name}" class="glass px-3 py-2 rounded-lg text-xs text-white/50"><i class="fa-solid fa-trash"></i></button>
        <button id="open-${d.name}" ${online ? "" : "disabled"} class="btn-primary px-4 py-2 rounded-lg text-xs ${online ? "" : "opacity-40"}"><i class="fa-solid fa-up-right-from-square"></i> Open</button>
      </div>
    </div>
    <div class="mt-2 grid grid-cols-4 gap-2 text-[11px] font-mono text-white/50">
      <div>RAM<br><b class="text-white/80">${d.ram}M</b></div>
      <div>Storage<br><b class="text-white/80">${d.storage}M</b></div>
      <div>Cores<br><b class="text-white/80">${d.cores}</b></div>
      <div>API<br><b class="text-white/80">${d.api}</b></div>
    </div>
    <div class="mt-2 text-[11px] font-mono text-white/40">access: <b class="text-neon-blue">/${d.name}</b> · user: ${d.user} · pass: ${d.pass}</div>
  </div>`;
}

function showCreate() {
  setTab("new");
  $("#panel").innerHTML = `
    <div class="glass rounded-xl p-5">
      <div class="grid sm:grid-cols-2 gap-4">
        ${fld("c_name","Device name (URL slug)","text","","pixel-1")}
        ${sel("c_profile","Hardware profile",["pixel_6","pixel_4","pixel_xl","Nexus 6"],"pixel_6")}
        ${sel("c_api","Android version",["30","31","33","34"],"31")}
        ${fld("c_cores","CPU cores","number","4")}
        ${fld("c_ram","RAM (MB)","number","4096")}
        ${fld("c_storage","Storage (MB)","number","10240")}
        ${fld("c_user","Device username","text","","user")}
        ${fld("c_pass","Device password","text","","")}
      </div>
      <div class="flex gap-2 mt-5">
        <button id="defBtn" class="glass neon-border px-4 py-3 rounded-xl text-sm font-mono text-neon-green flex-1"><i class="fa-solid fa-bolt"></i> Quick default</button>
        <button id="createBtn" class="btn-primary px-4 py-3 rounded-xl text-sm flex-1"><i class="fa-solid fa-rocket"></i> CREATE DEVICE</button>
      </div>
      <div id="createMsg" class="text-xs font-mono mt-3 h-4"></div>
    </div>`;
  $("#defBtn").onclick = () => {
    const r = (n) => Math.random().toString(36).slice(2, 2 + n);
    $("#c_name").value = "test-" + r(4); $("#c_cores").value = 4; $("#c_ram").value = 4096;
    $("#c_storage").value = 10240; $("#c_user").value = "user_" + r(4); $("#c_pass").value = r(10);
  };
  $("#createBtn").onclick = createDevice;
}

async function createDevice() {
  const body = {
    name: $("#c_name").value.trim(), profile: $("#c_profile").value, api: $("#c_api").value,
    cores: $("#c_cores").value, ram: $("#c_ram").value, storage: $("#c_storage").value,
    user: $("#c_user").value.trim(), pass: $("#c_pass").value,
  };
  const msg = $("#createMsg");
  if (!body.name || !body.user || !body.pass) { msg.className = "text-xs font-mono mt-3 text-neon-orange"; msg.textContent = "name, user and pass required"; return; }
  const btn = $("#createBtn"); btn.disabled = true; btn.classList.add("opacity-60");
  try {
    await api("/api/devices", { method: "POST", body: JSON.stringify(body) });
    msg.className = "text-xs font-mono mt-3 text-neon-green";
    msg.textContent = `Created. Access at /${body.name} (booting…)`;
    setTimeout(render, 800);
  } catch (e) {
    msg.className = "text-xs font-mono mt-3 text-neon-orange"; msg.textContent = e.message;
  } finally { btn.disabled = false; btn.classList.remove("opacity-60"); }
}

async function delDevice(name) {
  if (!confirm(`Delete device '${name}'?`)) return;
  try { await api("/api/devices/" + encodeURIComponent(name), { method: "DELETE" }); render(); } catch (e) { alert(e.message); }
}

render();
setInterval(async () => { try { devices = (await api("/api/devices")).devices || []; if ($("#tDev")?.classList.contains("tab-active")) showDevices(); } catch {} }, 12000);
