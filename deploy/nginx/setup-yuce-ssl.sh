#!/bin/bash
set -euo pipefail

DOMAIN=yuce.bid
WWW=www.yuce.bid
EMAIL="${CERTBOT_EMAIL:-admin@yuce.bid}"
REPO=/opt/yuce/bbbbb
NGINX_AVAILABLE=/etc/nginx/sites-available/yuce.bid
NGINX_ENABLED=/etc/nginx/sites-enabled/yuce.bid

echo "[1/6] install packages"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq nginx certbot python3-certbot-nginx

echo "[2/6] prepare webroot"
sudo mkdir -p /var/www/certbot
sudo chown -R www-data:www-data /var/www/certbot

echo "[3/6] disable default site, enable yuce HTTP"
sudo rm -f /etc/nginx/sites-enabled/default
sudo cp "$REPO/deploy/nginx/yuce.bid.http.conf" "$NGINX_AVAILABLE"
sudo ln -sf "$NGINX_AVAILABLE" "$NGINX_ENABLED"
sudo nginx -t
sudo systemctl reload nginx

echo "[4/6] obtain certificate"
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  sudo certbot certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" -d "$WWW" \
    --non-interactive --agree-tos -m "$EMAIL" \
    --no-eff-email
else
  echo "certificate already exists, skip certonly"
fi

echo "[5/6] install HTTPS nginx config"
sudo cp "$REPO/deploy/nginx/yuce.bid.conf" "$NGINX_AVAILABLE"
sudo nginx -t
sudo systemctl reload nginx

echo "[6/6] certbot renew timer"
sudo systemctl enable certbot.timer 2>/dev/null || true
sudo systemctl start certbot.timer 2>/dev/null || true

echo "Done. Test: curl -sI https://$WWW/ | head"
