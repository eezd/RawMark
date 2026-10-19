import vue from '@vitejs/plugin-vue'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'rawmark-pwa',
      apply: 'build',
      enforce: 'post',
      generateBundle(_options, bundle) {
        // 缓存列表由产物生成，覆盖懒加载资源，旧页面更新后仍能加载其依赖。
        const files = Object.keys(bundle).filter((name) => name === 'index.html' || name.startsWith('assets/')).sort()
        const version = createHash('sha256')
        for (const name of files) {
          const item = bundle[name]!
          version.update(name).update(item.type === 'chunk' ? item.code : item.source)
        }
        for (const name of ['manifest.webmanifest', 'icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png']) {
          version.update(readFileSync(new URL('./public/' + name, import.meta.url)))
          files.push(name)
        }
        const source = readFileSync(new URL('./src/service-worker.js', import.meta.url), 'utf8')
          .replace('__VERSION__', version.digest('hex').slice(0, 16))
          .replace('__PRECACHE__', JSON.stringify(files.map((name) => '/' + name)))
        this.emitFile({ type: 'asset', fileName: 'sw.js', source })
      },
    },
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
