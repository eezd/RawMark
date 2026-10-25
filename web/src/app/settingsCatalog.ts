import type { IconName } from './Icon.vue'
import type { SettingsSection } from './workspace'

export const SETTINGS_SECTIONS: { id: SettingsSection; title: string; icon: IconName; description: string }[] = [
  { id: 'application', title: '应用', icon: 'grid', description: '查看存储空间及各类文件占用' },
  { id: 'appearance', title: '外观', icon: 'palette', description: '界面字号、主题、明暗模式与 CSS 片段' },
  { id: 'editor', title: '编辑器', icon: 'edit', description: '正文排版、代码字体与编辑行为' },
  { id: 'shortcuts', title: '快捷键', icon: 'command', description: '查找命令，添加、移除或重置快捷键' },
  { id: 'plugins', title: '插件', icon: 'grid', description: '安装、启停和管理插件及其设置页' },
  { id: 'tokens', title: 'API 令牌', icon: 'key', description: '创建或撤销 REST API 访问令牌' },
  { id: 'trash', title: '回收站', icon: 'trash', description: '恢复或永久删除已移入回收站的文件' },
  { id: 'account', title: '账户与安全', icon: 'user', description: '修改登录密码与退出登录' },
  { id: 'about', title: '关于', icon: 'info', description: '应用版本、安装应用与 API 文档' },
]

export const SETTING_ITEMS = {
  'storage': { section: 'application', title: '存储空间', description: '按需统计笔记库、数据库、字体、主题、插件及其他文件的大小；包含外置笔记库。', keywords: '容量 占用 大小 附件 图片 回收站' },
  'trash-retention': { section: 'trash', title: '自动删除期限', description: '按原删除时间计算，默认 30 天；0 表示永不自动删除。修改期限会影响已有条目，服务启动及每小时清理一次。', keywords: '回收站 天数 自动 清理 保留' },
  'trash-clear': { section: 'trash', title: '清空全部', description: '永久删除回收站中的全部条目，无法撤销。', keywords: '回收站 清理 全部 删除' },
  'ui-font': { section: 'appearance', title: '界面字体', description: '用于菜单、侧栏与按钮；可导入或删除字体，Maple 为不可删除的默认字体。', keywords: 'UI 字体 导入 删除 TTF OTF WOFF' },
  'ui-font-size': { section: 'appearance', title: '界面字号', description: '调整菜单、侧栏与按钮文字，不影响正文和代码字号。', keywords: 'UI 大小' },
  'theme-select': { section: 'appearance', title: '主题', description: '使用内置主题，或从服务器数据目录的 themes 文件夹添加主题。', keywords: '白色 黑色 自定义' },
  'color-mode': { section: 'appearance', title: '明暗模式', description: '选择浅色、深色，或跟随系统切换。', keywords: '黑暗 夜间 light dark system' },
  'glass-opacity': { section: 'appearance', title: '磨砂玻璃通透度', description: '调整玻璃面板的透明程度，保留当前主题配色。', keywords: '透明度 背景' },
  'css-snippets': { section: 'appearance', title: 'CSS 片段', description: '管理自定义主题和 CSS 片段。', keywords: '样式 自定义 高级' },
  'reset-appearance': { section: 'appearance', title: '恢复默认外观与排版', description: '重置主题、界面与正文排版；停用并保留 CSS 片段。', keywords: '重置 默认 恢复' },
  'text-font': { section: 'editor', title: '正文主要字体', description: '用于笔记正文，不改变界面字体。', keywords: '无衬线 宋体 系统' },
  'code-font': { section: 'editor', title: '代码字体', description: '用于代码块和行内代码。', keywords: '等宽 JetBrains Mono' },
  'font-size': { section: 'editor', title: '编辑器字号', description: '调整正文与代码的基础字号，不影响界面字号。', keywords: '正文 大小' },
  'content-width': { section: 'editor', title: '正文宽度', description: '限制正文最大宽度，或使用可用空间的全宽。', keywords: '窄 标准 宽 全宽' },
  'line-height': { section: 'editor', title: '正文行高', description: '调整正文各行之间的距离。', keywords: '行距 排版' },
  'paragraph-spacing': { section: 'editor', title: '段落间距', description: '调整相邻段落之间的距离。', keywords: '段距 排版' },
  'selection-toolbar': { section: 'editor', title: '选中文本浮动工具栏', description: '选中文字后显示常用格式操作。', keywords: '格式 编辑' },
  'spellcheck': { section: 'editor', title: '拼写检查', description: '使用浏览器的拼写检查，检查语言取决于浏览器设置。', keywords: '语言 拼写' },
  'tab-size': { section: 'editor', title: '制表符宽度', description: '仅调整 Tab 字符的显示宽度，不改写正文；Tab 键仍按两个空格缩进。', keywords: 'Tab 缩进 空格' },
  'typography-preview': { section: 'editor', title: '排版预览', description: '查看当前正文与代码字体的显示效果。', keywords: '字号 行高 段距 预览' },
  'password': { section: 'account', title: '修改登录密码', description: '修改后其他设备需要重新登录。', keywords: '账户 安全 鉴权' },
  'logout': { section: 'account', title: '退出登录', description: '退出当前设备的登录会话。', keywords: '账户 会话' },
  'install': { section: 'about', title: '安装应用', description: '浏览器支持安装时，可将 RawMark 添加到桌面或主屏幕。', keywords: 'PWA 安装' },
  'version': { section: 'about', title: '构建版本', description: '当前页面加载的应用版本。', keywords: 'RawMark 关于' },
  'openapi': { section: 'about', title: 'API 文档', description: '在「API 令牌」创建令牌后，通过 REST API 读取或写入笔记。', keywords: 'OpenAPI 接口 自动化' },
} satisfies Record<string, { section: SettingsSection; title: string; description: string; keywords: string }>

export type SettingId = keyof typeof SETTING_ITEMS
export interface SettingSearchResult {
  section: SettingsSection
  id?: SettingId
  title: string
  description: string
}

/** 只搜索设置说明，不读取设置值、笔记或管理列表。 */
export function searchSettings(query: string): SettingSearchResult[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const matches = (text: string) => terms.every(term => text.toLocaleLowerCase().includes(term))
  return [
    ...SETTINGS_SECTIONS.filter(s => matches(s.title + ' ' + s.description)).map(s => ({ section: s.id, title: s.title, description: s.description })),
    ...(Object.entries(SETTING_ITEMS) as [SettingId, typeof SETTING_ITEMS[SettingId]][])
      .filter(([, item]) => matches(item.title + ' ' + item.description + ' ' + item.keywords))
      .map(([id, item]) => ({ id, section: item.section, title: item.title, description: item.description })),
  ]
}
