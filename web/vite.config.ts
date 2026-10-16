import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  build: {
    rolldownOptions: {
      // demo.html 为免登录的编辑器演示页，供自动化性能/交互测试使用
      input: { index: 'index.html', demo: 'demo.html' },
    },
  },
  worker: { format: 'es' },
  server: {
    // 开发时把 API 与 WebSocket 转发给本地 Go 服务
    proxy: { '/api': { target: 'http://127.0.0.1:8080', ws: true } },
  },
  test: { environment: 'node' },
})
