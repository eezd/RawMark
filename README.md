# RawMark

纯 Markdown 笔记网页编辑器：所见即所得（类 Obsidian Live Preview）、文件即真源、Docker 部署、浏览器访问。

## 部署

本机部署沿用 `/srv/AlphaPulse/deploy` 的目录约定，端口按 `/docker/main/.env` 的个人项目范围（21000–21999）分配为 `RAWMARK_PORT=21000`：

```sh
cd deploy
install -d -m 750 -o 65532 -g 65532 data
docker compose --env-file /docker/main/.env up -d --build --wait
```

持久化数据位于 `deploy/data/`，与 `.dev-data/` 独立。首次打开网页时直接设置登录密码。
升级已有实例移除分享时，先备份数据与旧镜像、停止旧服务，再对 `rawmark.db` 执行一次 `scripts/remove-sharing.sql`，然后启动新版本。脚本删除分享表、专用密钥及分享快捷键；不会删除笔记或图片。旧分享页面和接口返回 404。回滚必须配套恢复数据库和旧镜像，不能只恢复旧程序。

升级到 Typora 默认快捷键时，先停止服务并备份数据与旧镜像，再对 `rawmark.db` 执行一次 `scripts/reset-shortcuts.sql`。该脚本按本次需求清空已有快捷键覆盖，其他设置保留；程序启动不会再次重置快捷键。
宿主机 Nginx 配置为 `deploy/nginx/raw.134333.xyz.conf`，复用现有通配证书及 WebSocket 升级映射；安装到 `/etc/nginx/conf.d/134333.xyz/` 后，先执行 `nginx -t` 再重载。
域名 `raw.134333.xyz` 在 DNSPod 设置 CNAME 指向 `cdn.134333.xyz`（与 AlphaPulse 一致）；还需在 Cloudflare for SaaS 的 `unino.top` 区域添加该自定义域名，并等待域名与托管证书均为 `active`。仅设置 CNAME 或旧区域中的 A 记录不足以完成 CDN 接入。访问地址为 `https://raw.134333.xyz`。修改端口时需同步端口登记和 Nginx 上游。

其他服务器也可直接构建并运行：

```sh
mkdir -p ~/rawmark-data
docker build -t rawmark .
docker run -d --name rawmark \
  --user "$(id -u):$(id -g)" \
  -p 8080:8080 \
  -v ~/rawmark-data:/data \
  --restart unless-stopped \
  rawmark
```

