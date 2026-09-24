# fnOS 部署（fpk）

## 构建方式

代码推到 GitHub 后，打 tag 触发 Actions（或手动 workflow_dispatch）：

    git tag v0.1.0 && git push origin main --tags

Actions 会在 ubuntu-24.04 / ubuntu-24.04-arm 两个 runner 上分别用官方 fnpack 1.2.1 打包，
产物：

    creditdaddy-<version>-x86.fpk
    creditdaddy-<version>-arm.fpk
    SHA256SUMS-fpk.txt

打 tag 时自动建 Release 并附上产物；手动触发则去 Actions 页面下载 artifact。

## 安装

fnOS 应用中心 → 手动安装 → 选择 fpk。会自动安装依赖应用 nodejs_v24。

## 安装后

1. 首次启动会生成面板访问密钥，写入 <数据目录>/panel_key（0600），
   并在安装日志打印一次 —— 打开面板时输入该密钥
2. 桌面出现两个图标，按习惯选一个（端口都是 47860）：
   - **CreditDaddy**：在浏览器新标签页打开（应用中心卡片默认也打开这个）
   - **CreditDaddy（窗口）**：在飞牛桌面的窗口里打开。用 HTTPS 或远程域名访问飞牛时，浏览器会把 http 窗口当作「混合内容」拦截，
     这时请用新标签页那个图标
   - 用不到的图标可以在飞牛桌面上隐藏
3. 数据目录：@appdata/creditdaddy（账号 token 均只存本机）
4. 服务监听 0.0.0.0:47860，所有 /api/* 需要 x-qd-key 头（或 ?key=）

## 功能限制

Qoder 国际版的每日 Credits 只下发给携带设备风控身份的请求，风控身份由 Qoder 客户端（Windows / macOS）自带的
runtime-info 生成。NAS 上没有 Qoder 客户端，需要先安装 **设备身份组件**：打开面板的 Qoder 页点「安装设备身份组件」，
或 SSH 执行 `node bin/creditdaddy.js umid install`。它从 npm 官方包 `@qoder-ai/qodercli` 下载（约 30MB，校验 npm 的 sha512 完整性），
取出其中内置的 Linux x64 / arm64 版 UMID 程序存到数据目录的 `qoder-umid/`，装好后 NAS 即可签到 Qoder 国际版。
NAS 算一台独立设备：每天同样只能有一个国际版账号领取（与 Windows 电脑各算各的）。
WorkBuddy / ZCode 账号不受影响（本机导入 / 切换客户端需在装有客户端的电脑上操作；也可以在 NAS 面板里用「浏览器登录」直接添加）。

## 手动运维

fnOS 应用详情页可启停；命令行：

    /var/apps/creditdaddy/cmd/main start|stop|status|restart

日志：<数据目录>/creditdaddy.log

## 10Router 集成

面板「10Router」标签页填 10Router 地址（如 `http://127.0.0.1:20128`，NAS 上的 10Router 用其局域网地址）和虚拟 key，即可看其他供应商的额度卡片（需 10Router 1.2.1+）。
用量同步读的是本机桌面客户端（ZCode / OpenCode / mirasim / MiMo）的数据，NAS 上一般没有这些客户端，请在装有它们的电脑上用桌面版开启同步。

## 从 QoderDaddy 迁移

CreditDaddy（原名 QoderDaddy）的 fpk appname 为 creditdaddy，会作为新应用安装；首次启动自动把 @appdata/qoderdaddy 的账号数据与 panel_key 复制过来。确认无误后卸载旧的 QoderDaddy 应用。

## 升级 / 卸载

- 升级：应用中心覆盖安装新版本 fpk，panel_key 与账号数据保留
- 卸载：卸载不会删除 @appdata/creditdaddy 数据目录，需手动清理
