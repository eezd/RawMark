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

- 首次打开直接设置登录密码，之后凭密码登录；请在将新实例开放给他人访问前完成初始化。
- 笔记以普通 `.md` 文件保存在 `数据目录/vault/`，图片按 Typora 习惯存放在同级的 `笔记名.assets/`，可直接用 Typora 等编辑器打开；外部修改会实时同步到网页。
- 知识工具：标准 Markdown 链接构成图谱和反向链接，支持正文 `#标签` 与 YAML `tags`。笔记或文件夹在应用内改名、移动时维护入链和相对出链；公式和代码示例不参与关系提取。
- 日记与模板：默认日记路径为 `Daily/YYYY-MM-DD.md`（本地日期），已有日记直接打开；模板为 `Templates/` 下的普通 Markdown，支持 `{{date}}`、`{{time}}`、`{{title}}`，资源链接按新笔记位置调整。可在设置中修改目录和日记模板。
- 外观：浅色玻璃工作台与深色模式，字体资源随应用本地提供；界面字号默认 16px，可输入 14–20px 并单独重置，与编辑器及阅读字号独立；排版、玻璃透明度、选中文本工具栏均可在设置中调整并即时保存。
- 图片管理：侧栏默认隐藏 `assets` 和 `笔记名.assets`；右键文件夹选择「图片管理」，查看当前目录及直属附件目录的图片，支持检索、排序、网格/列表、批量上传、引用查看及预览、重命名、移动、替换。可切换整个知识库；清理孤立图片须确认候选，服务端再次核对全库引用与有效分享后移入回收站，可恢复。上传至所选目录的 `assets/`，相同内容自动去重。根目录可在侧栏空白处右键或通过命令面板打开。图片改名/移动会更新笔记中的本地引用；替换保留路径，选择相同扩展名的图片（最大 50 MB），旧图片不进回收站。
- `--user` 让容器以宿主机用户身份读写数据目录；不指定时容器以 UID 65532 运行，需要该用户对目录有写权限。
- 请通过 HTTPS 反向代理（Caddy、Nginx 等）访问，并转发 WebSocket（`/api/v1/events`）。
- 分享：文件或文件夹右键「分享」，也可通过命令面板（F1）分享当前笔记；多选生成一个合集链接。链接 `/s/…` 的标识完全随机，展示源文件最新内容并跟随分享主体移动；文件夹递归包含当前内容。可设密码与有效期，在设置中管理与撤销。公开阅读页仅提供分享范围内的导航、大纲、阅读进度、复制与打印，不加载编辑器。
- 多选与导出：Ctrl/Cmd 点击切换选择，Shift 点击选择可见范围；右键批量分享、删除、移动或导出 Markdown。单篇无附件直接下载 `.md`，其他情况下载包含 Markdown 与本地附件的 ZIP；重名目标不会被覆盖，批量操作会汇报单项失败。
- 快捷键：设置中支持添加、逐条移除和单项/全部重置，并拒绝冲突绑定。默认 Ctrl+Alt+1～6 设置对应级别标题，同级再次触发恢复正文；字号可直接输入。
- 导入：侧栏顶部或文件夹右键菜单选择「导入」，支持多选 UTF-8 `.md` 文件或单个 ZIP（总上传上限 100 MB）。ZIP 新建同名文件夹并保留层级，本地图片转换为笔记独立附件，原附件保留；同名内容不覆盖，缺失的本地链接会提示，外部图片不会自动下载。
- 自动化：「API 令牌」中创建只读或读写令牌，以 `Authorization: Bearer <令牌>` 调用 REST API，接口说明见 `/api/v1/openapi.json`。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RAWMARK_DATA` | `/data` | 数据目录（数据库、可重建的搜索索引 `index.db`、默认笔记仓库） |
| `RAWMARK_VAULT` | `$RAWMARK_DATA/vault` | 笔记仓库目录，可指向已有的笔记文件夹 |
| `RAWMARK_ADDR` | `:8080` | 监听地址 |

## 开发

需要 Go 1.27+ 与 Node 24+。开发时不必构建前端或 Docker 镜像，一键启动：

```sh
scripts/dev.sh          # 后端 go run -tags dev + 前端 Vite 热更新，Ctrl+C 同时退出
scripts/dev.sh --host   # 前端监听所有网卡，手机访问 http://<电脑 IP>:5173
```

浏览器打开 http://localhost:5173 ，首次使用直接设置登录密码。端口与数据目录可用 `API_PORT`、`WEB_PORT`、`RAWMARK_DATA` 覆盖，详见 `scripts/dev.sh --help`。

检查：

```sh
cd web && npm run typecheck && npm test
go vet -tags dev ./... && go test ./internal/...
```
