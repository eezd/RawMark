<div align="center">
  <img src="web/public/icon.svg" width="80" height="80" alt="RawMark 标志" />
  <h1>RawMark</h1>
  <p><strong>在自己的空间，安心写作。</strong></p>
  <p>自托管的个人 Markdown 笔记工作台。文件属于你，打开浏览器就能继续写。</p>
  <p><a href="README.md">English</a> · <strong>简体中文</strong></p>
  <p>
    <a href="https://eezd.github.io/RawMark/">在线体验</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="docs/guide.zh-CN.md">使用指南</a> ·
    <a href="docs/deployment.zh-CN.md">部署文档</a> ·
    <a href="https://github.com/eezd/RawMark/issues">反馈问题</a>
  </p>
</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/workspace-dark.png" />
  <img src="docs/images/workspace-light.png" alt="RawMark 主界面：左侧文件目录，中间 Markdown 即时预览编辑器和标签页，右侧文章大纲" width="1440" />
</picture>

<p align="center"><sub>真实工作区，使用示例笔记 · <a href="docs/images/workspace-light.png">浅色界面</a> · <a href="docs/images/workspace-dark.png">深色界面</a></sub></p>

## 为记录而设计

RawMark 适合想把笔记保存在自己服务器上的个人用户：整理知识、记录项目、收集灵感，在电脑、平板或手机的浏览器中继续写作。

笔记就是普通的 `.md` 文件，图片放在笔记旁的 `assets/` 文件夹。你可以直接访问文件，也可以随时导出，用熟悉的 Markdown 工具打开。

- **专注写作**：Markdown 即时预览与源码模式切换，支持表格、任务列表、数学公式、Mermaid 和代码高亮。
- **有条理地整理**：文件夹、标签、全文搜索与文章大纲；拖动移动、批量操作、自定义文件图标，让笔记各归其位。
- **延续工作状态**：多标签页与固定标签，刷新或重启后恢复；自动保存，外部文件修改同步到页面。
- **让图片跟着笔记走**：粘贴、上传与批量导入图片；图片管理支持引用查看、重命名、移动、替换及孤立图片清理。
- **按自己的习惯调整**：英文与简体中文、浅色与深色模式，独立的界面、正文及代码字体，可导入字体、自定义快捷键、主题和 CSS 片段。
- **数据可带走**：导入 Markdown 或 ZIP，导出笔记与附件；回收站、完整实例备份与设置迁移，支持 API 自动化及前端插件扩展。

RawMark 面向**单用户、自托管**场景。目前不提供多人协作或公开分享。

## 快速开始

安装 Docker 后运行：

请先从 [Releases](https://github.com/eezd/RawMark/releases) 选择已发布版本。此前版本已撤回，下方命令仅为安装示例，不代表该版本已可拉取。

```sh
docker run -d --name rawmark --restart unless-stopped \
  -p 127.0.0.1:21000:8080 \
  -v rawmark-data:/data \
  ghcr.io/eezd/rawmark:latest
```

打开 **http://localhost:21000**，首次访问设置登录密码。全新空实例会提供 7 篇英文示例笔记，可以自由编辑或删除，然后开始记录自己的内容。数据保存在 Docker 卷 `rawmark-data` 中，重建容器不会丢失。

Docker 支持 Linux amd64 和 arm64；原生程序支持 Linux amd64/arm64、Windows amd64 和 macOS Intel/Apple Silicon。可在 [Releases](https://github.com/eezd/RawMark/releases) 下载原生程序，或按照部署文档从源码构建。

无需安装即可[在线体验编辑器](https://eezd.github.io/RawMark/)。Demo 修改仅在当前页面保留，刷新恢复示例，不提供服务端工作区。

以上命令仅监听本机。部署到服务器时，请先完成初始化，再配置 HTTPS 访问；Docker Compose、已有笔记目录接入、备份与升级见[部署文档](docs/deployment.zh-CN.md)。

## 文档

| 想做什么 | 从这里开始 |
| --- | --- |
| 写作、整理笔记、管理图片与个性化设置 | [使用指南](docs/guide.zh-CN.md) |
| 部署、配置存储、备份和升级 | [部署与维护](docs/deployment.zh-CN.md) |
| 本地开发、了解目录职责和运行检查 | [开发指南](docs/development.zh-CN.md) |
| 编写脚本、接入认证和调用接口 | [API 与认证](docs/api.zh-CN.md) |

## 参与项目

欢迎通过 [Issues](https://github.com/eezd/RawMark/issues) 报告问题或提出建议。报告问题时，请附上版本、部署方式、浏览器和复现步骤；日志与截图中请移除密码、令牌及私人笔记内容。

提交改动前请阅读 [AGENTS.md](AGENTS.md) 和[开发指南](docs/development.zh-CN.md)。RawMark 优先保持简单、清晰，较大的功能或架构调整建议先通过 Issue 讨论。

## 致谢与许可

感谢 [CodeMirror](https://codemirror.net/)、[Vue](https://vuejs.org/)、[Element Plus](https://element-plus.org/)、[highlight.js](https://highlightjs.org/) 和 [Maple Mono](https://github.com/subframe7536/maple-font) 等项目。前端结构参考 [vue3-starter](https://github.com/eezd/vue3-starter)，其 [MIT 许可](web/LICENSE) 保留；[Maple 字体许可](web/src/common/appearance/fonts/maple/LICENSE.txt)及其他第三方许可遵循各自文件。

RawMark 采用 [MIT License](LICENSE) 开源；第三方代码与字体保留各自的许可和版权声明。
