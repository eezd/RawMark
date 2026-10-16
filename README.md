# RawMark

纯 Markdown 笔记网页编辑器：所见即所得（类 Obsidian Live Preview）、文件即真源、Docker 部署、浏览器访问。

## 部署

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

- 首次打开需要输入启动码，位于数据目录的 `setup-code.txt`（如 `~/rawmark-data/setup-code.txt`），设置密码后自动删除。
- 笔记以普通 `.md` 文件保存在 `数据目录/vault/`，图片按 Typora 习惯存放在同级的 `笔记名.assets/`，可直接用 Typora 等编辑器打开；外部修改会实时同步到网页。
- `--user` 让容器以宿主机用户身份读写数据目录；不指定时容器以 UID 65532 运行，需要该用户对目录有写权限。
- 请通过 HTTPS 反向代理（Caddy、Nginx 等）访问，并转发 WebSocket（`/api/v1/events`）。笔记加密等功能依赖浏览器的安全上下文，纯 HTTP 下不可用。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RAWMARK_DATA` | `/data` | 数据目录（数据库、默认笔记仓库） |
| `RAWMARK_VAULT` | `$RAWMARK_DATA/vault` | 笔记仓库目录，可指向已有的笔记文件夹 |
| `RAWMARK_ADDR` | `:8080` | 监听地址 |

## 开发

需要 Go 1.27+ 与 Node 24+。开发时不必构建前端或 Docker 镜像，一键启动：

```sh
scripts/dev.sh          # 后端 go run -tags dev + 前端 Vite 热更新，Ctrl+C 同时退出
scripts/dev.sh --host   # 前端监听所有网卡，手机访问 http://<电脑 IP>:5173
```

浏览器打开 http://localhost:5173 ，启动码在 `.dev-data/setup-code.txt`。端口与数据目录可用 `API_PORT`、`WEB_PORT`、`RAWMARK_DATA` 覆盖，详见 `scripts/dev.sh --help`。

检查：

```sh
cd web && npm run typecheck && npm test
go vet -tags dev ./... && go test ./internal/...
```
