import {app, BrowserWindow} from 'electron'

interface USBDevice {
	deviceId: string
}

interface USBDeviceDetails {
	deviceList: USBDevice[]
	device: USBDevice
	deviceType: string
	origin: string
	securityOrigin: string
	protectedClasses: string[]
}

function createWindow() {
	const mainWindow = new BrowserWindow({
		width: 800,
		height: 600,
	})

	let grantedDeviceThroughPermHandler: USBDevice | undefined

	mainWindow.webContents.session.on(
		'select-usb-device',
		(
			event: Event,
			details: USBDeviceDetails,
			callback: (deviceId?: string) => void
		) => {
			mainWindow.webContents.session.on(
				'usb-device-added',
				(_event: Event, device: USBDevice) => {
					console.log('usb-device-added FIRED WITH', device)
				}
			)

			mainWindow.webContents.session.on(
				'usb-device-removed',
				(_event: Event, device: USBDevice) => {
					console.log('usb-device-removed FIRED WITH', device)
				}
			)

			event.preventDefault()
			if (details.deviceList && details.deviceList.length > 0) {
				const deviceToReturn = details.deviceList.find(device => {
					return (
						!grantedDeviceThroughPermHandler ||
						device.deviceId !== grantedDeviceThroughPermHandler.deviceId
					)
				})
				if (deviceToReturn) {
					callback(deviceToReturn.deviceId)
				} else {
					callback()
				}
			}
		}
	)

	// Load from Vite dev server in development
	if (process.env.VITE_DEV_SERVER_URL) {
		mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
	} else {
		mainWindow.loadFile('index.html')
	}
}

app.whenReady().then(() => {
	createWindow()

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow()
	})
})

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit()
})
