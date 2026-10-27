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

正式发布后提供 `ghcr.io/eezd/rawmark:<版本>`，支持 Linux amd64 和 arm64。此前版本已撤回，`VERSION` 不代表版本已可下载；使用下方示例版本前先核对 Releases 和软件包公开状态。将上述 Docker 命令中的 `rawmark` 镜像名替换为它即可跳过源码构建。`latest` 跟随最新稳定版本；需要可控升级时请固定版本标签。仓库 Compose 文件继续支持源码构建。

[Releases 页面](https://github.com/eezd/RawMark/releases) 提供 Linux amd64/arm64、Windows amd64 和 macOS Intel/Apple Silicon 原生压缩包及 `SHA256SUMS`。下载对应系统和架构，先核对校验和再解压：

```sh
sha256sum --ignore-missing --check SHA256SUMS
tar -xzf rawmark_0.1.1_linux_amd64.tar.gz
./rawmark --version
RAWMARK_DATA="$HOME/rawmark-data" RAWMARK_ADDR=127.0.0.1:21000 ./rawmark
```

macOS 的 Apple Silicon 使用 `darwin_arm64`，Intel 使用 `darwin_amd64`。先将 `shasum -a 256 rawmark_0.1.1_darwin_arm64.tar.gz` 的结果与 `SHA256SUMS` 中对应记录比较，再用 `tar -xzf` 解压并沿用上述环境变量启动。程序未签名，若系统提示拦截，请核对来源后通过 macOS 安全设置手动允许。

Windows 先将 `Get-FileHash` 的结果与 `SHA256SUMS` 中对应记录比较，再在 PowerShell 中启动：

```powershell
Get-FileHash .\rawmark_0.1.1_windows_amd64.zip -Algorithm SHA256
Expand-Archive .\rawmark_0.1.1_windows_amd64.zip -DestinationPath .\rawmark
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
3. 拉取选定的预构建镜像摘要，使用同一份挂载启动新实例；源码构建仅供贡献者选择，不用于托管生产更新。不要并行运行新旧服务。
4. 核对容器健康、登录、笔记与附件。回退时使用配套的旧镜像与数据备份。

Bearer 认证升级需要前后端一起发布。旧 Cookie 页面不能继续使用，需重新登录；启动程序会沿现有 SQLite 初始化流程创建资源票据表和索引，笔记、密码、设置与已有 API 令牌保留。第三方客户端的 JSON 解包方式须遵循[当前协议](api.zh-CN.md)。

`scripts/remove-sharing.sql` 和 `scripts/reset-shortcuts.sql` 是历史版本的一次性迁移：前者移除旧分享数据，后者清空旧快捷键覆盖。**新部署无需运行，已执行过的实例不要重跑**；只有确认来自对应旧版本且需要该迁移时，才在停服并备份后单独执行。

## 日常维护与排查

- 容器自带健康检查，也可访问 `GET /api/v1/health`；健康不代表所有业务流程已验证。
- 设置内的优化/重建仅处理派生索引；清理临时文件不删除用户文件、活动上传或恢复备份。
- 重置设置保留账户、资源、插件存储和本机标签页。
- 日志位于 `logs/`，轮转保留三份，每份至多 10 MiB；可在设置中导出日志及版本摘要。该功能不补录历史日志。
- 更新后界面异常先核对前后端是否来自同一构建，再查看浏览器网络请求和应用日志；插件与外观恢复入口见[使用指南](guide.zh-CN.md#插件与界面恢复)。

## 开发与生产托管

仓库 `deploy/compose.image.yml` 是仅拉镜像的模板，复制至实例目录并命名为 `compose.yml`，旁边放权限 600 的私有 `.env`。实例不依赖源码工作目录，必须明确填写：

```dotenv
RAWMARK_CHANNEL=development
RAWMARK_PROJECT=rawmark-dev
RAWMARK_BIND=127.0.0.1
RAWMARK_PORT=21001
RAWMARK_DATA_DIR=/docker/main/rawmark-dev/data
RAWMARK_IMAGE=git.134333.xyz/eezd/rawmark@sha256:<已验证摘要>
```

生产使用 channel `production`、project `rawmark`、端口 21000、`/docker/main/rawmark/data` 和 `ghcr.io/eezd/rawmark@sha256:<已验证摘要>`；迁移时保留当前监听地址。仅为新的开发目录设置 `65532:65532` 所有者，不递归修改现有生产权限，不将仓库示例模板作为运行数据挂载。

main push CI 自动更新开发。Gitea **Deploy production manually** 工作流只接受两端均正式发布、构建/发布回执相同且标签一致的版本。它固定 GHCR 摘要，检查原挂载与并发写入实例，仅停止本项目旧服务，备份完整数据目录和配置后替换。备份为私有文件并包含 SQLite WAL；旧镜像和备份继续保留。

替换前记录 `deployment.pending.json`，健康和前端检查通过后记录 `deployment.json`。候选版本访问数据后失败则停止候选，保留备份和 pending 记录，不自动恢复私人数据，也不直接用旧程序打开可能迁移后的数据；恢复须明确授权并核对兼容性。备份在替换前失败时，旧数据未被新程序访问，可安全重新启动旧容器。不做全局 Docker 清理。

准备生产文件不等于重启当前服务或执行数据迁移。首次从旧源码构建 Compose 切换须明确授权生产更新，不同时运行两套 Compose。先用合成数据演练更新和恢复。

新开发域名须完成 DNS、CDN 自定义主机名及证书激活，并配置源站和国内入口。必须验证公网访问，不能仅凭回环端口健康或 DNS 有记录认定成功。所有代理都要对资源票据路径脱敏。
