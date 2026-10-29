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

## Gitea CI/CD

Gitea 为公开主仓库，GitHub 为单向公开镜像；默认分支均为 main，日常开发使用 dev。

- dev push：容器内检查、Linux amd64 打包与隔离冒烟，通过后发布 `git.134333.xyz/eezd/dev/rawmark:YYYYMMDD-<8位SHA>`，按摘要部署 DEV。日期取提交时间 UTC，完整 SHA 保留在回执；同名异提交拒绝，已验证镜像重试复用。
- main push：独立检查实际合并提交、Linux amd64 构建及容器冒烟，不发布镜像、不部署。仓库内受信 PR 只检查；外部 fork PR 不自动进入共享 Docker runner，不注入发布凭据。
- DEV 为 `/docker/gitea/dev/RawMark`，容器 `RawMark-dev`，Compose 项目 `rawmark-dev`，监听 `127.0.0.1:21001`，域名 `raw-dev.134333.xyz`。数据独立；所有部署共用宿主实例 `.deploy.lock`，锁内核对 dev 最新 SHA，pending 未处理时拒绝覆盖。已有数据即使无旧容器也必须备份。
- Git 镜像独立于 CI 成败：push/create/delete、每小时对账和手动重试，共用 `/docker/gitea/mirrors/RawMark/.mirror.lock`，仅同步业务分支和 TAG 及完整历史，跟随源端删除。同步代码从 main 读取；`RAWMARK_MIRROR_ENABLED=true` 后启用，凭据为 `RAWMARK_GITHUB_MIRROR_TOKEN`。DEV 镜像不上传 GHCR。main 切换前保持该变量关闭。
- CI 凭据 `RAWMARK_GITEA_TOKEN` 需要仓库和 Packages 写权限。runner 保持容量一、`sweep: false`，只运行受信代码；工具链安装在任务容器。资源按任务标签清理，禁止全局 prune。
- 开发构建通过 `RAWMARK_BUILD_CHANNEL=development` 派生版本，前端与二进制一致；正式 `VERSION` 不因开发构建改变。开发包为 `RawMark_<版本>_linux_amd64.tar.gz`；历史正式产物不改名。安装包及单次传输保持既有 90,000,000 字节预算。
- 正式发布与生产入口暂时禁用，后续由 gitea-release 适配，不能绕过 Git 镜像锁直接写 GitHub 分支。生产保留现有目录和数据，不随开发推送更新；GitHub 旧 Release workflow 保持禁用，Pages Demo 不切换。
