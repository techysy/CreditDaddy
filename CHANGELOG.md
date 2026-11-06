# 变更日志

本文件为 CreditDaddy 完整开发与版本变更日志，按版本从上往下排列。

---

## [1.7.1] (2026-11-06)

- **Loomy「我的邀请码」**：账号卡新增查看本账号专属邀请码的入口（协议自 Loomy 客户端 app.asar 逆向：`GET /api/v1/invitation-codes`）——弹窗列出每个邀请码、使用进度（如 1/20 名额，用完标橙）、一键复制邀请码或分享文案（客户端同款文案）；生产端实测字段为 `{inviteCode, usedCount, maxUses, status}`，与客户端 bundle 的 `{code, usedCount, limit}` 不同，归一化兼容两种形状；列表为空时按客户端同款先 first-login 初始化积分档案再重查。

## [1.7.0] (2026-11-06)

本版主题:**新增 CodeBuddy IDE 产品线（双档位凭据收割 / SQLite 加解密 / 多账号切换）+ WorkBuddy 双客户端切号重写（国内/国际独立会话、$wbEncrypted 写盘加密封包、无会话合成兜底）+ ZCode 活动领取改版（marketing/touch 真源 + 激活事件上报、废弃硬编码兜底清单）+ 独立更新窗 + 切号体验（自动拉起客户端 / 导航灰角标 / 国际版徽章全亮）**.
Theme: **New CodeBuddy IDE product line (dual-flavor credential harvesting / SQLite crypto / multi-account switching) + WorkBuddy dual-client switch rewrite (CN/INTL independent sessions, $wbEncrypted sealed write-back, synthesized-session fallback) + ZCode claim rework (marketing/touch as the real source + activation-event reporting, hardcoded fallback list retired) + standalone update window + switching polish (auto-relaunch client, gray nav badges, INTL badges for all four clients)**.

- **新增 CodeBuddy IDE 产品线（issue #51）**：CodeBuddy IDE（国内 CodeBuddy CN / 国际 CodeBuddy）与 WorkBuddy 账号体系同源（token 由同一 realm 签发），额度 / 签到 / 10Router 推送全量复用既有链路；本版补齐它自己那套存储的读写——
  - **凭据收割**：读 `%APPDATA%\(CodeBuddy CN|CodeBuddy)\User\globalStorage\state.vscdb`（SQLite ItemTable 的 `secret://…` 行），Chromium Safe Storage v10 加解密（Windows：Local State `os_crypt.encrypted_key` → DPAPI → AES-256-GCM；macOS：Keychain Safe Storage → PBKDF2 → AES-128-CBC）。全 async、只在显式导入 / 切换时调用（DPAPI 要起子进程，1.6.6 白屏铁律：绝不进 `/api/status` 状态轮询）；
  - **多账号切换**：写前强制备份 `state.vscdb.bak-<时间戳>`；upsert 而非裸 UPDATE（IDE 装了但从未登录时 secret 行不存在，裸 UPDATE 影响 0 行不报错 → 「假成功」）；修复 upsert 键 / 值参数反转（真 secret 行从未被写中的缺陷）；
  - **无原生快照的账号**（token / 10R 导入）动态合成完整 IDE 会话（`buildCodeBuddyIdeSession`，对齐 workbuddy-switch 规范）后写盘，同样可切。
- **WorkBuddy 双客户端切号重写**：
  - 国内 WorkBuddy 与国际 WorkBuddyAI 是两个独立客户端（auth id 不同、会话文件两份、可同时各登录一个号）：`writeWorkbuddySession` 按账号档位写入对应文件（国际档同时落国际与国内两份）；新增 `currentWorkbuddyUids()` 一次读取分档返回国内 / 国际两个当前 uid；
  - `$wbEncrypted` 信封写盘：目标文件为加密模板时，token / refreshToken / 昵称用官方运行时提取的 masterKey 重新封包（keyId 契合原文件），对齐国际客户端连昵称都加密的形态；
  - 缺 `meta.session` 的账号合成完整会话后写盘（`buildWorkbuddySession`：域名按档位、手机号脱敏）——纯 token 导入的账号也能直接切客户端；
  - 自定义安装路径发现（issue #46）：注册表 Uninstall 键 → 进程路径两路兜底，daemon 启动时异步预热；`detectWorkbuddy` 保持同步零子进程（1.6.6 白屏教训）。
- **面板切号体验与徽章**：
  - 修复「选什么都能切到 CodeBuddy IDE」——uiDialog 承诺把 `'alt'` 强转 `true`，切换目标选择逻辑失效；
  - WorkBuddy 页新增「全部 / WorkBuddy / CodeBuddy IDE」客户端过滤段：过滤激活时切号直接定向对应客户端，不再每次弹「选择切换目标」；
  - 切号成功后 800ms 自动拉起对应客户端（ZCode 同款），WorkBuddy / WorkBuddyAI / CodeBuddy CN / CodeBuddy 四个 exe 按档位精确选择；
  - 国际版当前账号徽章修复：`/api/status` 下发四个当前 uid（WorkBuddy 国内 / 国际、CodeBuddy IDE CN / 国际），面板按账号档位对齐点亮；token 刷新后的客户端回写同步也覆盖双端；
  - 导航标签：账号数从主题色大胶囊改为图标右侧灰色小胶囊，激活标签底色改半透明；头部菜单加宽 + flex 分配修复按钮溢出。
- **ZCode 活动领取改版（2026-11-04 真机实测）**：
  - 活动发现改 `marketing/touch` 真源（官方客户端的活动投放数据源，隐藏活动可见），与 `billing/preview` 两路合并；**废弃硬编码兜底清单**（`ZCODE_KNOWN_CLAIM_PLANS` 清空占位）——活动 ID 一换代硬编码必失效（1102 → gb-1104 实测）；
  - 新增激活事件上报（`app_launch` / `app_daily_active`，移植自 zcode-switch claim.rs）：不上报激活事件时 preview 恒空、claim 被当非活跃端拒绝——这正是「只能在官方客户端里领」的根因；
  - 验证码 region 端点（按出口 IP 下发 cn/sgp）强制直连（`directOnly`），避免代理出口把 region 发错导致验证恒失败。
- **独立更新窗**：检查更新 / 下载 / 安装移入独立无边框小窗（`update-window.html` + 白名单 preload），与主窗口完全隔离——主窗口卡死或未加载时更新通道仍可用；顺带修复「取消下载」死按钮（AbortController 此前从未赋值）。
- **10Router 同步标记**：所有经 CreditDaddy 同步的 10R 连接统一携带 `creditDaddySync: true`（apikey 与 OAuth 两通道）；配合 10Router 侧同批改动，CodeBuddy 连接也能亮「CD Sync」来源徽章（qoder 网页会话 `creditDaddyWebSession` 语义不变）。
- 杂项：daemon 新增 `/assets/providers/` 产品图标静态路由与图标资源文件；测试 389/389（新增 codebuddy-ide、workbuddy-custom-path 两套，cookiesites / tenrouter / smoke 断言随同步标记更新）。

---

## [1.6.7] (2026-11-03)

> **1.6.6 撤版说明**：1.6.6 曾于同日早间发布（tag / GitHub Release / npm），因新引入的 WorkBuddy 取钥 `spawnSync` 缺陷导致桌面壳「未响应」白屏（网友实测卡首页），**发布后数小时内整体下架**（GitHub tag + Release 删除、npm 1.6.6 挂 deprecation 指向 1.6.7）。经用户拍板以 **1.6.7 重新发布同一批内容 + 白屏根治修复**——本版即原 1.6.6 的完整替代，请所有 1.6.6 用户升级。

本版主题:**WorkBuddy 5.6+ 加密凭据收割（对标 WorkDaddy 适配：$wbEncrypted 信封解密 / 5.8+ 手机号还原 / 切号加密写盘）+ ZCode GLOBAL BUILD 新活动兜底（3 亿 GLM-5.3-Flash）+ 1.6.5 发布后全量复审修复（v1.6.2..HEAD 35 提交 10 项发现）**.

本版主题:**WorkBuddy 5.6+ 加密凭据收割（对标 WorkDaddy 适配：$wbEncrypted 信封解密 / 5.8+ 手机号还原 / 切号加密写盘）+ ZCode GLOBAL BUILD 新活动兜底（3 亿 GLM-5.3-Flash）+ 1.6.5 发布后全量复审修复（v1.6.2..HEAD 35 提交 10 项发现）**.
Theme: **WorkBuddy 5.6+ encrypted-credential harvesting (WorkDaddy-style: $wbEncrypted envelope decryption / 5.8+ phone recovery / encrypted switch write-back) + ZCode GLOBAL BUILD activity fallback (300M GLM-5.3-Flash) + post-release full review fixes (35 commits, 10 findings)**.

- **【1.6.6 紧急修复】WorkBuddy 取钥改异步——根治桌面壳「未响应」白屏（网友实测卡首页）**：1.6.6 初版的 `getWorkbuddyMasterKey` 用 **`spawnSync`** 起 WorkBuddy Electron 子进程取解密密钥——同步调用把整个 Node 事件循环卡住最长 5 秒，而桌面壳把 daemon 跑在 **Electron 主进程内**：`/api/status`（面板首屏 + 30 秒轮询）→ `currentWorkbuddyUid()` → 加密会话解密 → 同步起 200MB 的客户端进程，主进程消息泵停摆 → Windows 判「未响应」→ 窗口白屏（首屏撞上 60 秒失败退避窗口时必然复现）。现已全链路异步化：取钥改 `spawn`（Promise + 在途去重 + 5s 超时）、`decryptSessionJson` / `sessionToAccount` / `readWorkbuddySessions` / `currentWorkbuddyUid` / `writeWorkbuddySession` 全部 async、`detectWorkbuddy` 的 `signedIn` 改纯文件判定（不再触发解密）；解不开的加密会话如实返回 null 不挂起不崩溃。本机实测 detect 1ms / 收割 3 账号 5ms。376/376 测试（新增「密钥不可用不阻塞」回归）。
- **ZCode 新活动「GLOBAL BUILD」兜底收录与名额满拦截**：
  - 收录 11 月新活动 `zcode-v3-start-plan-1102`（ZCODE GLOBAL BUILD · 300,000,000 GLM-5.3-Flash Token）。服务端已隐蔽该活动（`preview` 不返回），但通过兜底清单可直接调用 `claim` 领取；
  - 实测确认：名额抢光时服务端返回 `1005 今日领取名额已用完（exceed quota limit）`，在客户端内点领取会提示「操作失败，请稍后重试」；已有账号已领过则返回 `1003 该套餐已经领取过`；
- **WorkBuddy 5.6+ 静态加密（$wbEncrypted）信封解密与 5.8+ 手机号还原**：
  - ① **$wbEncrypted 本地解密**：支持 WorkBuddy 5.6+ 的字段级 at-rest 加密（`$wbEncrypted` 信封：内含 AES-256-GCM 密文与 AAD 签名）。调用官方 WorkBuddy Electron 运行时（`ELECTRON_RUN_AS_NODE=1`）提取存储绑定密钥，内存缓存且 60s 失败退避，安全解密 token 等敏感字段，彻底解决 5.6+ 客户端账号完全无法收割的问题；
  - ② **真实手机号还原**：WorkBuddy 5.8+ 会对 `account.phoneNumber` 掩码脱敏（如 `135****6735`），现自动从 access_token 的 JWT payload claims（`preferred_username` / `phone_number` / `mobile`）中提取未脱敏的大陆手机号；
  - ③ **切号写盘加密保护**：若原会话是 `$wbEncrypted` 结构，写回时自动重新封包为加密信封，防止 5.6+ 客户端加载异常；
  - ④ **客户端探测扩展**：补齐 `WorkBuddyAI.exe`、`CodeBuddy CN.exe` 及 macOS 对应候选。测试 375/375。
- **1.6.5 发布后复审修复（对 v1.6.2..HEAD 全部 35 提交 + 跨 #38 边界的 10 项发现逐条复核）**：① **daemon 崩溃路径**——10R 用量同步调度器的 setInterval 回调直读 loadConfig（鲁棒性审计把「读失败回默认值」改成了「读失败抛错」，但没有兜异常），杀软瞬时占用配置文件的 EPERM 会掀翻整个 daemon；现在调度轮 catch 跳过本轮。② **`.bak` 退路毁于一旦**——主文件损坏从 .bak 恢复后，第一次保存把仍损坏的主文件内容写进 .bak；现在主文件 JSON 不可解析时 .bak 不动。③ **Trae 同机多账号设备号回归**——#38 让 attempt=0 一律优先 meta.deviceId，但同机导入的 N 个账号 deviceId 相同：第二个号起天天 9074。新增 traePrimaryIds（每个设备号只认首账号）由签到循环传入，非首账号强制派生号（#28 的分离语义恢复）。④ **面板额度过期覆盖**——loadQuotas 的批次守卫在 await 之前判、恒为真，旧批次的快照仍会盖掉用户刚点的手动 live 刷新；改为 await 之后重判。⑤ **webSessionOnly 推送无视渠道排除**——免费额度页「同步到 10Router」自带 source 清单，绕过了 quotaPushDisabledProviders 过滤，把用户专门取消勾选（10R 已有同源连接）的渠道又推回去；现在同样尊重排除清单。⑥ **Loomy 切换两枚**——目标账号缺 userid 时不再借用旧凭据的 userid（会把新 session 配上别人的身份、徽章亮错卡）；未安装 Loomy 客户端时如实报 LOOMY_NOT_INSTALLED（此前非 Windows/未装环境下 mkdir+假写入+假「成功」，与 WorkBuddy 同款死路）。⑦ **Loomy 积分总额口径**——total=永久+每日剩余 让进度条恒满看不见 used 段；total 改容量口径（永久+每日上限）。⑧ **网关删号残留**——forgetAccount 清了 weights 却没清在途的 weightInflight，慢上游刷新落地后把已删账号的权重写回 Map（正是 2s 封顶要防的黑洞路径）；两个网关都补在途清理。⑨ **macOS qodercli 组件选取（PR #44 跟进）**——目录排序改版本排序（1.2.10 > 1.2.9）；候选项必须 statSync().isFile() 存在才用，坏条目跳过而不是选中即 ENOENT。⑩ 清理：面板站点卡 warn 补渲染、hardSwitch 后死码 LOOMY_RUNNING 从面板强切清单摘除、loomyClient hasAny 死变量与四语字典不可达字面 `\n` 键删除、ja「現在前不可」乱码修正。370/370 测试。

---

## [1.6.5] (正式版，内容曾以 1.6.3 名义出过测试包)

