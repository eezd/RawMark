<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api, ApiError } from './api'
import { runCommand } from './commands'
import Icon, { type IconName } from './Icon.vue'
import AppearanceSettings from './AppearanceSettings.vue'
import { CODE_FONTS, TEXT_FONTS } from '../themes/typography'
import PluginsPanel from './PluginsPanel.vue'
import { installApp, installPrompt } from './pwa'
import { CONTENT_WIDTHS, TAB_SIZES, loadSettings, settings, updateSettings, type Settings } from './settings'
import ShortcutSettings from './ShortcutSettings.vue'
import SharePanel from './SharePanel.vue'
import TokensPanel from './TokensPanel.vue'
import TrashPanel from './TrashPanel.vue'
import { toast, ws, type SettingsSection } from './workspace'

const SECTIONS: { id: SettingsSection; title: string; icon: IconName }[] = [
  { id: 'appearance', title: '常规与外观', icon: 'palette' },
  { id: 'editor', title: '编辑器与模板', icon: 'edit' },
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

const section = computed(() => (ws.settings === 'index' ? 'appearance' : ws.settings!))
// 手机上一次只显示分组列表或分组内容
const dailyTemplates = computed(() => ws.entries.filter(entry => !entry.dir && entry.path.endsWith('.md')))
const missingDailyTemplate = computed(() => settings.dailyTemplate && !dailyTemplates.value.some(entry => entry.path === settings.dailyTemplate))
const showList = ref(ws.settings === 'index')
const current = computed(() => SECTIONS.find((s) => s.id === section.value)!)

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
    void loadSettings().catch(error => toast('重新读取设置失败：' + (error instanceof Error ? error.message : '网络错误')))
  }
}

function changeFont(event: Event) {
  const input = event.target as HTMLInputElement
  const value = input.valueAsNumber
  if (!Number.isFinite(value) || value <= 0) {
    toast('字号必须为正数')
    input.value = String(settings.fontSize)
    return
  }
  if (value !== settings.fontSize) void change({ fontSize: value })
}

