import type { IconName } from '@@/components/Icon/index.vue'
import type { SettingsSection } from '@/pinia/stores/settings'
import { t as translate } from '@@/i18n/runtime'

export const SETTINGS_SECTIONS: { id: SettingsSection, title: string, icon: IconName, description: string }[] = [
  { id: 'appearance', get title() {
    return translate('common.appearance_86a63f')
  }, icon: 'palette', get description() {
    return translate('settings.interface_text_size_themes_color_5acf4b')
  } },
  { id: 'editor', get title() {
    return translate('settings.editor_3b7f59')
  }, icon: 'edit', get description() {
    return translate('settings.body_typography_code_font_and_f38913')
  } },
  { id: 'shortcuts', get title() {
    return translate('settings.shortcuts_ee2638')
  }, icon: 'command', get description() {
    return translate('settings.find_commands_and_add_remove_05d2bd')
  } },
  { id: 'plugins', get title() {
    return translate('settings.plugins_e806fb')
  }, icon: 'grid', get description() {
    return translate('settings.install_enable_disable_and_manage_50b0ae')
  } },
  { id: 'storage', get title() {
    return translate('settings.storage_26de3d')
  }, icon: 'grid', get description() {
    return translate('settings.storage_usage_backups_migration_and_a2f3e7')
  } },
  { id: 'trash', get title() {
    return translate('common.trash_ba35dc')
  }, icon: 'trash', get description() {
    return translate('settings.restore_or_permanently_delete_files_3db466')
  } },
  { id: 'account', get title() {
    return translate('settings.account_and_security_ed3b4b')
  }, icon: 'user', get description() {
    return translate('settings.password_api_tokens_and_signing_9c84b0')
  } },
  { id: 'about', get title() {
    return translate('settings.about_52d25a')
  }, icon: 'info', get description() {
    return translate('settings.app_version_installation_and_api_1217bd')
  } },
]

