import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    vue(),
    // 开发服务器中把分享地址 /s/{token} 交给分享页入口（生产环境由 Go 服务处理）
    {
      name: 'rawmark-share-route',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url?.startsWith('/s/')) req.url = '/share.html'
          next()
        })
      },
    },
  ],
  build: {
    rolldownOptions: {
      // demo.html 为免登录的编辑器演示页，供自动化性能/交互测试使用；share.html 为只读分享页（/s/{token}）
      input: { index: 'index.html', demo: 'demo.html', share: 'share.html' },
    },
  },
  worker: { format: 'es' },
  server: {
    // 开发时把 API 与 WebSocket 转发给本地 Go 服务（端口与 scripts/dev.sh 的 API_PORT 一致）
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.API_PORT ?? 8080}`, ws: true } },
  },
  test: { environment: 'node' },
})
