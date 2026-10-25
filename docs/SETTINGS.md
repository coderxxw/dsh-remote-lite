# 配置项完整说明

配置文件位置：

```
C:\Users\<你>\.dsh\dsh-remote-lite\settings.json
```

修改后需要**重启 DSH** 才生效（`defaultMode` 和 `notify` 除外，它们支持热更新）。

---

## 顶层字段

### `port`
- **类型**：数字
- **默认**：`3090`
- **说明**：手机访问的端口。改了要重启 DSH（需要重新监听）。
- **注意**：确保防火墙放行。Windows 首次运行可能弹窗询问，选「允许专用网络」。

### `bindAddress`
- **类型**：字符串
- **默认**：`"auto"`
- **可选值**：
  - `"auto"` — 自动监听所有可用网卡（推荐，手机内网访问需要这个）
  - `"127.0.0.1"` — 只监听本机，手机连不上（除非走隧道）
  - 具体 IP，如 `"10.90.82.19"` — 只监听指定网卡
- **说明**：改了要重启 DSH。

### `token`
- **类型**：字符串（敏感）
- **默认**：空（首次启动自动生成 32 位 hex）
- **说明**：手机访问口令。出现在 URL 的 `?token=` 参数里。
- **建议**：设一个自己好记但别人猜不到的字符串，如 `my-remote-2026`。

### `maxHistory`
- **类型**：数字
- **默认**：`50`
- **说明**：手机端每个会话保留多少条历史。太大影响加载速度。

### `defaultMode`
- **类型**：字符串
- **默认**：`"minimal"`
- **可选值**：
  - `"minimal"` — 单帧模式，只留最新一条回答
  - `"chat"` — 聊天模式，显示完整对话
  - `"full"` — 完整模式，聊天记录之外再展开每一轮的思考与工具调用
- **说明**：手机打开时默认进哪个模式。改了这个**不用重启**（该字段是 volatile）。

---

## `tunnel` — 公网隧道

### `tunnel.enabled`
- **类型**：布尔
- **默认**：`false`
- **说明**：是否启用公网隧道。`false` = 只用局域网。
- **注意**：改为 `true` 时，`apiToken` 或 `tunnelToken` 至少有一个要填。

### `tunnel.mode`
- **类型**：字符串
- **可选值**：
  - `"quick"` — 快速隧道，免账号，但**网址每次重启都换**
  - `"named"` — 固定域名隧道，需要自己的域名和 Cloudflare 账号
- **说明**：改了要重启。

### `tunnel.hostname`
- **类型**：字符串
- **示例**：`"dsh.example.com"`
- **说明**：固定隧道使用的域名。必须是托管在 Cloudflare 的域名，且已在隧道的 Public Hostname 里配好。

### `tunnel.tunnelToken`
- **类型**：字符串（敏感）
- **说明**：**推荐用这个**。从 Cloudflare 后台隧道页面直接复制的那串 `eyJ...` 令牌。
- **优点**：插件直接用它跑隧道，跳过所有 Cloudflare API 调用，最少出错环节。
- **前提**：DNS 记录必须已经在后台配好（Public Hostname 会自动做）。

### `tunnel.apiToken`
- **类型**：字符串（敏感）
- **说明**：Cloudflare **管理 API** Token，不是隧道令牌。填这个后插件会自己创建隧道、写 ingress、建 DNS。
- **所需权限**：
  - `Account` → `Cloudflare Tunnel` → `Edit`
  - `Zone` → `DNS` → `Edit`
  - `Zone` → `Zone` → `Read`
- **注意**：和 `tunnelToken` 二选一。如果两者都填，优先用 `tunnelToken`。

### `tunnel.accountId`
- **类型**：字符串
- **默认**：空
- **说明**：Cloudflare Account ID。留空 = 自动用 API Token 能看到的账号。
- **⚠️ 常见错误**：不要填隧道 ID。隧道 ID 是 `4bfc4e77-...` 这种，Account ID 是另一串 32 位 hex。

### `tunnel.tunnelId`
- **类型**：字符串
- **说明**：隧道 ID。用 `apiToken` 模式时由插件自动写入，**不用手填**。

### `tunnel.cloudflaredPath`
- **类型**：字符串
- **默认**：空
- **说明**：自定义 cloudflared 可执行文件路径。留空 = 插件自动查找（配置路径 → 系统 PATH → 数据目录 `bin/` → 自动下载）。

---

## `notify` — 外部推送

手机锁屏或浏览器被挂起时，WebSocket 和 SSE 都靠不住，需要系统级推送。支持三种通道。改这里**不用重启**。

