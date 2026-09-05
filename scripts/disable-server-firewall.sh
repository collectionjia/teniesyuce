#!/bin/bash
# 在 Lightsail「网页终端 / Connect using SSH」里粘贴执行
set -e

echo "== before =="
sudo ufw status verbose 2>/dev/null || echo "ufw not installed"
sudo iptables -L INPUT -n --line-numbers 2>/dev/null | head -15 || true

echo "== disable ufw =="
if command -v ufw >/dev/null 2>&1; then
  sudo ufw disable || true
  echo "ufw disabled"
fi

echo "== flush iptables (INPUT policy ACCEPT) =="
if command -v iptables >/dev/null 2>&1; then
  sudo iptables -P INPUT ACCEPT
  sudo iptables -P FORWARD ACCEPT
  sudo iptables -P OUTPUT ACCEPT
  sudo iptables -F
  sudo iptables -X
  echo "iptables flushed"
fi

echo "== ensure sshd running =="
sudo systemctl enable ssh 2>/dev/null || sudo systemctl enable sshd 2>/dev/null || true
sudo systemctl restart ssh 2>/dev/null || sudo systemctl restart sshd 2>/dev/null || true
sudo systemctl is-active ssh 2>/dev/null || sudo systemctl is-active sshd 2>/dev/null || true

echo "== listen 22 =="
ss -lntp | grep ':22' || netstat -lntp 2>/dev/null | grep ':22' || true

echo "== public ip =="
curl -4 -s --max-time 5 ifconfig.me || curl -4 -s --max-time 5 icanhazip.com || true
echo
echo DONE
