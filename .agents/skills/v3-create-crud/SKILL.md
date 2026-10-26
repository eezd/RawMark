---
name: v3-create-crud
description: 调整业务页面与表单
---

先读根 AGENTS.md，核对后端路由和现有业务调用链。页面私有组件、类型和组合函数放 `web/src/pages/<module>/`；全部 API 放 `common/apis/<resource>/{index.ts,type.ts}`。按模板导出独立 `*Api` 函数，用 `request<ResponseData>({ url, method, data, params })` 返回完整响应，调用方读取 `.data`；原文/下载按实际语义保留响应。复用 Element Plus 的 Form、Dialog、表单控件和 Table，不预设分页、CRUD、导出或角色能力。失败保留原因，成功后再关闭/刷新，取消确认不得伪装成实际操作成功。按行为测试成功、失败与权限边界。