### `notify.enabled`
- **类型**：布尔
- **默认**：`false`

### `notify.channel`
- **类型**：字符串
- **可选值**：`"bark"` | `"ntfy"` | `"telegram"` | `"none"`

### `notify.onlyWhenBackground`
- **类型**：布尔
- **默认**：`true`
- **说明**：只在手机不在前台时推送，避免重复打扰。

### `notify.maxLength`
- **类型**：数字
- **默认**：`200`
- **说明**：推送内容截断长度。

### Bark（iOS）

```json
"notify": {
  "enabled": true,
  "channel": "bark",
  "barkUrl": "https://api.day.app/你的Key",
  "onlyWhenBackground": true,
  "maxLength": 200,
  "sound": "default"
}
```

### ntfy（跨平台）

```json
"notify": {
  "enabled": true,
  "channel": "ntfy",
  "ntfyUrl": "https://ntfy.sh",
  "ntfyTopic": "你的私有主题名",
  "onlyWhenBackground": true,
  "maxLength": 200
}
```

### Telegram

```json
"notify": {
  "enabled": true,
  "channel": "telegram",
  "telegramBotToken": "123456:ABC...",
  "telegramChatId": "你的ChatID",
  "onlyWhenBackground": true,
  "maxLength": 200,
  "sound": "default"
}
```

---

## 完整示例

### 场景 1：只用局域网

```json
{
  "port": 3090,
  "bindAddress": "auto",
  "tunnel": { "enabled": false },
  "token": "my-remote-2026",
  "maxHistory": 50,
  "defaultMode": "minimal",
  "notify": {}
}
```

### 场景 2：局域网 + Cloudflare 固定域名

```json
{
  "port": 3090,
  "bindAddress": "auto",
  "tunnel": {
    "enabled": true,
    "mode": "named",
    "cloudflaredPath": "",
    "hostname": "dsh.example.com",
    "accountId": "",
    "apiToken": "",
    "tunnelId": "自动写入的隧道ID",
    "tunnelToken": "eyJhIjoi...从后台复制"
  },
  "token": "my-remote-2026",
  "maxHistory": 50,
  "defaultMode": "minimal",
  "notify": {
    "enabled": true,
    "channel": "ntfy",
    "ntfyUrl": "https://ntfy.sh",
    "ntfyTopic": "my-dsh-topic",
    "onlyWhenBackground": true,
    "maxLength": 200
  }
}
```

### 场景 3：快速隧道（临时用，网址会变）

```json
{
  "port": 3090,
  "bindAddress": "auto",
  "tunnel": {
    "enabled": true,
    "mode": "quick",
    "cloudflaredPath": ""
  },
  "token": "my-remote-2026",
  "maxHistory": 50,
  "defaultMode": "minimal"
}
```

---

## 排查

### 插件完全没加载

检查 `qrcode` 依赖是否装了：

```powershell
Test-Path "插件目录\node_modules\qrcode"
```

返回 `False` 就执行 `npm install qrcode@^1.5.4`。

### 端口没在监听

```powershell
Get-NetTCPConnection -LocalPort 3090 -State Listen
```

没有输出 = 插件没起来，看 DSH 启动日志里 `[dsh-remote-lite]` 开头的行。

### 隧道连不上

看启动日志关键词：

- `Registered tunnel connection` — 成功
- `Tunnel not found` — 隧道被删了，重建
- `Invalid request headers` — token 类型填错
- `timeout` — 网络问题，插件已强制 http2

手工测试隧道令牌：

```powershell
& "插件数据目录\bin\cloudflared.exe" --protocol http2 --edge-ip-version 4 tunnel --loglevel info run --token "你的令牌"
```

看到 `Registered tunnel connection` 就说明令牌没问题。

### 数据目录

```
C:\Users\<你>\.dsh\dsh-remote-lite\
├── settings.json      # 配置
├── token              # 自动生成的访问口令
├── state.json         # 运行时状态
├── session-meta.json  # 会话元数据缓存
├── titles.json        # 会话标题缓存
├── subagents.json     # 子智能体缓存
└── bin/
    └── cloudflared.exe
```

想重置全部设置：停掉 DSH，删掉这个目录，重启即可。

> **目录名有一处历史遗留**：若 `%USERPROFILE%\.dsh\dsh-mini-remote-lite` 已存在，插件**沿用它**而不是新建 `dsh-remote-lite`。改名会把已配好的口令与隧道令牌一起丢掉，所以查找配置时两个名字都要看。
