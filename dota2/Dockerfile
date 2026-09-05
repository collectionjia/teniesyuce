FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PORT=8781 \
    POLY_TAG_SLUG=dota-2 \
    SPORT_LABEL=DOTA2 \
    CACHE_PATH=/app/data/cache.json \
    REFRESH_SEC=60

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY docker-entrypoint.sh .
RUN mkdir -p /app/data && chmod +x /app/docker-entrypoint.sh

EXPOSE 8781

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://127.0.0.1:8781/api/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
