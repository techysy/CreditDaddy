# AutoClaw（智谱澳龙）登录 / 邀请码 / 同步 —— 可行性报告

> 2026-11-26 · 基线分支 `feat/autoclaw-line`（`dfd5a7d1` + `f456ebf1` + `8a49380f`）
> 结论先行：**三件事都能做，但不是同一个口径**。登录只做国内版短信直登（国际版 OAuth 不做）；
> 邀请码有真 API（不止静态池）；同步只在「CD 自己登的小号」这一条线上做，本机号仍不同步。
> 本轮全部结论都做过只读实测，实测方法与证据位置见文末附录。
> **2026-11-26 用户已拍定口径 (a) 与「bind 用可弃小号验」，C1/C2/C3 已实现，落地状态见 §6。**

---

## 0. 一页结论

| 事项 | 可行性 | 推荐口径 | 不做的事 |
|---|---|---|---|
| 登录 | 国内版**可做**（纯 HTTP 两步，已实测端点可达）；国际版**不建议** | 只做 `autoclaw-cn` 短信直登，形态照 Loomy 的「手机登录」页签 | 不在 CD 做国际版 Z.AI OAuth（滑块 + 18432 回环端口冲突） |
| 邀请码 | **有真 API**，比 loomy 口径还多一层（能读自己的码、能查绑定状态） | 填码 + 我的邀请码两个按钮，池子照 LOOMY_INVITE_POOL | 不在未点头前真打 bind（有副作用） |
| 账号切换 | 只读收割下**做不到写回式切换**，但「对齐客户端当前号」已经能做 | 保持现状语义，文案说清「在客户端换号 → CD 跟随」 | 绝不写 `%APPDATA%\autoclaw\auth.json` |
| 同步 10R | 本机号**不可行**（三副本互杀）；CD 登录号**可行** | access-only + 定时重推（croli 同款），仅覆盖 CD 登录来源的账号 | 不把本机收割来的账号推给 10R |
| 文案 | 已落 | 顶部一行摘要 + 「说明」弹窗全文 | — |

---

## 1. 核心冲突：refresh token 单次轮换，副本数就是死法数量

这条决定了后面所有取舍，先把它讲实。

AutoClaw 的 `refresh_token` 是**单次使用轮换制**：谁拿它刷新，服务端立刻作废旧的那条。
10Router 侧与 CD 侧的源码注释在这点上完全一致（`open-sse/shared/autoclaw/client.js`、
`src/autoclawClient.js` 文件头、registry 的 `notice` 文案）。

于是同一账号被 N 个副本持有，就有 N−1 条必死链：

- **本机 AutoClaw 桌面客户端**：CD 管不到它。它每小时自己换一次新对（实测本机 access 的
  `iat`/`exp` 恰好相隔 24h，且 `auth.json` 会被它持续重写）。
- **CD**：现在的设计是「账号库 access 未到期 → 直接用；到期 → 重读本机 `auth.json` 取客户端
  刚换的新对；两边都过期才由 CD 代刷」（`resolveAutoclawAuth`，`from` 字段标了三条路径）。
  这条顺序把「客户端 + CD」两副本的共存问题解决了——CD 永远优先用客户端刚产出的那一对，
  不抢着刷。
- **10Router**：CD 一旦把 rt 推过去，10R 也会自己刷。它看不见本机 `auth.json`，
  手里只有推过去那一刻的快照，**必然抢在客户端之前把链刷死**。

**这不是偶发，是必然**：三个副本里只要有两个各自发起刷新，另一个当场 `invalid_grant`，
而且无法恢复——只能重新登录。meoo test.12 就是这套机制踩出来的事故（`src/tenrouterAccounts.js`
映射表注释里写着）。AutoClaw 比 meoo 多一个 CD 管不到的第三方副本（桌面客户端），所以更硬。

### 三条可选口径与代价

