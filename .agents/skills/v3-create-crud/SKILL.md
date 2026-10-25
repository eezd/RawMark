---
name: v3-create-crud
description: 调整业务页面与表单
---

先读根 AGENTS.md，核对后端路由和现有业务调用链。页面放 `web/src/pages/<module>/`，私有 API/类型跟随模块；真正跨模块共享才放 common。复用实际 Element Plus 控件和 `http/axios` 的 requestJSON/requestRaw，不预设分页、CRUD、导出或角色能力。失败保留原因，成功后再关闭/刷新，取消确认不得伪装成实际操作成功。按行为测试成功、失败与权限边界。
