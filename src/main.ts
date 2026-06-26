import 'floating-vue/dist/style.css'
// Override floating-vue's light popper styling to follow Tweeq's theme.
import './floating-vue-theme.css'

import FloatingVue from 'floating-vue'
import {createPinia} from 'pinia'
import {TroisJSVuePlugin} from 'troisjs'
import {createApp} from 'vue'

import App from './components/App.vue'

const pinia = createPinia()
const app = createApp(App)

app.use(pinia)
// Teleport tooltips into Tweeq's viewport so they inherit its CSS reset
// (font-family, colors). The default 'body' target sits outside .TqViewport,
// leaving tooltips with the UA default serif font.
app.use(FloatingVue, {container: '.TqViewport'})
app.use(TroisJSVuePlugin)

app.mount('#app')
