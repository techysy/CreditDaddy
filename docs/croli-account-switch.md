# Croli 0.0.19 账号切换调查（Windows，2026-11-25）

本机安装的 Croli.exe 文件版本为 0.0.19.0；运行时有 Croli.exe 与 croli-server.exe。只读检查发现 `%APPDATA%\Croli\auth.json` 仍包含 `access_token`、`refresh_token`、`expires_at` 三个字段；JWT 的 `sub` 仍是 `user_…`，签发方仍是 `https://clerk.croli.net`。检查时没有输出或修改任何实际票据。Electron 安装包仍通过 sidecar 启动 `croli-server.exe`。这些证据支持沿用旧版冷启动凭据切换路径，但不能代替真实双账号切换验证。

CreditDaddy 的实现：读取当前客户端票据并以 `sub` 归户保存 → 对目标账号的临期快照单次续期（独立账号才由 CD 使用 refresh token）→ 停 Croli 壳、sidecar 和 CLI → 写入完整目标快照 → 延时复核 `sub` 与 refresh token → 重启客户端。若进程未退出、目标凭据缺失或过期、写后被覆盖，立即报错。当前客户端的票据轮换由 sidecar 持有；CD 的额度读取和签到只会从同一 `sub` 的本机凭据同步最新 access/refresh。10Router 同步只推 access，不复制一次性 refresh token。

限制：离线账号保存的 refresh token 可能被其它会话先行轮换；此时需在官方客户端重新登录并导入。真实双账号切换及官方客户端界面最终身份尚未在本机执行验收，以免中断正在运行的会话。隔离临时目录的切号、同身份匹配、过期阻断和续期并发测试均通过。
