# AGENTS.md

> 本文件记录 RawMark 的项目事实与专用约束。通用开发行为、授权、代码质量、记忆维护和 Pi 子代理调度遵循当前环境的全局 `AGENTS.md`（本环境为 `/root/.pi/agent/AGENTS.md`）；本文件只补充项目边界。当前任务涉及的实现仍须结合源码核实。

## 项目定位

- **项目名称**：RawMark。
- **目标与边界**：单用户、自托管的浏览器 Markdown 笔记应用，提供类似 Typora 的即时预览体验；当前不提供多人协作或公开分享。
- **技术栈与运行环境**：Go 标准库 HTTP、modernc SQLite、文件系统；Vue 3、TypeScript 6、CodeMirror 6、Vite、Pinia、Element Plus。`go.mod` 声明 Go 1.27.2；开发文档要求 Node.js 24+，`web/package.json` 锁定 pnpm 12.11.2；交付脚本使用 Python 3。
- **交付形式**：内嵌前端与公开示例的独立 Go 程序、Docker 镜像，以及独立静态 demo；正式程序包覆盖 Linux/Windows/macOS 的 amd64、arm64，镜像覆盖 Linux 双架构。
- **核心业务不变量**：Markdown 文件是正文真源，`index.db` 是可重建派生索引；编辑、预览、插件和语言切换不能丢失原文、未保存改动或撤销历史。同一数据集只运行一个实例。
- **示例初始化**：仅在空且未初始化的实例一次性创建 `deploy/data/vault` 中的公开示例；已有账户或非空 vault 不补种。该目录不能作为用户可写数据目录。

## 项目结构与关键入口

| 位置 | 职责 |
| --- | --- |
| `cmd/rawmark/` | 环境配置、恢复、存储和 HTTP 生命周期；`main.go` 为程序入口，`examples.go` 管理示例初始化 |
| `internal/api/`、`internal/api/openapi.json` | `/api/v1` HTTP 边界、认证、文件/资源/维护接口与 OpenAPI 契约 |
| `internal/auth/`、`internal/store/` | 密码、会话/API token、资源票据及实例 SQLite 状态 |
| `internal/vault/` | 路径与文件边界、原子保存、移动、图片、导入导出、回收站 |
| `internal/watch/`、`internal/search/`、`internal/events/` | 文件监听、派生索引与搜索、WebSocket 事件 |
| `internal/backup/`、`internal/i18n/` | 备份恢复状态机、后端消息及错误本地化 |
| `web/src/main.ts`、`web/src/App.vue` | Vue 装配、身份变化、语言、外观和 PWA 生命周期 |
| `web/src/pages/workspace/` | 文件树、编辑器、保存队列、草稿与事件同步；`workspace.ts` 和 `editor/` 为关键入口 |
| `web/src/pages/settings/`、`web/src/common/` | 私有设置界面，以及共享 API、组件、工具、外观、插件 host/SDK |
| `web/src/http/`、`web/src/router/`、`web/src/pinia/stores/` | 请求隔离、登录/权限守卫与共享状态 |
| `web/vite.config.ts`、`web/embed.go`、`web/embed_dev.go` | 前端生成配置及正式/开发模式 Go 静态资源适配 |
| `scripts/`、`scripts/tests/`、`.forgejo/workflows/` | 开发、检查、打包、冒烟、原生部署与 Forgejo 手动发布 |
| `deploy/`、`Dockerfile` | 部署模板、公开示例和镜像；真实原生运行目录为被忽略的 `runtime/` |

- **关键数据流**：浏览器读取原始 Markdown → CodeMirror 保存原文并携带 revision 条件 → vault 原子写入；外部文件修改 → watch 快照 → search 索引事务 → events 通知 → 浏览器同步。不能用预览 HTML 替代正文真源。
- **持久化数据**：`RAWMARK_DATA` 默认 `/data`，包含 `rawmark.db`、`index.db`、字体/主题/插件、备份、日志和临时目录；`RAWMARK_VAULT` 默认 `$RAWMARK_DATA/vault`，包含 Markdown、图片与 `.rawmark` 元数据。服务不依赖独立数据库或缓存服务。
- **权威文档**：`README.zh-CN.md`（定位和启动）、`docs/guide.zh-CN.md`（用户行为）、`docs/development.zh-CN.md`（开发）、`docs/api.zh-CN.md`（协议）、`docs/deployment.zh-CN.md`（数据和部署）；均有英文对应文件，相关契约变更需同步必要的双语文档。

## 开发与验证

下列命令从仓库根目录执行；它们是已核实入口，不代表可以直接操作已有运行实例。