本版主题:**讯飞 Loomy 产品线（短信直登 / 本机凭据导入 / 多账号硬切换 / 积分与邀请码 / 10Router 同步）+ ZCode 隐形活动兜底（WEEKEND BUILD）+ Trae 自动签到修复与 fnOS 统一网关入口（#38 / #39）+ 全量代码审查清零**。
Theme: **iFlytek Loomy product line (SMS direct login / local credential import / multi-account hard switching / points & invite codes / 10Router sync) + ZCode hidden-activity fallback (WEEKEND BUILD) + Trae auto check-in fix and fnOS unified-gateway entry (#38 / #39) + full code review cleared**.

> **发布状态 / 版本号说明**：本版内容曾以 1.6.3 名义分发过本地测试包（2026-10-28，飞书群文件 `CreditDaddy-Win-Setup-1.6.3.exe`）；此前误发到 npm 的 `creditdaddy@1.6.3`（已挂 deprecation）因 npm 同版本号不可重发而**永久作废**——正式发版（tag / GitHub Release / npm）**跳过 1.6.3 / 1.6.4 用 1.6.5**，避免同一版本号在两条渠道指向两个不同的东西（2026-10-29 用户拍板）。

### 🔧 修复

- **免费额度页「同步到 10Router」只推网页会话渠道的额度卡**：此前该按钮先调账号连接同步（把 Qoder / WorkBuddy 等全部账号连接也推上去）再全量推额度卡（连本机凭据线的 minimax-free 都搭车）——网页会话页的「同步」顺手改动了别的东西，用户找不出原因。现职责收拢：本页「同步到 10Router」与「推送设置 → 立即推送」都走 `webSessionOnly` 口径只推 cookie-site 系额度卡（tokenharbor / 小米 MiMo / River / 魔搭 / LongCat）；账号连接同步归 10Router 页「账号管理」弹窗（带渠道开关），10Router 页推送仍是全量。
- **Qoder 网页会话收割后「缺网页会话」徽章即时消失并主动刷新明细**：收割链路是三段异步（登录成功 → 登录窗「关闭」后才收割 Cookie → daemon 绑定），面板此前只靠登录成功后 12s/30s 两个 setTimeout 猜收割时机——猜错徽章就挂着，逐资源包明细要等用户手动刷新才出来（本机实测：16:43:11 登录成功、16:43:16 绑定完成，徽章却等周期轮）。现对齐 cookie-site 捕获的既有事件模式：收割绑定完成（bound>0）时桌面壳推 `qoder-web-session:bound` 事件，面板收到后刷新账号列表并按 **live 口径重查 Qoder 账号额度**（与手动「刷新积分」同款：真探上游重拉逐资源包明细，不是只把徽章藏掉）；非桌面场景（无 preload）仍由周期轮与登录后的两轮轻量补拉兜底。
- **Trae 自动签到每天 9074 失败（issue #38，#31 的真正根因）**：签到用的 `x-device-id` 此前按 uid **确定性派生**，但服务端会把「账号-设备」绑在**登录时注册的那台**上——派生的陌生设备号从导入第二天起被风控持续拒绝（「当前参与用户太多，请稍后再试」），重试轮换其它派生号也全拒；同一时刻在官方客户端手动签到正常。导入首日能成功是风控学习窗口，之后每天失败。现签到设备号**优先原样使用导入时从客户端 `storage.json` 抓到的真机号**（`meta.deviceId`）；无真机号（纯 token 导入）或 9074 重试时才回落派生号轮流尝试，多账号同机时首账号用真机号、其余派生互不抢占。升级后次日起自动签到应恢复正常；若首日仍见 9074 属风控放行窗口，官方客户端手动签一次即可。

### ✨ 新功能

- **fnOS 桌面/APP 走统一网关入口（issue #39，方案 2）**：从公网域名（反向代理 / Cloudflare Tunnel 等 HTTPS 入口）打开 fnOS 桌面图标或飞牛手机 APP 时白屏——窗口按「当前访问主机名」拼 `http://域名:47860`，而 HTTPS 入口只服务 443，该地址不可达（内网 LAN 一切正常）。现 fpk 改走 **fnOS 统一网关**：`ui/config` 的窗口声明 `gatewaySocket`（app.sock）与前缀 `/app/creditdaddy`，manifest 声明 `micro_app`，新增 `gateway-proxy.mjs`（Node 零依赖）把网关转来的请求剥前缀、改写 Host/Origin/Referer 后转发本机 47860——**公网 443 直达，与页面同源，无需用户任何配置**；Anthropic SSE 长流（/gateway/*）流式透传。直连 `http://LAN_IP:47860` 的旧路径完全不受影响；反代代理起不来也不挡主服务。已验证：前缀剥离 / Host+Origin 改写 / SSE 完整流 / POST body 原样（冒烟脚本三路全过）。

### 🛡 稳健性加固（2026-10-29 全量审计）

对全部 25 个运行时文件做了一轮鲁棒性审计（并发/资源泄漏/错误路径/无界增长），落地以下修复：

- **网关补上「优雅断开」观察（三个网关）**：客户端在响应头到达前取消（cc CLI 里 Ctrl+C / 点停止）只触发 `res 'close'`、不触发 `req 'close'`——此前唯一的断开钩子接不到这种断开，整个重试循环照跑：ZCode 空转验证码求解与账号轮换、Trae 照样创建 SOLO 会话真烧额度、MiniMax 白跑。补上 `res 'close'` 钩子后取消即中止。
- **Trae 网关错误响应体不再滞留**：401 / 429 / 事件流失败的响应 body 此前既不读也不取消，每条把连接钉到上游关闭或 ~300s 超时——429 风暴时一次补全泄漏最多 5 条 socket。统一 `cancel()` 丢弃；会话清理 DELETE 也改走 10s 限时通道（裸 fetch 黑洞时吊 5 分钟）。
- **ZCode / MiniMax 网关流中断补 error 帧**：上游中途断流此前只 debug 日志 + 静默 `res.end()`——客户端只见无 `message_stop` 的裸 EOF，报「流意外结束」没头绪。现按 Anthropic 协议补一帧 `event: error` 带原因；客户端主动断开仍静默收尾。
- **Trae / MiniMax 网关的权重查询不再阻塞补全请求**：分流用的「剩余积分」缓存过期后，第一个请求此前会**串行完整等待**每个账号的额度查询（Trae 每号两个 POST、各 15s 上限）——上游黑洞时补全请求先卡 1-2 分钟，客户端还挂着已连接的 SSE。现权重并行获取且单个 **2 秒封顶**：额度接口健康时照常拿到新值精准分流；黑洞时先用旧快照顶上，刷新转后台继续，下一个请求就有新值。并发请求共用同一次刷新（in-flight 去重），不会随请求翻倍打额度接口。
- **经代理的响应流式化**：代理通道此前把整个 body 收完才 resolve——「代理优先」模式下网关补全在整个生成期间一个字节都到不了客户端，首 token 超时必然误报。现改 PassThrough 逐块透传，墙钟上限继续管住流式 body（与直连同口径）。
- **10Router 配置读失败不再被默认值静默覆盖**：`loadConfig` 此前任何读错误（杀软/同步盘瞬时占用、JSON 损坏）都返回默认配置，下一个写请求会把「默认值 + 本轮改动」整份落盘——端点、key、同步水位全没，且 catpaw 用量水位清零导致历史用量整段重发。现仅文件不存在用默认值；损坏走 `.bak` 恢复（保存前自动维护）；其余错误上抛跳过落盘。
- **CLI 变更命令与运行中的 daemon 互斥**：`withAccounts` 串行队列只在单进程内有效——daemon 签到轮刚轮换的 refreshToken 会被 CLI 进程基于旧快照的整份写回冲掉（一次性 refresh 当场作废，凭据链死）。`add / import / checkin / remove / scan` 检测到后台实例运行即拒绝并提示改走面板或先 `stop`。
- **面板轮询与请求生命周期**：30s/10s/5min 轮询加单飞守卫（daemon 卡住时不再无限堆积，恢复后不齐发踩踏）；`api()` 加挂钟超时（默认 2 分钟，全量签到 / 10R 推送等慢操作显式放宽到 5-10 分钟），半开连接不再吊死轮询链；额度批量加载的过期结果不再覆盖新发起的 live 刷新值；免费页站点卡拖拽监听改启动时绑一次（此前每次渲染累积，一次 drop 触发 N 次重排）；设备码登录轮询容忍瞬时失败（连续 5 次才终止，daemon 忙时的 502 不再毁掉整个授权流程）。
- **桌面壳（Electron）**：启动安装器的 `spawn` 补 `error` 事件兜底（杀软隔离安装包时不再 uncaughtException 掀翻主进程）；`shell-open-external` 只放行 https 外链；GitHub 更新检查 15s 超时、安装包下载 60s 空闲掐断（墙钟放行大文件，黑洞不再卡死更新弹窗）；保存密码弹窗改单趟 token 替换（密码里恰好含占位符字面量时不再被改写后入库）；验证码窗口 JSON 注入修正。
- **fnOS 统一网关代理**：压缩响应不再改写 HTML（gzip 解码再替换必然乱码）；客户端断开即销毁上游连接（反复开关页面不再累积挂起的 SSE socket）；`stop` / 卸载对网关代理进程按脚本名兜底清理（pid 文件丢失不再留孤儿进程占着 app.sock）。
- **杂项**：Qoder 暂存网页会话 48h TTL（过期凭据不再永久躺在 settings.json）；面板密码限流与配额刷新回调的按 IP 计数 Map 周期清扫（公网扫描器来源不再只进不出）；catpaw 用量水位清理回溯窗（410 天）外的死账；`atomicWrite` 首写失败清掉半截临时文件；删除账号时同步清三个网关的冷却/权重/粘滞残留（`forgetAccount`）；Qoder 对「200 但非 JSON」响应报明确错误（不再让 SyntaxError 冒充「token 不可用」误导重导凭据）；ZCode 手动领取轮结束时若自动领取已开启则补排调度（此前自动领取会静默死掉）；设置接口不再因签到字段提前返回而漏处理同请求里的密码修改；豆包客户端死代码清理。

### 🗑 撤回：码道 CodeArts 签到（issue #40，产品决策非缺陷）

**结论：本版不提供 CodeArts 签到，该接入线整体撤下。** 详见 issue #40 的三条评论（场景边界 / 实测数据 / 补充观察）。

撤下依据（三条，均为实测）：

- **会话保活不成立**：华为云控制台会话受闲置超时 + WAF 指印（`HWWAFSESID` / `browserCheckResult`）绑定，浏览器里靠 SPA 持续续期，本机无法续。新鲜会话可用（实测签到真实入账 +100），但当日内即失效（网关回登录页）。
- **收割时机不可控**：登录窗关早一拍只能收到 35 条 cookie（完整 47 条），探测同样被拒，且没有可靠信号判断「够不够」——轮询某个特定 cookie 也只是碰运气。
- **形态矛盾**：签到要求「每天固定时刻会话必须有效」，而该会话有效期以小时计。维持它需要用户每天重登一次浏览器——需要用户每天喂一次登录态的自动化，不叫自动化。

叠加新注册华为云账号可能接到推广电话，两条「臭鸡蛋标准」都踩中，故不再迭代实现，直接撤线。

落地：

- `cookieSites.js`（站点配置）、`providers.js`（产品实现）、`constants.js`（注册表三处）、`codeartsClient.js`、`test/codearts.test.js` 全部移除；`checkin.js` 保活监视回退为只盯 Qoder 网页会话；`daemon.js` 采集/重探分支与其身份归户接线一并清理；`panel.html` 余额胶囊分支移除；i18n 四语清掉 17 条死词条。
- `startDaemon()` 加一次性剪枝：`provider === 'codearts'` 的存量账号在启动时移除并逐条记日志（与 `minimax-intl` / `inception` 撤线同款模式）。**必须清**——provider 已不在注册表，`productOf` 会回落到 `qoder`，否则会在 Qoder 页显示成一条点不动、签不了、删不掉的幽灵行。
- 保留 `site.warnHtml` 站点级红字警示字段（本次为码道加的，通用能力：用于「接入该站点有工具之外的代价」这类必须前置告知的场景）。
- 顺手把 `daemon.js` 里决定自动行名的**四层嵌套三元**改成 if 链——撤线时删分支漏了一个括号导致语法错误，那串写法每增删一个站点都要数括号，是结构性隐患。

若日后码道开放长期凭据（AK/SK 或 OAuth refresh）且登录链路稳定，可按既有 `cookieSites` 结构重新接入。

### ✨ 追加（2026-10-31 本地测试包）

- **Loomy 产品线补齐四件套**：① 新手机号**自动注册**——短信直登被拒（未注册）时用同一条验证码走 `/register/phone/submit` 注册后自动重登，账号名优先取讯飞昵称（`/userinfo/query/baseInfo`），有效期按 14 天落库；② **打开客户端**——Loomy 页工具栏新增「打开客户端」（带运行状态灯，桌面版 IPC 拉起 Loomy.exe）；③ **切换账号**——Loomy 账号卡出现切换键：写回 `auth-session.json`，强制切换先退客户端、写完自动拉起（与 ZCode/Trae 同款体验）；④ **积分口径订正**——额度改走客户端真实积分接口：`GET {loomyad.xunfei.cn}/api/v1/points/records?pageNo=1&pageSize=1&recordType=all`（永久积分 = 响应 `balance`、每日赠送积分 = `dailyBalance`，两行展示，单位「积分」），**不再拿模型数量冒充积分**（此前显示「剩余 13」实为模型池大小）。**100002 根因订正**：客户端 `points-config.js` 的默认积分地址 `ossptest.voicecloud.cn/loomy/integration` 是开发/测试环境（会话表与生产独立）——拿生产 session 打它必得 100002「登录已失效」，而认证层 baseInfo 同会话有效，极具迷惑性；拆包实证客户端运行期只连 loomyad.xunfei.cn 不连 ossptest，且生产域上同一 session 的 records 直接返回 `code=000000、balance=10500` 与客户端 UI 一致。积分接口现按客户端协议在 100002 时补调幂等的 `POST /api/v1/points/first-login` 初始化档案后重试一次，仍失败才如实报错，不再给假数字。
- **ZCode「隐形活动」自动兜底（WEEKEND BUILD 领不到的根治）**：服务端偶尔把活动从 `billing/preview` 列表里藏起来（2026-10-30 WEEKEND BUILD 实测 preview 空、claim 按 planId 直接可领免验证码），按「先查列表、空则逐个试已知 planId」兜底——1001/1002（不存在/已结束）静默跳过不留痕、1003 记已领、0 即领取成功；面板手动领取弹窗空态新增「尝试已知活动」按钮走同一兜底。新活动出现时在 `ZCODE_KNOWN_CLAIM_PLANS` 追加一行即可。
- **Loomy 登录反馈收口**：短信发送 / 登录请求加 45s 面板超时（不再无限「登录中…」，失败原因直接上 toast），重复登录同一账号提示「凭据已更新」。
- **Loomy 邀请码入口**：Loomy 账号卡新增「填写邀请码」按钮（礼物图标）——输入邀请码即调客户端同款 `POST {loomyad}/api/v1/points/activation` 绑定，服务端给新号 +5000 永久积分（每号一次）；绑定后自动刷新该卡积分，运行日志记录绑定结果。协议逆向自客户端 points-service（`bindInviteCode` / 激活状态 `GET activation` → `{activated, appliedInvitationCode}`）。
- **审查后两笔补丁（正式版收尾）**：① #42——`dailyConsumedPoints` 存在即直读（哪怕 0），不再被 `||` 链倒推出幻影「已用」（顶层 used 同口径收敛；10Router 侧 open-sse/services/usage/loomy.js 同款跟进对齐，两边各带 =0 回归用例）；② 仪表盘 Loomy 卡补「积分合计」聚合行（此前误挂「活动领取」错位文案且无积分聚合），四语文案收成一行式。
- **Loomy「客户端当前」徽章修复（切换混乱的根因）**：面板徽章按 `a.token` 比对，但账号卡下发的是脱敏视图（`tokenMasked`），`a.token` 恒为空——徽章永远不亮，分不清哪张卡是客户端当前登录，点当前账号切换只会得到「已是该账号」，看起来就像「无法切换」。现在 `/api/status` 新增 `loomyCurrentUid`（读 auth-session.json 的 userid），面板与其它产品线同款按 uid 比对。
- **Loomy 切换改硬切换 + 边界摊牌（外部切号的能力上限）**：实测抓到「切了没生效」的真凶——不只退出清理会回写，**客户端渲染层把界面登录态存在自己的 localStorage（`loomy-auth-session`），启动时反向推给主进程**（实测 CD 写入 187 后 21 秒被客户端重启回写成 131），且渲染层从不从主进程拉取会话（asar 里只有 `setSession/clearSession/onSessionInvalidated`，无 `getSession` 调用）——**像 ZCode/Trae 那样外部注入切号在 Loomy 上原理不可行**（Chromium Local Storage 二进制格式无法安全外部改写）。现在：切换统一硬切换（先关客户端 → 写凭据 → 延时复核防迟到回写）+ **只要真切换就自动拉起客户端**（此前客户端没跑时切完毫无动静）；**凭据文件缺失（如在客户端内退出登录把它清空）不再挡切换**——目标账号的 session/userid/phone 直接从账号库写入（此前会弹「没有可用的登录凭据文件」死路，且失败不落日志）；切换失败现在也写运行日志。面板与日志明确告知边界——CD 侧账号切换/积分/10Router 同步按目标账号生效，客户端界面若仍显示旧账号，需在客户端内「退出登录」后重新登录。
- **Loomy 同步 10Router 恢复**：渠道白名单是 Loomy 上线前保存的（`accountSync.providers` 无 loomy），账号管理弹窗的渠道清单也没给 loomy 行——同步永远过滤掉 loomy 账号。弹窗补「讯飞 Loomy」渠道行；同步载荷为 loomy 补 `authType:'apikey'`（10Router 原生 loomy 连接即 apikey 形态、凭据存 `apiKey` 字段，缺这个字段导入端按 oauth 落库不写 apiKey）。实测：两个 Loomy 账号导入 10Router 成功，重同步幂等命中「更新 2」。面板「同步账号」现在会写运行日志（`10Router 账号同步:{summary}`）——此前同步成功也没有日志落点，无从核对。

### 🌐 其它

- 网页会话站点 label 与产品描述补齐「豆包」；CHANGELOG.en 补 1.6.1 / 1.6.2 英文段（英文面板「更新日志」直接显示英文）。
- **1.6.5 全量代码审查修复（对 9a056a0..HEAD 全 diff 的多代理审查，9 项发现逐条人工复核）**：① loomyClient 三处积分/激活/邀请码接口补 `res.ok` 与非 JSON 校验——上游 5xx/HTML 错误页不再被吞成「绑定成功」或「0 积分」；② 每日上限不再把服务端显式的 0 捏造成 5000，零余额空号恢复 empty 口径（不再有「0/5000 已用 5000」幻影额度）；③ ZCode 隐形活动静默跳过收窄到已知清单兜底项（`known` 标记）——preview 列表里的真实活动返回 1002 仍如实记失败；④ `/api/status` 停发 `loomyCurrentToken`（活跃会话 token 无消费方，暴露面收敛为 uid）；⑤ 硬切换不再把旧账号手机号配进目标账号凭据；⑥ 删除切换路由里不可达的第二个 Loomy 分支及 loomyLocal 死导出（switchTo/killLoomy/launchLoomy/switchLoomyAccount/currentLoomyToken）；⑦ Loomy 全部界面字符串补齐四语翻译（空态/本机导入提示/SMS 登录流/切换警示 15 条）并移除失效键。366/366 测试。

---

## [1.6.2] (2026-10-26)

本版主题:**ZCode 体验包网关分流收口（轮转修复 + 会话粘滞）+ LongCat 包行数字失真修复 + 领取到账时间可见 + 429 退避阶梯与切号/领取反馈收口**。
Theme: ZCode pack gateway dispatch hardening (rotation fix + session stickiness) + LongCat pack-row number fix + claim arrival time surfaced + 429 backoff ladders and switch/claim feedback hardening.

> **Tag 前追加（2026-10-28）**：以下「429 退避阶梯」「WorkBuddy 未装拦截」「领取即时上卡」「10R 渠道开关」四组随本版一并发出（tag 未发过，无独立版本号）。

### 🔧 修复

- **网关 429 冷却从「固定 5 分钟」改为退避阶梯**：三个网关（ZCode / MiniMax / Trae）此前把 429 冷却写死 5 分钟——上游限流窗口通常不止 5 分钟，冷却一到期就立刻又撞 429，同一账号陷入「冷却 → 立刻再被限流」的循环（日志里清一色「冷却 5 分钟」）。现按连续次数走阶梯 **30s → 1min → 2min → 5min → 10min**（第 5 次起封顶 10 分钟不再上涨），成功补全一次即清零计数——偶发撞一次 429 不会累积，只有真被持续限流的号才会拉长。清零点覆盖补全成功（流式 / 非流式）、凭据更新复活、重开网关、领到新额度四处；日志带连续次数（「冷却 10 分钟(连续第 2 次)」），一眼分清偶发与持续限流。
- **Trae 网关事件流阶段 429 此前不进冷却**：Trae 补全是两段式（建会话 → 拉 events 流），会话建好、拉流被 429 拒时只记「事件流 HTTP 429」不计数——该号下一轮会话创建仍从 30 秒档起算继续撞限流。现与建会话阶段同走阶梯。
- **WorkBuddy 未装客户端时切换明确提示安装**：`writeWorkbuddySession()` 此前无条件 mkdir + 写会话文件并返回成功——没装 WorkBuddy / CodeBuddy 客户端的机器点了切换，面板显示「已切换」，但没有任何客户端会应用这份凭据，纯死路。现 `detectWorkbuddy()` 只认客户端 exe（凭据目录不能当依据——CD 自己切换 mkdir 出的空壳目录会误报已安装），未安装时切换接口返回 `WORKBUDDY_NOT_INSTALLED`；面板点切换即 toast 指引、WorkBuddy 页未安装时横幅说明（Token 导入 / 额度 / 领取不受影响，只有切换需要客户端）。
- **ZCode 领取成功后卡片与徽标即时更新**：自动领取（后台轮询）与手动领取两条路径此前只 `loadQuotas()` 不重绘，卡片停在旧样子；且 `statusOf()` 对 ZCode 直接返回空徽标——领取结果在卡片上毫无痕迹。活动额度常带 `effective_at`（当天稍晚到账），在那之前额度行是「待生效」，与旧状态差别用户根本看不出来，只能自己手动点刷新。现三处（自动领取 / 弹窗手动领取 / 单卡刷新）补重绘，ZCode 补「已领取 / 已领过 / 领取失败」徽标。
- **ZCode 体验包网关「多账号轮换」实际没在转——所有请求都堆在第一个号上**：`rotationQueue()` 只把轮转指针 `rrIndex` 归一化到可用账号数范围内，**从不自增**，于是队首恒为账号库里的第一个账号，`handleGateway` 每轮都从它起用；其余账号只在它失败 / 冷却 / 被拉黑时才挨到。现每轮推进一格，请求分摊到各账号；可用集变化时起点取模归位，不越界卡死。同仓 MiniMax 网关用「粘性主力 + 权重排序」能分流，ZCode 这条连指针都没转起来，是它独有的实现缺陷。
- **LongCat 资源包行数字失真（issue #37）**：推给 10Router 的包行把真实数字拼进了 `name` 文本（「317.57 万 / 500 万 · 36%已消耗」），结构化字段却推 `used=0 / total=剩余值 / remainingPercentage=100`——10R 渲染链只认结构化字段，卡面画成满格未用，与 name 文本自相矛盾。现改为**字段即真相**：`used`=已消耗、`total`=包总量、`remainingPercentage`=剩余%，`name` 退回纯文案（获赠资源包 / 资源包），到期日走 `resetAt`；Balance 汇总行同步改推 Σ消耗 / Σ总量，10R 池条据此画出消耗空段（此前 Balance 推剩余值当总量，池条恒满）。
- **ZCode 领取成功但活动未到账时，消息带「HH:MM 到账」**：`claimPlan()` 早就返回了 `startsAt`，但 `zcodeAutoClaim` 拿到后完全没用，`claims` 只记 `plan/via/ok`——到账时间就这么丢了。现场：自动领到「ZCODE GLOBAL BUILD」3 亿 Token，日志明确「已领取（免验证码）」，面板却只显示「待生效 3 亿 · 23:00 到账」，用户无法区分「没领上」还是「要等」。现两条领取路径（免验证码 / 静默验证码）都带出 `startsAt`，仅当到账时间在未来才追加「（HH:MM 到账）」（同日只出时分、跨天出 `M-DD HH:MM`），已生效的不加后缀。

### ✨ 新功能

- **ZCode 体验包网关会话粘滞**：同一会话的多轮对话固定用同一个账号，新会话才轮转（跳号会让上下文承接出现割裂）。会话标识取自调用方 body 的 `metadata.user_id`（宽容解析嵌套 JSON 串 / 顶层 `session_id` / 字符串直给三种形状）；同时 `metadata.user_id` 改为**调用方传了就原样透传、没传才随机生成**——此前每次请求都新生成一个 `session_id`，上游眼里每请求都是新会话，会话连续性本身就是断的。粘滞 TTL 30 分钟，到期让位给轮转；粘住的号被拉黑 / 冷却 / 打标时自动让位，不死粘。调用方没传 `metadata` 时退化为纯轮转（行为安全）。
- **10Router 账号同步渠道开关**：账号管理弹窗新增渠道勾选区（只显示本机有账号的渠道），每渠道两个勾——主勾 = 额度卡推送、「连接」= 账号连接同步。10Router 已单独配了同源渠道（如 minimax-code 连接）时，取消勾选即可去掉 CD 侧重复维护的同名免费卡（`minimax-free-*`）——此前两张卡并存且数字各刷各的。`tenrouter.json` 新增 `accountSync { enabled, providers }`（providers 空 = 不限渠道，向后兼容）与 `quotaPushDisabledProviders[]`；被排除渠道的刷新回调返回 410 不再回源。10R 端已有卡片不会被 CD 主动删除（避免误删手动建的卡），挂 7 天 TTL 自然过期或手动删。
- 面板「接口使用中」徽标在多账号时注明轮转分摊（n 个 ZCode 账号、每请求换一个），避免以为只有一个号在服役；`gatewayStatus` 新增 `stickySessions`。

### 🌐 其它

- `gatewayStatus` 三网关补 `coolingDetail`（剩余秒数 / 文案 / 连续次数）；`cooling` 字段保持字符串数组历史形状不破。新增 `formatDuration.js`：冷却时长可读格式，30s 按秒显示（`Math.round(ms/60000)` 会把 30s 抹成「1 分钟」）。
- 10Router 工具栏按钮顺序调整为 刷新额度 · 用量同步 · 账号管理 · 设置。
- 测试补强：网关轮转 / 会话粘滞各 2–4 条、三网关 429 阶梯逐档断言 + 封顶 + 成功清零、`formatDuration` 边界、`detectWorkbuddy` 判定、渠道白名单过滤 / 排除渠道零推送（关键用例均验证过「摘掉修复即转红」）；logger 归档等待条件从「文件存在」改为「文件有字节」（修 CI 在 Windows / Node 24 上的偶发竞态红——`createWriteStream` 一 new 出来文件就存在，但 `write()` 落盘是异步的）。全量 340 条。
- 补 i18n 词条（冷却阶梯 / WorkBuddy 未安装指引 / 渠道开关 / ZCode 徽标轮转说明）四语同步；`scripts/check-i18n.js` 全量覆盖通过。


---

## [1.6.1] (2026-10-23)

本版主题:**Qoder 双渠道切号收口（判定错位 / 失效报错 / 自动拉起）+ ZCode 活动权益「待生效」展示 + 10Router 账号管理入口**。
Theme: Qoder dual-channel switching hardening (current-account alignment / real-cause errors / auto-relaunch) + ZCode pending-grant display + 10Router account-management entry.

### 🔧 修复

- **Qoder 切号后当前账号判定错位（切换键消失）**：国际 / 国内双渠道来回切，切完面板「客户端当前」对不上实际登录——`/api/status` 的 `qoderCurrent` 原来只按 uid 比对，且结果缓存 60 秒。触发路径实测：客户端会静默刷新 token（旧快照 uid 相同但 token 已换），uid 比对撞上「同 uid 多条记录」时把别的记录误当当前账号——新当前账号不亮角标、切换键显隐全错，用户看到的就是「切完切换键没了」。现改为按 `auth.v1.dat` 解出的 **token 精确对齐账号 id**（uid 兜底），切号成功后立即清缓存；面板 `isClientCurrent()` 按 id 判定。非当前账号的切换按钮不再连带消失。回归：`test/qoder-current-token.test.js`（同步修掉新测试在 CI 全红的两处环境依赖——DPAPI 密钥创建延后到测试体（Linux 无 powershell.exe 不再 ENOENT 崩在 skip 之前）、收尾关日志归档流 + 退避重试兜住 gzip 落盘尾窗）。
- **Qoder 切换凭据失效时提示指向真实原因**：原提示「凭据文件不存在（客户端可能被卸载或换了数据目录）」把最常见的「客户端退出登录后删掉了 `auth.v1.dat`」说成了换目录——照着提示找目录永远找不到。现按探测结果给指引（已安装 → 确认客户端里登录后再「本机导入」；未安装 → 先安装登录），并带上账号名与渠道名，报错能直接照着做。

### ✨ 新功能

- **Qoder 切号后自动拉起客户端**：强制切换会先关掉 Qoder，原来切完停在「请重新打开」——用户得自己翻开始菜单找快捷方式。现与 ZCode / mirasim / 妙手 / Trae 对齐，写完登录后自动启动，并按渠道只开对应的那一份（切国际版不把国内版 Qoder CN 一起打开，反之亦然）。
- **ZCode 未生效活动权益单独显示「待生效」**：活动权益要到 `effective_at` 才进余额（如 ZCode 1024 Dev Day 的 3 亿 + 2 亿），此前显示成「剩余 0 / 5 亿」——像额度丢了，用户以为领取失败。现全部未生效时主行显示「待生效 5 亿 Token · 活动名 · HH:MM 到账」，进度条用虚线（pending-ghost），不再画成零额度实条；部分生效时在剩余行下追加待生效行。后端补 `pendingTotal` / `pendingAt` 与每项权益的 `planName`（未生效权益靠它告诉用户「这是哪个活动发的」）。
- **10Router「Cookie 会话」改为「账号管理」**：账号同步原来藏在「10Router 连接设置」弹窗最底部，找不到；Cookie 会话又单独占一个按钮。现工具栏「账号管理」弹窗内分两块——账号同步（推本机 Qoder / WorkBuddy 为上游连接，带面板密码输入走 OAuth 通道）与网页会话（Token Harbor 等 Cookie 捕获）。设置弹窗里重复的「同步账号到 10R」区块与旧弹窗死代码一并清掉；免费额度页「同步到 10Router」仍一键两路（连接 + 额度卡）。

### 🌐 其它

- 补 i18n 词条（待生效 / 到账 / 即将到账 / 账号管理 / Qoder 启动相关）四语同步；`scripts/check-i18n.js` 全量覆盖通过。

---

## [1.6.0] (2026-10-21)

> **同版重发说明（2026-10-21）**：1.6.0 首发构建（tag 未打，无线上产物）后当日连修六笔（详见 docs/incident-20261021-quota-sync.md），全部并入本版随 tag 一次发出；此前分发的本地测试包（81b02e0 / 5b5aab6 / b6f6dad 等 build）与本 tag 构建并存，以本 tag 产物为准。

本版主题:**Trae 9074 换设备号重试（#31）+ WorkBuddy 国际版「活跃领取」机制下线 + 豆包快捷入口（#32）+ Inception 线整体移除（#35）+ MiniMax 免费额度卡回归 10Router 并带只读签到状态（#33 方案 B）+ 多语化更新日志（en/ja/ko）+ 2026-10-21 六连修复**。
Theme: Trae 9074 device-id rotation retry (#31) + WorkBuddy intl "active-claim" retirement + Doubao quick-open entry (#32) + Inception line removal (#35) + MiniMax free-quota card back on 10Router with read-only check-in status (#33 plan B) + multilingual changelog (en/ja/ko) + the 2026-10-21 six-fix batch.

### 🔧 修复（2026-10-21 六连，详见 docs/incident-20261021-quota-sync.md）

- **mirasim 用量只同步官方中继行**（cf60179）:直连上游的调用（本机 10Router 已原生记账）不再导入——修 10R 用量表同批调用双记（同名模型出 codebuddy-cn 与 mirasim-anthropic 两行）；viaRelay 分界实测零交叉，配套 10R 侧存量重复清理（usageHistory 删 4,066 行 + usageDaily 聚合按备份重写，终态 342 纯官方中继真值）。
- **minimax-free 旧聚合卡升级一次性清理**（230e2fd）:按账号单卡换代后旧 source 无人推也无删除，升级用户旧卡挂满 7 天 TTL 与新卡并存——首轮推送自动 DELETE 旧卡。
- **TraeWork→TRAE 迁移适配**（5b5aab6）:客户端探测顺序新 TRAE CN 优先（SOLO CN 已停发，残留目录陈旧凭据不再首选）+ 国际版客户端（trae.ai）导入时面板明确警示「仅支持国内版」，不再静默导入空额度卡。
- **cookie 收割后账号卡余额即刻刷新**（b6f6dad）:onCookieCaptured 漏拉 quota 缓存，小米等网页会话收割成功后卡面旧数字挂到手动刷新。
- **「免费额度推送设置」改名「额度卡片推送设置」**（bea2acb）:推送范围含订阅/储值线不全是免费；四语词条同步。
- **i18n 死词条全量清理**（8c8683a）:86 条无引用旧文案 ×4 语移除（1783→1699）；两轮核验防误删（转义归一 + 标点归一 + 前缀碎片匹配）。
- **面板主题切换崩溃（白屏）**（d020c19）:捐赠二维码日夜双主题改造时 `applyDonateQrTheme` 定义位置落在 `applyTheme` 调用之后，暗色主题下函数不可达直接 ReferenceError——面板整页白屏。调整定义顺序修复。
- **面板 HTML 缓存错位**（df1d1a6）:重装新版后浏览器仍渲染旧缓存的面板 HTML，用户看到的功能与安装版本对不上（按钮行为错乱、新功能不存在）。`/` 与 `/index.html` 响应加 `Cache-Control: no-cache`。
- **豆包客户端指纹伪装**（2e53bb1）:纯网页 cookie 用裸 UA 打活动接口吃「请求非法」——UA 与 URL 平台参数对齐桌面版 webview 指纹后接口放行。
- **minimax 外配额卡 source 挂靠纠正**（80a98ce）:此前误挂订阅线 minimax-code 同名卡（外部配额与连接卡互相踩），改挂 `minimax-free` 独立卡。

### ✨ 新功能

- **豆包快捷入口（issue #32，随本版收敛为最终形态）**:网页 cookie 的额度读数与签到状态实测残缺（累计恒 0、状态不可信），按用户拍板**收敛为纯「打开豆包」快捷按钮卡**（entryOnly）——无捕获、无探测、无账号行，签到动作归还用户在官方页面完成；CD 不代签。接口形状勘探过程（CDP 实测 / 纯 cookie 鉴权 / 仅个人账号门槛）沉淀在 cookieSites 框架能力里（method/body JSON API 探测先例）。
- **多语化更新日志（en / ja / ko）**（975f62f / ce6558c）:CHANGELOG.en.md / ja.md / ko.md 随包分发；桌面壳「更新日志」弹窗按面板语言优先拉对应语言文件（raw.githubusercontent 按 tag 拉取），缺该语言段落时回落 Releases body（简中主文）；语言路由 en→en、ja→ja、ko→ko，zh 系走主文件。
- **捐赠支持弹窗**（b8c8d8f，随本版首发）:四渠道（爱发电 / 支付宝 / 微信 / GitHub Sponsors）与 10Router 一致，二维码 SVG 日夜双版本（dark 白码衬深底、light 黑码衬白底，背景矩形与码体分离着色修掉黑底黑码）。
- **MiniMax 免费额度卡回归 10Router + 只读签到状态推送（issue #33，方案 B）**:撤掉每轮推送对 minimax-code 卡片的清理（此前 10R 下架 minimax-free 后无挂靠点而停用），恢复推送并在每行配额带 `checkinToday` / `streakDays` 只读字段——凭据不出 CD，10R 只展示（徽章渲染由 10Router#77 消费，旧版 10R 忽略未知字段向前兼容）；**签到动作不进 10R**（只读边界）。新增 `fetchMiniMaxCheckinStatus` 只查不打 claim，失败返 null 不炸推送。免费卡改按账号单卡（6ebcc52，minimax-code 同款单值卡：卡面副标题账号名）。
- **WorkBuddy 临时活动批量领取**（ec95ffa，随本版首发）:新增 `POST /api/workbuddy/claim-activities` 批量领取临时活动（额外补偿 / 首月赠礼），面板一键领全部账号。
- **网页会话探测频率治理**（ec95ffa，随本版首发）:面板 2 分钟轮询不再全量轰上游，`/quota` 默认读缓存快照，仅手动「刷新积分」真探；后台推送循环顺手保鲜快照。

### 🔧 移除

- **WorkBuddy 国际版「活跃领取」机制整体下线**（口径此前已定）:逐日主动打上游对话接口博活跃资格的灰色路径删除（服务端已收紧识别，issue #34 实证「请求非法」）——`checkinWorkbuddyIntl`、签到轮 wbActivity 开关与设置项、面板活跃统计 UI、行为测试与 18 条死词条 ×4 语全部清退；**workbuddy-intl 产品线保留**（登录 / 额度 / 赠送包余量 / 到期提醒 / 10R 推送照常），国内版每日签到不受影响。国际版积分获取引导改用官方网页版定时任务（codebuddy.ai/agents，#34 回复口径）。
- **Inception Labs（Mercury）线整体移除**（issue #35，4c5c704 / ec54138）:Cloudflare 对代理出口 `/api/*` 持续 429，签到与额度轮询反复空打刷 401/429 报错——网页会话线与免费额度卡整体删除，**disabled 站点彻底断探测**（live quota / 重探路由直接 410）、面板整卡隐藏（用户预期是看不见而非置灰）、daemon 启动一次性清理孤儿账号（照 minimax-intl 先例）。
- **「登录捕获」按钮改名「网页版」**（81b02e0）:更贴近用户心智——点它 = 打开该站网页登录；网页会话站点 label 只留品牌名（去掉「免费额度/控制台余额」等后缀，翻译负担与视觉噪音）。

### 🐛 修复

- **Trae 签到 9074 换设备号重试（issue #31 报告者实测路径）**:对照实验证实派生设备号被服务端一律拒 9074、同一时刻真机号可领——重试时**轮换派生设备号**（attempt 递增），退避 3s/8s/15s 叠加换号。⚠️ 派生 salt 变化使 attempt=0 默认指纹一次性全量轮换（旧号已被服务端标记，必要代价）：**升级后首轮签到若仍见 9074 属预期**，重试机制会自动换号，多轮后趋稳。
- **更新日志弹窗体验**（f67c468 随本版首发）:点击即开窗带「加载中…」；在线拉取认「本版主题:」格式（1.5.1 条目此前只剩标题）。


---

## [1.5.1] (2026-10-18)

本版主题:**Trae 签到 9074 风控口径纠正（issue #31）——瞬时限流退避重试,不再误标「本机已领」+ 失败提示带服务端 code + 网络错误聚合双路原因**。无破坏性变更,可直接升级。

> **热更新说明**（同日重发）:首发的 1.5.1 更新日志弹窗有一处展示缺陷（在线拉取不认「本版主题:」新格式致条目只剩标题、且无加载态）,随本版一并修复并**替换全部产物**——同版本号重发,已装首发 1.5.1 的用户点「检查更新」可能提示已是最新,介意者从 Release 重装;exe 功能面（签到/额度/网关）与首发版完全一致,仅弹窗展示不同。

### 🐛 修复

- **「更新日志」弹窗无加载态**:点击后要等在线拉 GitHub Releases API(最长 10s 超时)返回才开窗,期间零反馈形同「点了没反应」。改为点击**立刻开窗**显示「加载中…」,数据到达后填充;在线拉取失败回落随包 CHANGELOG.md,窗口不空白。
- **更新日志在线拉取只剩标题**:desktop 的 release body 解析只认 `>` 引用行当主题行(1.5.0 的发版说明恰是该格式),本版起改用「本版主题:**…**」行内格式后,在线拉到的条目只剩版本号没有主题——只有本地回落解析认得新格式。现在线路径两种格式都认(全角/半角冒号兼容)。配套 i18n 四语补「加载中…」hint 词条。
- **Trae 签到 9074 误判「本机已领」且当天不再重试（issue #31）**:实测 9074 的服务端文案是「当前参与用户太多,请稍后再试」= **瞬时限流**,此前却按 Qoder 设备限领语义归 `limited`——面板徽章挂「本机已领」（黄标误导）、且写入当日签到记忆后当天不再重试,限流明明过一会儿就能过。改为 9074 自动退避重试（3s/8s/15s 共 4 次尝试,过程落运行日志）,重试耗尽归 `failed` 且**不写签到 memo**（下一轮自动签到继续试,当天仍有机会领到）。顺带:业务失败提示统一附服务端 code（`（code 9074）`）,此前 9074 之外的风控码全被 message 吞掉;服务端返回「已经签到」类文案归 `already`（面板显示「今日已领」而非红字失败）。
- **`fetchJsonRace` 双路失败只抛最后一条错误**:直连失败回退代理再失败时,面板只见代理那条（如 `connect ECONNREFUSED 127.0.0.1:3213`）,直连那路的真实死因被掩盖,排查方向直接被带偏（issue #31 附带）。现双路都失败时聚合为 `直连: xxx；代理: yyy` 再抛（在最后一条错误对象上改写 message,保留 `err.code` 与 instanceof,调用方判定不受影响）;单路场景与既有测试断言不受影响。
- **logger 运行时加固**（6035938,原挂账 [Unreleased] 随本版发出）:跨轮换的旧归档流挂了 error 兜底、新建的当前流漏挂——Windows 写盘异步 EBUSY/EPERM 时未捕获 error 事件会掀翻 daemon 进程（概率低但真实）。



- **WSL2 镜像网络端口冲突修复**：WSL2 镜像网络模式把一段端口圈进 Hyper-V `excludedportrange`（实测 47860~47870 落进去），Windows 端 bind 直接 EACCES——应用根本拿不到绑定权限，daemon 起不来。改为启动时用 `netsh` 查系统保留段、从 47860 起挑第一个空闲端口（确定性选择，不漂移，10Router 网关节点 / 书签硬编码端口不断）；bind 重试同时认 EACCES + EADDRINUSE（原来只认后者，落保留段直接放弃）、窗口 10→100 逃出大保留块、整段不可用时回退 OS 随机空闲端口（端口记进 daemon.json）。netsh 不可用时退化为 +1 重试，跨平台不受影响。
- **网页会话探测频率治理**：面板 2 分钟自动轮询曾把五家上游（Token Harbor / 小米 MiMo / River / ModelScope / LongCat）全量 live 轰一遍（日志「就地重探通过」刷屏）。改为 `/api/accounts/:id/quota` 默认读缓存快照零网络，仅 `?live=1`（手动「刷新积分」按钮）才真探上游并回填快照；后台推送循环（默认 60 分钟）live 拉到的余额顺手落库 `meta.quotaSnapshot` 保鲜缓存。上游实际探测频率从「面板开着每 2 分钟」降到「后台每 60 分钟 + 手动」，面板显示与呼吸灯不变。
- **WorkBuddy 临时活动批量领取（额外补偿 / 首月赠礼）**：新增 `POST /api/workbuddy/claim-activities` 用已存 Bearer 凭据批量领取（先查状态、只对 active && !claimed 的发领取请求，幂等多号安全），面板 WorkBuddy 页新增「领取活动」按钮一键领全部账号——免逐个网页点击。端点事实源 = usercenter bundle（`/billing/meter/compensation-status` / `claim-compensation` / `check-gift-claimed` / `claim-gift`），实测 Keycloak Bearer 直接可用（无需网页会话 cookie）。附 `GET /api/workbuddy/activities` 预览可领项。
- 【待发】logger 运行时加固（6035938）已随 1.5.1 发出。

---

## [1.5.0] (2026-10-15)

本版主题：**网页会话捕获全线落地——通用浏览器 cookie 捕获框架（配置驱动）+ Token Harbor / 小米 MiMo / River AI / ModelScope 魔搭 / LongCat 五家接入 + 10Router 额度卡同步（同名认领 / 就地重探 / 手改备注名保护）**。无破坏性变更，可直接升级。

> **发版说明**：原「1.4.1」批次（2026-10-11，通用浏览器 cookie 捕获 / Token Harbor 免费额度首个接入）**无 git tag**——此前误发的 npm 1.4.1 已撤回（挂「已撤回」deprecation），该批次日志整体并入本版随 1.5.0 发布，各清单末尾以「原 1.4.1 批次」标注来源。10Router 侧配套需要 **≥ v1.4.1**（外部配额白名单放行 `isCreditBalance` / `summarizesDetail`、储值卡名条）。

### ✨ 新功能

- **外配额卡「刷新配额」回调接口（与 10Router 联动）**：推卡载荷新增顶层字段 `refreshUrl`——10R 外配额卡的刷新按钮 POST 它即可让 CD **现拉该 source 的最新余额并重推**（`POST /api/quota-refresh?source=…&exp=…&sig=…`，单路 `onlySource` 过滤，签名随每轮推送滚动）。安全模型延续「凭据材料禁止入载荷」：URL 里**无裸令牌**，`sig = HMAC-SHA256(quotaRefreshToken, source+exp)`，密钥只存本机 settings.json；8 天过期（覆盖 10R 快照 7 天 TTL）；触发口自带签名鉴权（不走面板密码门）、单 IP 20 次/分限流、CORS 放行浏览器直连。10R 侧为独立分支 PR（techysy/10router#63：白名单放行 `refreshUrl`（仅 http(s) 标量）+ 外卡按钮回源 + 旧推送无字段降级重读，原有连接卡 refreshProvider 链不动）。
- **网页会话「就地重探」**：账号行新增重探按钮（`POST /api/cookie-sites/:id/reprobe`）——用已存会话 cookie 重跑「身份 + 余额 + 流水拆分」回填行，**免登录窗重捕**（身份解析失败 / 额度过期时一键修复）；ModelScope / MiMo / River / Token Harbor 四线全支持（HTML 探针站点顺带刷新身份与读数），重探后自动推一轮额度卡。
- **ModelScope 魔粒拆分显示（今日/长期）**：卡片把余额拆成「今日发放 X（1 天有效）/ 长期 Y」两腿（发放记录 `transactions` 按 `expire_days<=1 且今日获得` 归今日，长期 = 总额 − 今日吸收消耗误差；官方口径 300 = 200 + 50 + 50），面板胶囊同步显示拆分；拿不到流水回退单值。用户面文案统一官方名「魔粒」。
- **ModelScope 魔方余额接入（CD#25）**：魔搭（modelscope.cn）进「网页会话」捕获线——会话 cookie 读 `GET /openapi/v1/magicubes/balance`（字段 `total_balance`/`available_balance`，卡面取 total 对齐官方「My Magicubes」口径），余额数字推 10Router 储值计数卡（同名认领可挂连接卡）。端点事实源 = 前端 86 chunk 考古：**每日魔方额度为登录自动发放，无签到动作端点**（「Login Reward」入账提示弹层），故不做签到自动化，只做余额可见/推送；身份走 `POST /openapi/v1/auth/check` + 邮箱正则兜底；解析失败时错误信息携带响应字段名（防字段演化盲摸）。配套回归 6 项；测试顺带加固：`fetchJsonRace` 在配代理时会与真实网络竞速，直连调用一律显式注入 `fetchImpl` 消除偶发真网 401 抢跑。
- **「网页会话」账号行改名入口**：此前只有删除按钮，别名无处可改（10R「同名认领」的匹配键落不了地）——账号名现在可点改备注名（与主账号卡同款 `uiPrompt` + `PATCH /api/accounts/:id`），网页会话型账号（river / MiMo / Token Harbor）改完**自动立即推一轮额度卡**，label 随别名更新、同名认领不等下一个推送周期。
- **推卡 label 跟随账号别名（配合 10R「同名认领」）**：River 与小米 MiMo 的 external-quota 推卡 label 改为**账号别名优先**（捕获默认名不变：`River AI (邮箱)` / `Xiaomi MiMo (UID: …)`）——在 CD 改账号别名与 10R 连接同名，余额即挂上该连接卡显示，推送卡自动让位。
- **River AI 免费额度接入（网页会话 localStorage 变体）**：console.river.ai（$25 免费额度）进「网页会话」捕获线。与 Token Harbor / 小米 MiMo 的 cookie 线不同：console API 只认 WorkOS SPA 的 localStorage JWT（`Authorization: Bearer`），`rv_` API key 只能打 api.river.ai 的 OpenAI 兼容面**看不到余额**——desktop 收割升级出 **localStorage 凭据变体**（`site.storageKeys` 同源读 `workos:access-token` / `refresh-token` / `expires-at` / `user`），daemon 用余额 API 调用本身做探测（`GET /api/billing/account` → `balance_usd`）并按邮箱归户。WorkOS 单次轮换刷新链内置**无回调自动原子落盘**（与 MiniMax 同款防护，旧 refresh 刷新即作废、新链当场写盘）；额度卡推 10Router 为储值余额卡（`Balance (USD)`，`isCreditBalance` + `summarizesDetail`，10R 侧外部配额白名单同步放行 `isCreditBalance`）；会话失效降级 message 状态卡。回归测试 7 项（解析 / 余额 / 刷新落盘 / 401 重试 / 载荷标量 / 推送链）。
- **面板一级标签「免费额度」（额度池独立成页）**：Token Harbor 等「凭据只在网页会话」的供应商从 10Router 页签的「Cookie 会话」弹窗升级为独立标签页（`#view-free`，注册进组件显隐/排序体系）——顶部汇总会话总数与供应商数，逐供应商卡片列出已捕获身份、捕获时间，支持逐行删除；「同步到 10Router」「刷新状态」直达操作；10Router 页签的原入口改为直达该标签。捕获成功事件同步刷新新页。
- **接线 10Router 通用额度推送接口（issue #24）与小米 MiMo 控制台充值余额抓取（issue #26）**：
  - 小米 MiMo（issue #26）：在「免费额度」专区接入小米开放平台（`platform.xiaomimimo.com`）控制台会话捕获，登录后自动请求 `userProfile` 提取账号 UID 与昵称归户，并请求 `balance` 提取实时充值可用余额；通过外部配额规范（source: `xiaomi-mimo-{userId}`）推送至 10Router 配额追踪器显示单值余额卡（`provider: "xiaomi-mimo"`，与 10R 品牌图标及筛选精准对齐）；
  - Token Harbor（issue #24）：捕获时从隐藏窗探针 HTML 抽取读数存 `meta.quotaSnapshot`，出行并带重置倒计时（超期自动降级 message 状态卡）；
  - MiniMax Code（issue #24）：免费线算力币读数，弥补 10Router `minimax-free` 路由卡自身无法查配额的盲区；
  - 零凭据安全纪律：出口强校验（`assertScalarOnly`），只发标量数字，凭据永不出载荷；随后台调度自动推送 + 免费额度页一键推送。单元测试 15 项全绿。
- **10Router 额度主动刷新 + 推送设置归入「免费额度」页**：
  - 主动拉取：在 10Router 页点击「刷新额度」时，由过去的纯读取变为**先主动向 10Router 推送一次 CD 最新解析好的额度卡，再拉取全量额度**（即点即显最新数字，不再单向干等后台被动轮询）；
  - 设置归位：推送频率与开关归入「免费额度」主页面工具栏的「推送设置」专用弹窗（`#m-free-settings`，支持 15 / 30 / 60 / 120 / 240 分钟，并可一键立即推送），符合用户在管理免费资产时的直觉心智；10Router 页的弹窗恢复纯粹的用量同步定位。
- **网页会话链路自愈闭环（探活心跳 + 死会话低频重试 + 陈粮标注）**：后台每轮额度推送本就 live 拉全部账号——探活结果却丢在推送循环里，面板呼吸灯要等用户手点才更新、死会话永久躺平不重试。三条闭环：① **推送循环回写探活痕迹**——live 结果（成功/401/网络失败）顺手落 `meta.lastProbe`（fire-and-forget 串行队列，不阻塞推送；10R 回调路径 `noProbeMark` 防自环），呼吸灯从此有后台心跳；② **死会话低频重试**——`lastProbe.status==='dead'` 的账号 6 小时内跳过 live 拉取（照常推状态卡，少打上游），过 6 小时再试一次——网站恢复/误判自愈时自动复活；单卡回调（用户显式刷新）不跳过必须真试；③ **快照陈粮标注**——快照回退（非 live）且距今 >24h 时，卡面 plan 副标题带「（数据 M-DD HH:mm）」，四家储值站（MiMo/River/ModelScope/LongCat）同款，避免把三个月前的余额当好粮挂卡面。回归 3 项（回写+noProbeMark 不覆盖 / dead 跳过+单卡不跳过 / ageTag 三态）。
- **LongCat（美团）Token 资源包接入（issue #29）**：第 5 个网页会话站点（纯只读——资源包为购买/赠送发放，无签到动作端点）。凭据 = longcat.chat 会话 cookie（美团账号体系 SSO），cookie 直连打平台 API（fetch wrapper 只加 Content-Type + x-requested-with，无 Bearer/CSRF——chunk 考古 + 登录态实测；未登录 401「用户未登录」归会话失效）。数据端点 `POST /api/pay/quota/metering/token-packs/summary`（currentLot + otherLots 全部 ACTIVE 包；`/commercial/entitlements/token-packs/list` 实测空分页壳不采用）；身份打 `GET /api/v1/user-current`（`{code:0,data:{userId,uid,name}}` 双标识——userId 为 LongCat 侧、uid 为美团侧，都留档；fail-soft，解析不出走无身份单例不阻断捕获）。卡面 = Balance 汇总行（全部 ACTIVE 包 remaining 之和，储值口径 isCreditBalance + summarizesDetail）+ **逐包 detailOnly 明细腿**（每包一行带面值/赠送徽注/到期日/已消耗百分比，按 consumeOrder 排序——官方消耗顺序：购买包未动时优先烧赠送包），行带 `giftPack` 标志（10R 白名单已放行，quota key 正则同步放宽到 CJK——官方包名「赠送资源包」就是 key）；全部包耗尽 → message 状态卡；快照兜底带陈粮标注。推 10Router 只带 token 数字，会话 cookie 只存本机。回归 8 项（summary 解析 / 探测三结局 / 身份双标识 / 卡面形状 / giftPack / authInvalid 降级 / 陈粮标注 / onlySource 推送链）。
- **Trae 多账号签到（issue #28）——每号独立设备码**：本机导入的 N 个 Trae 账号共用同一台物理客户端的 `meta.deviceId`，签到请求 `x-device-id` 全同 → 服务端按设备限每日一领，第二个账号起吃 9074（社区 TraeTools 的「设备码切换」本质就是给每号换设备码）。改为 `x-device-id` 按 uid 确定性派生（每号独立、稳定恒定、纯数字合规），不再采用客户端自报值——纯请求头改动，不碰 Trae 客户端与本机登录态快照。回归断言：多账号同 stored 设备号时派生结果互异且稳定。
- **网页会话账号行探活灯（三色呼吸灯）+ 重探失败落运行日志**：账号行呼吸灯原是**恒绿**（写死 `dot on`）——会话已死的行看不出任何异常。重探结果现落 `meta.lastProbe`（GET /api/cookie-sites 回显），面板按它渲染三态：**绿=上次重探通过 / 黄=探测失败（网络或结构变化，旧数字仍挂着）/ 红=会话失效（401/403，需重新登录捕获）**，悬停 tooltip 带失败原因与时间。重探的每行失败同时落 `COOKIE-SITE` 运行日志（原先失败只 toast 一闪，日志时间线无迹可查）；探活痕迹写入 await 串行队列排空，避免跟调用方的直写文件竞态。

**原「1.4.1」批次（2026-10-11 · 无 git tag，日志并入本版）：**

- **通用浏览器 cookie 捕获（配置驱动，issue #23）——首个接入方：Token Harbor 免费额度**：`src/cookieSites.js` 站点配置表（登录页 URL / 收割域 / 探测规则），桌面壳无痕登录窗关闭时按站点通用收割全量 cookie（plain string 形状），daemon `POST /api/cookie-sites/:id/capture` 带 agent 探测（401/403 → 拒绝、缺配额标记 → 重试、网络异常 → 502，探测走 `fetchJsonRace` 跟随全局代理——Token Harbor 对大陆/港澳有封锁）。入库按 provider 单例合并（重复捕获原位更新），同步进 `TENROUTER_PROVIDER_MAP` 并经 `buildConnPayload` 按既有 `providerSpecificData.creditDaddyWebSession.cookie` 形状推给 10Router（与 qoder 老形状并存，零兼容回归）。面板 10Router 页签加「登录捕获」行（已捕获时间 / 未捕获提示；无桌面桥时按钮禁用并注明需桌面版无痕窗）；捕获成功经 preload 事件回落，自动刷新行与额度。回归测试 6 项（拼串去重 / 探测四结局 / 载荷形状 / 页签隔离 / daemon 全链路 / 单例合并）。上线形态经复查调整为：10Router 页签 actions 收拢为「Cookie 会话」入口按钮 → 弹窗逐供应商列出（与后续供应商扩展对位）。

### 🐛 修复

- **Qoder 网页会话无法在 CD 侧更新（10R 卡「网页会话已失效」的账号走「浏览器登录」刷新 = 死路）**：`attachPendingWebSession` 旧守卫「账号已有 `qoderWebSession` 就 return false」——重新登录收割的新 cookie 被 pending 暂存后**永远挂不上**（暂存项成死信），会话过期的账号无论重登多少次都带着旧 cookie。E2E 复现钉死：已有旧会话 + 重新授权（token 轮换）→ cookie 仍是 `OLDCOOKIE`。修复：新收割的会话**无条件替换**旧会话（刷新语义，与 cookie-site 捕获的原位更新对齐），暂存项消费后清空。回归 1 项（替换 + capturedAt 刷新 + 暂存不残留）。
- **产品页「刷新积分」对网页会话账号无效（502 且呼吸灯不动，重探后才变绿）**：cookie-site 五家（Token Harbor / MiMo / River / ModelScope / LongCat）不在 `PRODUCTS` 能力表里——`/api/accounts/:id/quota` 端点 `productImpl(...)` 拿 `undefined` 直接崩 502，既不拉新余额也不写探活痕迹（lastProbe），呼吸灯只有点「重探」才会变。修复：重探的「live 拉 + 回填 + lastProbe」逻辑抽成共享函数 `reprobeCookieAccount`，`/quota` 端点对 `meta.cookieSiteId` 账号改走它（响应归一成统一 quota 结构：API 站 total=余额、HTML 探针站 remaining=100−used），产品页「刷新积分」按钮从此对五家全部可用且呼吸灯同步刷新。回归 1 项（HTTP 栈全链：quota 200 + lastProbe.ok + 快照回填）。
- **重探/推送失败时 10R 卡面是「瞎」的（死会话挂旧数字）+ 重探触发全量推送**：① 三个储值卡 builder（MiMo / River / ModelScope）在 live 拉取失败时一律回退旧快照数字——会话已死的账号照样把旧余额推上 10R，且每轮推送都刷新 `pushedAt` 连 7 天快照 TTL 都不会过期，10R 侧永远看不出失效。现区分两类失败：**auth 失效（401/403）不再回退旧快照**，推 message 状态卡「会话失效，请重新登录捕获」（River 的刷新兑换链各通道失败结论同样透传）；**网络抖动 / 5xx 仍保留旧数字**（瞬时故障不该清空卡面）。② 就地重探结尾的额度卡同步原是**全量**（tokenharbor + 全部 MiMo/River/ModelScope 每账号 live 拉一遍），现 `pushQuotaCards` 支持 `onlySources` 数组，重探只推涉及的 source（失败行也纳入——失败恰说明会话可能已死，要把状态卡推上去）；单卡回调的 `onlySource` 过滤同样先于 live 拉取生效，别路 source 不打上游（river 侧不再白烧 WorkOS 单次轮换）。回归 3 项：auth 失效降级 message 且不带旧数字、网络失败保留快照、`onlySource` 数组多路过滤。
- **「刷新配额」回调浏览器直连被跨站闸误杀（全量审查逮到的回归）**：`/api/quota-refresh` 本是 HMAC 自鉴权、设计上供 10R 卡片按钮**浏览器直连**（Origin 必然是 10R 站点），却被入口的 `rejectForeignRequest` 跨站检查提前 403——POST 进不到签名校验，OPTIONS 预检同死，按钮点了只回落「重读快照」。修复：该路径豁免 Origin 同源检查（防伪交给签名 + 单 IP 限流），Host 闸照常（防 DNS 重绑定）；其余 API 路径跨站照拒。另修 `runQuotaPush` 单卡回调（`onlySource`）原会在过滤前 live 拉取**别路**供应商余额（river 侧还可能白烧一次 WorkOS 单次轮换）——source 判定提前到拉取之前。回归：外站 Origin 的 POST/OPTIONS 走通 daemon HTTP 栈、其他 API 跨站仍 403、单卡回调不打别路上游。
- **手改备注名被自动名冲掉（刷新/重探/重捕后回退）**：改名保护原只靠 `meta.renamed` 标记——但**历史改名（旧包改的名）没有标记**，捕获/重探的自动命名照旧覆盖。加第二道闸：`isAutoGeneratedName` 自动名家族判定（站点默认名[+身份后缀] / `Xiaomi MiMo (UID: …)` / `River AI (…)` / `ModelScope (…)`），名字不在家族里 = 用户手改备注名，任何路径都不动；清空名则回填自动名（恢复自动命名的出口）。五处写名点（捕获归户 + 四条重探线）统一走双闸守卫，回归 3 场景（新改名 / 历史无标记改名 / 空名回填）。
- **ModelScope 身份未解析（卡名停在「会话」）+ 拆分全算今日（今日 300 · 长期 0）**：三根因——① 身份端点打错前缀：`/openapi/v1/users/login/info` 与 `auth/check` 实测 404，真身在 **`/api/v1/users/login/info`（Name）+ `/api/v1/users/info`（email / email_extra）**（前端 axios `baseURL:${host}/api`），两条互补合并；② 身份响应信封是**大写** `{Code,Message,Success,Data}`（前端 `accountInfo:(await Yi())?.Data`），解析只认小写 `data` 白搭；③ 流水有效期字段是 **`expire_days`**（前端行渲染 `e.expire_days>1 ? 有效期{days}天 : …`），代码认的 `days` 恒 undefined 折算成 0 天把全部 EARN 吞进今日——现按 `expire_days<=1 且今日获得` 归今日，缺失/0/90 天归长期。另修：行名更新原只认 `msSession.id`（邮箱身份解析出也不改名），且捕获/重探会覆盖用户手改的备注名（10R 同名认领键）——现身份任一字段（id/email/name）即更新行名，且 `meta.renamed`（PATCH 改名入口留痕）保护手改名永不被自动名覆盖。
- **全局代理的启动日志仍标「ZCode 出口」（历史遗留命名）**：代理/出口早已是全局（Qoder / ZCode / cookie 探测等全部出口都走它，面板设置也已正名「网络出口（全局）」），但 `/api/zcode-gateway` 保存时的 DAEMON 日志模板还挂着 ZCode 名头。日志改为「网络出口（全局）:{route},ZCode 自动领取:{claim},代理 {proxy}」（自动领取确属 ZCode 功能，保留归属），两处过时注释与四语词条同步正名。
- **River 捕获失败（WorkOS 会话通道判错）**：实测 console SPA 的 WorkOS token 只存**内存 Map**（localStorage 空、cookie 里没有 token 本体）——初版按 localStorage 键收割必空，daemon 拿不到凭据静默 400；二轮（cookie 授予兑换）又因按 URL 过滤收割漏掉 Path 域会话 cookie，被 WorkOS 拒 `Missing refresh token.`。修复：① **CDP 截获 `/user_management/authenticate` 响应体**（access + refresh + user 的唯一可靠出口）→ 以 storage 同形键进收割管道；② cookie 收割改 **`cookies.get({})` 全量**（Path 域 cookie 不再被过滤），盘点日志带 cookie 名单（只记名不记值）；③ 余额探测三通道递进——cookie 直连（不混发失效 Bearer）→ Bearer → refresh 兑换，各通道失败原因进日志，兑换新链单次轮换即时落盘；④ 静默分支全量补日志。
- **「网页会话」卡片账号行沉底**：站点卡 `justify-content:space-between` 在网格行被最高卡撑高后把单行账号推到卡底（MiMo 单会话卡尤甚）——改 `flex-start` 顶部对齐。
- **小米 MiMo 外部卡逐包明细首行是汇总句（同一数值印两遍）**：汇总行「现金余额：¥ 0.00 · 赠送余额：¥ 32.88 (CNY)」漏进逐包明细当首行，与「赠送余额」行各印一遍 32.88/32.88。修复：① Balance 汇总行标 `summarizesDetail`（10R `isSummaryRow` 将其从逐包明细丢掉，只出大数字 + 副标题）；② 现金 / 赠送两腿对位出行（0 腿也出，逐包明细两行 = 副标题两腿），`detailOnly` 不进汇总池不扰动单值沉淀。需 10Router v1.4.1 侧配套（外部配额白名单放行 `summarizesDetail`、储值卡名条保留），旧版 10R 上汇总行仍会漏进明细。
- **「网页会话」页卡片恒「加载中」**：`renderFreePool` 里 Token Harbor 重置倒计时调用了从未定义的 `shortDuration`，命中即 `ReferenceError` 打断整段卡片渲染——顶部汇总数字先写已就位（会话总数 / 供应商数可见），卡片体永远停在占位符。改用面板既有 `relReset`（「3 天 4 小时 后重置」同款文案）。
- **MiniMax / WorkBuddy / mirasim 单次轮换 refreshToken 内存丢失导致「1 天后必作废」根因修复**：MiniMax accessToken 寿命仅 1 小时，每次刷新服务端执行单次轮换（Single-Use Rotation），旧 refreshToken 立即在服务端失效。若后台轻量调用（如额度卡推送、离线探测等）未显式传 `onRefresh` 回调，新 refreshToken 仅更新在内存中，未持久化写入磁盘；下一次调用重新从磁盘读出已作废的旧凭据，服务端当场报 `invalid_grant: this refresh token can no longer be used` 并被熔断守卫拉黑（用户误以为“refreshToken 寿命只有 1 天”）。修复：① `refreshAccountToken` / `workbuddy` / `mirasim` 客户端内部增加**无条件自动原子持久化兜底**（只要账号有 ID，换到新凭据立即写入 `accounts.json`，绝不依赖上层是否传回调）；② `minimaxGateway` 401 重试统一收拢到 `refreshAccountToken`（享受并发互斥与自动落盘，根除并发请求打烂刷新链）；③ `tenrouter.pushQuotaCards` 显式包裹 `refreshContext`。回归测试覆盖无回调自动持久化。
- **MiniMax 网关 402 余额不足被误归「上游错误」、无冷却导致刷屏重试**：免费额度耗尽时上游回 `402 insufficient_balance (1008)`，此前落到兜底分支——日志只显示「上游错误×2」，且账号不进冷却，每个请求都把已空号全部重打一遍（10-12 用户报告刷屏）。现在 402（或响应含 `insufficient_balance`/余额不足）明确归类**额度耗尽**：账号冷却 30 分钟（对齐 ZCode 网关口径，远长于 429 的 5 分钟——额度耗尽不会分钟级恢复），摘要显示「额度耗尽×N」，冷却期内直接 503 提示「N 个临时冷却中」不再打下游。回归测试 2 项（双空号冷却 + 混合号只冷却空号）。

**原「1.4.1」批次（2026-10-11 · 无 git tag，日志并入本版）：**

- **Token Harbor 捕获被「假空壳」误拒（首版探测头缺失）**：探测 dashboard 裸发 `undici` 默认 UA，边缘节点直接喂 HTML 空壳——`Free allowance` 标记不在壳内，登录明明成功也报「登录未完成」。探测头按 10Router `services/usage/tokenharbor.js` 同款浏览器形补齐（Chrome UA / Accept-Language / Referer / Upgrade-Insecure-Requests）；会话过期被挡回登录页与「页面结构变化」分开归类（前者 = 会话失效，与 10R 的 AUTH_EXPIRED 对齐）。
- **捕获失败时面板弹窗无回显**：此前仅托盘气泡提示。现在桌面壳把服务端拒绝原因（401/422/502 分级的具体文案）转发为面板事件，弹窗 toast 落详情；弹窗保持打开可立刻重试。
- **Token Harbor 同步落点挂错卡（监控卡 ≠ 钱包卡）**：初版把会话同步到 `tokenharbor`(sk- 钱包卡走 /v1 transport，cookie 当运输 key 必败）；issue #23 点名的是 `tokenharbor-free`（注册表 freeTier，只做额度监控不走路由）。同步映射收口 `tokenharbor → 'tokenharbor-free'`。已知限制：apikey 通道同名连接 409 只「已存在」不覆盖，重新捕获的 cookie 轮换需 10Router 侧允许「冲突原位更新」或在 CD 走连接编辑接口（10R 注释的既有约定，另行处理）。
- **Token Harbor 探测假阴根因修正——探测改走「同会话隐藏 Chromium 窗口」**：Node fetch 即使补齐浏览器头也只拿到风控挑战/客户端渲染空壳，`Free allowance` 根本不在文本里，登录明明成功也判会话无效。桌面壳在无痕收割后**用同一隐私会话再开隐藏窗** 加载 dashboard（轮询配额标记最短 500ms/最长 20s），把浏览器视角 HTML 随 `probeHtml` 上探——探测与真实浏览器完全同视角；CLI/非桌面环境回退原 Node 探测。探针未中时把页面前 120 字写进 `COOKIE-SITE` 日志便于区分挑战页/登录壳/结构变化（调试态）。
- **弹窗「已捕获」状态永不更新（状态数据源用错）**：行状判定依赖脱敏视图 `state.accounts.meta`——`publicAccount` 根本不返回 meta，行恒为「未捕获」。改为直接消费 daemon `/api/cookie-sites` 返回的 `capturedAt`，与捕获落盘是同一份真相。
- **Cookie 会话捕获按「身份归户」多账号轮换**：初版把免费站会话按单例合并（异身份覆盖旧行但悲剧免费账号轮换的初衷）——身份从浏览器探针 HTML 里抽取（零新请求），归户键 `(siteId, identityHash)`：同身份=凭证轮换原位更新，异身份=新行（每行独立 connName 带身份，10R 收成多卡同一供应商下多连接），无身份→单例。弹窗按账号列行（每行身份+捕获时间）。
- **Cookie 会话捕获按钮点不动（初版接线缺陷）：**入口按钮的委托分支从未真正写进 tr-panel 的点击链（编辑过程里的静默落空），整行区块拔掉重做——改为 actions 里的「Cookie 会话」按钮开弹窗（`m-cookie`），捕获按钮走弹窗内独立委托（`data-capture-site`），入口走 `data-tr="cookie-sites"` 既有链路。CDP 实拍：入口点击开弹窗、浏览器态捕获禁用注明需桌面、桥在场点捕获直达 `openAuthWindow(loginUrl)`。

## [1.4.0] (2026-10-10)

本版主题：**面板与运行日志多语言（5 语）+ 面板设置全面重构 + MiniMax / WorkBuddy 凭据健壮化 + 发版前安全加固**。新增 ⚠️ 升级注意（含两项行为变更），其余为向后兼容增量。

> **发布备注**：本 tag 经历了三次前移，以**确保 v1.4.0 的线上产物始终是修复后的代码**——①并入「密码关闭漏清哈希修复 + #21 构建身份」（f4c024c → 03ce630)；②并入「面板密码门 z 序死锁修复」（→ d5597c4)；③并入「密码区按钮死键修复（监听漏搬）」（→ 本段所属提交）。期间曾**错误地发布过 v1.4.1 并已撤回**（release/tag 已删）。**npm 侧**:`1.4.0` 为首版内容（不可同版本重发，已挂 deprecation),`1.4.1` 挂「已撤回」deprecation，为避免带病包被默认安装,**npm `latest` 已回退到 `1.3.2`**——npm 用户要 1.4.0 修复内容请走 GitHub Releases,修复随下一个版本号上 npm。

### ⚠️ 升级注意（先看这里）

- **LAN 白名单通配规则收严（行为变更）**：网关局域网白名单的 `*` 通配此前是裸前缀匹配，`192.168.31.1*` 会把 `.100-.199` 整段一起放行。本版起**通配段必须以 `.` 结尾**（`192.168.31.*`）或写精确 IP——已有前缀写法的白名单升级后不再匹配，请改成点段尾写法。
- **面板 fail-closed（行为变更）**：监听 `0.0.0.0`（网关开局域网、fnOS / NAS 部署）但**未设面板访问密码**时，面板 `/api/*` 与首页一律 403（此前仅 Host 校验 + 一行警告）。**升级后从局域网访问需要先在「面板设置 → 通用 → 面板访问密码」设密码**；本机桌面端与托盘操作不受影响。
- **面板访问密码 scrypt 化（不可回滚迁移）**：密码改为 `panelKeyHash = scrypt:<salt>:<hash>` 落盘，首次启动自动把旧的明文 `panelKey` 迁移为哈希并清除明文。凡在 `settings.json` 里直接读过 `panelKey` 的第三方流程需改用面板接口；面板本身的照常。
- **MiniMax 网关「一主一备」行为变更**：两个账号从逐请求交替改为**粘性主力选型**（详见修复）——看到主力固定且一段时间不切换，属预期行为而非异常。
- **发行产物改名**：统一加平台段（`CreditDaddy-Win-Setup-1.4.0.exe`、`CreditDaddy-Mac-Setup-<ver>-<arch>.dmg`、`CreditDaddy-FnOS(-Window)-<ver>-<arch>.fpk`），下载路径变化；应用内更新代码兼容新旧名，不受影响。

### ✨ 新功能

- **面板与运行日志五语国际化（简 / 繁 / EN / 日 / 韩）**
  - 词条以中文原文为 key 兜底（缺词条回原文，永不空白），五套词条随包分发；「外观」下方新增语言分组，聚合菜单与面板设置两处入口共用同一切换逻辑。
  - 日志改为 `logger.info(tag, key, args)` 存 key + 参数，`getLogs()` 按当前语言实时重渲染——切换语言后历史日志一并换语，不用重跑任务。
  - `scripts/gen-i18n-zhtw.js` 用 opencc-js 自动生成繁体词条，不靠人工维护两套。
- **i18n 词典漏网清零（+289 词条 ×4 语）**：机读全量扫描（`scripts/check-i18n.js`，注释/正则/转义感知的字面量提取）覆盖 src 运行时与面板的全部中文用户面字符串——日志模板、API 错误消息、额度/套餐/窗口/单位标签、密码门与切号确认、空态与 loading 文案、网关地址块、迁移/同步/设备身份全部入典四语；面板 toast 统一过 `T()`，任何词典内服务端错误消息自动随语言切换；额度行渲染点接 `T()`（plan / bottleneckLabel / q.name / unit / pack 名）。zh-TW 继续 opencc-js 转写。`scripts/release-check.sh` 挂为第 15 项硬门禁（有漏词条即失败）。
- **构建身份注入与「同版本新构建」更新识别（#21）**：打包产物（桌面 exe/dmg、npm 包、fnOS fpk）随包 `build.json`（version / commit / builtAt / channel）；`/api/status` 暴露 `build`，面板品牌区与托盘 tooltip 显示短哈希；release 附 `build-info.json` 资产，应用内更新在 **semver 相等时做平局裁决**——线上同版本但 commit 不同且构建更晚（同 tag 重推修复包）时提醒「检测到同版本新构建」，本地 dev / dirty / 无元数据一律回退纯 semver 旧行为。CI 三 workflow 已接线生成，npm 经 `prepack` 写入。
- **桌面壳（托盘 / 本机弹窗 / 通知）随面板语言切换（+79 词条 ×4 语）**：桌面 main 进程与内置 daemon 共用同一个 `src/i18n.js` 模块实例——托盘菜单、气泡与系统通知、「保存/更新密码」询问窗、面板密码验证窗、「已保存的密码」管理窗、右键菜单（复制/粘贴/全选/填充密码）、验证码与登录子窗标题、客户端探测错误等全部接入词典；面板切语言经 `settings.json` watcher 400ms 内即时重建托盘。「妙手」英译同时在 en/ja/ko 统一为官方名 **CatPaw**（去 Miaoshou/妙手 混用），桌面壳字符串同步纳入 `check-i18n.js` 默认门禁（豁免只剩 CLI 与解析锚点等非 UI 串）。
- **日志结构化归档与历史查询**：每条日志除 `.log` 外双写 `daemon-YYYY-MM-DD.jsonl`（`{at, level, tag, msg, key, args}`；gzip、7 天保留期同处）。面板「运行日志」新增「加载历史」按钮：`GET /api/logs?history=1` 突破环形缓冲 300 条上限、按当前语言实时重渲染当日历史。
- **直接导入 workbuddy-switch 备份（`wb-switch-accounts-*.json`）**：按 JWT issuer 自动识别国内/国际版（无需 provider 字段），从 `auth_raw` / `profile_raw` 还原完整会话结构（`meta.session`），导入后即可在面板一键切号到对应客户端。
- **面板设置全面重构（贴近按钮的下拉弹出层）**
  - 从全屏遮罩居中弹窗改为贴近齿轮下拉展开（`.setpop`，与聚合菜单同一视觉语言）；撤掉与菜单重复的项，「通用 / 组件与排序」两页签，默认回到通用。
  - **通用页新增**：全局自动签到开关与频率（1/2/4/8 小时，PUT 后守护立即重调度）；WorkBuddy 国际版活跃请求开关（关闭时定时轮与手动领取跳过全部 `workbuddy-intl` 账号，服务端过滤）；日志显示方式（默认展开/收起，本机记忆）；面板访问密码（设置 / 修改 / 关闭）。
  - **组件与排序**：组件显隐改点按整体切换（高亮 = 显示、置灰 = 隐藏）+ 拖拽重排（不再 ↑↓ 按钮）；排序提示语同步去掉箭头。
- **首次加载态**：面板首屏等待守护进程数据时显示居中的加载卡片（静态 HTML 立即可见），数据到达或 9 秒兜底后淡出；守护不可达时收起来并报错而非永久卡住。
- **语言切换加载态**：点语言分段立刻亮出「正在切换语言…」遮罩卡片，落盘与整页刷新期间常亮；失败收起、原语言保留。
- **头部主题按钮**：亮 ↔ 暗一键反转（每次点击必有视觉反馈），「跟随系统」不进按钮循环（菜单里走三态分段控件），按钮图标/提示按实际生效的亮暗显示。

### 🛡️ 安全与健壮化

- **刷新并发互斥与失效链熔断推广（`src/refreshGuard.js`）**：`minimaxClient` 原生的 in-flight dedupe + refreshToken 指纹熔断抽为公共守卫，workbuddy / mirasim 接入同一模式——面板额度查询与签到轮同链抢刷触发 `12153` / `invalid_grant` 的误杀从根消失。
- **跨进程单实例守护（ALREADY_RUNNING）**：启动前经 `daemon.json` pid + `/api/status` 探活（加一拍重试，防启动途中的瞬时假阴），有活实例拒绝起第二份。runtime 写入推广到前台 / 后台 / 桌面三种启动方式——两个实例共用 dataDir 时 accounts / state / settings 的跨进程覆盖被拆除。
- **面板访问密码三重加固**：scrypt 哈希落盘（见升级注意）；**连错 10 次锁 5 分钟**（按源 IP 退避）；桌面壳寄主改走 `getSessionKey()`（进程随机钥，重启失效）与 `verifyPanelPassword()`（走 scrypt 比较）——hash 模式下桌面壳内凭证不再依赖明文存在。
- **LAN 白名单通配规则收严**：三个网关所有 `e.endsWith('*')` 的通配必须承载点段尾（`192.168.31.*`）；不再支持裸前缀写法（见升级注意的行为变更行）。
- **Trae 网关事件流与额度权重**：事件流接入 `fetchJsonRace`（连接段 15 秒限时 + 出站代理统一），不再裸 `fetch` 无超时；quota 权重缓存改为 10 分钟 TTL + 失败保留旧快照。
- **fetchJsonRace 默认 `redirect: 'manual'`**：301/302 不再把 POST 转 GET 丢 body、307 不再原样重放凭据头的新地址（涉及三个网关的大 body 请求）。
- **Trae 网关 stop_reason**：流式与非流式 EOF / 断流 / reader 抛错统一报 `interrupted`，不再伪装 `end_turn`——客户端不再把截断的字当完整答案。
- **tenrouter.json 配置落盘走 store.atomicWrite**（Windows 杀软瞬时占文件直接 EPERM 的坑改掉）；`saveConfig` 改为 async，`withConfig` 串行加 await。
- **settings / state 损坏 JSON 读侧回退同目录 `.bak`**（断电半写不再让守护起不来），仍失败才以原错误上抛（不静默重置）。
- **ZCode 1005（名额已满）消费 `err.nextAt`**：以服务端 `plan.ends_at` 把该账号挂进跳过窗口（进程内缓存 + `account.meta.zcodeClaimNextAt` 双轨），自动轮询在该时间点前不再空打。
- **代理漏网收口（审计 M2）**：Qoder openapi（userinfo / quota / 活动列表 / 领取 / PAT→jobToken）与 WorkBuddy（billing / 国际版活跃探测 / token 刷新）统一走 `fetchJsonRace`——配置出口代理后这些请求也终于走代理（直连优先，报错才走代理兜底），**不带 `preferProxy: true` 的调用域**，行为跟设置了代理的机器不会变。`authDevice / qoderUmid / zcodeAuth / workbuddyAuth` 的认证流程继续保留直连（避免代理改 auth 路径的可变面）。

### 🐛 修复

- **MiniMax 本机导入与浏览器登录共用凭据链、互相作废（`invalid_grant`）**：`meta.authRecordKey` 既是「绑定本机客户端凭证链」的开关，又在账号合并浅合并时被嫁接给别的账号。现在本机导入不再写 `authRecordKey`，对齐前按 uid 归属自检（uid 不符直接跳过），刷新合并按 source 回收（非 `local-app` 一律清掉）。
- **MiniMax「客户端当前」登出后不消失**：`records` 为空时一律返回 null（不再回落 uid 缓存），缓存只在 record 仍存在且缺 `subject`/`accountId` 时启用。
- **MiniMax 网关「一主一备」逐请求交替刷屏**：SWRR 在两个账号积分接近时逐请求换人，主/备交替刷满运行日志。改为**粘性主力选型**：按剩余积分选主力并保持，仅当另一账号领先超过 10%（且绝对差超过 50 分）或主力拉黑/冷却才切换；幅度抖动不翻主力。
- **MiniMax 凭据链失效后的刷新风暴**：某条 refreshToken 被服务端作废后面板每 2 分钟一轮额度查询持续自动刷新——曾一晚打 400+ 次 `invalid_grant`。改链级熔断（失效链指纹在凭据更新前不再重试）。
- **WorkBuddy 本机导入不做服务端校验（过期凭据直进库，越用越坏）**：入库前用 refreshToken 打一次官方刷新接口——401 / `12153` / `invalid_grant` 直接 409 拒绝入库并提示重新登录，其他失败返回 502，过期凭据不再污染账号库（思路对齐 workbuddy-switch 的 `ensure_fresh_token` 与 `refresh_account_token`）。
- **面板样式三重修**:
  - 额度进度条 / 主题分段控件冲突（`.seg` 类名被两个组件同时使用）：主题控件塌成绿条、水位条只画一半——分段控件独立用 `.mode-seg`、`.seg` 归还水位条。
  - 设置弹出层与遮罩弹窗打开顺序错位（`m-changelog` 等浮在设置弹出层上）：`openModal` 打开任何遮罩弹窗前自动收起设置弹出层。点组件 chip 置灰会把设置弹出层一起关掉（重建的 `comp-menu` 把被点节点摘出 DOM，document 的点外关闭判定落空）→ 加了 `e.target.isConnected` 守卫：目标已被重渲染摘走的点击不算点外面。
  - 面板设置字体层级反了（提示与标签同字号 12px）→ 统一为三层：弹窗标题 14px/700 → 字段标签 12.5px/650 → 说明文字 11px/1.65 灰，`.comp-menu-title` 对齐字段标签；相邻段落于 `.sort-hint` 与 `.hint` 同字号灰。
- **语言切换点了不切换（`PUT /api/settings {locale}` 的 400 陷阱）**：面板语言没落盘前 `{locale}` 误入访问密码分支返 400，面板 `api()` 抛错导致加载态收起却不刷新——看上去就是「语言切换没反应」。分流按字段走密码分支，纯语言更新直接 200。
- **主题按钮图标不联动**：按钮点击走 `applyThemeMode → renderThemeMode`，但 `renderThemeButton()` 只在菜单分段点击路径手动补调——头部路径漏掉。现在 `renderThemeMode()` 是唯一同步点（分段高亮 + 头部图标一起更新）。
- **日志翻译各层残余中文** ——
  - 签到汇总（`签到汇总：成功 A（+B Credits）、已领 C、无活动 D、失败 E`）与 10Router 同步汇总、ZCode 引「条 Cookie」、WorkBuddy 次元申请等从运行期拼出的整句，走 key+args 翻译。
  - 复合标签 `[WorkBuddy 国内版] / [Qoder 国际版]`：整串不可能进词典，用 `localizeEmbedded` 按 `PROVIDER_LABEL` 词表子串替换；`ATTEMPT_BUCKETS` 的 7 个失败摘要桶（验证码被拒 / 账号拉黑 / 额度耗尽 等）同模式。
  - 带数字的既有消息（`今日已签（连签 11 天）`、`今日第 1 天已签到（400 + 0 积分）`）永不整串匹配——还原成模板再翻译（`ARG_PATTERNS`，`{n}/{d}/{a}/{b}` 占位符）。
- **仪表盘 KPI「活跃 x / y」硬编码**：`' · 活跃 '` 内嵌中文，走 `T(' · 活跃 {n} / {m}', ...)`。
- **品牌区版本行可读性**：头部「v1.4.0 · 数据目录 …」行高 1.3 → 1.55，长 Windows 路径允许任意位置折行（此前反斜杠折行贴在一起）。
- **Trae 网关提示去掉过期模型名录（#19）**：面板里写死的「Doubao-Seed / GLM-5.1 / Kimi-K2.6 / DeepSeek-V4 等 12 款模型」与 TRAE 2.3.87413 官方目录严重脱节；改为透传口径「官方目录持续更新，网关透传任意合法模型 ID——如 GLM-5.3 / DeepSeek-V4.1-Flash / MiMo-V2.6 / Kimi-K3」。模型目录归 **10Router** registry（`traeGateway.js` 对 `model` 原文透传、零校验）——CreditDaddy#19 → 10Router#54 已落地（`10router@cc108143`）。
- **聚合菜单「检查更新」在所有环境显示**：此前该项 `display:none` 藏在 markup 里且只在桌面版有条件恢复——结果任何环境都看不到。现在始终显示：桌面版照旧走应用内更新；纯浏览器打开面板时（无 updater 桥）点开给出承接「在浏览器里打开的面板没有本机更新通道——请从 GitHub Releases 下载最新安装包安装」+「打开 Releases」按钮，不再空藏入口（词条 ×4）。
- **MiniMax 网关「请求详情」调试日志不随语言切换**：该条日志走了 key+args 归档但四份词典都漏了对应词条——英文面板下整条中文原文。补词条 ×4；同批新增的全量扫描（`scripts/check-i18n.js`）确认其余网关日志词条无遗漏。
- **Trae SOLO 介绍段英文态显示中文（隐性死键）**：词典里存的是「含 `<code>/<b>` 标签的整段」做 key，而 `applyDictFromServer` 的文本节点行走的是**逐节点精确匹配**——标签把段落切成 4 个节点，整段键永远打不中。改按文本节点键（前缀节点新词条，后三段原有词条继续命中），旧死键清理。
- **面板访问密码「关闭」永不生效**：`PUT {disable:true}` 只清了明文 `panelKey`，漏清 scrypt 哈希——重读设置又把模式拉回 hash，关闭按钮点了没反应，还误报「部署环境强制注入」。现在两种形态一起清；环境变量（fnOS 向导）部署仍按设计保持开启。回归测试随 `test/hardening.test.js` 入库（关后无密码直连 /api/settings 200）。
- **后台启动「启动超时（30s）」误报（探针超时贴边，`bgdaemon` 3 例全红的根因）**：`/api/status` 单次响应含 DPAPI 解密（Qoder 登录）与本机客户端探测，本机稳态耗时 ~1.9s、冷首击 ~4s；`probeStatus` 2 秒超时与之贴边，机器一忙探针永远超时 → `waitReady` 30 秒全部作废、误杀刚起的实例。探针超时放宽到 8 秒（回环地址，上限仍受 `READY_TIMEOUT 30s` 约束）。
- **「妙手」英译在词典值里不统一（Miaoshou / CatPaw 混用）**：en/ja/ko 词条值统一为产品英文名 **CatPaw**（键不变，源中文仍为「妙手」）；10Router 测试连接错误消息接 `T()`。

- **设了面板访问密码 → 面板永远转圈（1.4.0 首版回归，重切二次修复）**：首屏加载卡 `#boot-busy`（z-95）把密码输入框（`.mask` z-50）整个盖住——首次 API 401 促发的密码门「弹了但看不见」，loading 永远等不到数据。密码门触发时主动收掉加载卡（401 = 守护可达的明确信号），对话框统一提到 z-96。headless 实拍回归：密码框可见可输入。
- **设置里「修改密码 / 关闭」按钮点了没反应（密码区搬通用页的重构遗漏）**：密码区从「组件与排序」搬进「通用」页签时，点击监听仍绑在旧宿主 `#comp-menu` 上——按钮渲染在兄弟容器 `#sec-block`，事件根本到不了监听（此前用 API 层 curl 验证，漏了面板接线这层）。监听改委托到 `#sec-block` 自身；E2E 实点回归：进门 → 点修改密码弹「输入新密码」→ 点关闭弹确认框。
- **logger 归档测试跨零点必挂（测试侧）**：用例拿 `toISOString()`（UTC）拼归档文件名，logger 按本地时间命名——UTC+8 的 00:00–08:00 窗口文件名错位一天；改用本地日期拼 + 轮询断言。

### 📖 文档

- **README 明确 npm CLI 是全平台安装方式（#17）**：下载表加「全平台（安装包）· `npm i -g creditdaddy`」一行并在顶部加 npm 徽章；补 Node.js 在 Linux 的安装说明、「方式三」全平台通用指引、Linux 各功能可用性对照表（Qoder UMID 组件 / 妙手仅 Windows / 客户端切号仅 Windows / 用量同步需 Node 22.5+）、systemd user service 后台常驻与开机自启示例。
- **README / DEPLOY 下载表统一命名**：产品一改 CreditDaddy-Win/Mac/FnOS 命名列子，与 CI 及 npm 的指引口径一致。
- **产品线平台边界注明**：Qoder 段标注 npm 全局安装的 UMID 安装路径；妙手段标注桌面客户端仅 Windows（非 Windows 平台自动隐藏入口）。

## [1.3.3] (2026-10-08)

本版主题:**Qoder 国际版网页会话收割竞态修复 + 主界面聚合下拉菜单与面板设置分页签重构**。无破坏性变更,可直接升级。

### ✨ 新功能

- **主界面聚合下拉菜单**：顶栏最右侧新增菜单入口（检查更新 / 更新日志 / 主题 / 重启 / 建议反馈 / 捐赠），Lucide 线性图标与全局设计语言统一；下拉紧贴按钮右对齐展开（非居中弹窗），点击外部 / ESC / 滚动自动收起。检查更新与重启从面板设置弹窗聚合进来（网页面板无 updater 时自动隐藏检查更新项）；主题收敛为**单条菜单项点击循环：跟随系统 → 亮色 → 暗色**（跟随系统 = 清掉手动选择，matchMedia 实时跟跑；菜单保持展开可连点观感切换）；建议反馈直达 GitHub issue 模板选择页（🐞 Bug 反馈 / ✨ 功能建议 / 🔒 安全问题三套表单模板，与 10Router 仓库同一套结构，含版本 / 安装渠道 / 平台必填字段，空白 issue 入口关闭）；更新日志从「弹窗里再开弹窗」改为菜单直达的独立小窗（解析随包 CHANGELOG.md 的最近版本主题 + 板块标题，兜底跳 GitHub Releases），捐赠经系统浏览器打开。

### 🐛 修复

- **Qoder 网页会话收割竞态（长期「缺网页会话」的根因）**：登录窗关闭时「读 Cookie」与「清无痕存储」并发赛跑，清存储抢先就抹掉 Cookie，收割永远为空且完全静默。现在**先等收割完成再清存储**。
  - **全链路诊断日志**：收割（两域分别上报 Cookie 条数）、探测未通过、绑定结果全部进运行日志——「缺网页会话」从此可定位。实测确认 `qoder.com` 探测接口国内直连可达（401 正常拒绝），窗口侧才是断点。
  - **登录窗显式代理**：浏览器登录打开 `qoder.com` 时，若配置了出口代理则给无痕 session 显式设置代理；未配置则维持跟随系统代理的默认行为。
  - **徽章提示**：国际版账号的「缺网页会话 / 网页会话过期」tooltip 补充出口代理配置说明。
- **检查更新误报「发现新版本」**：electron-updater 的 `update-available` 与手动检查只比较 `!== 当前版本`，本地版本比发布通道更新（如 1.3.3 本地构建 vs 线上 1.3.2）时误报——现在一律要求**严格更新**才提示。
- **关闭登录子窗连带隐藏主窗（桌面版）**：Windows 对带 owner 的子窗（尤其最大化过的授权窗）关闭时会向主窗发出连带关闭/最小化，面板凭空消失。现在子窗关闭瞬间主窗收到的 close 一律按级联处理并自动恢复可见性；用户主动收进托盘不受影响。
- **托盘「更新日志」重复注册 IPC handler**：每次点菜单都 `ipcMain.handle` 一次，第二次起抛「second handler」错误——改为一次性注册 + 广播打开。
- **10Router 额度与上游对不齐（「剩 100%」问题）**：额度行只要带 `remainingPercentage` 就优先显示百分比，而上游这个字段是四舍五入值——`3.99 / 4` 被显示成「剩 100%」，与 10Router 自己面板的数字口径对不上。现在**绝对量优先**：有 `total` 就显示「剩 x / y」，只有真正的百分比窗口（Antigravity 这类限时额度）才走百分比口径；供应商汇总卡的跨连接归并同修。
- `fetchJsonRace` 新增 `preferProxy` 选项：按 IP 识别地区的域名需要「代理优先」语义——直连即使返回 403 风控页也算「成功响应」，默认的先直连顺序永远不会轮到代理（Qoder 国际版登录链路使用）。

### 🎨 界面

- **出口代理上收到面板设置（全局）**：原「ZCode 网络出口」弹窗整段移入右上角齿轮——代理本就是全局出口，不应埋在单一产品线里。所有出网请求（ZCode 上游、Qoder 国际版登录与凭据探测等）共用这一份配置；ZCode 页的出口状态按钮移除。
- **面板设置分页签**：内容越来越多，改为「通用（版本与更新 / 服务维护）/ 网络（出口代理）/ 组件与排序」三个页签——高度减半，后续扩展不再堆长页。
- **组件显隐 chips 横向排布**：页签内组件开关由纵向大列表改为横向小胶囊，一屏看全。
- **日志过滤器归位**：「全部 / 只看提醒」分段控件移到日志卡右上、与「展开/收起」按钮并排。
- **应用图标重制**：`desktop/icon.png` 此前是 SVG 的浏览器截图（带滚动条与白底），现由 `desktop/gen-icon.js` 从矢量源离屏栅格化为干净的 1024×1024 透明底（macOS 构建同样要求 ≥512 的图标源）。

### 📌 说明

- MiniMax Code 客户端**不支持多端登录**（本机凭据只有一条活动记录，且 refreshToken 轮换式一次性），CreditDaddy 与客户端共用必然互抢凭据——因此 MiniMax 不做卡片切换登录，保留顶栏「打开客户端」按钮；账号管理走额度 / 签到 / 本地网关轮换。
- MiniMax 国际版（`minimax-intl`）在本版开发过程中曾短暂实现，实测其 API 侧对国内出口**全链路 401**（账号区域按出口 IP 识别，无法绕过），发布前已整体撤回；启动时会自动清理存量国际版账号并在运行日志说明。

---

## [1.3.2] (2026-10-06)

本版主题:**一键重启(托盘/面板/API) + CLI 后台运行(关终端断 SSH 签到照跑) + ZCode 网关 3012 风控修复(脱敏后恢复 plan 形状注入) + 网关日志轻重缓急分级**。无破坏性变更,可直接升级。

### ✨ 新功能

- **立即重启能力（托盘菜单、网关配置与面板维护）**：
  - **托盘菜单**：右键菜单新增「重启 CreditDaddy」，无需退出后重新翻找可执行程序。
  - **网关配置修改后立即生效**：修改 ZCode / MiniMax / Trae 体验包与本地网关的「对局域网开放」绑定设置后，自动弹窗提示「是否立即重启」，点击后无缝重启并自动刷新重连，无需用户手动重启。
  - **面板设置快捷入口**：右上角「面板设置」弹窗内增加「服务维护 - 重启 CreditDaddy」按钮。
  - **核心支持与系统接口**：新增 `POST /api/system/restart` 接口并对接桌面端 IPC（`app.relaunch()`），CLI 环境支持自动派生重启。
- **CLI 后台运行**：`creditdaddy start` 把守护进程拉进独立进程组，**关掉终端 / 断开 SSH 后每日自动签到照常跑**，此前只有「前台跑」一种形态。配套 `stop` / `status` / `restart`，`start` 与 `stop` 均幂等（脚本里可放心串写），`status` 未运行时退出码 1 便于脚本判断。运行信息记在 `<数据目录>/daemon.json`（含**实际监听端口**——端口被占时 daemon 会自动 +1 重试），日志在 `<数据目录>/logs/background.log`。仍是零依赖纯标准库：托盘图标与开机自启归桌面版，CLI 不引入任何原生模块。
- **10Router 导出 Qoder 网页会话检查（issue #44）**：导出 Qoder 账号时，前置点名提示网页会话缺失或已超过 7 天过期的账号，引导重新浏览器登录后再导出，避免导入 10Router 后套餐内积分凭空消失。

### 🌐 网关健壮性与多产品线对齐

- **ZCode 网关 plan 形状修复（issue #15 / #16）**：恢复镜像本机客户端真实流量的请求形状——`buildPlanRequest` 重新注入 system 提示词数组、首条 user 消息前的 `<system-reminder>` 日期块与 `metadata.user_id` 会话形状。实测证明这正是上游 405/3012 风控的通过票：1.3.2 首版的「纯净透传」（不注入 system）会让所有账号的补全请求被 `验证码被拒 ([code:3012])` 全量拒绝，恢复注入后全天稳定 `补全成功 (200)`（见 #15 更正评论）。同时 `zcodePlanShape.json` 保留注入所需的形状模板并完成脱敏：抓包来源的真实用户路径（`C:\Users\<user>\<workspace>`）与会话 id 替换为占位符，日期块运行时动态生成为当天——隐私清理与风控通过兼得（见 #16 更正评论）。
- **网关日志轻重缓急分级**：`流式转发中断 / 流式（非流式）读取中断`（客户端主动断开，属正常收尾）由 warn 降为 debug；`验证码被拒`、`验证码重解失败`、`JWT 失效拉黑` 由 info/debug 升为 warn——此前真正严重的风控/凭据事件是最不起眼的灰色，无害的流中断反而顶着告警色，轻重倒挂。新增 `summarizeAttempts`：「全部 N 次尝试失败」现在附带归因明细（如 `网络错误×4`、`验证码被拒×3、网络错误×3`），不必再靠「有没有伴随 3012」反推；MiniMax / Trae 网关全失败此前完全静默，现同样补上明细。面板日志卡新增 `✗ / ⚠ / ·` 级别图标与「全部 / 只看提醒」过滤器。
- **桌面端局域网绑定修复**：桌面端启动检测由单一 `zcodeGatewayLan` 拓展为三网关统一判定（ZCode / MiniMax / Trae 任一开启即绑定 `0.0.0.0`），修复此前仅开启 MiniMax 或 Trae 局域网时桌面端仍绑定 `127.0.0.1` 导致外部连不上的问题。
- **防止中断监听器内存泄漏**：MiniMax 与 Trae 网关重试循环中移除循环内 `req.on('close')`，改为循环外单例 `clientAbort` 与 `req.once('close')` 级联取消，彻底杜绝 `MaxListenersExceededWarning`。
- **连接段两段式超时保护**：MiniMax 与 Trae 网关统一接入 `UPSTREAM_CONNECT_MS = 15_000` 两段式超时，上游遭遇 DNS/TLS 网络黑洞时 15 秒快速失败并切换下一个账号，避免死挂 10 分钟。
- **热路径磁盘读合并**：MiniMax 与 Trae 网关入口合并配置读取，省掉一次每请求高频磁盘 I/O。
- **面板指引与弹窗文案完全对齐**：ZCode 弹窗统一指向规范的 `<code>/gateway/zcode/v1/messages</code>`，MiniMax / Trae 弹窗复选框与保存 Toast 统一为「重启后绑定 0.0.0.0 / 绑定改动重启后生效」。

### 🐛 修复与体验优化

- **夜间模式（Dark Theme）输入框文字发黑修复**：根节点增加 `color-scheme: dark` 声明；补齐 `textarea` 的字体与颜色继承；为 `.input` 显式指定 `color: var(--text)` 并增加 `.input::placeholder` 规则，彻底解决夜间模式下 IP 白名单框等输入控件文字与占位符发黑看不清的问题。
- **多实例并存时日志静默丢失**：`gzipAndCleanup` 压缩当天日志后会 unlink 原文件，而同目录可能还有另一个实例（前台 daemon / 桌面版）以 O_APPEND 持有同一个 fd——POSIX 上它的后续写入会落进已无链接的 inode。改为压缩后**截断**原文件，同一个 inode 从 0 继续追加。同时 `closeArchiveStream()` 改为返回 Promise 并等流真正 close 才 resolve，优雅退出流程不再在 gzip 落盘前就 `process.exit()`。
- **优雅退出**（此前 `src/` 里没有任何 `process.on`，Ctrl+C 是硬杀）：现在 SIGINT / SIGTERM 会停掉签到定时器、关闭 HTTP server、清理自己写的状态文件并等日志归档完成再退出；非交互式（后台）实例忽略 SIGHUP，终端消失不算「收摊」。
- **端口占用探测**：`start` 前的端口预检改用 bind 探测。此前发 HTTP 请求探活，端口被非 HTTP 程序（数据库等）占着时对方不回话，请求超时后误报「端口空闲」，子进程便悄悄漂到下一个端口，用户摸不着面板到底在哪；现在能正确识别 EADDRINUSE 并直接报错、不留状态文件。
- **主题实时跟随系统深色模式**：此前只在首次打开时读一次 `prefers-color-scheme`，系统换深色/浅色页面不响应；现在无手动选择时监听 `matchMedia('prefers-color-scheme')` change 实时切换（不用刷新页面），用户手动切过则尊重其选择不再跟跑。
- **Qoder 卡片徽章提示**：账号为 Qoder 且网页会话（Cookie）缺失或超 7 天时，卡片出橙色警告徽章「缺网页会话 / 网页会话过期」（tooltip 说明：导出到 10Router 后「套餐内 Credits」逐资源包明细可能缺失，用「浏览器登录」重登一次即可补上）。判定口径与导出弹窗检查一致。
- **bgdaemon.stopDaemon 竞态修复**：此前只等端口释放就报 stopped，Linux runner 上端口先于 pid 回收完成导致测试断言 `isAlive(pid)` 仍读到 true。新增 `waitPidDead` 轮询直到进程从进程表消失才返回，8s 超时记 warn 日志但不阻塞流程（不 SIGKILL）。

---

## [1.3.1] (2026-10-05)

本版主题:**Trae SOLO 本地 Anthropic 兼容网关(10Router 直接调度) + ZCode 网关路径统一 /gateway/zcode/v1/messages + 两段式超时根治补全「卡十分钟」 + 多项额度/签到显示修复**。无破坏性变更,可直接升级。

### ✨ 新功能

- **Trae SOLO 本地 Anthropic 兼容网关**：`POST /gateway/trae/v1/messages`（上游为 Trae SOLO 的 OpenAI 兼容补全接口），10Router 建 anthropic-compatible 节点指向即可把 Trae 当普通供应商调度。多账号轮换、额度不足标记、面板开关与局域网白名单机制与 MiniMax 网关同款；`test/trae-gateway.test.js` 覆盖转发/轮换/错误分类。
- **ZCode 网关数据面路径统一为带品牌段** `/gateway/zcode/v1/messages`：与此前 `gatewayStatus()` 展示、注释、错误提示一致（旧路径 `/gateway/v1/messages`、`/v1/messages` 保留为别名向后兼容——后者与 zcode-api 端点同形，10Router 的 zcode-free 供应商换 host:port 即可切换）。按面板提示填 endpoint 不再 404。

### 🐛 修复

- **ZCode：BigModel 登录态账号额度显示「无有效套餐（仅免费额度）」**（如 techysy）：上游 `quota/limit` 对部分 oauth token 偶发返回 **HTTP 200 + 空 body**，`getJson` 把非 JSON 响应兜底成 `{code:200}` 被 `businessOk` 判真，零额度项提前返回 empty，**短路了本可查到 1 亿 Token 的 `billing/balance`**。现在：非 JSON 响应合成 `code:-1` 永不放行；quota/limit「有效但零额度项」继续把 balance 链试完（对齐 zcode-switch 每 token 双端点连查）；无套餐判定改用显式 `sawNoPlan` 标志（「不存在coding plan / 没有资格」口径），不再靠错误措辞正则。
- **Trae 签到显示 +0 Credits**：claim 响应不返 credits 字段时，用 status 预告值兜底，兜底默认值提为具名常量 `TRAE_DEFAULT_DAILY_CREDITS`。
- **MiniMax 套餐到期显示 58729 年**：`get_membership_info` 的 `expires_at` 混发秒/毫秒两种口径，按量级自适应解析（`<1e12` 视为秒），并补边界测试。
- **accounts.json 数据保护**：覆盖写前先落 `.bak` 备份，写坏时至少可回滚。
- **面板日志卡防御**：无 tag 的日志行（历史数据/异常写入）不再让 `getLogs` 过滤时 TypeError 崩溃。

### ⚡ 性能

- **ZCode 网关不再「卡十分钟」**：补全上游此前只有一个 600s 整墙钟，TCP/TLS 黑洞（被墙、代理失效）时请求吊满才失败换路。`fetchJsonRace` 新增两段式超时——拿到响应头前限时 15s 快速失败换下一条路，响应头到达即解除连接段限时、流式 body 仍可合法跑满墙钟；`handleGateway` 把每请求两次 settings 磁盘读合并为一次，客户端断连经 AbortController 级联取消上游请求。

### 🔧 日志

- 每日签到日志带产品线标签（如 `[Qoder 国内版]`），汇总行不再分不清是哪个产品。
- 运行日志默认排除网关 `*-GW` 流量标签，网关高频调用不再淹没面板运行日志（网关日志仍在各自标签下查看）。

### 🧪 测试

- 全仓 188 → 202 例。新增：`test/zcode-quota.test.js` 额度链 5 例（精确复刻 techysy token 矩阵：500 无套餐/401/空 body 不得短路、零额度项续查、真无套餐、balance 空 body 收敛、鉴权全灭报错）、`test/zcode-net.test.js` 两段式超时 3 例（连接黑洞快速换路、响应头后 body 慢流不误杀、不传 connectMs 旧行为）、`test/daemon-listen.test.js` 网关路由 1 例（三个路径命中、未注册路径 404）、Trae 网关 4 例、MiniMax 到期边界 1 例。

---

## [1.3.0] (2026-10-03)

本版主题:**接入 MiniMax Code 第 7 条产品线(本机导入/浏览器 OAuth 登录/每日签到/积分加权轮询本地网关) + refreshToken 轮换互斥与「重新授权仍被拉黑」根治 + 已存密码查看需面板密码**。无破坏性变更,可直接升级。

### ✨ 新功能

- **接入 MiniMax Code（智谱 MiniMax）作为第 7 条产品线**：本机导入 + 额度查询 + 每日签到领积分 + Anthropic 兼容本地网关。
  - **本机导入**：读取 `~/.minimax/auth/prod/cn/mcode-public/auth.json` 的当前登录记录（明文凭据文件，token 不出机）；`creditdaddy scan` 与面板「本机导入」均可抓取，并缓存 `uid-cache.json` 供离线比对当前登录账号。
  - **额度查询**：`POST /matrix/api/v1/commerce/get_membership_info` 解析积分余额（原「算力币」），按「免费/活动积分」与「购买积分」拆分为多条 part，带套餐名（Pro / 免费版）与到期时间；与 Qoder / Trae 同为「积分」口径，计入仪表盘剩余积分合计。
  - **每日签到**：`signin/status` 判今日是否已领（status 3），未领则 `signin/claim` 领取，返回连续天数与所得积分（含 `claimedAmount` 供面板「今日已领」徽章按产品日界刷新）。
  - **Anthropic 兼容本地网关**：`POST /gateway/minimax/v1/messages`（上游 `agent.minimax.cn/mavis/api/v1/llm/v1/messages`），10Router 建 anthropic-compatible 节点指向即可把 MiniMax 当普通供应商调度；多账号按**剩余积分加权轮询**（平滑加权轮询 SWRR，积分多的分到更多请求，不再雨露均沾的 round-robin）、401 自动刷新重试、429 冷却 5 分钟、SSE 与 JSON 流式透明转发、局域网白名单与回环校验（与 ZCode 体验包接口同机制）。面板开关持久化在 `settings.minimaxGateway`。
- **MiniMax 浏览器登录（官方 OAuth 设备码授权）**：面板「浏览器登录」新增 MiniMax Code 选项，桌面版在内置隐私窗口打开 `account.minimax.cn/oauth-authorize` 完成授权，无需本机客户端、无需粘贴 token。
  - 走 RFC 8628 设备码 + S256 PKCE：`POST /oauth2/device/code` 取 `verification_uri_complete` 与 `user_code`，`POST /oauth2/token`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`）轮询兑换，`authorization_pending` / `slow_down` 继续等待，`expired_token` / `access_denied` 终态失败。
  - **独立凭据链**：设备码登录拿到的是独立 `loginEpoch` 的一条新 refresh token 链，不与本机 `~/.minimax` 客户端共用凭据，因此 CreditDaddy 自行刷新不会作废客户端的 token（从根上消除轮换互斥）；该流程绝不回写 `auth.json`。
  - 登录成功按 uid 与本机导入的同一账号自动去重续期（保留 id 与签到记录）。

### 🐛 修复

- **MiniMax token 刷新报 `invalid_grant`（"this refresh token can no longer be used"）**：根因是刷新令牌轮换互斥——MiniMax 的 refreshToken 是一次性轮换的（`auth.json` 的 `generation` 随之累加），本机客户端会独立刷新，而账号库里的快照刷新后不回写文件，下次刷新即命中已被服务端作废的旧 token。
  - **刷新前对齐**：本机导入账号（带 `meta.authRecordKey`）在刷新前先从 `auth.json` 重读该 record 的最新 `refreshToken`（`alignMiniMaxFromLocal`），不再用陈旧快照；额度查询、签到与本地网关三处刷新路径统一接入。
  - **刷新后安全回写**：仿 mirasim，刷新成功经 `onRefresh` 回写账号库后，再尝试把新凭据写回 `auth.json`（`writeMiniMaxAuth`，原子写 + `generation+1`）——但**仅当客户端未运行时**：客户端运行中回写会让它内存里的 refreshToken 下次刷新命中已被消费的旧 token，反而弄坏客户端，故此时跳过（账号库已更新，下轮刷新前会再重读对齐）。device 登录账号无 `authRecordKey`，回写对其 no-op。
- **重新授权后本地网关仍报「凭据已失效」且开关重开也无效（MiniMax / ZCode 同款）**：根因是网关的失效拉黑名单是进程级、且只按账号 id 记账——授权到期那段时间上游 401 触发的刷新失败把账号拉黑后，即便随后重新登录/重新导入换来了新凭据，进程内旧黑名单仍把它挡在轮换队列外，网关持续 503；而 `setGatewayEnabled` 只翻设置开关、从不清这份状态，导致「开关重开也没用」。
  - **拉黑改记凭据指纹**：MiniMax 记 `token|refreshToken`、ZCode 记 `zcodejwttoken|token`；账号当前指纹与拉黑时不一致即视为已重新授权，自动解除拉黑与冷却并复活入队。凭据未变则拉黑依旧生效，不会反复空打上游。
  - **刷新成功即复活**：网关内就地刷新拿到新 token 回写账号库后，一并清掉该账号的拉黑/冷却。
  - **开启网关清场**：`setGatewayEnabled(true)` 视为「重新开始」，清空进程内黑名单与冷却，重开开关即可恢复。
- 签到「今日已领」徽章改按产品日界刷新（此前统一按 Qoder 的 10:00 UTC+8 翻日，与 MiniMax 口径错位）；客户端当前登录识别与积分口径修正。
- 本地网关流式缓冲透传优化，补充签到 `claimedAmount` 字段。

### 🎨 界面

- **日志卡内标签切换（运行日志 + 各网关调用）**：面板底部一张日志卡，卡内「运行日志 / ZCode 网关 / MiniMax 网关」三段切换；`/api/logs` 支持 `?tag=` 过滤（`MINIMAX-GW` / `ZCODE-GW`）。
  - **默认跟随当前页**：仪表盘默认显示运行日志（签到、额度查询、token 失效、异常等），切到 ZCode / MiniMax 产品页默认显示对应网关调用日志；同一页内手动切换会记住，切到别的页才重置跟随。
  - **网关开关联动**：对应网关开关关闭时隐藏该日志标签（无网关的产品页也不会出现多余的网关标签）。

### 🔧 测试

- 新增 `test/minimax.test.js` 设备码登录与凭据对齐用例：S256 PKCE 请求体校验、`authorization_pending` 轮询、授权完成返回独立凭据链账号（`source=browser`、无 `authRecordKey`）、`expired_token`/`access_denied` 终态、`alignMiniMaxFromLocal` 轮换对齐与 device 账号跳过、`writeMiniMaxAuth` 对 device 账号不回写 / 对本机账号回写并 `generation+1`。
- 新增 `test/minimax-gateway.test.js` 拉黑与复活回归：401 且刷新失败拉黑后 503 分类计数、刷新成功自动复活并回写账号库、**重新授权换凭据后自动复活**（本次修复的核心场景）、同指纹期间拉黑保持不空打上游、`setGatewayEnabled(true)` 清场、网关未开启 503、**按剩余积分加权轮询**（积分多的分到更多请求、额度只查一次）；`test/zcode-gateway.test.js` 补同款「重新导入换 JWT 复活」与「开关清场」用例。全仓 188 例绿。

### 🔒 安全

- **「已保存的密码」需面板访问密码才能查看**：此前托盘菜单「已保存的密码…」直接打开管理窗，点「显示/复制」即可拿到明文（DPAPI 解密对同系统用户无需口令），绕过面板访问密码。现在设了面板访问密码时，打开管理窗前先弹出密码验证（常量时间比较，失败不提示进度），验证通过才允许查看/复制明文；未设面板密码则维持原行为（桌面壳本身已绑定当前系统用户）。

---

## [1.2.0] (2026-10-02)

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

### 🎨 界面

- **检查更新改用面板内弹窗**：原生系统对话框全部撤掉，换成与 CreditDaddy 同设计语言的模态——分阶段状态（检查中 / 已是最新 / 发现新版本 / 下载进度条 / 已就绪待重启），后台 electron-updater 事件实时推送；入口在「面板设置 → 版本与更新」和托盘菜单。独立下载进度小窗一并移除，主进程改为 `updateUi` 状态机 + `update:*` IPC
- **仪表盘「总览」收进面板容器**：裸飘的标题行改为 panel + toolbar（与产品页同一语言），KPI 四格从独立卡片收成面板内统计条（虚线分隔），不再割裂
- **ZCode / 10Router 顶部重构收尾**：ZCode 设置入口收进顶栏按钮组（状态灯 + 弹窗），横幅单行化只留活动领取口径；10Router 连接信息入设置弹窗、用量同步独立弹窗（自动开关 / 来源 / 手动同步），页面状态条删除（历史在弹窗与日志里）

### 🔒 安全

- **体验包接口删除虚拟 key 鉴权兜底**：局域网访问收口为唯一规则——本机回环放行 + IP 白名单免密直连，白名单外一律 403。原来「白名单外可用 10Router 虚拟 key 鉴权」的旁路与 `gatewayKey` 导出、相关常量时间比较函数一并删除，配置面更少、规则更好记（zcode-free 本就是 10Router 侧免授权供应商，加白即可）

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
