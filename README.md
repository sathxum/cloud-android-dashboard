# Cloud Android — Dashboard + Deployer

Deploy **real Android cloud devices** on GitHub's runners (macOS hardware-accelerated emulators), access them from anywhere over a Cloudflare/ngrok tunnel with a browser screen mirror (ws-scrcpy), all behind an admin login and per-device username/password.

This is a **single repo** that contains:

| Part | Path | What it is |
|------|------|-----------|
| **Deployer + Dashboard** | `index.html`, `app.js` | One HTML file you host anywhere (like soserupee). Enter GitHub user/repo/token + set an admin login → it configures this repo and boots devices. |
| **Device workflow** | `.github/workflows/android-device.yml` | Boots the Android AVD, screen-mirror server, auth proxy, and tunnel on a runner. |
| **Auth proxy** | `.github/scripts/auth-proxy.js` | Wraps the device with a username/password gate before the tunnel. |
| **Status reporter** | `.github/scripts/report-status.js` | Pushes each device's live URL/status into a private Gist the dashboard reads. |
| **Bundled copies** | `workflow/` | Same workflow/scripts, served to the page so it can self-install them into any target repo via the API. |

## How to use

1. **Host the deployer.** Take `index.html` + `app.js` (+ `workflow/`) and drop them on any static host (Netlify, Cloudflare Pages, Vercel, GitHub Pages, `soserupee`-style). It's a static site — no backend.
2. **Open it.** First run asks you to **set an admin username + password** (stored hashed in your browser). This gates the dashboard.
3. **Connect GitHub.** Enter your GitHub **username**, **repo** (this one, or any repo you want devices to run in), and a **classic token** with `repo` + `workflow` scopes. The page self-installs the workflow + scripts into that repo and creates a private status Gist.
4. **Create a device.** Pick Android version, hardware profile, RAM, storage, cores, and a **device access username/password**. Hit deploy → a workflow run boots it.
5. **Access it.** Within ~2–4 min the dashboard shows the device **online** with its URL. Open `URL` (or `URL/devicename`), log in with the device username/password, and you get a live Android screen in the browser.

## Notes

- **Real device specs** are read from the booted Android (`/proc/meminfo`, `/proc/cpuinfo`, `df /data`) and shown in the run log + dashboard — not faked.
- **Runners:** GitHub gives macOS (KVM/HAXM-style accel for fast x86_64 AVDs), Linux, and Windows. macOS is used because it boots real hardware-accelerated Android emulators reliably.
- **Token safety:** the token lives only in your browser (localStorage) and is sent directly to GitHub's API over HTTPS. Revoke it whenever you want.
- **Lifetime:** each device lives up to the job timeout (~5.5 h) then goes offline; redeploy to get a fresh one.
