---
description: "DSH mobile remote-control plugin (dsh-remote-lite): operate DSH from a phone over LAN or a Cloudflare tunnel, for users and deployers who need DSH away from the desktop."
kind: "package-reference"
---

# dsh-remote-lite

English | [中文](README.md)

## Overview

`dsh-remote-lite` moves DSH sessions onto a phone. The plugin starts an HTTP/SSE server on the host (default `:3090`); a phone browser pointed at it can browse workspaces and sessions, send instructions, switch agent modes and models, and approve tool calls. The plugin subscribes to DSH's `session/event` and `agent/status` events, replays execution progress into a mobile-shaped structure, and pushes it over SSE; user instructions travel back to the host over a reverse channel.

Two transports are available: plaintext HTTP on the local network, and an HTTPS tunnel through Cloudflare. The `cloudflared` binary the tunnel requires is fetched on demand and its lifetime owned by the plugin — it registers no system service, does not run at boot, and does not modify the hosts file. Given a Cloudflare API Token, the plugin creates the tunnel, writes the ingress rule, and writes the DNS record itself, so neither the command line nor manual dashboard configuration is required.

## Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further exploration](#further-exploration)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)
- [Dev note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install `dsh-remote-lite` into a profile and restart DSH. The default composition does not declare this plugin, so it must be installed explicitly and inserted as an active row.

```sh
dsh plugin add dsh-remote-lite
dsh web
```

On startup the plugin logs pairing addresses that include the access token:

```
[dsh-remote-lite] 已启动。手机打开下面任意一条：
[dsh-remote-lite]   内网  http://10.0.0.5:3090/mini?token=xxxx
```

The DSH Web UI's **Settings → Mobile remote** tab renders the pairing QR code; scanning it opens the mobile page.

### When to choose this

Choose this plugin when sessions need to be monitored, instructed, or approved from a phone without staying at the desktop UI. Deployments that only need desktop operation, or have no cross-device requirement, can skip it.

### Version compatibility

Install and startup check the runtime version against the `engines.dsh` range, declared here as `>=0.1.5-rc.2 <1.0.0`. When it does not match, DSH refuses to load the plugin and asks for an exact-version exemption.

### Configuring remote access

The LAN transport needs no configuration: the plugin binds all available interfaces by default (`bindAddress: "auto"`), so devices on the same Wi-Fi connect directly.

The public transport needs a Cloudflare API Token with `Account → Cloudflare Tunnel → Edit`, `Zone → DNS → Edit`, and `Zone → Zone → Read`. Paste it into the settings page and select **读取我的域名**; the plugin lists the zones the token can see. Pick one and save — the plugin then creates the tunnel, writes the ingress rule, writes the DNS record, and starts `cloudflared`.

The same page also accepts the run token of a tunnel already created in the Cloudflare dashboard (`eyJ...` form). That path skips every management API call, but the DNS record must be configured by the deployer.

The two transports resolve to these address forms:

| Transport | Address | Reach |
|---|---|---|
| LAN | `http://<host-ip>:3090/mini?token=<token>` | Same network |
| Public | `https://<hostname>/mini?token=<token>` | Any network |

The access token is viewable and editable in the settings page with a 12-character minimum. If unset on first start, the plugin generates a 32-character hex string and persists it.

### Configuration

Configuration lives at `$DSH_HOME/dsh-remote-lite/settings.json`, by default `~/.dsh/dsh-remote-lite/settings.json`. Three keys form a working minimum:

```json
{
  "port": 3090,
  "bindAddress": "auto",
  "token": ""
}
```

Every other field has a default. Field semantics, push channels (Bark / ntfy / Telegram), and per-item troubleshooting appear in the [configuration reference](docs/SETTINGS.md).

### Observable success and failure

A successful start logs `[dsh-remote-lite] 已启动` followed by pairing addresses, and `:3090` enters a listening state. A successful tunnel logs `固定隧道已连上：https://<hostname>` and the page reports connected.

Network-layer failures surface as `timeout` or `no recent network activity`; token or tunnel-state problems surface as `Invalid request headers` and `Tunnel not found`. The plugin installs no system service, so the server stops when DSH exits.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

This section explains how the plugin is wired; observable behavior is covered under [Use this package](#use-this-package).

### Design rationale

The plugin registers an HTTP server and several settings routes during `apply`, subscribes to DSH session events, and serves the mobile page as a single-file asset. It imports no runtime values from `@deepseek-ai/*` with one exception: `@deepseek-ai/schemastery`, used solely to declare `Config`. That dependency is supplied by the host (declared in `peerDependencies`, not `dependencies`) so a second copy never appears.

The tunnel process is owned by the plugin. The binary is resolved from the configured path, then system PATH, then the data directory's `bin/`, then downloaded from GitHub directly or through mirrors. Because no system service is registered, the plugin is mutually exclusive with an independently installed `cloudflared` service.

The mobile page is compressed on send according to `Accept-Encoding`, preferring brotli and falling back to gzip. This targets bandwidth-constrained tunnels: the 395 KB source compresses to roughly 109 KB under brotli.

### Source map

| File | Responsibility |
|---|---|
| [`lib/index.js`](lib/index.js) | Plugin entry: settings routes, tunnel orchestration, event subscription |
| [`lib/server.js`](lib/server.js) | Mobile HTTP and SSE server |
| [`lib/page.html`](lib/page.html) | Single-file mobile page |
| [`lib/tunnel.js`](lib/tunnel.js) | `cloudflared` process management |
| [`lib/cloudflare.js`](lib/cloudflare.js) | Cloudflare API calls and automatic tunnel provisioning |
| [`lib/cloudflared.js`](lib/cloudflared.js) | Binary lookup and download |
| [`lib/pairing.js`](lib/pairing.js) | Pairing data and QR code |
| [`client/client.js`](client/client.js) | Settings-page **Mobile remote** tab |

### Config declaration

`Config` is declared with schemastery. `defaultMode` and `notify` are marked volatile and apply without a reload; changes to `port`, `bindAddress`, `tunnel`, `token`, and `maxHistory` require reloading the plugin.

</details>

-----

<a id="further-exploration"></a>
## Further exploration

- [Configuration reference](docs/SETTINGS.md) — every field, push-channel setup, scenario examples, troubleshooting commands
- [Example configs](examples/) — complete LAN and public deployments
- [Changelog](CHANGELOG.md) — release history
- [Security policy](SECURITY.md) — threat model, credential storage, vulnerability reporting

-----

<a id="known-limitations-and-deferred-work"></a>
## Known limitations and deferred work

- The LAN transport is plaintext HTTP with no transport encryption; the token travels as a query parameter, so it is unsuitable on untrusted networks.
- Cloudflare edge addresses are unreachable on some networks. The plugin pins `--protocol http2 --edge-ip-version 4` to work around this, but cannot cover every environment.
- The tunnel's actual edge node is chosen by Cloudflare; cross-region access may be affected by link quality.
- The tunnel process is owned by the plugin; stop the plugin before uninstalling or migrating to an independent service.

-----

<a id="dev-note"></a>
## Dev note

```sh
npm install
npm run check     # syntax check
```

Link the repository into a profile for local development:

```sh
cd ~/.dsh/profiles/web
pnpm add link:D:/path/to/dsh-remote-lite
```

Then append `"dsh-remote-lite"` to `dsh.profile.bundles` in that `package.json`. Restart DSH after changing code. `prepublishOnly` runs the syntax check before an npm publish.

-----

## Acknowledgments

Derived from [dsh-mini-remote](https://github.com/xingzhen199186/dsh-mini-remote) by [@xingzhen199186](https://github.com/xingzhen199186).

## License

[MIT](LICENSE)
