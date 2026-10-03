# MiniMax Code 本地反代网关与资产管理可行性技术调研

> 归档日期：2026-10-02  
> 调研对象：名之梦 MiniMax Code（MCode）桌面客户端  
> 核心目标：评估是否能将 MiniMax Code 纳入 CreditDaddy 资产管理（每日自动签到、额度监控、本地凭据自动发现），并将其模型能力反代为标准的 Anthropic API 网关供 10Router 或第三方客户端调用。

---

## 一、调研背景与总览

CreditDaddy 在 v1.2.0 中成功实现了 **ZCode 本地体验包网关**（`POST /gateway/v1/messages`，Anthropic 兼容格式），但 ZCode 存在需要真实 Chromium 无头窗口求解阿里云盾滑块验证码的工程约束。在此之前对字节跳动 **Trae** 的调研中，由于其底层强绑定私有 Frontier WebSocket、Protobuf 二进制封包与 Native TTNet 动态库，导致反代可行性极低。

在对 **MiniMax Code（MCode 桌面客户端）** 的逆向反编译、数据流追踪与接口实测中，我们得出了突破性的结论：**MiniMax Code 天然采用标准 HTTP REST + Anthropic Messages 协议，且完全没有验证码与底层风控，是迄今为止反代可行性最高、工程最优雅的客户端平台。**

### 三大客户端横向对比表

| 维度 | Trae (字节跳动) | ZCode (智谱) | **MiniMax Code (名之梦)** |
|---|---|---|---|
| **网络传输层** | 私有 Frontier WebSocket 长连接 | 标准 HTTPS (REST) | **标准 HTTPS (REST)** |
| **数据序列化** | 私有 Protobuf 二进制 (`pbbp2.Frame`) | JSON + SSE | **标准 JSON + SSE** |
| **上游接口规范** | 内部私有 RPC，无公开补全 API | Anthropic 协议端点 | **原生标准 Anthropic Messages 规范** |
| **风控阻断与验证码** | 强校验设备指纹、`x-ss-stub`、JA3 | **阿里云盾图形验证码**（需 Chromium 求解） | **零验证码！纯 Bearer Token 即可放行！** |
| **反代工程难度** | 🔴 极高（已放弃） | 🟡 中等（需验证码求解器） | 🟢 **极低（纯 Node.js fetch 透明转发即可）** |
| **资产与白嫖价值** | 每日 150 积分（7天过期） | 体验包消耗（3亿 Token） | **每日签到 1200~3000 积分 + 免费模型池** |
| **结论** | 仅适合做账号快照与自动签到 | 已支持反代网关 | **全量支持：自动签到 + 本地 API 网关** |

---

## 二、MiniMax Code 深度架构与实测验证

### 1. 发现官方的原生 Anthropic 架构
在客户端运行时配置 `~/.minimax/config.yaml` 中，MiniMax Code 明确声明了其底层 LLM 适配器配置：
```yaml
provider:
  minimax:
    name: MiniMax
    npm: '@ai-sdk/anthropic'   # 直接采用 Vercel AI SDK 的 Anthropic Messages 适配器
    options:
      apiKey: sk-xxx
      baseURL: https://agent.minimax.cn/mavis/api/v1/llm/v1
```
其模型能力完全通过标准的 Anthropic 端点提供：
- 端点：`https://agent.minimax.cn/mavis/api/v1/llm/v1/messages`
- 支持模型列表：
  - `MiniMax-M3.1-Flash-Preview`（支持 Thinking 深度思考推理、512K/1M 上下文）
  - `MiniMax-M3`
  - `MiniMax-M2.7-highspeed`
  - `MiniMax-M2.7`

### 2. 补全接口实测（100% 成功）
从本机凭据文件 `~/.minimax/auth/prod/cn/mcode-public/auth.json` 提取 `accessToken`（格式为 `mmoat_...`）：
```http
POST https://agent.minimax.cn/mavis/api/v1/llm/v1/messages HTTP/1.1
Host: agent.minimax.cn
Authorization: Bearer mmoat_xxxxxxxxxxxx
anthropic-version: 2023-06-01
Content-Type: application/json

{
  "model": "MiniMax-M3.1-Flash-Preview",
  "max_tokens": 50,
  "messages": [{"role": "user", "content": "hi"}]
}
```
**实测结果：**
- 无需浏览器环境、无需任何设备指纹或签名头，直接返回标准 Anthropic 消息结构体（包含 `thinking` 与 `text`）。
- 响应速度约 1~2 秒，支持 SSE 流式推流。
- 4 个主流模型均全量测试通过。

### 3. 每日自动签到实测（100% 成功）
针对 MiniMax 客户端每日连续签到赠送 800~2000（外加 400）算力币的活动：
- **状态查询接口**：
  `GET https://agent.minimax.cn/minimax-cloud/api/v1/signin/status?timezone_offset=28800&is_desktop=1&client=desktop`
  - 携带 Bearer Token 即可获取 7 天连签状态与今日奖励数值。
- **领取奖励接口**：
  `POST https://agent.minimax.cn/minimax-cloud/api/v1/signin/claim?timezone_offset=28800&is_desktop=1&client=desktop`
  - 同样使用 Bearer Token 发起 POST，即可成功入账算力币。

---

## 三、产品与交互设计方案

为保持 CreditDaddy 界面与交互的一致性与轻量化，MiniMax Code 的入口与交互完全**对齐 ZCode 的极简设计**：

1. **顶栏状态与控制入口**：
   - 切换到 `MiniMax` 产品视图后，顶栏提供：
     - **接口按钮**：状态灯指示当前网关开启状态（如 `● 接口` / `● 接口·局域网`）。
     - **打开客户端按钮**：状态灯检测本机 `MiniMax Code.exe` 是否在运行，支持一键前台激活或启动。
2. **弹窗设置**：
   - 点击「接口」按钮弹出网关配置对话框：
     - 启用/停用 MiniMax 本地接口开关。
     - 接口地址展示（`POST /gateway/minimax/v1/messages` 或通用 `/gateway/v1/messages`）。
     - 局域网开放（`0.0.0.0` 绑定）与 IP 白名单支持。
     - 推荐模型与 10Router 配置指南。
3. **资产管理与自动签到**：
   - 本机扫描支持自动发现 `~/.minimax` 登录账号。
   - 纳入 CreditDaddy 核心调度器（每 ~2 小时自动检查并签到，防止断签）。
4. **多账号轮换**：
   - 当用户在 CreditDaddy 中导入多个 MiniMax 账号时，本地网关自动在多账号之间进行负载均衡和故障回退（401 自动拉黑，429 自动冷却）。

---

## 四、结论与下一步行动

**结论**：MiniMax Code 接入技术条件完全成熟，无任何不可逾越的协议壁垒或风控门槛，应立即落地实施。

**落地计划**：
1. 注册 `minimax` 供应商（`constants.js`、`providers.js`、`store.js`）。
2. 实现 `minimaxClient.js`（每日签到、额度查询、Token 校验）。
3. 实现 `minimaxLocal.js`（本地客户端检测、`~/.minimax` 凭据自动扫描、客户端进程状态与唤醒）。
4. 实现 `minimaxGateway.js`（Anthropic 兼容本地反代端点、账号轮换、局域网白名单）。
5. 在 `panel.html` 接入 MiniMax 专属标签页、顶栏按钮状态灯与设置弹窗。
