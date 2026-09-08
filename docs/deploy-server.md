# 服务器部署说明

## 1. 项目目录

| 位置 | 路径 |
|------|------|
| 线上推荐 | `/opt/yuce` |
| GitHub | https://github.com/collectionjia/yuce （私有） |

## 2. 前置条件

- Ubuntu + Docker / Docker Compose
- 已配置 `server/.env`（从 `server/.env.example` 复制）
- 私有仓库需先在服务器配置 Git 访问：
  ```bash
  # HTTPS + Personal Access Token
  git clone https://<TOKEN>@github.com/collectionjia/yuce.git /opt/yuce

  # 或 SSH（把公钥加到 GitHub）
  git clone git@github.com:collectionjia/yuce.git /opt/yuce
  ```

## 3. 一键部署（Lightsail 网页终端）

```bash
cd /opt/yuce
chmod +x scripts/deploy-server.sh
bash scripts/deploy-server.sh
```

**首次全新机器：**

```bash
export INSTALL_DIR=/opt/yuce
export REPO_URL='https://<TOKEN>@github.com/collectionjia/yuce.git'
sudo mkdir -p /opt
sudo git clone "$REPO_URL" "$INSTALL_DIR"
sudo chown -R $USER:$USER "$INSTALL_DIR"
cd "$INSTALL_DIR"
cp server/.env.example server/.env
nano server/.env
bash scripts/deploy-server.sh
```

## 4. 常用命令

```bash
bash scripts/deploy-server.sh                 # 核心服务
bash scripts/deploy-server.sh --web-only --no-cache
bash scripts/deploy-server.sh --status
bash scripts/deploy-server.sh --logs server
```

## 5. Compose 文件 / 测试与生产

| 文件 | 说明 |
|------|------|
| `docker-compose.core.yml` | redis + btc-board + server + web |
| `deploy/test.env` | 测试：`yuce-test`，web `9018`，**不启 redis**，用 `server/.env.test` |
| `deploy/prod.env` | 生产：`yuce-prod`，web `80`，`COMPOSE_PROFILES=with-redis` |

```bash
# 改端口：编辑对应 env 里的 WEB_PORT / BOARD_PORT / REDIS_HOST_PORT
bash scripts/docker-deploy.sh test up -d --build
bash scripts/docker-deploy.sh prod up -d --build

bash scripts/docker-deploy.sh test ps
curl -s http://127.0.0.1:9018/api/health   # 测试默认
curl -s http://127.0.0.1/api/health        # 生产默认 80
```

同机可同时跑测试+生产（项目名与端口不同）。`server/.env` 仍是 DB/Redis/密钥等业务配置。

**测试/生产采集代理（monitor.env）：**

| 文件 | 何时加载 |
|------|----------|
| `monitor.env.test` | `APP_ENV=test` 或 `SOFA_MONITOR_ENV_FILE=monitor.env.test` |
| `monitor.env.prod` | `APP_ENV=production` |
| `monitor.env` | 回退（兼容旧部署） |

```bash
cp scripts/tennis-monitor/env.monitor.test.example scripts/tennis-monitor/monitor.env.test
cp scripts/tennis-monitor/env.monitor.prod.example scripts/tennis-monitor/monitor.env.prod
# 填入各自 IPWO 账号；勿提交 Git
```

## 6. 核心目录

| 目录 | 作用 |
|------|------|
| `btc-board/` | BTC 链上持仓看板（Python，Docker 8890） |
| `scripts/tennis-monitor/` | 网球数据采集（Sofascore，宿主机 9004，systemd `tennis-monitor`） |
| `client/` | Vue 前端 |
| `server/` | Node API |

**从旧目录名迁移（线上一次性）：**

```bash
# 旧安装目录 /opt/yuce/bbbbb → /opt/yuce
if [ -d /opt/yuce/bbbbb ]; then
  sudo rsync -a /opt/yuce/bbbbb/ /opt/yuce/
  sudo rm -rf /opt/yuce/bbbbb
fi

# 若仍有旧 systemd 服务
sudo systemctl stop sofascore-monitor 2>/dev/null || true
sudo systemctl disable sofascore-monitor 2>/dev/null || true

# 迁移 monitor 配置与 venv（若路径仍是 scripts/sofascore-monitor）
sudo mv scripts/sofascore-monitor/monitor.env scripts/tennis-monitor/ 2>/dev/null || true
sudo mv scripts/sofascore-monitor/venv scripts/tennis-monitor/ 2>/dev/null || true

sudo cp scripts/tennis-monitor/tennis-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tennis-monitor

# 重建 Docker（board 服务已改名为 btc-board）
docker compose -f docker-compose.core.yml up -d --build
```

## 7. 验收

```bash
curl -s http://127.0.0.1:9018/api/health
docker compose -f docker-compose.core.yml ps
```
