---
name: v3-use-utils
description: 复用公共工具与认证能力
---

先读根 AGENTS.md 和 `web/src/common/utils/` 的实际实现。命令、路径、通知、PWA 等按已有签名复用；认证 Token 由 user store 维护，不绕过会话与动态路由清理。没有模板示例的角色/日期工具，不引入虚构依赖。API 请求只通过 `common/apis/<resource>/index.ts` 的独立函数与 `http/axios` 的 request；原生资源票据缓存等实际共享工具留在 common/utils。页面专用转换留在页面模块，未知外部输入在边界校验。
