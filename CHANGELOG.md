# Changelog

## [Unreleased]

---

## [0.9.4] - 2026-09-27

### Fixed
- 日志时间戳改用本机时区（原为 UTC+0，现跟随系统时区如 UTC+8）
- 修复前端卡片删除账号无响应问题（`armed is not defined`）(#2)

---

## [0.9.3] - 2026-09-26

### Added
- ZCode 客户端运行状态芯片（面板实时显示客户端是否运行）
- 桌面版一键打开 ZCode 客户端

### Fixed
- 额度条 100% 时残留灰色尾段

---

## [0.9.2] - 2026-09-20

### Fixed
- 10Router 聚合视图按源数据口径显示：百分比额度显示 %，各行平等，不再被重置为绝对数字
- 10Router 主额度行改分散对齐：名称靠左，数值与相对重置时间靠右
- WorkBuddy 产品卡合并行防截断
- CLI 文案统一为「领取」

### Changed
- WorkBuddy 产品卡国内/国际合并为一行（领取 / 活跃 x/x（国内）· x/x（国际））
- README 门面优化

---

## [0.9.1] - 2026-09-10

### Added
- ZCode 自动轮询领取开关（默认关）

### Changed
- ZCode 卡片不再显示任何徽标

---

## [0.9.0] - 2026-09-08

### Added
- ZCode 活动领取自动轮询：每轮签到后自动查可领活动并领取
- 桌面版隐藏窗口静默通过验证码

### Fixed
- WorkBuddy 页 innerHTML 汇总覆盖后 s-done 丢失，导致改名/切页报 textContent 空指针
- store 原子写 rename 失败重试 + 兜底直写，修复 Windows 上 EPERM 导致的签到轮报错

### Changed
- ZCode 代理地址可面板配置（优先于 HTTPS_PROXY 环境变量）
- 仪表盘/详情页措辞按语义拆分：国内签到 / 国际活跃
- 文案统一为「领鸡蛋」语义：Qoder / WorkBuddy 都叫领取，仅国际版叫保持活跃
- KPI「活跃 x/x」改为小字副标
- 汇总卡窗口额度多进度条
- 设置加「隐藏 0/无额度汇总卡」
- 胶囊徽章去类型背景色
- 10Router 全部视角去掉「最早到期」；隐藏项不出现在标签；单连接卡周/月额度默认带进度条

---

## [0.8.0] - 2026-08-25

### Added
- npm 包发布渠道
- macOS 桌面版（dmg + zip）
- 10Router 健康状态显示（/api/health：正常/异常/驱动降级）
- 10Router 供应商标签页视图：「全部」按供应商汇总成卡，标签页看单连接明细
- WorkBuddy 国际版「活跃领取」签到

### Fixed
- macOS 构建要求 ≥512 图标（改为 1024x1024）
- ZCode billing 版本跟随本机客户端（3001 修复）
- ZCode 客户端当前账号按 uid+email 识别

### Changed
- 10Router 卡片对齐账号主卡版式；积分包按系列聚合
- 10Router 额度行对齐 CLIProxyAPI 管理中心样式：三档水位条 + 相对重置标签
- 10Router 卡片默认只显示主额度，其余收进摘要（明细可展开）
- ZCode 出口可切「代理优先」并自动回退

---

## [0.7.0] - 2026-08-10

### Added
- ZCode 活动领取（preview→claim + 面板阿里云验证码）
- ZCode 卡片显示套餐权益额度

### Fixed
- ZCode 强制切换先关闭客户端

---

## [0.6.0] - 2026-07-20

### Added
- 10Router 集成（供应商额度卡片 + 用量同步）
- fnOS 窗口版 fpk
- WorkBuddy/CodeBuddy 及 ZCode 浏览器登录

### Fixed
- fnOS 安装向导设置面板密码；面板 401 时重新提示

---

## [0.5.0] - 2026-07-01

### Added
- Qoder 国际版在 fnOS/Linux 上通过设备身份组件签到
- fnOS 双桌面入口（新标签页 + fnOS 窗口）；页内对话框
