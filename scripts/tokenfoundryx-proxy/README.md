# TokenFoundryX → Cursor 本地代理

上游 `https://www.tokenfoundryx.com/v1/chat/completions` 当前不可用（所有模型被错误路由到已挂的 `claude-sonnet-4-5` 渠道）。`/v1/responses` 正常，本代理把 Cursor 的 chat/completions 转到 responses。

## 启动

```powershell
cd d:\bbbbb\scripts\tokenfoundryx-proxy
.\start.ps1
```

默认监听：`http://127.0.0.1:8787/v1`

## Cursor 设置

1. Cursor Settings → Models
2. OpenAI API Key：填 TokenFoundry 的 key
3. Override OpenAI Base URL：`http://127.0.0.1:8787/v1`
4. Add Model：`gpt-5.6-sol`
5. 聊天里选择 `gpt-5.6-sol`

代理需保持运行；关掉后 Cursor 会连不上。