function changeFolder(key: 'dailyFolder' | 'templatesFolder', event: Event) {
  const input = event.target as HTMLInputElement
  const path = input.value.trim()
  if ((key === 'templatesFolder' && !path) || path && path.split('/').some(part => !part || part.startsWith('.') || /[\\\0]/.test(part))) {
    toast('请输入有效的仓库相对目录'); input.value = settings[key]; return
  }
  void change({ [key]: path })
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
          <h2>偏好设置中心<small>Personal Preferences Vault</small></h2>
          <button class="rm-icon-btn rm-settings-close-list" title="关闭" @click="close"><Icon name="close" /></button>
        </div>
        <button v-for="s in SECTIONS" :key="s.id" class="rm-settings-tab" :class="{ on: s.id === section }" @click="open(s.id)">
          <Icon :name="s.icon" />{{ s.title }}
        </button>
        <div class="rm-settings-nav-foot"><button v-if="installPrompt" class="rm-btn" @click="installApp">安装到桌面</button><small>RawMark · {{ buildVersion }}</small></div>
      </nav>
      <section class="rm-settings-body">
        <div class="rm-dialog-head">
          <button class="rm-icon-btn rm-settings-back" title="返回" @click="showList = true"><Icon name="chevron" class="flip" /></button>
          <div class="rm-settings-heading"><small>首选项 / {{ current.title }}</small><h2>{{ current.title }}</h2><p>让工作区适合你的写作习惯，修改即时保存。</p></div>
          <button class="rm-icon-btn" title="关闭" @click="close"><Icon name="close" /></button>
        </div>
        <div class="rm-settings-content">
          <PluginsPanel v-if="section === 'plugins'" />
          <template v-else-if="section === 'appearance'">
            <AppearanceSettings />
            <div class="rm-setting"><label for="rm-glass-opacity" class="rm-setting-label">磨砂玻璃通透度</label><input id="rm-glass-opacity" type="range" min="0.4" max="1" step="0.05" :value="settings.glassOpacity" @change="change({ glassOpacity: Number(($event.target as HTMLInputElement).value) })" /><span>{{ Math.round(settings.glassOpacity * 100) }}%</span></div>
            <h3 class="rm-settings-group-title">编辑与阅读排版</h3>
            <div class="rm-setting"><label for="rm-text-font" class="rm-setting-label">正文主要字体</label><select id="rm-text-font" :value="settings.textFont" @change="change({ textFont: ($event.target as HTMLSelectElement).value as Settings['textFont'] })"><option v-for="(font, id) in TEXT_FONTS" :key="id" :value="id">{{ font.label }}</option></select></div>
            <div class="rm-setting"><label for="rm-code-font" class="rm-setting-label">代码字体</label><select id="rm-code-font" :value="settings.codeFont" @change="change({ codeFont: ($event.target as HTMLSelectElement).value as Settings['codeFont'] })"><option v-for="(font, id) in CODE_FONTS" :key="id" :value="id">{{ font.label }}</option></select></div>
            <div class="rm-setting">
              <span class="rm-setting-label">字号</span>
              <label class="rm-font-input"><input type="number" step="any" :value="settings.fontSize" aria-label="字号" @blur="changeFont" @keydown.enter="($event.target as HTMLInputElement).blur()" /> px</label>
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
            <div class="rm-setting"><label for="rm-line-height" class="rm-setting-label">正文行高</label><input id="rm-line-height" type="range" min="1.2" max="2.5" step="0.05" :value="settings.lineHeight" @change="change({ lineHeight: Number(($event.target as HTMLInputElement).value) })" /><span>{{ settings.lineHeight.toFixed(2) }}</span></div>
            <div class="rm-setting"><label for="rm-paragraph-spacing" class="rm-setting-label">段落间距</label><input id="rm-paragraph-spacing" type="range" min="0" max="40" step="2" :value="settings.paragraphSpacing" @change="change({ paragraphSpacing: Number(($event.target as HTMLInputElement).value) })" /><span>{{ settings.paragraphSpacing }}px</span></div>
            <div class="rm-setting"><label for="rm-selection-toolbar" class="rm-setting-label">选中文本浮动工具栏</label><input id="rm-selection-toolbar" type="checkbox" :checked="settings.selectionToolbar" @change="change({ selectionToolbar: ($event.target as HTMLInputElement).checked })" /></div>
            <article class="rm-typography-preview"><small>LIVE TYPOGRAPHY PREVIEW</small><h2>让文字自由呼吸</h2><p>用简洁的记录，连接每一个想法。Markdown 文件始终属于你。</p><p>真实内容，自然排版，专注当下的灵感。</p><code>const idea = 'Hello, RawMark'</code></article>
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
            <h3 class="rm-settings-group-title">日记与模板</h3>
            <div class="rm-setting"><label for="rm-daily-folder" class="rm-setting-label">日记目录</label><input id="rm-daily-folder" :value="settings.dailyFolder" placeholder="根目录" @change="changeFolder('dailyFolder', $event)" /></div>
            <div class="rm-setting"><label for="rm-templates-folder" class="rm-setting-label">模板目录</label><input id="rm-templates-folder" :value="settings.templatesFolder" @change="changeFolder('templatesFolder', $event)" /></div>
            <div class="rm-setting"><label for="rm-daily-template" class="rm-setting-label">日记模板</label><select id="rm-daily-template" :value="settings.dailyTemplate" @change="change({ dailyTemplate: ($event.target as HTMLSelectElement).value })"><option value="">空白笔记</option><option v-for="entry in dailyTemplates" :key="entry.path" :value="entry.path">{{ entry.path }}</option><option v-if="missingDailyTemplate" :value="settings.dailyTemplate">{{ settings.dailyTemplate }}（不存在）</option></select></div>
            <p class="rm-share-note">日记使用本地日期命名，已有日记直接打开。模板支持 <code v-pre>{{date}}</code>、<code v-pre>{{time}}</code>、<code v-pre>{{title}}</code>。</p>
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

          <ShortcutSettings v-else-if="section === 'shortcuts'" />

          <SharePanel v-else-if="section === 'shares'" :path="null" />
          <TokensPanel v-else-if="section === 'tokens'" />
          <TrashPanel v-else-if="section === 'trash'" />
          <template v-else-if="section === 'about'">
            <div class="rm-setting"><h3>RawMark</h3></div>
            <p class="rm-share-note">纯 Markdown 笔记编辑器，文件即真源。</p>
            <div v-if="installPrompt" class="rm-setting">
              <span class="rm-setting-label">安装应用</span>
              <button class="rm-btn" @click="installApp">安装 RawMark</button>
            </div>
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
