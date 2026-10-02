# 变更日志

本文件为 CreditDaddy 完整开发与版本变更日志，按版本从上往下排列。

---

## [1.3.0] (2026-10-02)

### ✨ 新功能

- **ZCode 体验包接口局域网改 IP 白名单免密直连**：局域网开放开关 + IP 白名单（每行一个，支持 `192.168.31.*` 通配）收进体验包接口设置弹窗，打开时默认预填 10Router 服务地址的主机。白名单内机器（如 10Router 所在机器）免密直连 `/gateway/v1/messages`——zcode-free 本就是 10Router 侧免授权供应商，不再被迫走虚拟 key；白名单外的局域网请求仍可用「10Router 连接设置」的虚拟 key 鉴权，本机回环始终放行。绑定改动仍需重启生效
- **ZCode / 10Router 状态区分区整理**：ZCode 页顶部的开关从一整条挤成两行改为四个功能分区（活动领取 / 网络出口 / 体验包接口 / 客户端），每组一行带分组标签；10Router 页状态条由随意换行的一长条改为「连接」（地址 · key 掩码 · 同步策略）与「状态」（上次同步 · 额度更新）两行
- **ZCode 设置入口收进顶栏、操作全面弹窗化**：「自动领取 / 出口 / 接口（·局域网）」按钮组放到「添加账号」左侧（桌面版另有「打开客户端」），点开都是弹窗——自动领取（周期 / 时长）、网络出口（直连/代理顺序单选 + 代理地址，一次保存；代理框只以 placeholder 显示脱敏地址不再回填，留空 = 清除）、体验包接口（总开关 + 局域网开放 + IP 白名单同弹窗，总开关关闭时局域网选项联动置灰）。顶部横幅回归纯信息文案（活动领取口径、出口与代理、接口调用统计、客户端状态），不再夹按钮；修掉旧代理弹窗把脱敏地址当真实值回填、回存后密码变成 `****` 的隐患
- **「自动签到」口径进全局设置 + 业务日按产品刷新时点区分**：面板设置弹窗新增「自动签到」说明区（调度周期、下次执行时间、各产品业务日口径、ZCode 自动领取状态）。签到记忆「今日已领」此前统一按 Qoder 的 10:00 (UTC+8) 翻日，导致 WorkBuddy 这类 0 点刷新的产品在 0–10 点间口径错位；现按产品区分——Qoder 10:00、其余产品（WorkBuddy / mirasim 等）00:00，记忆写入与比对、过期清理均按各自口径
- **ZCode 自动领取计划可配置**：面板「自动领取」改为弹窗设置，轮询周期（1–720 分钟，默认 2）与单次运行时长（0 = 一直运行直到手动关闭，或 5–1440 分钟，默认 60）由用户自己决定，配置落 `zcode-net.json`。此前固定「每 2 分钟 × 最多 1 小时」，活动包若在时段结束后才放出（实测每日 0 点左右刷新）就会错过当次领取、只能手动补领；现在把运行时长设为 0 或让时段跨过 0 点即可覆盖。顺带修复时段到期自动关闭后面板开关仍显示「开」的问题（30 秒轮询补上 `loadZNet`）
- **接入 Trae（字节 TRAE SOLO / Trae CN）作为第 6 条产品线**：本机导入 + 额度查询 + 每日签到领积分 + 一键切换登录账号。凭据直接解本机客户端 `<userData>/User/globalStorage/storage.json` 的 `iCubeAuthInfo://icube.cloudide`（Trae 自研「tc」信封：pepper 为随安装包分发的公开常量表，SHA512 两轮派生 + AES-128-CBC + SHA512 完整性前缀），纯 `node:crypto` 实现，不引入依赖、不需要 SQLite。切换按账号存 15 项登录态快照到 `~/.creditdaddy/trae-slots/<uid>/`，换走前先自动快照当前登录避免丢号，客户端在跑时拒绝切换（Trae 会把内存里的旧登录写回文件），强制切换后自动重新拉起。
- 风控口径：`x-device-id` 必须为纯数字设备号（传 GUID 触发 `code 9074`），优先取 `storage.json` 里 `iCubeAuthInfo://icube-dc:<数字>` 的键名后缀以与 IDE 自身指纹一致，缺失时按 uid 确定性派生。
- 有意**不做自动续期**：Trae 的 refresh 会轮转 refreshToken 并作废 IDE 自己那份，等于把用户正在用的客户端踢下线；面板改为显示凭据到期日并在临期变红。
- **给 Qoder 补上一键切换登录账号**（此前仅 WorkBuddy / ZCode / mirasim / 妙手 支持）：把 `auth.v1.dat` 解密后的整份 JSON 存进账号 meta，切换时用同一 DPAPI 密钥重新加密写回并留 `.bak`。Qoder 正在运行时报 409，面板可选「关闭并强制切换」代为结束进程再写入（早期版本按「AI 会话挂在 Qoder 内」的老前提禁止强退；会话迁到 Kimi 后该约束已不存在）。存量账号缺快照时由 status 轮询自动回填本机当前登录的整份 auth，无需重新导入
- **Qoder 客户端当前检测**：`/api/status` 补 `qoderCurrent`（国际 / 国内分开）与 `qoderClient`，当前登录账号显示「客户端当前」角标并隐藏其切换按钮（此前 Qoder 是唯一没有当前检测的产品线）