| 目的 | 确认过的命令或入口 | 环境要求 / 副作用 |
| --- | --- | --- |
| 安装依赖 | `go mod download`；`pnpm -C web install --frozen-lockfile` | 网络访问、写入依赖缓存及 `web/node_modules`；保持锁文件，CI 使用 npm 官方 registry |
| 本地开发 | `./scripts/dev.sh` | 安装前端依赖并启动 Go/Vite；默认仓库 `.dev-data`、API `127.0.0.1:8080`、Vite `5173`，支持 `API_PORT`、`WEB_PORT`、`--host`；Ctrl+C 结束所启动进程组 |
| 定向测试 | `go test ./internal/api -run TestOpenAPICoversRoutes`；`pnpm -C web exec vitest run src/http/axios.test.ts` | 示例分别验证 API 路由覆盖、请求契约；其他模块按其现有测试选择范围，使用合成数据 |
| 完整检查 | `sh scripts/ci-check.sh development` | Python 测试、锁定依赖、前端检查/构建、Go 开发/生产模式检查和强制非 root 权限测试；会生成产物及临时文件，root 下用 `setpriv` 切换数字 UID/GID，不需要专用账号 |
| 本地构建与打包 | `pnpm -C web build`；随后 `sh scripts/ci-package.sh development` | 前端产物在 `web/dist`；打包写入 `package/`、`downloads/`，并用临时合成数据运行 Linux amd64 冒烟；`release` 模式编译六平台 |
| 本地服务部署 | `./start.sh`；`./stop.sh`；只读状态入口 `./status.sh` | 前两者改变实际 systemd 服务，需明确授权；`start.sh` 还会检查、构建、冒烟并切换 `runtime/current`，不是轻量开发启动入口 |
| 正式发布 | `./release.sh <remote-branch>` | `FORGEJO_TOKEN` 分派 Forgejo 手动发布；普通 push 只更新 Git 引用，不检查、构建、发布、部署或同步 |
| 手动同步 | `./sysnc-github.sh` | 仅操作者执行；从 Forgejo 同步已公开范围的 `main`、`dev`、TAG 和已验收版本到 GitHub/GHCR，不修改仓库设置 |

- **强制检查入口**：代码变更按影响执行下列检查；完整顺序及开发/正式模式覆盖以 `scripts/ci-check.sh` 为准，不能删减检查以制造通过结果。单纯文档修改核对事实、引用路径及 `git diff --check` 即可，不必启动服务。

```sh
pnpm -C web lint:check
pnpm -C web typecheck
pnpm -C web test
pnpm -C web build
go vet -tags dev ./...
go test ./internal/...
go test -tags dev ./web ./cmd/rawmark
python3 -m unittest discover -s scripts/tests
# 以下正式模式检查须在生成 web/dist 后执行：
go vet ./...
go test ./web ./cmd/rawmark
```

- **最小验收标准**：相关行为与既有 API/保存/认证契约通过验证，必要文档和 OpenAPI 同步，生成产物没有意外差异；汇报实际执行范围。涉及编辑器、保存、身份切换、备份恢复时，验证原文及未保存数据保留、冲突/失败路径，而不只验证成功提示。
- **测试策略**：Go 使用标准 `testing`，前端使用就近 Vitest，交付测试在 `scripts/tests/`。权限测试必须以非 root 运行；从 root 执行完整检查时用 `setpriv` 为测试进程设置 UID/GID `65534` 并清除补充组，无需创建账号。恢复、迁移、回收站和清理测试只使用隔离的合成数据；race、浏览器、Docker 冒烟按真实改动风险选择。
- **开发数据隔离**：启动前核实 `RAWMARK_DATA` 和 `RAWMARK_VAULT`，避免继承真实路径。Vite 代理 `/api` 及 WebSocket 到 API_PORT；Go `-tags dev` 的静态适配从磁盘读取 `web/dist`，开发页面由 Vite 提供，不依赖已有 dist。正式 Go 构建须先生成待嵌入前端。
- **生成文件**：`web/types/auto/*.d.ts` 由 Vite 自动导入配置生成；`web/dist`、`web/dist-demo` 及其中的 PWA/字体统计产物由构建生成。修改源文件或生成配置后重建，不直接编辑产物。Maple Mono v7.9 字体已入库，常规构建不重新下载或转换；字体维护入口为 `scripts/prepare-maple-font.py`。

## 项目特有约束

### 前端结构与编辑状态

