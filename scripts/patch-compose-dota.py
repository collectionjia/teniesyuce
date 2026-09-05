#!/usr/bin/env python3
"""Add dota2elo service to docker-compose.external.yml"""
from pathlib import Path

p = Path("/opt/yuce/bbbbb/docker-compose.external.yml")
text = p.read_text(encoding="utf-8")

dota_block = """
  dota:
    build:
      context: ./dota2elo
    restart: unless-stopped
    environment:
      PORT: "8777"
      PYTHONUTF8: "1"
      DOTA_INGEST_LIMIT: ${DOTA_INGEST_LIMIT:-10}
      STRATZ_API_KEY: ${STRATZ_API_KEY:-}
      DOTA2ELO_SOURCE: ${DOTA2ELO_SOURCE:-auto}
    volumes:
      - dota_data:/app/data
    expose:
      - "8777"

"""

if "context: ./dota2elo" not in text:
    anchor = "\n  web:\n"
    if anchor not in text:
        raise SystemExit("web anchor missing")
    text = text.replace(anchor, dota_block + anchor, 1)

if "dota_data:" not in text:
    text = text.rstrip() + "\n  dota_data:\n"

server_env = "      BOARD_PRODUCT_URL: ${BOARD_PRODUCT_URL:-http://board:8890/}\n"
dota_env = (
    "      BOARD_PRODUCT_URL: ${BOARD_PRODUCT_URL:-http://board:8890/}\n"
    "      DOTA_PRODUCT_URL: ${DOTA_PRODUCT_URL:-http://dota:8777/}\n"
)
if "DOTA_PRODUCT_URL" not in text:
    if server_env not in text:
        raise SystemExit("server env anchor missing")
    text = text.replace(server_env, dota_env, 1)

p.write_text(text, encoding="utf-8")
print("patched docker-compose.external.yml")
