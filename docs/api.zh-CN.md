# API 与认证

[English](api.md) · **简体中文**

[返回项目首页](../README.zh-CN.md) · [开发指南](development.zh-CN.md)

API 基础路径为 `/api/v1`。完整端点、请求字段、权限和响应以 [OpenAPI 源文件](../internal/api/openapi.json)为准，运行中的实例在 `GET /api/v1/openapi.json` 提供同一文档。测试 `TestOpenAPICoversRoutes` 核对路由覆盖。

## 脚本接入

在「设置 → 账户与安全 → API 令牌」创建只读或读写令牌。受保护 API 只接受 `Authorization: Bearer <token>`，不接受 Cookie，也不要将主令牌放进 URL。

以下只读示例从环境变量读取凭据：

```sh
# Set RAWMARK_URL and RAWMARK_TOKEN locally first; never commit real values.
curl --fail-with-body \
  -H "Authorization: Bearer $RAWMARK_TOKEN" \
  "$RAWMARK_URL/api/v1/tree"
```

`rm_` API 令牌在服务端只存哈希，保留 read/write 权限。只读令牌可读取笔记、搜索和执行只读 POST 导出，不能写入；API 令牌不能管理账户、令牌、维护或资源票据，不能为自身扩权。管理操作需要浏览器登录会话。

## JSON 与 HTTP 语义

普通 JSON 成功响应：

```json
{
  "code": 0,
  "data": { "ok": true },
  "message": "Success"
}
```

`code = 0` 表示成功，非零表示失败；失败时 `message` 是可展示的原因。保留真实 HTTP 状态，不把错误全部转为 200。通用错误码为 HTTP 状态乘 100，特定业务码如下：

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | 40001 | 验证码错误、无效或已使用 |
| 400 | 40002 | 验证码过期 |
| 400 | 40003 | 修改密码时当前密码错误，不清理身份 |
| 401 | 40101 | 登录密码错误 |
| 412 | 41200 | 文件版本冲突，当前版本在 `data.rev` |

401 表示需要重新认证；403 表示当前身份没有权限，不能据此注销用户。维护输入或备份内容无效返回 400，占用或空间不足返回 503，文件系统/数据库内部故障返回 500。

**文件原文、下载、WebSocket、204 及 OpenAPI 文档不包 JSON 外壳**。`GET /files/{path}` 返回 Markdown 原文和 `ETag`；`PUT /files/{path}` 接收原文，成功返回包含 `rev` 的 JSON。用 `If-Match: "rev"` 防止覆盖新版本，或 `If-None-Match: *` 要求目标不存在；都不带会直接覆盖，不适合需要冲突保护的写入。

## 响应语言

发送 `Accept-Language: en` 或 `Accept-Language: zh-CN` 选择应用提示的语言，未指定或不支持的语言默认英文。服务端按质量权重选择支持的语言，并在 API 响应的 `Content-Language` 中返回实际语言；API 继续 `Cache-Control: no-store`。`message`、导入警告、维护状态及清理跳过原因会本地化，HTTP 状态、业务码、字段、笔记正文及用户资源名称保持不变。客户端应按状态和 `code` 判断结果，不能匹配翻译后的文案。

账户语言位于 `/settings` 的 `locale` 字段，仅支持 `en`、`zh-CN`；PATCH 传 `null` 删除覆盖，恢复默认英文。该字段与其他设置一同导出、导入和同步；登录页的临时选择不写入账户。请求头只影响当前响应，不修改账户语言。

## 浏览器登录

实例没有用户名、注册或角色系统。尚未初始化时，`POST /auth/setup` 使用 `{ password }` 设置密码并返回会话；已经初始化的实例不能再次初始化。

正常登录流程：

1. `POST /auth/captcha` 获取 `{ captchaId, imageDataUrl, expiresAt }`。
2. 展示图片，用户填写密码与六位数字验证码。
3. `POST /auth/login` 提交 `{ password, captchaId, captchaCode }`。
4. 成功返回 `{ token, expiresAt }`，再通过 `GET /auth/me` 恢复真实身份与权限。

以上字段均位于普通响应的 `data` 中。刷新验证码时传 `{ replaceId }` 使旧挑战失效。挑战绑定来源，五分钟过期；每次登录提交一次性消费，即使密码或验证码错误也不能重用，失败必须刷新。签发与登录均保留限流。

`rms_` 浏览器会话 Token 保存在 localStorage 的 `rawmark.token`，固定三十天有效、不滑动续期，服务端仅存哈希。退出调用 `POST /auth/logout`，服务端撤销成功返回 204 后才清理本地身份；请求失败时保留身份并提示错误，不能仅删除本地 Token 宣称注销完成。

localStorage 可被同源脚本读取；有完整前端权限的插件必须视为可信代码，不能承诺凭据隔离。

## 原生资源与事件

原生图片、字体、插件模块与浏览器 WebSocket 不能统一设置认证头，通过 `POST /auth/tickets` 获取受限资源 URL；主 Token 不进入 URL。票据服务端只保存哈希，每次读取检查父会话，父会话退出后即失效。

- 图片/字体票据不超过父会话有效期。
- 插件票据额外绑定插件 ID 和版本，支持相对模块导入。
- 事件握手票据一分钟有效、仅消费一次；已连接事件仍会检查父凭据。
- 脚本 WebSocket 客户端可以通过 Bearer 请求头继续连接 `/api/v1/events`。

私有响应使用 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`，API 和私有资源不进入 PWA 静态缓存。代理日志也需脱敏，见[部署文档](deployment.zh-CN.md#https-与反向代理)。

## 前端请求责任

请求处理、认证与路由守卫分别位于 `http/`、`pinia/` 和 `router/`。匿名跳登录并保留合法站内回跳，拒绝外部地址与循环跳转。401 清理当前身份、权限与动态路由，403 保留身份。

每次替换或退出会话更新代号、取消旧请求。用户信息、路由安装、异步响应与排队写入均须检查所属会话；旧结果按 Axios 取消语义拒绝，不能覆盖或注销新身份，也不提示取消错误。

同一错误只由一个责任层提示。请求默认负责展示，已有行内状态、保存重试或批量汇总的 API 使用 `errorOwner: 'caller'`；失败依然 reject，不以空列表或默认值伪装成功。

## 旧客户端迁移

统一协议需要前后端同时更新，不保留 Cookie/Bearer 或两种 JSON 格式兜底。旧 `rm_` API 令牌无需重建，但调用方要改为读取 `{ code, data, message }` 中的 `data`；文件及导出字节语义不变。旧浏览器页面需重新登录，不能连接新旧混用的后端。
