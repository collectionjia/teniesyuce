# 安装与部署指南

本指南覆盖 Dota2 Elo 服务在 **macOS / Linux / Windows** 上的本地开发、生产部署、定时任务配置。

---

## 1. 环境要求

| 依赖 | 最低版本 | 说明 |
|---|---|---|
| Python | **3.9+** | 推荐 3.11（uvloop 性能更好） |
| pip | 21+ | 随 Python 自带 |
| SQLite | 3.30+ | 几乎所有系统都内置 |
| 操作系统 | macOS 11+ / Ubuntu 20.04+ / Windows 10+ | 定时任务在 macOS 用 launchd，Linux 用 cron |
| 内存 | 256 MB+ | 服务进程 < 100 MB |
| 磁盘 | 200 MB+ | 包含虚拟环境 |
| 网络 | 可访问 OpenDota 公共 API | 默认数据源，无需 token |

外部 API：
- **OpenDota**（主源）：`https://api.opendota.com/api/` — 无需注册
- **Stratz**（备选）：`https://stratz.com/api` — 需要免费 token（https://stratz.com/api → 控制台获取）
- **Cloudflare DNS**（可选，仅自动部署用）：`CF_API_TOKEN`

---

## 2. 快速开始（5 分钟）

### macOS / Linux

```bash
# 1) 解压
unzip dota2elo.zip
cd dota2elo

# 2) 创建虚拟环境并装依赖
python3 -m venv .venv
source .venv/bin/activate

pip install --upgrade pip
pip install -r requirements.txt

# 3) 拉取 + 重算（首次需要几分钟）
python run.py ingest --limit 20

# 4) 启动服务
python run.py serve
# 默认监听 http://127.0.0.1:3001
```

### Windows (PowerShell)

```powershell
# 1) 解压
Expand-Archive dota2elo.zip
cd dota2elo

# 2) 虚拟环境
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1

python -m pip install --upgrade pip
python -m pip install -r requirements.txt

# 3) 拉取数据
python run.py ingest --limit 20

# 4) 启动
python run.py serve
```

### Docker（可选）

> 项目本身不带 Dockerfile，可按下面模板构建：

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 3001
CMD ["python", "run.py", "serve", "--host", "0.0.0.0"]
```

```bash
docker build -t dota2elo:latest .
docker run -d --name dota2elo -p 3001:3001 \
  -e STRATZ_API_KEY=optional_token \
  -v $(pwd)/data:/app/data \
  dota2elo:latest
```

---

## 3. 配置（环境变量）

复制示例配置，按需修改：

```bash
cp .env.example .env
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `STRATZ_API_KEY` | _(空)_ | 启用 Stratz 数据源；空 → 仅 OpenDota |
| `DOTA2ELO_SOURCE` | `auto` | 数据源：`auto` / `opendota` / `stratz` / `multi` |
| `DOTA2ELO_CACHE` | `1` | 是否启用源缓存（`0` 关闭） |
| `CF_API_TOKEN` | _(空)_ | 仅 `cf_dns_setup.sh` 使用 |
| `CF_ZONE_NAME` | `yuce.bid` | Cloudflare 域名 |
| `CF_TARGET_IP` | `95.40.77.158` | A 记录指向的公网 IP |

CLI 参数优先级 > 环境变量 > `.env` > 代码默认值。

---

## 4. 验证安装

```bash
# 1) 健康检查
curl http://127.0.0.1:3001/api/health
# 期望：{"status":"ok", ...}

# 2) 排行榜
curl http://127.0.0.1:3001/api/rankings | head -200

# 3) 预测示例
curl "http://127.0.0.1:3001/api/predict?a=Team%20Spirit&b=Team%20Liquid"
```

浏览器访问：
- 排行榜：http://127.0.0.1:3001/
- 预测：http://127.0.0.1:3001/predict
- 管理：http://127.0.0.1:3001/admin
- API 文档（Swagger UI）：http://127.0.0.1:3001/docs
- OpenAPI 规范：http://127.0.0.1:3001/openapi.json

---

## 5. 定时任务（自动 ingest）

让服务在后台按周期拉取新比赛数据，**关掉 Web 也能继续更新**。

### macOS（launchd）

```bash
# 安装：每 6 小时跑一次
python run.py schedule install --every 6h

# 查状态
python run.py schedule status

# 看日志
python run.py schedule logs

# 健康检查（自动诊断权限/路径问题）
python run.py schedule doctor

# 卸掉
python run.py schedule uninstall
```

⚠️ **macOS 必看**：项目**不要放在 `~/Downloads/`** 下，launchd 子进程读不到该目录
（macOS 系统沙箱限制，会报 `Operation not permitted`）。推荐：

```bash
mv ~/Downloads/dota2elo ~/Code/dota2elo
cd ~/Code/dota2elo
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python run.py schedule install --every 6h
```

实现细节：
- plist 写入 `~/Library/LaunchAgents/com.dota2elo.ingest.plist`
- 包装脚本写入 `~/.local/bin/dota2elo-ingest.sh`（不在 Downloads 内）
- 脚本用系统 Python + `PYTHONPATH` 指向 venv 的 `site-packages`
- `StartInterval` 控制频率；`RunAtLoad=true` 安装后立即跑一次
- 日志：`data/ingest.log` / `data/ingest.err`

### Linux（cron）

