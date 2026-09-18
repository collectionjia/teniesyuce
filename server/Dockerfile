FROM node:20-bookworm-slim

# 管理员「立即采集」：容器内 python3 collect_live.py（IPWO + curl_cffi）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ca-certificates libcurl4 \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/tennis-monitor/requirements.txt /tmp/tm-requirements.txt
RUN pip3 install --break-system-packages --no-cache-dir -r /tmp/tm-requirements.txt \
    && python3 -c "from curl_cffi import requests; import redis, requests as rq; print('tm-deps-ok')" \
    && rm /tmp/tm-requirements.txt

WORKDIR /app

COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY server/src ./src
COPY server/scripts ./scripts
COPY server/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
ENV TENNIS_MONITOR_DIR=/tennis-monitor
EXPOSE 3001

ENTRYPOINT ["./docker-entrypoint.sh"]
