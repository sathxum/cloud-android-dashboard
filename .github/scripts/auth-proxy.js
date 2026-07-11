// Per-device auth wall in front of ws-scrcpy.
// Prompts for the username/password the user set when creating the device,
// then proxies (incl. WebSocket) to ws-scrcpy on :8000.
const http = require("http");
const net = require("net");

const AUTH_USER = process.env.AUTH_USER || "admin";
const AUTH_PASS = process.env.AUTH_PASS || "admin";
const DEVICE_NAME = process.env.DEVICE_NAME || "device";
const LISTEN_PORT = parseInt(process.env.PROXY_PORT || "8080", 10);
const TARGET_HOST = "127.0.0.1";
const TARGET_PORT = parseInt(process.env.SCRCPY_PORT || "8000", 10);

function unauthorized(res) {
  res.writeHead(401, {
    "WWW-Authenticate": `Basic realm="${DEVICE_NAME} — Cloud Android"`,
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(
    `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">` +
      `<body style="background:#050508;color:#e0e0e0;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">` +
      `<div style="text-align:center"><h2 style="color:#00f3ff">🔒 ${DEVICE_NAME}</h2>` +
      `<p>Authentication required to access this device.</p></div></body>`
  );
}

function checkAuth(req) {
  const h = req.headers["authorization"] || "";
  if (!h.startsWith("Basic ")) return false;
  const [u, p] = Buffer.from(h.slice(6), "base64").toString().split(":");
  return u === AUTH_USER && p === AUTH_PASS;
}

const server = http.createServer((req, res) => {
  if (!checkAuth(req)) return unauthorized(res);
  const proxyReq = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on("error", () => {
    res.writeHead(502);
    res.end("bad gateway");
  });
  req.pipe(proxyReq);
});

// WebSocket / upgrade passthrough (auth enforced on the upgrade request too)
server.on("upgrade", (req, socket, head) => {
  if (!checkAuth(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic\r\n\r\n");
    socket.destroy();
    return;
  }
  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("") +
        "\r\n"
    );
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
});

server.listen(LISTEN_PORT, () => {
  console.log(`[auth-proxy] ${DEVICE_NAME} listening on :${LISTEN_PORT} -> :${TARGET_PORT}`);
});
