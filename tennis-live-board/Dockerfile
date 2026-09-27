# 国内镜像拉基础镜像（DaoCloud）；拉不动可改回 python:3.12-slim 并配 daemon 镜像加速
FROM docker.m.daocloud.io/library/python:3.12-slim

WORKDIR /app

# Debian apt 换阿里云
RUN set -eux; \
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' \
      /etc/apt/sources.list.d/debian.sources; \
  fi; \
  if [ -f /etc/apt/sources.list ]; then \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' \
      /etc/apt/sources.list; \
  fi; \
  apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# PyPI 清华源
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
  --trusted-host pypi.tuna.tsinghua.edu.cn \
  -r requirements.txt

COPY tm/ tm/
COPY config/ config/
COPY server.py index.html push_redis_prod.py ./

ENV PYTHONUNBUFFERED=1 \
    SOFA_BOARD_HOST=0.0.0.0 \
    SOFA_BOARD_PORT=8765

EXPOSE 8765

CMD ["python", "server.py"]