### 🐛 修复

- **Trae 页面残留通用产品线 UI**：Trae 不分国际 / 国内版，产品页顶部不再显示「全部 / 国际版 / 国内版」筛选；「添加账号」弹窗不再显示「粘贴 Token」标签页（Trae 凭据只能从本机客户端 storage.json 解密，不支持贴 Token）
- **ZCode 数据目录挪盘后一直读到陈旧凭据**：上游只找 `~/.zcode/v2/credentials.json`，而 ZCode 支持把数据目录整体挪盘，真实位置记在 `~/.zcode/v2/setting.json` 的 `dataBaseDir` 里（口径对齐 pjpv/zcode-switch 的 `resolve_data_root`）。此前后果是面板永远显示挪盘前的旧账号、点切换还被误判成「已是当前账号」而什么都不做。加密密钥仍按 home 派生，不随数据目录挪动。
- **#13** 10Router 地址兼容 LLM 客户端风格的 `/v1` 后缀：从 LLM 客户端复制的 base URL 常带 `/v1`，原样保存后 `/api/*` 调用全部落空，404 被误判成 TOO_OLD、提示「需要 1.2.1+」误导用户去升级。现在 test/save 统一出口剥离尾部 `/v1`（及多余斜杠），`normalizeEndpoint()` 兜底自愈已保存的坏配置，历史配置无需重存、请求前即剥离；地址输入框 placeholder 注明「站点根地址，不要带 /v1」。

---

## [1.1.1] (2026-10-01)

### 🐛 修复

- **#11** 主题跟随系统：面板未手动锁定主题（localStorage 无记录）时实时跟随系统亮暗切换；Electron 窗口背景色按 `nativeTheme` 取暗色（`#0a0a0c`），消除暗色系统下启动 / 调整窗口大小时的白闪
- **#12** ZCode 领取报 3001：`fetchClaimPlans` / `claimPlan` / `billing/balance` 补 `X-Device-Mid` 设备指纹头（沿用账号 meta 的 deviceMid，没有则生成并落盘，与桌面客户端行为一致）；`client/configs` 公开端点去掉空 `Authorization: Bearer` 畸形头；客户端版本兜底 3.11.2 → 3.14.3（新活动要求 ≥ 3.14.3）

### 🔧 改进

- ZCode 体验包接口上游错误友好化：HTML 错误页提取 `<h1>` 标题、JSON 错误提取业务码与消息、纯文本截断展示，日志不再是整页 HTML 或裸 JSON；JWT 失效日志由 warn 降为 info

---

## [1.1.0] (2026-10-01)

### 🐛 修复

- 10Router 页「全部」供应商汇总卡对齐新配额形态：非包行按名称归并求和（此前只按首个连接的主行名取值，其余连接主行名称不同会被静默丢行——Qoder CN 曾把 2,600 的资源包汇总成 800）；识别 10Router 新版逐包明细标记（detailOnly / summarizesDetail：汇总行已含包行数值），供应商级聚合跳过明细行不重复计数，老版本无标记照常兼容；「积分包×N 剩 X」简讯两种形态都保留

### ✨ 新功能

- 桌面版内置密码管理器（与 10Router 桌面壳同款）：无痕登录窗口遇到账号密码表单弹「保存密码？」询问，下次登录自动填充（站点恰好一条时聚焦回填，多账号右键显式选）；托盘「已保存的密码…」管理窗支持手动添加 / 改名 / 显示 / 复制 / 两步删除。库文件 userData/passwords.json 只落 safeStorage（Windows=DPAPI 绑当前用户）密文，加密不可用即整功能停用、绝不落明文；面板主窗（导出口令等输入框）刻意不注册为容器，口令不会被误存。