| | (a) CD 登录只为「CD 独占的小号」 | (b) 同号但刷新权只在一处 | (c) 不同步、只保留本机收割（现状） |
|---|---|---|---|
| 做法 | CD 短信直登出来的账号，`device_id` 用 CD 自己派生的新值，**与本机客户端不是同一台设备**；rt 只有 CD 一个持有者 | 用户自己选一处持有 rt（要么客户端、要么 CD、要么 10R），另两侧只拿 access 且不再刷 | 本机号只走 `auth.json` 收割，CD 只做「用前重读」；10R 侧要这条线就去 10R 自己登录 |
| 签到能不能天天做 | **能**，且最稳：CD 手里那条链只有它自己在转，永不 `invalid_grant` | **有条件能**：选「客户端持有」时，CD 每次签到前必须重读 `auth.json`（现状即如此）；一旦客户端 24h 没开机，access 过期 → CD 代刷 → 客户端下次要求重登，用户会当成 CD 把号弄坏 | **能**，但依赖客户端在跑；客户端连续 >24h 未运行时，CD 代刷一次就与客户端互杀一轮，之后要用户在客户端重登 |
| 同步 | **可做**：access-only + 定时重推（见 §4） | 不可行：权在客户端时 CD 自己都可能拿不到新鲜 access，更推不出稳定的；权在 10R 时本机客户端必死 | 不可行（就是它的定义） |
| 代价 | 多一个号要维护；小号与本机号在同一个产品页里要靠徽章区分 | 把「谁的链谁做主」变成用户要理解的概念，面板必须解释清楚，出错时排查成本高 | 用户明确要「同步也要做」，这条不满足 |
| 风险 | 低（新增线，不动既有语义） | 中高（改变既有本机号的续期承诺） | 低，但需求不达标 |

**推荐 (a)**。理由：它把「CD 独占刷新权」变成**新账号的天然属性**而不是要用户选的开关，
既满足「登录用 10R 的能力」和「同步也要做」，又完全不改动现有本机收割账号的行为——
`resolveAutoclawAuth` 那套「本机优先」的逻辑一行都不用动，只是多一条 `source='sms-login'`
的账号走「账号库里那对就是最新的」这条快路径。

对「签到能不能天天做」的影响，正是推荐 (a) 的第二条理由：小号每天签到不再需要赌客户端开没开。

---

## 2. 登录

### 2.1 国内版（`autoclaw-cn`）：短信两步直登 —— 可做

10R 现成能力在 `src/lib/oauth/providers/autoclaw-cn.js`（+ `open-sse/shared/autoclaw/client.js`）。
CD 侧照搬即可，三个坑 10R 已经踩过并写在注释里：

1. **`code` 必须发数字**——字符串会 400001（`autoclawSmsCodeValue()` 专门做这个转换，
   `code: 0` 会被当空值，别自己拼）。
2. **`agent-login/` 端点带尾斜杠**——少斜杠 404。
3. **`device_id` 必须稳定**——登录与后续 refresh 必须同一份（服务端按 JWT 里的 `device_id` 对账）。

本轮只读实测（用非法手机号，不发真短信）确认两个端点都活着、且上游没把 CD 的签名头拦掉：

```
POST /userapi/v1/agent-send-code  { phone: '00000000000' }
  → HTTP 200 {"code":630006,"msg":"抱歉,手机号码不合法"}     ← 端点在，参数校验在跑
POST /userapi/v1/agent-login      { phone, code }            ← 无斜杠
  → HTTP 200 {"code":400001,"msg":"请求数据有问题,请检查后重试"}
POST /userapi/v1/agent-login/     { phone, code }            ← 带斜杠，同样 400001
```

`630006` 是手机号格式校验的回答，说明请求已经打到业务层——**WAF 没有拦 CD 侧的头**
（`X-Auth-Sign` / `User-Agent: AutoClaw/2.1.0` 那套 `autoclawClient.js` 里已实现且签到线在用）。

**CD 侧落地形态**：照 Loomy 的「手机登录」页签（`panel.html` `data-pane="sms"`，
后端 `/api/loomy/sms/send` + `/api/loomy/sms/login` 两步，成功后 `addAccount({ source:'sms-login' })`）。
新增 `src/autoclawAuth.js`（`sendAutoclawCnSms` / `loginAutoclawCnBySms`，纯函数 + 注入 `fetchImpl`），
daemon 加两条路由 `/api/autoclaw-cn/sms/send`、`/api/autoclaw-cn/sms/login`，
`openAdd('autoclaw')` 的 `tabShown.sms` 放开。

