import os
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(
    "46.250.163.215", 53022, username="root",
    password=os.environ["YB_SSH_PW"], timeout=20,
    allow_agent=False, look_for_keys=False,
)
cmd = r"""
cd /opt/yucebid/teniesyuce
rm -f /tmp/yuce-tm-venv.log
setsid bash /opt/yucebid/teniesyuce/scripts/_tmp_tm_venv.sh > /tmp/yuce-tm-venv.log 2>&1 < /dev/null &
echo STARTED
"""
# write remote script via sftp
script = r"""#!/usr/bin/env bash
set -euo pipefail
cd /opt/yucebid/teniesyuce/scripts/tennis-monitor
echo "==> python3 $(python3 --version)"
if [ ! -x venv/bin/python ]; then
  echo "==> create venv"
  python3 -m venv venv
fi
echo "==> pip install -r requirements.txt"
./venv/bin/python -m pip install -U pip
./venv/bin/python -m pip install -r requirements.txt
./venv/bin/python -c "from curl_cffi import requests; print('curl_cffi ok')"
cd /opt/yucebid/teniesyuce
export COLLECT_HOST_PORT=9111
export SCHEDULER_HOST_PORT=9115
export DOTA2ELO_HOST_PORT=8893
export NFLELO_HOST_PORT=8894
export SERVER_ENV_FILE=/opt/yucebid/teniesyuce/server/.env.test
bash scripts/deploy-host-services.sh restart
sleep 3
echo "==> health"
curl -sf --max-time 5 http://127.0.0.1:9111/health; echo
echo "==> start top100"
curl -sf --max-time 20 -X POST http://127.0.0.1:9111/internal/collect/full \
  -H 'Content-Type: application/json' \
  -d '{"sport":"tennis","top100":true}'; echo
sleep 12
echo "==> collect log"
tail -n 50 logs/services/collect.log | sed 's/\x1b\[[0-9;]*m//g'
"""
sftp = c.open_sftp()
with sftp.file("/opt/yucebid/teniesyuce/scripts/_tmp_tm_venv.sh", "w") as f:
    f.write(script)
sftp.chmod("/opt/yucebid/teniesyuce/scripts/_tmp_tm_venv.sh", 0o755)
sftp.close()
_, o, e = c.exec_command(cmd, timeout=15)
print(o.read().decode())
print(e.read().decode())
c.close()