- 同步账号到 10Router 时随加密通道带上 Qoder 网页会话（providerSpecificData.creditDaddyWebSession，含 userId 归属校验）：10Router 的 Qoder 额度从「campaign 近似推算逐包」升级为网页端真实逐资源包明细（每包精确 used / 到期时间）；无会话时 10Router 维持原近似，行为不变。回导入 CreditDaddy 时该会话自动恢复到 meta，双向闭环

- Qoder 逐资源包用量明细：网页端「用量明细」接口（`/api/v2/me/usages/big_model_credits`）上线后，桌面版登录窗口关闭前自动抢救 qoder.cn / qoder.com 的会话 Cookie（httpOnly，只有 Electron session API 能读），按响应里的 `user_id` 归到对应账号；额度查询把「附加额度」聚合值展开为每个资源包一条（名称按来源区分 获赠 / 购买 / 组织，各自到期时间进进度条与「N 于 X 到期」提示）。会话失效自动清除并回落聚合数据；无会话（fnOS / 未走过登录窗口）行为不变

---

## [1.0.1] (2026-09-30)

### 🐛 修复

- 桌面版「检查更新」报错修复：v1.0.0 的 release 资产里没有 latest.yml（自动更新功能晚于 v1.0.0 打包才上线），electron-updater 按最新 release 找元数据必 404。electron-updater 失败时改为直查 GitHub Releases API 的兜底通道（zcode/qoder 式更新：比版本号 → 下载 CreditDaddy-Setup-*.exe、按 SHA256SUMS-desktop.txt 校验 → 运行安装程序），托盘菜单与后台静默检查同步接入；后续 release 即使再漏传 latest.yml 也不会断更新。发布 v1.0.1 后，线上 v1.0.0 安装版即可恢复正常自更新
- **#7** 保存 10Router 设置时带上面板密码（原先只在点「同步账号」时发送，保存后密码丢失，同步退回 apikey 通道被 10Router 拦 401；10Router 侧守卫问题见 techysy/10router#38）
- **#5** mirasim 本机导入支持新版密钥 `%APPDATA%\@mirasim\desktop\secret-key.enc`（Electron safeStorage v10）；读不到密钥时明确列出检查过的位置，「解密失败」与「未登录」分开提示；CLI `scan` 打印跳过原因
- **#6** WorkBuddy 国际版浏览器登录改走 `www.workbuddy.ai`（原 `www.codebuddy.ai` 是 CodeBuddy 国际站）；token 识别补 `workbuddy.cc`
- **#4** 探测 Qoder 0.3+ 的 `.qoder-versions\<版本>\resources`、`Program Files (x86)`、卸载注册表里的自定义安装目录，兜底 qodercli 解压的 `runtime-info.exe`；上报实际运行版本
- ZCode 体验包接口：空队列 503 按 耗尽 / 冷却 / 拉黑 / 缺 token 分类说明，额度耗尽不再提示「重新登录导入」；额度查询失败不再误标耗尽；同一请求内已打标账号不重打

### ✨ 新功能

- 领取成功后清除接口的额度耗尽标记（原先要等打标 10 分钟 / 冷却 30 分钟才回轮换），面板约 30 秒内即时刷新对应账号额度
- 用量同步新增「10Router 本机」来源（移植 10router-sync 插件 `--source 10r`）：本机 10Router 实例自己记的账（含 zcode-free 经其中转的行）同步到聚合端；同实例防护、gatewaySync 标记、无时间戳行跳过；来源版本 2→3，已有配置自动并入
- 桌面端自动更新（Windows 安装版）：启动 30 秒后与每 6 小时静默检查 GitHub Releases，后台下载、退出时自动安装；托盘菜单可手动检查、一键重启更新。Portable / macOS（未签名）继续手动下载

### 💄 界面

- 体验包接口的轮换账号徽章挪到账号卡片（「接口使用中」，靛蓝，与「客户端当前」区分）；接口统计随状态轮询 30 秒刷新，不再停留在打开页面时的快照
- 「额度网关」改名「体验包接口」、「网关当前」改名「接口使用中」，相关悬停说明同步更新
- 仪表盘「剩余积分」读取期间显示 …（不再显示部分合计来回跳动）；「今日领取 / 活跃」「领取（国内）」「活跃（国际）」加悬停口径说明
- 额度进度条统一用健康语义色（浅色 / 深色主题都是绿色），不再随主题强调色变化
- 10Router 页「体验包接口」状态行收紧为紧凑横条；「没有可汇总的额度」空卡片不再被拉伸到和正常卡一样高

---

## [1.0.0] (2026-09-29)

