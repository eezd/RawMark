import type { IconName } from '@@/utils/icons'
import type { Gemoji } from 'gemoji'
import { t as translate } from '@@/i18n/runtime'

export const iconLabels: Record<IconName, string> = {
  get plus() {
    return translate('workspace.plus_3d5f3d')
  },
  get eye() {
    return translate('workspace.view_db8db0')
  },
  get expand() {
    return translate('workspace.expand_00bd39')
  },
  get graph() {
    return translate('workspace.links_253aaf')
  },
  get calendar() {
    return translate('workspace.calendar_a00f29')
  },
  get tag() {
    return translate('workspace.tag_1d0fd5')
  },
  get copy() {
    return translate('common.copy_63d90d')
  },
  get task() {
    return translate('workspace.task_525304')
  },
  get quote() {
    return translate('workspace.references_e0ec65')
  },
  get undo() {
    return translate('workspace.undo_926a50')
  },
  get redo() {
    return translate('workspace.redo_03717b')
  },
  get print() {
    return translate('workspace.print_d7bfe7')
  },
  get grid() {
    return translate('workspace.grid_e41ecc')
  },
  get menu() {
    return translate('workspace.menu_4ce4ca')
  },
  get noteAdd() {
    return translate('workspace.new_note_d3d2d9')
  },
  get import() {
    return translate('common.import_576d81')
  },
  get folderAdd() {
    return translate('workspace.new_folder_84244a')
  },
  get folder() {
    return translate('workspace.folder_7c7802')
  },
  get image() {
    return translate('workspace.image_d24c10')
  },
  get note() {
    return translate('workspace.document_2687cc')
  },
  get chevron() {
    return translate('workspace.arrow_83fa01')
  },
  get more() {
    return translate('workspace.more_38844b')
  },
  get close() {
    return translate('workspace.close_3fd47e')
  },
  get pin() {
    return translate('workspace.pin_d4b3f4')
  },
  get trash() {
    return translate('common.trash_ba35dc')
  },
  get logout() {
    return translate('common.sign_out_498e1d')
  },
  get restore() {
    return translate('common.restore_e0534b')
  },
  get edit() {
    return translate('common.edit_051836')
  },
  get search() {
    return translate('workspace.search_44ce7a')
  },
  get link() {
    return translate('workspace.link_305378')
  },
  get key() {
    return translate('workspace.key_6d1327')
  },
  get settings() {
    return translate('common.settings_df3d58')
  },
  get palette() {
    return translate('workspace.palette_57d285')
  },
  get user() {
    return translate('workspace.user_0d0e1a')
  },
  get outline() {
    return translate('workspace.outline_79fadb')
  },
  get source() {
    return translate('workspace.code_e6f04f')
  },
  get command() {
    return translate('common.command_928f87')
  },
  get info() {
    return translate('workspace.info_e70286')
  },
}

export const emojiCategories = [
  { id: 'Smileys & Emotion', get label() {
    return translate('workspace.emoji_c762ed')
  }, icon: '😀' },
  { id: 'People & Body', get label() {
    return translate('workspace.people_8d7aff')
  }, icon: '👋' },
  { id: 'Animals & Nature', get label() {
    return translate('workspace.nature_4f1240')
  }, icon: '🌿' },
  { id: 'Food & Drink', get label() {
    return translate('workspace.food_ab2775')
  }, icon: '🍎' },
  { id: 'Travel & Places', get label() {
    return translate('workspace.travel_e751bc')
  }, icon: '🚀' },
  { id: 'Activities', get label() {
    return translate('workspace.activities_9e9bea')
  }, icon: '⚽' },
  { id: 'Objects', get label() {
    return translate('workspace.objects_7c89d6')
  }, icon: '💡' },
  { id: 'Symbols', get label() {
    return translate('workspace.symbols_e89265')
  }, icon: '❤️' },
  { id: 'Flags', get label() {
    return translate('workspace.flags_f5aee0')
  }, icon: '🏳️' },
]

