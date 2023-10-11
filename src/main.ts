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

// Prevent pinch zooming on tablets
window.addEventListener(
	'touchstart',
	e => {
		if (e.touches.length > 1) {
			e.preventDefault()
		}
	},
	{passive: false}
)
