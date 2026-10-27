## RawMark 0.1.1

Native downloads now cover five platforms:

| Platform | Download |
| --- | --- |
| Linux amd64 | `rawmark_0.1.1_linux_amd64.tar.gz` |
| Linux arm64 | `rawmark_0.1.1_linux_arm64.tar.gz` |
| Windows amd64 | `rawmark_0.1.1_windows_amd64.zip` |
| macOS Apple Silicon | `rawmark_0.1.1_darwin_arm64.tar.gz` |
| macOS Intel | `rawmark_0.1.1_darwin_amd64.tar.gz` |

- Platform-specific disk space queries, temporary storage and restore-record publication support Windows backup/restore.
- Windows paths reject device names, alternate data streams and filename aliases at note/import/backup boundaries.
- One Gitea release workflow checks the project and cross-builds all five targets. Linux amd64 runs native lifecycle tests; Windows, macOS and Linux arm64 remain unverified at runtime. Docker remains Linux amd64/arm64 and uses the same packaged programs.
- Archives contain the CLI web server and licenses; no desktop GUI, installer or code signing is included. macOS may require manual approval for the unsigned download.

### Try or install

- [Online editor demo](https://eezd.github.io/RawMark/) — edits reset on refresh.
- Docker: `ghcr.io/eezd/rawmark:0.1.1` (Linux amd64/arm64).
- Verify downloads using `SHA256SUMS`, then follow the [deployment guide](https://github.com/eezd/RawMark/blob/v0.1.1/docs/deployment.md).
- [English README](https://github.com/eezd/RawMark/blob/v0.1.1/README.md) · [中文说明](https://github.com/eezd/RawMark/blob/v0.1.1/README.zh-CN.md).

Preserve your complete data directory and mount configuration when upgrading, and back up first. No historical cleanup SQL is required. This file is a release draft; availability depends on a completed formal release.

---

新增 Windows amd64、macOS Apple Silicon 和 Intel 原生程序，保留 Linux 双架构程序与 Docker 镜像。同一个 Gitea 发布工作流完成检查与交叉构建；Linux amd64 执行原生生命周期测试，Windows、macOS 和 Linux arm64 尚未完成原生运行验收。原生程序是网页服务端，不含桌面窗口、安装器或签名；macOS 首次运行可能需要手动允许。请先核对 SHA256SUMS，再参考部署指南。升级前备份并保留完整数据目录，不重跑历史清理 SQL。此文件为发布草稿，产物是否可用以完整正式发布为准。