**必须一并处理的两件事**：

- **限流**：`agent-send-code` 对同一手机号有频率限制（业务码 630203「操作太频繁」）。
  Loomy 线同款问题靠面板按钮倒计时解决，这里也做倒计时，不做服务端节流（CD 是单机工具，
  节流意义不大，但**失败要把上游原文回显**，别只报「发送失败」）。
- **新号自动注册**：Loomy 的登录路由里有一段「登录被拒 → 用同一条验证码自动注册再重试」。
  AutoClaw 是否同语义**未实测**（要真手机号才能验）。落地时先按「不自动注册」实现，
  把登录失败原文回显；确认上游支持后再补，别猜。

### 2.2 device_id 从哪来：不能复用本机那一条

实测本机 `auth.json` 的 `deviceId` 与 access/refresh JWT 的 `device_id` claim **逐字节相同**：

```
auth.json deviceId = 943d191e…a7300
access.device_id   = 943d191e…a7300   ← 相等
refresh.device_id  = 943d191e…a7300
access.source_id   = autoclawaccess_token      → intl 形态的 claim 名
refresh.source_id  = agentrefresh_token        → CN 线（source_id 以 agent 开头判 CN）
```

这条实测有两个直接后果：

1. **CD 短信登录必须自己派生一个新的 64-hex device_id**，绝不能复用本机 `auth.json` 那条。
   复用了就等于「用同一台设备登录另一个号」，会把本机客户端那条链挤掉（同设备重复登录
   上游会轮换/作废既有会话），后果是用户的桌面客户端莫名要重新登录——这是最坏的一类事故。
2. 派生方式照 CD 已有的两处先例，**不要新造**：
   - `catpawLocal.js`：`sha256(MachineGuid + ":catpaw-desk-token-v2")`，MachineGuid 来自
     注册表 `HKLM\SOFTWARE\Microsoft\Cryptography`（与 `node-machine-id` 同源）；
   - `quworkClient.js`（`feat/quwork-line`）：`quworkDeviceIdentifier(seed)`——首次随机、**落库复用**，注释写明
     「反复用随机值会让服务端看到同一账号换机器」。

   AutoClaw 选**后者形态**：`meta.autoclawDeviceId` 落库复用，种子用
   `sha256(MachineGuid + ':autoclaw-cd-device')`。原因是 CD 登录的号可能被导出/迁移，
   纯机器派生会跟着机器走；落库那份跟着账号走，与 10R 的 `getConsistentMachineId` 语义一致
   但更稳。10R 侧的 `autoclawDeviceId()` 是**它自己那台机器的**派生值，CD 不必也不应与之相同。

   与 `src/authDevice.js` 的关系：**没有关系，别去复用**。`authDevice.js` 是浏览器设备码登录
   （Qoder/Trae/MiniMax 那套 PKCE + `machine_id: crypto.randomUUID()` 一次性随机），
   会话只存内存。AutoClaw 要的恰恰是「跨进程稳定」，两者语义相反。

### 2.3 登录来的凭据与本机收割来的凭据，怎么在同一账号行里不打架

靠**三个已有字段**分层，不需要新机制：

| | 本机收割账号 | CD 短信登录账号 |
|---|---|---|
| `source` | `'local-app'` | `'sms-login'` |
| `meta.autoclawDeviceId` | = `auth.json` 的 deviceId | = CD 派生的新值 |
| `resolveAutoclawAuth` 走哪条 | `account` → `local` → `refreshed`（本机优先） | `account` → `refreshed` |

关键护栏**已经存在**，就是 `autoclawLocalBelongsTo()`（`autoclawClient.js:547`）：
它比对「本机 `auth.json` 这一对是不是这个账号的」，优先比 `meta.autoclawDeviceId`，
其次比 uid，两个都对不上就**不借用本机凭据**。CD 登录的小号 `meta.autoclawDeviceId`
与本机那条必然不同 → 天然不会串凭据，`from` 永远不会是 `'local'`。
这条逻辑是当初为「用户在客户端换登别的号」加的，正好把新口径接住，**一行都不用改**。

