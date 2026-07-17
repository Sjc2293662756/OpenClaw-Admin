# GAIOP Admin 本地开发

本项目是 GAIOP 的 Web 管理台与产品前端工程。日常开发在本机完成；当前联调 Gateway 为 Ubuntu 237 上的最新 GAIOP/OpenClaw 开发环境，NAPM 数据源仍为 238。

## 首次准备

1. 使用 Node.js 20 或更高版本。
2. 复制 `.env.example` 为 `.env`，仅在本机填写登录信息和 Gateway Token；`.env` 不得提交 Git。
3. 安装依赖：`npm ci`。

## 连接麒麟测试环境

日常本地开发推荐双击根目录的：

```text
D:\杨硕文件\GAIOP\GAIOP\启动GAIOP本地开发环境.cmd
```

启动器会建立或复用同一条 SSH 连接上的本机 `3003 → 237:18789` Gateway 隧道、`3004 → 237:19090` 正式 Syslog 接收器隧道，以及本机 Admin BFF 和 Vite 前端；第一次会在本机安全提示输入 237 告警 Syslog 的 SSH 地址、账号和密码，之后通过当前 Windows 用户的加密凭据自动读取。该信息不写入脚本、`.env`、Git、文档或日志。启动器不会修改服务器、OpenClaw、Syslog 或 NAPM。

若只需建立服务隧道，可双击根目录的 `连接237GAIOP服务.cmd`；若还需使用正式 Syslog 接收器，应使用“启动GAIOP本地开发环境.cmd”，它会同时建立 3003 和 3004。成功后窗口会保留启动结果，按任意键关闭提示窗口不影响后台隧道；隧道遇到短暂 SSH 断开时会自动重连。随后在管理台“GAIOP 服务配置”中填写 `ws://127.0.0.1:3003` 及服务访问令牌，并点击“保存并重新连接”。本机开发不能填写 237 的回环地址，因为该地址只在 237 服务器内部有效，也不要再使用历史本机端口 8080。

将 Admin BFF 部署到 237 后，不再需要 SSH 隧道；同机部署配置应填写 `ws://127.0.0.1:18789` 及部署侧提供的服务访问令牌。

237 使用本机 DPAPI 加密的开发凭据，手工模式不接收或记录密码；请使用上述启动器建立隧道。旧 236 双 Gateway 隧道仅作历史回退参考，不再是默认开发目标。

本地 `.env` 使用：

```dotenv
PORT=3001
OPENCLAW_WS_URL=ws://127.0.0.1:3003
OPENCLAW_AUTH_TOKEN=<仅本机保存的 Docker Gateway Token>
AUTH_USERNAME=<本地管理台用户名>
AUTH_PASSWORD=<本地管理台密码>
```

`OPENCLAW_AUTH_TOKEN` 必须是 237 当前 Gateway 对应的本机受控 Token。隧道端口连通只证明网络路径可用；应以 BFF 健康接口中的 Gateway 状态已连接、且工作台可正常创建并发送会话作为最终联调结果。

手工启动本地前端与后端（告警只读数据源需要额外的运行时环境变量）：

```powershell
npm run dev:all
```

用户访问 `http://127.0.0.1:3002/welcome`；Admin BFF 监听 `http://127.0.0.1:3000`。如需更换保存的本机告警凭据：

```powershell
& 'D:\杨硕文件\GAIOP\GAIOP\启动GAIOP本地开发环境.ps1' -ResetAlertCredential
```

## 设备配对

Gateway 会为本管理台生成设备配对请求。`server/gateway.js` 将设备身份保存到 `data/gateway-device-identity.json`，避免每次重启都创建新设备。该文件已被 Git 忽略，首次连接时应仅批准一次该固定设备。

## 发布约定

- 先在本地完成构建和真实 Gateway 联调。
- 通过 Git 提交前端源码；禁止提交 `.env`、Token、NAPM 凭据或 `data/` 下的运行数据。
- 服务器运行目录：`/opt/gaiop/openclaw-admin`。
- 服务器管理台仅监听 `127.0.0.1:3001`，经 SSH 隧道访问。
