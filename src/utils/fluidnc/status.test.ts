import {describe, expect, it} from 'vitest'

import {
	axesWords,
	fmtNum,
	jogLine,
	machineMoveLine,
	prepareGCode,
	setWorkOffsetLine,
} from './gcode'
import {
	classifyLine,
	mposToWpos,
	parseBuildInfo,
	parseStatusReport,
} from './status'

describe('parseStatusReport', () => {
	it('parses a 6-axis FluidNC idle report', () => {
		const s = parseStatusReport(
			'<Idle|MPos:1.000,-2.500,3.000,4.000,5.000,6.000|FS:0,0|WCO:0.000,0.000,0.000,0.000,0.000,0.000>'
		)
		expect(s.state).toBe('Idle')
		expect(s.mpos).toEqual({x: 1, y: -2.5, z: 3, a: 4, b: 5, c: 6})
		expect(s.feedRate).toBe(0)
		expect(s.wco).toEqual({x: 0, y: 0, z: 0, a: 0, b: 0, c: 0})
	})

	it('parses sub-state, pins, overrides, buffers and SD', () => {
		const s = parseStatusReport(
			'<Hold:1|MPos:0.000,0.000,0.000|Bf:15,128|Ln:42|FS:500,12000|Pn:XYP|Ov:100,90,80|A:SF|SD:12.5,/sd/frame.nc>'
		)
		expect(s.state).toBe('Hold')
		expect(s.subState).toBe(1)
		expect(s.buffer).toEqual({planner: 15, rx: 128})
		expect(s.lineNumber).toBe(42)
		expect(s.spindleSpeed).toBe(12000)
		expect(s.pins).toBe('XYP')
		expect(s.override).toEqual({feed: 100, rapid: 90, spindle: 80})
		expect(s.accessories).toBe('SF')
		expect(s.sd).toEqual({progress: 12.5, filename: '/sd/frame.nc'})
	})

	it('rejects non-reports', () => {
		expect(() => parseStatusReport('ok')).toThrow()
	})
})

describe('classifyLine', () => {
	it('classifies push messages', () => {
		expect(classifyLine('ok')).toEqual({type: 'ok'})
		expect(classifyLine('error:9')).toEqual({type: 'error', code: 9})
		expect(classifyLine('ALARM:12')).toEqual({type: 'alarm', code: 12})
		expect(classifyLine('[MSG:INFO: Homing]')).toEqual({
			type: 'message',
			text: 'INFO: Homing',
		})
		expect(classifyLine("Grbl 3.9 [FluidNC v3.9.9 (wifi) '$' for help]")).toMatchObject(
			{type: 'banner'}
		)
		expect(classifyLine('[GC:G0 G54 G17 G21 G90 G94]')).toEqual({
			type: 'bracket',
			key: 'GC',
			value: 'G0 G54 G17 G21 G90 G94',
		})
		expect(classifyLine('<Idle|MPos:0,0,0>')).toMatchObject({type: 'status'})
	})
})

describe('parseBuildInfo', () => {
	it('extracts the FluidNC machine name from $I output', () => {
		const info = parseBuildInfo([
			'[VER:3.9 FluidNC v3.9.9:]',
			'[OPT:PHS]',
			'[MSG: Machine: BoxRig]',
			'[MSG: Mode=STA:SSID=x:Status=Connected]',
		])
		expect(info.version).toBe('3.9 FluidNC v3.9.9')
		expect(info.options).toBe('PHS')
		expect(info.machineName).toBe('BoxRig')
	})
})

describe('mposToWpos', () => {
	it('subtracts the offset per axis', () => {
		expect(mposToWpos({x: 10, y: 5, a: 90}, {x: 1, y: 2})).toEqual({
			x: 9,
			y: 3,
			a: 90,
		})
	})
})

describe('gcode builders', () => {
	it('formats numbers without float noise', () => {
		expect(fmtNum(1)).toBe('1')
		expect(fmtNum(0.1 + 0.2)).toBe('0.3')
		expect(fmtNum(-0.00001)).toBe('0')
		expect(fmtNum(-2.5)).toBe('-2.5')
	})

	it('builds axes words in canonical order', () => {
		expect(axesWords({a: 90, x: 1.5, z: undefined})).toBe('X1.5 A90')
	})

	it('builds jog / move / offset lines', () => {
		expect(jogLine({x: -1}, {feed: 1000})).toBe('$J=G91 G21 X-1 F1000')
		expect(jogLine({x: 100}, {feed: 500, relative: false, machineCoords: true})).toBe(
			'$J=G90 G53 G21 X100 F500'
		)
		expect(machineMoveLine({x: 1, y: 2})).toBe('G53 G0 X1 Y2')
		expect(machineMoveLine({z: -3}, 200)).toBe('G53 G1 Z-3 F200')
		expect(setWorkOffsetLine(1, {x: 10, y: 20, z: 30})).toBe(
			'G10 L2 P1 X10 Y20 Z30'
		)
	})

	it('prepares G-code text', () => {
		expect(
			prepareGCode('%\n(header)\nG21 ; mm\n\n  G0 X1 (rapid) Y2\nM30\n')
		).toEqual([
			{line: 'G21', sourceLine: 3},
			{line: 'G0 X1  Y2', sourceLine: 5},
			{line: 'M30', sourceLine: 6},
		])
	})
})
