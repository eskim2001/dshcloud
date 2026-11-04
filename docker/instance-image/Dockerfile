# syntax=docker/dockerfile:1.7
#
# 默认构建路径（VERSION …_5 及之后同代热修）：
#   FROM 已知好的 0.1.6-alpha.1_1，只叠新 entrypoint + 卸 caddy filecap。
#   不要在此路径重新 npm install @deepseek-ai/dsh —— 全量 rebuild 会漂到
#   dsh-app-boot@alpha.2，缺 watchUserPatches，profile-boot SyntaxError（honcho `_3` 实测）。
#
#   _5 ≡ _1 + entrypoint（node --expose-internals …）+ setcap -r caddy
#
# 升 dsh 主版本、必须全量重装时用：FULL=1 ./build.sh → Dockerfile.full（含 pin boot）。

ARG BASE_IMAGE=ghcr.io/eskim2001/dsh-instance:0.1.6-alpha.1_1
FROM ${BASE_IMAGE}

ARG DSH_VERSION
ARG REVISION

USER root

COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh

# 上游 caddy 二进制带 cap_net_bind_service=ep；平台 CapDrop:ALL + no-new-privileges
# 下 exec 报 Operation not permitted。bridge 听 8080，不需要该能力。
RUN apt-get update \
 && apt-get install -y --no-install-recommends libcap2-bin \
 && /sbin/setcap -r /usr/local/bin/caddy \
 && test -z "$(getcap /usr/local/bin/caddy 2>/dev/null || true)" \
 && apt-get purge -y libcap2-bin \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# ARG + LABEL 故意放在耗时层之后，避免污染叠层缓存。
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.title="dsh-instance" \
      org.opencontainers.image.version="${DSH_VERSION}_${REVISION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.opencontainers.image.source="https://github.com/eskim2001/dsh-cloud"

USER 1000:1000
