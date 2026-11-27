# 2026-10-21 事故复盘：配额卡残留 + mirasim 用量重复同步

一天内连续处理两个用户可见问题，根因不同但都指向同一类坑：**本地打包流程跳步** 与 **同一批调用双记账**。
本文沉淀事实、根因、修复与防范，供后续同类问题定位参考。

---

## 事故一：10R 上 minimax-free 出现三张卡（旧聚合卡残留）

### 现象

10Router 额度页同时出现三张 MiniMax 卡：旧聚合卡「MiniMax Code 免费额度」（双行）+ 新按账号单卡「主」「备」。

### 根因

`6ebcc52`（minimax-free 改按账号单卡推送，07:54）之后，本地打包 `npm run dist` 用的 `desktop/server/`
暂存目录是 07:49 拷的——**早于最后一笔提交 5 分钟**，包里 build.json 实锤 `commit: 81b02e0`（旧聚合推送代码）。
装上后旧代码继续推聚合卡；而 `6ebcc52` 没有对旧 source 做清理调用，聚合卡不会消失（7 天 TTL 才过期）。

### 修复

- `230e2fd`：`runQuotaPush` minimax 分支加一次性 `DELETE /api/external-quota/minimax-free`——升级用户首轮推送自动清旧卡，失败不阻断。
- **流程修正（规矩）**：本地打桌面包必须先重新暂存 `desktop/server/`（等价 CI 的 "Stage app bundle" 步骤），
  以 `desktop/server/build.json` 的 commit 与 HEAD 一致为准。CI 有这一步，本地 `npm run dist` 没有——跳过即翻车。

### 深层教训

**「测试包」不等于「当前代码的包」。** 暂存目录是隐式状态，打包脚本不校验它的新鲜度。

---

## 事故二：mirasim 用量在 10R 双记（同批调用两行）

### 现象

10R 用量表 `glm-5.3-flashx` 出现两行：`codebuddy-cn` 3,800 次 + `mirasim-anthropic` 2,917 次。

### 根因

用户 mirasim IDE 的上游就是本机 10Router。同一批调用：

1. 10R **原生**记账 → 落在 `codebuddy-cn`（网关侧 provider）
2. CD 从 `~/.mirasim/insights/usage-*.ndjson` **导入**一遍 → 落在 `mirasim-anthropic`

ndjson 的 direct 行 `upstreamHost` 全为 `null`，CD 的 `isSelfHostedUpstream` 无从识别——重复无法被旧规则拦截。

### 修复（`cf60179`）

`collectMirasim` 改为**只同步 `viaRelay=true` 的官方中继行**（走 relay.mirasim.ai，10R 没见过），
直连的全部跳过。数据验证该分界零交叉：relay 行全是 claude/kimi 家族，direct 行全是 glm/deepseek/gemini。

### 存量清理（10R 侧手动 SQL，六轮）

- `usageHistory`：删 4,066 行重复（provider='mirasim-anthropic' AND glm/deepseek/gemini AND imported），claude/kimi 全留。
- `usageDaily`（**预聚合表**）：删明细不动统计——统计页从这张表读。按备份逐天重写，终态 `mirasim-anthropic = 342`
  （10-10 的 4 行 + 10-20 的 338 行，纯官方中继真值），与备份三方对平。
- 踩坑记录（重要）：
  - **usageDaily 的 dateKey 与行 timestamp 的 UTC 日可能错位**（10R 部署 TZ 决定）；按本地日（UTC+8）分组才对。
  - usageDaily.byModel 的键格式是 `model|provider`（竖线），不是 `model (provider)`。
  - 脚本改库期间 10R 必须停止服务，否则实时聚合路径回写会覆盖脚本结果（fix3 输出与后读状态不一致的怪象即此）。
  - 备份文件：`/vol4/@appdata/10router/db/data.sqlite.bak-mirasim-dedup-1021`（NAS），留观一周后删。

---

## 版本状态

以上全部修复（`230e2fd` `bea2acb` `8c8683a` `5b5aab6` `b6f6dad` `cf60179`）都落在 **1.6.0 的 Unreleased**——
1.6.0 尚未发版（tag 未打），随 1.6.0 一起发。

## 防范清单

1. 本地打桌面前：`npm run stage --prefix desktop`（等价 CI 的 "Stage app bundle"，内部即 `node scripts/stage-bundle.js desktop`），核对 `desktop/server/build.json` 的 commit = HEAD。
   - **别手敲 `cp -r` 清单**：2026-11-25 的 1.8.4-test.25 公告事故就是手敲清单漏了 `announcements.json`（本条命令 10-21 写下时就漏了它），CI 的 Stage 步骤有、本地没有，随包兜底公告整份丢失。拷贝清单从此只维护 `scripts/stage-bundle.js` 一份，`npm run dist` 已自动调用它，`scripts/release-check.sh` 第 11 项会拦住缺失。
2. 改推送 source 命名时，旧 source 必须带一次性清理（DELETE），否则升级用户旧卡挂满 TTL。
3. 客户端上游指向本机 10R 的场景，用量同步必须以「10R 是否已记账」为分界（viaRelay / upstreamHost），导入只补 10R 没见过的。
4. 删 usageHistory 后必须同步修正 usageDaily 聚合，且改库时停服务、先备份、以备份为 ground truth 逐天重写。