### ✨ 新功能

- **ZCode 免费额度网关（Start Plan 体验包 → 本地补全端点）**：
  - **数据面** `POST /gateway/v1/messages`（Anthropic `/v1/messages` 形态）：10Router 建一个 anthropic-compatible 自定义节点指向 `http://127.0.0.1:<端口>/gateway`，即可把 Start Plan 体验包（GLM-5.3-Flash）当普通供应商调度；SSE 流式原样透传。
  - **验证码复用**：补全与「活动领取」共用同一个桌面版隐藏窗口求解器（真 Chromium 静默过阿里云验证码，8 秒未过弹人工）；token 缓存 30 秒摊薄求解开销，被服务端拒（3007/3012）即作废重解。
  - **账号轮换与失败分类**：所有 provider=zcode 且快照里有 zcodejwttoken 的账号参与轮转；401（JWT 失效）拉黑、402/1113（额度不足）跳过半小时、429 冷却 5 分钟，全败返回 502 + 各账号结论汇总；凭据永不回传面板。
  - **面板开关**：ZCode 页新增「额度网关：开/关」（设置持久化），开启后卡片显示本机端点地址；纯 CLI / NAS 环境无验证码提供者，开关给出明确说明。
  - `fetchJsonRace` 支持调用方 AbortSignal 合并（流式转发可随客户端断开中止上游）。
  - 单测 `zcode-gateway.test.js` 7 例（开关门 / 无提供者 / 无凭据账号 / SSE 透传与 token 缓存 / 3007 重解换号 / 401 拉黑与额度跳过 / 方法提示），全仓 109 例绿。

  - **实测打通（09-29）**：CreditDaddy 账号 JWT 直接注入 zcode-api（凭据文件 AES-GCM 本机派生 key 可离线构造，免 auth login），`--cli serve` 起服后补全 **HTTP 200**——体验包（GLM-5.3-Flash）经其求解器可消费；「客户端当前」账号返回 1005（客户端会话占用），非当前账号正常。面板开关 / 轮换 / 局域网鉴权全部就绪。

- **接入美团「妙手」（CatPaw）产品线：额度 / 版本 / 用户信息 + 本机切号**：
  - **桌面客户端凭据解密**：自动定位 `%APPDATA%\catpaw-moon\catx-credential.json`，其 `ssoTokenEnc` 为 AES-256-GCM 密文（`iv‖tag‖ciphertext` base64），密钥由本机 `HKLM\...\Cryptography\MachineGuid` 派生（`sha256(machineId + ":catpaw-desk-token-v2")`），全程内存计算、不改动客户端存储格式即可读写。
  - **桌面网关直连**：额度 / 套餐版本 / 用户信息走 `https://catx.nocode.cn/api/gateway/*`（`auth/current-user` + `credit/balance`，token 置于 `X-Auth-Token` 头）——网页端 `credit.catpaw.meituan.com` 的三个接口只认浏览器 Cookie，daemon 不可用，网关路径为纯 token 鉴权，实测可用。
  - **统一配额结构**：可用 Credits 余额 + 当前套餐（体验版 / 专业版，`planName` 缺失按 `pro` 兜底）+ 套餐到期 / 下次刷新时间；Credits 无总量口径，与 ZCode / mirasim 一样不计入面板「剩余积分」合计。
  - **本机导入与切换**：`/api/local/detect` 报告妙手安装 / 登录 / 运行状态，`creditdaddy scan` 与面板「添加账号 → 本机导入」抓取当前登录（网关补全 uid / 昵称 / 手机号）；切号 = 重写加密凭据 + 重启妙手客户端（客户端无热加载），运行中默认拒绝并给出 409 `CATPAW_RUNNING`，强制切换自动 taskkill 退出并重新拉起；切换前把当前登录同步进账号库防丢号。
  - **凭据失效引导**：妙手没有对外 refresh 接口，401 / 「登录失效」统一提示在妙手客户端重新登录后再本机导入；面板妙手页说明「按套餐发放 Credits、无每日签到」。
  - **全端界面适配**：导航栏 / 仪表盘新增「妙手」产品卡（Credits 余额 + 套餐版本，客户端未导入账号时的当前登录提示），组件开关、导出范围（`p:catpaw`）、`CLIENT_LABEL` 状态芯片、深色模式配色一并接入。

