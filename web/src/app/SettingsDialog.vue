<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api, ApiError } from './api'
import { allCommands, formatKeys, runCommand } from './commands'
import Icon, { type IconName } from './Icon.vue'
import AppearanceSettings from './AppearanceSettings.vue'
import PluginsPanel from './PluginsPanel.vue'
import { CONTENT_WIDTHS, FONT_SIZES, TAB_SIZES, loadSettings, settings, updateSettings, type Settings } from './settings'
import SharePanel from './SharePanel.vue'
import TokensPanel from './TokensPanel.vue'
import TrashPanel from './TrashPanel.vue'
import { toast, ws, type SettingsSection } from './workspace'

const SECTIONS: { id: SettingsSection; title: string; icon: IconName }[] = [
  { id: 'appearance', title: '外观', icon: 'palette' },
  { id: 'editor', title: '编辑器', icon: 'edit' },
  { id: 'plugins', title: '插件', icon: 'command' },
  { id: 'account', title: '账户', icon: 'user' },
  { id: 'shortcuts', title: '快捷键', icon: 'command' },
  { id: 'shares', title: '分享链接', icon: 'link' },
  { id: 'tokens', title: 'API 令牌', icon: 'key' },
  { id: 'trash', title: '回收站', icon: 'trash' },
  { id: 'about', title: '关于', icon: 'info' },
]

const buildVersion = import.meta.env.DEV ? '开发版' : document.querySelector<HTMLMetaElement>('meta[name="rawmark-version"]')?.content
if (!buildVersion) throw new Error('缺少应用构建版本信息')

// 编辑器内置的按键（不在命令注册表中）
const EDITOR_KEYS = [
  { title: '粗体', keys: 'Mod+B' },
  { title: '斜体', keys: 'Mod+I' },
  { title: '插入链接', keys: 'Mod+K' },
  { title: '撤销', keys: 'Mod+Z' },
  { title: '重做', keys: 'Mod+Shift+Z' },
  { title: '缩进 / 取消缩进', keys: 'Tab / Shift+Tab' },
  { title: '全选（代码块内先选中整个代码块）', keys: 'Mod+A' },
]

const section = computed(() => (ws.settings === 'index' ? 'appearance' : ws.settings!))
// 手机上一次只显示分组列表或分组内容
const showList = ref(ws.settings === 'index')
const current = computed(() => SECTIONS.find((s) => s.id === section.value)!)
const shortcuts = computed(() => [
  ...allCommands()
    .filter((c) => c.keys?.length)
    .map((c) => ({ title: c.title, keys: c.keys!.map(formatKeys).join(' / ') })),
  ...EDITOR_KEYS.map((k) => ({ title: k.title, keys: k.keys.split(' / ').map(formatKeys).join(' / ') })),
])

function open(id: SettingsSection) {
  ws.settings = id
  showList.value = false
}

function close() {
  ws.settings = null
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && !e.isComposing) close()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

async function change(patch: Partial<Settings>) {
  try {
    await updateSettings(patch)
  } catch (err) {
    toast('保存设置失败：' + (err instanceof ApiError ? err.message : '网络错误，请检查连接'))
    void loadSettings().catch(() => {})
  }
}

// ---- 修改登录密码 ----
const pw = ref({ current: '', next: '', confirm: '' })
const pwError = ref('')
const pwBusy = ref(false)

async function changePassword() {
  pwError.value = ''
  if (pw.value.next.length < 8) return void (pwError.value = '新密码至少 8 位')
  if (pw.value.next !== pw.value.confirm) return void (pwError.value = '两次输入的新密码不一致')
  pwBusy.value = true
  try {
    await api.changePassword(pw.value.current, pw.value.next)
    pw.value = { current: '', next: '', confirm: '' }
    toast('登录密码已修改，其他设备需要重新登录')
  } catch (err) {
    pwError.value = err instanceof ApiError ? err.message : '网络错误，请检查连接'
  } finally {
    pwBusy.value = false
  }
}
</script>