归线判别也不用改：`autoclawRegionOfToken()` 看 JWT 的 `source_id` 是否以 `agent` 开头。
短信登录响应里的 token 与本机收割来的同形态（实测本机 refresh 的 `source_id=agentrefresh_token`
→ CN），所以 `liveToAccount` 与 `verifyAutoclawAccount` 的归线逻辑复用即可。

### 2.4 国际版（`autoclaw`）：建议这轮不做

10R 的实现（`src/lib/oauth/providers/autoclaw.js`）已经写明它为什么特殊：

- 上游**阿里云滑块 captcha 是开着的**（2026-11-24 实测：`oauth-url` 不带回执直接 400001），
  回执**只能由用户浏览器里的阿里云 SDK 产出**——所以 10R 用的是专用 dashboard modal，
  不走通用 OAuthModal。
- 回调是 `http://localhost:18432/auth/callback-zai`，**10R 侧不监听**，靠用户把打不开的
  那一页地址栏整段粘回来（paste-callback，croli/junie 同款形态）。
- 「如果 AutoClaw 桌面端在跑，它占着 18432 并把回调吞掉」——10R 注释原话，要求先退出客户端。

CD 理论上能做（`desktop/main.js:761` 的 `openIncognitoWindow` 是现成的内置无痕窗，
DuMate 网页版那条线已经在用它做会话捕获），但要同时解决：无痕窗里嵌阿里云 SDK 拿回执、
拦截 18432 回调、以及「用户必须先退客户端」这条前置。
**成本高、失败面大，而且国际版本来就有本机收割这条路**（用户机器上装了客户端就能导入）。
所以国际版这轮**只做收割，不做登录**，面板上「国际版没有登录入口」这件事要在说明弹窗里写明，
免得用户找不到按钮以为缺功能。

---

## 3. 邀请码：不是「无 API 口径」，是有三个真端点

**这一节推翻了任务书里的预设**（任务书写「10R 全无实现、找不到就写无 API 口径」）。
10R 确实全无实现（`grep -rn "invite\|fission" open-sse/shared/autoclaw/*.js` 零命中，
registry 里只有运营 `notice` 文案），但**客户端安装目录里有完整实现**。

反解 `%LOCALAPPDATA%\Programs\AutoClaw\resources\app.asar`（295MB，Electron asar 未加密，
源码可直接读）找到：

```js
// 主进程 IPC → HTTP，三条端点
const getInviteInfo = (param = { activity_id: "autoclaw_fission", business: "autoclaw" }) =>
  get(`/agent-assetmgr/api/v1/fission-v2/status?${qs(param)}`);
const getInviteOnlineActivityInfo = (param = { business: "autoclaw" }) =>
  get(`/agent-assetmgr/api/v1/fission-v2/online-activity-info?${qs(param)}`);
const useInviteCode = (params) =>
  post(`/agent-assetmgr/api/v1/fission-v2/bind`, withWebInfo(params));
// withWebInfo = { source_id: 'autoclaw', device_id: <auth.json 那个> }
```

渲染进程的绑定调用参数形状（同 asar 内）：

```js
window.electronAPI.inviteCode.use({ activity_id: "autoclaw_fission", business: "autoclaw", invite_code })
// 成功判定：res.code 为假值 → 成功；有值 → 「邀请码使用失败」
```

官方文案（同 asar i18n 表）：`invite.title`「受邀赢福利」、`invite.inputInviteCode`「填写好友邀请码」、
`invite.useSuccess`「邀请码使用成功」、`invite.skip`「无邀请码，直接使用」。

### 3.1 只读实测（本机真号，未打 bind）

