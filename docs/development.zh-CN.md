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

Gitea 是主仓库和构建执行方（`origin`）；GitHub（`github`）只接收明确发布的版本，不持续镜像。项目检查和编译全部在 CI 工具链容器执行，不向部署宿主安装 Node 或 Go。runner 容量保持一；加上允许的 Pages 平台部署，同时执行的任务不超过两个。

### 开发流程

main push 触发 `.gitea/workflows/ci.yml`，执行项目检查、CI 行为测试、Linux amd64 打包和原生生命周期冒烟。后续 Docker job 校验同一运行的包，使用合成数据验证非 root 镜像、重启及重建容器持久化、服务端注销；通过后才发布 `git.134333.xyz/eezd/rawmark:dev-<完整SHA>` 并按摘要更新独立开发实例。PR 仅检查和打包，不注入发布凭据、不部署。宿主 Docker runner 只运行受信代码，并非不可信代码沙箱；外部 PR 运行前须由维护者审查。

开发使用 `raw-dev.134333.xyz`、回环端口 21001 和 `/docker/gitea/dev/rawmark/data`；生产保留 `/docker/main/rawmark` 下的独立数据和 21000 端口。部署锁内再次核对 main，旧运行不能覆盖新部署。

CI 入口是 `sh scripts/ci-check.sh development` 和 `sh scripts/ci-package.sh development`；参数换为 `release` 才构建 Demo 和五平台程序。`python3 -m unittest discover -s scripts/tests -v` 验证产物与部署行为。部署宿主不重新编译这些产物。

### 正式发布

先更新 `VERSION` 和 `.github/release-notes.md`，review 提交并通过 main push 开发 CI。进入 Gitea 的 **Release** 工作流，选择 main，输入完整提交 SHA 和对应的 `X.Y.Z` 版本。手动操作才发布，推标签不会自动启动发布。

同一工作流完成检查并打包 Linux amd64/arm64、Windows amd64、Darwin amd64/arm64。现有 runner 只对 Linux amd64 执行原生运行验收；交叉构建和 vet 不代替 Windows、macOS、ARM64 原生验收，先前 Windows 原生测试失败尚未复验。程序包附许可证和 `SHA256SUMS`。双架构镜像复用这些包中的 Linux 二进制，原样同步到 Gitea Registry 和 GHCR。

完成产物上传后，工作流准备 Gitea 草稿和不可变的 `build.json`；`image.json` 记录已验证候选镜像，`release.json` 关联构建、镜像摘要和 Demo 提交。两端最终发布文件一致。中断后重跑失败 job 或重新选择相同版本和提交，复用已有回执与原始产物；原产物过期则明确失败，不重新构建另一份内容。标签或附件冲突报错，已发布版本不覆盖。GitHub main 只正常快进。

GitHub 发布和 Pages 验证完成后，Gitea 才成为正式 Release。跨服务发布不具原子性：失败时可能已有 GitHub Release 或候选镜像，但 Gitea 仍为草稿，该版本不能进入生产。稳定镜像标签只在产物和公开镜像验证后更新。

每个安装包及 Demo 产物小于 90,000,000 字节，按平台分别上传。同时核对源码 Git pack 和镜像 blob：Cloudflare 100 MB 限制针对请求，而非只针对单个入库文件。合并 OCI 文件只留在 CI 临时空间，不作为发布附件上传。

### 凭据与 runner

在 Gitea 仓库 Actions Secrets 中配置：

| Secret | 所需权限 |
| --- | --- |
| `RAWMARK_GITEA_TOKEN` | Gitea 仓库 Release 与 Packages 写入 |
| `RAWMARK_GITHUB_TOKEN` | GitHub classic PAT，仓库权限、修改工作流文件所需的 `workflow`、`write:packages` |

Gitea 禁止 Secret 名以 `GITEA_` 或 `GITHUB_` 开头。令牌不进入 Git 或日志；job 的 Docker 凭据使用私有临时目录。手动生产 job 使用只读 Gitea job token 和匿名 GitHub/GHCR 读取，不获取发布 PAT。

首次创建的 GHCR 包默认私有，需要在包设置中设为公开后重跑失败的发布 job；匿名拉取通过后才能完成发布。不假定仓库凭据天然有 Packages 权限。

现有 runner 设置 `container.sweep: false`，避免任务结束后清除已部署服务。冒烟资源带 run/attempt 标签，由 always 清理步骤仅回收本次资源；部署挂载仅允许两个实例目录。不执行全局 Docker prune，不删除历史软件包；成功、失败和取消后均核对清理结果。

### 静态 Demo

`pnpm -C web build:demo` 生成 `web/dist-demo/`，基础路径为 `/RawMark/`。示例编辑仅在当前页面有效，不使用私有 API、身份、持久化工作区或 Service Worker。Gitea 将预构建产物和 `.nojekyll` 同步至 GitHub `gh-pages`，Pages 从此分支发布。GitHub 仍会执行平台 Pages 部署，这是唯一允许的 GitHub job，不编译 RawMark；旧 GitHub 项目发布工作流已移除。

生产更新为独立手动操作，见[部署文档](deployment.zh-CN.md#开发与生产托管)。
