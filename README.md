# Cloud Android — Dashboard (Project)

The **project** that runs on a GitHub Actions runner. It is **not** the deployer — deploy it using the separate one-file deployer: https://github.com/sathxum/android-deployer

## What it is
A gateway server + dashboard. One public tunnel URL fronts everything:

- `URL/`                → dashboard (behind your **admin** login)
- `URL/<devicename>`    → that device's live Android screen (behind the **device's own** login)

So **multiple devices are reached from the single dashboard URL** as `dashboardURL/devicename`.

## Pieces
| File | Role |
|------|------|
| `server.js` | Gateway: serves dashboard, per-device auth walls, reverse-proxies `/name` to each device, device API. |
| `dashboard.html` / `dashboard.js` | Dashboard UI — real runner specs, create/list/delete devices. |
| `.github/scripts/boot-device.sh` | Boots one Android emulator + ws-scrcpy web mirror per device with exact RAM/storage/cores. |
| `.github/workflows/gateway.yml` | Runs the gateway on a macOS runner and opens the dashboard tunnel (cloudflare/ngrok). |

## How it runs (via the deployer)
1. Deployer creates a repo in the user's account, drops in a workflow that **clones this project**, and dispatches it.
2. `gateway.yml` starts `server.js`, opens the chosen tunnel → prints the **dashboard URL**.
3. Log in with admin user/pass → create devices → open each at `URL/devicename`.

Devices run up to ~6h/session (GitHub runner limit).
