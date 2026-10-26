import { i18n } from '@@/i18n/runtime'
import errorEn from './pages/error/locales/en.json'
import errorZh from './pages/error/locales/zh-CN.json'
import loginEn from './pages/login/locales/en.json'
import loginZh from './pages/login/locales/zh-CN.json'
import settingsEn from './pages/settings/locales/en.json'
import settingsZh from './pages/settings/locales/zh-CN.json'
import workspaceEn from './pages/workspace/locales/en.json'
import workspaceZh from './pages/workspace/locales/zh-CN.json'

i18n.global.mergeLocaleMessage('en', { error: errorEn, login: loginEn, settings: settingsEn, workspace: workspaceEn })
i18n.global.mergeLocaleMessage('zh-CN', { error: errorZh, login: loginZh, settings: settingsZh, workspace: workspaceZh })
export { i18n }
