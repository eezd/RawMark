import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import Components from 'unplugin-vue-components/vite'
import { defineConfig } from 'vitest/config'

const releaseVersion = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim()

export default defineConfig({
  define: { __RAWMARK_RELEASE__: JSON.stringify(releaseVersion) },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)), '@@': fileURLToPath(new URL('./src/common', import.meta.url)) } },
  plugins: [
    vue(),
    UnoCSS(),
    AutoImport({ imports: ['vue', 'vue-router', 'pinia'], dts: 'types/auto/auto-imports.d.ts' }),
    Components({ dts: 'types/auto/components.d.ts', resolvers: [ElementPlusResolver({ importStyle: false })] }),
    {
      name: 'rawmark-pwa',
      apply: 'build',
      enforce: 'post',
      generateBundle(_options, bundle) {
        // Count only optional application fonts; fonts.css excludes Maple and KaTeX.
        const fontCSS = readFileSync(new URL('./src/common/appearance/fonts.css', import.meta.url), 'utf8')
        const fontPaths = new Set([...fontCSS.matchAll(/url\(['"]?(\.?\/?fonts\/[^)'"]+)/g)].map(match => match[1]!))
        const size = [...fontPaths].reduce((total, path) => total + readFileSync(new URL(`./src/common/appearance/${path}`, import.meta.url)).byteLength, 0)
        const manifest = JSON.stringify({ optionalFontsSize: size })
        this.emitFile({ type: 'asset', fileName: 'font-storage.json', source: manifest })

        // Generate the cache list from build output, including lazy resources, so old pages retain access to their dependencies after updates.
        const files = Object.keys(bundle).filter(name => name === 'index.html' || name.startsWith('assets/')).sort()
        const version = createHash('sha256')
        for (const name of files) {
          const item = bundle[name]!
          version.update(name).update(item.type === 'chunk' ? item.code : item.source)
        }
        for (const name of ['manifest.webmanifest', 'icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png']) {
          version.update(readFileSync(new URL(`./public/${name}`, import.meta.url)))
          files.push(name)
        }
        version.update(manifest)
        files.push('font-storage.json')
        const buildVersion = version.digest('hex').slice(0, 16)
        const entry = bundle['index.html']
        if (!entry || entry.type !== 'asset' || typeof entry.source !== 'string') throw new Error('缺少应用入口 HTML，无法写入构建版本')
        // The entry and offline shell share a build identifier; old pages continue displaying their own version.
        entry.source = entry.source.replace('</head>', `<meta name="rawmark-version" content="${buildVersion}" />\n  </head>`)
        const source = readFileSync(new URL('./src/service-worker.js', import.meta.url), 'utf8')
          .replace('__VERSION__', buildVersion)
          .replace('__PRECACHE__', JSON.stringify(files.map(name => `/${name}`)))
        this.emitFile({ type: 'asset', fileName: 'sw.js', source })
      },
    },
  ],
  build: {
    rolldownOptions: {
      // demo.html is an unauthenticated editor demo for automated performance/interaction tests.
      input: { index: 'index.html', demo: 'demo.html' },
    },
  },
  worker: { format: 'es' },
  server: {
    // During development, proxy APIs and WebSockets to the local Go service using scripts/dev.sh's API_PORT.
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.API_PORT ?? 8080}`, ws: true } },
  },
  test: { environment: 'node', setupFiles: ['./src/i18n.ts'] },
})
