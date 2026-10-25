# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **会话按最近一次对话排序 + 每个工作区默认只亮 5 条**（2026-10-25 用户要求）：
  DSH 的 `SessionHeader` 只有 `createdAt`，没有「最后活动时间」，所以新增 `lib/activity.js`——
  扫 `~/.dsh/sessions/<slug>/<id>/session.*.jsonl.zstd` 的 mtime（每次写事件都会刷新），
  5 秒 TTL。跑着的会话天然排最前；没有日志的新会话退回创建时间。手机端展开一个工作区
  默认只列前 5 条，底下「更多（还有 N 个）」开关展开全部、再点收起；服务端单次上限
  从 20 提到 60，免得点开「更多」却发现数量对不上。每行的日期标签同样改用活动时间。
- **手机端可清理会话**：长按导航里的会话行 → 归档，或永久删除；长按工作区标题 → 归档该文件夹下的全部会话，或删除工作区。
- **永久删除会话**（不可恢复）：DSH 自身没有这个动作（`dsh-session` 的 store 只增不删，也没有 prune/retention），
  由插件按它的分层实现 —— 先归档（停掉正在跑的活）→ 删掉 `~/.dsh/sessions/<slug>/<id>/` 整个目录 →
  清掉四处引用（内存里的已删名单、导航元数据缓存、标题缓存、DSH 的投影缓存文件）。
  搜索索引会晚一步自愈（它只在搜索那条路和启动时对账）。接口要求请求体带 `confirm: "delete"`。
- **执行面板的立绘位**：`lib/art/mascot.webp`（或 `.png`）存在时就显示，不存在时**不占位置**。
  探测在 `artFileName()`，结果经 `GET /mini/api/version` 的 `art` 字段下发，页面据此显隐。
- 服务端技能账本接口 `GET /mini/api/skills`（只给名字与描述）与 `GET /mini/api/skill`（按需取正文）。
  **手机端的选择器尚未接入**，界面暂不露出；两个接口只是把宿主 `ctx.skills` 的能力准备好。

### 变更

- **面板一律改实底，去掉毛玻璃**（2026-10-25 布局审计）：设置抽屉、导航抽屉、输入栏、
  附件小条、指令菜单原来是 `background: var(--glass)` + `backdrop-filter: blur(14px)`，
  实测主界面的粗体字会穿上来跟面板文字叠在一起，可读性很差。把 `--glass` 提到 93% 不透明、
  遮罩压暗之后**穿透依旧**（computed style 是对的，是合成器的 backdrop-filter 渲染不完整）。
  于是这些面板直接用实底 `var(--panel)`，只留顶栏保留玻璃（它下面是背景渐变不是文字）。
  代价是少一层质感，换到的是任何浏览器都不会穿透。
- **触摸目标**：顶栏按钮 36→40px（WCAG 2.5.5 的 44 会压标题，40 是可点性与版面的折中）；
  代码块/表格右上角的复制按钮保持 28px 视觉、用 `::after` 把热区扩到 44px——
  它是手机上最常点的小东西，28px 手指一盖就点偏。
- 顺手清掉两处重复规则（`footer` 的 box-shadow 拆成单独一条；`.md table` 定义了两处）。
- **移除「正在执行」的鲸鱼娘立绘轮播**（九姿势雪碧图、切帧动画、为角色预留的 122px 行宽、预热与建层逻辑）。
  该面板只保留三样东西：不确定进度条、已跑秒数、模型此刻的台词气泡——这本来才是它唯一的信息量。
  顺带把立绘接口放宽到 `.webp/.png/.svg`（正文里的图片走同一条通道，现在 png/gif 之外的矢量图也能直出）。
- 图标重绘：改用 DeepSeek 品牌蓝（`#4D6BFE`）鲸鱼，图形取自 Twemoji 的 🐳（CC-BY 4.0）并重新配色，
  替换原先与产品色板无关的靛紫/青绿手机图形。
- 流式输出改为「事后确认再推」：`text-delta` 先缓存不外露，出现 `tool-call-delta` 即判定为中间步骤并整段丢弃，
  直到该步收尾仍无工具调用才确认是最终回答、一次性补齐后转入逐帧推送。消除了旁白闪现，代价是首字延迟。
- 文档按 GitHub 开源项目惯例重排：去掉 YAML front-matter 与手写 `<a id>` 锚点（改由标题自动生成），
  `README.md` / `README.en.md` 统一为「徽章 → 简介 → 目录 → 特性 → 环境要求 → 安装 → 快速开始 → 使用 →
  配置 → 工作原理 → 接口 → 常见问题 → 已知限制 → 路线图 → 参与贡献 → 致谢 → 许可证」结构，
  架构图改用 GitHub 原生渲染的 Mermaid；`docs/SETTINGS.md` 修正乱码、补 `full` 模式与数据目录回退说明。

