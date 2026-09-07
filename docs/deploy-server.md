# 服务器部署说明

## 1. 项目目录

| 位置 | 路径 |
|------|------|
| 线上推荐 | `/opt/yuce/bbbbb` |
| GitHub | https://github.com/collectionjia/yuce （私有） |

## 2. 前置条件

- Ubuntu + Docker / Docker Compose
- 已配置 `server/.env`（从 `server/.env.example` 复制）
- 私有仓库需先在服务器配置 Git 访问：
  ```bash
  # HTTPS + Personal Access Token
  git clone https://<TOKEN>@github.com/collectionjia/yuce.git /opt/yuce/bbbbb

  # 或 SSH（把公钥加到 GitHub）
  git clone git@github.com:collectionjia/yuce.git /opt/yuce/bbbbb
  ```

## 3. 一键部署（Lightsail 网页终端）

```bash
cd /opt/yuce/bbbbb
chmod +x scripts/deploy-server.sh
bash scripts/deploy-server.sh
```

**首次全新机器：**

```bash
export INSTALL_DIR=/opt/yuce/bbbbb
export REPO_URL='https://<TOKEN>@github.com/collectionjia/yuce.git'
sudo mkdir -p /opt/yuce
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

## 5. Compose 文件

| 文件 | 说明 |
|------|------|
| `docker-compose.core.yml` | redis + board + server + web |
| `docker-compose.test.yml` | 本地测试 MySQL + Redis |

## 6. 验收

```bash
curl -s http://127.0.0.1:9001/api/health
docker compose -f docker-compose.core.yml ps
```
