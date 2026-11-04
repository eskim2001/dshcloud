#!/bin/sh
set -eu

# dsh 的会话目录名编码 cwd，cwd 一变用户就「找不到历史会话」。
# 卷可能是全新的，而 cd 不会建目录，所以先建再进。
mkdir -p "$HOME/workspace"
cd "$HOME/workspace"

# dsh 的 /api 信任围栏只放行回环和 --trusted-host 声明的 authority。
# 经平台域名进来必须声明，否则页面能开、API 全 403。
TRUSTED=""
for h in $(echo "${DSH_TRUSTED_HOSTS:-}" | tr ',' ' '); do
  TRUSTED="$TRUSTED --trusted-host $h"
done

LOG=/tmp/dsh.log
: > "$LOG"

# cordis-plugin-hmr 仍硬校验 process.execArgv 含 --expose-internals（0.1.6-alpha.1 实测）
export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--expose-internals"

dsh web --patch /etc/platform/owns-host.yml \
  --host 127.0.0.1 --port "$DSH_PORT" --no-open $TRUSTED > "$LOG" 2>&1 &
DSH_PID=$!

tail -n +1 -f "$LOG" &

# dsh 只打印一次入口 token，锚定前缀避免抓到别的输出。
DSH_LAUNCH_TOKEN=""
i=0
while [ -z "$DSH_LAUNCH_TOKEN" ] && [ "$i" -lt 240 ]; do
  DSH_LAUNCH_TOKEN=$(sed -n 's/^dsh web: .*[?&]token=\([A-Za-z0-9_-]*\).*/\1/p' "$LOG" | head -1)
  [ -n "$DSH_LAUNCH_TOKEN" ] || sleep 0.5
  i=$((i + 1))
done
[ -n "$DSH_LAUNCH_TOKEN" ] || echo "entrypoint: 没抓到 token，首页会 401" >&2
export DSH_LAUNCH_TOKEN

# 桥：dsh 拒绝绑非回环，必须有东西在 0.0.0.0 上听并转发。
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
CADDY_PID=$!

# 两边都要盯着：只等 dsh 的话 caddy 崩了容器照样 running（用户 502、平台看着正常）。
while kill -0 "$DSH_PID" 2>/dev/null && kill -0 "$CADDY_PID" 2>/dev/null; do
  sleep 1
done
echo "entrypoint: dsh 或 caddy 已退出，容器跟着停" >&2
kill "$DSH_PID" "$CADDY_PID" 2>/dev/null || true