```
GET /agent-assetmgr/api/v1/fission-v2/status?activity_id=autoclaw_fission&business=autoclaw
→ HTTP 200 code:0
  activity:  enabled=true, status="active",
             starts_at=2026-07-28, ends_at=2026-12-11,
             bind_inviter_reward_amount=1000,
             bind_inviter_reward_amounts=[1000 ×15],
             bind_inviter_reward_limit=15,
             bind_inviter_reward_valid_days=30,
             bind_invitee_reward_amount=0,          ← 被邀请方当前配 0
             bind_inviter_reward_event="bind_and_query",
             placements=["point_detail_page"]
  share:     invite_code="CN5RTLJH", inviter_id="935428",
             status="active", can_share=true, expires_at=2029-08-21
  bind:      status="unbound", can_bind=true
  stats:     invited_count=0, remaining_bind_reward_count=15, reward_total=0
```

**结论**：

1. **自己的邀请码可读**（`share.invite_code`）——比 loomy 的静态池口径更强，
   「我的邀请码」按钮能做真数据，不用只放池子里的码。
2. **绑定状态可读**（`bind.status` / `can_bind`）——面板能在用户点之前就说「已绑定过」，
   避免重复提交。
3. **奖励口径**：邀请方 1000 积分/人、上限 15 人、30 天有效；**被邀请方当前配 0**。
   文案必须照实写「绑定后邀请方得 1000 积分（每号最多 15 次、30 天内有效）」，
   **不要照抄 loomy 的「双方各 +5000」**——那是 Loomy 的政策，不是 AutoClaw 的。
4. `bind_inviter_reward_event="bind_and_query"` 说明**查询 status 本身就会触发发奖结算**
   （字面义「绑定与查询」）。这条要当事实对待：读 status 不是纯只读，它可能改变账面。
   本轮实测后本机 `reward_total` 仍是 0（没有下级），无副作用，但**实现时不要把 status
   挂进高频轮询**，只在打开邀请码弹窗时读一次。
5. **活动有截止日**（2026-12-11）。过期后端点大概率回 `enabled=false` 或非 active，
   面板要能优雅显示「活动已结束」而不是报错。

### 3.2 未实测、必须如实标注的部分

- **`POST /fission-v2/bind` 没打**——它改变账号账面（不可逆、消耗「每号仅一次」资格）。
  按约束「动手前确认」，等用户点头再打第一次。参数形状与成功判定来自客户端源码，
  可信度高，但**首次真打要拿一个可弃的号**，不要拿用户主力号验。
- **`withWebInfo` 里的 `device_id`** 在 CD 侧应该用**这个账号自己的**
  （`meta.autoclawDeviceId` 或 JWT claim），不是 `auth.json` 的固定那份——
  `autoclawPost()` 已经是这个口径，复用即可。
- **国际版是否同端点**：未测。`fission-v2` 挂在 `agent-assetmgr` 下，与 wallets/task 同域，
  理论上 intl host 也有一份，但 CN 的活动配置（`autoclaw_fission`）不一定对国际号开放。
  实现时先只给国内版出邀请码按钮，国际版按 `status` 读失败就不显示。

### 3.3 推荐池（照 LOOMY_INVITE_POOL 口径）

用户明确要「邀请码磁子参考 cd 的 loomy」。Loomy 的口径是三条（`panel.html:4893-4900` 注释 + `LOOMY_INVITE_POOL`）：

1. 维护者共享码放进一个**静态数组池**（`LOOMY_INVITE_POOL = ['AAYW9D', ...]`）；
2. **弹窗正文随机推荐一个**——把消耗均摊到多个码上，避免单个码提前用完；
3. **输入框保持空 + placeholder 示例**引导（注释里写了用户实测反馈：直接预填太生硬）。

AutoClaw 照这个口径加 `AUTOCLAW_INVITE_POOL`，与 §3.1 的真 API 组合成两个按钮：

- 「填写邀请码」（礼物图标）→ `uiPrompt` 弹窗：正文随机推荐池里一个码 + placeholder 示例，
  提交打 `/fission-v2/bind`；成功后立刻重读 `status` 把 `bind.status` 更新成 bound。
