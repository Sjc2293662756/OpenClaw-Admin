# GAIOP Admin 本地开发

本项目是 GAIOP 的 Web 管理台与产品前端工程。日常开发在本机完成，麒麟服务器仅用于与真实 Docker OpenClaw Gateway 的联调和发布验证。

## 首次准备

1. 使用 Node.js 20 或更高版本。
2. 复制 `.env.example` 为 `.env`，仅在本机填写登录信息和 Gateway Token；`.env` 不得提交 Git。
3. 安装依赖：`npm ci`。

## 连接麒麟测试环境

日常本地开发推荐双击根目录的：

```text
D:\杨硕文件\GAIOP\GAIOP\启动GAIOP本地开发环境.cmd
```

启动器会建立或复用 Docker / 原生 Gateway 隧道、本机 Admin BFF 和 Vite 前端；第一次会在本机安全提示输入告警 Syslog 的 SSH 地址、账号和密码，之后通过当前 Windows 用户的加密凭据自动读取。该信息不写入脚本、`.env`、Git、文档或日志。启动器不会修改服务器、OpenClaw、Syslog 或 NAPM。

若仅需手工建立 Gateway 隧道：

```powershell
ssh -i C:\Users\Peter\.ssh\id_ed25519 -N `
  -L 8080:127.0.0.1:18789 `
  -L 8081:127.0.0.1:18790 `
  root@101.254.114.236
```

本地 `.env` 使用：

```dotenv
PORT=3001
OPENCLAW_WS_URL=ws://127.0.0.1:8080
OPENCLAW_AUTH_TOKEN=<仅本机保存的 Docker Gateway Token>
AUTH_USERNAME=<本地管理台用户名>
AUTH_PASSWORD=<本地管理台密码>
```

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
