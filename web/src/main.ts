import { watchFontLoading } from './themes/fontLoading'
import { createApp } from 'vue'
import App from './app/App.vue'
import './themes/base.css'
import './app/app.css'

watchFontLoading()
createApp(App).mount('#app')
