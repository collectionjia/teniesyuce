# CodeBuddy HTTP API 本地搭建

基于官方文档：[CodeBuddy Code HTTP API Beta](https://www.workbuddy.cn/docs/cli/http-api)

## 1. 安装 CLI

```powershell
npm install -g @tencent-ai/codebuddy-code
codebuddy --version
```

## 2. 首次登录（很重要）

WorkBuddy 桌面端登录 **不等于** CodeBuddy CLI 已登录。

如果 job 一直卡在 `preparing`，先执行：

```powershell
codebuddy
```

按提示完成腾讯账号 / WorkBuddy 登录。

检查状态：

```powershell
.\check.ps1
```

## 3. 启动本地 HTTP 服务

```powershell
cd D:\bbbbb\scripts\codebuddy-api
.\start-server.ps1
```

默认监听：`http://127.0.0.1:8080`

- Web UI：`http://127.0.0.1:8080/`
- Swagger：`http://127.0.0.1:8080/api/docs`
- 健康检查：

```powershell
curl.exe -H "X-CodeBuddy-Request: 1" http://127.0.0.1:8080/api/v1/health
```

## 4. 发送一条消息

PowerShell：

```powershell
.\chat.ps1 -Prompt "你好，用一句话介绍你自己"
```

Python：

```powershell
python .\client.py "你好，用一句话介绍你自己"
```

## 5. 常用 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/health` | 健康检查 |
| POST | `/api/v1/jobs` | 派发 agent 任务 |
| GET | `/api/v1/jobs/:id/stream` | SSE 流式输出 |
| GET | `/api/v1/jobs/:id/transcript` | 读取对话 transcript |
| POST | `/api/v1/runs` | Gateway 协议发起执行 |
| GET | `/api/v1/runs/:id/stream` | 读取 run 结果 |

所有 `/api/v1/*` 请求建议带上：

```text
X-CodeBuddy-Request: 1
```

如果启用了密码认证，还需要：

```text
Authorization: Bearer <password>
```

## 6. 给 Cursor 用

CodeBuddy HTTP API **不是 OpenAI 兼容格式**，Cursor 不能直接填 Base URL 使用。

可选方案：

1. 继续用 `workbuddy2api` 做 OpenAI 兼容代理
2. 自己写一层 FastAPI，把 OpenAI `/v1/chat/completions` 转成 CodeBuddy `/api/v1/jobs`

## 7. 安全说明

`start-server.ps1` 默认 `--auth none`，仅适合本机开发。

对外暴露时请改用：

```powershell
.\start-server.ps1 -WithAuth
```

启动后终端会打印密码，写入 `%USERPROFILE%\.codebuddy\settings.json`。
