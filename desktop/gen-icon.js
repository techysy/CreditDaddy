// 从 icon.svg 矢量源重新栅格化 icon.png（1024×1024，透明底）
// 旧的 icon.png 是浏览器查看 SVG 的截图——带着滚动条和白底，必须重新生成
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    webPreferences: { offscreen: true },
  });
  await win.loadURL('file:///' + path.join(__dirname, 'icon.svg').replace(/\\/g, '/'));
  // 等一帧确保渲染完成
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.toPNG());
  console.log('icon.png 已生成:', img.getSize());
  app.exit(0);
});