### 修复

- **归档在手机上看不出任何变化**：`archiveSession` 调用是成功的（id 确实进了
  `workspaceRegistry.archivedSessionIds`），但导航从来不读这个集合 —— `sessionQuery.listSessions()`
  返回的是持久化层现扫盘的结果，归档这件事它不反映。表现就是点了「归档」、接口回 `ok:true`、
  列表一条没少，用户只能反复点。现在 `listWorkspaces` / `listSessionsOf` / `allSessionIdsOf`
  统一接一个 `hidden` 集合（已归档 ∪ 已永久删除），渲染前先滤掉。
- **永久删除后列表里还留着那一条**：日志目录确实删了（接口回 `files:true`），但 `listSessions()`
  在现扫盘之后**会把 `ctx.sessions.list()`（内存中活着的实例）合并进来** —— 本次启动后建的会话
  被删掉文件后依然在内存里，于是列表照旧有它、点进去却是空的。原来的注释把这条判断写错了
  （「删完导航立刻就对」），已一并更正。现在用内存里的 `deletedIds` 在渲染前遮住，重启后
  内存清空、它自然失效。
- **`total` / `truncated` 用的是未过滤的 `sessionIds.length`**：已归档、已删除、子智能体会话
  都被算进总数，于是手机显示「共 22 条」却只列 21 行，还一直提示「还有更多」。改为按过滤后的
  行数计算，两个接口的口径也一致了（工作区计数 vs 会话总数）。
- **删完留下两处缓存垃圾**：DSH 的投影缓存（`~/.dsh/storages/session_projcache/sessions/<id>.json`，
  每个 3–6 KB）和插件自己的 `titles.json` 都会留着那个 id——日志都没了它们就是孤儿，
  搜索还搜得到。现在一并清掉，「删干净」才算真的删干净。
- **二次确认文案里的 `**不能恢复**` 在真机露出星号**：`openMenu` 用 `textContent` 写入、
  不跑 markdown，星号会原样显示。改为纯文本句式。

## [1.0.0] - 2026-10-25

首个公开版本。基于 `dsh-mini-remote` 重构，聚焦两条连接通路与零配置部署。

### 新增

- **局域网配对**：扫描设置页二维码即可进入移动端界面，无需手工拼装地址。
- **Cloudflare 固定域名隧道**：填入 API Token 后，插件自动完成隧道创建、ingress 写入、DNS 记录写入与 `cloudflared` 启动。
- **域名发现**：设置页可读取 Token 可见的全部域名，一键填入 `dsh.<域名>`。
- **页面压缩**：移动端页面按 `Accept-Encoding` 协商，优先 brotli（395 KB → 约 109 KB），其次 gzip（约 140 KB）。经隧道访问时首屏耗时由约 6.7 秒降至约 1.9 秒。
- **外部推送**：支持 Bark、ntfy、Telegram 三种通道，用于锁屏与后台场景。
- **双语文档**：`README.md`（中文）与 `README.en.md`（英文）。

### 变更

- 项目更名为 `dsh-remote-lite`。
- 使用 `tunnelToken` 直连模式时不再依赖 Cloudflare 管理 API，减少出错环节。
- `cloudflared` 二进制由插件托管生命周期，不注册系统服务、不开机自启、不修改 hosts。

### 修复

- 修复本地 `link:` 安装方式下 `qrcode` 依赖缺失导致插件加载失败的问题。
- 修正文档中 `accountId` 与隧道 ID 混用的说明。
- 隧道连接固定为 `--protocol http2 --edge-ip-version 4`，规避部分网络中 Cloudflare 边缘地址不可达的问题。

### 已知限制

- 局域网通路为明文 HTTP，口令经查询参数传递，仅适用于可信网络。
- 公网隧道的实际路由节点由 Cloudflare 决定，跨区域访问可能受国际链路质量影响。
- 移动端页面为单文件结构，首次加载体积较大。

## 致谢

本项目源自 [dsh-mini-remote](https://github.com/xingzhen199186/dsh-mini-remote)（作者 [@xingzhen199186](https://github.com/xingzhen199186)）。

[Unreleased]: https://github.com/coderxxw/dsh-remote-lite/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/coderxxw/dsh-remote-lite/releases/tag/v1.0.0