- **面板访问密码搬进右上角「设置」弹窗，可直接开启 / 修改 / 关闭**：
  - 顶栏齿轮图标由原「面板组件」下拉升级为「面板设置」弹窗：一节 **面板访问密码**（状态徽章 + 开启 / 修改密码 / 关闭按钮），下接原有组件显隐排序与账号卡片排序区。
  - 密码持久化在数据目录 `settings.json`（新增 `GET/PUT /api/settings`，响应只回 `panelKeyEnabled` 布尔，不回显密码）；开启后所有 `/api/*` 需 `x-qd-key` 头，面板 401 时自动弹框要密码并重试请求。
  - 环境变量 `CREDITDADDY_PASSWORD`（fnOS 安装向导 / 命令行部署注入）保持兜底优先：`settings.json` 未设或被面板关闭时回退 env，保证 NAS 部署密码始终有效；此类部署下面板内「关闭」会如实提示无法关闭。
  - 关闭访问密码需二次确认（提示局域网 / 公网暴露风险）；关闭后清掉面板本地缓存密钥。桌面版托盘「立即领取」实时读取当前密码（`getPanelKey()`），面板内改密不中断托盘领取。

### 🔒 安全加固

- **账号导出强制加密，移除全部明文导出路径**：
  - `transfer.exportAccounts` 不再接受无口令调用（新错误码 `PASSWORD_REQUIRED`），产物一律为 10router 兼容的 `10router-oauth-secure-v1` 信封（scrypt N=16384 + AES-256-GCM，口令至少 4 位）。
  - 面板导出弹窗口令必填（文件名固定带 `.secure`）；`/api/export` 对缺失 / 过短口令直接 400；CLI `creditdaddy export` 无 `--password` 时拒绝执行并给出用法；导出文件可直接在 10router 或本面板导入。

---

## [0.9.5] - 2026-09-27

> 本版主题：**全面集成 mirasim 产品线（用量 / 额度 / 账号切换）+ ZCode 双套餐体系与客户端切号闭环 + 全局组件开关 + 杀软误报根治与安全审计**。

### ✨ 新功能

- **全面集成 mirasim（原生 AI 编程开发环境）产品线**：
  - **凭据本地安全解密**：自动定位 `~/.mirasim/setting.json` 与 `~/.mirasim/secret.key`。针对 Windows 平台使用 DPAPI 解开十六进制 master key 密文（抽取 UTF-16LE 字节流获取 64 位密钥），配合 AES-256-GCM 原生还原 `mrs1:` 密文（12 字节 IV + 16 字节 tag）。全流程内存计算，敏感 Token 绝不出机。
  - **用户资料与套餐识别**：对接 `GET https://auth.mirasim.ai/auth/me`，自动拉取当前账号主体（UID / 邮箱 / 昵称 / 角色）以及套餐等级（Pro / Plus）和到期时间（`plan_exp`）。
  - **平台额度（5h / 7d 滚动窗口）查询**：对接 `GET https://relay.mirasim.ai/v1/limits`，解析「5小时滚动窗口」、「7天全局窗口」以及分模型上限（Claude、Fable 等）的实时预算、已用量与精确重置时间戳。
  - **区域受限网络自动回退**：`relay.mirasim.ai` 对中国大陆 IP 直连实施区域封控并返回 HTTP 429（`shared_quota_unavailable`）。mirasim 客户端接入统一出口 `fetchJsonRace`，优先调度本机配置的 HTTP 代理（`HTTPS_PROXY` 或面板专属代理），保障国内网络环境下额度实时拉取不断流。
  - **客户端无损切号与热唤醒**：切换账号时原子更新 `~/.mirasim/setting.json` 的 `auth` 节点，**完整保留**用户的 `workspaces`、`models`、`connectors` 等全部配置。切号前自动同步当前在线 Token 进账号库防丢号；桌面版（Electron）切号后自动通过本地可执行文件探测重新拉起 Mirasim 客户端，实现平滑免干预换号。
  - **Token 自动静默续期**：mirasim 的 access_token 约 1 小时过期。额度查询遇 401 时自动用 refreshToken 换新（refreshToken 会轮换，两者一并保存），经 `ctx.onRefresh` 回写账号库，并在该账号正是客户端当前登录时把新凭据加密同步回 `setting.json`，杜绝「积分读取失败：登录凭据已过期」，客户端也不会因 Token 轮换掉线。
  - **全端界面与 CLI 适配**：首页仪表盘增加 mirasim 状态卡（展示套餐级别、有效性及客户端当前登录）；产品标签页支持各窗口使用率条形图与重置倒计时；`creditdaddy scan` 命令与面板「本机导入」自动解密扫描 mirasim 候选账号；标签页提示明确「切号需至少两个已导入账号（当前登录 + 目标）」的操作前提。

