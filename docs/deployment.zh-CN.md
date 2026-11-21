# 部署与维护

[English](deployment.md) · **简体中文**

[返回项目首页](../README.zh-CN.md) · [使用指南](guide.zh-CN.md) · [开发指南](development.zh-CN.md)

RawMark 将前端嵌入 Go 服务，运行时使用 SQLite 与文件系统，不需要额外数据库服务。可以使用正式镜像或从源码构建，以下源码构建方式继续保留。

## Docker 快速启动

安装 Git、Docker 后：

```sh
git clone https://github.com/eezd/RawMark.git
cd RawMark
docker build -t rawmark .
docker run -d --name rawmark --restart unless-stopped \
  -p 127.0.0.1:21000:8080 \
  -v rawmark-data:/data \
  rawmark
```

访问 http://localhost:21000 完成首次密码设置。命名卷 `rawmark-data` 保存应用数据，重新创建容器时应继续挂载同一个卷，不要删除它。服务器上的本机端口可通过 SSH 隧道访问，再完成初始化：

```sh
ssh -L 21000:127.0.0.1:21000 user@your-server
```

容器默认以 UID/GID `65532:65532` 运行，Docker 新建命名卷会继承镜像数据目录的权限。

全新实例的空笔记库会自动生成 `deploy/data/vault/` 公开模板中的 7 篇英文示例笔记。示例嵌入二进制，Docker 与原生部署行为一致。仍需自行设置密码，不附带账号凭据或私人设置；已有账号和非空笔记库不会被添加示例。示例是普通文件，删除、重启或重置偏好设置后都不会重新生成；一次性初始化状态保存在应用数据库中，不属于用户偏好设置。

## Docker Compose

仓库提供 [deploy/docker-compose.yml](../deploy/docker-compose.yml)，默认使用独立的 Docker 命名卷保存运行数据：

```sh
docker compose -f deploy/docker-compose.yml up -d --build --wait
```

纳入版本控制的 `deploy/data/` 是公开示例模板，不是运行数据目录，不要将其作为可写数据目录挂载。若使用宿主机目录，先创建目录并设置 UID/GID `65532:65532`，再指定绝对路径：

```sh
sudo install -d -o 65532 -g 65532 /your/storage/rawmark/data
RAWMARK_DATA_DIR=/your/storage/rawmark/data \
  docker compose -f deploy/docker-compose.yml up -d --build --wait
```

后续每次执行 Compose 命令都必须使用相同的 `RAWMARK_DATA_DIR`，例如保存在通过 `--env-file` 指定的私有文件中。该 Compose 变量选择宿主机挂载位置，与容器内应用使用的 `RAWMARK_DATA` 不同。原先使用 `deploy/data/` 的实例，在迁出前必须显式指定原目录；省略此覆盖值会在命名卷中启动另一个独立实例。

该配置默认发布到所有网卡的 **21000** 端口。对公网开放前完成初始化并设置访问边界；使用反向代理时，可将 Compose 端口绑定改为 `127.0.0.1:${RAWMARK_PORT:-21000}:8080`。自定义端口可使用 `RAWMARK_PORT=21001 docker compose -f deploy/docker-compose.yml up -d --build --wait`。

不要把快速开始中的容器与 Compose 实例同时指向同一份数据库或笔记库；切换部署方式前先停止旧实例、备份并确认数据位置。

## 预构建镜像与原生程序

Forgejo 发布 `git.134333.xyz/eezd/rawmark:<版本>`，支持 Linux amd64 和 arm64。建议固定版本标签；OCI `:latest` 仅指向按 main 祖先关系确定的最新已验收 main 正式版本，同步后 GHCR 使用同摘要。没有 `latest` Git TAG。安装前先核对 Releases 和软件包公开状态。仓库 Compose 文件继续支持源码构建。

