import 'floating-vue/dist/style.css'
// Override floating-vue's light popper styling to follow Tweeq's theme.
import './floating-vue-theme.css'

import FloatingVue from 'floating-vue'
import {createPinia} from 'pinia'
import {TroisJSVuePlugin} from 'troisjs'
import {vTooltip} from 'tweeq'
import {createApp} from 'vue'

import App from './components/App.vue'

const pinia = createPinia()
const app = createApp(App)

app.use(pinia)
// floating-vue is still needed for the remaining vDropdown usages; its container
// keeps those poppers inside Tweeq's viewport (CSS reset).
app.use(FloatingVue, {container: '.TqViewport'})
// Override floating-vue's v-tooltip with Tweeq's balloon tooltip.
app.directive('tooltip', vTooltip)
app.use(TroisJSVuePlugin)

app.mount('#app')