- **面板右上角新增全局「组件开关」（偏好本地持久化）**：
  - 在顶栏右侧新增调节图标入口，弹出「面板组件」菜单，支持独立勾选 **Qoder / WorkBuddy / ZCode / mirasim / 10Router**。
  - 取消勾选后：导航栏标签即时隐藏、仪表盘对应产品卡同步收起、「需要处理」与「最近记录」不再混杂被隐藏组件的告警与日志；直接通过 `#zcode` 或 `#mirasim` 等 Hash 访问已收起的页面时自动安全回落至仪表盘。
  - 组件显隐偏好保存在浏览器本地 `localStorage`，不随服务端数据重置，方便只使用单一工具的用户保持面板极简。
  - 组件支持 ↑↓ 上下调序，仪表盘产品卡与顶部标签栏按同一顺序同步渲染。

- **账号 / 连接卡片排序体系（默认积分多者靠前，手动拖拽优先级最高）**：
  - **默认规则**：各产品面板（Qoder / WorkBuddy / ZCode / mirasim）账号卡按剩余积分从多到少排列，无额度数据或查询失败的账号稳定排后；10Router 连接卡在启用优先的前提下按剩余额度 % 从多到少排列，供应商汇总卡同理。
  - **手动拖拽（最高优先级）**：直接拖拽卡片到目标位置即固定顺序（产品面板每产品独立、10Router 每供应商独立，连接卡与供应商汇总卡分别记忆），拖拽过程带插入位置指示线。
  - **设置菜单上下调整**：右上角「面板设置」新增「账号卡片排序」区，按产品分组展示当前顺序，支持 ↑↓ 微调与「恢复默认排序」；调整后卡片列表即时同步。

- **ZCode 账号卡片标明登录渠道徽章（BigModel 国内版 / Z.ai 国际版）**：
  - 解决 ZCode 体系认知痛点：ZCode 客户端内分为国内智谱平台（BigModel，绑定 Coding Plan）与国际平台（Z.ai，绑定 Start Plan / 赠送额度）。
  - 账号卡片在产品名旁根据凭据类型直观标出 **`BigModel`**（国内版）或 **`Z.ai`**（国际版），双登录账号标明 **`Z.ai + BigModel`**，彻底消除切换账号后因渠道不符导致「未登录」的困惑。

### 🔒 安全加固

- **Windows 本地 DPAPI 解密防杀软误报升级（改用 `-EncodedCommand`）**：
  - **背景**：Windows Defender、火绒等杀毒软件具备严格的「命令行启发式（CommandLine Heuristic）」审计规则。直接在子进程命令参数中明文传入 `[ProtectedData]::Unprotect` 会直接命中窃密木马（InfoStealer）特征并触发拦截（报毒阻断导致子进程权限被拒绝）。
  - **修复**：将所有 PowerShell 解密脚本在 Node 内存中即时编译为 UTF-16LE 并转为 Base64 密文，通过官方标准的 `-EncodedCommand` 参数传递，敏感数据走 stdin 管道输入。系统命令行不再包含任何明文字符串，彻底根除杀软误报。
- **DNS 重绑定防御范围扩展**：
  - 针对非 loopback 监听（如监听 `0.0.0.0` 用于 NAS 或局域网环境）且未设置访问密钥的部署场景，Host 头校验扩展到本机全部网卡 IP（IPv4 / IPv6）与主机名白名单，恶意网页无法再通过解析指向内网的域名绕过同源检查。
- **彻底移除 `?key=` 查询参数传密**：
  - 守护进程访问密钥只接受 `x-qd-key` 请求头，不再支持 URL Query 传密，避免密码明文落入反代日志、浏览器历史与系统访问日志中。
- **桌面版验证码窗口内联脚本防护**：
  - 阿里云验证码 SDK 注入模板中对服务端下发的动态配置做 `\u003c` 实体转义，杜绝由于配置内容包含 `</script>` 引发的跨站或闭合逃逸风险。
- **UMID 设备身份组件下载防投毒**：
  - 安装组件时 integrity 校验值必须匹配 npmjs 官方权威注册表；npmmirror 仅作为加速镜像源。当镜像版本与 npmjs 不一致时自动跳过镜像源，杜绝供应链投毒。
- **桌面版面板外链协议收敛**：
  - 桌面壳 `window.open` 拦截器仅放行 `https://` 协议，杜绝恶意或特殊 scheme 调用外部系统程序。

### 🐛 修复