<template>
  <div class="rm-dialog-backdrop" @click.self="close">
    <div class="rm-dialog rm-settings" :class="{ 'show-list': showList }" role="dialog" aria-label="设置">
      <nav class="rm-settings-nav">
        <div class="rm-dialog-head">
          <h2>设置</h2>
          <button class="rm-icon-btn rm-settings-close-list" title="关闭" @click="close"><Icon name="close" /></button>
        </div>
        <button v-for="s in SECTIONS" :key="s.id" class="rm-settings-tab" :class="{ on: s.id === section }" @click="open(s.id)">
          <Icon :name="s.icon" />{{ s.title }}
        </button>
      </nav>
      <section class="rm-settings-body">
        <div class="rm-dialog-head">
          <button class="rm-icon-btn rm-settings-back" title="返回" @click="showList = true"><Icon name="chevron" class="flip" /></button>
          <h2>{{ current.title }}</h2>
          <button class="rm-icon-btn" title="关闭" @click="close"><Icon name="close" /></button>
        </div>
        <div class="rm-settings-content">
          <PluginsPanel v-if="section === 'plugins'" />
          <template v-else-if="section === 'appearance'">
            <AppearanceSettings />
            <div class="rm-setting">
              <span class="rm-setting-label">字号</span>
              <select :value="settings.fontSize" aria-label="字号" @change="change({ fontSize: Number(($event.target as HTMLSelectElement).value) })">
                <option v-for="n in FONT_SIZES" :key="n" :value="n">{{ n }} px</option>
              </select>
            </div>
            <div class="rm-setting">
              <span class="rm-setting-label">正文宽度</span>
              <div class="rm-segmented" role="radiogroup" aria-label="正文宽度">
                <button
                  v-for="w in CONTENT_WIDTHS"
                  :key="w.value"
                  role="radio"
                  :aria-checked="settings.contentWidth === w.value"
                  :class="{ on: settings.contentWidth === w.value }"
                  @click="change({ contentWidth: w.value })"
                >
                  {{ w.label }}
                </button>
              </div>
            </div>
            <p class="rm-share-note">设置保存在服务器上，所有设备共用。</p>
          </template>

          <template v-else-if="section === 'editor'">
            <div class="rm-setting">
              <label for="rm-spellcheck" class="rm-setting-label">拼写检查</label>
              <input id="rm-spellcheck" type="checkbox" :checked="settings.spellcheck" @change="change({ spellcheck: ($event.target as HTMLInputElement).checked })" />
            </div>
            <p class="rm-share-note">使用浏览器的拼写检查，检查语言取决于浏览器设置。</p>
            <div class="rm-setting">
              <label for="rm-tab-size" class="rm-setting-label">制表符宽度</label>
              <select id="rm-tab-size" :value="settings.tabSize" @change="change({ tabSize: Number(($event.target as HTMLSelectElement).value) })">
                <option v-for="n in TAB_SIZES" :key="n" :value="n">{{ n }} 列</option>
              </select>
            </div>
            <p class="rm-share-note">仅调整 Tab 字符的显示宽度，不改写正文。Tab 键仍按两个空格缩进。</p>
            <p class="rm-share-note">设置保存在服务器上，所有设备共用。</p>
          </template>

          <template v-else-if="section === 'account'">
            <form class="rm-auth-card rm-settings-form" @submit.prevent="changePassword">
              <h3>修改登录密码</h3>
              <label><span>当前密码</span><input v-model="pw.current" type="password" autocomplete="current-password" required /></label>
              <label><span>新密码</span><input v-model="pw.next" type="password" autocomplete="new-password" required /></label>
              <label><span>确认新密码</span><input v-model="pw.confirm" type="password" autocomplete="new-password" required /></label>
              <p v-if="pwError" class="rm-auth-error">{{ pwError }}</p>
              <button class="rm-btn rm-btn-primary" type="submit" :disabled="pwBusy">修改密码</button>
            </form>
            <div class="rm-setting">
              <span class="rm-setting-label">退出登录</span>
              <button class="rm-btn" @click="close(), runCommand('app.logout')"><Icon name="logout" />退出</button>
            </div>
          </template>

          <table v-else-if="section === 'shortcuts'" class="rm-shortcuts">
            <tr v-for="s in shortcuts" :key="s.title">
              <td>{{ s.title }}</td>
              <td><kbd>{{ s.keys }}</kbd></td>
            </tr>
          </table>

          <SharePanel v-else-if="section === 'shares'" :path="null" />
          <TokensPanel v-else-if="section === 'tokens'" />
          <TrashPanel v-else-if="section === 'trash'" />
          <template v-else-if="section === 'about'">
            <div class="rm-setting"><h3>RawMark</h3></div>
            <p class="rm-share-note">纯 Markdown 笔记编辑器，文件即真源。</p>
            <div class="rm-setting">
              <span class="rm-setting-label">构建版本</span>
              <code>{{ buildVersion }}</code>
            </div>
            <div class="rm-setting">
              <span class="rm-setting-label">API 文档</span>
              <a class="rm-btn" href="/api/v1/openapi.json" target="_blank" rel="noopener">查看 OpenAPI 文档</a>
            </div>
            <p class="rm-share-note">在「API 令牌」中创建令牌后，可通过 REST API 读取或写入笔记。</p>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>
