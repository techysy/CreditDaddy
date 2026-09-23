# fnOS 部署（fpk）

## 构建方式

代码推到 GitHub 后，打 tag 触发 Actions（或手动 workflow_dispatch）：

    git tag v0.1.0 && git push origin main --tags

Actions 会在 ubuntu-24.04 / ubuntu-24.04-arm 两个 runner 上分别用官方 fnpack 1.2.1 打包，
产物：

    qoderdaddy-<version>-x86.fpk
    qoderdaddy-<version>-arm.fpk
    SHA256SUMS-fpk.txt

打 tag 时自动建 Release 并附上产物；手动触发则去 Actions 页面下载 artifact。

## 安装

fnOS 应用中心 → 手动安装 → 选择 fpk。会自动安装依赖应用 nodejs_v24。

## 安装后

1. 首次启动会生成面板访问密钥，写入 <数据目录>/panel_key（0600），
   并在安装日志打印一次 —— 打开面板时输入该密钥
2. 桌面出现 QoderDaddy 图标，点击打开面板（端口 47860）
3. 数据目录：@appdata/qoderdaddy（账号 token 均只存本机）
4. 服务监听 0.0.0.0:47860，所有 /api/* 需要 x-qd-key 头（或 ?key=）

## 手动运维

fnOS 应用详情页可启停；命令行：

    /var/apps/qoderdaddy/cmd/main start|stop|status|restart

日志：<数据目录>/qoderdaddy.log

## 升级 / 卸载

- 升级：应用中心覆盖安装新版本 fpk，panel_key 与账号数据保留
- 卸载：卸载不会删除 @appdata/qoderdaddy 数据目录，需手动清理
