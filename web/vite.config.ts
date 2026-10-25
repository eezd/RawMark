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
        // 只统计应用内可选字体；Maple 与 KaTeX 不在 fonts.css 内。
        const fontCSS = readFileSync(new URL('./src/themes/fonts.css', import.meta.url), 'utf8')
        const fontPaths = new Set([...fontCSS.matchAll(/url\(['"]?(\.?\/?fonts\/[^)'"]+)/g)].map(match => match[1]!))
        const size = [...fontPaths].reduce((total, path) => total + readFileSync(new URL('./src/themes/' + path, import.meta.url)).byteLength, 0)
        const manifest = JSON.stringify({ optionalFontsSize: size })
        this.emitFile({ type: 'asset', fileName: 'font-storage.json', source: manifest })

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
        version.update(manifest)
        files.push('font-storage.json')
        const buildVersion = version.digest('hex').slice(0, 16)
        const entry = bundle['index.html']
        if (!entry || entry.type !== 'asset' || typeof entry.source !== 'string') throw new Error('缺少应用入口 HTML，无法写入构建版本')
        // 入口与离线外壳使用同一构建标识，旧页面仍显示其自身的版本。
        entry.source = entry.source.replace('</head>', `<meta name="rawmark-version" content="${buildVersion}" />\n  </head>`)
        const source = readFileSync(new URL('./src/service-worker.js', import.meta.url), 'utf8')
          .replace('__VERSION__', buildVersion)
          .replace('__PRECACHE__', JSON.stringify(files.map((name) => '/' + name)))
        this.emitFile({ type: 'asset', fileName: 'sw.js', source })
      },
    },
  ],
  build: {
    rolldownOptions: {
      // demo.html 为免登录的编辑器演示页，供自动化性能/交互测试使用
      input: { index: 'index.html', demo: 'demo.html' },
    },
  },
  worker: { format: 'es' },
  server: {
    // 开发时把 API 与 WebSocket 转发给本地 Go 服务（端口与 scripts/dev.sh 的 API_PORT 一致）
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.API_PORT ?? 8080}`, ws: true } },
  },
  test: { environment: 'node' },
})
