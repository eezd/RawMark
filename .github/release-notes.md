## RawMark 0.1.0

The first public release of RawMark, a single-user, self-hosted Markdown workspace.

- Markdown Live Preview and source editing, with tables, tasks, math, Mermaid, and Atom One Dark code highlighting.
- Folders, search, tabs, outlines, image management, import/export, and a recoverable recycle bin.
- English and Simplified Chinese, light/dark themes, local fonts, customizable shortcuts, and frontend plugins.
- Bearer authentication, API tokens, full-instance backups, and seven editable example notes on a fresh installation.

### Try or install

- [Online editor demo](https://eezd.github.io/RawMark/) — edits stay in the current page and reset on refresh.
- Docker: `ghcr.io/eezd/rawmark:0.1.0` (Linux amd64/arm64).
- Native Linux: download the matching archive, verify it using `SHA256SUMS`, extract it, and follow the [deployment guide](https://github.com/eezd/RawMark/blob/v0.1.0/docs/deployment.md).
- [English README](https://github.com/eezd/RawMark/blob/v0.1.0/README.md) · [中文说明](https://github.com/eezd/RawMark/blob/v0.1.0/README.zh-CN.md).

Existing installations must preserve their complete data directory and mount configuration. Back up before upgrading. No historical cleanup SQL is required for a fresh installation. Public sharing and multi-user collaboration are not included.

---

RawMark 首个公开版本：支持 Markdown 即时预览、笔记与图片管理、搜索与多标签、明暗主题、中英文、完整备份及 Bearer 认证。提供 Linux 双架构程序与 Docker 镜像，以及无需登录的编辑器在线预览。已有实例升级前请备份并保留原有数据目录及挂载配置。
