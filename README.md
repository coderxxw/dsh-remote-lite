---
description: "DSH 手机遥控插件（dsh-remote-lite）：在手机上查看会话、下发指令、审批工具调用，局域网直连或经 Cloudflare 隧道，供需要脱离桌面使用 DSH 的用户与部署方阅读。"
kind: "package-reference"
---

# dsh-remote-lite

**把 DSH 搬到手机上。** 插件在宿主起一个 HTTP/SSE 服务（默认 `:3090`），手机浏览器扫码即进：看工作区与会话、发指令、审批工具调用、切模型与权限档位。出门在外走 Cloudflare 隧道，同一个页面，换个地址。

[English](README.en.md) | 中文

## 目录

- [能做什么](#what-it-does)
- [快速开始](#quick-start)
- [安装](#install)
- [访问与配对](#access)
- [配置](#config)
- [工作原理](#how-it-works)
- [排错](#troubleshooting)
- [已知限制](#limitations)
- [开发](#dev)

-----

<a id="what-it-does"></a>
## 能做什么

| 能力 | 在手机上怎么用 |
|---|---|
| 会话与工作区 | 左侧抽屉：工作区 → 会话树，可新建会话、新建工作区、浏览目录挑位置 |
| 三档显示 | 「单帧」只看最新一条回答｜「聊天」看完整往返｜「完整」额外展开每一轮的思考与工具调用 |
| 下发指令 | 底部输入框。跑着的时候再发，会**排队**或**插话**（行为可在设置里选） |
| 斜杠指令 | 输入 `/` 弹出当前会话可用的指令，点选填入后发送 |
| 附件 | 回形针入口「选文件」或「拍照」，传完随下一条消息一起发出 |
| 审批与提问 | 电脑端触发工具审批、或向你提问时，手机弹卡片，可直接同意 / 拒绝 / 作答 |
| 子智能体 | 面板列出子代理，可看它的对话、追问、单独停止 |
| 参数调整 | 模型、思考强度、权限档位按会话单独设置，与电脑端同一套政策 |
| 电脑端界面 | 「进阶设置 → 电脑端界面」把 DSH 原生 GUI 反代过来，插件自己的设置页在手机上够不着时用它 |
| 外部推送 | 锁屏时用 Bark / ntfy / Telegram 兜底；页面在后台且为 HTTPS 时可用系统通知 |
| 插件与版本 | 设置页可看已加载插件清单、当前 DSH 版本与本插件的构建指纹 |

-----

<a id="quick-start"></a>
## 快速开始

```sh
# 1. 装
dsh plugin --profile web add github:coderxxw/dsh-remote-lite

# 2. 起
dsh web
```

3. 打开 DSH Web 界面 → **设置 → 手机遥控**，扫二维码；或直接用启动日志里打印的地址：

```
[dsh-remote-lite] 已启动。手机打开下面任意一条（或到 DSH 设置 → 手机遥控 扫码）：
[dsh-remote-lite]   本机  http://127.0.0.1:3090/mini?token=xxxx
[dsh-remote-lite]   内网  http://10.0.0.5:3090/mini?token=xxxx
```

局域网这条开箱即用。要从外面连，再配[公网隧道](#tunnel)。

-----

<a id="install"></a>
## 安装

本包**尚未发布到 npm**，只有两条安装路径，且都必须显式带 `--profile` —— `dsh plugin` 不会替你推断目标 profile。

### 从 GitHub

```sh
dsh plugin --profile web add github:coderxxw/dsh-remote-lite
```

拉的是 `main` 的最新提交，所以版本随仓库走，不跟已发布版本。

### 从本地路径（开发用）

本机已有仓库副本、要改代码即时生效时：

```sh
dsh plugin --profile web add link:/path/to/dsh-remote-lite
```

Windows 写作 `link:D:/path/to/dsh-remote-lite`。

### 确认真的加载了

`dsh plugin add` 会把包名追加进 profile 的 `dsh.profile.bundles`。该数组里没有 `"dsh-remote-lite"`，插件就不会加载 —— 而且**不会报错**，只是安静地什么都没发生。

```sh
node -e "console.log(require('C:/Users/<你>/.dsh/profiles/web/package.json').dsh.profile.bundles)"
```

### 版本兼容

安装与启动会按 `engines` 声明的范围校验，本包要求：

| 依赖 | 范围 |
|---|---|
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| DSH | `>=0.1.5-rc.2 <1.0.0` |

不满足时 DSH 拒绝加载并提示需要精确版本豁免。

-----

<a id="access"></a>
## 访问与配对

| 通路 | 地址 | 可用范围 | 前提 |
|---|---|---|---|
| 局域网 | `http://<宿主IP>:3090/mini?token=<口令>` | 同一 Wi-Fi | 无 |
| 公网 | `https://<域名>/mini?token=<口令>` | 任意网络 | Cloudflare 账号 + 域名 |

局域网默认就开：插件按 `bindAddress: "auto"` 监听全部可用网卡（虚拟网卡会被跳过），本机地址也留着，方便在电脑上打开配对页。

<a id="tunnel"></a>
### 配公网隧道

需要一份 Cloudflare API Token，权限为：

- `Account → Cloudflare Tunnel → Edit`
- `Zone → DNS → Edit`
- `Zone → Zone → Read`

在设置页粘贴 Token → 点「读取我的域名」→ 选域名并保存。插件随即完成**建隧道、写 ingress、写 DNS 记录、拉起 `cloudflared`** 四步，不需要命令行，也不需要在 Cloudflare 后台手工配置。

设置页也接受一条**已存在隧道的运行令牌**（`eyJ...` 形式）：这条路跳过全部管理 API 调用，但 DNS 记录要你自己配好。

### 口令

访问口令在设置页可查看与修改，**最短 12 位**。首次启动若未配置，插件生成 32 位十六进制串并落盘。改完口令需重载插件。

口令以查询参数形式出现，首次访问后写入 cookie，之后不必再带。**局域网通路是明文 HTTP**，不适合不可信网络。

-----

<a id="config"></a>
## 配置

配置在 `$DSH_HOME/dsh-remote-lite/settings.json`（默认 `~/.dsh/dsh-remote-lite/settings.json`）。最小可用配置只要三项：

```json
{
  "port": 3090,
  "bindAddress": "auto",
  "token": ""
}
```

| 字段 | 默认 | 说明 | 改动后 |
|---|---|---|---|
| `port` | `3090` | 手机访问端口 | 需重载 |
| `bindAddress` | `"auto"` | `auto` / `127.0.0.1` / 具体 IP | 需重载 |
| `token` | 空 | 访问口令，空 = 首次启动自动生成 | 需重载 |
| `maxHistory` | `50` | 每个会话在手机上保留多少条历史 | 需重载 |
| `defaultMode` | `"minimal"` | 打开时进哪一档：`minimal` / `chat` / `full` | 即时生效 |
| `tunnel.enabled` | `false` | 是否启公网隧道（默认关：把服务挂到公网上该由你自己决定） | 需重载 |
| `tunnel.mode` | `"quick"` | `quick`（免账号，网址每次变）/ `named`（固定域名） | 需重载 |
| `tunnel.hostname` | 空 | 固定隧道要用的域名，如 `dsh.example.com` | 需重载 |
| `tunnel.apiToken` | 空 | 管理 API Token，自动建隧道用 | 需重载 |
| `tunnel.tunnelToken` | 空 | 已有隧道的运行令牌，跳过管理 API | 需重载 |
| `tunnel.accountId` | 空 | 留空 = 用 Token 能看见的那个账号 | 需重载 |
| `notify.*` | 空 | Bark / ntfy / Telegram 推送 | 即时生效 |

字段语义、推送通道的具体配法、逐项排查命令，见[配置参考](docs/SETTINGS.md)。

> 数据目录名有一处历史遗留：若 `$DSH_HOME/dsh-mini-remote-lite` 已存在，插件**沿用它**而不是新建 `dsh-remote-lite` —— 换目录名会把已配好的口令与隧道令牌全丢掉。

-----

<a id="how-it-works"></a>
## 工作原理

<details>
<summary>实现细节 —— 点击展开</summary>

### 一条指令的来回

```
手机浏览器 ──POST /mini/api/send──▶ 插件 server.js
                                      │ 造 MessageId、投进 DSH 会话
                                      ▼
                                   DSH agent
                                      │ session/event（turn/start、user/message、
                                      │ assistant/message、tool/call、turn/end…）
                                      ▼
                                   index.js 订阅
                                      │ events.js / trajectory.js 分类
                                      ├─▶ store.js（最新一条 + 历史 + 轨迹）
                                      └─▶ SSE /mini/api/stream ──▶ 手机重绘
```

插件本身**不代理桌面界面**：手机只拿「指令」和「回答」两样东西，中间过程按需展开。

### 三条设计取舍

1. **不 import 任何 `@deepseek-ai/*` 的运行时值。** 唯一例外是 `@deepseek-ai/schemastery`，只用来声明 `Config`；它由宿主提供（写在 `peerDependencies`），避免出现第二份副本引发 cordis 双实例问题。
2. **自己起 `node:http`，不挂 `ctx.webServer`。** 宿主 Web 服务只能绑 `127.0.0.1` 或 `0.0.0.0`，把主 GUI 暴露到 `0.0.0.0` 不可接受；而插件要按配置精确绑定到指定网卡。
3. **SSE 而不是 WebSocket。** 零依赖、`EventSource` 自带断线重连（手机切后台回来能自愈），且只需要「服务端→手机」单向推送，反向用普通 POST 就够。

流式输出采用**事后确认再推**：`text-delta` 先缓存不外露，一旦出现 `tool-call-delta` 就判定这一步是中间步骤、整段丢弃（旁白零闪现）；直到这一步收尾仍无工具调用，才确认是最终回答、一次性补齐并转入逐帧推送。代价是首字延迟，换来的是「不闪一下就没」。

### 源码地图

| 分组 | 文件 | 职责 |
|---|---|---|
| 入口 | `lib/index.js` | 插件入口：`apply` / `Config` / 事件订阅 / 设置面路由 / 隧道编排 |
| 传输 | `lib/server.js` | 移动端 HTTP + SSE 服务，全部 `/mini/api/*` |
| | `lib/page.html` | 移动端单文件页面（约 395 KB 源码） |
| | `lib/page.js` | 页面模板注入（默认模式、口令门禁、构建指纹）与图片资产 |
| | `lib/build.js` | 构建指纹：确认「现在应答我的是不是刚改的那份代码」 |
| | `lib/sw.js` | service worker，只为系统通知而存在，不缓存任何请求 |
| 会话数据 | `lib/events.js` | 原始事件 → 可见文本；判定「哪一步才算最终回答」 |
| | `lib/history.js` | 把会话日志重放成聊天记录（与实时路径共用同一个提取器） |
| | `lib/trajectory.js` | 把思考、工具调用、工具结果重放成「过程组」 |
| | `lib/store.js` | 内存状态（最新回答 / 历史 / 轨迹 / 队列 / 在线），落盘只为重启后仍可读 |
| | `lib/log-tail.js` | 直接读 DSH 会话日志（含 zstd 解压），补上插件不在场时的历史 |
| | `lib/tree.js` | 工作区 → 会话树，供左侧导航 |
| | `lib/commands.js` | 斜杠指令事件的折叠与状态行 |
| 缓存 | `lib/title-cache.js` | 会话标题缓存（TTL 7 天） |
| | `lib/session-meta-cache.js` | 会话元数据缓存 |
| | `lib/subagent-cache.js` | 子智能体清单缓存（防抖 + TTL） |
| 能力 | `lib/permissions.js` | 权限档位的读取与切换 |
| | `lib/browse.js` | 目录浏览与新目录创建（选工作区位置用） |
| | `lib/notify.js` | Bark / ntfy / Telegram 三种外部推送 |
| 隧道 | `lib/tunnel.js` | `cloudflared` 进程生命周期与就绪判定 |
| | `lib/cloudflared.js` | 二进制查找与按需下载 |
| | `lib/cloudflare.js` | 管理 API：建隧道、写 ingress、写 DNS |
| | `lib/net.js` | 网卡挑选与监听地址解析 |
| | `lib/pairing.js` | 配对信息与二维码 |
| 镜像 | `lib/mirror.js` | 把电脑端 GUI 经本插件端口反代出去（改头代理，含 WebSocket 透传） |
| 设置页 | `client/client.js` | DSH 设置里的「手机遥控」标签页 |

### 接口一览

插件自有服务（`:3090`）上：

| 分组 | 路径 | 用途 |
|---|---|---|
| 页面 | `GET /mini`、`/mini/art/*`、`/mini/sw.js` | 页面本体、立绘与正文图片、service worker |
| 状态 | `GET /mini/api/state` | 完整快照（最新回答、历史、轨迹、队列、在线状态） |
| | `GET /mini/api/stream` | SSE 主通道 |
| | `GET /mini/api/history`、`/trajectory`、`/subagents`、`/version` | 分页历史、执行轨迹、子代理清单、构建指纹 |
| 指令 | `POST /mini/api/send`、`/command`、`/stop`、`/unqueue` | 发送、跑斜杠指令、停止、取消排队 |
| | `POST /mini/api/upload` | 附件上传 |
| 交互 | `POST /mini/api/approval`、`/answer`、`/subagent/ask`、`/set-model`、`/permissions` | 审批、答题、追问子代理、切模型、切权限档位 |
| 导航 | `GET /mini/api/workspaces`、`/browse`、`/browse/roots`；`POST /mini/api/bind`、`/browse/mkdir` | 会话树、目录浏览、绑定会话、新建目录 |
| 其它 | `GET /mini/api/plugins`、`/models`、`/commands`、`/mirror` | 插件清单、模型列表、指令表、镜像开关 |

挂在宿主 Web 服务（默认 `:10001`）上、供设置页调用的：

| 路径 | 用途 |
|---|---|
| `GET /mini-remote/pairing` | 配对信息（地址、二维码、隧道状态） |
| `POST /mini-remote/tunnel/zones` | 读 Token 可见的域名 |
| `POST /mini-remote/tunnel`、`/tunnel/named` | 快速隧道 / 固定隧道的启停与配置 |
| `POST /mini-remote/token` | 改访问口令 |

所有路由都校验口令；设置面那组额外限定只接受本机请求。

### 构建指纹

`lib/build.js` 把几个源文件的内容揉成一个短哈希，`/mini/api/version` 会返回它：

```sh
curl -s "http://127.0.0.1:3090/mini/api/version?token=<口令>"
# {"ok":true,"build":"dfa3c69b7b66","dshVersion":"0.2.1-rc.2","canCreateSession":true}
```

改完代码重启后先比这个指纹，再判断「看到的是新行为还是旧行为」—— 重启期间旧进程还在应答，这件事误判过两次。

</details>

-----

<a id="troubleshooting"></a>
## 排错

| 现象 | 先查什么 |
|---|---|
| 插件像没装 | `dsh.profile.bundles` 里有没有 `"dsh-remote-lite"`；`node_modules/qrcode` 是否装上（`link:` 安装常见） |
| 手机打不开 | `:3090` 是否处于 LISTEN；Windows 防火墙是否放行「专用网络」；手机与电脑是否同一 Wi-Fi |
| 页面一直停在「连接中」 | 打开 `/mini/api/version` 看是否 200；再看 DSH 日志里 `[dsh-remote-lite]` 开头的行 |
| 进了门禁页而不是页面 | 口令不对或已改；地址里 `?token=` 要带对，或在设置页重新扫码 |
| 隧道连不上 | 见下表关键词；先关掉电脑上的代理／VPN（Clash 这类）再试 |
| 收不到通知 | 系统通知要求 HTTPS 安全上下文（公网隧道满足，局域网明文不满足）；不想折腾就配 Bark / ntfy / Telegram |
| 改了代码没变化 | `page.html`、`sw.js` 在启动时读进内存，**必须重启 DSH**；重启后用构建指纹确认 |

隧道日志关键词：

| 关键词 | 含义 |
|---|---|
| `Registered tunnel connection` | 成功 |
| `Tunnel not found` | 隧道被删了，重建 |
| `Invalid request headers` | Token 类型填错（管理 Token 与隧道令牌混用） |
| `timeout` / `no recent network activity` | 网络层不通；插件已固定 `--protocol http2 --edge-ip-version 4` 规避 |

插件不注册系统服务，DSH 退出服务即停。数据目录里的 `state.json` 等缓存可随时删；`settings.json` 与 `token` 删了要重新配置和配对。

-----

<a id="limitations"></a>
## 已知限制

- 局域网通路为**明文 HTTP**，无传输加密；口令以查询参数传递，因此不适用于不可信网络。
- 部分网络中 Cloudflare 边缘地址不可达，插件固定 `--protocol http2 --edge-ip-version 4` 规避，但无法覆盖全部网络环境。
- 隧道的实际边缘节点由 Cloudflare 决定，跨区域访问可能受链路质量影响。
- 隧道进程由插件托管，卸载或切换为独立服务前需先停插件。
- 移动端页面是单文件结构，首次加载体积较大 —— 已按 `Accept-Encoding` 协商压缩：395 KB 原文 → brotli 约 110 KB（gzip 约 141 KB）。
- 技能（skills）的列举与取正文接口已在服务端就位（`/mini/api/skills`、`/mini/api/skill`），但**手机端的选择器尚未接入**，当前不在界面露出。

-----

<a id="dev"></a>
## 开发

```sh
npm install
npm run check     # 语法检查（index / server / tunnel / client）
```

本地调试用 `link:` 方式安装（见[从本地路径](#install)），改代码后重启 DSH 即生效，不需要重装。

两处容易踩：

- `page.html` 与 `sw.js` 是**启动时读进内存**的，改了必须重启 DSH，重装无用。
- `dsh plugin add` 会自动维护 `dsh.profile.bundles`；手工维护时条目名必须与包名完全一致。

`prepublishOnly` 在发布前跑一次语法检查。

-----

## 致谢

源自 [dsh-mini-remote](https://github.com/xingzhen199186/dsh-mini-remote)（[@xingzhen199186](https://github.com/xingzhen199186)），本包在其基础上重构为两条连接通路与零命令行部署。

## License

[MIT](LICENSE)
