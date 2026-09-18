FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ca-certificates libcurl4 \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/tennis-monitor/requirements.txt /tmp/tm-requirements.txt
RUN pip3 install --break-system-packages --no-cache-dir -r /tmp/tm-requirements.txt \
    && python3 -c "from curl_cffi import requests; print('tm-deps-ok')" \
    && rm /tmp/tm-requirements.txt

WORKDIR /app/collect
COPY services/collect/package.json ./
RUN npm install --omit=dev
COPY services/collect/src ./src
COPY services/_lib /app/_lib

EXPOSE 9101
CMD ["node", "src/index.js"]
