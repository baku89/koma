/**
 * WebUSB / WebSerial / File System Access permissions for the koma window.
 *
 * Chromium's device pickers don't exist in Electron; the renderer's
 * `requestDevice()` / `requestPort()` end up in the `select-*` events here.
 *
 * - Serial: every port is granted (koma already opens each granted port and
 *   asks the board what it is — see `serialDiscovery`), so `getPorts()` sees
 *   them all without anyone clicking. `requestPort()` still shows a small
 *   native chooser when more than one port matches.
 * - USB: Chrome's model — a camera is picked once (native chooser, or taken
 *   straight away when it's the only match) and remembered in userData, so
 *   `getDevices()` returns it on the next launch and tethr can reconnect.
 * - File System Access: granted, and the directory paths that come with the
 *   requests are recorded so the renderer can learn where its project folder
 *   really is (`grantedDirectoryPath`).
 */
import {app, type BrowserWindow, dialog, type Session} from 'electron'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'

//------------------------------------------------------------------------------
// Remembered USB grants

type UsbKey = string

const grantsFile = () => path.join(app.getPath('userData'), 'usb-grants.json')

function usbKey(d: {vendorId: number; productId: number; serialNumber?: string}): UsbKey {
	return `${d.vendorId}:${d.productId}:${d.serialNumber ?? ''}`
}

const usbGrants = new Set<UsbKey>(
	(() => {
		try {
			return JSON.parse(readFileSync(grantsFile(), 'utf8')) as UsbKey[]
		} catch {
			return []
		}
	})()
)

function rememberUsb(key: UsbKey) {
	usbGrants.add(key)
	try {
		mkdirSync(path.dirname(grantsFile()), {recursive: true})
		writeFileSync(grantsFile(), JSON.stringify([...usbGrants]))
	} catch {
		// best effort
	}
}

//------------------------------------------------------------------------------
// Granted directories (File System Access API)

const grantedDirs: {path: string; at: number}[] = []

function recordGrant(details?: {filePath?: string; isDirectory?: boolean}) {
	if (!details?.filePath || !details.isDirectory) return
	const p = details.filePath
	const i = grantedDirs.findIndex(g => g.path === p)
	if (i >= 0) grantedDirs.splice(i, 1)
	grantedDirs.push({path: p, at: Date.now()})
}

/** Most recently granted directory whose basename is `name`, or null. */
export function grantedDirectoryPath(name: string): string | null {
	for (let i = grantedDirs.length - 1; i >= 0; i--) {
		if (path.basename(grantedDirs[i].path) === name) return grantedDirs[i].path
	}
	return null
}

/** Whether `p` lies inside a folder the renderer was granted. */
export function isGrantedPath(p: string): boolean {
	const abs = path.resolve(p)
	return grantedDirs.some(g => abs === g.path || abs.startsWith(g.path + path.sep))
}

//------------------------------------------------------------------------------
// Native chooser for the `select-*` events

async function choose<T>(
	win: BrowserWindow | null,
	title: string,
	items: T[],
	label: (item: T) => string
): Promise<T | undefined> {
	if (items.length === 0) return undefined
	if (items.length === 1) return items[0]
	const buttons = items.map(label)
	const opts: Electron.MessageBoxOptions = {
		type: 'question',
		message: title,
		buttons: [...buttons, 'Cancel'],
		cancelId: buttons.length,
		noLink: true,
	}
	const {response} = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
	return response < items.length ? items[response] : undefined
}

const hex = (n: number) => n.toString(16).padStart(4, '0')

//------------------------------------------------------------------------------

export function installDeviceHandlers(ses: Session, getWindow: () => BrowserWindow | null) {
	// Everything the page asks for (usb, serial, fileSystem, media, clipboard,
	// notifications…) is ours to grant: there is one page and it is koma.
	ses.setPermissionRequestHandler((_wc, _permission, callback, details) => {
		recordGrant(details as {filePath?: string; isDirectory?: boolean})
		callback(true)
	})
	ses.setPermissionCheckHandler((_wc, _permission, _origin, details) => {
		recordGrant(details as {filePath?: string; isDirectory?: boolean})
		return true
	})

	ses.setDevicePermissionHandler(details => {
		if (details.deviceType === 'serial') {
			// Only USB-backed ports (the FluidNC boards, the LED wall's CP2102):
			// Chromium also lists Bluetooth and debug ports, and koma would probe
			// each of them for 12 s before giving up.
			return !!(details.device as Electron.SerialPort).vendorId
		}
		if (details.deviceType === 'usb') {
			return usbGrants.has(usbKey(details.device as Electron.USBDevice))
		}
		return false
	})

	ses.on('select-usb-device', (event, details, callback) => {
		event.preventDefault()
		// `deviceList` is already narrowed by the renderer's filters (PTP still
		// image class, or a remembered vendor:product).
		choose(getWindow(), 'Which camera?', details.deviceList, d => {
			const name = [d.manufacturerName, d.productName].filter(Boolean).join(' ')
			return `${name || 'USB device'}  ${hex(d.vendorId)}:${hex(d.productId)}${
				d.serialNumber ? `  #${d.serialNumber}` : ''
			}`
		}).then(device => {
			if (device) rememberUsb(usbKey(device))
			callback(device?.deviceId)
		})
	})

	ses.on('select-serial-port', (event, portList, _webContents, callback) => {
		event.preventDefault()
		choose(getWindow(), 'Which serial port?', portList, p => {
			const ids =
				p.vendorId && p.productId ? `  ${hex(Number(p.vendorId))}:${hex(Number(p.productId))}` : ''
			return `${p.displayName ?? p.portName}  (${p.portName})${ids}`
		}).then(port => callback(port?.portId ?? ''))
	})
}
