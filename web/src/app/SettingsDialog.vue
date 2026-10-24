<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { api, ApiError } from './api'
import { runCommand } from './commands'
import Icon from './Icon.vue'
import AppearanceSettings from './AppearanceSettings.vue'
import { CODE_FONTS, TEXT_FONTS, UI_FONT_SIZE } from '../themes/typography'
import PluginsPanel from './PluginsPanel.vue'
import { installApp, installPrompt } from './pwa'
import { CONTENT_WIDTHS, DEFAULTS, TAB_SIZES, loadSettings, settings, settingsSave, SettingsAppearanceError, updateSettings, type Settings } from './settings'
import SettingRow from './SettingRow.vue'
import { SETTINGS_SECTIONS, searchSettings, type SettingSearchResult } from './settingsCatalog'
import ShortcutSettings from './ShortcutSettings.vue'
import TokensPanel from './TokensPanel.vue'
import TrashPanel from './TrashPanel.vue'
import { toast, ws, type SettingsSection } from './workspace'

const buildVersion = import.meta.env.DEV ? '开发版' : document.querySelector<HTMLMetaElement>('meta[name="rawmark-version"]')?.content
if (!buildVersion) throw new Error('缺少应用构建版本信息')

const section = computed(() => (ws.settings === 'index' ? 'appearance' : ws.settings!))
// 手机上一次只显示分组列表或分组内容
const showList = ref(ws.settings === 'index')
const current = computed(() => SETTINGS_SECTIONS.find((s) => s.id === section.value)!)
const query = ref('')
const searching = computed(() => !!query.value.trim())
const results = computed(() => searchSettings(query.value))
const dialog = ref<HTMLElement>()
const content = ref<HTMLElement>()
const heading = ref<HTMLElement>()
const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
const preferenceSection = computed(() => ['appearance', 'editor', 'shortcuts'].includes(section.value))
const saveLabel = computed(() => settingsSave.pending ? '保存中…' : settingsSave.result === 'error' ? '保存失败' : settingsSave.result === 'saved' ? '已保存' : '修改自动保存')

async function open(id: SettingsSection) {
  query.value = ''
  ws.settings = id
  showList.value = false
  await nextTick()
  content.value!.scrollTop = 0
  heading.value!.focus({ preventScroll: true })
}

async function locate(result: SettingSearchResult) {
  await open(result.section)
  if (!result.id) return
  const target = document.getElementById('rm-setting-' + result.id)!
  // 设置可能位于 CSS 或排版预览的折叠区内。
  for (let parent = target.parentElement; parent && parent !== content.value; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true
  }
  if (target instanceof HTMLDetailsElement) target.open = true
  await nextTick()
  target.focus({ preventScroll: true })
  target.scrollIntoView({ block: 'center' })
}

function back() {
  query.value = ''
  showList.value = true
  void nextTick(() => dialog.value!.querySelector<HTMLInputElement>('.rm-settings-search input')!.focus())
}

function close() {
  ws.settings = null
}

function onKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
  if (e.key !== 'Tab') return
  const controls = [...dialog.value!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')].filter(el => el.getClientRects().length > 0 && !el.closest('[hidden]'))
  const first = controls[0], last = controls.at(-1)
  if (e.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement as HTMLElement))) {
    e.preventDefault(); last?.focus()
  } else if (!e.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement as HTMLElement))) {
    e.preventDefault(); first?.focus()
  }
}
onMounted(() => dialog.value!.focus({ preventScroll: true }))
onBeforeUnmount(() => { if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }) })

async function change(patch: Partial<Settings>) {
  try {
    await updateSettings(patch)
  } catch (err) {
    if (err instanceof SettingsAppearanceError) { toast(err.message); return }
    toast('保存设置失败：' + (err instanceof ApiError ? err.message : '网络错误，请检查连接'))
    void loadSettings().catch(error => toast('重新读取设置失败：' + (error instanceof Error ? error.message : '网络错误')))
  }
}

function changeFont(event: Event) {
  const input = event.target as HTMLInputElement
  const value = input.valueAsNumber
  if (!Number.isFinite(value) || value <= 0) {
    if (event.type === 'input') return
    toast('字号必须为正数')
    input.value = String(settings.fontSize)
    return
  }
  if (value !== settings.fontSize) void change({ fontSize: value })
}