- 首次打开直接设置登录密码，之后凭密码与图片验证码登录；请在将新实例开放给他人访问前完成初始化。
- 笔记以普通 `.md` 文件保存在 `数据目录/vault/`，粘贴、上传和导入的图片统一存放在笔记同级的 `assets/`，链接使用 `./assets/文件名`，同目录相同内容去重。笔记跨目录移动时图片跟随，仍被其他笔记引用的原图保留；删除单篇笔记不会删除共享图片。旧 `笔记名.assets/` 仍可读取、移动与恢复；外部修改会实时同步到网页。
- 知识工具：标准 Markdown 链接构成图谱，支持正文 `#标签` 与 YAML `tags`。笔记或文件夹在应用内改名、移动时维护入链和相对出链；公式和代码示例不参与关系提取。
- 外观：浅色玻璃工作台与深色模式，默认字体为 Maple Mono Normal NL NF CN v7.9（界面、正文与代码），字体资源随应用本地提供，文字在所需字体加载完成后显示，加载失败会提示刷新；代码块使用 highlight.js，固定采用官网的 Atom One Dark 配色，与页面明暗模式独立；界面、正文与代码字体可分别选择，各字体下拉均支持导入 TTF/OTF/WOFF/WOFF2（单个不超过30 MB）及删除；Maple为不可删除的默认字体，删除正在使用的字体会恢复Maple，导入字体保存在服务器数据目录的fonts/并跨设备共用。界面字号默认 14px，可输入 14–20px 并单独重置，与编辑器及阅读字号独立；排版、玻璃透明度、选中文本工具栏均可在设置中调整并即时保存。
- 选区格式：电脑与触屏选中文字后提供外观、加粗、斜体、下划线、删除线、高亮和链接。外观可设置配色、字体、局部字号与效果；下划线及外观以受限的标准 HTML 行内标签保存在 Markdown 中，源码与导出保留标签，其他软件的显示取决于其 HTML 支持。清除样式只重置局部外观；底部不再显示格式栏。
- 图片管理：侧栏默认隐藏 `assets` 和 `笔记名.assets`；右键文件夹选择「图片管理」，查看当前目录及直属附件目录的图片，支持检索、排序、网格/列表、批量上传、引用查看及预览、重命名、移动、替换。可切换整个知识库；清理孤立图片须确认候选，服务端再次核对全库引用后移入回收站，可恢复。上传至所选目录的 `assets/`，相同内容自动去重。根目录可在侧栏空白处右键或通过命令面板打开。图片改名/移动会更新笔记中的本地引用；替换保留路径，选择相同扩展名的图片（最大 50 MB），旧图片不进回收站。
- `--user` 让容器以宿主机用户身份读写数据目录；不指定时容器以 UID 65532 运行，需要该用户对目录有写权限。
- 请通过 HTTPS 反向代理（Caddy、Nginx 等）访问，并转发 WebSocket（浏览器使用 `/api/v1/resources/<ticket>/events/`，脚本可使用 Bearer 连接 `/api/v1/events`）。
- 多选与导出：Ctrl/Cmd 点击切换选择，Shift 点击选择可见范围；右键批量删除、移动或导出 Markdown。单篇无附件直接下载 `.md`，其他情况下载包含 Markdown 与本地附件的 ZIP；重名目标不会被覆盖，批量操作会汇报单项失败。
- 设置：桌面使用居中窗口，手机使用分类与内容两级布局；支持搜索设置并定位、常用排版项单独重置，自动保存状态与失败提示可见。外观与编辑器分别管理，安装入口位于「关于」。
- 回收站与存储：回收站支持清空全部；默认按原删除时间保留 30 天，0 表示永不自动删除，服务启动及每小时执行清理，修改期限同样影响已有条目。设置「存储空间」进入即统计数据目录、外置笔记库及内置可选字体（不含默认 Maple），支持刷新和字体明细；不跟随内部符号链接，附件与回收站包含在笔记库总量中。
- 快捷键：支持按命令名称、ID 或组合键搜索，添加、逐条移除和单项/全部重置，并拒绝冲突绑定。默认跟随 [Typora](https://support.typora.io/Shortcut-Keys/) 的 Windows/Linux 或 macOS 组合，无对应项和插件默认留空；浏览器保留键可自行重新绑定。Ctrl/Cmd+1～6 设置标题，同级再次触发恢复正文；字号可直接输入，编辑器字号随有效输入即时生效。
- 备份与维护：设置「存储空间」提供完整实例、普通 Markdown 笔记库、设置与资源三种迁移入口。完整实例含数据库、登录信息、回收站与资源，恢复会替换当前业务数据并要求重新登录；设置包含偏好、插件数据及字体／主题／插件，保留包外资源，同 ID 资源替换。两者应用前均在数据目录 `backups/` 保存恢复包；不包含运维环境配置、派生索引或临时文件。普通笔记导出保留目录与原文，即使仓库与应用目录重合或嵌套也不包含应用数据库、资源与暂存文件；缺失附件记录于 `.rawmark-export/missing-assets.json`，导回时忽略该报告并导入新文件夹。
- 维护边界：备份恢复只接受本程序的版本化 ZIP，顺序分块上传，每块 8 MiB，压缩上限 2 GiB、展开上限 8 GiB／100000 项；完整恢复前需停止外部程序直接改写仓库。维护期间暂时暂停 API 操作，实例恢复在关闭数据库和后台任务后执行，中断时回退操作前备份。优化／重建仅作用于派生索引；临时清理不删除用户文件、活动上传或恢复备份。重置偏好保留插件存储、账户、资源和本机标签页。日志保存于 `logs/`，三份、每份至多 10 MiB，可导出日志及版本运行摘要，不补录历史日志。

- 文件目录操作：右键「文件目录」标题或目录空白处，可搜索、打开标签索引、新建笔记、新建目录、导入文档及管理图片；也可点击标题打开菜单。文件夹右键操作以所选文件夹为目标。
- 导入：文件目录或文件夹右键菜单选择「导入」，支持多选 UTF-8 `.md` 文件或单个 ZIP（总上传上限 100 MB）。ZIP 新建同名文件夹并保留笔记层级，本地图片归入各笔记同级 `assets/`；全部改链后移除已迁移且无引用的重复原图，其他附件和未使用图片保留。同名不同内容不覆盖，缺失的本地链接会提示，外部图片不会自动下载。
- 自动化：在设置「账户与安全 → API 令牌」中创建只读或读写令牌，以 `Authorization: Bearer <令牌>` 调用 REST API，接口说明见 `/api/v1/openapi.json`。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RAWMARK_DATA` | `/data` | 数据目录（数据库、可重建的搜索索引 `index.db`、默认笔记仓库） |
| `RAWMARK_VAULT` | `$RAWMARK_DATA/vault` | 笔记仓库目录，可指向已有的笔记文件夹 |
| `RAWMARK_ADDR` | `:8080` | 监听地址 |

文件树默认使用 📂 / 📄，可点击图标或右键“修改图标”，选择表情或内置线性图标。自定义属性存于仓库的 `.rawmark/tree-icons.json`，随应用内移动、重命名及回收站恢复保留，不改动或导出到 Markdown 正文；外部文件操作不保证跟随。

## 开发

需要 Go 1.27+、Node 24+ 与 pnpm 12.11.2（可通过 Corepack 启用）。开发时不必构建前端或 Docker 镜像，一键启动：

```sh
scripts/dev.sh          # 后端 go run -tags dev + 前端 Vite 热更新，Ctrl+C 同时退出
scripts/dev.sh --host   # 前端监听所有网卡，手机访问 http://<电脑 IP>:5173
```

浏览器打开 http://localhost:5173 ，首次使用直接设置登录密码。端口与数据目录可用 `API_PORT`、`WEB_PORT`、`RAWMARK_DATA` 覆盖，详见 `scripts/dev.sh --help`。
开发模式从源码统计可选字体，日志导出的版本标为 `dev`，不读取已有 `web/dist`；生产模式使用前端构建清单与页面构建版本。

检查：

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

字体资源已入库，普通构建无需下载或转换。重新生成时，在独立 Python 环境安装 `fonttools[woff]`，下载 [v7.9 指定字体包](https://github.com/subframe7536/maple-font/releases/download/v7.9/MapleMonoNormalNL-NF-CN.zip)，运行 `python3 scripts/prepare-maple-font.py /path/to/MapleMonoNormalNL-NF-CN.zip`；生成 WOFF2 与 `maple-font.css`，保留上游许可。

## 前端结构与接口升级

前端以 [vue3-starter](https://github.com/eezd/vue3-starter/tree/fd41d62ce3f1c8338a478e0be3e2f31b53b7ea5e) 为结构基线，保留 RawMark 的编辑器、主题与布局；模板许可在 `web/LICENSE`。`web/src/pages/workspace/` 管理笔记、目录、编辑器与图片，`pages/settings/` 管理设置及维护，`pages/login/` 管理初始化与验证码登录；页面私有组件、类型和组合函数跟随模块。全部资源 API 统一位于 `common/apis/<resource>/index.ts` 与 `type.ts`，API 函数直接调用 `request<ResponseData>({ url, method, data, params })` 并返回完整 `{ code, data, message }`，调用方读取 `.data`；原文及下载用 `returnResponse: true` 保留 Axios 响应和响应头，204 为 void，事件连接也归资源 API。实际共享的外观、Markdown、插件 SDK 位于 `common/`；请求、路由、共享状态分别由 `http/`、`router/`、`pinia/` 管理。唯一前端构建入口为 `web/`，使用 pnpm 锁文件。此次 API 目录与普通页面调整复用已部署的统一后端协议，不新增数据库迁移。

本次协议升级需前后端一起发布，旧页面与旧 Cookie 会话不能继续使用，需要重新登录。升级前备份数据库和旧镜像；启动新程序时沿用现有 SQLite 初始化流程新增 `resource_tickets` 表及过期索引，保留笔记、设置、密码和 API 令牌。生产迁移与部署须另行授权，不手动运行历史清理 SQL。回滚使用配套数据库和旧镜像；新前端不能连接旧后端。

登录流程先 `POST /api/v1/auth/captcha`，取得 `{captchaId,imageDataUrl,expiresAt}`；刷新传 `replaceId` 使旧挑战失效。再提交 `POST /api/v1/auth/login` 的 `{password,captchaId,captchaCode}`，后端校验六位数字，挑战绑定来源、五分钟过期且一次性消费（密码或验证码失败也会消费）。保留登录防暴力破解与签发限流。首次 `POST /auth/setup` 直接设置密码，不需要已有登录挑战。

登录/初始化返回 `{token,expiresAt}`。浏览器将 `rms_` 会话 Token 保存于 localStorage `rawmark.token`，所有受保护请求带 `Authorization: Bearer <token>`；服务端只存哈希、固定三十天有效，不滑动续期。`GET /auth/me` 返回真实权限及到期时间，`POST /auth/logout` 服务端撤销会话后返回 204；注销失败保留本地身份并明确报错。401 清除当前身份及动态路由，403 保留身份；旧请求或排队写入不能覆盖或注销新会话。localStorage 属于同源脚本可读的凭据，管理员安装的前端插件仍为全权限插件，不能承诺隔离。

普通 JSON 响应统一为 `{code,data,message}`，code=0 成功，message 表示成功或明确失败原因；错误保留 400/401/403/404/409/412/429/500 等 HTTP 状态。通用错误码为 HTTP 状态乘 100，40001 验证码错误/已使用、40002 验证码过期、40003 当前密码错误、40101 密码错误、41200 版本冲突；冲突版本位于 `data.rev`。文件原文、下载、WebSocket、204 和 OpenAPI 文档不包装。旧 JSON 客户端必须更新解包方式，不提供双格式兼容。

`rm_` API 令牌无需重新创建，read/write 权限不变；令牌不能管理账户、令牌、维护或资源票据。只读令牌仍可 POST 导出。第三方脚本只需保留 Bearer 请求头并按新 JSON 协议解包，文件/导出原始字节不变；WebSocket 客户端可继续以 Bearer 请求头连接 `/api/v1/events`。

浏览器原生图片、字体、插件相对模块导入及 WebSocket 无法统一设置认证头，使用 `POST /auth/tickets` 签发的受限资源 URL。图片/字体票据不超过父会话期限，插件另绑定 ID 和版本；每次读取都核对父会话，注销后立即不可读。事件握手票据一分钟有效、只能使用一次，已连接事件在发送与心跳时检查父凭据。主 Token 不放在 URL，不使用 Cookie 兜底；私有响应 no-store、Referrer-Policy=no-referrer，PWA 仅缓存静态外壳。部署代理也须避免记录票据 URL，仓库 Nginx 配置已提供脱敏日志格式；CDN/其他代理需按同样规则配置。
