#!/usr/bin/env bash
# Cloudflare DNS setup for yuce.bid → AWS 95.40.77.158
# Usage:
#   1) cp .env.example .env  &&  edit .env  (填入 CF_API_TOKEN)
#   2) ./cf_dns_setup.sh

set -euo pipefail

# ---- 加载 .env ----
if [[ ! -f .env ]]; then
  echo "❌ .env 不存在，请先：cp .env.example .env 并填入 CF_API_TOKEN" >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a; source .env; set +a

: "${CF_API_TOKEN:?CF_API_TOKEN 未设置}"
: "${CF_ZONE_NAME:=yuce.bid}"
: "${CF_TARGET_IP:=95.40.77.158}"

API="https://api.cloudflare.com/client/v4"
H_AUTH="Authorization: Bearer ${CF_API_TOKEN}"
H_JSON="Content-Type: application/json"

# ---- 1. 验证 token ----
echo "🔑 验证 token ..."
VERIFY=$(curl -sS -X GET "$API/user/tokens/verify" -H "$H_AUTH")
if ! echo "$VERIFY" | jq -e '.success == true' >/dev/null; then
  echo "❌ token 无效：$VERIFY" >&2
  exit 1
fi
echo "✅ token 有效"

# ---- 2. 解析 zone_id（优先用 .env 的 CF_ZONE_ID）----
if [[ -z "${CF_ZONE_ID:-}" ]]; then
  echo "🌐 查找 zone_id for ${CF_ZONE_NAME} ..."
  ZONE_RESP=$(curl -sS -X GET "$API/zones?name=${CF_ZONE_NAME}" -H "$H_AUTH")
  CF_ZONE_ID=$(echo "$ZONE_RESP" | jq -r '.result[0].id // empty')
  if [[ -z "$CF_ZONE_ID" ]]; then
    echo "❌ 找不到 zone：${CF_ZONE_NAME}。检查：1) 域名已加到 Cloudflare  2) token 有该 zone 权限" >&2
    echo "响应：$ZONE_RESP" >&2
    exit 1
  fi
  echo "✅ zone_id = $CF_ZONE_ID"
fi

# ---- 3. 工具函数：upsert 一条 A 记录 ----
upsert_a() {
  local name="$1"     # "" 表示根域
  local ip="$2"
  local label="${name:-@}"
  echo "—— 处理 ${label} (${CF_ZONE_NAME}) → ${ip}"

  # 查已有
  local existing
  existing=$(curl -sS -X GET \
    "$API/zones/${CF_ZONE_ID}/dns_records?type=A&name=${CF_ZONE_NAME}" \
    -H "$H_AUTH" | jq -r ".result[] | select(.name==\"${CF_ZONE_NAME}\") | .id // empty")

  if [[ -n "$existing" ]]; then
    echo "   存在 id=$existing，更新 ..."
    curl -sS -X PUT \
      "$API/zones/${CF_ZONE_ID}/dns_records/${existing}" \
      -H "$H_AUTH" -H "$H_JSON" \
      --data "{\"type\":\"A\",\"name\":\"${CF_ZONE_NAME}\",\"content\":\"${ip}\",\"ttl\":1,\"proxied\":true}" \
      | jq -e '.success == true' >/dev/null \
      && echo "   ✅ 已更新" || { echo "   ❌ 更新失败"; exit 1; }
  else
    echo "   不存在，创建 ..."
    curl -sS -X POST \
      "$API/zones/${CF_ZONE_ID}/dns_records" \
      -H "$H_AUTH" -H "$H_JSON" \
      --data "{\"type\":\"A\",\"name\":\"${CF_ZONE_NAME}\",\"content\":\"${ip}\",\"ttl\":1,\"proxied\":true}" \
      | jq -e '.success == true' >/dev/null \
      && echo "   ✅ 已创建" || { echo "   ❌ 创建失败"; exit 1; }
  fi
}

# ---- 4. 加 /www 子域 ----
upsert_a ""      "$CF_TARGET_IP"        # 根域 yuce.bid
upsert_a "www"   "$CF_TARGET_IP"        # www.yuce.bid

# ---- 5. 总结 ----
echo
echo "🎉 完成。当前 A 记录："
curl -sS -X GET "$API/zones/${CF_ZONE_ID}/dns_records?type=A" -H "$H_AUTH" \
  | jq -r '.result[] | "  \(.name)\t\(.content)\tproxied=\(.proxied)"'