function changeUIFont(event: Event) {
  const input = event.target as HTMLInputElement
  const value = input.valueAsNumber
  if (!Number.isInteger(value) || value < UI_FONT_SIZE.min || value > UI_FONT_SIZE.max) {
    toast(`界面字号须为 ${UI_FONT_SIZE.min}–${UI_FONT_SIZE.max} 之间的整数`)
    input.value = String(settings.uiFontSize)
    return
  }
  if (value !== settings.uiFontSize) void change({ uiFontSize: value })
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
  <div class="rm-dialog-backdrop rm-settings-backdrop" @click.self="close">
    <div ref="dialog" class="rm-dialog rm-settings" :class="{ 'show-list': showList, searching }" role="dialog" aria-modal="true" aria-label="设置" tabindex="-1" @keydown="onKey">
      <nav class="rm-settings-nav" aria-label="设置分类">
        <div class="rm-dialog-head">
          <h2>设置</h2>
          <button class="rm-icon-btn rm-settings-close-list" title="关闭设置" @click="close"><Icon name="close" /></button>
        </div>
        <label class="rm-settings-search"><Icon name="search" /><input v-model="query" type="search" aria-label="搜索设置" placeholder="搜索设置" /><button v-if="query" class="rm-icon-btn" aria-label="清空设置搜索" @click="query = ''"><Icon name="close" /></button></label>
        <div class="rm-settings-categories">
          <button v-for="s in SETTINGS_SECTIONS" :key="s.id" class="rm-settings-tab" :class="{ on: s.id === section && !searching }" :aria-current="s.id === section && !searching ? 'page' : undefined" @click="open(s.id)"><Icon :name="s.icon" />{{ s.title }}</button>
        </div>
        <div class="rm-settings-nav-foot"><span>RawMark</span><small>{{ buildVersion }}</small></div>
      </nav>
      <section class="rm-settings-body">
        <div class="rm-dialog-head">
          <button class="rm-icon-btn rm-settings-back" title="返回设置分类" @click="back"><Icon name="chevron" class="flip" /></button>
          <h2 ref="heading" tabindex="-1">{{ searching ? '搜索结果' : current.title }}</h2>
          <span v-if="preferenceSection && !searching" class="rm-settings-save" :class="{ error: settingsSave.result === 'error' && !settingsSave.pending }" :title="settingsSave.error || '偏好设置保存在服务器上，所有设备共用'" role="status" aria-live="polite">{{ saveLabel }}</span>
          <button class="rm-icon-btn" title="关闭设置" @click="close"><Icon name="close" /></button>
        </div>
        <div ref="content" class="rm-settings-content">
          <div v-if="searching" class="rm-settings-results">
            <p class="rm-settings-result-count" role="status">{{ results.length ? `找到 ${results.length} 项设置` : '没有匹配的设置，试试其他关键词。' }}</p>
            <button v-for="result in results" :key="result.id || result.section" class="rm-settings-result" @click="locate(result)"><span><strong>{{ result.title }}</strong><small>{{ result.description }}</small></span><small>{{ SETTINGS_SECTIONS.find(s => s.id === result.section)!.title }}</small><Icon name="chevron" /></button>
          </div>
          <div v-show="!searching" class="rm-settings-page">
            <PluginsPanel v-if="section === 'plugins'" />
            <template v-else-if="section === 'appearance'">
              <SettingRow id="ui-font-size" control="rm-ui-font-size" resettable @reset="change({ uiFontSize: DEFAULTS.uiFontSize })">
                <label class="rm-font-input"><input id="rm-ui-font-size" type="number" :min="UI_FONT_SIZE.min" :max="UI_FONT_SIZE.max" step="1" :value="settings.uiFontSize" @blur="changeUIFont" @keydown.enter="($event.target as HTMLInputElement).blur()" /> px</label>
              </SettingRow>
              <SettingRow id="glass-opacity" control="rm-glass-opacity" resettable @reset="change({ glassOpacity: DEFAULTS.glassOpacity })"><input id="rm-glass-opacity" type="range" min="0.4" max="1" step="0.05" :value="settings.glassOpacity" @change="change({ glassOpacity: Number(($event.target as HTMLInputElement).value) })" /><output for="rm-glass-opacity">{{ Math.round(settings.glassOpacity * 100) }}%</output></SettingRow>
              <AppearanceSettings />
            </template>

            <template v-else-if="section === 'editor'">
              <h3 class="rm-settings-group-title">正文与代码</h3>
              <SettingRow id="text-font" control="rm-text-font" resettable @reset="change({ textFont: DEFAULTS.textFont })"><select id="rm-text-font" :value="settings.textFont" @change="change({ textFont: ($event.target as HTMLSelectElement).value as Settings['textFont'] })"><option v-for="(font, id) in TEXT_FONTS" :key="id" :value="id">{{ font.label }}</option></select></SettingRow>
              <SettingRow id="code-font" control="rm-code-font" resettable @reset="change({ codeFont: DEFAULTS.codeFont })"><select id="rm-code-font" :value="settings.codeFont" @change="change({ codeFont: ($event.target as HTMLSelectElement).value as Settings['codeFont'] })"><option v-for="(font, id) in CODE_FONTS" :key="id" :value="id">{{ font.label }}</option></select></SettingRow>
              <SettingRow id="font-size" control="rm-font-size" resettable @reset="change({ fontSize: DEFAULTS.fontSize })"><label class="rm-font-input"><input id="rm-font-size" type="number" min="0" step="any" :value="settings.fontSize" @input="changeFont" @blur="changeFont" @keydown.enter="($event.target as HTMLInputElement).blur()" /> px</label></SettingRow>
              <SettingRow id="content-width" resettable @reset="change({ contentWidth: DEFAULTS.contentWidth })"><div class="rm-segmented" role="radiogroup" aria-label="正文宽度"><button v-for="w in CONTENT_WIDTHS" :key="w.value" role="radio" :aria-checked="settings.contentWidth === w.value" :class="{ on: settings.contentWidth === w.value }" @click="change({ contentWidth: w.value })">{{ w.label }}</button></div></SettingRow>
              <SettingRow id="line-height" control="rm-line-height" resettable @reset="change({ lineHeight: DEFAULTS.lineHeight })"><input id="rm-line-height" type="range" min="1.2" max="2.5" step="0.05" :value="settings.lineHeight" @change="change({ lineHeight: Number(($event.target as HTMLInputElement).value) })" /><output for="rm-line-height">{{ settings.lineHeight.toFixed(2) }}</output></SettingRow>
              <SettingRow id="paragraph-spacing" control="rm-paragraph-spacing" resettable @reset="change({ paragraphSpacing: DEFAULTS.paragraphSpacing })"><input id="rm-paragraph-spacing" type="range" min="0" max="40" step="2" :value="settings.paragraphSpacing" @change="change({ paragraphSpacing: Number(($event.target as HTMLInputElement).value) })" /><output for="rm-paragraph-spacing">{{ settings.paragraphSpacing }}px</output></SettingRow>
              <details id="rm-setting-typography-preview" class="rm-settings-details" tabindex="-1"><summary>排版预览</summary><article class="rm-typography-preview"><h2>让文字自由呼吸</h2><p>用简洁的记录，连接每一个想法。Markdown 文件始终属于你。</p><p>真实内容，自然排版，专注当下的灵感。</p><code>const idea = 'Hello, RawMark'</code></article></details>
              <h3 class="rm-settings-group-title">编辑行为</h3>
              <SettingRow id="selection-toolbar" control="rm-selection-toolbar"><input id="rm-selection-toolbar" type="checkbox" :checked="settings.selectionToolbar" @change="change({ selectionToolbar: ($event.target as HTMLInputElement).checked })" /></SettingRow>
              <SettingRow id="spellcheck" control="rm-spellcheck"><input id="rm-spellcheck" type="checkbox" :checked="settings.spellcheck" @change="change({ spellcheck: ($event.target as HTMLInputElement).checked })" /></SettingRow>
              <SettingRow id="tab-size" control="rm-tab-size" resettable @reset="change({ tabSize: DEFAULTS.tabSize })"><select id="rm-tab-size" :value="settings.tabSize" @change="change({ tabSize: Number(($event.target as HTMLSelectElement).value) })"><option v-for="n in TAB_SIZES" :key="n" :value="n">{{ n }} 列</option></select></SettingRow>
            </template>

            <template v-else-if="section === 'account'">
              <form id="rm-setting-password" class="rm-auth-card rm-settings-form" tabindex="-1" @submit.prevent="changePassword">
                <h3>修改登录密码</h3>
                <p class="rm-share-note">修改后其他设备需要重新登录。</p>
                <label><span>当前密码</span><input v-model="pw.current" type="password" autocomplete="current-password" required /></label>
                <label><span>新密码</span><input v-model="pw.next" type="password" autocomplete="new-password" required /></label>
                <label><span>确认新密码</span><input v-model="pw.confirm" type="password" autocomplete="new-password" required /></label>
                <p v-if="pwError" class="rm-auth-error" role="alert">{{ pwError }}</p>
                <button class="rm-btn rm-btn-primary" type="submit" :disabled="pwBusy">修改密码</button>
              </form>
              <SettingRow id="logout"><button class="rm-btn" @click="close(), runCommand('app.logout')"><Icon name="logout" />退出</button></SettingRow>
            </template>

            <ShortcutSettings v-else-if="section === 'shortcuts'" />
            <TokensPanel v-else-if="section === 'tokens'" />
            <TrashPanel v-else-if="section === 'trash'" />
            <template v-else-if="section === 'about'">
              <p class="rm-share-note">RawMark · 纯 Markdown 笔记编辑器，文件即真源。</p>
              <SettingRow id="version"><code>{{ buildVersion }}</code></SettingRow>
              <SettingRow id="install"><button v-if="installPrompt" class="rm-btn" @click="installApp">安装 RawMark</button><span v-else class="rm-settings-unavailable">当前浏览器暂未提供安装入口</span></SettingRow>
              <SettingRow id="openapi"><a class="rm-btn" href="/api/v1/openapi.json" target="_blank" rel="noopener">查看 OpenAPI 文档</a></SettingRow>
            </template>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
