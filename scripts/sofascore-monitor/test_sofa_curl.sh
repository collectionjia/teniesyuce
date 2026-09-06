#!/bin/bash
set -euo pipefail
cd /opt/yuce/bbbbb/scripts/sofascore-monitor
set -a
source ./monitor.env
set +a
U="${IPWO_PROXY_USER}_custom_zone_${IPWO_PROXY_ZONE:-US}"
PX="http://${U}:${IPWO_PROXY_PASS}@${IPWO_PROXY_HOST}:${IPWO_PROXY_PORT}"
CJ=/tmp/sofa_cj.txt
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

echo "=== proxy warm cookies ==="
curl -sS -m 25 -c "$CJ" -b "$CJ" -x "$PX" \
  -H "User-Agent: $UA" \
  -H 'Accept: text/html' \
  -o /dev/null -w "tennis HTML:%{http_code}\n" \
  'https://www.sofascore.com/tennis'

curl -sS -m 25 -c "$CJ" -b "$CJ" -x "$PX" \
  -H "User-Agent: $UA" \
  -H 'Accept: application/json' \
  -H 'Referer: https://www.sofascore.com/tennis' \
  -H 'Origin: https://www.sofascore.com' \
  -o /tmp/sofa_cookie.json -w "rankings:%{http_code}\n" \
  'https://www.sofascore.com/api/v1/rankings/type/6'
head -c 200 /tmp/sofa_cookie.json; echo
echo "cookies:"; cat "$CJ" | head -5

echo "=== curl_cffi if installed ==="
./venv/bin/python - <<'PY' || true
try:
    from curl_cffi import requests as cr
    import os
    from monitor_env import load_monitor_env
    load_monitor_env()
    u=os.environ['IPWO_PROXY_USER']+'_custom_zone_'+os.environ.get('IPWO_PROXY_ZONE','US')
    px=f"http://{u}:{os.environ['IPWO_PROXY_PASS']}@{os.environ['IPWO_PROXY_HOST']}:{os.environ['IPWO_PROXY_PORT']}"
    s=cr.Session(impersonate='chrome131')
    s.proxies={'http':px,'https':px}
    s.get('https://www.sofascore.com/tennis', timeout=25)
    r=s.get('https://www.sofascore.com/api/v1/rankings/type/6', timeout=25, headers={'Referer':'https://www.sofascore.com/tennis'})
    print('curl_cffi', r.status_code, r.text[:120])
except Exception as e:
    print('curl_cffi fail', e)
PY
