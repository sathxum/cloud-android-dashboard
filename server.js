/*
 * Cloud Android — Gateway server (runs on the GitHub Actions runner).
 *
 * One public tunnel URL fronts everything:
 *   GET  /                      -> dashboard UI (behind admin login)
 *   GET  /<deviceName>/...       -> that device's screen (behind the device's own login)
 *   API  /api/*                  -> device lifecycle (admin only)
 *
 * Devices are real Android emulators started on-demand; each exposes a
 * ws-scrcpy web mirror on a local port, and the gateway reverse-proxies
 * /<deviceName> to it with a per-device Basic-Auth wall.
 */
const http = require("http");
const net = require("net");
const { spawn, execSync } = require("child_process");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";

// In-memory device registry. Persisted best-effort to devices.json.
const fs = require("fs");
const STATE_FILE = "devices.json";
let devices = loadState(); // { name: {name,user,pass,ram,storage,cores,api,profile,port,status,pid} }

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).devices || {}; } catch { return {}; }
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ devices }, null, 2)); } catch {}
}

// ---------- helpers ----------
function basicAuthOk(req, user, pass) {
  const h = req.headers["authorization"] || "";
  if (!h.startsWith("Basic ")) return false;
  const [u, p] = Buffer.from(h.slice(6), "base64").toString().split(":");
  return u === user && p === pass;
}
function askAuth(res, realm) {
  res.writeHead(401, { "WWW-Authenticate": `Basic realm="${realm}"`, "Content-Type": "text/html" });
  res.end(`<meta name=viewport content="width=device-width,initial-scale=1"><body style="background:#050508;color:#e6e6e6;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#3ddc84">🔒 ${realm}</h2><p>Authentication required.</p></div></body>`);
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function firstSegment(url) {
  const p = url.split("?")[0].replace(/^\/+/, "");
  return p.split("/")[0];
}
let nextPort = 9100;
function allocPort() { return nextPort++; }

// ---------- device lifecycle ----------
function startDevice(d) {
  d.status = "booting";
  d.port = d.port || allocPort();
  d.logs = d.logs || [];
  d.bootStartedAt = Date.now();
  pushLog(d, "info", `Booting ${d.name} (API ${d.api}, ${d.profile}, ${d.ram}MB RAM / ${d.storage}MB / ${d.cores} cores)...`);
  saveState();
  // boot.sh brings up emulator + ws-scrcpy on d.port; see scripts/boot-device.sh
  const child = spawn("bash", [".github/scripts/boot-device.sh"], {
    env: {
      ...process.env,
      DEVICE_NAME: d.name, DEVICE_PORT: String(d.port),
      ANDROID_API: String(d.api), DEVICE_PROFILE: d.profile,
      RAM_MB: String(d.ram), STORAGE_MB: String(d.storage), CORES: String(d.cores),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  d.pid = child.pid;
  child.stdout.on("data", (b) => {
    const s = b.toString();
    process.stdout.write(`[${d.name}] ${s}`);
    s.split(/\r?\n/).forEach((line) => { if (line.trim()) pushLog(d, "log", line.trim()); });
    if (s.includes("WS_SCRCPY_READY")) { d.status = "online"; d.onlineAt = Date.now(); pushLog(d, "success", "Device online — screen ready."); saveState(); }
    // explicit phase markers from boot-device.sh take priority
    const pm = s.match(/PHASE\s+(.+)/);
    if (pm) d.phase = pm[1].trim();
    else if (/Downloading|sdkmanager/i.test(s)) d.phase = "downloading image";
    else if (/create avd/i.test(s)) d.phase = "creating AVD";
    else if (/wait-for-device|booting/i.test(s)) d.phase = "booting emulator";
    else if (/ws-scrcpy|scrcpy/i.test(s)) d.phase = "starting screen mirror";
  });
  child.stderr.on("data", (b) => {
    process.stderr.write(`[${d.name}] ${b}`);
    b.toString().split(/\r?\n/).forEach((line) => { if (line.trim()) pushLog(d, "warn", line.trim()); });
  });
  child.on("exit", (code) => { if (d.status !== "online") pushLog(d, "error", `boot process exited (code ${code})`); d.status = d.status === "online" ? "online" : "offline"; saveState(); });
  saveState();
}
function pushLog(d, kind, msg) {
  d.logs = d.logs || [];
  d.logs.push({ t: Date.now(), kind, msg });
  if (d.logs.length > 400) d.logs.splice(0, d.logs.length - 400);
}
function stopDevice(d) {
  if (d.pid) { try { process.kill(-d.pid, "SIGKILL"); } catch {} }
  d.status = "offline"; d.pid = null; saveState();
}

// ---------- reverse proxy to a device ----------
function proxyHttp(req, res, targetPort, stripPrefix) {
  const path = req.url.slice(stripPrefix.length) || "/";
  const pr = http.request(
    { host: "127.0.0.1", port: targetPort, method: req.method, path, headers: req.headers },
    (pres) => { res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res); }
  );
  pr.on("error", () => { res.writeHead(502); res.end("device not ready"); });
  req.pipe(pr);
}

// ---------- dashboard assets ----------
function serveFile(res, file, type) {
  try { res.writeHead(200, { "Content-Type": type }); res.end(fs.readFileSync(file)); }
  catch { res.writeHead(404); res.end("not found"); }
}

// ---------- HTTP server ----------
const server = http.createServer((req, res) => {
  const seg = firstSegment(req.url);

  // API (admin only)
  if (seg === "api") return handleApi(req, res);

  // Device route: /<name>/...
  if (seg && devices[seg]) {
    const d = devices[seg];
    if (!basicAuthOk(req, d.user, d.pass)) return askAuth(res, `${d.name} — Cloud Android`);
    if (d.status !== "online") { res.writeHead(503, { "Content-Type": "text/html" }); return res.end(`<meta http-equiv=refresh content=4><body style="background:#050508;color:#3ddc84;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${d.name}</h2><p>Booting… (${d.status})</p></div></body>`); }
    return proxyHttp(req, res, d.port, "/" + seg);
  }

  // Dashboard (admin only)
  if (!basicAuthOk(req, ADMIN_USER, ADMIN_PASS)) return askAuth(res, "Cloud Android Dashboard");
  if (req.url === "/" || req.url.startsWith("/?")) return serveFile(res, "dashboard.html", "text/html");
  if (seg === "dashboard.js") return serveFile(res, "dashboard.js", "text/javascript");
  res.writeHead(404); res.end("not found");
});

// WebSocket upgrade -> route to device (auth on upgrade)
server.on("upgrade", (req, socket, head) => {
  const seg = firstSegment(req.url);
  const d = devices[seg];
  if (!d) { socket.destroy(); return; }
  if (!basicAuthOk(req, d.user, d.pass)) { socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic\r\n\r\n"); socket.destroy(); return; }
  const path = req.url.slice(("/" + seg).length) || "/";
  const up = net.connect(d.port, "127.0.0.1", () => {
    up.write(`${req.method} ${path} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n");
    if (head && head.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  up.on("error", () => socket.destroy());
});

// ---------- API handlers (admin) ----------
function handleApi(req, res) {
  if (!basicAuthOk(req, ADMIN_USER, ADMIN_PASS)) return askAuth(res, "Cloud Android API");
  const path = req.url.split("?")[0];

  if (req.method === "GET" && path === "/api/devices") {
    return json(res, 200, { devices: Object.values(devices).map(pub) });
  }
  if (req.method === "GET" && path === "/api/specs") {
    return json(res, 200, hostSpecs());
  }
  if (req.method === "POST" && path === "/api/devices") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(res, 400, { error: "bad json" }); }
      const name = String(b.name || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (!name) return json(res, 400, { error: "name required" });
      if (devices[name]) return json(res, 409, { error: "device exists" });
      const d = {
        name,
        user: b.user || b.auth_user || "user",
        pass: b.pass || b.auth_pass || crypto.randomBytes(6).toString("hex"),
        ram: parseInt(b.ram || b.ram_mb || 4096, 10),
        storage: parseInt(b.storage || b.storage_mb || 10240, 10),
        cores: parseInt(b.cores || 4, 10),
        api: parseInt(b.api || 31, 10),
        profile: b.profile || "pixel_6",
        status: "queued",
      };
      devices[name] = d;
      startDevice(d);
      return json(res, 201, { device: pub(d) });
    });
    return;
  }
  if (req.method === "DELETE" && path.startsWith("/api/devices/")) {
    const name = decodeURIComponent(path.split("/").pop());
    if (!devices[name]) return json(res, 404, { error: "not found" });
    stopDevice(devices[name]);
    delete devices[name];
    saveState();
    return json(res, 200, { ok: true });
  }
  // GET /api/devices/:name/logs?since=<ts>  -> live logs
  const mLogs = path.match(/^\/api\/devices\/([^/]+)\/logs$/);
  if (req.method === "GET" && mLogs) {
    const d = devices[decodeURIComponent(mLogs[1])];
    if (!d) return json(res, 404, { error: "not found" });
    const since = parseInt((req.url.split("since=")[1] || "0"), 10) || 0;
    const logs = (d.logs || []).filter((l) => l.t > since);
    return json(res, 200, { status: d.status, phase: d.phase || null, logs });
  }
  // POST /api/devices/:name/restart -> reboot the emulator
  const mRestart = path.match(/^\/api\/devices\/([^/]+)\/restart$/);
  if (req.method === "POST" && mRestart) {
    const d = devices[decodeURIComponent(mRestart[1])];
    if (!d) return json(res, 404, { error: "not found" });
    stopDevice(d);
    d.logs = []; d.phase = null;
    startDevice(d);
    return json(res, 200, { device: pub(d) });
  }
  return json(res, 404, { error: "unknown endpoint" });
}
function pub(d) {
  return {
    name: d.name, user: d.user, pass: d.pass, ram: d.ram, storage: d.storage,
    ram_mb: d.ram, storage_mb: d.storage,
    cores: d.cores, api: d.api, profile: d.profile, status: d.status,
    phase: d.phase || null,
    uptime: d.onlineAt ? Date.now() - d.onlineAt : 0,
    bootElapsed: d.bootStartedAt ? Date.now() - d.bootStartedAt : 0,
  };
}

function hostSpecs() {
  const specs = { os: process.platform, cores: require("os").cpus().length, ram_mb: Math.round(require("os").totalmem() / 1048576) };
  try { specs.disk_free_mb = parseInt(execSync("df -m / | awk 'NR==2{print $4}'").toString().trim(), 10); } catch {}
  return specs;
}

server.listen(PORT, () => console.log(`[gateway] listening on :${PORT} (admin=${ADMIN_USER})`));
