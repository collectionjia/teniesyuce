FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PORT=3001

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY run.py .
COPY dota2elo/ ./dota2elo/
COPY web/ ./web/
COPY scripts/ ./scripts/
COPY openapi.json API.md ARCHITECTURE.md PROJECT.md README.md CHANGELOG.md INSTALL.md ./

# 预置校准表与 Elo DB（entrypoint 在空 volume 时灌入）
COPY data/ /app/data-seed/
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh && mkdir -p /app/data

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://127.0.0.1:3001/api/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["python", "run.py", "serve", "--host", "0.0.0.0", "--port", "3001"]
