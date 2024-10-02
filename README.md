<div align="center">
  <img width="100" src="./public/icon.png" />
  <h1>Koma</h1>
  <img width="600" src="./screenshot.png" alt="Screenshot of the app" />
	<div>
		<strong><a href="https://baku89.github.io/koma/">💥 Live Demo 💥</a></strong>
	</div>
	<br>
</div>

An open-source stop-motion tool that runs on browsers. It allows you to shoot while tethering USB-connected cameras such as DSLMs, DSLRs, and webcams. Technically, it's built upon [Picture Transfer Protocol](https://en.wikipedia.org/wiki/Picture_Transfer_Protocol), [WebUSB API](https://developer.mozilla.org/en-US/docs/Web/API/USB) and its wrapper library [Tethr](https://github.com/baku89/tethr). Note that this project has been developed for my animation project and is still in the early stage of working in progress. So it might not work in your environment yet.

FYI, Koma (コマ) means “frames” in Japanese, but I'm wondering if the app has a nicer name.

[日本語での解説はこちら](./README.ja.md)

## Development

```bash
git clone --recursive https://github.com/baku89/koma
yarn install
yarn dev
```

## Termiology

The terms used in the code and documentation.

- OPFS: [Origin Private FIle System](https://developer.chrome.com/articles/file-system-access/#accessing-the-origin-private-file-system).
- Frame: An integer that represents a frame number (starts from 0)
- Koma: A frame data that contains multiple Shots
- Shot: A single image data that contains images and metadata

- flatten data: A data represented as plain JS object and can be JSON-stringified
- unflatten data: A data that contains Blob objects

## Credits

- Sound Effects by [OtoLogic](https://otologic.jp/free/license.html) ([CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/))
