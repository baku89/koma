import 'tweeq/global.styl'
import 'floating-vue/dist/style.css'

import FloatingVue from 'floating-vue'
import {createPinia} from 'pinia'
import {createApp} from 'vue'

import App from './components/App.vue'

const pinia = createPinia()
const app = createApp(App)

app.use(pinia)
app.use(FloatingVue)
app.mount('#app')

const xr = navigator.xr

console.log(xr)

const session = await xr.requestSession('inline')

console.log(session)

session.addEventListener('inputsourceschange', event => {
	console.log(event)
})