- 「我的邀请码」（user-plus 图标）→ `m-my-invite` 弹窗：打 `/fission-v2/status`，
  显示 `share.invite_code` + `remaining_bind_reward_count/15` + 活动截止日 + 复制分享文案。
  这一步复用现成的 `m-my-invite` 弹窗（Loomy/DuMate/Croli 共用），只加一个分支函数。

**池子里放什么码**：需要用户提供。AutoClaw 的码形态是 7 位大写字母数字（实测 `CN5RTLJH`
是 8 位、`CN` 前缀，注意与 Loomy 的 6 位形态不同），CD 代码里不预置任何码值，
空数组 + 注释说明「维护者放码进来才启用推荐」，比放一个失效码更诚实。

---

## 4. 账号切换：只读收割下能做到哪

现状：`autoclawLocal.switchTo()` 固定抛错（`autoclawLocal.js:229`），
`store.js:315` 的 `canSwitch` 白名单不含 autoclaw → 卡片上根本没有切换按钮。
这是**有意的**：写回 `auth.json` 会被客户端退出时用内存里的旧登录覆盖，制造不一致
（qwenwork 真机覆盖事故的同款教训，已写进 `autoclawClient.js` 文件头纪律）。

那么用户说的「账号切换」在 AutoClaw 上到底是什么？分三种，能做到的程度不同：

| 语义 | 能不能做 | 怎么做 |
|---|---|---|
| **CD 写回客户端换号**（Loomy/mirasim 那种） | **不能** | 见上；且 AutoClaw 的 token 是 safeStorage 密文，写回等于替客户端做决定 |
| **CD 侧多账号并存 + 客户端当前号对齐** | **已经能做** | 卡片上「客户端当前」徽章（`isClientCurrent()` → `s.autoclawCurrentUid` 比对 `userInfo.id`）；用户在客户端换登 → 点「本机导入」→ CD 识别新号并归线 |
| **CD 登录的小号 ↔ 本机号 之间切** | **不需要切** | 两条线是两个**不同的账号行**，各自签到、各自读额度，本来就不互斥 |

**判断：中间那一档属于用户说的「账号切换」**。理由：用户要的是「我能管多个号、能知道客户端
现在登的是哪个、能分别签到」，这三条现状都满足；缺的只是「一键把客户端切成 B 号」。
而这一键在 AutoClaw 上做了会坏（写回被覆盖），所以**如实说明比硬做更好**——
本轮 B 项加的说明弹窗里第三条「换号」正是把这件事写进 UI（`panel.html` `m-ac-note`）。

**要不要给用户一个「拉起客户端 + 提示去登录」的半自动按钮？** 现成的
`clientOpenHint()` / `window.creditdaddy.openAutoclawClient` 已经能唤起客户端。
可以做成：点「换号」→ 打开客户端 + toast「请在客户端登录目标账号，然后点添加账号 → 本机导入」。
这是纯 UX 糖，不引入新机制，等用户看完报告决定要不要加。

---

## 5. 同步：只有 (a) 口径下能做，且形态是既有的那个

如果走 §1 的 (a)（CD 短信登录 = CD 独占刷新权的小号），同步**可行**，做法是 croli 已定稿的那套，
不是新发明（`feat/croli-restored` 上 `src/tenrouterAccounts.js:275` 起）：

```js
// 1) 映射表加一行，只让 CD 登录来源的账号进得来
autoclaw: 'autoclaw', 'autoclaw-cn': 'autoclaw-cn'   // 10R 有这两个原生渠道，id 同名

// 2) 剥 rt 集合加两项（同步只推 accessToken）
ROTATING_RT_SYNC_PROVIDERS = new Set(['croli', 'qwenwork', 'qwenwork-cn', 'autoclaw', 'autoclaw-cn'])

// 3) access 自动重推（30 分钟一轮，比对上次推过的值，变了才推）
resyncAutoclawAccessToken(...)   // 照 resyncCroliAccessToken 的形状
```

