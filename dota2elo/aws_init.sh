#!/usr/bin/env bash
# AWS Ubuntu/Debian 一键初始化：Nginx + Certbot + Cloudflare 真实 IP + HTTPS
# 用法：sudo bash aws_init.sh yuce.bid your-email@example.com

set -euo pipefail

DOMAIN="${1:-yuce.bid}"
EMAIL="${2:-admin@${DOMAIN}}"

echo "=== 目标域名: $DOMAIN ==="
echo "=== Let's Encrypt 邮箱: $EMAIL ==="

# ---- 1. 系统更新 + 安装 ----
echo ">>> [1/6] apt update + 安装 nginx / certbot / curl"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx curl ufw jq

# ---- 2. 防火墙放行 ----
echo ">>> [2/6] ufw 放行 22/80/443"
ufw allow OpenSSH || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
# 注意：Cloudflare IP 段必须放行（80/443 已放，源站校验也走 80/443）
yes | ufw enable || true
ufw status | head -10

# ---- 3. 写入 Cloudflare 真实 IP 段（关键，否则日志全是 CF IP）----
echo ">>> [3/6] 写入 Cloudflare real_ip 配置"
mkdir -p /etc/nginx/conf.d
cat > /etc/nginx/conf.d/cloudflare-real-ip.conf <<'EOF'
# Cloudflare IP ranges — 自动更新自 https://www.cloudflare.com/ips/
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
set_real_ip_from 103.22.200.0/22;
set_real_ip_from 103.31.4.0/22;
set_real_ip_from 141.101.64.0/18;
set_real_ip_from 108.162.192.0/18;
set_real_ip_from 190.93.240.0/20;
set_real_ip_from 188.114.96.0/20;
set_real_ip_from 197.234.240.0/22;
set_real_ip_from 198.41.128.0/17;
set_real_ip_from 162.158.0.0/15;
set_real_ip_from 104.16.0.0/13;
set_real_ip_from 104.24.0.0/14;
set_real_ip_from 172.64.0.0/13;
set_real_ip_from 131.0.72.0/22;
set_real_ip_from 2400:cb00::/32;
set_real_ip_from 2606:4700::/32;
set_real_ip_from 2803:f800::/32;
set_real_ip_from 2405:b500::/32;
set_real_ip_from 2405:8100::/32;
set_real_ip_from 2a06:98c0::/29;
set_real_ip_from 2c0f:f248::/32;
real_ip_header CF-Connecting-IP;
EOF

# ---- 4. 写站点配置 ----
echo ">>> [4/6] 写 nginx 站点配置"
cat > /etc/nginx/sites-available/${DOMAIN} <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN};

    # 临时用于 certbot 验证（80 端口必须能访问）
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # 其他先返回 200，等证书签发再切 443
    location / {
        return 200 'OK - ${DOMAIN} nginx is up. waiting for SSL...';
        add_header Content-Type text/plain;
    }
}
EOF

ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/${DOMAIN}
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
systemctl enable nginx

# ---- 5. 申请证书 ----
echo ">>> [5/6] 申请 Let's Encrypt 证书（certbot）"
certbot certonly --nginx \
  --non-interactive --agree-tos --register-unsafely-without-email \
  -d "${DOMAIN}" -d "www.${DOMAIN}" || \
certbot certonly --nginx \
  --non-interactive --agree-tos -m "${EMAIL}" \
  -d "${DOMAIN}" -d "www.${DOMAIN}"

CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
if [[ ! -f "${CERT_DIR}/fullchain.pem" ]]; then
  echo "❌ 证书没拿到，DNS 可能还没传播。等几分钟再单独跑 certbot"
  exit 1
fi

# ---- 6. 切到 HTTPS ----
echo ">>> [6/6] 切到 HTTPS 完整配置"
cat > /etc/nginx/sites-available/${DOMAIN} <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN} www.${DOMAIN};

    ssl_certificate     ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;

    root /var/www/html;
    index index.html;

    location / {
        try_files \$uri \$uri/ =404;
    }
}
EOF

nginx -t
systemctl reload nginx

# ---- 自动续期 ----
( crontab -l 2>/dev/null | grep -v certbot ; \
  echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'" \
) | crontab -

echo
echo "🎉 完成！"
echo "  - 证书路径: ${CERT_DIR}"
echo "  - 自动续期: 每天 3 点跑"
echo
echo "下一步："
echo "  1. 确认 Cloudflare 后台 SSL/TLS = Full (Strict)"
echo "  2. 本地测试：curl -I https://${DOMAIN}"
echo "  3. 真实 IP 透传：curl https://${DOMAIN}/cdn-cgi/trace"
