<script lang="ts" setup>
import {refThrottled} from '@vueuse/core'
import {scalar} from 'linearly'
import {computed, onBeforeUnmount, onMounted, ref, shallowRef} from 'vue'

const log15 = ref('')
const dlog15 = refThrottled(log15, 100)

const log23 = ref('')
const dlog23 = refThrottled(log23, 100)

const tracker = shallowRef<HIDDevice | null>(null)

onMounted(async () => {
	const devices = await navigator.hid.getDevices()

	tracker.value = devices[0]

	tracker.value.addEventListener('inputreport', callback)

	tracker.value.open()
})

const historyCount = 500

function useGraph(options: {min: number; max: number; color: string}) {
	const {min, max} = options

	const history = ref<number[]>([])

	const points = computed(() => {
		const points = history.value.map(
			(v, i) => `${i},${scalar.inverseLerp(min, max, v)}`
		)
		return points.join(' ')
	})

	function addHistory(value: number) {
		history.value.push(value)

		if (history.value.length > historyCount) {
			history.value.shift()
		}
	}

	return {points, addHistory}
}

const vX = useGraph({min: -1, max: 1, color: 'red'})
const vY = useGraph({min: -1, max: 1, color: 'green'})
const vZ = useGraph({min: -1, max: 1, color: 'blue'})

const rvX = useGraph({min: -180, max: 180, color: 'pink'})
const rvY = useGraph({min: -180, max: 180, color: 'yellowgreen'})
const rvZ = useGraph({min: -180, max: 180, color: 'skyblue'})

const pg = useGraph({min: -32768, max: 0x7fff, color: 'black'})

function callback(event: HIDInputReportEvent) {
	const {reportId} = event

	const data = event.data as DataView

	if (reportId !== 35) {
		// 36がある
		return
	}

	// Parse
	const second = data.getUint8(0)
	const flag0 = data.getUint8(1) // データの種類に関係している気がする
	const millsecond = data.getUint8(2) // 255-0まですごい勢いでカウントアップしてる

	// これが 128 のとき、回転データが入ってくる
	// 位置トラッキングが切れると、16が途絶える
	const flag1 = data.getUint8(3)
	const counterA = data.getUint8(4)

	// 多分ジャイロセンサー
	const vel = [...new Int16Array(data.buffer.slice(5, 11))].map(x => x / 0x1000)

	// これは多分角速度
	const angleVel = [...new Int16Array(data.buffer.slice(11, 17))].map(toDegree)

	// 上位2ビットが常に00

	// 忙しなく動く
	const myth = [...new Uint8Array(data.buffer.slice(17, 21))].map(
		parse12BitSignedInt
	)

	// トラッキングが切れると止まる
	const rest = [...new Uint8Array(data.buffer.slice(21, 25))].map(
		parse12BitSignedInt
	)
	const last = [...new Uint8Array(data.buffer.slice(25))].map(
		parse12BitSignedInt
	)

	if (flag1 === 128) {
		// トラッカーからの情報なのかなと思う

		// vX.addHistory(vel[0])
		// vY.addHistory(vel[1])
		// vZ.addHistory(vel[2])

		// rvX.addHistory(angleVel[0])
		// rvY.addHistory(angleVel[1])
		// rvZ.addHistory(angleVel[2])

		log15.value = `
second= ${second}
flag0 = ${flag0}

ms    = ${millsecond}

flag1 = ${flag1}

cntA  = ${counterA}

angle = (${pt(vel)})
   av = (${pt(angleVel)})

myth  = (${pt(myth, 2)})
rest  = (${pt(rest, 2)})
last  = (${pt(last, 2)})
`
	} else if (flag1 === 16) {
		// これってベースステーションがTrackerを感知したときに発生する？
		// ベースステーション絡みたトラッカー情報?

		// 徐々にカウントアップする謎のデータ
		const countup = data.getInt16(5, true)
		pg.addHistory(countup)

		const bytes = new Uint8Array(data.buffer.slice(4))
		const uint16 = new Uint16Array(data.buffer.slice(5))

		log23.value = `
second= ${second}
flag0 = ${flag0}
ms    = ${millsecond}
flag1 = ${flag1}
cntA  = ${counterA}

angle = (${pt(vel)})
   av = (${pt(angleVel)})

myth  = (${pt(myth, 2)})
rest  = (${pt(rest, 2)})
last  = (${pt(last, 2)})

bytes = ${pt(bytes, 16, 2)}
uint16= ${pt(uint16, 10, 10)}

countup = ${countup}
`
	} else {
		console.log('unknown flag1', flag1, flag1.toString(2))
		// unknown flag1 192 11000000
		// unknown flag1 144 10010000
	}
}

function parse12BitSignedInt(value: number) {
	return value

	// 12ビットマスクを適用して12ビットだけを抽出
	value = value & 0x3f

	// 符号ビット（ビット11）をチェック
	if (value & 0x20) {
		// 負の数の場合、2の補数で負の数として解釈
		return value - 0x40
	} else {
		// 正の数の場合はそのまま返す
		return value
	}
}

function toDegree(v: number) {
	return Math.round((((v / 1000) * 180) / Math.PI) * 100) / 100
}

function pad(n: number, digit: number, width: number) {
	return n
		.toString(digit)
		.padStart(digit === 2 ? 8 : width, digit === 2 ? '0' : ' ')
}

function pt(arr: ArrayLike<number>, digit = 10, width = 4) {
	return Array.from(arr)
		.map(x => pad(x, digit, width))
		.join(' ')
}

onBeforeUnmount(() => {
	if (tracker.value) {
		tracker.value.removeEventListener('inputreport', callback)
		tracker.value.close()
	}
})
</script>

<template>
	<div class="ViveTracker">
		<h1>Vive Tracker: {{ tracker?.productName }}</h1>

		<pre>{{ log15 }}</pre>
		<svg :viewBox="`0 0 ${historyCount} 1`" preserveAspectRatio="none">
			<polyline :points="pg.points.value" stroke="black" />
			<!-- <polyline :points="vX.points.value" stroke="red" /> -->
			<!-- <polyline :points="vY.points.value" stroke="green" /> -->
			<!-- <polyline :points="vZ.points.value" stroke="blue" /> -->
			<!-- <polyline :points="rvX.points.value" stroke="pink" /> -->
			<!-- <polyline :points="rvY.points.value" stroke="yellowgreen" /> -->
			<!-- <polyline :points="rvZ.points.value" stroke="skyblue" /> -->
		</svg>

		<pre>{{ dlog23 }}</pre>
	</div>
</template>

<style lang="stylus" scoped>
.ViveTracker
	color black
	position fixed
	z-index 1000
	top 200px
	font-family monospace
	width 100%
	background white

svg
	width 100%
	height 80px
	background pink
	overflow visible

polyline
	fill none
	stroke-width 1
	vector-effect non-scaling-stroke
</style>
