# 开发指南

[English](development.md) · **简体中文**

[返回项目首页](../README.zh-CN.md) · [API 与认证](api.zh-CN.md) · [项目约束](../AGENTS.md)

## 工具链

- Go 1.27.2 或更高版本，具体要求见 [go.mod](../go.mod)。
- Node.js 24+、pnpm **12.11.2**；前端依赖以 [pnpm-lock.yaml](../web/pnpm-lock.yaml) 为准。
- Docker 仅在验证容器构建或部署时需要，本地开发不强制使用。

前端采用 Vue 3、TypeScript、Vite、Router、Pinia、Element Plus、Axios、SCSS 与 UnoCSS；编辑器使用 CodeMirror 6。服务端使用 Go 标准库 HTTP、SQLite 与文件系统；Markdown 文件是真源，搜索索引可以重建。

## 启动本地开发

```sh
corepack enable
corepack prepare pnpm@12.11.2 --activate
scripts/dev.sh
```

脚本使用锁文件安装前端依赖，同时启动 Go 开发服务和 Vite 热更新。打开 http://localhost:5173，首次访问初始化密码；Ctrl+C 同时退出。

```sh
scripts/dev.sh --host     # Allow LAN devices to access the frontend
scripts/dev.sh --help
```

`RAWMARK_DATA` 默认指向仓库的 `.dev-data/`，`API_PORT` 默认 8080，`WEB_PORT` 默认 5173。可通过环境变量覆盖，例如 `API_PORT=18080 WEB_PORT=15173 scripts/dev.sh`。不要将开发服务指向生产数据；初始化、恢复、导入和删除测试只使用合成数据。

开发模式从源码统计可选字体，日志版本显示为 `dev`，不读取旧 `web/dist`。生产模式使用嵌入的前端构建、字体清单和构建版本。

## 目录职责

```text
cmd/rawmark/                 服务入口
internal/
  api/                      HTTP 路由、授权、协议及 OpenAPI
  auth/                     密码、会话与 API 凭据
  store/                    应用 SQLite
  vault/                    真源笔记、附件与文件操作
  search/                   可重建的派生索引
web/
  src/
    pages/login/            初始化与验证码登录
    pages/workspace/        笔记、目录、编辑器与图片管理
    pages/settings/         设置、账户与维护
    common/apis/            全部资源 API
    common/components/      跨模块公共组件
    common/                 共享外观、Markdown、插件 SDK 与工具
    http/                   Axios、认证头、统一响应与错误
    router/                 路由与守卫
    pinia/                  实例及共享认证、权限、设置状态
  types/auto/               自动生成的导入声明
deploy/                    容器、代理配置及嵌入的公开示例笔记库
scripts/                   开发、资源生成及历史迁移脚本
```

页面私有组件、类型、状态、组合函数和资源跟随 `pages/<module>/`，确实跨模块复用的能力才进入 `common`；公共代码不得依赖页面私有实现。模块内优先相对导入，跨职责用 `@`（`web/src`）与 `@@`（`web/src/common`）。

全部资源接口位于 `common/apis/<resource>/index.ts` 和 `type.ts`。函数直接调用 `request<ResponseData>({ url, method, data, params })`，返回完整 `{ code, data, message }`，调用方显式读取 `.data`。原文/下载设置 `returnResponse: true` 保留 Axios 响应与响应头，204 返回 void，事件连接也归资源 API。不增加页面私有请求入口或多格式 fallback。

公共组件放在 `common/components/<PascalCaseName>/index.vue`。SFC 使用 Composition API 与 TypeScript，其他文件使用 kebab-case。自动声明应修改生成配置后重新构建，不手工编辑。更完整的执行约束以根 [AGENTS.md](../AGENTS.md) 为准，不另维护一套规范。

## 验证

```sh
pnpm -C web install --frozen-lockfile
pnpm -C web lint:check
pnpm -C web typecheck
pnpm -C web test
pnpm -C web build
go vet -tags dev ./...
go test ./internal/...
go test -tags dev ./web
```

前端使用 Vitest，测试随模块存放；Go 使用标准 `testing`。生产构建需先生成 `web/dist`，Go 再将其嵌入二进制。`-tags dev` 保留无需嵌入产物的开发和对应测试边界。

按改动风险补充 Go race、Docker 构建及真实浏览器验收。认证与请求变更应覆盖验证码成功/失败/过期、401 与 403、服务端注销以及旧会话响应隔离；编辑器与文件操作应核对原文保存、版本冲突、附件及移动/导入/导出。不用空数据或模拟成功掩盖失败。

## 主题、字体与插件

内置默认、白色与黑色主题，保留独立明暗模式和 CSS 片段。自定义主题位于数据目录 `themes/<id>/`，包含 `manifest.json` 与 `theme.css`；清单包含 `id`、`name`、`version`，ID 与目录一致，不能覆盖保留的 `default`、`white`、`black`。在外观设置刷新列表后选择。

