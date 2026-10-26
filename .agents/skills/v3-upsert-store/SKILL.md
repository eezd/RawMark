---
name: v3-upsert-store
description: 调整 Pinia 共享状态
---

先读根 AGENTS.md 和现有 store。跨页面共享状态放 `web/src/pinia/stores/`，使用 Setup Store，状态、动作和保存队列均归 store 实例所有，API 从 common/apis 对应资源导入；页面表单和工作区临时状态留在模块。setup 外显式传入 pinia，不增加转发函数或重复镜像。认证变更通过 user store 更新会话代号，持久化仅保留已有明确需求。验证旧请求隔离与状态重置。
