import { defineConfig, presetAttributify, presetWind3 } from 'unocss'

export default defineConfig({
  // Presets.
  presets: [
    // Attributify mode and valueless attributes.
    presetAttributify({
      prefix: 'un-',
      prefixedOnly: false,
    }),
    // Default preset.
    presetWind3({
      important: '#app',
    }),
  ],
  // Custom rules.
  rules: [],
  // Custom shortcuts.
  shortcuts: {
    'wh-full': 'w-full h-full',
    'flex-center': 'flex justify-center items-center',
    'flex-x-center': 'flex justify-center',
    'flex-y-center': 'flex items-center',
  },
})
