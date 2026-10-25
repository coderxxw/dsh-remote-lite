---
description: "DSH 手机遥控插件（dsh-remote-lite）：通过局域网或 Cloudflare 隧道在手机上远程操作 DSH，供需要脱离桌面使用 DSH 的用户与部署方阅读。"
kind: "package-reference"
---

# dsh-remote-lite

[English](README.en.md) | 中文

## 概述

`dsh-remote-lite` 为 DSH 提供一个移动端远程操作界面。插件在宿主机上启动一个 HTTP/SSE 服务（默认 `:3090`），手机浏览器访问该服务即可查看工作区与会话、发送指令、切换 agent 模式与模型、审批工具调用。插件订阅 DSH 的 `session/event` 与 `agent/status` 事件，将执行过程重放为移动端结构后经 SSE 推送；用户指令经反向通道回注宿主。

远程访问有两条通路：局域网明文 HTTP，以及经 Cloudflare 的 HTTPS 隧道。隧道所需的 `cloudflared` 由插件按需获取并管理生命周期，不注册系统服务、不开机自启、不修改 hosts。给定 Cloudflare API Token 时，插件自行创建隧道、写入 ingress 规则并配置 DNS 记录，因此命令行与后台手工配置均非必需。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将 `dsh-remote-lite` 安装到 profile 并重启 DSH。默认组合不声明该插件；使用它需要安装包并在活动组合中插入插件行。

```sh
dsh plugin add dsh-remote-lite
dsh web
```

插件启动后日志输出配对地址，其中包含访问口令：

```
[dsh-remote-lite] 已启动。手机打开下面任意一条：
[dsh-remote-lite]   内网  http://10.0.0.5:3090/mini?token=xxxx
```

在 DSH Web 界面的 **设置 → 手机遥控** 中可查看配对二维码，扫码即进入移动端页面。

### 何时选择

当需要在手机上查看会话状态、下发指令或审批工具调用，而不希望停留在桌面界面时，选择此插件。仅需桌面操作或没有跨设备访问需求的部署可跳过。

### 配置远程访问

局域网通路无需配置：插件默认监听全部可用网卡（`bindAddress: "auto"`），同一 Wi-Fi 下的设备可直接访问。

公网通路需要一份 Cloudflare API Token，权限为 `Account → Cloudflare Tunnel → Edit`、`Zone → DNS → Edit` 与 `Zone → Zone → Read`。在设置页粘贴该 Token 后点击「读取我的域名」，插件列出令牌可见的域名；选定其一并保存，插件随即完成隧道创建、ingress 写入、DNS 记录写入与 `cloudflared` 启动。设置页也接受在 Cloudflare 后台已创建隧道的运行令牌（`eyJ...` 形式），此时 DNS 记录需由部署方自行配置。

两条通路的地址形式如下：

| 通路 | 地址 | 可用范围 |
|---|---|---|
| 局域网 | `http://<宿主IP>:3090/mini?token=<口令>` | 同一网络 |
| 公网 | `https://<域名>/mini?token=<口令>` | 任意网络 |

访问口令在设置页可查看与修改，最小长度 12 位。首次启动若未配置口令，插件生成 32 位十六进制串并落盘。

### 配置文件

配置位于 `$DSH_HOME/dsh-remote-lite/settings.json`，默认路径为 `~/.dsh/dsh-remote-lite/settings.json`。最小可用配置只需三项：

```json
{
  "port": 3090,
  "bindAddress": "auto",
  "token": ""
}
```

其余字段均有默认值。字段语义、推送通道（Bark / ntfy / Telegram）与逐项排查见[配置参考](docs/SETTINGS.md)。

### 可观察的成功与失败

启动成功时日志出现 `[dsh-remote-lite] 已启动` 及其后的配对地址，且 `:3090` 进入监听状态。隧道成功时日志出现 `固定隧道已连上：https://<域名>`，页面状态显示已连接；网络层失败表现为 `timeout` 或 `no recent network activity`，令牌或隧道状态问题表现为 `Invalid request headers` 与 `Tunnel not found`。插件不安装系统服务，DSH 退出时服务随之停止。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明插件如何接线；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

插件在 `apply` 阶段注册一个 HTTP 服务与若干设置路由，订阅 DSH 的会话事件，并把移动端页面作为单文件资源提供。插件不 import 任何 `@deepseek-ai/*` 的运行时值，唯一例外是 `@deepseek-ai/schemastery`，仅用于声明 `Config`。该依赖由宿主提供（列入 `peerDependencies` 而非 `dependencies`），以免出现第二份副本。

隧道进程由插件自身托管：二进制优先使用配置路径、系统 PATH、数据目录 `bin/`，均不存在时按顺序尝试 GitHub 直链与镜像下载。插件不注册系统服务，因此与独立安装的 `cloudflared` 服务互斥。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`lib/index.js`](lib/index.js) | 插件入口：设置路由、隧道编排、事件订阅 |
| [`lib/server.js`](lib/server.js) | 移动端 HTTP 与 SSE 服务 |
| [`lib/page.html`](lib/page.html) | 移动端单文件页面 |
| [`lib/tunnel.js`](lib/tunnel.js) | `cloudflared` 进程管理 |
| [`lib/cloudflare.js`](lib/cloudflare.js) | Cloudflare API 调用与隧道自动配置 |
| [`lib/cloudflared.js`](lib/cloudflared.js) | 二进制查找与下载 |
| [`lib/pairing.js`](lib/pairing.js) | 配对信息与二维码 |
| [`client/client.js`](client/client.js) | 设置页「手机遥控」标签页 |

### 配置声明

插件以 schemastery 声明 `Config`。`defaultMode` 与 `notify` 标记为 volatile，修改后无需重载；`port`、`bindAddress`、`tunnel`、`token`、`maxHistory` 的变更需重载插件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [配置参考](docs/SETTINGS.md) — 全部字段语义、推送通道配置、场景示例与排查命令
- [示例配置](examples/) — 局域网与公网两种部署的完整配置
- [变更日志](CHANGELOG.md) — 各版本的变更记录
- [安全策略](SECURITY.md) — 威胁模型、凭据存放与漏洞报告渠道

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 局域网通路为明文 HTTP，不提供传输加密；口令以查询参数传递，因此不适用于不可信网络。
- 部分网络中 Cloudflare 边缘地址不可达，插件固定 `--protocol http2 --edge-ip-version 4` 以规避，但无法覆盖全部网络环境。
- 隧道进程由插件托管，卸载或切换为独立服务前需先停止插件。

-----

<a id="dev-note"></a>
## 开发备注

```sh
npm install
npm run check     # 语法检查
```

本地调试时将仓库链接进 profile：

```sh
cd ~/.dsh/profiles/web
pnpm add link:D:/path/to/dsh-remote-lite
```

并在 `package.json` 的 `dsh.profile.bundles` 数组中追加 `"dsh-remote-lite"`。改代码后重启 DSH 生效。

npm 发布前 `prepublishOnly` 会执行语法检查。

-----

## 致谢

源自 [dsh-mini-remote](https://github.com/xingzhen199186/dsh-mini-remote)（[@xingzhen199186](https://github.com/xingzhen199186)）。

## License

[MIT](LICENSE)