- **ZCode 客户端切号后无法自动唤醒打开**：
  - 修复切号成功后仅关闭进程而未唤醒客户端的问题。桌面版切号后自动延迟 800ms（等待文件锁释放）后调用 `openZcodeClient` 重启客户端；网页端弹窗清晰提示用户打开客户端。
- **ZCode 切号导致「个人套餐未登录」的设置丢失问题**：
  - 逆向 ZCode 客户端 `app.asar` 定位到其套餐登录判定链：客户端经 `nPn` 枚举内置 Individual Coding Plan provider，用 `account-provider:<providerId>:identity` 读出该账号身份 ID，读不到即直接跳过 → 模型页显示「未登录」；随后才用 `account-provider:coding-plan:<providerId>:account:<identity>:api-key` 取密钥，并依赖 `provider_config.json` 的 `defaultModelSelection` 决定默认套餐。
  - 根因即此：`credentials.json` 缺少 `identity` 键、`provider_config.json` 无 `defaultModelSelection`，且切号时漏写 `setting.json`。现切号会按目标账号渠道（`zai` / `bigmodel`）自动补齐 `identity` 键、对齐 `config.json` 的 `builtin:*` 启用状态、`setting.json` 的 `modelProviderFamilySelectedKeys`，并把 `defaultModelSelection` 指向目标账号的 Coding Plan；`provider_config.json` 一并纳入快照生命周期。
- **ZCode 客户端版本探测阻塞事件循环（卡顿 20s+ 修复）**：
  - 原实现使用 `execFileSync` 同步查询 3 个注册表 Hive（每个超时 8s），在启动或首个请求到来时会锁死 Node 单线程事件循环数十秒。现改为异步 `execFile` + 缓存，并在调度器启动时后台预热。
- **桌面托盘「立即领取」在 401 鉴权失败时误报成功**：
  - 修复 `checkinNow()` 未校验 `res.ok`，当设置了访问密码时 401 响应会被默认当成「领取完成」弹窗通知的问题。
- **Qoder 客户端版本探测重复文件扫描消除**：
  - 消除同一次调用中连续两次触发 `detectQoderApps()` 导致的文件系统重复遍历。

### 🔧 工程与测试

- **单测用例扩充至 72 项全部通过**：
  - 新增 `test/mirasim.test.js`：覆盖 mirasim 凭据 AES-GCM 加解密往返、5h/7d 窗口配额归一化解析、`setting.json` 原子替换与配置保全。
  - 扩展 `test/zcode-local.test.js`：新增 `switchTo` 对 `setting.json`、`config.json` 与 `credentials.json` 三文件协同还原的断言。
  - 适配 `test/smoke.test.js`：更新非 loopback 监听 Host 校验用例、新增 mirasim 产品线注册与数据脱敏断言。
- **全仓语法与一致性门禁**：通过 `node --check` 语法检查，确保无语法与模块引用缺陷。

---

## [0.9.4] - 2026-09-27

