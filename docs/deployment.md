# 部署与维护

[返回项目首页](../README.zh-CN.md) · [使用指南](guide.md) · [开发指南](development.md)

RawMark 将前端嵌入 Go 服务，运行时使用 SQLite 与文件系统，不需要额外数据库服务。目前从源码构建 Docker 镜像；以下命令不依赖预先发布的镜像仓库。

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

## Docker Compose

仓库提供 [deploy/docker-compose.yml](../deploy/docker-compose.yml)，使用宿主机的 `deploy/data/` 持久化。Linux 上首次部署可执行：

```sh
mkdir -p deploy/data
sudo chown 65532:65532 deploy/data
docker compose -f deploy/docker-compose.yml up -d --build --wait
```

该配置默认发布到所有网卡的 **21000** 端口。对公网开放前完成初始化并设置访问边界；使用反向代理时，可将 Compose 端口绑定改为 `127.0.0.1:${RAWMARK_PORT:-21000}:8080`。自定义端口可使用 `RAWMARK_PORT=21001 docker compose -f deploy/docker-compose.yml up -d --build --wait`。

不要把快速开始中的容器与 Compose 实例同时指向同一份数据库或笔记库；切换部署方式前先停止旧实例、备份并确认数据位置。

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
3. 更新源码并重新构建，使用同一份挂载启动新实例；不要并行运行新旧服务。
4. 核对容器健康、登录、笔记与附件。回退时使用配套的旧镜像与数据备份。

Bearer 认证升级需要前后端一起发布。旧 Cookie 页面不能继续使用，需重新登录；启动程序会沿现有 SQLite 初始化流程创建资源票据表和索引，笔记、密码、设置与已有 API 令牌保留。第三方客户端的 JSON 解包方式须遵循[当前协议](api.md)。

`scripts/remove-sharing.sql` 和 `scripts/reset-shortcuts.sql` 是历史版本的一次性迁移：前者移除旧分享数据，后者清空旧快捷键覆盖。**新部署无需运行，已执行过的实例不要重跑**；只有确认来自对应旧版本且需要该迁移时，才在停服并备份后单独执行。

## 日常维护与排查

- 容器自带健康检查，也可访问 `GET /api/v1/health`；健康不代表所有业务流程已验证。
- 设置内的优化/重建仅处理派生索引；清理临时文件不删除用户文件、活动上传或恢复备份。
- 重置设置保留账户、资源、插件存储和本机标签页。
- 日志位于 `logs/`，轮转保留三份，每份至多 10 MiB；可在设置中导出日志及版本摘要。该功能不补录历史日志。
- 更新后界面异常先核对前后端是否来自同一构建，再查看浏览器网络请求和应用日志；插件与外观恢复入口见[使用指南](guide.md#插件与界面恢复)。
