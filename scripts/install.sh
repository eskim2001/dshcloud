#!/usr/bin/env bash
#
# dsh-cloud 一键安装 / 升级 / 卸载。**在宿主机上以 root 跑**，不是在容器里。
#
#   curl -fsSL https://raw.githubusercontent.com/eskim2001/dshcloud/main/scripts/install.sh \
#     | bash
#
# 子命令：install（默认）/ update / uninstall
#
# 安装顺序：
#   ① 预检（环境 / 端口 / **存储能力**）
#   ② 在**宿主上**预置存储池并写持久化 —— 容器里建池宿主看不见（见 D35）
#   ③ 从镜像里取部署资产到 /opt/dsh-cloud，渲染 Traefik 配置
#   ④ 安装宿主 INPUT / FORWARD 网络边界及开机加载单元
#   ⑤ 起 Postgres → 迁移 → 起控制面与入口 → **打印一行引导地址**
#
# **账号和域名不归它管**：都在那行地址打开的引导页里配。安装这一步因此一个问题都不问。
#
# **幂等**：/opt/dsh-cloud/.env 存在时 install 等价于 update，且**绝不重新生成 secret**
#     —— 换了 PLATFORM_SECRET，所有实例的门 token 立刻全废（桥 403）。
#
# 设计取舍见 docs/DECISIONS.md 的 D32–D35；前置条件见 PLAN.md 的 M1.5。
set -euo pipefail

STATE_DIR=/opt/dsh-cloud
IMAGE_REPO=ghcr.io/eskim2001/dshcloud
DEFAULT_POOL_ROOT=/var/lib/dsh
POSTGRES_PORT_DEFAULT=55432

# ── 参数默认值 ──────────────────────────────────────────────────────────
CMD=install
VERSION=${DSH_CLOUD_VERSION:-}
POOL_SIZE_MB=${DSH_POOL_SIZE_MB:-}
POOL_ROOT=$DEFAULT_POOL_ROOT
WIZARD_PORT=${DSH_WIZARD_PORT:-}
# 空 = 还没定（首装时由 pick_control_port 挑；重跑时从 .env 读回来）
CONTROL_PORT=
# 同上：空 = 还没定，首装取默认值、重跑沿用 .env
POSTGRES_PORT=
PURGE=0
FORCE_SECRETS=0

# 由 fetch_assets 填：拉到的镜像 digest（写进 .installed-version，标签漂移时靠它认版本）
IMAGE_DIGEST=

STEP='初始化'
trap 'on_fail' ERR

log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m警告：\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m错误：\033[0m %s\n' "$*" >&2; exit 1; }

on_fail() {
  printf '\n\033[31m✗ 安装失败于：%s\033[0m\n' "$STEP" >&2
  printf '  状态目录 %s 已写入的内容**保留**（幂等，排障后重跑本脚本即可）。\n' "$STATE_DIR" >&2
  printf '  看日志：docker compose -f %s/prod.yml logs --tail=50\n' "$STATE_DIR" >&2
}

usage() {
  # $0 在 `curl | bash` 下是 "bash"，不是文件 —— 那时只打印下面这段，不读文件头
  if [ -f "$0" ]; then sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; fi
  cat <<'EOF'

用法：install.sh [子命令] [选项]

子命令
  install            安装（默认）；已装过则等价于 update
  update             拉新镜像、重渲染配置、重启服务（保留数据与 secret）
  uninstall          停服务并删容器（**保留** Postgres 卷与存储池）

选项
  --version <tag>    平台镜像 tag，如 0.1.7。省略 = 用 latest（**会漂移**；装到的 digest 会记下来）
  --wizard-port <端口> 引导页（也就是控制面自己）的端口。省略 = 从 3000 起试 3000-3003，
                     取第一台空闲的
  --pool-root <路径> 存储池根，默认 /var/lib/dsh
  --pool-size-mb <MB> 需要自动建 loopback 池时用；省略取该文件系统的 80%
  --harden-host      兼容旧命令；安装和升级现在始终配置宿主网络边界。
                     限制实例访问宿主/内网/容器网桥，允许公网 IPv4 TCP/UDP，拒绝主动 IPv6 出站。
                     仅匹配平台专用 dshw 网桥及带归属标签的旧实例网桥。
                     需要 systemd；开机加载配置失败则停止安装。完整加固部署仍需额外验收。
  --purge            （uninstall）连 Postgres 卷、存储池、状态目录一起删 —— **不可恢复**
  -h, --help         显示这段

域名和首个管理员**不在这里配**：装完打印一行引导地址，在那页里填（见 README）。
EOF
}

# ── 参数解析 ────────────────────────────────────────────────────────────
if [ $# -gt 0 ]; then
  case "$1" in
    install | update | uninstall) CMD=$1; shift ;;
  esac
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=${2:?--version 后面要给 tag}; shift 2 ;;
    --pool-root) POOL_ROOT=${2:?--pool-root 后面要给路径}; shift 2 ;;
    --pool-size-mb) POOL_SIZE_MB=${2:?--pool-size-mb 后面要给数字}; shift 2 ;;
    --wizard-port) WIZARD_PORT=${2:?--wizard-port 后面要给端口号}; shift 2 ;;
    --harden-host) shift ;;
    --purge) PURGE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "认不出的参数：$1（-h 看用法）" ;;
  esac
done

# ── 小工具 ──────────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

rand_hex() { # 32 字节十六进制。十六进制是**有意的**：它会进 DATABASE_URL，不用再转义
  if have openssl; then
    openssl rand -hex 32
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  fi
}

