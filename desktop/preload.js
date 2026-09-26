/**
 * 面板窗口的 preload — 只暴露一个能力：在隐私（无痕）会话里打开一个授权/登录页面。
 *
 * 用途：Qoder / 未来其他产品的网页登录，有时需要绕开系统默认浏览器里已登录的账号（选账号页面
 * 会默认带出已登录身份），或者不想让登录页的 Cookie 混进日常浏览的浏览器里。
 * contextIsolation 下面板拿到的只是这一个函数，不能访问 Node/Electron 的其它能力。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('creditdaddy', {
  /** @param {string} url 必须是 https:// 开头 @returns {Promise<{ok: boolean, error?: string}>} */
  openAuthWindow: (url) => ipcRenderer.invoke('open-auth-window', String(url || '')),
  /** 打开本机 ZCode 客户端 @returns {Promise<{ok: boolean, error?: string}>} */
  openZcodeClient: () => ipcRenderer.invoke('open-zcode-client'),
});