export const SETTING_ITEMS = {
  'locale': { section: 'appearance', get title() {
    return translate('settings.language')
  }, get description() {
    return translate('settings.language_description')
  }, keywords: 'language English Chinese 语言 英文 中文' },
  'storage': { section: 'storage', get title() {
    return translate('settings.storage_usage_37ac17')
  }, get description() {
    return translate('settings.automatically_counts_vault_databases_fonts_0fcb92')
  }, get keywords() {
    return translate('settings.capacity_usage_size_attachments_images_43526f')
  } },
  'backup-full': { section: 'storage', get title() {
    return translate('settings.full_instance_backup_093926')
  }, get description() {
    return translate('settings.includes_notes_trash_authentication_settings_c1fad0')
  }, get keywords() {
    return translate('settings.data_import_export_backup_restore_edece0')
  } },
  'backup-notes': { section: 'storage', get title() {
    return translate('settings.note_data_7d34ee')
  }, get description() {
    return translate('settings.export_markdown_and_attachments_as_362805')
  }, get keywords() {
    return translate('settings.data_md_markdown_import_export_0fe592')
  } },
  'backup-settings': { section: 'storage', get title() {
    return translate('settings.settings_and_resources_7408ce')
  }, get description() {
    return translate('settings.back_up_preferences_shortcuts_plugin_88d8f8')
  }, get keywords() {
    return translate('settings.settings_import_export_fonts_themes_6ca5d2')
  } },
  'index-optimize': { section: 'storage', get title() {
    return translate('settings.optimize_index_57f600')
  }, get description() {
    return translate('settings.optimize_full_text_search_and_c95d3a')
  }, get keywords() {
    return translate('settings.search_database_optimize_vacuum_378345')
  } },
  'index-rebuild': { section: 'storage', get title() {
    return translate('settings.rebuild_index_9b178a')
  }, get description() {
    return translate('settings.rebuild_full_text_search_and_af7c7e')
  }, get keywords() {
    return translate('settings.search_database_rebuild_repair_fa9c2a')
  } },
  'temp-clear': { section: 'storage', get title() {
    return translate('settings.clean_temporary_files_af91ae')
  }, get description() {
    return translate('settings.remove_temporary_files_no_longer_d96efe')
  }, get keywords() {
    return translate('settings.temporary_cache_space_cleanup_c6ff13')
  } },
  'settings-reset': { section: 'storage', get title() {
    return translate('settings.reset_settings_9a70ef')
  }, get description() {
    return translate('settings.reset_all_rawmark_preferences_and_9b1af9')
  }, get keywords() {
    return translate('settings.reset_default_restore_3d517b')
  } },
  'logs-export': { section: 'storage', get title() {
    return translate('settings.export_system_logs_d05855')
  }, get description() {
    return translate('settings.export_rotated_application_logs_and_b1f880')
  }, get keywords() {
    return translate('settings.logs_system_errors_diagnostics_f13574')
  } },
  'trash-retention': { section: 'trash', get title() {
    return translate('settings.automatic_deletion_2fb018')
  }, get description() {
    return translate('settings.measured_from_the_original_deletion_0b80f9')
  }, get keywords() {
    return translate('settings.trash_days_automatic_cleanup_retention_f6669a')
  } },
  'trash-clear': { section: 'trash', get title() {
    return translate('settings.empty_trash_1b5909')
  }, get description() {
    return translate('settings.permanently_delete_all_items_in_cf673d')
  }, get keywords() {
    return translate('settings.trash_cleanup_all_delete_bf12ce')
  } },
  'ui-font': { section: 'appearance', get title() {
    return translate('settings.interface_font_52a039')
  }, get description() {
    return translate('settings.used_for_menus_sidebars_and_4ac475')
  }, get keywords() {
    return translate('settings.ui_fonts_import_delete_ttf_767e88')
  } },
  'ui-font-size': { section: 'appearance', get title() {
    return translate('settings.interface_font_size_608972')
  }, get description() {
    return translate('settings.adjust_text_in_menus_sidebars_2eb51a')
  }, get keywords() {
    return translate('settings.ui_size_8d1a96')
  } },
  'theme-select': { section: 'appearance', get title() {
    return translate('settings.themes_788db1')
  }, get description() {
    return translate('settings.use_a_built_in_theme_c2d94c')
  }, get keywords() {
    return translate('settings.light_dark_custom_2035c5')
  } },
  'color-mode': { section: 'appearance', get title() {
    return translate('settings.color_mode_65260b')
  }, get description() {
    return translate('settings.choose_light_dark_or_follow_614653')
  }, get keywords() {
    return translate('settings.night_light_dark_system_49c06d')
  } },
  'glass-opacity': { section: 'appearance', get title() {
    return translate('settings.glass_opacity_c60f04')
  }, get description() {
    return translate('settings.adjust_glass_panel_transparency_while_69b576')
  }, get keywords() {
    return translate('settings.opacity_background_33f07e')
  } },
  'css-snippets': { section: 'appearance', get title() {
    return translate('settings.css_snippets_d0a2c3')
  }, get description() {
    return translate('settings.manage_custom_themes_and_css_5e5a1a')
  }, get keywords() {
    return translate('settings.styles_custom_advanced_88fcf7')
  } },
  'reset-appearance': { section: 'appearance', get title() {
    return translate('settings.reset_appearance_and_typography_c73c09')
  }, get description() {
    return translate('settings.reset_themes_interface_and_body_b13efd')
  }, get keywords() {
    return translate('settings.reset_default_restore_3d517b')
  } },
  'text-font': { section: 'editor', get title() {
    return translate('settings.body_font_dd63f6')
  }, get description() {
    return translate('settings.used_for_note_content_without_30ab7a')
  }, get keywords() {
    return translate('settings.sans_serif_system_13027c')
  } },
  'code-font': { section: 'editor', get title() {
    return translate('settings.code_font_e42107')
  }, get description() {
    return translate('settings.used_for_code_blocks_and_a5b950')
  }, get keywords() {
    return translate('settings.monospace_jetbrains_mono_324be7')
  } },
  'font-size': { section: 'editor', get title() {
    return translate('settings.editor_font_size_7c825e')
  }, get description() {
    return translate('settings.adjust_the_base_font_size_12669f')
  }, get keywords() {
    return translate('settings.body_size_daa3aa')
  } },
  'content-width': { section: 'editor', get title() {
    return translate('settings.content_width_e92272')
  }, get description() {
    return translate('settings.limit_the_maximum_content_width_5de587')
  }, get keywords() {
    return translate('settings.narrow_standard_wide_full_width_d586a8')
  } },
  'line-height': { section: 'editor', get title() {
    return translate('settings.body_line_height_088ef4')
  }, get description() {
    return translate('settings.adjust_the_distance_between_lines_d6a35c')
  }, get keywords() {
    return translate('settings.line_spacing_typography_703508')
  } },
  'selection-toolbar': { section: 'editor', get title() {
    return translate('settings.selection_toolbar_1fe31f')
  }, get description() {
    return translate('settings.show_common_formatting_actions_when_b8ed19')
  }, get keywords() {
    return translate('settings.format_editing_8105d6')
  } },
  'spellcheck': { section: 'editor', get title() {
    return translate('settings.spell_check_c664a4')
  }, get description() {
    return translate('settings.use_the_browser_s_spell_be99c8')
  }, get keywords() {
    return translate('settings.language_spelling_d5cb13')
  } },
  'tab-size': { section: 'editor', get title() {
    return translate('settings.tab_width_c8881a')
  }, get description() {
    return translate('settings.change_only_the_display_width_3af0c9')
  }, get keywords() {
    return translate('settings.tab_indentation_spaces_8a3c02')
  } },
  'typography-preview': { section: 'editor', get title() {
    return translate('settings.typography_preview_31ac73')
  }, get description() {
    return translate('settings.preview_the_current_body_and_aadacb')
  }, get keywords() {
    return translate('settings.font_size_line_height_spacing_862f84')
  } },
  'tokens': { section: 'account', get title() {
    return translate('common.api_tokens_79db53')
  }, get description() {
    return translate('settings.create_or_revoke_rest_api_64d1ec')
  }, get keywords() {
    return translate('settings.api_rest_automation_security_ca1d07')
  } },
  'password': { section: 'account', get title() {
    return translate('settings.change_password_81ecab')
  }, get description() {
    return translate('settings.other_devices_must_sign_in_2c516e')
  }, get keywords() {
    return translate('settings.account_security_authentication_e06655')
  } },
  'logout': { section: 'account', get title() {
    return translate('common.sign_out_3ab8cc')
  }, get description() {
    return translate('settings.end_this_device_s_login_c5bf28')
  }, get keywords() {
    return translate('settings.account_session_4b227c')
  } },
  'install': { section: 'about', get title() {
    return translate('settings.install_app_a298ba')
  }, get description() {
    return translate('settings.add_rawmark_to_your_desktop_fb06d4')
  }, get keywords() {
    return translate('settings.pwa_install_57a0e5')
  } },
  'version': { section: 'about', get title() {
    return translate('settings.build_version_736f65')
  }, get description() {
    return translate('settings.the_application_version_loaded_by_3242d8')
  }, get keywords() {
    return translate('settings.rawmark_about_64ca9b')
  } },
  'openapi': { section: 'about', get title() {
    return translate('settings.api_documentation_c7042f')
  }, get description() {
    return translate('settings.create_a_token_under_account_8d40ff')
  }, get keywords() {
    return translate('settings.openapi_automation_9f53ae')
  } },
} satisfies Record<string, { section: SettingsSection, title: string, description: string, keywords: string }>

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
    ...SETTINGS_SECTIONS.filter(s => matches(`${s.title} ${s.description}`)).map(s => ({ section: s.id, title: s.title, description: s.description })),
    ...(Object.entries(SETTING_ITEMS) as [SettingId, typeof SETTING_ITEMS[SettingId]][])
      .filter(([, item]) => matches(`${item.title} ${item.description} ${item.keywords}`))
      .map(([id, item]) => ({ id, section: item.section, title: item.title, description: item.description })),
  ]
}