**为什么必须配「定时重推」**：access JWT 约 24h 有效（实测 `iat`→`exp` 正好 24h），
10R 手里没有 rt 就必然断供。croli 的解法是 CD 每 30 分钟看一次 token 换没换、换了就重推
（`CROLI_RESYNC_INTERVAL_MS = 30 * 60_000`，启动 1 分钟后先跑一轮补重启丢掉的基准）。
AutoClaw 小号同口径：CD 自己刷出新 access 后立刻重推，10R 侧按 uid 原位更新，幂等。

**为什么本机收割来的号不能进这套**（这是必须点明的，也是本轮推翻旧口径的地方）：

- 2026-11-26 用户本人在三选一里拍过 **「保持不同步」**，定稿写进 `8a49380f`
  （`tenrouterAccounts.js` 映射表注释 + `panel.html:3962` 渠道行整体摘除）。
- 本轮用户要求「同步账号也要做」——**这是对上一条的推翻**，报告按新口径写，
  但推翻只覆盖到 (a) 那条新线。**本机号仍然不同步，旧结论在本机号上依然成立**，
  理由就是 §1 的三副本互杀：CD 推不出一个「既能让 10R 用、又不弄坏桌面客户端」的形态。
- 所以实现上必须**按来源过滤**，而不是按 provider 一刀切：
  只有 `account.source === 'sms-login'`（或 meta 里标了 `cdOwnedRefresh: true`）的账号
  才进同步集合。这条判据要写死在代码里并配测试，否则将来一定会误推本机号。

**渠道行（`AM_CHANNELS`）要恢复**：`panel.html:3962` 那段注释把 autoclaw 渠道行整体摘除了，
接同步后必须补回一行（`syncable: true`），否则用户在 10Router 设置里根本没有开关。
补回时把注释改成「仅 CD 登录来源的账号可同步；本机收割号不同步（三副本互杀）」。

---

## 6. 落地状态（2026-11-26 用户拍定口径 (a) 后已实现）

| 步 | 内容 | 状态 |
|---|---|---|
| **B** | 顶部文案精简 + `m-ac-note` 说明弹窗 + 四语词条 | **已落**（提交 90656510） |
| C1 | 邀请码：`autoclawClient.js` 三条端点函数 + daemon 2 条路由 + 面板 2 个按钮 + `AUTOCLAW_INVITE_POOL` | **已落**（代码完成，bind 未真打，见下） |
| C2 | 国内版短信直登：`autoclawAuth.js` + daemon 2 条路由 + `ac-sms` 页签 + device_id 派生落库 | **已落**（代码完成，待真手机号端到端验一次） |
| C3 | 同步：映射表 + 剥 rt 集合 + 按 source 过滤 + 30 分钟重推 + 渠道行恢复 + 渠道版本迁移 v2 | **已落** |
| C4 | 国际版 OAuth | **不做**（§2.4） |

**实现要点（改动落点）**：

- 协议层 `src/autoclawClient.js`：`fetchAutoclawInviteStatus` / `fetchAutoclawInviteActivities` /
  `bindAutoclawInviteCode` / `normalizeAutoclawInvite` / `autoclawSecToIso` /
  `sendAutoclawCnSmsCode` / `loginAutoclawCnBySms` / `autoclawSmsCodeValue` /
  `cleanAutoclawCnPhone` / **`canSyncAutoclawAccount`**（同步准入判据，刻意放协议层避免循环依赖）。
- 登录层 `src/autoclawAuth.js`（新增）：`autoclawCdDeviceId` / `autoclawCdSmsDeviceId` /
  `sendAutoclawSms` / `loginAutoclawSms` / `isAutoclawCdOwned` / `accountDeviceId`。
  **「本机收割号同 uid」会被硬拒**（不改写原行）——否则 accounts 的 uid 查重会把本机号
  原位改写成 `source='sms-login'`，于是它变成"可同步"，而客户端正登录着同一个号。
- 同步层 `src/tenrouterAccounts.js`：映射表两行 + `ROTATING_RT_SYNC_PROVIDERS` 加两项 +
  分组循环里按 `canSyncAutoclawAccount` 拦截并计入 summary + `resyncAutoclawAccess` /
  `startAutoclawResyncWatch`（30 分钟，只读账号库绝不打上游）。
