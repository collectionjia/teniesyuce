#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 -m venv venv
source venv/bin/activate
# 国内/WSL 慢时可设 PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
INDEX="${PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
pip install -U pip -i "$INDEX" --default-timeout=120
pip install -r requirements.txt -i "$INDEX" --default-timeout=120
python -c "from curl_cffi import requests; print('curl_cffi ok')"
