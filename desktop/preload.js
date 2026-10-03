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
  /** 打开本机 mirasim 客户端 @returns {Promise<{ok: boolean, error?: string}>} */
  openMirasimClient: () => ipcRenderer.invoke('open-mirasim-client'),
  /** 打开本机妙手（美团 CatPaw）客户端 @returns {Promise<{ok: boolean, error?: string}>} */
  openCatpawClient: () => ipcRenderer.invoke('open-catpaw-client'),
  /** 打开本机 Trae 客户端 @returns {Promise<{ok: boolean, error?: string}>} */
  openTraeClient: () => ipcRenderer.invoke('open-trae-client'),
  /** 打开本机 MiniMax Code 客户端 @returns {Promise<{ok: boolean, error?: string}>} */
  openMiniMaxClient: () => ipcRenderer.invoke('open-minimax-client'),
  /** 检查更新（面板内弹窗）：状态查询 / 触发检查 / 主按钮动作 / 打开 Releases / 状态推送 */
  update: {
    state: () => ipcRenderer.invoke('update-state'),
    check: () => ipcRenderer.invoke('update-check'),
    install: () => ipcRenderer.invoke('update-install'),
    openReleases: () => ipcRenderer.invoke('update-open-releases'),
    onState: (cb) => { const l = (_e, s) => cb(s); ipcRenderer.on('update:state', l); return () => ipcRenderer.removeListener('update:state', l); },
    onOpen: (cb) => { const l = () => cb(); ipcRenderer.on('update:open', l); return () => ipcRenderer.removeListener('update:open', l); },
  },
});