// Translate common icon labels at use time so locale changes do not retain cached text.
const keywordKeys: Record<string, string> = {
  '📂': 'workspace.folder_directory_open_3744fe',
  '📁': 'workspace.folder_directory_796213',
  '📄': 'workspace.document_note_article_28eb56',
  '📝': 'workspace.note_edit_record_87af46',
  '📃': 'workspace.document_article_2d7c78',
  '📋': 'workspace.checklist_clipboard_032cfe',
  '📚': 'workspace.books_knowledge_learning_ef0c86',
  '📖': 'workspace.reading_books_0d07d9',
  '📕': 'workspace.books_red_book_86db47',
  '📗': 'workspace.books_green_book_e2ab64',
  '📘': 'workspace.books_blue_book_3f6b60',
  '📙': 'workspace.books_orange_book_1ff6c9',
  '📓': 'workspace.notebook_155c2f',
  '📒': 'workspace.ledger_notebook_b17498',
  '📔': 'workspace.notebook_journal_f3f1a0',
  '📅': 'workspace.calendar_date_0a71ec',
  '🗓️': 'workspace.calendar_plan_54e7ab',
  '✅': 'workspace.done_task_checkmark_9071c9',
  '☑️': 'workspace.checkbox_task_064c0e',
  '⭐': 'workspace.star_favorite_b042d9',
  '🌟': 'workspace.star_important_8cf705',
  '❤️': 'workspace.heart_like_37e5e5',
  '🔥': 'workspace.fire_popular_48643d',
  '💡': 'workspace.lightbulb_inspiration_idea_404d08',
  '📌': 'workspace.pin_30251e',
  '🔗': 'workspace.link_305378',
  '🔒': 'workspace.lock_security_ca4da0',
  '🔑': 'workspace.key_secret_f6132e',
  '⚙️': 'workspace.settings_gear_08cbae',
  '🛠️': 'workspace.tools_development_66775a',
  '💻': 'workspace.computer_programming_code_e80796',
  '🖥️': 'workspace.computer_monitor_096473',
  '📱': 'workspace.phone_2e0733',
  '🖼️': 'workspace.images_album_e7c28d',
  '🎨': 'workspace.art_design_palette_7177c2',
  '🎵': 'workspace.music_db9514',
  '🎬': 'workspace.film_video_78c13a',
  '📷': 'workspace.camera_photography_50a8c0',
  '🎮': 'workspace.game_847c5f',
  '🏠': 'workspace.house_home_6cddfb',
  '🏡': 'workspace.home_house_e9cb84',
  '🚀': 'workspace.rocket_project_release_85d3b1',
  '💼': 'workspace.work_briefcase_f2fcc3',
  '🎯': 'workspace.target_57060c',
  '🌍': 'workspace.earth_world_c6983f',
  '🌏': 'workspace.earth_asia_b820a1',
  '🌱': 'workspace.seedling_growth_5d0cd3',
  '🌿': 'workspace.plant_leaf_nature_d57c83',
  '🌸': 'workspace.flower_cherry_blossom_c6af13',
  '☀️': 'workspace.sun_sunny_c1c7c6',
  '🌙': 'workspace.moon_night_8d87a0',
  '🐱': 'workspace.cat_animal_7759cf',
  '🐶': 'workspace.dog_animal_872611',
  '🍎': 'workspace.apple_food_d549ae',
  '☕': 'workspace.coffee_drink_1d3d41',
  '😀': 'workspace.smile_happy_emoji_3b25f0',
  '😊': 'workspace.smiling_happy_emoji_5fab64',
  '🤔': 'workspace.thinking_idea_fd06c2',
  '👍': 'workspace.thumbs_up_good_7d9981',
  '⚠️': 'workspace.warning_attention_a3fe1d',
  '❗': 'workspace.exclamation_important_5a619b',
  '❓': 'workspace.question_03c022',
  '💰': 'workspace.money_finance_13980e',
  '🎓': 'workspace.graduation_learning_f0d5cf',
}

const chineseKeywords: Record<string, string> = {
  '📂': '文件夹 目录 打开',
  '📁': '文件夹 目录',
  '📄': '文档 笔记 文章',
  '📝': '笔记 编辑 记录',
  '📃': '文档 文章',
  '📋': '清单 剪贴板',
  '📚': '书籍 知识 学习',
  '📖': '阅读 书籍',
  '📕': '书籍 红书',
  '📗': '书籍 绿书',
  '📘': '书籍 蓝书',
  '📙': '书籍 橙书',
  '📓': '笔记本',
  '📒': '账本 笔记本',
  '📔': '笔记本 日记',
  '📅': '日历 日期',
  '🗓️': '日历 计划',
  '✅': '完成 任务 对勾',
  '☑️': '勾选 任务',
  '⭐': '星星 收藏',
  '🌟': '星星 重要',
  '❤️': '爱心 喜欢',
  '🔥': '火 热门',
  '💡': '灯泡 灵感 想法',
  '📌': '固定 图钉',
  '🔗': '链接',
  '🔒': '锁 安全',
  '🔑': '钥匙 密钥',
  '⚙️': '设置 齿轮',
  '🛠️': '工具 开发',
  '💻': '电脑 编程 代码',
  '🖥️': '电脑 显示器',
  '📱': '手机',
  '🖼️': '图片 相册',
  '🎨': '艺术 设计 调色板',
  '🎵': '音乐',
  '🎬': '电影 视频',
  '📷': '相机 摄影',
  '🎮': '游戏',
  '🏠': '房子 主页 家',
  '🏡': '家 房子',
  '🚀': '火箭 项目 发布',
  '💼': '工作 公文包',
  '🎯': '目标',
  '🌍': '地球 世界',
  '🌏': '地球 亚洲',
  '🌱': '幼苗 成长',
  '🌿': '植物 叶子 自然',
  '🌸': '花 樱花',
  '☀️': '太阳 晴天',
  '🌙': '月亮 夜晚',
  '🐱': '猫 动物',
  '🐶': '狗 动物',
  '🍎': '苹果 食物',
  '☕': '咖啡 饮料',
  '😀': '笑脸 开心 表情',
  '😊': '微笑 开心 表情',
  '🤔': '思考 想法',
  '👍': '赞 好',
  '⚠️': '警告 注意',
  '❗': '感叹号 重要',
  '❓': '问号 问题',
  '💰': '钱 财务',
  '🎓': '毕业 学习',
}

export function emojiLabel(emoji: Gemoji): string {
  const key = keywordKeys[emoji.emoji]
  return key ? translate(key) : emoji.description
}

export function matchesEmoji(emoji: Gemoji, query: string): boolean {
  return [emoji.emoji, emoji.description, ...emoji.names, ...emoji.tags, chineseKeywords[emoji.emoji] ?? '', emojiLabel(emoji), emojiCategories.find(c => c.id === emoji.category)?.label ?? ''].join(' ').toLowerCase().includes(query)
}
