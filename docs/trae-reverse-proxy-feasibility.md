# Trae 本地反代与网关可行性技术调研

> 归档日期：2026-10-02  
> 调研对象：字节跳动 Trae / TRAE SOLO CN 客户端  
> 核心目标：评估是否能像 ZCode（Start Plan 体验包）一样，将 Trae 的模型能力在本地反代为标准 OpenAI / Anthropic 兼容的 API 网关供 10Router 或第三方客户端调用。

---

## 一、调研背景与对比总览

CreditDaddy 在 v1.2.0 中成功实现了 **ZCode 本地体验包网关**（`POST /gateway/v1/messages`，Anthropic 兼容格式），通过本地真实 Chromium 上下文求解阿里云盾验证码并转发请求。

用户提出了进一步设想：**能否将 Trae 积攒的积分（每日签到 ~150 通用积分）也通过类似网关反代出来？**

### 核心对比表

| 维度 | ZCode (Start Plan) | Trae (TRAE SOLO CN) |
|---|---|---|
| **网络传输层** | 标准 HTTP/1.1 与 HTTP/2 | 内部专有 **Frontier WebSocket** (`wss://frontier.zijieapi.com/ws/v2`) |
| **数据序列化** | 标准 JSON + SSE (`text/event-stream`) | 字节私有 **Protobuf 二进制封包** (`pbbp2.Frame`) |
| **通信拓扑** | 无状态单次请求-响应 (Request-Response) | 全双工有状态长连接、双向心跳与流控 |
| **客户端网络栈** | 普通 Node.js fetch / 浏览器 fetch | 依赖私有 Native 动态库 (`sscronet.dll` / `TTNet`) |
| **风控识别手段** | 阿里云图形验证码（可通过渲染窗口求解） | 强校验设备指纹 (`x-device-id`)、`x-ss-stub`、TLS/JA3 硬件指纹 |
| **接口公开度** | 服务端直接提供 Anthropic 协议端点 | 完全私有的内部 RPC 结构，无公开 REST 补全接口 |
| **结论** | **支持，已实现稳定反代** | **工程可行性极低，不建议投入实现** |

---

## 二、Trae 深度技术架构拆解

### 1. 传输层：Frontier WebSocket 而非 HTTP REST
Trae 客户端的 AI 交互不是普通的 HTTP 请求，而是复用了字节跳动内网核心设施 **Frontier 长连接网关**：
- 连接建立：客户端启动时与 `wss://frontier.zijieapi.com/ws/v2`（或国际版对应 Frontier 地址）保持一条持久化 WebSocket。
- 请求多路复用：所有的代码补全（Inline Completion）、对话（Chat）、Agent 任务等，都是在这一条长连接内通过 Stream ID 多路复用传输。
- 难以直接伪造：若使用纯 Node.js 或标准 WebSocket 库连接，缺少完整的 Frontier 协议握手包和鉴权握手阶段，会在建立握手 100ms 内被服务端直接 Reset。

### 2. 报文层：Protobuf (`pbbp2.Frame`) 二进制双向封包
- ZCode 的请求体是可读的 JSON（`{"model":"glm-5.3-flash","messages":[...]}`），响应是标准的 SSE 流。
- Trae 的报文则是纯二进制 **Protocol Buffers**（内部命名为 `pbbp2.Frame`）：
  - 包含了 Service ID、Method ID、Sequence ID、压缩标志位（Gzip/Zstd）、Payload 字节流。
  - Payload 内部嵌有多层嵌套的 `.proto` 结构体，包括上下文 AST 截断片段、编辑器活动态、工程指纹等。
  - 缺乏公开的 `.proto` 契约定义；一旦客户端版本迭代，字段编号和枚举变动会导致反代服务全量抛出解码异常。

### 3. 网络与风控栈：TTNet / Cronet 原生库绑定
Trae 桌面安装包中内嵌了字节自研的 Native 动态库：
- `sscronet.dll`
- `TTNetDownloaderCrossPlatform.dll`

这些库负责底层网络流量发送，并施加了严格的风控逻辑：
1. **纯数字设备指纹**：`x-device-id` 必须与客户端自身注册的设备一致（纯 16 位数字，传 UUID 会直接报 `code 9074` 风控拦截）。
2. **请求摘要签名**：请求头包含动态计算的 `x-ss-stub`（对报文哈希与私有盐的混合签名）。
3. **TLS / JA3 指纹**：服务端会校验 Chromium TTNet 特有的 Cipher Suites 顺序与 ALPN 协商特征，普通 Node.js / Python 请求在握手阶段即被标记为脚本流量。

### 4. 凭据与鉴权限制
Trae 本地的凭据格式为：
- `authorization: Cloud-IDE-JWT <jwt>`
- 该 JWT 可以通过 CreditDaddy 本地解析 `storage.json` 的 `tc` 信封得到。
- 但该 Token 仅对业务 API（如每日签到 `checkin_credits`、额度查询 `ide_user_ent_usage`）开放标准的 HTTPS 接口；**核心的 AI 代码补全服务并不对这些 Web API 开放**，补全权限严格收敛在 Frontier 内部链路中。

---

## 三、可行性评估与成本收益分析

### 1. 尝试破解与反代的工程成本
- **逆向成本**：需要完整 dump 客户端内存或 Hook `sscronet.dll`，逆向全套 `pbbp2` 的 Protobuf 定义文件（数百个字段与方法定义）。
- **进程常驻与入侵性**：由于 Native 库与签名难以完全独立提取，通常需要注入（DLL Injection）或启动受控的 Trae 无头实例，这会导致 CreditDaddy 变得异常臃肿甚至被安全软件报毒。
- **极度脆弱的维护性**：字节跳动客户端更新极其频繁，一旦 Protobuf 字段或签名盐值变动，反代网关即刻瘫痪，需持续投入大量逆向人力修复。
- **高封号风险**：异常的 Frontier 流量模式和高频调用极易触发字节风控系统的批量封禁，导致用户主账号连带受损。

### 2. 收益对比
- Trae 每日签到大约赠送 **150 通用积分**（有效期通常仅为 7 天）。
- 150 积分的额度规模相对较小，主要适合在 IDE 中应对日常编码；将其导出作为通用大模型 API 网关的性价比极低。

---

## 四、最终结论与产品定位

### 1. 结论
**Trae 不适合、也不应作为类似 ZCode 的反代网关进行开发。** 两者的底层通信机制与工程形态存在本质差异。

### 2. CreditDaddy 最佳产品分工
- **ZCode**：
  - 定位为 **「本地免授权 API 网关」**。
  - 充分利用其标准 HTTP/SSE 协议与大额体验包（如 3 亿 Token 一次性体验包 / GLM-5.3-Flash），反代暴露为标准 Anthropic `/gateway/v1/messages` 接口供 10Router / NextChat 无缝调用。
- **Trae**：
  - 定位为 **「多账号资产托管与客户端快速切换辅助」**。
  - **核心价值 1**：每日后台自动签到，持续领取 150 Credits，解决 7 天短期资源包的积攒问题。
  - **核心价值 2**：本地凭据透明解密、多账号登录态完整快照（包含 `storage.json`、`state.vscdb`、分区 Cookie 等 15 项），支持免扫码一键换号。
  - **核心价值 3**：顶栏一键直达唤醒 Trae 客户端，直接在官方原生 IDE 中享受最佳补全体验。