- Vue SFC 使用 Composition API 与 TypeScript；页面私有逻辑留在 `web/src/pages/<module>`，共享逻辑放在 `web/src/common`，禁止 common 反向依赖页面。`@` 对应 `web/src`，`@@` 对应 `web/src/common`；公共组件采用 `<PascalCaseName>/index.vue`，其他文件沿用 kebab-case。
- API 按 `web/src/common/apis/<resource>/index.ts`、`type.ts` 组织，导出独立 `*Api` 函数，资源类型用 `import type`；不增加 API 聚合对象。`request<T>` 返回完整响应包装，业务读取 `.data`；原文/下载使用 `returnResponse: true`，204 不包装。不得用 `any`、`@ts-ignore` 或断言掩盖接口类型错误。
- 同一笔记串行保存；412 冲突不得自动覆盖。编辑器状态、脏文档和 IndexedDB 草稿必须按现有流程保留，不能把 `flushAll()` 返回当作可刷新，仍须检查 `readyToReload()`。外部事件不能覆盖本地未保存或保存中的内容。
- 设置写入沿现有串行队列；`settings.pinnedTabs` 为跨设备路径列表，字段缺失才迁移旧本地值，`[]` 表示明确清空。远端固定项变化不抢焦点、不关闭有编辑状态的标签。
- 语言为 `en`（默认）、`zh-CN`；共享/页面词典由 `web/src/i18n.ts` 组合，新增文案补齐双语。后端保留消息 ID、参数及错误链，在 HTTP 边界按 `Accept-Language` 输出并设置 `Content-Language`；不能靠翻译文案判断错误，也不能为切换语言改索引格式。
- 代码高亮固定使用 highlight.js Atom One Dark，不随主题更新改回旧实现。插件是用户信任的同页面 JS，不是沙箱；插件 vault 写入走工作区及 revision 检查，故障停用须保留原文。插件 SDK 契约入口为 `web/src/common/plugin-api/index.d.ts`。

### API、认证与数据边界

- 普通 API 使用真实 HTTP 状态及 `{ code, data, message }`，成功 `code=0`；Markdown、下载、WebSocket、204、OpenAPI 不加普通包装。修改路由或协议需同步 `internal/api/openapi.json`、调用方和覆盖测试。
- GET 笔记返回原文与强 ETag，PUT 使用 `If-Match: "rev"` 防覆盖、`If-None-Match: *` 排他新建；412 返回 `code=41200` 与 `data.rev`。代理必须保留强 ETag、条件请求头及 `Cache-Control: no-store, no-transform`，不能用缓存或内容变换破坏保存并发控制。
- 受保护 API 只接受 Bearer 主令牌，不改成 Cookie 或 URL 主令牌。`rms_` 浏览器会话与 `rm_` read/write API token 的权限保持分离，数据库只存令牌摘要；API token 不管理账户、令牌、维护和资源票据。原生资源使用绑定用途和父会话的票据，事件握手票据单次消费，不能绕过父会话校验。
- 用户 store 的 `sessionVersion`、取消和归属检查贯穿请求、工作区事件及异步资源；旧响应/旧 401 不能覆盖新身份。退出须先成功服务端撤销再清本地身份；403、当前密码错误不能触发全局退出。错误由请求层或 `errorOwner: 'caller'` 的调用方负责一次提示，失败仍须 reject。
- vault 路径必须相对、禁止隐藏段、越界和符号链接逃逸；删除笔记不直接删共享图片。完整恢复、设置合并、普通笔记导入是不同操作，不能混用；真实恢复/迁移/清理需相应授权。
- `runtime/config/rawmark.env`、真实 `runtime/data`、用户 vault、数据库、日志和备份可能含凭据或私人内容。文档、开发与测试不得为补充上下文读取这些内容；诊断只访问任务确有必要且获授权的范围，不输出令牌或私人笔记。资源票据不得明文泄露到 Referer、代理日志或静态缓存。
- PWA 只缓存静态应用外壳及按需字体，不缓存私有 API、笔记、图片或插件，也不承诺离线编辑/同步。数据库文件备份须处理 SQLite WAL 一致性；不能只复制运行中的 `.db`。新实例或已迁移实例不得重复执行历史迁移 SQL。

### 部署、恢复与发布

