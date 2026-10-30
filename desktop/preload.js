/**
 * 面板窗口的 preload — 只暴露一个能力：在隐私（无痕）会话里打开一个授权/登录页面。
 *
 * 用途：Qoder / 未来其他产品的网页登录，有时需要绕开系统默认浏览器里已登录的账号（选账号页面
 * 会默认带出已登录身份），或者不想让登录页的 Cookie 混进日常浏览的浏览器里。
 * contextIsolation 下面板拿到的只是这一个函数，不能访问 Node/Electron 的其它能力。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('creditdaddy', {
  /**
   * @param {string} url 必须是 https:// 开头
   * @param {{persistKey?: string}} [opts] persistKey='cookie-site-<id>' → 持久登录分区
   *   （本窗登录一次，下一轮捕获/重探复用会话免二次登录）；缺省 = 一次性隐私窗。
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  openAuthWindow: (url, opts) => ipcRenderer.invoke('open-auth-window', String(url || ''), opts),
  /** 抹掉某站点持久登录分区的存储（「清除已存会话」）@returns {Promise<{ok: boolean, error?: string}>} */
  clearCookieSiteSession: (persistKey) => ipcRenderer.invoke('clear-cookie-site-session', String(persistKey || '')),
  /** 打开本机 ZCode 客户端 @returns {Promise<{ok: boolean, error?: string}>} */
  openZcodeClient: () => ipcRenderer.invoke('open-zcode-client'),
  /** 打开本机 mirasim 客户端 @returns {Promise<{ok: boolean, error?: string}>} */
  openMirasimClient: () => ipcRenderer.invoke('open-mirasim-client'),
  /** 打开本机妙手（美团 CatPaw）客户端 @returns {Promise<{ok: boolean, error?: string}>} */
  openCatpawClient: () => ipcRenderer.invoke('open-catpaw-client'),
  /** 打开本机 Trae 客户端 @returns {Promise<{ok: boolean, error?: string}>} */
  openTraeClient: () => ipcRenderer.invoke('open-trae-client'),
  /** 打开本机 Qoder 客户端（按渠道：qoder / qoder-cn）@returns {Promise<{ok: boolean, error?: string}>} */
  openQoderClient: (provider) => ipcRenderer.invoke('open-qoder-client', String(provider || 'qoder')),
  openDoubaoClient: () => ipcRenderer.invoke('open-doubao-client'),
  /** 打开本机 MiniMax Code 客户端 @returns {Promise<{ok: boolean, error?: string}>} */
  openMiniMaxClient: () => ipcRenderer.invoke('open-minimax-client'),
  /** 打开本机 Loomy 客户端 @returns {Promise<{ok: boolean, error?: string}>} */
  openLoomyClient: () => ipcRenderer.invoke('open-loomy-client'),
  /** 重启 CreditDaddy 应用 @returns {Promise<{ok: boolean, error?: string}>} */
  restartApp: () => ipcRenderer.invoke('app-restart'),
  /** 简要更新日志（解析随包 CHANGELOG.md 的最近几个版本） */
  changelogBrief: () => ipcRenderer.invoke('changelog-brief'),
  /** 检查更新（面板内弹窗）：状态查询 / 触发检查 / 主按钮动作 / 打开 Releases / 状态推送 */
  update: {
    state: () => ipcRenderer.invoke('update-state'),
    check: () => ipcRenderer.invoke('update-check'),
    install: () => ipcRenderer.invoke('update-install'),
    openReleases: () => ipcRenderer.invoke('update-open-releases'),
    onState: (cb) => { const l = (_e, s) => cb(s); ipcRenderer.on('update:state', l); return () => ipcRenderer.removeListener('update:state', l); },
    onOpen: (cb) => { const l = () => cb(); ipcRenderer.on('update:open', l); return () => ipcRenderer.removeListener('update:open', l); },
    onChangelogOpen: (cb) => { const l = () => cb(); ipcRenderer.on('changelog:open', l); return () => ipcRenderer.removeListener('changelog:open', l); },
  },
  /** 打开外部 URL（捐赠按钮） */
  shellOpen: (url) => ipcRenderer.invoke('shell-open-external', url),
  openChangelogBrief: () => ipcRenderer.invoke('open-changelog-brief'),
  /** cookie 站点捕获成功（issue #23：桌面壳收割完成通知），cb({site, name}) */
  onCookieCaptured: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on('cookie-site:captured', l); return () => ipcRenderer.removeListener('cookie-site:captured', l); },
  /** Qoder 网页会话收割绑定完成（cb({bound})）：面板「缺网页会话」徽章即时消失 */
  onQoderWebSessionBound: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on('qoder-web-session:bound', l); return () => ipcRenderer.removeListener('qoder-web-session:bound', l); },
});
