#!/usr/bin/env python3
import json
import os
import subprocess
import urllib.request

key = subprocess.check_output(
    ["sudo", "docker", "exec", "bbbbb-board-1", "printenv", "ALCHEMY_KEY"], text=True
).strip()
print("key", key[:16], "... len", len(key))

urls = [
    f"https://polygon-mainnet.g.alchemy.com/v2/{key}",
    f"https://polygon-mainnet.g.alchemy.com/v2/{key}",
]
body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []}).encode()
req = urllib.request.Request(
    urls[0],
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        print("alchemy status", resp.status, resp.read()[:300])
except Exception as e:
    print("alchemy FAIL", e)

# locate source files
for cmd in [
    ["sudo", "docker", "exec", "bbbbb-board-1", "ls", "/app"],
    ["sudo", "docker", "exec", "bbbbb-board-1", "grep", "-n", "ALCHEMY", "onchain_leaderboard.py"],
]:
    try:
        print(subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT)[:800])
    except subprocess.CalledProcessError as e:
        print(e.output[:500] if e.output else e)
