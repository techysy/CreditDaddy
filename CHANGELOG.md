# 变更日志

本文件为 CreditDaddy 完整开发与版本变更日志，按版本从上往下排列。

---

## [Unreleased]

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