env_get() { # 从 .env 里读一个键（不 source：值可能带奇怪字符）
  [ -f "$STATE_DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$STATE_DIR/.env" | head -1
}

compose() { docker compose -f "$STATE_DIR/prod.yml" --project-directory "$STATE_DIR" "$@"; }

# 这个端口上有没有人在听。先用 `ss`（能看见绑在别的网卡上的，最准），没有就退回往回环连一下 ——
# 连得上就说明有人在听。
port_in_use() {
  local p=$1
  if have ss; then
    if ss -lnt 2>/dev/null | grep -qE "[:.]${p}[[:space:]]"; then return 0; fi
    return 1
  fi
  if (exec 3<>/dev/tcp/127.0.0.1/"$p") 2>/dev/null; then return 0; fi
  return 1
}

# 控制面自己的端口 —— 引导页就开在它上面，装完打印的那行地址带的就是它。
#
# 首装从 3000 起试 3000-3003，取第一台空闲的：操作者不用挑，装完只面对**一行**地址。
# 重跑沿用 .env 里的：端口是「这台机器上装在哪」的一部分，悄悄换掉的话，之前按老地址配的
# 防火墙规则会突然失效，而正开着那个页面的人也只会看到连接被拒。
# `--wizard-port` 显式给的压过上面两条，且**满了就直接报错、不另挑一个** —— 显式给的值被悄悄
# 换掉是最难查的那类问题。
pick_control_port() {
  if [ -n "$WIZARD_PORT" ]; then
    if port_in_use "$WIZARD_PORT"; then
      die "--wizard-port $WIZARD_PORT 已经被占用了。换一个，或先把它腾出来。"
    fi
    CONTROL_PORT=$WIZARD_PORT
    return 0
  fi
  [ -n "$CONTROL_PORT" ] && return 0 # 重跑：.env 里已经有了
  local p
  for p in 3000 3001 3002 3003; do
    if ! port_in_use "$p"; then
      CONTROL_PORT=$p
      return 0
    fi
  done
  die "端口 3000-3003 都被占用了。用 --wizard-port <端口> 指定一个空闲的。"
}

# ── ① 预检 ──────────────────────────────────────────────────────────────

# 这台机器上的 Docker 会不会被 firewalld 冲掉跨网络隔离（CVE-2025-54410）。
#
# 为什么平台要在意：**每实例一个网络**那层隔离不是 Docker 的默认行为，而是它写下的 iptables
# 规则。firewalld 一 reload（`firewall-cmd --reload`、装包、改 zone）就把那些规则抹掉，而
# 影响范围里的 Docker **不会重建它们** —— 于是实例之间又能互相访问，且**没有任何报错**。
# 影响范围（GHSA-4vq8-7jfc-9cvp）：`<= 25.0.12`，以及 `26.0.0-rc1 ~ 28.0.0`；25.0.13 与
# 28.0.0 起已修。只在「firewalld 在跑」**且**「版本落在范围里」时返回 0。
docker_affected_by_firewalld_cve() {
  local ver major minor patch
  ver=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || return 0
  major=${ver%%.*}
  ver=${ver#*.}
  minor=${ver%%.*}
  patch=${ver#*.}
  # 版本尾巴上可能挂着 `-rc.1` / `+dfsg` 之类，只取前缀里的数字。**解析不出来就当成受影响**：
  # 这条警告的假阳性只是多一句提醒，假阴性是一个静默失效的隔离。
  major=${major%%[!0-9]*}
  minor=${minor%%[!0-9]*}
  patch=${patch%%[!0-9]*}
  case "$major$minor$patch" in
    '' | *[!0-9]*) return 0 ;;
  esac
  [ "$major" -ge 28 ] && return 1
  if [ "$major" -eq 25 ] && [ "$minor" -eq 0 ] && [ "$patch" -ge 13 ]; then
    return 1
  fi
  return 0
}

warn_if_firewalld_breaks_isolation() {
  have firewall-cmd || return 0
  systemctl is-active --quiet firewalld 2>/dev/null || return 0
  docker_affected_by_firewalld_cve || return 0
  warn "这台机器跑着 firewalld，Docker 又落在 CVE-2025-54410 的影响范围里：firewalld 一 reload 就会冲掉 Docker 的跨网络隔离规则，而它不会重建 —— 实例之间那层隔离会**静默**失效。升级到 25.0.13 / 28.0.0 以上再上线。"
}

preflight() {
  STEP='预检'

  [ "$(id -u)" = 0 ] || die "要 root（要建挂载点、写 fstab、装存储池）。用 sudo 跑。"

  [ "$(uname -s)" = Linux ] || die "只支持 Linux。macOS / Docker Desktop 请用仓库里的本地开发栈（见 docker/compose/README.md）。"

  require_host_firewall

  if [ -f /.dockerenv ] || grep -qa 'docker\|containerd' /proc/1/cgroup 2>/dev/null; then
    die "看起来在**容器里**跑。本脚本要在宿主机上执行：它要建挂载、写 fstab、并让 Docker 用宿主路径挂卷。"
  fi

  have docker || die "没装 Docker。"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 不可用（需要 \`docker compose\` 子命令，不是老的 docker-compose）。"
  docker info >/dev/null 2>&1 || die "连不上 Docker daemon（docker info 失败）。"

  warn_if_firewalld_breaks_isolation

  # 80/443：**只有首装才要求它们空闲**。更新时占着这两个端口的正是我们自己的入口，
  # 要求空闲会让 `update` 永远跑不起来（实测 2026-09-14：在跑着的部署上重跑，直接卡在这）。
  # 真被别人占了的话，`compose up` 会当场报出来 —— 报在真正出事的那一步。
  if [ ! -f "$STATE_DIR/.env" ]; then
    # 用 if 而不是 `cmd && die`：端口**空闲**时那条链的左半边是失败的，读起来像「空闲就报错」。
    local p
    for p in 80 443; do
      if have ss; then
        if ss -ltnH "sport = :$p" 2>/dev/null | grep -q .; then
          die "端口 $p 已被占用。先腾出来（入口要绑它）。"
        fi
      elif have lsof; then
        if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
          die "端口 $p 已被占用。"
        fi
      fi
    done
  fi

  resolve_version
}

resolve_version() {
  if [ -z "$VERSION" ] && [ -f "$(dirname "$0")/../docker/platform/VERSION" ]; then
    # 直接从仓库里跑（开发 / 排障）时顺手读一下，省得每次带 --version
    VERSION=$(tr -d '[:space:]' <"$(dirname "$0")/../docker/platform/VERSION")
  fi
  if [ -z "$VERSION" ]; then
    VERSION=latest
    warn "没给 --version：用 latest —— 它**会漂移**，同一个命令今天和下周装出来的不是同一版。要可复现就钉一个 tag（--version 0.1.0）。实际装到的 digest 会记进 $STATE_DIR/.installed-version。"
  fi
  printf '%s' "$VERSION" | grep -qE '^([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?|latest)$' ||
    die "版本形状不对（期望普通 semver 如 0.1.0，或 latest）：$VERSION"
}

# 装的是哪个镜像的**哪一份**。版本标签可能漂移（latest），digest 不会 ——
# 「我到底装的哪版」靠它回答，别只记标签。
image_digest() {
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$1" 2>/dev/null | head -1
}

# ── ② 存储池：在**宿主**上预置并持久化（见 D35）──────────────────────────
# 判定与平台启动时的探针**同源**：路径所在文件系统是 XFS 且挂了 pquota → 直接用。
# 否则建一块 loopback XFS 镜像。容器里建池宿主看不见，所以这件事必须在宿主上做完。
pool_is_ready() {
  have findmnt || return 1
  local fstype opts
  fstype=$(findmnt -n -o FSTYPE --target "$POOL_ROOT" 2>/dev/null) || return 1
  [ "$fstype" = xfs ] || return 1
  opts=$(findmnt -n -o OPTIONS --target "$POOL_ROOT" 2>/dev/null)
  case "$opts" in
    *pquota* | *prjquota*) return 0 ;;
    *) return 1 ;;
  esac
}

provision_pool() {
  STEP="预置存储池（$POOL_ROOT）"

  mkdir -p "$POOL_ROOT"

  if pool_is_ready; then
    log "存储池已就绪：$POOL_ROOT 是挂了 pquota 的 XFS"
    return
  fi

  if findmnt -n -o FSTYPE --target "$POOL_ROOT" >/dev/null 2>&1 &&
    [ "$(findmnt -n -o FSTYPE --target "$POOL_ROOT")" = xfs ]; then
    # 已经是 XFS，只是没挂 pquota —— 当场 remount 是**不安全**的（改挂载选项要 umount，
    # 而 umount 会失败：池子可能正被实例用着）。交给操作者。
    die "$POOL_ROOT 已经是 XFS，但没以 pquota 挂载。加 pquota 要 umount 重挂，脚本不替你做 —— 请改 /etc/fstab 里的挂载选项后重跑。"
  fi

  local img="$POOL_ROOT.img"
  local size_mb="$POOL_SIZE_MB"

  if [ -e "$img" ]; then
    log "池子镜像已存在：$img（不重建 —— 重建会抹掉现有数据）"
  else
    local avail_mb
    avail_mb=$(df -Pm "$(dirname "$POOL_ROOT")" | awk 'NR==2 {print $4}')
    [ -n "$avail_mb" ] || die "读不出 $(dirname "$POOL_ROOT") 的可用空间（df 输出没认出）。用 --pool-size-mb 显式给一个。"
    if [ -z "$size_mb" ]; then
      size_mb=$((avail_mb * 80 / 100))
      log "没给 --pool-size-mb，取所在文件系统可用空间的 80%：${size_mb} MiB"
    fi
    if [ "$size_mb" -gt "$avail_mb" ]; then
      die "池子要 ${size_mb} MiB，但 $(dirname "$POOL_ROOT") 只有 ${avail_mb} MiB 可用。"
    fi
    log "建 ${size_mb} MiB 稀疏镜像 $img 并 mkfs.xfs"
    truncate -s "${size_mb}M" "$img"
    have mkfs.xfs || die "缺 mkfs.xfs。装一下：apt-get install -y xfsprogs（或 yum/dnf install xfsprogs）"
    mkfs.xfs -q -f "$img"
  fi

  # 先挂上、确认配额真强制得了，**再**写 fstab。反过来（先写 fstab 再挂）的话，mount 失败会在
  # 机器上留一条指向不存在镜像的挂载行；而那时 prod.yml 还没生成，uninstall 认不出这台装过 ——
  # 那行就再没人清得掉。挂的时候给显式选项，和 fstab 那行要写的是同一组（loop,pquota），
  # 所以不依赖 fstab 已存在。
  STEP="挂载 $POOL_ROOT"
  if mountpoint -q "$POOL_ROOT" 2>/dev/null; then
    die "$POOL_ROOT 已经挂着别的东西，且不是「XFS + pquota」。先 umount 并清掉旧挂载再重跑。"
  fi
  mount -o loop,pquota "$img" "$POOL_ROOT" ||
    die "挂 $POOL_ROOT 失败。手工跑 mount -o loop,pquota $img $POOL_ROOT 看报什么，或看 dmesg。"

  if ! pool_is_ready; then
    umount "$POOL_ROOT" 2>/dev/null || true
    die "$POOL_ROOT 挂上了但不是「XFS + pquota」。配额强制不了，平台会拒绝启动。"
  fi

  # 用 fstab 的 `loop` 选项挂：不钉 /dev/loopN（重启后编号会变）。
  # nofail 是有意的 —— 池子挂了不该让宿主机进 emergency；平台启动时会自己拒绝启动，
  # 那是**看得见**的失败，比开不了机强。
  if ! grep -qE "^[^#]*[[:space:]]${POOL_ROOT}[[:space:]]" /etc/fstab; then
    log "写 /etc/fstab（重启后自动挂回）"
    printf '# dsh-cloud 实例数据池（D18/D35）\n%s %s xfs loop,pquota,nofail,defaults 0 0\n' \
      "$img" "$POOL_ROOT" >>/etc/fstab
  fi
  log "存储池就绪：$POOL_ROOT（loopback XFS + pquota，已写进 fstab）"
}

# ── ②b 宿主网络基线 ─────────────────────────────────
# 实例容器从网桥的**网关**后面出去，发给宿主自己的包（sshd:22，以及任何绑 0.0.0.0 的东西）
# 走的是 INPUT，默认一路放行。Docker **没有**原生开关能只关掉这一条 ——
# `com.docker.network.bridge.gateway_mode_ipv4=isolated` 会连网桥地址一起去掉，而它**必须**
# 配 `--internal`，那样实例连出网都没了（实测：官方文档写明 isolated 只用于 internal 网络）。
# 所以只剩两条路：接受「实例够得到宿主上的服务」，或者在宿主 INPUT 上拦一道。这是后者。
#
# 拦法按**接口**、不按网段：网段是 Docker 动态分的（还跟操作者自己的网络共享地址池），而
# 「来自容器网桥接口」正好就是那个威胁面。FORWARD 另外限制私网和容器目的地，
# 保留公网 IPv4 TCP/UDP。宿主主动访问实例的回复通过 conntrack REPLY 放行。
HARDEN_CHAIN=dsh-cloud-input
HARDEN_UNIT=/etc/systemd/system/dsh-cloud-harden.service

require_host_firewall() {
  have systemctl && [ -d /run/systemd/system ] || die "生产安装需要运行中的 systemd，以加载宿主网络边界。"
  have iptables && have iptables-restore || die "生产安装需要 iptables 和 iptables-restore。"
  if [ -d /proc/sys/net/ipv6 ]; then
    have ip6tables && have ip6tables-restore || die "IPv6 已启用，需要 ip6tables 和 ip6tables-restore。"
  fi
}

harden_host() {
  STEP='宿主网络基线'
  require_host_firewall

  # 规则单独落成脚本：systemd 单元开机直接跑它，安装脚本和开机走的是同一份逻辑。
  cat >"$STATE_DIR/harden-host.sh" <<'EOS'
#!/usr/bin/env bash
# 由 scripts/install.sh 生成。**可重复执行**（每次先清空自己的链再重建）。
#
# Scope INPUT and FORWARD restrictions to platform bridges; preserve unrelated workloads.
set -euo pipefail
CHAIN=dsh-cloud-input
FORWARD_CHAIN=dsh-cloud-forward
EGRESS_CHAIN=dsh-cloud-egress
command -v iptables >/dev/null 2>&1 || { echo "缺 iptables" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "缺 docker" >&2; exit 1; }
families=(iptables)
if [[ -d /proc/sys/net/ipv6 ]]; then
  command -v ip6tables >/dev/null 2>&1 || { echo "IPv6 已启用但缺 ip6tables，拒绝仅加固 IPv4" >&2; exit 1; }
  ip6tables -L INPUT -n >/dev/null
  families+=(ip6tables)
fi

# Validate ownership before touching rules, including reserved-prefix collisions.
networks=$(docker network ls --filter driver=bridge --format '{{.ID}}')
bridges=()
destination_bridges=()
for network in $networks; do
  record=$(docker network inspect --format '{{.Id}}|{{.Name}}|{{index .Labels "dsh.cloud/managed"}}|{{index .Labels "dsh.cloud/instance"}}|{{index .Options "com.docker.network.bridge.name"}}' "$network")
  IFS='|' read -r id name managed slug bridge <<<"$record"
  if [[ -z "$bridge" || "$bridge" = '<no value>' ]]; then
    if [[ "$name" = bridge ]]; then bridge=docker0; else bridge="br-${id:0:12}"; fi
  fi
  [[ "$bridge" =~ ^[a-zA-Z0-9_.-]{1,15}$ ]] || { echo "非法 Docker 网桥名，拒绝生成规则" >&2; exit 1; }
  destination_bridges+=("$bridge")
  if [[ "$managed" = true && "$slug" =~ ^[a-z0-9][a-z0-9-]*$ && "$name" = "dsh-net-$slug" ]]; then
    if [[ -z "$bridge" || "$bridge" = '<no value>' ]]; then bridge="br-${id:0:12}"; fi
    [[ "$bridge" =~ ^[a-zA-Z0-9_.-]{1,15}$ ]] || { echo "非法平台网桥名" >&2; exit 1; }
    bridges+=("$bridge")
  elif [[ "$bridge" = dshw* ]]; then
    echo "其他业务占用了平台保留网桥前缀 dshw，拒绝修改防火墙" >&2
    exit 1
  fi
done

for firewall in "${families[@]}"; do
  command -v "$firewall-restore" >/dev/null 2>&1 || { echo "缺 $firewall-restore" >&2; exit 1; }
done
for firewall in "${families[@]}"; do
  # Count only our exact jumps; the transaction never flushes the shared INPUT chain.
  input_rules=$("$firewall" -S INPUT)
  jumps=$(printf '%s\n' "$input_rules" | grep -Fxc -- "-A INPUT -j $CHAIN" || true)
  forward_rules=$("$firewall" -S FORWARD)
  forward_jumps=$(printf '%s\n' "$forward_rules" | grep -Fxc -- "-A FORWARD -j $FORWARD_CHAIN" || true)
  {
    printf '*filter\n:%s - [0:0]\n-F %s\n' "$CHAIN" "$CHAIN"
    printf ':%s - [0:0]\n:%s - [0:0]\n-F %s\n-F %s\n' "$FORWARD_CHAIN" "$EGRESS_CHAIN" "$FORWARD_CHAIN" "$EGRESS_CHAIN"
    printf '%s\n' "-A $CHAIN -m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN"
    printf '%s\n' "-A $CHAIN -i dshw+ -j DROP"
    for bridge in "${bridges[@]}"; do printf '%s\n' "-A $CHAIN -i $bridge -j DROP"; done
    for ((i=0; i<jumps; i++)); do printf '%s\n' "-D INPUT -j $CHAIN"; done
    printf '%s\n' "-I INPUT 1 -j $CHAIN"
    printf '%s\n' "-A $FORWARD_CHAIN -i dshw+ -j $EGRESS_CHAIN"
    for bridge in "${bridges[@]}"; do printf '%s\n' "-A $FORWARD_CHAIN -i $bridge -j $EGRESS_CHAIN"; done
    printf '%s\n' "-A $EGRESS_CHAIN -m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN"
    if [[ "$firewall" = iptables ]]; then
      # These output-interface checks only run for packets originating on platform bridges.
      for bridge in dshw+ docker+ br-+ "${destination_bridges[@]}"; do
        printf '%s\n' "-A $EGRESS_CHAIN -o $bridge -j DROP"
      done
      for destination in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
        printf '%s\n' "-A $EGRESS_CHAIN -d $destination -j DROP"
      done
      printf '%s\n' "-A $EGRESS_CHAIN -p tcp -j RETURN" "-A $EGRESS_CHAIN -p udp -j RETURN"
    fi
    # IPv6 outbound is denied until a separately validated dual-stack policy exists.
    printf '%s\n' "-A $EGRESS_CHAIN -j DROP"
    for ((i=0; i<forward_jumps; i++)); do printf '%s\n' "-D FORWARD -j $FORWARD_CHAIN"; done
    printf '%s\n' "-I FORWARD 1 -j $FORWARD_CHAIN" 'COMMIT'
  } | "$firewall-restore" --wait 5 --noflush
done
EOS
  chmod 755 "$STATE_DIR/harden-host.sh"
  "$STATE_DIR/harden-host.sh"
  log "规则已生效（链 $HARDEN_CHAIN）。看现状：iptables -L $HARDEN_CHAIN -n"

  # iptables 规则不落盘，重启就没了 —— 一个"重启后静默失效"的加固比没有这个开关更坏。
  # 用 systemd 单元而不是 iptables-persistent：不引新包，也不去改操作者自己那份防火墙配置。
  cat >"$HARDEN_UNIT" <<EOS
[Unit]
Description=dsh-cloud workspace host and egress firewall
# Legacy bridges are discovered through Docker labels before installing rules.
Requires=docker.service
After=network.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$STATE_DIR/harden-host.sh

[Install]
WantedBy=multi-user.target
EOS
  systemctl daemon-reload || die "无法加载宿主网络单元，停止安装。"
  systemctl enable --now dsh-cloud-harden.service || die "无法启用宿主网络单元，停止安装。查：systemctl status dsh-cloud-harden"

  warn "平台实例将不能访问宿主/私网服务或主动使用 IPv6；dshw 是平台保留网桥前缀，其他业务不可使用。卸载平台时才移除网络边界。"
  warn "firewalld / ufw 一 reload 有可能把这条链冲掉 —— 复查：iptables -L $HARDEN_CHAIN -n"
}

# 撤掉加固。**只在 uninstall 调**，而且不限于 --purge：这套规则会误伤这台机器上别的容器，
# 平台都不在了就不该留着。
harden_host_down() {
  local had=0 firewall
  if [ -f "$HARDEN_UNIT" ]; then had=1; fi
  for firewall in iptables ip6tables; do
    if have "$firewall" && "$firewall" -L "$HARDEN_CHAIN" -n >/dev/null 2>&1; then had=1; fi
  done
  if [ "$had" = 0 ]; then return 0; fi

  if have systemctl; then
    systemctl disable --now dsh-cloud-harden.service >/dev/null 2>&1 || true
  fi
  for firewall in iptables ip6tables; do
    if have "$firewall"; then
      "$firewall" -D INPUT -j "$HARDEN_CHAIN" 2>/dev/null || true
      "$firewall" -F "$HARDEN_CHAIN" 2>/dev/null || true
      "$firewall" -X "$HARDEN_CHAIN" 2>/dev/null || true
      "$firewall" -D FORWARD -j dsh-cloud-forward 2>/dev/null || true
      "$firewall" -F dsh-cloud-forward 2>/dev/null || true
      "$firewall" -X dsh-cloud-forward 2>/dev/null || true
      "$firewall" -F dsh-cloud-egress 2>/dev/null || true
      "$firewall" -X dsh-cloud-egress 2>/dev/null || true
    fi
  done
  rm -f "$HARDEN_UNIT"
  if have systemctl; then
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f "$STATE_DIR/harden-host.sh"
  log "  宿主侧加固已撤（链 $HARDEN_CHAIN）"
}

# ── ③ 部署资产与配置渲染 ────────────────────────────────────────────────
fetch_assets() {
  STEP='取部署资产'
  log "拉平台镜像 $IMAGE_REPO:$VERSION"
  docker pull -q "$IMAGE_REPO:$VERSION" >/dev/null || die "拉不到 $IMAGE_REPO:$VERSION（检查 tag 和网络；GHCR 包需要是公开的）"
  IMAGE_DIGEST=$(image_digest "$IMAGE_REPO:$VERSION")
  # 标签可能是漂移的（latest），digest 不是 —— 把它记下来，「我到底装的哪版」才有答案
  log "digest：${IMAGE_DIGEST:-（拿不到，非 registry 拉来的镜像没有 RepoDigests）}"

  # 部署资产**随镜像走**：这样模板和镜像版本严格对齐，安装时也不用再连第二个域名。
  # docker cp 直接读镜像文件系统，不依赖镜像里有哪些命令。
  log "从镜像里取部署资产到 $STATE_DIR"
  local cid
  cid=$(docker create "$IMAGE_REPO:$VERSION")
  mkdir -p "$STATE_DIR"
  docker cp "$cid:/app/deploy/." "$STATE_DIR/" || {
    docker rm -f "$cid" >/dev/null
    die "镜像里没有 /app/deploy（镜像太旧？换新 tag）"
  }
  docker rm -f "$cid" >/dev/null

  mkdir -p "$STATE_DIR/traefik/dynamic" "$STATE_DIR/traefik/acme"
}

render_configs() {
  STEP='渲染 Traefik 配置'

  # ACME 恒开。`email:` 那一行**删掉**：留空在 YAML 里是 null，Traefik 未必收；
  # 而 email 本身是可选的（实测：不带 email 的 resolver 通过校验，ACME 照常工作）。
  # 代价是收不到证书过期提醒 —— Traefik 自己会续签，丢的只是"续签失败时的那个预警"。
  sed -e '/^ *email: __ACME_EMAIL__$/d' \
    "$STATE_DIR/traefik/traefik.yml.tmpl" >"$STATE_DIR/traefik/traefik.yml"
  rm -f "$STATE_DIR/traefik/traefik.yml.tmpl"

  # 动态那份（控制台 router / :80 跳转 / 引导口）**不在这里渲染** —— 控制面是它的唯一写者，
  # 每次启动按当前状态（配没配域名）自己写、自己删。安装脚本插一脚只会两边打架。
}

write_env() {
  STEP='写 .env'

  if [ -f "$STATE_DIR/.env" ] && [ "$FORCE_SECRETS" != 1 ]; then
    log ".env 已存在，**保留现有 secret**（重新生成会让所有实例的门 token 立刻失效）"
    PLATFORM_SECRET=$(env_get PLATFORM_SECRET)
    BETTER_AUTH_SECRET=$(env_get BETTER_AUTH_SECRET)
    POSTGRES_PASSWORD=$(env_get POSTGRES_PASSWORD)
    # 引导态那枚一次性 token 也照旧 —— 重跑一次就换掉它，等于把刚打印给操作者的链接作废
    SETUP_TOKEN=$(env_get SETUP_TOKEN)
    [ -n "$PLATFORM_SECRET" ] || die ".env 在，但读不到 PLATFORM_SECRET。修好它，或删掉 $STATE_DIR/.env 重装（会换 secret）。"
    [ -n "$POSTGRES_PASSWORD" ] || die ".env 在，但读不到 POSTGRES_PASSWORD —— DATABASE_URL 会拼错。修好它。"
  else
    PLATFORM_SECRET=$(rand_hex)
    BETTER_AUTH_SECRET=$(rand_hex)
    POSTGRES_PASSWORD=$(rand_hex)
    SETUP_TOKEN=''
  fi

  # 引导页的一次性凭证，**总是**要有：装机之后域名一定还没配（域名在引导页里填），
  # 所以控制面必然以引导态起来，这枚 token 就是那个页面的唯一凭证。
  [ -n "$SETUP_TOKEN" ] || SETUP_TOKEN=$(rand_hex)

  # 登录页上的演示账号。**从既有 .env 或调用者环境透传**（环境优先），不在这里生成 ——
  # 这份 .env 每次 update 都是整份重写，不显式透传的话操作者手加的两行会被无声抹掉，
  # 症状是「登录页那块提示突然不见了」。普通部署留空 = 登录页什么都不多出来。
  DEMO_EMAIL=${DEMO_EMAIL:-$(env_get DEMO_EMAIL)}
  DEMO_PASSWORD=${DEMO_PASSWORD:-$(env_get DEMO_PASSWORD)}

  local tmp="$STATE_DIR/.env.new"
  cat >"$tmp" <<EOF
# 由 scripts/install.sh 生成。手改要小心：secret 一换，实例的门 token 全废（桥 403）。
DATABASE_URL=postgres://dshcloud:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/dsh_cloud
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_PORT=${POSTGRES_PORT}

# 域名**不在这里**。装机不配域名：控制面以引导态起来，域名由操作者在引导页里填、写进
# platform_setting；之后要改也是写那张表（镜像里的 domain 子命令）。所以这份 .env 里
# 刻意**不留** BASE_DOMAIN / CONSOLE_DOMAIN 两个键 —— env 有值会压过 DB（见 env.ts），
# 而这个脚本每次都会整份重写 .env，留一个"看着能改、一重跑就被抹平"的旋钮只会误导人。
PUBLIC_SCHEME=https

# 引导页的一次性凭证。配好域名后引导口被摘掉，它自然失效（见 control-plane 的 setup-routes）。
SETUP_TOKEN=${SETUP_TOKEN}

PLATFORM_SECRET=${PLATFORM_SECRET}
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}

# 平台镜像 tag（compose 用它选镜像）
DSH_CLOUD_IMAGE=${IMAGE_REPO}:${VERSION}

PORT=${CONTROL_PORT}
WEB_DIST_DIR=/app/web

HOST_STORAGE_ROOT=${POOL_ROOT}
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_CERT_RESOLVER=le
INSTANCE_UPSTREAM_HOST=127.0.0.1
INSTANCE_IMAGE_REPO=ghcr.io/eskim2001/dsh-instance

TRAEFIK_ROUTES_PATH=/etc/traefik/dynamic/routes.yml
FORWARD_AUTH_ADDRESS=http://127.0.0.1:${CONTROL_PORT}/auth/verify

MAX_INSTANCES_PER_USER=3

# 登录页上的演示账号提示（两个都填才显示）。只有对外提供试用入口的部署才设；
# 普通部署留空 —— 那时登录页上什么都不多出来。这里只是把它落盘，
# 值在上面的 write_env 里从既有 .env / 调用者环境透传过来。
DEMO_EMAIL=${DEMO_EMAIL}
DEMO_PASSWORD=${DEMO_PASSWORD}
EOF
  install -m 600 "$tmp" "$STATE_DIR/.env"
  rm -f "$tmp"
}

# 安装只需要定两个端口：控制面自己（= 引导页）和 Postgres。
# 定过一次就沿用 .env 里读回来的值，别悄悄挪走。
pick_ports() {
  STEP='确定端口'
  pick_control_port
  POSTGRES_PORT=${POSTGRES_PORT:-$POSTGRES_PORT_DEFAULT}
}

# ── ④ 起服务 ────────────────────────────────────────────────────────────
start_services() {
  STEP='起 Postgres'
  log "起 Postgres 并等它就绪"
  compose up -d postgres

  local tries=60
  until compose exec -T postgres pg_isready -U dshcloud -d dsh_cloud >/dev/null 2>&1; do
    tries=$((tries - 1))
    [ "$tries" -gt 0 ] || die "Postgres 60 秒内没就绪。看：docker compose -f $STATE_DIR/prod.yml logs postgres"
    sleep 1
  done

  STEP='跑数据库迁移'
  log "迁移"
  # Postgres is already ready; migrations must not start the privileged runtime dependency.
  compose run --rm --no-deps control-plane migrate

  STEP='起节点、控制面与入口'
  compose up -d node-agent control-plane traefik

  STEP='等控制面就绪'
  wait_for_console

  printf '\n\033[32m✓ 装好了\033[0m\n\n'
  # 「配好没配好」看**控制面的投影**：platform.yml 在 = 域名配过了（那份域名存在平台的库里）。
  # 别拿 .env 判 —— 装机不写域名，那两项恒为空，照它判会把已配置的机器当成引导态、
  # 打印一条早就作废的指引。
  if [ -f "$STATE_DIR/traefik/dynamic/platform.yml" ]; then
    printf '  域名　　　：已配置（存在平台的库里，管理入口是 https://<控制台域名>/admin）\n'
    printf '  首次访问时 ACME 可能还在签发证书（几秒到一分钟），报证书错就等一下再刷。\n'
  else
    printf '  \033[1m下一步：用浏览器打开下面这条链接，在那里建管理员账号、填域名。\033[0m\n\n'
    printf '    http://%s:%s/setup?token=%s\n' "$(machine_address)" "$CONTROL_PORT" "$SETUP_TOKEN"
    printf '\n'
    printf '  平台上**还没有账号、也没有域名**。这个页面是此刻唯一的入口，token 是它唯一的凭证（一次性）。\n'
    printf '  账号和域名都在那一页里填。默认控制台就是父域本身，填完重启后打开 https://<父域>/admin。\n'
    printf '  填之前先把父域的 A 记录和泛解析 *.<父域> 指向这台机器 —— 否则证书签不下来。\n'
  fi
  printf '\n'
  printf '  下一步：登录 → 管理台「镜像管理」把实例镜像设为默认 → 建实例。\n'
  printf '  安全边界（宿主权限由节点服务持有，控制面只连接受限接口）：\n'
  printf '    https://github.com/eskim2001/dshcloud/blob/main/docs/ARCHITECTURE.md\n'
}

# 引导期要打印一个操作者**能直接打开**的地址：优先公网 IP（他浏览器能到的是那个），
# 拿不到就退到本机第一个非回环地址（内网部署够用）。
machine_address() {
  if have curl; then
    local pub
    pub=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
    if [ -n "$pub" ]; then
      printf '%s' "$pub"
      return 0
    fi
  fi
  hostname -I 2>/dev/null | awk '{print $1}'
}

wait_for_console() {
  if ! have curl; then
    warn "宿主没有 curl，跳过就绪检查。自己确认：curl -fsS http://127.0.0.1:${CONTROL_PORT}/healthz"
    return
  fi
  local tries=45
  until curl -fsS --max-time 3 "http://127.0.0.1:${CONTROL_PORT}/healthz" >/dev/null 2>&1; do
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then
      die "控制面 45 秒内 /healthz 不通。常见原因：存储池不满足（HOST_STORAGE_ROOT）—— 看 \`docker compose -f $STATE_DIR/prod.yml logs control-plane\`。"
    fi
    sleep 1
  done
  log "控制面就绪"
}

# ── 子命令 ──────────────────────────────────────────────────────────────
cmd_install() {
  if [ -f "$STATE_DIR/.env" ]; then
    # 已有安装：**先**把上次的值读回来，再预检 —— 端口和池子路径都是「这台机器上装在哪」
    # 的一部分，重跑不能悄悄换掉（换了等于把上一轮的东西晾在那儿）。
    log "检测到已有安装（$STATE_DIR/.env）—— 保留数据与 secret"
    POOL_ROOT=$(env_get HOST_STORAGE_ROOT)
    POSTGRES_PORT=$(env_get POSTGRES_PORT)
    CONTROL_PORT=$(env_get PORT)
  fi

  preflight
  pick_ports
  provision_pool
  fetch_assets
  # 放在 fetch_assets 之后：它把 $STATE_DIR 建出来，而加固脚本落在那里。
  # 首装和升级都必须成功配置边界后才能启动服务。
  harden_host
  write_env
  render_configs
  start_services

  # 记**两份**：人能读的标签，和不会漂移的 digest
  printf 'version=%s\ndigest=%s\n' "$VERSION" "$IMAGE_DIGEST" >"$STATE_DIR/.installed-version"
}

cmd_update() {
  CMD=update
  cmd_install
}

# 工作空间容器**不属于** compose 项目 —— 它们是控制面经 docker.sock 建的（label 见
# instance-spec 的渲染器），所以 `compose down` 碰不到它们。不显式处理就会留下还在跑的孤儿：
# 没有入口也没有控制面，纯白吃 CPU/内存。用平台**自己的 label** 找，别按名字猜。
managed_instance_ids() {
  docker ps -aq --filter 'label=dsh.cloud/managed=true' 2>/dev/null || true
}

# 每实例一个网络（label 见 instance-spec 的渲染器）。同样不属于 compose 项目，`compose down`
# 碰不到它们；留着会一直占着 Docker 的地址池（默认池能分的网络数很少）。
managed_network_ids() {
  docker network ls -q --filter 'label=dsh.cloud/managed=true' 2>/dev/null || true
}

# 这个路径会被直接 rm -rf，而它来自 .env（可能被截断或手工改过）。先过一遍形状检查。
pool_root_is_removable() {
  local p=${1:-}
  # 先挡写法：结尾的 `/`、`/..`、路径中间的 `/../` 都能让 `rm -rf <值>` 变成 `rm -rf /` 或顶层
  # 目录 —— 光数层级是拦不住的（`/var/..` 有两层）。这几条放在最前面。
  case "$p" in
    / | */ | *.. | */../*) return 1 ;;
  esac
  # 再要绝对、且至少在 / 下面两层：`/pool` 这种单层路径会被拒（宁可让操作者手工确认），
  # 因为放行单层就等于要逐个列全部顶层目录，漏一个就是灾难。
  case "$p" in
    /*/*) ;;
    *) return 1 ;;
  esac
  case "$p" in
    /bin | /boot | /dev | /etc | /home | /lib | /lib64 | /media | /mnt | /opt | /proc | \
      /root | /run | /sbin | /srv | /sys | /tmp | /usr | /var) return 1 ;;
  esac
  # 二级目录也挡一道：`.env` 被截断成 `/var/lib`（从 `/var/lib/dsh`）这种是能通过的，
  # 而 `rm -rf /var/lib` 会连 docker、apt 的目录一起带走。
  case "$p" in
    /var/cache | /var/lib | /var/log | /var/run | /var/spool | /var/tmp | \
      /usr/bin | /usr/include | /usr/lib | /usr/local | /usr/sbin | /usr/share | /usr/src) return 1 ;;
  esac
  return 0
}

# 调用方必须先过 pool_root_is_removable。
teardown_pool() {
  # 先 umount：池子还挂着的时候删 .img，等于把挂着的东西从底下抽掉
  umount "$1" 2>/dev/null || true
  rm -rf "$1"
  rm -f "$1.img"
  # 挂载行和那行说明注释一起删，别在 fstab 里留孤儿（注释以 `# dsh-cloud 实例数据池` 开头）
  sed -i -e "\|^[^#]*[[:space:]]$1[[:space:]]|d" \
    -e '\|^# dsh-cloud 实例数据池|d' /etc/fstab 2>/dev/null || true
}

manual_pool_cleanup() {
  printf '  存储池没清（路径读不到，或看着不像池子路径）。手工清：\n' >&2
  printf '    1. 找：mount | grep xfs，以及 /etc/fstab\n' >&2
  printf '    2. 卸：umount <池子路径>\n' >&2
  printf '    3. 删：rm -rf <池子路径> <池子路径>.img\n' >&2
  printf '    4. 删 /etc/fstab 里以 "# dsh-cloud 实例数据池" 开头的那两行\n' >&2
}

cmd_uninstall() {
  STEP='卸载'

  # prod.yml 是「装过一次」的凭据，但**不是**卸载的前提：install 在它落盘之前就已经建池子、写
  # fstab 了（cmd_install 里 provision_pool 早于 render_configs）。装到一半死掉恰恰是最需要清
  # 的状态，所以这里降级成「能确定多少清多少」，而不是拿一句「这里没装过？」把操作者挡回去。
  local degraded=0
  [ -f "$STATE_DIR/prod.yml" ] || degraded=1

  local ids root='' nets
  ids=$(managed_instance_ids)
  root=$(env_get HOST_STORAGE_ROOT)

  if [ "$degraded" = 1 ]; then
    warn "没找到 $STATE_DIR/prod.yml —— 这不是一次完整安装（装到一半失败，或已经被卸过）。"
    warn "只清能确定的部分；compose 栈（如果有）的容器要手工 docker ps 处理。"
  fi

  if [ "$PURGE" = 1 ]; then
    warn "--purge：连 Postgres 卷、存储池、工作空间容器一起删，**不可恢复**"
    if [ "$degraded" = 0 ]; then
      log "停服务、删容器（含工作空间）"
      compose down -v --remove-orphans || true
    fi
    if [ -n "$ids" ]; then
      # 必须**先删容器再动池子**：它们 bind 在池子目录上，池子被 umount + 删掉之后
      # 它们写进去的东西会直接进已删除的目录（静默），而且 loop 设备还被它们占着。
      # 未加引号是有意的：$ids 是多行 id 列表，这里就是要按空白拆开。
      # shellcheck disable=SC2086
      docker rm -f $ids >/dev/null && log "  工作空间容器已删"
    fi
    nets=$(managed_network_ids)
    if [ -n "$nets" ]; then
      # 顺序不能反：网络里还有端点时 Docker 拒绝删 —— 上面那批容器删完，这里才删得掉。
      # shellcheck disable=SC2086
      docker network rm $nets >/dev/null && log "  实例网络已删"
    fi
    if [ -n "$root" ] && pool_root_is_removable "$root"; then
      teardown_pool "$root"
      log "  存储池与 fstab 已清：$root"
    else
      manual_pool_cleanup
    fi
    rm -rf "$STATE_DIR"
    log "清干净了。"
  else
    if [ "$degraded" = 0 ]; then
      log "停服务并删容器"
      compose down --remove-orphans || true
    fi
    if [ -n "$ids" ]; then
      # 只**停**不删：容器和它的数据都还在，重装之后平台自己会把「状态是 running」的
      # 那批拉起来（见 instance/boot.ts）。留着跑才是错的 —— 它们此时既没有入口也没有控制面。
      # shellcheck disable=SC2086
      docker stop $ids >/dev/null && log "  工作空间容器已停（数据留着，重装即可再用）"
    fi
    if [ "$degraded" = 0 ]; then
      log "容器删了；**Postgres 卷、存储池与工作空间数据保留**。"
    else
      log "能确定的都清了；**存储池与工作空间数据保留**。"
    fi
    printf '  连数据一起删：install.sh uninstall --purge\n'
  fi

  # 两条路都撤。放在最后、且在 `rm -rf $STATE_DIR` 之后也照样成立：它认的是 systemd 单元和
  # iptables 链，不认状态目录。**平台都不在了就不该留着这条链** —— 它会误伤这台机器上别的容器。
  harden_host_down
}

case "$CMD" in
  install) cmd_install ;;
  update) cmd_update ;;
  uninstall) cmd_uninstall ;;
esac