### 🐛 修复
- 日志时间戳改用本机时区（原为 UTC+0，现跟随系统时区如 UTC+8）。
- 修复前端卡片删除账号无响应问题（`armed is not defined`）(#2)。

---

## [0.9.3] - 2026-09-26

### ✨ 新功能
- ZCode 客户端运行状态芯片（面板实时显示客户端是否运行）。
- 桌面版一键打开 ZCode 客户端。

### 🐛 修复
- 额度条 100% 时残留灰色尾段。

---

## [0.9.2] - 2026-09-26

### 🐛 修复
- 10Router 聚合视图按源数据口径显示：百分比额度显示 %，各行平等，不再被重置为绝对数字。
- 10Router 主额度行改分散对齐：名称靠左，数值与相对重置时间靠右。
- WorkBuddy 产品卡合并行防截断。
- CLI 文案统一为「领取」。

### 🔧 其他
- WorkBuddy 产品卡国内/国际合并为一行（领取 / 活跃 x/x（国内）· x/x（国际））。
- README 门面重构。

---

## [0.9.1] - 2026-09-25

### ✨ 新功能
- ZCode 自动轮询领取开关（默认关）。

### 🔧 其他
- ZCode 卡片不再显示任何徽标。

---

## [0.9.0] - 2026-09-25

### ✨ 新功能
- ZCode 活动领取自动轮询：每轮签到后自动查可领活动并领取。
- 桌面版隐藏窗口静默通过阿里云验证码。

### 🐛 修复
- WorkBuddy 页 innerHTML 汇总覆盖后 s-done 丢失，导致改名/切页报 textContent 空指针。
- store 原子写 rename 失败重试 + 兜底直写，修复 Windows 上 EPERM 导致的签到轮报错。

### 🔧 其他
- ZCode 代理地址可面板配置（优先于 HTTPS_PROXY 环境变量）。
- 仪表盘/详情页措辞按语义拆分：国内签到 / 国际活跃。
- 文案统一为「领鸡蛋」语义：Qoder / WorkBuddy 都叫领取，仅国际版叫保持活跃。
- KPI「活跃 x/x」改为小字副标。
- 汇总卡窗口额度多进度条。
- 设置加「隐藏 0/无额度汇总卡」。
- 胶囊徽章去类型背景色。
- 10Router 全部视角去掉「最早到期」；隐藏项不出现在标签；单连接卡周/月额度默认带进度条。

---

## [0.8.0] - 2026-09-24

### ✨ 新功能
- npm 包发布渠道（`creditdaddy`）。
- macOS 桌面版构建（dmg + zip，Apple Silicon 与 Intel 双架构）。
- 10Router 健康状态显示（/api/health：正常/异常/驱动降级）。
- 10Router 供应商标签页视图：「全部」按供应商汇总成卡，标签页看单连接明细。
- WorkBuddy 国际版「活跃领取」签到。

### 🐛 修复
- macOS 构建要求 ≥512 图标（升级为 1024x1024）。
- ZCode billing 版本跟随本机客户端（3001 修复）。
- ZCode 客户端当前账号按 uid+email 识别。

### 🔧 其他
- 10Router 卡片对齐账号主卡版式；积分包按系列聚合。
- 10Router 额度行对齐三档水位条 + 相对重置标签。
- 10Router 卡片默认只显示主额度，其余收进摘要（明细可展开）。
- ZCode 出口可切「代理优先」并自动回退。

---

## [0.7.0] - 2026-09-24

### ✨ 新功能
- ZCode 活动领取（preview → claim + 面板阿里云验证码）。
- ZCode 卡片显示套餐权益额度。

### 🐛 修复
- ZCode 强制切换先关闭客户端（防止内存旧登录覆盖回文件）。

---

## [0.6.0] - 2026-09-24

### ✨ 新功能
- 10Router 集成（供应商额度卡片 + 用量自动同步）。
- 飞牛 fnOS 窗口版 fpk（桌面多窗口模式）。
- WorkBuddy/CodeBuddy 及 ZCode 浏览器登录授权与自动入库。

### 🐛 修复
- fnOS 安装向导设置面板访问密码；面板 401 时自动重新提示输入。

---

## [0.5.0] - 2026-09-24

### ✨ 新功能
- Qoder 国际版在 fnOS/Linux 上通过「设备身份组件（UMID）」实现免客户端签到。
- 飞牛 fnOS 双桌面入口（新标签页 + fnOS 独立窗口）；页内原生交互对话框。

---

## [0.4.0] - 2026-09-23

### ✨ 新功能
- 接入 ZCode 账号管理：本地解密 `~/.zcode/v2/credentials.json` 的 `enc:v1:` AES-256-GCM 凭据，Token 绝不出机。
- 桌面版内置隐私（无痕）登录窗口：隔离一次性 session，不污染系统浏览器 Cookie。

---

## [0.3.0] - 2026-09-23

### ✨ 新功能
- **项目更名为 CreditDaddy**：数据目录自动从 `~/.qoderdaddy` 平滑迁移至 `~/.creditdaddy`（旧目录保留）。
- 接入 WorkBuddy（腾讯 CodeBuddy 系）账号管理与客户端热切换：本地读取 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\` 会话，支持国内版每日签到与国际版流式对话保持活跃。

---

## [0.2.0] - 2026-09-23

### ✨ 新功能
- Qoder 国际版每日签到支持（携带官方设备风控身份 Cosy-MachineToken）。
- 本机客户端一键导入：本地 DPAPI 解密 Qoder / Qoder CN 的 `auth.v1.dat` 凭据。
- 账号安全加密导出导入（兼容 10Router 的 `10router-oauth-secure-v1` 迁移标准）。
- 仪表盘与卡片式 UI、桌面托盘常驻。

---

## [0.1.0] - 2026-09-23

### ✨ 新功能
- 项目诞生（原名 **QoderDaddy**）：Qoder 多账号本地管理与每日积分自动签到助手。
- 本地守护进程架构（监听 127.0.0.1，Host/Origin 校验防 DNS 重绑定与 CSRF，数据全留本机）。
- Electron 桌面版外壳（Windows 托盘常驻）与飞牛 fnOS 应用包（fpk）支持。
- Qoder PKCE 设备码登录与本机 IDE 凭据扫描。
