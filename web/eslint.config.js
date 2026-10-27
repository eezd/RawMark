import antfu from '@antfu/eslint-config'

// For more custom configuration, see https://github.com/antfu/eslint-config.
export default antfu(
  {
    // Use external formatters for CSS, HTML, Markdown, and similar files.
    formatters: true,
    // Enable stylistic rules.
    stylistic: {
      // Indentation width.
      indent: 2,
      // Quote style: 'single' | 'double'.
      quotes: 'single',
      // Whether to require semicolons.
      semi: false,
    },
    // Ignored files.
    ignores: ['dist/**', 'dist-demo/**', 'types/auto/**', 'public/**', 'src/common/appearance/fonts/**', 'src/common/appearance/maple-font.css', 'LICENSE'],
  },
  {
    // Rules applied to all files.
    rules: {
      // Preserve existing compact branches and native browser confirmation for destructive actions.
      'style/max-statements-per-line': 'off',
      'no-alert': 'off',
      // vue
      'vue/block-order': ['error', { order: ['script', 'template', 'style'] }],
      'vue/attributes-order': 'off',
      // ts
      'ts/no-use-before-define': 'off',
      // node
      'node/prefer-global/process': 'off',
      // style
      'style/comma-dangle': ['error', 'always-multiline'],
      'style/brace-style': ['error', '1tbs'],
      // regexp
      'regexp/no-unused-capturing-group': 'off',
      // other
      'no-console': 'off',
      'no-debugger': 'off',
      'symbol-description': 'off',
      'antfu/if-newline': 'off',
      'unicorn/no-instanceof-builtins': 'off',
    },
  },
  {
    files: ['src/**/*.{ts,vue}'],
    ignores: ['src/common/apis/**', 'src/http/**', 'src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: '@/http/axios', importNames: ['request'], message: '业务请求统一放在 common/apis/<resource>/index.ts。' }, { name: 'axios', importNames: ['default'], message: '复用 http/axios 的统一请求处理。' }] }],
    },
  },
  { files: ['src/service-worker.js'], languageOptions: { globals: { __PRECACHE__: 'readonly' } } },
)
