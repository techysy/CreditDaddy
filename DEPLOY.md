# fnOS 部署（fpk）

## 发版流程

1. **bump 版本号**（三处必须一致，CI 会校验）：
   - `package.json`
   - `desktop/package.json`
   - `fnos-packaging/manifest`
2. **归档 CHANGELOG**：把 `[Unreleased]` 内容移到 `## [<新版本>] (<日期>)` 下（GitHub Release notes 从这里提取）。
3. **跑发版前审查**：

       npm run release-check            # 按 package.json 当前版本
       npm run release-check -- 1.2.0   # 显式指定期望版本

   审查项：版本三处一致、JS 语法、单元测试、CHANGELOG 归档、tag 未占用、
   敏感文件、遗留调试代码、npm pack 内容、Desktop/fnOS 打包清单、
   运行时关键文件、TODO 统计、产品线文案覆盖。
   同一脚本也被 CI 的 `Release Check` workflow 调用（手动 dispatch，
   或给 PR 打 `release` 标签触发），本地与 CI 不会漂移。
4. **打 tag 推送**：

       git tag v1.2.0 && git push origin main --tags

   触发 `build-fpk`（4 个 fpk 变体）和 `build-desktop-win`（Win/macOS 桌面版），
   自动建 GitHub Release 并上传产物 + SHA256。
5. **（可选）发 npm**：`npm publish`（包名 `creditdaddy`，CLI 直装）。

## 构建方式

代码推到 GitHub 后，打 tag 触发 Actions（或手动 workflow_dispatch）：

    git tag v0.1.0 && git push origin main --tags

Actions 会在 ubuntu-24.04 / ubuntu-24.04-arm 两个 runner 上分别用官方 fnpack 1.2.1 打包，
产物：

    creditdaddy-<version>-x86.fpk           标签页版
    creditdaddy-<version>-arm.fpk
    CreditDaddy-FnOS-Window-<version>-x86.fpk    窗口版
    CreditDaddy-FnOS-Window-<version>-arm.fpk
    SHA256SUMS-fpk.txt

打 tag 时自动建 Release 并附上产物；手动触发则去 Actions 页面下载 artifact。

## 安装

fnOS 应用中心 → 手动安装 → 选择 fpk。会自动安装依赖应用 nodejs_v24。Release 里每个架构（x86 / arm）有两种包，按习惯选一个：

| 包 | 点桌面图标后 |
|---|---|
| `creditdaddy-<版本>-<架构>.fpk` | 在浏览器**新标签页**打开面板 |
| `CreditDaddy-FnOS-Window-<版本>-<架构>.fpk` | 在飞牛桌面的**窗口**里打开面板 |

两种包是同一个应用（appname 都是 creditdaddy、共用数据目录），想换的话直接覆盖安装另一种即可，账号与密码都保留。
窗口版注意：用 HTTPS 或远程域名访问飞牛时，浏览器会把 http 的窗口当作「混合内容」拦截，这种访问方式请用标签页版。

## 安装后

1. **面板访问密码**：安装向导里设置（至少 6 位、不含空格），存于 <数据目录>/panel_key（0600，不写日志）。
   打开面板时输入它；忘了可以在 fnOS「应用设置」里重设（保存后服务自动重启）。
   从 0.6.0 及更早版本升级的用户：旧版的密码是随机生成的，升级向导里可以直接设置一个新密码（留空则保留原密码）
2. 桌面出现 CreditDaddy 图标（面板端口 47860）：标签页版在新标签页打开，窗口版在飞牛桌面窗口里打开
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
