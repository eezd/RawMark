import type { Gemoji } from 'gemoji'
import type { IconName } from './icons'

export const iconLabels: Record<IconName, string> = {
  plus: '加号', eye: '查看', expand: '展开', graph: '关系', calendar: '日历', tag: '标签', copy: '复制',
  task: '任务', quote: '引用', undo: '撤销', redo: '重做', print: '打印', grid: '网格', menu: '菜单',
  noteAdd: '新建笔记', import: '导入', folderAdd: '新建文件夹', folder: '文件夹', image: '图片', note: '文档',
  chevron: '箭头', more: '更多', close: '关闭', pin: '固定', trash: '回收站', logout: '退出', restore: '恢复',
  edit: '编辑', search: '搜索', link: '链接', key: '钥匙', settings: '设置', palette: '调色板', user: '用户',
  outline: '大纲', source: '代码', command: '命令', info: '信息',
}

export const emojiCategories = [
  { id: 'Smileys & Emotion', label: '表情', icon: '😀' },
  { id: 'People & Body', label: '人物', icon: '👋' },
  { id: 'Animals & Nature', label: '自然', icon: '🌿' },
  { id: 'Food & Drink', label: '食物', icon: '🍎' },
  { id: 'Travel & Places', label: '旅行', icon: '🚀' },
  { id: 'Activities', label: '活动', icon: '⚽' },
  { id: 'Objects', label: '物品', icon: '💡' },
  { id: 'Symbols', label: '符号', icon: '❤️' },
  { id: 'Flags', label: '旗帜', icon: '🏳️' },
]

// 常见目录用途的中文检索词；其余仍可按 Emoji 和原有英文名称搜索。
const keywords: Record<string, string> = {
  '📂': '文件夹 目录 打开', '📁': '文件夹 目录', '📄': '文档 笔记 文章', '📝': '笔记 编辑 记录',
  '📃': '文档 文章', '📋': '清单 剪贴板', '📚': '书籍 知识 学习', '📖': '阅读 书籍', '📕': '书籍 红书',
  '📗': '书籍 绿书', '📘': '书籍 蓝书', '📙': '书籍 橙书', '📓': '笔记本', '📒': '账本 笔记本',
  '📔': '笔记本 日记', '📅': '日历 日期', '🗓️': '日历 计划', '✅': '完成 任务 对勾', '☑️': '勾选 任务',
  '⭐': '星星 收藏', '🌟': '星星 重要', '❤️': '爱心 喜欢', '🔥': '火 热门', '💡': '灯泡 灵感 想法',
  '📌': '固定 图钉', '🔗': '链接', '🔒': '锁 安全', '🔑': '钥匙 密钥', '⚙️': '设置 齿轮',
  '🛠️': '工具 开发', '💻': '电脑 编程 代码', '🖥️': '电脑 显示器', '📱': '手机', '🖼️': '图片 相册',
  '🎨': '艺术 设计 调色板', '🎵': '音乐', '🎬': '电影 视频', '📷': '相机 摄影', '🎮': '游戏',
  '🏠': '房子 主页 家', '🏡': '家 房子', '🚀': '火箭 项目 发布', '💼': '工作 公文包', '🎯': '目标',
  '🌍': '地球 世界', '🌏': '地球 亚洲', '🌱': '幼苗 成长', '🌿': '植物 叶子 自然', '🌸': '花 樱花',
  '☀️': '太阳 晴天', '🌙': '月亮 夜晚', '🐱': '猫 动物', '🐶': '狗 动物', '🍎': '苹果 食物',
  '☕': '咖啡 饮料', '😀': '笑脸 开心 表情', '😊': '微笑 开心 表情', '🤔': '思考 想法', '👍': '赞 好',
  '⚠️': '警告 注意', '❗': '感叹号 重要', '❓': '问号 问题', '💰': '钱 财务', '🎓': '毕业 学习',
}

export function emojiLabel(emoji: Gemoji): string {
  return keywords[emoji.emoji] ?? emoji.description
}

export function matchesEmoji(emoji: Gemoji, query: string): boolean {
  return [emoji.emoji, emoji.description, ...emoji.names, ...emoji.tags, keywords[emoji.emoji] ?? '', emojiCategories.find(c => c.id === emoji.category)?.label ?? ''].join(' ').toLowerCase().includes(query)
}