默认字体资源已入库，常规构建无需下载或转换。重新生成时，在独立 Python 环境安装 `fonttools[woff]`，下载 [Maple v7.9 指定字体包](https://github.com/subframe7536/maple-font/releases/download/v7.9/MapleMonoNormalNL-NF-CN.zip)，执行：

```sh
python3 scripts/prepare-maple-font.py /path/to/MapleMonoNormalNL-NF-CN.zip
```

脚本生成 WOFF2 和 `maple-font.css`，保留上游许可。代码块使用 highlight.js 的固定 Atom One Dark，不能在更新主题时顺带恢复旧高亮实现或配色。

插件 SDK 类型见 [common/plugin-api/index.d.ts](../web/src/common/plugin-api/index.d.ts)，加载与生命周期实现位于 `common/plugins/`。插件仅在前端运行，安装者必须信任其代码；命名空间、停用及资源版本管理不等于权限沙箱。编辑器扩展故障时保留正文并停用当前页相关扩展。

## 提交改动

先阅读 [AGENTS.md](../AGENTS.md)，聚焦实际需求，保留必要契约，不机械照搬模板示例。前端目录以 [vue3-starter 固定基线](https://github.com/eezd/vue3-starter/tree/fd41d62ce3f1c8338a478e0be3e2f31b53b7ea5e) 为参考，RawMark 的编辑器、主题和专用交互按业务保留。

提交前运行适用检查，说明实际验证与未验证范围。Commit 使用清晰英文，按功能拆分；不要提交真实笔记、账户数据、密钥或本地交接文件。

## 多语言

使用 Vue I18n Composition API，支持 `en` 与 `zh-CN`，默认英文。公共字典位于 `web/src/common/i18n/`，模块私有字典位于 `pages/<module>/locales/`，应用 `src/i18n.ts` 装配字典；不要用中文原文作为运行时查找键，也不要从公共模块导入页面字典。模板及命令、设置搜索等长期对象在使用时翻译；日期、数字和排序读取当前语言。

账户语言沿用 settings store 的串行写入、服务器设置与事件同步；登录页仅更新本机启动缓存，认证后读取服务器值。CodeMirror 使用 locale Compartment 更新控件，不替换文档、选区或撤销历史。用户正文、现有路径和插件提供的文字保持原样。

后端 `internal/i18n/` 保存消息 ID 与参数，错误在 HTTP 边界根据 `Accept-Language` 渲染，并保留 `errors.Is/As` 及原始诊断；日志遵循原有语言。既有索引警告只在需要时重新分析源笔记生成译文，同时更新该条目的完整元数据和版本，不改索引格式；已删除或移动的过期条目跳过，其他读取错误明确返回。新增文案同时补充中英字典与参数，运行字典完整性、设置同步、编辑器和 API 的相应测试。

## 开发 CI 与发布晋级

Gitea 为开发远端（`origin`），GitHub 为发布远端（`github`）。日常 `git push origin main` 触发 `.gitea/workflows/ci.yml`；不配置 GitHub 自动镜像，开发 CI 不发布版本或部署服务。私有 runner 每次执行一个 job，保持容量为一（本项目最多不能超过两个）。

Linux runner 执行 lint、类型检查、前端测试、正式与 Demo 构建、Go vet 和测试、普通用户文件权限测试，以及使用临时数据的 Linux amd64 程序生命周期测试；交叉编译并 vet Linux amd64/arm64、Windows amd64、macOS arm64/amd64。交叉编译**不代表**已验证 Windows、macOS 或 Linux arm64 的原生行为，GitHub 发布流程仍保留原生测试。

每个平台独立上传压缩包，附校验和，保留七天。上传前拒绝大于等于 90,000,000 字节的包，为 Cloudflare 的 100 MB 请求限制预留余量；不将五平台合成一个产物，不将构建输出提交到 Git。Git HTTP 限制同样针对整个 push 请求，而非只针对单个文件：保持小批量推送，不将大二进制文件写入历史。自托管 runner 通过已配置的 Docker 私有网络连接 Gitea。

发布时选择已 review 且通过 Gitea CI 的 commit。先完成版本与发布说明调整，再在 Gitea 验证最终提交。获得明确发布授权后，将该提交同步至 GitHub，并为该提交推送版本标签，不能直接发布后来移动且未验证的分支顶端。此前版本撤销后，GitHub Release Actions 仍处于手动禁用状态；仅在获准发布时恢复。生产部署另行授权。

## 版本发布与公开 Demo

`VERSION` 是发布版本的唯一来源。Docker 构建和发布二进制将其写入 `--version`，Vite 用于设置页面展示；既有 PWA 内容哈希保持独立。

发布时更新 `VERSION`、`.github/release-notes.md` 和双语安装示例，完成检查、review、提交并通过 Gitea CI。明确获准发布后，将选定的 `main` 提交推送至 `github` 远端，再将该提交对应的 `vX.Y.Z` 标签推送至 `github`。`.github/workflows/release.yml` 是唯一发布工作流：普通分支推送不触发，创建 Release 也不启动第二个工作流。发布运行全局串行，原生平台矩阵最多同时执行两个 job。同一次运行完成检查、Linux amd64/arm64、Windows amd64 与 macOS amd64/arm64 原生程序测试、以相同程序封装双架构镜像、Demo 部署及 Release 和稳定镜像标签发布。失败时在原 run 中重跑失败 job，不移动已发布标签或覆盖发布附件。

GitHub Pages 必须选择 GitHub Actions 作为发布来源，`github-pages` 环境需要允许版本标签部署。首次 GHCR 镜像需在包设置中将可见性改为 Public，公告前验证匿名拉取。生产实例部署与版本发布是不同操作。

执行 `pnpm -C web build:demo` 构建静态编辑器预览，输出至 `web/dist-demo/`，基础路径为 `/RawMark/`。复用现有编辑器，修改仅在当前页面保留；不使用私有 API、认证、持久化工作区或 Service Worker。工作流在同一次发布运行中部署至 https://eezd.github.io/RawMark/。
