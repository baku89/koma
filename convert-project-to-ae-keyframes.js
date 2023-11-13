import {execSync} from 'child_process'
import fs from 'fs'
import {Euler, Quaternion} from 'three'

// Open the JSON file specified in the first argument of the command
const file = fs.readFileSync(process.argv[2], 'utf8')

// // Get the JSON data from the first argumnet of the command
const data = JSON.parse(file)

const {komas} = data

const keyframes = komas
	.map((koma, frame) => {
		const shot = koma.shots[0]

		if (!shot) return null

		return {
			frame,
			shootTime: shot.shootTime,
			...shot.cameraConfigs,
			...(shot.tracker ?? {}),
		}
	})
	.filter(Boolean)

const keyProps = [
	{aeProp: 'Slider Control #2\tSlider #2', key: 'shootTime'},
	{aeProp: 'Slider Control #3\tSlider #2', key: 'iso'},
	{
		aeProp: 'Slider Control #4\tSlider #2',
		key: 'shutterSpeed',
		f: v => v.split('/')[0],
	},
	{
		aeProp: 'Slider Control #5\tSlider #2',
		key: 'shutterSpeed',
		f: v => v.split('/')[1],
	},
	{
		aeProp: 'Slider Control #6\tSlider #2',
		key: 'aperture',
	},
	{
		aeProp: 'Slider Control #7\tSlider #2',
		key: 'focalLength',
	},
	{
		aeProp: '3D Point Control #8\t3D Point #2',
		key: 'position',
		header: ['X pixels', 'Y pixels', 'Z pixels'],
		f: v => v.join('\t'),
	},
	{
		aeProp: '3D Point Control #9\t3D Point #2',
		key: 'rotation',
		header: ['X pixels', 'Y pixels', 'Z pixels'],
		f: v =>
			new Euler()
				.setFromQuaternion(new Quaternion(...v))
				.toArray()
				.slice(0, 3)
				.map(v => (v * 180) / Math.PI)
				.join('\t'),
	},
]

const keyframeString = keyProps
	.map(({aeProp, header, key, f}) => {
		f ??= v => v
		header ??= []

		const values = keyframes
			.map(k => {
				if (k[key] === undefined) return null
				return `\t${k.frame}\t${f(k[key])}\t`
			})
			.filter(Boolean)
			.join('\n')

		return `Effects\t${aeProp}\n\tFrame\t${header.join('\t')}\t\n${values}\n`
	})
	.join('\n')

const clipboardData = `Adobe After Effects 8.0 Keyframe Data

	Units Per Second	15
	Source Width	100
	Source Height	100
	Source Pixel Aspect Ratio	1
	Comp Pixel Aspect Ratio	1

${keyframeString}

End of Keyframe Data`

// console.log(clipboardData)

// Copy to clipboard
execSync(`echo "${clipboardData}" | pbcopy`)
