# 🐻‍❄️ QoderDaddy

**Qoder 多账号本地管理 + 每日 Credits 自动签到助手。**

架构参考 [WorkDaddy](https://github.com/babygoton/WorkDaddy)（本地守护进程 + Web 面板 + 数据全留本机 + 仅监听 127.0.0.1），
签到能力移植自 [10router](https://github.com/techysy/10router) 的 qoderCheckin，并按 Qoder App 0.2.x 客户端的真实协议补全了国际版签到。

## 功能

- **多账号管理**：国际版 / 国内版 Qoder 账号统一管理，卡片式面板（参考 WorkDaddy），显示签到状态、剩余 Credits、token 有效期，支持亮色 / 暗色
- **本机导入**：一键读取本机 Qoder / Qoder CN 客户端当前登录的账号（本地解密 `auth.v1.dat`，token 不出机器），同一用户 token 续期时自动更新
- **网络授权登录**：面板一键发起 Qoder 设备码授权（PKCE + nonce，与官方 qodercli 同流程），浏览器确认后 token 自动入库
- **每日自动签到**：守护进程每 ~2 小时扫描一轮；当天已领的账号记忆跳过；"无可领活动"不记忆，每日积分刷新（10:00 UTC+8）后自动重试。"签到日"以 10:00 (UTC+8) 为界，与本机时区无关
- **国际版签到**：携带 Qoder 客户端生成的设备风控身份（见下文），与客户端内「每天领 100 Credits」一致
- **导入导出**：可设口令加密，格式与 10router 的 OAuth 迁移文件（`10router-oauth-secure-v1`）互通 —— 10router 导出的 Qoder 授权可直接导入，QoderDaddy 的加密导出也能导入 10router
- **PAT 支持**：pt- 开头的 Personal Access Token 自动兑换短期 job token
- **Windows 桌面版**：托盘常驻、关窗不退出、开机自启（后台运行）、托盘一键签到并弹出结果
- **数据边界**：全部数据存 ~/.qoderdaddy（0600 权限 + 原子写 + 进程内串行写入），无任何遥测、无第三方依赖
- **本机防护**：只监听 127.0.0.1，并校验 Host 头（防 DNS 重绑定）、拒绝跨站 Origin（防 CSRF），网页无法偷读或篡改本机账号

## 国际版签到说明（重要）

实测 Qoder 国际版服务端只向**携带设备风控身份**（`Cosy-MachineToken / Cosy-MachineCode / Cosy-MachineType`）的请求下发「每天领 100 Credits」活动；不带时只返回推广活动，这也是旧版本（以及 10router）国际版一直"无可领活动"的原因。

- 风控身份由 **本机 Qoder 客户端自带的 `resources/umid/runtime-info`** 生成，QoderDaddy 直接调用它（每 50 分钟刷新），因此**国际版签到需要本机安装 Qoder 客户端**（无需保持登录、无需打开）
- **每台设备每天只能有一个国际版账号领取**（服务端按设备限领）。本机已有账号领取后，其余国际版账号显示「本机已领」并当日不再请求；账号列表中靠前的账号优先领取
- 国内版不需要风控身份，所有账号都能领取
- fnOS / NAS 上没有 Qoder 客户端，只能签到国内版账号

## 快速开始

需要 Node 18+，零依赖：

    node bin/qoderdaddy.js daemon        # 启动守护进程，打开 http://127.0.0.1:47860

CLI 用法：

    node bin/qoderdaddy.js scan                    # 导入本机 Qoder 客户端已登录的账号
    node bin/qoderdaddy.js add <token>             # 添加国际版账号
    node bin/qoderdaddy.js add <token> --cn        # 添加国内版账号
    node bin/qoderdaddy.js add <token> --name 工作号
    node bin/qoderdaddy.js list                    # 查看账号
    node bin/qoderdaddy.js checkin                 # 立即签到全部
    node bin/qoderdaddy.js checkin --cn            # 只签国内版（--intl 只签国际版）
    node bin/qoderdaddy.js remove <id前缀>          # 删除账号
    node bin/qoderdaddy.js export backup.json --password 口令   # 加密导出（10router 可导入）
    node bin/qoderdaddy.js export backup.json      # 明文导出（含明文 token）
    node bin/qoderdaddy.js import backup.json [--password 口令] # 导入 QoderDaddy / 10router 导出文件
    node bin/qoderdaddy.js help                    # 帮助

## 导入导出格式

加密文件与 10router `src/lib/auth/secureTransfer.js` 完全一致：

    { "format": "10router-oauth-secure-v1", "kdf": { "alg": "scrypt", "N": 16384, "r": 8, "p": 1, "keyLen": 32, "salt": "…" },
      "cipher": "aes-256-gcm", "iv": "…", "tag": "…", "payload": "…" }

解密后的载荷：`{ provider, exportedAt, accounts: [{ provider, name, email, uid, accessToken, refreshToken, expiresAt, providerSpecificData }] }`。
导入 10router 文件时只取 qoder / qoder-cn 账号；10router 按提供商导入，混合导出时建议分别导出国际版 / 国内版。

## API 端点

Qoder 侧（国际版 openapi.qoder.sh，国内版 openapi.qoder.com.cn）：

    GET  /sash/api/v1/me/campaigns                      活动（签到）列表，返回 uid / campaigns
    POST /sash/api/v1/me/campaigns/{id}/claim           领取
    GET  /api/v1/userinfo                               账号信息
    GET  /api/v2/quota/usage                            配额
    POST /api/v1/jobToken/exchange                      PAT → job token

签到请求头与 Qoder App 客户端一致：`Authorization`、`Cosy-ClientType: 10`、`Cosy-Version`（客户端版本）、
`Cosy-MachineOS`（如 `x86_64_win32`）、`Cosy-MachineHostname`、`Cosy-MachineId`，以及上述风控三件套。

### 本地 HTTP API

    GET    /api/accounts                账号列表（脱敏）
    POST   /api/accounts                添加 {name, provider, token}
    PATCH  /api/accounts/:id            修改备注名 {name}
    DELETE /api/accounts/:id            删除
    POST   /api/accounts/:id/checkin    单账号签到
    GET    /api/accounts/:id/quota      配额
    POST   /api/checkin                 全部签到 {provider?, skipIfCheckedToday?}（默认跳过今日已签）
    POST   /api/auth/device/start       发起设备码授权 {provider}
    POST   /api/auth/device/poll        轮询授权结果 {sessionId}
    GET    /api/local/detect            检测本机 Qoder 客户端 / 旧版 IDE / CLI
    POST   /api/local/scan              读取本机已登录账号
    POST   /api/local/import            导入扫描候选 {candidateId, provider?}
    GET    /api/status                  状态（版本、调度器、风控身份是否可用）
    GET    /api/logs                    日志
    POST   /api/export                  导出 {password?, provider?}
    POST   /api/import                  导入 {data, password?}

设置环境变量 `QODERDADDY_PASSWORD` 后，所有 /api/* 需要 `x-qd-key` 头（fnOS 部署自动启用）。

## 签到状态说明

| status | 含义 | 当日记忆 |
|---|---|---|
| checked-in | 领取成功，含金额 | ✓ 记忆，今天不再重复请求 |
| already | 有积分活动但已领过 | ✓ 记忆 |
| limited | 国际版：本机今日额度已被其他账号领取 | ✓ 记忆 |
| no-activity | 当前无可领活动（可能窗口未开） | ✗ 下轮重试 |
| failed | 鉴权失败 / 网络错误等 | ✗ 下轮重试 |

> ⚠️ 非官方接口，Qoder 调整服务端时可能失效。请遵守平台服务条款，仅管理自己的账号。

## 目录结构

    bin/qoderdaddy.js    CLI 入口
    src/constants.js     端点与请求头常量（版本号取自 package.json）
    src/qoderClient.js   Qoder OpenAPI 客户端（签到核心）
    src/qoderApp.js      本机 Qoder 客户端集成：安装探测、设备风控身份、safeStorage 解密
    src/checkin.js       调度器（2h tick + 当日去重 + 本机限领 + 串行执行）
    src/accounts.js      账号新增 / 导入 / 续期的统一入口
    src/transfer.js      导入导出（10router 迁移格式互通）
    src/authDevice.js    设备码授权登录（PKCE）
    src/localDetect.js   旧版 IDE / CLI token 扫描
    src/daemon.js        本地 HTTP API + 面板托管
    src/panel.html       Web 管理面板
    src/store.js         本机存储（原子写 / 0600 / 串行读改写）
    src/logger.js        环形缓冲日志
    test/                冒烟测试
    desktop/             Windows 桌面版（Electron 壳）
    fnos-packaging/      fnOS fpk 打包

## Windows 桌面版（Electron 壳）

Releases 下载 **QoderDaddy-Setup-x.y.z.exe**（安装版）或 **QoderDaddy-Portable-x.y.z.exe**（免安装）：

- 打开即用：内置 Node daemon，无需单独安装 Node.js
- 关闭窗口 = 隐藏到托盘，**后台自动签到不中断**；单击托盘图标打开面板，右键菜单可「立即签到 / 开机自启 / 打开数据目录 / 退出」
- Windows 10 可能把新图标收在任务栏右下角的 `^` 折叠区，可拖到任务栏常驻
- 数据仍存 `%USERPROFILE%\.qoderdaddy`（便携版与安装版通用同一数据目录）

fnOS / NAS 用户请用 **fpk** 包（见 DEPLOY.md）；两者功能一致，面板都在 `127.0.0.1:47860`。

## 开发

    npm test                                  # 运行测试（node --test，零依赖）
    npm start                                 # 启动守护进程
    cd desktop && npm install && npx electron .   # 本地运行桌面壳（直接使用仓库源码）

推送 / PR 会在 GitHub Actions 上跑测试（Ubuntu + Windows，Node 20 / 24）。
发版：同步修改 `package.json`、`desktop/package.json`、`fnos-packaging/manifest` 的版本号后打 `v*` tag。

## License

MIT