[Forgejo Releases 页面](https://git.134333.xyz/eezd/RawMark/releases) 提供 Linux、Windows 和 macOS 的 amd64 与 arm64 原生压缩包及 `SHA256SUMS`。下载对应系统和架构，先核对校验和再解压：

```sh
sha256sum --ignore-missing --check SHA256SUMS
tar -xzf RawMark_YYYYMMDD-xxxxxxxx_linux_amd64.tar.gz
./rawmark --version
RAWMARK_DATA="$HOME/rawmark-data" RAWMARK_ADDR=127.0.0.1:21000 ./rawmark
```

macOS 的 Apple Silicon 使用 `darwin_arm64`，Intel 使用 `darwin_amd64`。先将 `shasum -a 256 RawMark_YYYYMMDD-xxxxxxxx_darwin_arm64.tar.gz` 的结果与 `SHA256SUMS` 中对应记录比较，再用 `tar -xzf` 解压并沿用上述环境变量启动。程序未签名，若系统提示拦截，请核对来源后通过 macOS 安全设置手动允许。

Windows 先将 `Get-FileHash` 的结果与 `SHA256SUMS` 中对应记录比较，再在 PowerShell 中启动：

```powershell
Get-FileHash .\RawMark_YYYYMMDD-xxxxxxxx_windows_amd64.zip -Algorithm SHA256
Expand-Archive .\RawMark_YYYYMMDD-xxxxxxxx_windows_amd64.zip -DestinationPath .\rawmark
Set-Location .\rawmark
.\rawmark.exe --version
$env:RAWMARK_DATA = Join-Path $env:LOCALAPPDATA 'RawMark'
$env:RAWMARK_ADDR = '127.0.0.1:21000'
.\rawmark.exe
```

打开 `http://127.0.0.1:21000` 设置密码。原生程序是在终端运行的网页服务端，不含桌面窗口、安装器或代码签名；按 Ctrl+C 停止。替换程序时保留数据目录。跨系统迁移已有笔记库时，文件名须符合目标文件系统要求；Windows 会拒绝设备名、备用数据流和末尾点/空格，不会静默改名。

Linux ARM 系统请使用 Linux arm64 压缩包。以普通用户运行，并确保所选数据目录可写。程序已内嵌前端和示例，无需 Node.js 或独立数据库服务。长期远程运行请配置服务管理器和 HTTPS 反向代理。

## 存储与配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RAWMARK_DATA` | `/data` | 应用数据库、索引、资源与默认笔记库所在目录 |
| `RAWMARK_VAULT` | `$RAWMARK_DATA/vault` | Markdown 笔记库，可以单独挂载已有目录 |
| `RAWMARK_ADDR` | `:8080` | 容器或二进制内部的监听地址 |

主要数据：

| 路径 | 内容 |
| --- | --- |
| `vault/` | Markdown 文件、附件与笔记库元数据；设定外置笔记库时位于对应目录 |
| `rawmark.db` | 密码、会话、API 令牌、设置等应用状态 |
| `index.db` | 可重建的搜索索引 |
| `fonts/`、`themes/`、`plugins/` | 用户导入的字体、主题和插件 |
| `backups/` | 导入或恢复操作前生成的回退备份 |
| `logs/` | 运行日志 |

要接入已有文件夹，可额外挂载它并设置 `RAWMARK_VAULT`：

```sh
docker run -d --name rawmark --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:21000:8080 \
  -v "$HOME/rawmark-data:/data" \
  -v "$HOME/notes:/vault" \
  -e RAWMARK_VAULT=/vault \
  rawmark
```

先创建 `$HOME/rawmark-data` 和 `$HOME/notes`，确保所选用户可写。此例以宿主机当前用户运行，适合管理自己的已有目录；不设置 `--user` 时须给容器默认用户写权限。RawMark 会修改笔记和链接，首次接入前请备份已有目录。

## HTTPS 与反向代理

远程访问使用 HTTPS。代理到 RawMark 时需要转发 Host、协议与来源地址，并启用 WebSocket 升级和长连接；浏览器事件连接使用 `/api/v1/resources/<ticket>/events/`。代理上传限制也应满足实际导入需求。

[仓库 Nginx 配置](../deploy/nginx/raw.134333.xyz.conf)包含 WebSocket 和票据日志脱敏示例，但其中域名、证书 include、反爬 include、端口及日志路径属于原部署环境，**需要按自己的服务器调整，不能原样安装**。`$connection_upgrade` 的 map 也需要在 Nginx 的 `http` 上下文定义。

资源票据是凭据：代理、CDN 和访问日志不得记录明文票据、查询参数或携带凭据的 Referer；应用的 `no-store` 不能代替代理日志脱敏。Nginx 错误日志也可能包含原始请求路径，仓库示例对票据资源路径关闭错误日志，保留脱敏访问日志及应用错误日志。

若使用 CDN，需独立完成自定义域名与 TLS 证书配置，并确认 API、私有资源和 WebSocket 不被错误缓存；仅配置 DNS 不代表 HTTPS 接入已完成。

## 备份与恢复

在「设置 → 存储空间」选择所需导出类型：

| 类型 | 适合用途 | 恢复行为 |
| --- | --- | --- |
| 普通 Markdown 笔记库 | 迁移到其他笔记工具 | 导入到新文件夹，不替换实例 |
| 设置与资源 | 迁移偏好、插件数据、字体/主题/插件 | 合并资源，同 ID 替换，包外资源保留 |
| 完整实例 | 迁移或恢复 RawMark | 替换业务数据，包含登录信息、回收站和资源，完成后重新登录 |

设置导入与完整恢复只接受本程序的版本化 ZIP，应用前会在 `backups/` 保留回退包。上传顺序分块，每块 8 MiB，压缩包上限 2 GiB，展开上限 8 GiB、100000 项。不包含运维环境配置、派生索引或临时文件。

完整恢复前停止其他程序直接改写笔记库。维护时暂时暂停 API 操作，关闭数据库和后台任务后恢复，中断时回退操作前备份。导出的完整包包含账户和笔记等敏感数据，应妥善保管，不提交到仓库或附在公开 Issue 中。

独立于应用备份，升级前建议停止服务后备份完整数据目录、外置笔记库、部署配置与旧镜像。SQLite 运行时可能有 WAL 文件，不要只复制正在写入的 `rawmark.db` 来冒充一致备份。

## 升级与回退

1. 确认目标版本的行为和数据兼容性，保留当前镜像及部署配置。
2. 停止旧服务，备份应用数据与外置笔记库。
3. 拉取选定的预构建镜像版本标签，使用同一份挂载启动新实例；源码构建仅供贡献者选择，不用于托管生产更新。不要并行运行新旧服务。
4. 核对容器健康、登录、笔记与附件。回退时使用配套的旧镜像与数据备份。

Bearer 认证升级需要前后端一起发布。旧 Cookie 页面不能继续使用，需重新登录；启动程序会沿现有 SQLite 初始化流程创建资源票据表和索引，笔记、密码、设置与已有 API 令牌保留。第三方客户端的 JSON 解包方式须遵循[当前协议](api.zh-CN.md)。

`scripts/remove-sharing.sql` 和 `scripts/reset-shortcuts.sql` 是历史版本的一次性迁移：前者移除旧分享数据，后者清空旧快捷键覆盖。**新部署无需运行，已执行过的实例不要重跑**；只有确认来自对应旧版本且需要该迁移时，才在停服并备份后单独执行。

## 日常维护与排查

- 容器自带健康检查，也可访问 `GET /api/v1/health`；健康不代表所有业务流程已验证。
- 设置内的优化/重建仅处理派生索引；清理临时文件不删除用户文件、活动上传或恢复备份。
- 重置设置保留账户、资源、插件存储和本机标签页。
- 日志位于 `logs/`，轮转保留三份，每份至多 10 MiB；可在设置中导出日志及版本摘要。该功能不补录历史日志。
- 更新后界面异常先核对前后端是否来自同一构建，再查看浏览器网络请求和应用日志；插件与外观恢复入口见[使用指南](guide.zh-CN.md#插件与界面恢复)。
- 笔记读取返回 `Cache-Control: no-store, no-transform`，防止代理改写条件保存使用的强版本 ETag。代理将其改为弱 ETag 可能导致正常编辑返回 HTTP 412；公网入口须保留该响应策略。

## 本地 systemd 与手动发布

以 root 运行 `/srv/RawMark/start.sh` 可编译当前工作区并更新 `rawmark-dev.service`；`stop.sh` 只停止服务，`status.sh` 只读显示服务及构建状态。unit 以 root 运行，无需专用账号，分别调用 `start.sh --systemd` 与 `stop.sh --systemd`，不重新编译或递归调用 systemctl。默认监听 `127.0.0.1:21001`。项目脚本、运行配置和构建产物不得允许不可信用户修改。

`runtime/` 不入库：`builds/` 保存独立构建，`current` 指向活动产物，`config/rawmark.env` 配置 RAWMARK_DATA、RAWMARK_VAULT、RAWMARK_ADDR，`data/` 保存数据库、笔记和附件，`backups/` 保存迁移备份。脚本使用宿主 Go、Node 和锁定 pnpm，不安装全局工具链。候选检查、构建和合成数据冒烟通过后才切换服务；失败恢复旧产物和 unit。启停共用 `runtime/.deploy.lock`，构建记录包含完整 SHA、dirty 状态和时间。本地构建允许未提交源码。

Forgejo 是唯一主仓库，`origin` 指向 `https://git.134333.xyz/eezd/RawMark.git`。普通 `git push` 只更新 Git 引用，不触发检查、构建、发布、部署或 GitHub 同步。

### Forgejo 网页手动入口

在 Forgejo Actions 页面选择以下工作流，并使用可信 `main` 运行。根目录 `release.sh`、`sysnc-github.sh` 已移除，不提供本地 CLI 或兼容包装器；普通 push 不触发工作流，发布也不会自动同步。

| 入口 | 输入与行为 |
| --- | --- |
| **Manual release (RawMark)** | `.forgejo/workflows/release.yml`：`source_branch` 默认 `main`，`source_sha` 可空或完整 40 位小写 SHA。任务实际开始时解析远端分支，空 SHA 冻结该时刻尖端，显式 SHA 须属于指定分支；`scripts/resolve-release.py` 写临时 `RELEASE_CONTEXT`。随后 `scripts/manual-release.py` 构建六平台包、静态 demo 及 Linux 双架构 OCI，只发布 Forgejo。 |
| **Manual GitHub sync (RawMark)** | `.forgejo/workflows/sync-github.yml`：无自定义输入，运行 `scripts/sync-github.py`，仅同步已批准公开的 `main`、`dev`、范围内 TAG、已验收正式原件和镜像到 GitHub/GHCR，不重建。 |

两个工作流控制代码均检出本次 run 固定的可信 `forgejo.sha`，只接受 `workflow_dispatch`，按 `docker` 标签调度，共享静态并发组 `rawmark-delivery`、`cancel-in-progress: false`。不绑定 Runner 身份、不挂载项目宿主目录。首次接入或改动并发规则后须实测 A 占用、B 等待、取消 A 后 B 继续；平台可能取消多余 pending 请求，被取消的等待请求需人工重新运行。

**凭据仅由 Actions Secrets 显式提供**：`RELEASE_TOKEN` 在发布映射为 `FORGEJO_RELEASE_TOKEN`，在同步映射为 `FORGEJO_TOKEN`；`MIRROR_TOKEN` 仅在同步映射为 `GITHUB_TOKEN`。令牌分别需要对应仓库、Release 和 Registry 的读写权限。API、精确 HTTPS Git URL 和 Registry 各自认证；临时认证文件权限 `0600`、目录 `0700`，任务结束精确删除。缺 Secret 在远端写入前停止。不读取宿主 HOME Token、credential helper、Registry authfile 或本地锁，也不修改 GitHub Actions 设置。同步前必须确认 GitHub Actions 已关闭；分支分叉或 TAG 冲突停止，不强推、不删除历史。

**候选构建隔离**：Go 1.27.2、Node 24、pnpm 12.11.2 工具镜像仅安装工具。候选及只读可信控制树均由固定 Git SHA 导出，以 Docker create/cp/start 在独立 UID 10001 容器内执行；无 `.git`、Secret、宿主挂载、Docker 连接或共享 PID。执行完整检查、六平台交叉编译及 Linux amd64 合成数据备份恢复冒烟；其余五平台仅交叉编译，不冒充原生运行。控制器只接收有大小上限的扁平普通产物，再独立验收容器持久化。镜像上传后以认证和独立空 authfile/HOME 逐字节验收顶层及两个架构清单；源码、未提交文件、运行数据和凭据不会混入导出。

版本为提交 UTC 日期加八位 SHA。发布说明取同分支已验收的最近祖先（父边最短距离；等距时按正式发布时间降序、TAG 升序），没有基线时严格为 `init`；同分支历史重写而失去基线时停止。正式历史以 Forgejo Release、TAG、`build.json` 和最后写入并读回的 `release-complete.json` 为准。schema 5 元数据记录冻结的网页输入、来源分支尖端、控制 SHA、run ID 和请求 UUID；schema 4 已完成记录继续按原证明复用。损坏完成记录停止，不能覆盖。

同 SHA 跨分支复用原完成版，不改变来源或说明；dev 版本复用为 main 请求时不会伪造 main 完成记录。版本镜像不可变，唯一可变分发别名为 Forgejo/GHCR OCI `:latest`：仅在完成证明和原件验收后，按 main 祖先关系选最新正式版本、固定源摘要同双架构复制。dev 发布不移动别名，历史 main 重跑不回退；未知别名、不可达或分叉的 main 历史停止核对。若只更新别名失败，重跑只验收完成版并修复别名，不重建或覆盖版本。

上传前失败只丢弃临时产物，不阻塞新 SHA。不用 Generic Packages、持久原件或恢复检查点。未完成同版先证明旧任务已结束及 TAG/Release/镜像归属，从原 SHA 全量构建并验收替代产物，再复查身份不变，才精确删除该版本 Release/附件和镜像；正确 TAG 保留。schema 5 核对旧 run 的 `commit_sha`、可信 main 事件 ref 及归一化网页输入；schema 4 未完成记录仍严格核对旧三输入，不静默升级证明。陌生内容、任务在途、完成记录损坏或删除结果不明均停止。重跑旧版在网页填原 `source_branch` 和完整 `source_sha`，新请求 UUID 由解析器生成。所有 Docker context、Buildx builder、容器、卷、网络和认证目录按 run/attempt 精确清理，不全局 prune。

GitHub 接收六包、`SHA256SUMS`、`build.json` 和同摘要镜像，不接收内部完成记录、`packages.json` 或 demo。正式原件哈希、TAG/SHA 和两端双架构摘要逐项核对；缺验收证据的旧正式版本不冒充成功。GHCR 首次分发如仍为 private，须操作者在网页设为 public 后重跑同步；认证复制成功不代表匿名可拉取，匿名验收失败会明确报错。发布不会部署、合并分支或写 GitHub，同步也不会重新构建、部署或切换 Pages。

从旧 Docker 实例迁移后应停止旧容器并关闭自动重启。若新实例已有写入，不可直接启动旧数据副本回退；先停服并处理新增数据。运行配置和迁移备份不得提交到 Git。
