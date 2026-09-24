# CreditDaddy

**AI 编程工具多账号本地管理 + 每日积分自动签到助手** —— 目前支持 **Qoder**（国际版 / 国内版）、**WorkBuddy**（腾讯 CodeBuddy 系，国内版 / 国际版）、**ZCode**（智谱 GLM / Z.ai），并可接入 **[10Router](https://github.com/techysy/10router)** 查看其他供应商的额度、同步本机用量。

> 项目原名 **QoderDaddy**，v0.3.0 起更名为 CreditDaddy：数据目录自动从 `~/.qoderdaddy` 迁移到 `~/.creditdaddy`（旧目录保留），
> 旧的 `QODERDADDY_HOME` / `QODERDADDY_PASSWORD` 环境变量与 QoderDaddy 导出文件仍可使用。

架构参考 [WorkDaddy](https://github.com/babygoton/WorkDaddy)（本地守护进程 + Web 面板 + 数据全留本机 + 仅监听 127.0.0.1），
签到能力移植自 [10router](https://github.com/techysy/10router) 的 qoderCheckin / codebuddyCheckin，并按 Qoder App 0.2.x、WorkBuddy 桌面端的真实协议补全。

## 功能

- **仪表盘 + 分产品标签页**：首页仪表盘汇总账号数、今日签到进度、剩余积分、下次自动签到，各产品概况、需要处理的账号（token 失效 / 即将过期、签到失败）与最近签到记录；Qoder / WorkBuddy / ZCode 各自一个标签页，卡片式账号列表（参考 WorkDaddy），可按国际 / 国内版筛选，显示签到状态、连签天数、剩余积分、积分包到期、token 有效期，支持亮色 / 暗色
- **10Router 集成**：配置 10Router 地址 + 虚拟 key（sk-…）后，「10Router」标签页渲染 10Router 里其他供应商（Claude / Codex / Kiro / GLM …）的额度卡片，额度告急 / 查询失败会进仪表盘「需要处理」；并内置 10router-sync 插件的用量同步能力，每小时把本机 ZCode / OpenCode / mirasim / 小米 MiMo 的用量导入 10Router 的用量统计
- **本机导入**：一键读取本机 Qoder / Qoder CN 客户端（本地解密 `auth.v1.dat`）与 WorkBuddy 客户端（当前 + 历史会话）已登录的账号，token 不出机器；同一用户 token 续期时自动更新
- **WorkBuddy / ZCode 账号切换**：一键把客户端切换到选中的账号（WorkBuddy 自动应用；ZCode 需先退出客户端），切换前先保全当前登录，绝不丢号，每个账号独立设备指纹
- **隐私（无痕）登录窗口**：桌面版内置一次性会话的登录窗口，网页授权不带出系统浏览器里已登录的账号、Cookie 也不落盘，适合同一产品登录多个账号
- **浏览器登录**：三条产品线都能在面板里直接登录新账号，授权后 token 自动入库 —— Qoder 设备码授权（PKCE + nonce，与官方 qodercli 同流程）、WorkBuddy / CodeBuddy（与 WorkBuddy 桌面端同一 state 轮询流程）、ZCode（客户端的 CLI 轮询流程，支持 BigModel 智谱 / Z.ai）；WorkBuddy / ZCode 浏览器登录的账号同样可以一键切换客户端
- **每日自动签到**：守护进程每 ~2 小时扫描一轮；当天已领的账号记忆跳过；"无可领活动"不记忆，每日积分刷新（10:00 UTC+8）后自动重试。"签到日"以 10:00 (UTC+8) 为界，与本机时区无关
- **国际版签到**：携带 Qoder 客户端生成的设备风控身份（见下文），与客户端内「每天领 100 Credits」一致
- **导入导出**：可设口令加密，格式与 10router 的 OAuth 迁移文件（`10router-oauth-secure-v1`）互通 —— 10router 导出的 Qoder / CodeBuddy 授权可直接导入（CodeBuddy 对应 WorkBuddy），CreditDaddy 的加密导出也能导入 10router
- **PAT 支持**：pt- 开头的 Personal Access Token 自动兑换短期 job token
- **Windows 桌面版**：托盘常驻、关窗不退出、开机自启（后台运行）、托盘一键签到并弹出结果
- **数据边界**：全部数据存 ~/.creditdaddy（0600 权限 + 原子写 + 进程内串行写入），无任何遥测、无第三方依赖
- **本机防护**：只监听 127.0.0.1，并校验 Host 头（防 DNS 重绑定）、拒绝跨站 Origin（防 CSRF），网页无法偷读或篡改本机账号

## WorkBuddy 说明

- **账号来源**：WorkBuddy 与 CodeBuddy CLI / 插件共用凭据目录 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\`（macOS `~/Library/Application Support/CodeBuddyExtension/…`，Linux `~/.local/share/CodeBuddyExtension/…`），
  `workbuddy-desktop.info` 是当前登录会话，带时间戳的同名文件是历史会话。登录 token 是 Keycloak JWT，按签发方区分：`codebuddy.cn` / `workbuddy.cn` / `copilot.tencent.com` → 国内版，`codebuddy.ai` / `workbuddy.ai` → 国际版
- **签到**：`POST {域名}/v2/billing/meter/checkin-activity-status` 查今日是否已签（已签不再请求），未签则 `POST …/daily-checkin`；国内版每日签到送积分并累计连签天数
- **积分**：`POST {域名}/v2/billing/meter/get-user-resource`，循环额度包（体验版月度额度）按本周期计，活动赠送包按剩余量与到期时间计
- **浏览器登录**：`POST {域名}/v2/plugin/auth/state?platform=WorkBuddy` 取授权地址，用户登录后轮询 `/v2/plugin/auth/token?state=`（11217 = 等待）拿 token，再轮询 `/v2/plugin/login/account?state=`（12151 = 等待）与 `/v2/plugin/accounts` 补齐账号信息，组装成与 `workbuddy-desktop.info` 同结构的会话；国内版走 www.codebuddy.cn，国际版走 www.codebuddy.ai
- **token 刷新**：只在 token 过期或接口返回 401 时用 refreshToken 刷新（`/v2/plugin/auth/token/refresh`）；若该账号正是 WorkBuddy 客户端当前登录的账号，会把新 token 同步写回客户端，避免客户端掉线。refreshToken 也失效时（如在别处登出），需要在 WorkBuddy 重新登录后再「本机导入」同步
- **切换账号**：写入 `workbuddy-desktop.info` 并清除登出标记，WorkBuddy 监听该文件并自动应用；切换前会先把客户端当前会话的最新 token 保存到 CreditDaddy
- 国际版（workbuddy.ai / codebuddy.ai）的签到接口沿用同一路径，尚未经真实账号验证

## ZCode 说明

- **账号来源**：ZCode 桌面客户端把当前登录存在 `~/.zcode/v2/credentials.json`（值用客户端私有的 `enc:v1:` AES-256-GCM 加密，密钥从机器信息派生），CreditDaddy 本地解密读取，token 不出机器
- **浏览器登录**：与客户端的 CLI 轮询登录同一协议 —— `POST https://zcode.z.ai/api/v1/oauth/cli/init`（本地随机 poll token）拿授权地址（回调指向 zcode.z.ai 服务端，无需 `zcode://` 协议，任何浏览器都能用），用户登录后轮询 `/api/v1/oauth/cli/poll/{flow_id}`；Z.ai 账号再用 `api.z.ai/api/auth/z/login` 换业务 token。拿到的凭据按 `credentials.json` 格式用本机密钥加密保存，可直接切换到 ZCode 客户端
- **没有每日签到，支持活动领取**：ZCode 积分靠「活动领取」（billing/preview → billing/claim）。点卡片上的领取按钮，弹窗列出当期活动并可领取 —— 领取时面板会跑阿里云验证码（先静默验证，触发风控时弹出验证码手动完成，任何浏览器环境都能用），故不做后台无人值守的自动签到
- **客户端版本跟随本机**：billing 类接口校验客户端版本（过低直接 3001），请求头里上报的版本取本机已安装 ZCode 的版本（Windows 注册表读取），没有客户端时用兜底值
- **出口可切换**：ZCode 上游请求默认「直连优先、代理兜底」，标签页提示条里可切「代理优先、直连兜底」（代理取 `HTTPS_PROXY` 环境变量，http 代理 + CONNECT 隧道，纯 Node 内置实现；`NO_PROXY` 与 loopback 始终直连）
- **额度展示**：查询 BigModel Coding Plan（quota/limit + subscription/list）与 Z.ai / Start Plan（billing/balance）；balances 为空时从生效套餐的权益派生展示额度（未到生效时间的权益显示「xx 生效」）；无有效套餐时显示「仅免费额度」
- **账号切换**：写回 `credentials.json` / `config.json`，并为每个账号写入独立的设备 ID（`telemetry-state.json` 的 deviceMid），避免账号间被风控关联；需先退出 ZCode 客户端（运行中会覆盖回内存里的旧登录）。切换前当前登录会先保存进 CreditDaddy，不会丢号
- 协议移植自 [zcode-switch](https://github.com/pjpv/zcode-switch)（MIT）

## 10Router 集成

在面板「10Router」标签页填 10Router 的访问地址和仪表盘里创建的 **虚拟 key**（sk-…），key 只保存在守护进程数据目录的 `tenrouter.json`（0600，不随账号导出），面板只显示脱敏值。

- **供应商额度卡片**：读取 10Router 的 `GET /api/usage/quotas`（**10Router 1.2.1+**），一次拿到全部可查额度的供应商连接，口径与 10Router 仪表盘的 Provider Limits 一致；剩余不足 10% 标红并进入仪表盘「需要处理」。10Router 端按连接缓存 5 分钟，「刷新额度」会强制重查。老版本 10Router 会提示升级，用量同步不受影响
- **用量同步**（同 10router-sync 插件 `export-usage.mjs`，行结构逐行一致）：ZCode `~/.zcode/cli/db/db.sqlite`（只导出官方 `builtin:` / `account:` 渠道）、OpenCode `~/.local/share/opencode/opencode.db`、mirasim `~/.mirasim/insights/usage-*.ndjson`（跳过经 10Router 中转的调用）、小米 MiMo `mimocode.db`，POST 到 10Router 的 `/api/settings/database/import-usage`（10Router 1.0.7+，服务端按行签名去重）。每个来源记住已同步到的时间，之后只发新行（回退 2 天重叠兜底）；可开启每小时自动同步，也可手动「同步用量」
- 读取 SQLite 需要 Node 22.5+ 内置的 `node:sqlite`（桌面版自带；fnOS 依赖 nodejs_v24）；数据库先复制到临时目录再读，不碰客户端正在写的文件

## Qoder 国际版签到说明（重要）

实测 Qoder 国际版服务端只向**携带设备风控身份**（`Cosy-MachineToken / Cosy-MachineCode / Cosy-MachineType`）的请求下发「每天领 100 Credits」活动；不带时只返回推广活动，这也是旧版本（以及 10router）国际版一直"无可领活动"的原因。

- 风控身份由 **本机 Qoder 客户端自带的 `resources/umid/runtime-info`** 生成，CreditDaddy 直接调用它（每 50 分钟刷新），因此**国际版签到需要本机安装 Qoder 客户端**（无需保持登录、无需打开）
- **每台设备每天只能有一个国际版账号领取**（服务端按设备限领）。本机已有账号领取后，其余国际版账号显示「本机已领」并当日不再请求；账号列表中靠前的账号优先领取
- 国内版不需要风控身份，所有账号都能领取
- **fnOS / NAS（Linux，无 Qoder 客户端）**：在面板 Qoder 页一键安装「设备身份组件」（或 `creditdaddy umid install`）—— 从 npm 官方包 `@qoder-ai/qodercli` 下载（校验 npm 完整性），取出其内置的 Linux x64 / arm64 UMID 程序，参数与 qodercli 一致（国际版 env=4），之后 NAS 也能签到国际版；NAS 是独立设备，同样每天限领一个国际版账号。CreditDaddy 不分发该二进制

## 快速开始

需要 Node 18+，零依赖：

    node bin/creditdaddy.js daemon        # 启动守护进程，打开 http://127.0.0.1:47860

CLI 用法：

    node bin/creditdaddy.js scan                    # 导入本机 Qoder / WorkBuddy / ZCode 客户端已登录的账号
    node bin/creditdaddy.js add <token>             # 添加 Qoder 国际版账号
    node bin/creditdaddy.js add <token> --cn        # 添加 Qoder 国内版账号
    node bin/creditdaddy.js add <token> --workbuddy # 添加 WorkBuddy 国内版账号（--intl 为国际版）
    node bin/creditdaddy.js add <token> --name 工作号
    node bin/creditdaddy.js list                    # 查看账号
    node bin/creditdaddy.js checkin                 # 立即签到全部
    node bin/creditdaddy.js checkin --cn            # 只签 Qoder 国内版（--intl 只签国际版）
    node bin/creditdaddy.js checkin --workbuddy     # 只签 WorkBuddy
    node bin/creditdaddy.js remove <id前缀>          # 删除账号
    node bin/creditdaddy.js export backup.json --password 口令   # 加密导出（10router 可导入）
    node bin/creditdaddy.js export backup.json      # 明文导出（含明文 token）
    node bin/creditdaddy.js import backup.json [--password 口令] # 导入 CreditDaddy / 10router 导出文件
    node bin/creditdaddy.js umid install            # Linux / fnOS：安装 Qoder 设备身份组件（国际版签到用）
    node bin/creditdaddy.js help                    # 帮助

## 导入导出格式

加密文件与 10router `src/lib/auth/secureTransfer.js` 完全一致：

    { "format": "10router-oauth-secure-v1", "kdf": { "alg": "scrypt", "N": 16384, "r": 8, "p": 1, "keyLen": 32, "salt": "…" },
      "cipher": "aes-256-gcm", "iv": "…", "tag": "…", "payload": "…" }

解密后的载荷：`{ provider, exportedAt, accounts: [{ provider, name, email, uid, accessToken, refreshToken, expiresAt, providerSpecificData }] }`。
导入 10router 文件时取 qoder / qoder-cn / codebuddy-cn / codebuddy-intl 账号（后两者映射为 WorkBuddy）；10router 按提供商导入，混合导出时建议按单个版本导出。

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
    GET    /api/accounts/:id/quota      积分（统一结构 total / used / remaining / parts）
    POST   /api/accounts/:id/switch     切换 WorkBuddy / ZCode 客户端到此账号
    GET    /api/accounts/:id/zcode/plans   ZCode 可领取活动列表
    POST   /api/accounts/:id/zcode/claim   ZCode 领取活动 {planId, captchaParam?, region?}
    GET    /api/zcode/captcha-config       ZCode 领取验证码配置
    POST   /api/checkin                 全部签到 {provider?, product?, skipIfCheckedToday?}（默认跳过今日已签）
    POST   /api/auth/device/start       发起浏览器登录 {provider: qoder / qoder-cn / workbuddy / workbuddy-intl / zcode-bigmodel / zcode-zai}
    POST   /api/auth/device/poll        轮询登录结果 {sessionId}
    GET    /api/local/detect            检测本机 Qoder 客户端 / WorkBuddy 凭据目录 / 旧版 IDE / CLI
    POST   /api/local/scan              读取本机已登录账号（Qoder + WorkBuddy + ZCode）
    POST   /api/local/import            导入扫描候选 {candidateId, provider?}
    GET    /api/status                  状态（版本、调度器、风控身份是否可用）
    GET    /api/tenrouter               10Router 集成配置（key 脱敏）；PUT 保存 {endpoint, key?, syncEnabled?, sources?}；DELETE 断开
    POST   /api/tenrouter/test          测试地址与 key {endpoint?, key?}
    GET    /api/tenrouter/quotas        10Router 其他供应商额度总览（?force=1 跳过缓存）
    GET    /api/tenrouter/health        10Router 自身健康（ok / driver / lastDriverError，驱动降级有提示）
    POST   /api/tenrouter/sync          立即同步本机用量到 10Router {dryRun?}
    GET    /api/qoder/umid              Qoder 设备身份组件状态（Linux / fnOS）
    POST   /api/qoder/umid/install      下载官方 qodercli 并提取设备身份组件
    GET    /api/logs                    日志
    POST   /api/export                  导出 {password?, provider?, product?}
    POST   /api/import                  导入 {data, password?}

设置环境变量 `CREDITDADDY_PASSWORD` 后，所有 /api/* 需要 `x-qd-key` 头（fnOS 部署自动启用，密码在安装向导里设置、「应用设置」里可改）。面板遇到密码缺失或错误会弹框要密码并自动重试该请求。

## 签到状态说明

| status | 含义 | 当日记忆 |
|---|---|---|
| checked-in | 领取成功，含金额 | ✓ 记忆，今天不再重复请求 |
| already | 有积分活动但已领过 | ✓ 记忆 |
| limited | 国际版：本机今日额度已被其他账号领取 | ✓ 记忆 |
| no-activity | 当前无可领活动（可能窗口未开） | ✗ 下轮重试 |
| failed | 鉴权失败 / 网络错误等 | ✗ 下轮重试 |

> ⚠️ 非官方接口，Qoder / WorkBuddy / ZCode 调整服务端时可能失效。请遵守平台服务条款，仅管理自己的账号。

## 目录结构

    bin/creditdaddy.js    CLI 入口
    src/constants.js     端点与请求头常量（版本号取自 package.json）
    src/qoderClient.js   Qoder OpenAPI 客户端（签到核心）
    src/qoderApp.js      本机 Qoder 客户端集成：安装探测、设备风控身份、safeStorage 解密
    src/qoderUmid.js     Qoder 设备身份组件（Linux / fnOS：从官方 qodercli 提取 UMID）
    src/tenrouter.js     10Router 集成：配置、额度总览、用量同步调度
    src/usageSync.js     本机 ZCode / OpenCode / mirasim / MiMo 用量读取（同 10router-sync 插件口径）
    src/providers.js     产品线注册表：按 provider 分发签到 / 积分 / 校验
    src/workbuddyClient.js  WorkBuddy API：签到、积分、token 刷新
    src/workbuddyLocal.js   本机 WorkBuddy 会话读取与账号切换
    src/zcrypto.js          ZCode 本机凭据加解密（enc:v1: AES-256-GCM）
    src/zcodeClient.js      ZCode 额度查询 + 活动领取（billing preview/claim、验证码配置）
    src/zcodeLocal.js       本机 ZCode 凭据读取与账号切换
    desktop/preload.js      桌面版 preload：暴露隐私登录窗口能力
    src/checkin.js       调度器（2h tick + 当日去重 + 本机限领 + 串行执行）
    src/accounts.js      账号新增 / 导入 / 续期的统一入口
    src/transfer.js      导入导出（10router 迁移格式互通）
    src/authDevice.js    浏览器登录统一入口（Qoder 设备码 PKCE + 分发 WorkBuddy / ZCode）
    src/workbuddyAuth.js WorkBuddy / CodeBuddy 浏览器登录
    src/zcodeAuth.js     ZCode 浏览器登录（BigModel / Z.ai）
    src/localDetect.js   旧版 IDE / CLI token 扫描
    src/daemon.js        本地 HTTP API + 面板托管
    src/panel.html       Web 管理面板
    src/store.js         本机存储（原子写 / 0600 / 串行读改写）
    src/logger.js        环形缓冲日志
    test/                冒烟测试
    desktop/             Windows 桌面版（Electron 壳）
    fnos-packaging/      fnOS fpk 打包

## Windows 桌面版（Electron 壳）

Releases 下载 **CreditDaddy-Setup-x.y.z.exe**（安装版）或 **CreditDaddy-Portable-x.y.z.exe**（免安装）：

- 打开即用：内置 Node daemon，无需单独安装 Node.js
- 关闭窗口 = 隐藏到托盘，**后台自动签到不中断**；单击托盘图标打开面板，右键菜单可「立即签到 / 开机自启 / 打开数据目录 / 项目主页 / 退出」
- Windows 10 可能把新图标收在任务栏右下角的 `^` 折叠区，可拖到任务栏常驻
- 数据存 `%USERPROFILE%\.creditdaddy`（便携版与安装版通用同一数据目录）
- 从 QoderDaddy 升级：CreditDaddy 是新的应用 ID，会与旧版并存安装；首次启动自动迁移数据，确认无误后请在「应用和功能」卸载 QoderDaddy，避免两个程序同时签到

fnOS / NAS 用户请用 **fpk** 包（见 DEPLOY.md，分**标签页版** `creditdaddy-*.fpk` 与**窗口版** `creditdaddy-window-*.fpk`）；功能与桌面版一致，面板端口都是 47860。

## macOS 桌面版

Releases 下载 **mac-CreditDaddy-x.y.z-arm64.dmg**（Apple Silicon）或 **mac-CreditDaddy-x.y.z-x64.dmg**（Intel），另有同名 zip。拖入「应用程序」即可，功能与 Windows 桌面版一致（托盘常驻、内置 daemon、数据存 `~/.creditdaddy`）。未签名：首次打开在「系统设置 → 隐私与安全性」里放行。⚠️ macOS 版由 CI 构建，未在真机验证，问题请提 Issue。

## npm 包（Node ≥ 20）

```bash
npm install -g creditdaddy   # 全局安装
creditdaddy daemon           # 启动守护进程 + 面板（127.0.0.1:47860）
```

适合 fnOS / Linux / macOS 上只想跑 daemon + 面板的场景（fpk 之外的另一条路）。核心零依赖，bin/src 原样打包。

## 开发

    npm test                                  # 运行测试（node --test，零依赖）
    npm start                                 # 启动守护进程
    cd desktop && npm install && npx electron .   # 本地运行桌面壳（直接使用仓库源码）

推送 / PR 会在 GitHub Actions 上跑测试（Ubuntu + Windows，Node 20 / 24）。
发版：同步修改 `package.json`、`desktop/package.json`、`fnos-packaging/manifest` 的版本号后打 `v*` tag。

## License

MIT