- `start.sh` 可直接由 root 执行，依赖私有运行配置，不需要专用账号。`rawmark-dev.service` 以 root 运行，保留 systemd 文件系统保护；项目脚本、构建目录、运行配置和 unit 不得允许不可信用户写入。部署使用 `runtime/.deploy.lock`，为当前工作区快照构建，再切换 `runtime/current` 和 unit。unit 的 `ExecStart`/`ExecStop` 调用根目录脚本的 `--systemd` 模式，不构建、不获取部署锁或调用 `systemctl`。默认监听 `127.0.0.1:21001`，不得据此推断实际私有配置或运行身份。
- 原生激活须验证实际进程二进制摘要、健康接口及前端指纹，失败恢复旧产物、unit 与服务状态。旧实例与新实例不能同时写同一数据集；原生写入后不能再启动旧副本造成数据分叉。容器默认 nonroot `65532:65532`；Compose 默认发布到所有网卡的 21000 端口，与原生回环监听不同。
- 完整恢复通过 `internal/backup` 的校验、回退备份和 prepared → applying → verifying 状态机；清除会话、重建索引，HTTP 初始化通过后才提交，失败回退。不能绕过这些步骤或用真实笔记做恢复测试。
- 发布入口以 `release.sh`、`scripts/manual-release.py` 和 `.forgejo/workflows/release.yml` 为准：可信 main 控制器与候选源码分离，候选构建环境不传递发布令牌；固定远端完整 SHA，版本采用提交 UTC 日期与 8 位 SHA。`FORGEJO_TOKEN` 用于客户端，合法 Secret `RELEASE_TOKEN` 映射到 `FORGEJO_RELEASE_TOKEN`。工作流按 `docker` 标签调度，不依赖 Runner 身份或项目宿主挂载；仓库级并发组 `cancel-in-progress: false`，首次实测排队及取消后继续。产物只存临时目录，不用 Generic Packages、持久原件或检查点；正式历史只认 Forgejo Release、TAG、`build.json` 和完成标记。未完成同版须核实旧任务已结束与来源归属后，精确清理该版本 Release/镜像，从原 SHA 全量重建，保留正确 TAG；完成或陌生内容不覆盖，同 SHA 跨分支零写入复用。只发布不可变版本镜像，不更新 `latest`，不写 GitHub。
- `sysnc-github.sh` 是唯一 GitHub 写入入口，运行前核对 GitHub Actions 已关闭，不修改仓库设置；只快进同步批准的引用，不强推、不删除。六平台附件逐项核对原件，版本镜像复制保留 OCI 摘要，缺少完成凭证的历史版本不冒充已验收。
- 远端分派结果不明时先核实 request_id，不重复提交；本地中断不会取消远端发布。发布不会部署服务、合并分支或切换 Pages。CI 资源只按当前任务标识清理，不能全局 prune；完整运维和回滚说明见 `docs/deployment.zh-CN.md`。

## 项目记忆与接续

- 唯一项目记忆为根目录 `MEMORY.md`；新会话先读本文件与记忆，再核实任务代码。`AGENTS.md` 保存稳定规范，`MEMORY.md` 保存项目概览、架构、当前状态、决定、验证、风险和下一步，不把历史记录当作新任务。
- 记忆由主代理按全局规则维护，实质进展或交接时原位更新，区分事实与待验证项。当前 `MEMORY.md` 未跟踪且未忽略；`.gitignore` 忽略的是 `CONTEXT.md`，不得自行改名、改忽略策略或另建同义记忆。
- 项目技能位于 `.agents/skills/`：业务页面/表单用 `v3-create-crud`，守卫/路由用 `v3-upsert-route`，Pinia 用 `v3-upsert-store`，组合函数用 `v3-use-composables`，工具/认证用 `v3-use-utils`；仅在任务适用时读取对应 `SKILL.md`。

## 本项目的子代理任务划分

- 本项目允许按需使用 `pi-subagents`；沿用全局角色职责和 Pi 已配置模型，不在单次调度中重设模型或思考等级。仅使用实际可调用的角色和调度工具，不可用时由主代理继续。
- **可并行范围**：互不依赖的后端模块、前端页面和交付脚本可分别只读排查；写入并行仅限接口已明确、文件范围互不相交且隔离充分的任务，例如不改共享契约的 `internal/search/` 与 `web/src/pages/settings/` 独立改动。共享工作区默认单一写入者。
- **统一协调范围**：`internal/api/openapi.json`、`web/src/common/apis/`、认证/设置 store、`workspace.ts`、插件 SDK、`web/vite.config.ts`、生成文件、`go.mod`/`go.sum`、前端依赖与锁文件、工作流及 `MEMORY.md`。跨前后端协议或部署入口的修改先由主代理明确契约和顺序。
- **交接必须说明**：已实现状态、允许修改文件、API 包装及身份/revision 契约、是否需前端产物和非 root 测试、合成数据位置、实际验收命令；明确 `start.sh` 是部署、`release.sh` 是远端发布，子代理不得自行操作真实 vault、私有配置或运行服务。
- 写入任务只有在实现状态、文件边界和验收条件清楚时委派；主代理统一维护记忆、检查核心证据并整合验证，不把子代理自述视为验收结果。

## 维护要求

- 项目结构、命令、数据边界或稳定契约变化时更新本文件对应段落及必要的双语文档；当前工作进展写入 `MEMORY.md`。
- 不用旧提交中的过时自动部署规则覆盖当前脚本，不为填满模板编造信息。重要未知项留在记忆中标为待核实，确认后再维护规范；安全与授权边界须保留在本文件或其明确引用的受控文档中。
