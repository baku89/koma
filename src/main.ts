import {createPinia} from 'pinia'
import {TroisJSVuePlugin} from 'troisjs'
import {vTooltip} from 'tweeq'
import {createApp} from 'vue'

import App from './components/App.vue'

const pinia = createPinia()
const app = createApp(App)

app.use(pinia)
// Tweeq's balloon tooltip, used via `v-tooltip` across the app.
app.directive('tooltip', vTooltip)
app.use(TroisJSVuePlugin)

app.mount('#app')
