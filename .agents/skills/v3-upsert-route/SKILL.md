---
name: v3-upsert-route
description: 调整登录守卫与权限路由
---

先读根 AGENTS.md、`web/src/router/` 和 `pinia/stores/{user,permission}.ts`。常驻与动态路由按现有实现登记，匿名路由使用 meta.anonymous，真实权限来自 /auth/me，无角色系统。唯一名称、懒加载；核对匿名/初始化/回跳、深链、403、401、注销及换会话，旧结果不能注册新会话路由。