```bash
# 编辑 crontab
crontab -e

# 每 6 小时跑一次 ingest
0 */6 * * * cd /path/to/dota2elo && .venv/bin/python run.py ingest --limit 20 >> data/ingest.log 2>&1
```

### Windows（任务计划程序）

```powershell
# 创建每 6 小时运行的任务
$action = New-ScheduledTaskAction -Execute "C:\path\to\dota2elo\.venv\Scripts\python.exe" `
  -Argument "run.py ingest --limit 20" `
  -WorkingDirectory "C:\path\to\dota2elo"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6)
Register-ScheduledTask -TaskName "Dota2Elo Ingest" -Action $action -Trigger $trigger
```

---

## 6. 公网部署

### 方案 A：单机（推荐起步）

```bash
# 1) 准备一台 Linux 云主机（Ubuntu 22.04+）
ssh user@your-server

# 2) 装 Python
sudo apt update && sudo apt install -y python3.11 python3.11-venv

# 3) 部署项目
git clone <your-repo> /opt/dota2elo  # 或上传 zip 解压
cd /opt/dota2elo
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 4) 首次拉数据
python run.py ingest --limit 50

# 5) 用 systemd 管理（详见下一节）
sudo tee /etc/systemd/system/dota2elo.service > /dev/null <<'EOF'
[Unit]
Description=Dota2 Elo Service
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/dota2elo
Environment="PATH=/opt/dota2elo/.venv/bin"
ExecStart=/opt/dota2elo/.venv/bin/python run.py serve --host 0.0.0.0 --port 3001
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now dota2elo

# 6) Nginx 反向代理 + HTTPS（推荐用 certbot）
sudo apt install -y nginx certbot python3-certbot-nginx
# 配置 /etc/nginx/sites-available/dota2elo ...
```

### 方案 B：Cloudflare Tunnel（零公网 IP）

无需开防火墙、无需买证书：

```bash
# 1) 安装 cloudflared
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared

# 2) 登录 + 创建隧道
cloudflared tunnel login
cloudflared tunnel create dota2elo

# 3) 配置 DNS
cloudflared tunnel route dns dota2elo elo.your-domain.com

# 4) 写配置 /etc/cloudflared/config.yml
sudo tee /etc/cloudflared/config.yml > /dev/null <<'EOF'
tunnel: dota2elo
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: elo.your-domain.com
    service: http://localhost:3001
  - service: http_status:404
EOF

# 5) 跑起来
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

---

## 7. 数据导入（可选）

### 导入 dota-pro-db T1 比赛（推荐）

```bash
# 首次会自动从 https://github.com/dca123/dota-pro-db/releases 下载
python run.py import-pro-db
```

数据源：2025 全年 T1 职业比赛，含 picks/bans、选手、时长等。

### 导入 Betty HuggingFace（可选）

> ⚠️ HuggingFace xet-bridge CDN 在国内网络下经常 403。
> 建议在有直连的机器上下载后上传到 `data/external/betty-matches.parquet`。

```bash
# 把 parquet 文件放到 data/external/ 后运行
python run.py import-betty
```

---

## 8. 常见问题

### Q1: `pip install` 报 `Operation not permitted`

macOS 在 Downloads 目录下会触发沙箱限制，参考前面"项目不要放在 ~/Downloads"。

### Q2: 拉数据很慢 / 报 429

OpenDota 公共 API 限速约 1 req/s。本服务客户端已内置 1.1 req/s 节流。
如频繁 429，先停 ingest，过 5 分钟再试。

### Q3: 想清空数据库重新计算

```bash
rm data/dota2elo.db
python run.py ingest --limit 50
```

### Q4: 怎么清缓存？

```bash
# CLI
python run.py cache clear

# 或 API
curl -X POST http://127.0.0.1:3001/api/admin/cache/clear
```

### Q5: 端口被占用

```bash
# 查谁在用
lsof -i :3001

# 改端口启动
python run.py serve --port 8080
```

### Q6: Stratz 返回 401 / 500

- 401：token 无效或过期，去 https://stratz.com/api 重新生成
- 500：可能是免费额度用完，或 Stratz 本身故障；服务会自动回退到 OpenDota

### Q7: 如何升级

```bash
# 拉最新代码
git pull  # 或重新解压

# 升级依赖
source .venv/bin/activate
pip install -r requirements.txt --upgrade

# 全量重算（不删库）
python run.py ingest --limit 50
```

### Q8: 服务占内存太多

可能原因：`data/dota2elo.db` 太大。
```bash
# 看大小
ls -lh data/dota2elo.db

# 收缩（SQLite VACUUM）
sqlite3 data/dota2elo.db "VACUUM;"
```

---

## 9. 卸载

```bash
# 停定时任务
python run.py schedule uninstall

# 停服务
# macOS launchd:
launchctl unload ~/Library/LaunchAgents/com.dota2elo.ingest.plist
# systemd:
sudo systemctl disable --now dota2elo
# 直接 Ctrl+C 终止前台进程

# 删项目目录
rm -rf /path/to/dota2elo
```

---

## 10. 下一步

- 📖 阅读 `PROJECT.md` — 项目功能全景
- 🏗️ 阅读 `ARCHITECTURE.md` — 技术架构
- 📚 阅读 `API.md` — 完整 API 参考
- 🚀 阅读 `openapi.json` — 机器可读的接口规范（导入 Postman/Insomnia）
