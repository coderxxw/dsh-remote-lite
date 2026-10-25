# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 服务端技能账本接口 `GET /mini/api/skills`（只给名字与描述）与 `GET /mini/api/skill`（按需取正文）。
  **手机端的选择器尚未接入**，界面暂不露出；两个接口只是把宿主 `ctx.skills` 的能力准备好。

### 变更

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
