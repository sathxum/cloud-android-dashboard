// Reports device status into a GitHub Gist so the dashboard can read live state.
// Usage: node report-status.js <gistId> <deviceName> <publicUrl> <status>
const https = require("https");

const [, , gistId, deviceName, publicUrl, status] = process.argv;
const token = process.env.GH_TOKEN;
if (!gistId || !token) {
  console.log("[report-status] missing gistId or token, skipping");
  process.exit(0);
}

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        host: "api.github.com",
        method,
        path,
        headers: {
          "User-Agent": "cloud-android",
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d || "{}"));
          } catch {
            resolve({});
          }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const gist = await api("GET", `/gists/${gistId}`);
  let state = {};
  try {
    state = JSON.parse(gist.files?.["devices.json"]?.content || "{}");
  } catch {
    state = {};
  }
  state.devices = state.devices || {};
  state.devices[deviceName] = {
    name: deviceName,
    url: publicUrl || state.devices[deviceName]?.url || "",
    status,
    updated: new Date().toISOString(),
  };
  await api("PATCH", `/gists/${gistId}`, {
    files: { "devices.json": { content: JSON.stringify(state, null, 2) } },
  });
  console.log(`[report-status] ${deviceName} -> ${status} ${publicUrl || ""}`);
})();
