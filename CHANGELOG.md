# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
