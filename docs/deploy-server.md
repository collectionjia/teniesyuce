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

## 3. 一键部署

**测试（215 :9018）：**

```bash
cd /opt/yuce
git pull
chmod +x scripts/*.sh
bash scripts/docker-deploy-test-all.sh
```

**生产（215 :9001）：**

```bash
cd /opt/yuce
git pull
chmod +x scripts/*.sh
bash scripts/docker-deploy-prod-all.sh
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
bash scripts/docker-deploy-prod-all.sh
```

## 4. 常用命令

```bash
bash scripts/docker-deploy-test-all.sh          # 测试 core + 五引擎
bash scripts/docker-deploy-prod-all.sh          # 生产 core + 五引擎
bash scripts/docker-deploy-prod-all.sh --no-cache
bash scripts/docker-deploy.sh prod ps
bash scripts/docker-deploy.sh prod logs -f server
bash scripts/deploy-host-services.sh status
```

## 5. Compose 文件 / 测试与生产

| 文件 | 说明 |
|------|------|
| `docker-compose.core.yml` | redis + btc-board + server + web |
| `deploy/docker-compose.services.yml` | 五引擎 collect/rules/betting/stop-loss/scheduler |
| `deploy/test.env` | 测试：`yuce-test`，web `9018`，**不启 redis**，用 `server/.env.test` |
| `deploy/prod.env` | 生产：`yuce-prod`，web `9001`，`COMPOSE_PROFILES=with-redis`，`SCHEDULER_URL` |

```bash
# 改端口：编辑对应 env 里的 WEB_PORT / BOARD_PORT / REDIS_HOST_PORT
bash scripts/docker-deploy.sh test up -d --build
bash scripts/docker-deploy.sh prod up -d --build

bash scripts/docker-deploy.sh test ps
curl -s http://127.0.0.1:9018/api/health   # 测试默认
curl -s http://127.0.0.1:9001/api/health   # 生产默认 9001
```

### 215 测试环境（本机 MySQL / Redis）

测试栈 **不启 compose 内 redis**；`server/.env.test` 里 DB/Redis 应指向 **215 宿主机本机**（Docker 容器用 `host.docker.internal`，勿写公网 IP）。

```bash
cd /opt/yuce
git pull

# 首次：从 server/.env 生成本机库配置
bash scripts/init-env-test.sh
nano server/.env.test   # 确认 DB_PASSWORD、JWT_SECRET

# 采集代理（可选）
cp scripts/tennis-monitor/env.monitor.test.example scripts/tennis-monitor/monitor.env.test

# 一键：core Docker(test) + 宿主机五引擎
chmod +x scripts/*.sh
bash scripts/docker-deploy-test-all.sh

# 验收
curl -s http://127.0.0.1:9018/api/health
bash scripts/deploy-host-services.sh status
```

| 组件 | 连接方式 |
|------|----------|
| server 容器 → MySQL | `host.docker.internal:3306` |
| server 容器 → Redis | `host.docker.internal:9015` |
| 五引擎(宿主机) → MySQL/Redis | `127.0.0.1:3306` / `127.0.0.1:9015` |
| server 容器 → 五引擎 | `host.docker.internal:9101–9105` |

若 MySQL 仅监听 `9016`，把 `server/.env.test` 的 `DB_PORT` 改为 `9016`。

### 215 生产环境

生产栈启用 **compose 内 Redis**（宿主机 `127.0.0.1:9016`）；MySQL 仍连 **215 宿主机本机**。

```bash
cd /opt/yuce
git pull

# 首次或迁移：补丁 server/.env 为 Docker 本机地址（不覆盖密码）
bash scripts/init-env-prod-docker.sh
nano server/.env

# 采集代理（可选）
cp scripts/tennis-monitor/env.monitor.prod.example scripts/tennis-monitor/monitor.env.prod

# 一键：core Docker(prod) + 宿主机五引擎
chmod +x scripts/*.sh
bash scripts/docker-deploy-prod-all.sh

curl -s http://127.0.0.1:9001/api/health
bash scripts/deploy-host-services.sh status
```

| 组件 | 连接方式 |
|------|----------|
| server 容器 → MySQL | `host.docker.internal:3306` |
| server 容器 → Redis | `redis://redis:6379`（compose 内） |
| 五引擎(宿主机) → MySQL/Redis | `127.0.0.1:3306` / `127.0.0.1:9016` |

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