- `src/checkin.js`：`startScheduler()` 里挂 `startAutoclawResyncWatch`。
- `src/tenrouter.js`：`ACCOUNT_SYNC_CURRENT_VERSION` 1 → 2，加入 autoclaw 双线迁移。
- `src/panel.html`：账号卡两个邀请按钮 + 两个弹窗函数 + `data-pane="ac-sms"` 短信直登页签
  + `openAdd` 放开该页签 + `AM_CHANNELS` 恢复两行（`pushable:false`）。

**测试**：`npm test` 598 项全绿；`test/autoclaw.test.js` 48 项（新增 12 项，含**安全线用例**
「本机收割号绝不进同步集合」「同 uid 本机号拒绝合并且原行不动」）。
`node scripts/check-i18n.js` 缺口回到基线 13 条（全是 Croli 线遗留，与本改动无关）。

**还等用户的**：

1. **bind 首次真打**（口径：用可弃小号验）——代码已就绪，`POST /fission-v2/bind` 从未对真上游打过。
2. **推荐池的码**：`AUTOCLAW_INVITE_POOL` 故意留空（AutoClaw 码是 8 位带 `CN` 前缀，
   与 Loomy 的 6 位形态不同）。空池时弹窗不显示推荐行，只走用户粘贴 + 「我的邀请码」真数据。
3. **短信直登端到端**：需要真手机号跑一次「发码 → 登录 → 落库 → 签到 → 同步」全链路。
   本轮只用**非法/空号**验证了端点可达与错误透传（`19900000001` 未真收到短信）。

不动的东西（约束）：`desktop/dist` 产物、`npm run dist`、本机 `%APPDATA%\autoclaw` 只读、
不再打本机号的当日签到（已领过，`bind_and_query` 那条另说，见 §3.1 第 4 点）。

---

## 附录：证据位置

| 结论 | 证据 |
|---|---|
| rt 单次轮换 | `src/autoclawClient.js:24-38` 文件头纪律；10R `shared/autoclaw/client.js` 注释；registry `notice` 文案 |
| 三副本互杀已定稿过「不同步」 | `8a49380f`；`src/tenrouterAccounts.js:40-58` 映射表注释；`panel.html:3962` 渠道行摘除注释 |
| 短信端点可达 | 本轮只读探针（非法手机号）：`agent-send-code` → 630006，`agent-login/` → 400001 |
| code 必须数字 / 尾斜杠 / device_id 稳定 | 10R `src/lib/oauth/providers/autoclaw-cn.js:1-15` 注释 |
| device_id 与 JWT 逐字节相同 | 本轮只读探针：`auth.json.deviceId` == access/refresh JWT `device_id` claim |
| access 约 24h | 同上：`iat=2026-11-26T12:19Z`，`exp=2026-11-27T12:19Z` |
| CN 线判别 | 同上：refresh `source_id=agentrefresh_token`（`agent` 前缀 → CN） |
| 邀请码三端点 + 参数形状 | `%LOCALAPPDATA%\Programs\AutoClaw\resources\app.asar` 内主进程 `getInviteInfo/useInviteCode` 与渲染进程 `InviteCodeModal`（本轮反解，偏移约 241483089 / 290237000） |
| 邀请码真数据与活动窗口 | 本轮只读实测 `GET /fission-v2/status`：own code `CN5RTLJH`、1000×15、30d、2026-07-28→2026-12-11、`bind.status=unbound` |
| access-only + 定时重推先例 | croli：`ROTATING_RT_SYNC_PROVIDERS`、`resyncCroliAccessToken`、`startCroliResyncWatch`（`feat/croli-restored`） |
| device_id 派生先例 | `src/catpawLocal.js:43`（MachineGuid）、`src/quworkClient.js:97`（随机种子落库复用；该文件在 `feat/quwork-line`） |
| 内置无痕窗捕获先例 | `desktop/main.js:761 openIncognitoWindow`（DuMate 网页版在用） |
| Loomy 邀请码池口径 | `panel.html:4893-4900` 注释 + `panel.html:4895 LOOMY_INVITE_POOL` + `loomyInvite()` |
