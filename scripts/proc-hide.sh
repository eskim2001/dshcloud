#!/usr/bin/env bash
#
# 宿主侧的 /proc 加固：装 lxcfs，让实例容器读到的是**自己那份**内存 / 运行时长 / swap，
# 而不是宿主的 —— 后者能指纹宿主（几核、多大内存、哪天开的机），也能当跨租户侧信道。
#
# 它只管**宿主那一半**：装包、起服务、自检。另外两半不代做，装完会打印出来 ——
#   ① 重启控制面（探测只在启动时做一次）  ② 在控制台里重启各实例（挂载在建容器时定死）
#
# 盖得住的（2026-09-15 真机逐文件量过、2026-09-16 复量，表见 docs/SECURITY-HARDENING.md）：
#   /proc/meminfo（内存总量）、/proc/uptime（开机时长）、/proc/swaps（设备名与已用量）
# 盖不住的，别以为装了它就没了：
#   /proc/loadavg（负载没有命名空间）、/proc/cpuinfo（按 cpuset 假，而平台给的是 CPU 配额）、
#   /proc/stat 的 btime（宿主开机时刻照旧可读）、/proc/diskstats、/proc/slabinfo
#
# 用法见 -h。
set -euo pipefail

STATE_DIR=/opt/dsh-cloud

log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m警告：\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m错误：\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
用法：proc-hide.sh [选项]

在**宿主机上以 root 跑**。装上 lxcfs —— 实例容器里的 /proc/meminfo、/proc/uptime、
/proc/swaps 从此报容器自己的值，而不是宿主机的。

选项
  （无）        装上并自检；已经装了就只做自检（幂等）
  --remove      停掉并禁止开机自启（**保留**包，随时能再开）
  --purge       --remove 之外再卸掉包
  -h, --help    显示这段

它只做宿主这一半。装完还要：① 重启控制面 ② 在控制台里重启各实例 —— 脚本会打印命令。
EOF
}

CMD=install
while [ $# -gt 0 ]; do
  case "$1" in
    --remove) CMD=remove; shift ;;
    --purge) CMD=purge; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "不认识的参数：$1（-h 看用法）" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "要 root（要装包、起 systemd 服务）。用 sudo 跑。"

# ── 装包 ────────────────────────────────────────────────────────────────
install_package() {
  if have apt-get; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq lxcfs
  elif have dnf; then
    dnf install -y lxcfs
  elif have yum; then
    yum install -y lxcfs
  else
    die "这台机器上的包管理器不认识（只写了 apt-get / dnf / yum 三条路）。请自行安装 lxcfs 后重跑本脚本。"
  fi
}

purge_package() {
  if have apt-get; then
    DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq lxcfs
  elif have dnf; then
    dnf remove -y lxcfs
  elif have yum; then
    yum remove -y lxcfs
  else
    warn "包管理器不认识，包没卸。手动卸掉 lxcfs。"
  fi
}

# ── 服务 ────────────────────────────────────────────────────────────────
start_service() {
  have systemctl || die "这台机器上没有 systemctl，lxcfs 起不来也就没人挂它。本脚本只覆盖 systemd 的机器。"
  systemctl enable --now lxcfs >/dev/null 2>&1 ||
    die "lxcfs 起不来。查：systemctl status lxcfs; journalctl -u lxcfs -n 50"
}

stop_service() {
  have systemctl || return 0
  systemctl disable --now lxcfs >/dev/null 2>&1 || true
}

# ── 自检（**如实报告**，别把"装了"说成"挡住了"）────────────────────────
self_check() {
  local ok=1
  if [ -r /var/lib/lxcfs/proc/meminfo ]; then
    log "  /var/lib/lxcfs/proc/meminfo 在（控制面就靠它探测）"
  else
    warn "  /var/lib/lxcfs/proc/meminfo 读不到 —— 控制面探测不出 lxcfs，装了也不会生效。"
    ok=0
  fi
  if grep -q 'lxcfs /var/lib/lxcfs' /proc/mounts; then
    log "  lxcfs 已挂上（/proc/mounts 里能看到）"
  else
    warn "  /proc/mounts 里没有 lxcfs —— 服务大概没真正起来。"
    ok=0
  fi
  # 宿主上读它得到的是宿主自己的值（lxcfs 按**读它的那个 cgroup**给数），所以这里只查在不在，
  # 查值要进实例容器里查。
  [ "$ok" = 1 ]
}

# 平台侧那一半。**沉默失败是最坏的结果**：装了 lxcfs 却因为平台这版还不认识它而毫无变化。
check_platform() {
  local f="$STATE_DIR/prod.yml"
  if [ ! -f "$f" ]; then
    log "  这台机器上没有平台（$f 不在），跳过平台侧检查。"
    return 0
  fi
  if grep -q '/var/lib/lxcfs' "$f"; then
    log "  平台的 $f 里有 lxcfs 挂载"
  else
    warn "  平台的 $f 里**没有** lxcfs 挂载 —— 控制面看不见它，装了这一整套都不会生效。"
    warn "  这一份是安装脚本从平台镜像里取出来的：先升级平台再重跑本脚本（scripts/install.sh update）。"
    return 1
  fi
}

next_steps() {
  log "接下来两步（本脚本不代做）："
  printf '  1. 重启控制面，让它探测到 lxcfs：\n     docker restart dsh-control-plane\n'
  printf '  2. 在控制台里**重启每个实例** —— 挂载是建容器时定死的，之前建的容器不会自己拿到。\n'
  printf '  验证（进实例的终端）：\n'
  printf '     grep MemTotal /proc/meminfo   # 应当等于该实例的内存上限，不再是宿主的\n'
  printf '     cat /proc/uptime              # 应当是该实例的运行时长，不再是宿主开机时长\n'
  printf '  挡不住的照旧挡不住：cat /proc/loadavg 仍是宿主负载、nproc 仍是宿主核数。\n'
}

case "$CMD" in
  install)
    if have lxcfs; then
      log "lxcfs 已经装了（$(command -v lxcfs)），只做自检"
    else
      log "装 lxcfs"
      install_package || die "装 lxcfs 失败。手动装一次再重跑本脚本。"
    fi

    start_service
    self_check || die "lxcfs 没起来或没挂上，别往下走 —— 先解决问题（见上面几行）。"
    check_platform || true
    next_steps

    warn "代价：lxcfs 停/重启会让**已经在跑的**实例容器里那几个文件失效（FUSE 连接断，读会报错）。"
    warn "生产上别随意重启 lxcfs；真重启了，把受影响的实例重建一次。"
    ;;

  remove)
    stop_service
    log "lxcfs 已停用并禁止开机自启（包还在，随时能再开：重跑本脚本）。"
    warn "**马上重启控制面**（docker restart dsh-control-plane）：它只在启动时探测一次，"
    warn "不重启的话，中间态里**新建**的实例容器会**直接起不来** —— 源路径已经不在了，Docker 会把它"
    warn "建成一个目录，而 /proc/meminfo 是文件，挂不上去（实测报 \"not a directory\"）。"
    warn "**已经在跑的**容器里那几个文件也已经断了（读报 \"Transport endpoint is not connected\"）"
    warn "—— 重建实例才干净。"
    ;;

  purge)
    stop_service
    purge_package
    log "lxcfs 已停用、已卸包。"
    warn "**马上重启控制面**（docker restart dsh-control-plane），理由同 --remove。"
    warn "**已经在跑的**容器里那几个挂载点还指着（现在已不存在的）lxcfs —— 重建实例才彻底。"
    ;;
esac
