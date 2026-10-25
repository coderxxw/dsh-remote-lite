---
description: "DSH mobile remote-control plugin (dsh-remote-lite): read sessions, send instructions and approve tool calls from a phone, over LAN or a Cloudflare tunnel — for users and deployers who need DSH away from the desktop."
kind: "package-reference"
---

# dsh-remote-lite

**DSH, on your phone.** The plugin starts an HTTP/SSE server on the host (default `:3090`); scan the pairing QR code and a phone browser can browse workspaces and sessions, send instructions, approve tool calls, and switch models and permission presets. Away from home, the same page is reachable through a Cloudflare tunnel — different address, same UI.

English | [中文](README.md)

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Install](#install)
- [Access](#access)
- [Config](#config)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#limitations)
- [Development](#dev)

-----

<a id="what-it-does"></a>
## What it does

| Capability | Where it lives on the phone |
|---|---|
| Sessions and workspaces | Left drawer: workspace → session tree; create sessions or workspaces, browse directories to pick a location |
| Three display modes | "Frame" shows only the latest answer · "Chat" shows full turns · "Full" also expands every step's reasoning and tool calls |
| Sending instructions | Bottom composer. Sending while a turn is running queues the message or steers into it (behaviour is configurable) |
| Slash commands | Type `/` to list the commands available in this session, tap to fill, then send |
| Attachments | Paperclip entry: choose a file or take a photo; uploads ride along with the next message |
| Approvals and questions | When the desktop side asks for a tool approval or asks you a question, a card appears on the phone — allow, deny, or answer |
| Subagents | A panel lists subagents; read their conversation, follow up, or stop one individually |
| Parameters | Model, reasoning effort and permission preset are set per session, using the same policy as the desktop |
| Desktop UI | "Advanced → Desktop UI" reverse-proxies the native DSH GUI, for the settings pages the mobile UI cannot reach |
| External push | Bark / ntfy / Telegram when the phone is locked; system notifications when the page is in the background and served over HTTPS |
| Plugins and version | The settings sheet shows loaded plugins, the DSH version, and this plugin's build fingerprint |

-----

<a id="quick-start"></a>
## Quick start

```sh
# 1. install
dsh plugin --profile web add github:coderxxw/dsh-remote-lite

# 2. start
dsh web
```

3. Open the DSH Web UI → **Settings → Mobile remote** and scan the QR code, or use an address printed in the startup log:

```
[dsh-remote-lite] 已启动。手机打开下面任意一条（或到 DSH 设置 → 手机遥控 扫码）：
[dsh-remote-lite]   本机  http://127.0.0.1:3090/mini?token=xxxx
[dsh-remote-lite]   内网  http://10.0.0.5:3090/mini?token=xxxx
```

The LAN route works out of the box. To connect from outside, add a [tunnel](#tunnel).

-----

<a id="install"></a>
## Install

This package is **not published to npm**. Two install paths exist, and both require an explicit `--profile` — `dsh plugin` does not infer the target profile.

### From GitHub

```sh
dsh plugin --profile web add github:coderxxw/dsh-remote-lite
```

This resolves to the latest commit on `main`, so the installed version tracks the repository rather than a published release.

### From a local path (development)

For machines that already hold a clone and need edits to take effect immediately:

```sh
dsh plugin --profile web add link:/path/to/dsh-remote-lite
```

On Windows, write `link:D:/path/to/dsh-remote-lite`.

### Confirm it actually loaded

`dsh plugin add` appends the package name to the profile's `dsh.profile.bundles`. If that array lacks `"dsh-remote-lite"`, the plugin will not load — and there is **no error**, just silence.

```sh
node -e "console.log(require('C:/Users/<you>/.dsh/profiles/web/package.json').dsh.profile.bundles)"
```

### Version compatibility

Install and startup check the runtime against the `engines` range:

| Dependency | Range |
|---|---|
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| DSH | `>=0.1.5-rc.2 <1.0.0` |

When it does not match, DSH refuses to load the plugin and asks for an exact-version exemption.

-----

<a id="access"></a>
## Access

| Route | Address | Reach | Requires |
|---|---|---|---|
| LAN | `http://<host-ip>:3090/mini?token=<token>` | Same Wi-Fi | Nothing |
| Public | `https://<hostname>/mini?token=<token>` | Any network | Cloudflare account + a domain |

The LAN route is on by default: with `bindAddress: "auto"` the plugin binds every usable interface (virtual adapters are skipped) and keeps the loopback address so the pairing page opens on the desktop.

<a id="tunnel"></a>
### Configuring a tunnel

You need a Cloudflare API Token with:

- `Account → Cloudflare Tunnel → Edit`
- `Zone → DNS → Edit`
- `Zone → Zone → Read`

Paste the token in the settings page → click "读取我的域名" → pick a domain and save. The plugin then **creates the tunnel, writes the ingress rule, writes the DNS record, and starts `cloudflared`** — no command line, no manual dashboard configuration.

The same page also accepts the **run token** of a tunnel that already exists (`eyJ...`). That path skips every management API call, but the DNS record is yours to configure.

### The access token

The token is viewable and editable in the settings page, with a **12-character minimum**. If unset on first start, the plugin generates a 32-character hex string and persists it. Changing it requires a plugin reload.

The token travels as a query parameter on first visit and is then stored in a cookie. **The LAN route is plaintext HTTP**, so it is unsuitable on untrusted networks.

-----

<a id="config"></a>
## Config

Configuration lives at `$DSH_HOME/dsh-remote-lite/settings.json` (default `~/.dsh/dsh-remote-lite/settings.json`). Three keys form a working minimum:

```json
{
  "port": 3090,
  "bindAddress": "auto",
  "token": ""
}
```

| Field | Default | Meaning | After editing |
|---|---|---|---|
| `port` | `3090` | Port the phone connects to | Reload |
| `bindAddress` | `"auto"` | `auto` / `127.0.0.1` / a specific IP | Reload |
| `token` | empty | Access token; empty = generated on first start | Reload |
| `maxHistory` | `50` | How many history entries the phone keeps per session | Reload |
| `defaultMode` | `"minimal"` | Starting mode: `minimal` / `chat` / `full` | Live |
| `tunnel.enabled` | `false` | Expose over a tunnel (off by default — putting the service on the public internet is the user's call) | Reload |
| `tunnel.mode` | `"quick"` | `quick` (no account, URL changes every restart) / `named` (fixed domain) | Reload |
| `tunnel.hostname` | empty | Domain for a named tunnel, e.g. `dsh.example.com` | Reload |
| `tunnel.apiToken` | empty | Management API token, for automatic provisioning | Reload |
| `tunnel.tunnelToken` | empty | Run token of an existing tunnel; skips the management API | Reload |
| `tunnel.accountId` | empty | Empty = the single account the token can see | Reload |
| `notify.*` | empty | Bark / ntfy / Telegram push | Live |

Field semantics, push-channel setup and per-item troubleshooting live in the [configuration reference](docs/SETTINGS.md).

> One naming legacy: if `$DSH_HOME/dsh-mini-remote-lite` already exists, the plugin **reuses it** instead of creating `dsh-remote-lite` — renaming the directory would throw away the configured token and tunnel credentials.

-----

<a id="how-it-works"></a>
## How it works

<details>
<summary>Implementation details — click to expand</summary>

### The round trip of one instruction

```
phone browser ──POST /mini/api/send──▶ plugin server.js
                                        │ build MessageId, submit to the DSH session
                                        ▼
                                     DSH agent
                                        │ session/event (turn/start, user/message,
                                        │ assistant/message, tool/call, turn/end…)
                                        ▼
                                     index.js subscribes
                                        │ events.js / trajectory.js classify
                                        ├─▶ store.js (latest + history + trajectory)
                                        └─▶ SSE /mini/api/stream ──▶ phone re-renders
```

The plugin does **not** proxy the desktop UI: the phone gets two things, instructions and answers, with intermediate steps expanded on demand.

### Three design choices

1. **No runtime imports from `@deepseek-ai/*`.** The single exception is `@deepseek-ai/schemastery`, used only to declare `Config`. It is supplied by the host (`peerDependencies`), so a second copy never appears and cordis is never duplicated.
2. **Its own `node:http` server, not `ctx.webServer`.** The host web server can only bind `127.0.0.1` or `0.0.0.0`; exposing the main GUI on `0.0.0.0` is unacceptable, while the plugin must bind exactly the interfaces its config names.
3. **SSE instead of WebSocket.** Zero dependencies, `EventSource` reconnects on its own (the phone recovers after being backgrounded), and only server → phone push is needed — the reverse direction is an ordinary POST.

Streaming uses **confirm before reveal**: `text-delta` text is buffered and never shown; a `tool-call-delta` marks the step as intermediate and the buffer is discarded (no narration flash); only when the step ends without a tool call is it confirmed as the final answer, flushed in full, then streamed frame by frame. The cost is first-token latency; the gain is that nothing appears and then vanishes.

### Source map

| Group | File | Responsibility |
|---|---|---|
| Entry | `lib/index.js` | Plugin entry: `apply` / `Config` / event subscription / settings routes / tunnel orchestration |
| Transport | `lib/server.js` | Mobile HTTP + SSE server, all of `/mini/api/*` |
| | `lib/page.html` | Single-file mobile page (~395 KB of source) |
| | `lib/page.js` | Page template injection (default mode, token gate, build fingerprint) and image assets |
| | `lib/build.js` | Build fingerprint: answers "is the process replying to me the code I just edited?" |
| | `lib/sw.js` | Service worker that exists only for system notifications; caches nothing |
| Session data | `lib/events.js` | Raw events → visible text; decides which step counts as the final answer |
| | `lib/history.js` | Replays a session log into chat history (same extractor as the live path) |
| | `lib/trajectory.js` | Replays reasoning, tool calls and tool results into "process groups" |
| | `lib/store.js` | In-memory state (latest answer / history / trajectory / queue / presence); disk is only for surviving restarts |
| | `lib/log-tail.js` | Reads DSH session logs directly (zstd included) to backfill history the plugin never witnessed |
| | `lib/tree.js` | Workspace → session tree for the left drawer |
| | `lib/commands.js` | Folding slash-command events into a status line |
| Caches | `lib/title-cache.js` | Session titles (7-day TTL) |
| | `lib/session-meta-cache.js` | Session metadata cache |
| | `lib/subagent-cache.js` | Subagent list cache (debounced + TTL) |
| Capabilities | `lib/permissions.js` | Read and switch permission presets |
| | `lib/browse.js` | Directory browsing and mkdir, for choosing workspace locations |
| | `lib/notify.js` | Bark / ntfy / Telegram push |
| Tunnel | `lib/tunnel.js` | `cloudflared` lifecycle and readiness detection |
| | `lib/cloudflared.js` | Binary lookup and on-demand download |
| | `lib/cloudflare.js` | Management API: create tunnel, write ingress, write DNS |
| | `lib/net.js` | Interface selection and bind-address resolution |
| | `lib/pairing.js` | Pairing payload and QR code |
| Mirror | `lib/mirror.js` | Reverse-proxies the desktop GUI through the plugin port (header-rewriting proxy, WebSocket passthrough) |
| Settings UI | `client/client.js` | The **Mobile remote** tab inside DSH settings |

### Endpoints

On the plugin's own server (`:3090`):

| Group | Path | Purpose |
|---|---|---|
| Page | `GET /mini`, `/mini/art/*`, `/mini/sw.js` | The page, artwork and inline images, service worker |
| State | `GET /mini/api/state` | Full snapshot (latest answer, history, trajectory, queue, presence) |
| | `GET /mini/api/stream` | The SSE channel |
| | `GET /mini/api/history`, `/trajectory`, `/subagents`, `/version` | Paged history, execution trajectory, subagent list, build fingerprint |
| Commands | `POST /mini/api/send`, `/command`, `/stop`, `/unqueue` | Send, run a slash command, stop, dequeue |
| | `POST /mini/api/upload` | Attachment upload |
| Interaction | `POST /mini/api/approval`, `/answer`, `/subagent/ask`, `/set-model`, `/permissions` | Approval, answer, follow up a subagent, switch model, switch permission preset |
| Navigation | `GET /mini/api/workspaces`, `/browse`, `/browse/roots`; `POST /mini/api/bind`, `/browse/mkdir` | Session tree, directory browsing, bind session, mkdir |
| Misc | `GET /mini/api/plugins`, `/models`, `/commands`, `/mirror` | Plugin list, model list, command table, mirror toggle |

On the host web server (default `:10001`), used by the settings tab:

| Path | Purpose |
|---|---|
| `GET /mini-remote/pairing` | Pairing payload (addresses, QR code, tunnel state) |
| `POST /mini-remote/tunnel/zones` | Domains the token can see |
| `POST /mini-remote/tunnel`, `/tunnel/named` | Start/stop and configure quick / named tunnels |
| `POST /mini-remote/token` | Change the access token |

Every route checks the token; the settings group additionally accepts loopback requests only.

### Build fingerprint

`lib/build.js` hashes a handful of source files into a short fingerprint, returned by `/mini/api/version`:

```sh
curl -s "http://127.0.0.1:3090/mini/api/version?token=<token>"
# {"ok":true,"build":"dfa3c69b7b66","dshVersion":"0.2.1-rc.2","canCreateSession":true}
```

After a restart, compare this before concluding anything about new versus old behaviour — the previous process keeps answering during a restart, which has misled us twice.

</details>

-----

<a id="troubleshooting"></a>
## Troubleshooting

| Symptom | Check first |
|---|---|
| The plugin seems absent | Is `"dsh-remote-lite"` in `dsh.profile.bundles`? Is `node_modules/qrcode` installed (common with `link:` installs)? |
| Phone cannot connect | Is `:3090` listening? Did Windows Firewall allow the private network? Same Wi-Fi? |
| Page stuck on "connecting" | Hit `/mini/api/version` — 200 or not? Then read DSH log lines starting with `[dsh-remote-lite]` |
| Token gate instead of the page | Wrong or changed token; carry the right `?token=`, or re-scan from the settings page |
| Tunnel will not connect | See the keywords below; turn off any proxy/VPN (Clash and friends) on the desktop first |
| No notifications | System notifications need a secure context (the tunnel provides HTTPS, plaintext LAN does not); otherwise configure Bark / ntfy / Telegram |
| Code edits change nothing | `page.html` and `sw.js` are read into memory at startup — **restart DSH**; confirm with the build fingerprint |

Tunnel log keywords:

| Keyword | Meaning |
|---|---|
| `Registered tunnel connection` | Success |
| `Tunnel not found` | The tunnel was deleted; recreate it |
| `Invalid request headers` | Wrong token type (management token vs tunnel run token) |
| `timeout` / `no recent network activity` | Network layer is unreachable; the plugin already pins `--protocol http2 --edge-ip-version 4` |

No system service is registered, so the server stops when DSH exits. Caches such as `state.json` can be deleted at will; deleting `settings.json` or `token` means reconfiguring and re-pairing.

-----

<a id="limitations"></a>
## Known limitations

- The LAN route is **plaintext HTTP** with no transport encryption, and the token travels as a query parameter — unsuitable on untrusted networks.
- Cloudflare edge addresses are unreachable on some networks. The plugin pins `--protocol http2 --edge-ip-version 4` to work around it, which cannot cover every environment.
- The tunnel's edge node is chosen by Cloudflare; cross-region access may suffer from link quality.
- The tunnel process is owned by the plugin; stop the plugin before uninstalling or migrating to an independent service.
- The mobile page is a single file and therefore large on first load — mitigated by content negotiation: 395 KB of source → ~110 KB brotli (~141 KB gzip).
- Skills listing and body retrieval already exist server-side (`/mini/api/skills`, `/mini/api/skill`), but the **phone-side picker is not wired up yet** and is not exposed in the UI.

-----

<a id="dev"></a>
## Development

```sh
npm install
npm run check     # syntax check (index / server / tunnel / client)
```

For local development install through `link:` (see [From a local path](#install)); restart DSH after editing, no reinstall needed.

Two easy traps:

- `page.html` and `sw.js` are **read into memory at startup** — code edits require a DSH restart; reinstalling does nothing.
- `dsh plugin add` maintains `dsh.profile.bundles` for you; if you edit it by hand, the entry must match the package name exactly.

`prepublishOnly` runs the syntax check before publishing.

-----

## Acknowledgments

Derived from [dsh-mini-remote](https://github.com/xingzhen199186/dsh-mini-remote) by [@xingzhen199186](https://github.com/xingzhen199186); this package restructures it around two transports and zero-command-line deployment.

## License

[MIT](LICENSE)
