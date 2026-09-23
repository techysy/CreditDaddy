# 🐻‍❄️ QoderDaddy

**Qoder 多账号本地管理 + 每日 Credits 自动签到助手。**

架构参考 [WorkDaddy](https://github.com/babygoton/WorkDaddy)（本地守护进程 + Web 面板 + 数据全留本机 + 仅监听 127.0.0.1），
签到能力移植自 [10router](https://github.com/techysy/10router) 的 qoderCheckin 实现：
拉取活动列表 → 筛选 CLAIM_BENEFIT + CLAIMABLE → 逐个领取。

## 功能

- **多账号管理**：国际版 / 国内版 Qoder 账号统一管理，添加时自动拉取昵称
- **网络授权登录**：面板一键发起 Qoder 设备码授权（PKCE + nonce，与官方 qodercli 同流程），浏览器选账号确认后 token 自动入库，无需手动复制
- **本机检测导入**：检测本机 Qoder IDE / CLI 安装，扫描 userData 与 ~/.qoder 中的 dt-/pt- token，勾选导入（纯本地进行，token 不出机器）
- **每日自动签到**：守护进程每 ~2 小时（+0~10 分钟抖动）扫描一轮；当天已领的账号记忆跳过；"无可领活动"不记忆——每日积分刷新窗口（10:00 UTC+8）过后会自动重试。"签到日"以 10:00 (UTC+8) 为界，与本机时区无关
- **PAT 支持**：pt- 开头的 Personal Access Token 自动兑换短期 job token
- **手动签到 / 配额查询**：面板按钮或 CLI 一键操作
- **导入导出**：跨机器迁移账号
- **数据边界**：全部数据存 ~/.qoderdaddy（0600 权限 + 原子写 + 进程内串行写入），无任何遥测、无第三方依赖
- **本机防护**：只监听 127.0.0.1，并校验 Host 头（防 DNS 重绑定）、拒绝跨站 Origin（防 CSRF），网页无法偷读或篡改本机账号

## 快速开始

需要 Node 18+，零依赖：

    node bin/qoderdaddy.js daemon        # 启动守护进程，打开 http://127.0.0.1:47860

CLI 用法：

    node bin/qoderdaddy.js add <token>             # 添加国际版账号
    node bin/qoderdaddy.js add <token> --cn        # 添加国内版账号
    node bin/qoderdaddy.js add <token> --name 工作号
    node bin/qoderdaddy.js list                    # 查看账号
    node bin/qoderdaddy.js checkin                 # 立即签到全部
    node bin/qoderdaddy.js checkin --cn            # 只签国内版
    node bin/qoderdaddy.js remove <id前缀>          # 删除账号
    node bin/qoderdaddy.js export backup.json      # 导出（含明文 token）
    node bin/qoderdaddy.js import backup.json      # 导入
    node bin/qoderdaddy.js help                    # 帮助

## API 端点（源自 10router 实测）

    GET  /sash/api/v1/me/campaigns?clientType=10        活动（签到）列表
    POST /sash/api/v1/me/campaigns/{id}/claim           领取
    GET  /api/v1/userinfo                               账号信息
    GET  /api/v2/quota/usage                            配额
    POST /api/v1/jobToken/exchange                      PAT → job token

基础地址：国际版 openapi.qoder.sh，国内版 openapi.qoder.com.cn。
请求头（Cosy-ClientType: 10 等）与 10router 的 qoderCheckin.js 保持一致。

### 本地 HTTP API

    GET    /api/accounts                账号列表（脱敏）
    POST   /api/accounts                添加 {name, provider, token}
    DELETE /api/accounts/:id            删除
    POST   /api/accounts/:id/checkin    单账号签到
    GET    /api/accounts/:id/quota      配额
    POST   /api/checkin                 全部签到 {provider?, skipIfCheckedToday?}（默认跳过今日已签）
    POST   /api/auth/device/start       发起设备码授权 {provider}
    POST   /api/auth/device/poll        轮询授权结果 {sessionId}
    GET    /api/local/detect            检测本机 Qoder 安装
    POST   /api/local/scan              扫描本机 token 候选
    POST   /api/local/import            导入扫描候选 {candidateId, provider}
    GET    /api/status                  状态
    GET    /api/logs                    日志
    POST   /api/export | /api/import    导出/导入

设置环境变量 `QODERDADDY_PASSWORD` 后，所有 /api/* 需要 `x-qd-key` 头（fnOS 部署自动启用）。

## 签到状态说明

| status | 含义 | 当日记忆 |
|---|---|---|
| checked-in | 领取成功，含金额 | ✓ 记忆，今天不再重复请求 |
| already | 有积分活动但已领过 | ✓ 记忆 |
| no-activity | 当前无可领活动（可能窗口未开） | ✗ 下轮重试 |
| failed | 鉴权失败 / 网络错误等 | ✗ 下轮重试 |

> ⚠️ 非官方接口，Qoder 调整服务端时可能失效。请遵守平台服务条款，仅管理自己的账号。

## 目录结构

    bin/qoderdaddy.js    CLI 入口
    src/constants.js     端点与请求头常量（版本号取自 package.json）
    src/qoderClient.js   Qoder OpenAPI 客户端（签到核心）
    src/checkin.js       调度器（2h tick + 当日去重 + 串行执行）
    src/accounts.js      账号新增 / 批量导入的统一入口
    src/authDevice.js    设备码授权登录（PKCE）
    src/localDetect.js   本机 Qoder 检测与 token 扫描
    src/daemon.js        本地 HTTP API + 面板托管
    src/panel.html       Web 管理面板
    src/store.js         本机存储（原子写 / 0600 / 串行读改写）
    src/logger.js        环形缓冲日志
    test/                冒烟测试
    desktop/             Windows 桌面版（Electron 壳）
    fnos-packaging/      fnOS fpk 打包

## 开发

    npm test                                  # 运行测试（node --test，零依赖）
    npm start                                 # 启动守护进程

推送 / PR 会在 GitHub Actions 上跑测试（Ubuntu + Windows，Node 20 / 24）。
发版：同步修改 `package.json`、`desktop/package.json`、`fnos-packaging/manifest` 的版本号后打 `v*` tag。

## Windows 桌面版（Electron 壳）

Releases 下载 **QoderDaddy-Setup-x.y.z.exe**（安装版）或 **QoderDaddy-Portable-x.y.z.exe**（免安装）：

- 打开即用：内置 Node daemon，无需单独安装 Node.js
- 关闭窗口 = 最小化到托盘，**后台自动签到不中断**；托盘菜单可"打开面板 / 立即签到 / 退出"
- 数据仍存 `%USERPROFILE%\.qoderdaddy`（便携版与安装版通用同一数据目录）

fnOS / NAS 用户请用 **fpk** 包（见 DEPLOY.md）；两者功能一致，面板都在 `127.0.0.1:47860`。

## License

MIT
