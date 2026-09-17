# 基于 Docker 的容器隔离方案

> 2026-09-16。本文是「在 Docker 容器里跑不可信代码」这件事的完整隔离参考——
> **安全隔离**、**资源隔离**、**适用场景**三条线，逐条列手段、列边界、列挡不住的东西。
> 证据分两路：业界清单（出处见文末）与本项目实测——实测全部在一台 Debian 13 /
> 4 核 / 8G / 无 KVM 的普通 VPS 或 Docker Desktop（linuxkit 内核）上完成。
> 平台逐项现状以 [ARCHITECTURE](ARCHITECTURE.md) §四/§五 为准，本文不复列。

---

## 一、安全隔离

安全隔离要回答一个问题：**被攻陷的容器能做什么、够得着谁**。
Docker 的安全边界由五个层面叠加构成——任何一层缺席，其它层都无法完全补偿。

### 1.1 内核：共享即共命运

**这是 Docker 隔离的结构性天花板。**

Docker 容器与宿主共享一个 Linux 内核。内核暴露 ~300+ 个系统调用，
即使 seccomp 默认 profile 只过滤掉 ~44 个。一旦内核存在可被容器内触发的漏洞，
攻击者直接获得宿主权限——不是「串到邻居」，是**宿主失陷**。

历史上已有多次容器逃逸 CVE：

| CVE | 年份 | 向量 |
|---|---|---|
| CVE-2019-5736 | 2019 | runc 文件描述符泄漏，覆写宿主上的 runc 二进制 |
| CVE-2020-15257 | 2020 | containerd host 网络模式下的抽象 Unix socket |
| CVE-2022-0185 | 2022 | 文件系统上下文溢出 → 内核代码执行 |
| CVE-2024-21626 | 2024 | runc WORKDIR 文件描述符泄漏 |

**对策只有两档**（且互斥于 Docker 默认运行时）：

- **gVisor**（runsc）：用户态内核拦截系统调用，宿主内核只面对一份明确枚举过的小调用面。
  本平台量过：**不能跑**——dsh 的沙箱链（bwrap / Landlock）在 runsc 下全灭
  （`EPERM` / `ENOSYS`），dsh 按 fail-closed 语义拒绝执行命令。
- **microVM**（Kata Containers / Firecracker）：每容器一个独立内核，硬件边界。
  本平台量过：**跑不了**——要 `/dev/kvm`（硬件虚拟化支持），多数 VPS 不开嵌套虚拟化。

所以「接受共享内核」是本平台**写下来的决定**（D2），不是默认状态。

### 1.2 网络：谁能连谁

Docker 的网络隔离有三个层次，各管不同的通道：

| 手段 | 挡什么 | 挡不了什么 |
|---|---|---|
| **每实例一个 Docker 网络**（`dsh-net-<slug>`） | 实例之间直连 / ARP 扫描 / ARP 欺骗 | 容器到宿主、容器出网 |
| **桥端口只发布到宿主回环**（`127.0.0.1:<port>`） | 局域网直连实例端口 | Docker Desktop 上 `host.docker.internal` 绕得开（见下） |
| **宿主侧 INPUT 规则**（可选） | 容器到宿主上绑 `0.0.0.0` 的服务（ssh 等） | — |

**实测记录：**

- **默认 bridge 是反面教材**（2026-09-15）：所有实例接 Docker 默认 `bridge` 时，
  同处一个 L2 广播域——ARP 扫 `172.17.0.0/16` 就能看到邻居的 `:8080` 有响应，
  直连 / 端口扫描 / ARP 欺骗三条同时成立，且桥上转发的是明文（TLS 在入口终结了）。
  给每个实例一个自己的网络后三条一起消失：跨网段不可达，`ip neigh` 连邻居的表项都没有。

- **容器够得到宿主上绑非回环地址的服务**（2026-09-12）：容器访问宿主走 INPUT 路径，
  绑 `0.0.0.0` 的 socket 可达，绑 `127.0.0.1` 的不可达（`ECONNREFUSED`）。
  Docker 没有原生开关（`gateway_mode=isolated` 必须配 `--internal`，出网一起没了），
  挡它只能靠宿主侧 INPUT 规则。

- **Docker Desktop 上「发布到回环」不是边界**（2026-09-15）：`host.docker.internal`
  代理到宿主 localhost，宿主回环上的一切监听（含别的实例发布的桥端口）对所有容器开放。
  这是开发机特有，Linux 宿主不受影响。

**两个额外风险**：

1. **出网不过滤**。Docker 不提供 egress 过滤；做只能宿主侧 iptables / nftables，
   Docker Desktop 上无解。
2. **firewalld 重载会冲掉隔离规则**。受影响版本的 Docker 在 firewalld 重载后，
   跨网络的 iptables 规则被冲掉且 Docker 不重建（CVE-2025-54410）——
   隔离会**静默**失效。配置看起来是对的，但实际已裸奔。

### 1.3 文件系统：存储隔离与配额

每实例一份独立的数据目录（池子里的 `<pool>/<key>`），配额用文件系统级的 **XFS project quota**。

**实测（2026-09-12，Debian 12 / 内核 6.1 / Docker 29，loopback XFS 池）：**
- 限 256 MiB，灌 400 MiB → 只写进 256.0 MiB，然后 `ENOSPC`
- `df` / `statfs` 报的是**配额**不是宿主盘（实测：租户目录 256.0 MiB，池子 4032 MiB）
- 字节与 inode 双限（`bhard` + `ihard`），超限的创建同样被拒
- 硬限拦在文件系统的分配路径上，容器内有多少 capability 都改不了

**三个必须知道的要点：**

| 要点 | 说明 |
|---|---|
| **字节和 inode 必须一起限** | 只限字节，几百万个零字节文件就能耗尽宿主 inode，整台机器的文件系统瘫痪 |
| **设配额失败是静默的** | 设配额要 `CAP_SYS_ADMIN`，读 report 不需要。设不上不报错——必须在启动时自检、失败即拒绝启动 |
| **Docker Desktop 不支持** | linuxkit 内核裁了 `CONFIG_XFS_QUOTA`，`mount -o pquota` 一律 `EINVAL`。那里退回命名卷、不强制，界面标「无上限」 |

### 1.4 容器加固：capabilities / seccomp / 权限

业界清单（Docker 官方安全文档、云厂商指南、安全团队容器加固页）高度一致：

| 项 | 做什么 | 要点 |
|---|---|---|
| 禁 `--privileged` | 阻止容器获得宿主全部 capabilities + 设备访问 | 等于宿主 root，**绝不能用** |
| **CapDrop** | `--cap-drop=ALL` 后按需 `--cap-add` | Docker 默认保留 ~14 条 capability（含 CHOWN / SETUID / NET_RAW 等），不含 SYS_ADMIN |
| **`no-new-privileges`** | 阻止 setuid/setgid 二进制提权 | 容器内有 setuid 程序时必须开 |
| **seccomp** | 默认 profile 过滤 ~44 个危险 syscall（mount / reboot / swapon 等） | 可在此基础上进一步收紧 |
| **AppArmor** | Docker 默认 `docker-default` profile 限制 mount / ptrace / 敏感 /proc 访问 | 多一层 MAC 纵深 |
| **MaskedPaths** | 把 `/dev/null` 覆盖到敏感路径上 | **设了就是整份替换**默认列表，不是追加 |
| **ReadonlyPaths** | 把若干 /proc、/sys 路径设为只读 | 默认 5 条：`/proc/bus`、`/proc/fs`、`/proc/irq`、`/proc/sys`、`/proc/sysrq-trigger` |
| **userns-remap** | 容器 root → 宿主非特权 UID（100000+） | 逃逸后也是非特权用户；与 `--privileged` 不兼容 |
| **Rootless Docker** | Docker daemon 自身也以非 root 跑 | 比 userns-remap 更强，但有存储驱动和网络限制 |
| 资源上限 | `--memory` / `--cpus` / `--pids-limit` | 见下文「资源隔离」 |

**两个清单一般不写、但实测踩过的坑**：

1. **MaskedPaths 的「整份替换」**。默认表不进 `HostConfig`，你设 13 条，
   默认那 12 条就没了。且默认表**随 daemon 版本漂移**：同一时期两台机器，
   一份 11 条、一份 12 条（差的是 `/proc/interrupts`）。
   → 照抄一份写死，用测试守着。

2. **资源上限要验证「真的带下去了」**。本平台有过先例：schema 有字段、界面能调、
   驱动没往下带——改了不生效（`pidsLimit`，2026-09-13 才接上）。

### 1.5 凭据隔离

**零跨实例凭据**：实例里没有 DB 凭据、平台密钥、Docker socket、全局共享 HMAC。
实例之间真正共享的东西只有一个——内核。

这条看似简单，但它是最容易被「加个功能」时打破的边界。
只要任何一条凭据（数据库连接串、API key、宿主密钥）进入容器环境变量，
该实例被攻陷后的爆炸半径就不再是「一个容器」而是「该凭据能碰的一切」。

### 1.6 `/proc` 与 `/sys` 信息泄漏

这一层**主流清单不认**。逐份翻过 2026 年的清单类材料：它们挡的是「敏感文件」
（`/proc/kcore`、`/sys/firmware`），没有一份把「宿主全局数字」当泄漏面。

但泄漏是真的，且共享内核下**根治不了**：

**宿主全局文件（容器内可读）：**

| 路径 | 泄漏内容 | 能否遮蔽 |
|---|---|---|
| `/proc/meminfo` | 宿主总内存 | lxcfs ✓ |
| `/proc/uptime` | 宿主开机时长 | lxcfs ✓ |
| `/proc/swaps` | 交换设备名与已用量 | lxcfs ✓ |
| `/proc/loadavg` | 宿主负载 | lxcfs ✗（负载值原样透传，只有进程数是容器的） |
| `/proc/stat` | 含 `btime`（宿主启动时间戳） | lxcfs ✗ |
| `/proc/cpuinfo` | 宿主 CPU 型号与核数 | lxcfs ✗（按 cpuset 假，配额走 `NanoCpus` 就落空） |
| `/proc/diskstats` | 宿主磁盘 IO 计数 | lxcfs ✗ |
| `/proc/slabinfo` | 内核 slab 分配器状态 | lxcfs ✗ |
| `/sys/devices/virtual/dmi/id/*` | 宿主机型、是否虚拟机 | MaskedPaths ✓（与 lxcfs 无关） |

**这些数字能做两件事**：**指纹宿主**（几核、多大内存、哪天开的机）、
**当跨租户侧信道**（推断邻居的负载变化、宿主的重启事件）。
它不是数据泄漏，是**形状泄漏**。

**lxcfs 是治标手段，不是边界：**

lxcfs 是**资源可见性工具**（官方定位：让容器里的 `free` / `top` 报自己的限额），
不是隔离机制。实测（2026-09-15/16）8 个假文件中只有 3 个真正生效
（`meminfo` / `uptime` / `swaps`）。更关键的是：**直接调 `sysinfo(2)` 的程序
根本不读 `/proc`**——实测同一个容器里 `/proc/meminfo` 报 2 GB、`/proc/uptime` 报 0.09 秒，
而 `sysinfo(2)` 照样返回宿主的 8138036 kB 与 536750 秒 —— 在共享内核这个前提下，这一条没有遮蔽手段。

**部署上两个实测过的坑**：

1. **lxcfs 停 / 重启**会断掉已在跑的容器里的 FUSE 挂载（读报
   `Transport endpoint is not connected`），需要重建受影响的容器。
2. **bind 源缺失时 Docker 把源建成目录**，而目标是文件 → 容器**直接起不来**
   （`not a directory`）。宿主撤掉 lxcfs 后必须立即重启控制面（探测只在启动时做一次），
   否则中间态里新建的实例全是硬失败。

### 1.7 容器内沙箱（应用级纵深）

加固是平台层的手段，容器内部的应用也可以再加一层。本平台的 dsh 自身把用户命令包在
`bubblewrap → Landlock → 全部失败就拒绝执行` 的沙箱链里。

实测现状：
- **生产 Linux（runc）**：Landlock ABI 6 扛住整条链
- **Docker Desktop**：两档全灭——linuxkit 内核没编 Landlock
  （`CONFIG_SECURITY_LANDLOCK is not set`），默认容器里 `unshare -U` 是 EPERM，
  bwrap 因此也起不来。只剩不经沙箱的档位能跑命令

---

## 二、资源隔离

资源隔离的目标是**一个租户吃不掉另一个租户的资源**。Docker 通过 Linux cgroups
提供资源限制，但「设了」≠「生效了」——每一项都要验证。

### 2.1 CPU

| 参数 | 行为 | 注意 |
|---|---|---|
| `--cpus=<float>`（API: `NanoCpus`） | **硬限**：CFS quota/period 实现，超限被 throttle | 是上限不是预留，空闲时可用更多 |
| `--cpu-shares=<int>` | **软限**：只在 CPU 竞争时按权重分配 | 默认 1024，不竞争时无效 |
| `--cpuset-cpus=<string>` | 绑定到指定核心 | 适合需要 CPU 亲和性的场景 |

**cgroups v1 vs v2**：v2 把 `cpu.max`（硬限）和 `cpu.weight`（权重）统一到一个层级，
还提供 PSI（Pressure Stall Information）指标。Docker 20.10+ 支持 v2。

### 2.2 内存

| 参数 | 行为 | 注意 |
|---|---|---|
| `--memory=<bytes>` | 硬限，超限触发 OOM killer | 默认无限 |
| `--memory-swap=<bytes>` | 内存 + swap 总限 | 设成 `--memory` 的值 = 禁 swap |
| `--memory-reservation=<bytes>` | 软限，内存紧张时才生效 | — |
| `--oom-kill-disable` | 超限时挂起而非杀死 | **危险**——可导致宿主级 OOM |

Docker 默认把容器进程的 OOM adjustment score 调高，
让内存不足时优先杀容器进程而非宿主服务。

### 2.3 PID

`--pids-limit=<int>` 限制容器 cgroup 内的最大进程数。**多租户场景必须设**——
没有 PID 限制时，一个容器的 fork bomb 可以耗尽宿主的全局 PID 空间。

默认值为无限。Docker daemon 可在 `daemon.json` 里设 `default-pids-limit`。

### 2.4 磁盘 I/O

| 参数 | 行为 | 限制 |
|---|---|---|
| `--device-read-bps` / `--device-write-bps` | 每设备字节/秒限制 | 只对 direct I/O 有效 |
| `--device-read-iops` / `--device-write-iops` | 每设备 IOPS 限制 | 同上 |
| `--blkio-weight` | 相对权重（100–1000） | 竞争时才生效 |

**注意**：cgroups v1 的 blkio 限流**只对 direct I/O 有效**，buffered I/O
（经 page cache）不受限。cgroups v2 的 `io.max` 覆盖更好。

### 2.5 磁盘空间

见 §1.3「文件系统：存储隔离与配额」。关键点：

- XFS project quota 提供**字节 + inode 双限**的硬配额
- `overlay2` 存储驱动的 `--storage-opt size=<limit>` 也能限容器可写层，
  但只适用于特定后端文件系统
- 容器可写层、日志、快照**不在用户配额里**，需要另行规划

### 2.6 网络带宽

Docker **没有原生带宽限制**。方案：

- 宿主侧对容器的 veth 接口设 TC（traffic control）规则
- CNI 插件（Cilium / Calico）的带宽策略
- 对于单机 Docker 部署，TC 是唯一可行手段

### 2.7 资源限制速查

| 资源 | 硬限手段 | 默认行为 | 超限后果 |
|---|---|---|---|
| CPU | `--cpus`（CFS quota） | 无限 | Throttle（变慢，不杀） |
| 内存 | `--memory` | 无限 | OOM kill |
| PID | `--pids-limit` | 无限 | fork 返回 EAGAIN |
| 磁盘空间 | XFS project quota | 无限 | `ENOSPC` |
| 磁盘 I/O | blkio / io.max | 无限 | Throttle |
| 网络带宽 | TC 规则 | 无限 | Throttle / 丢包 |

---

## 三、适用场景：什么情况下用 Docker 隔离

### 3.1 信任等级分档

业界共识是按**工作负载的信任等级**选运行时，不是按「Docker 够不够安全」一刀切：

| 信任等级 | 运行时选择 | 典型场景 |
|---|---|---|
| **可信** | 标准 Docker（runc） | 组织内部微服务、CI/CD |
| **半可信** | 加固后的 Docker + 监控 | 托管开发环境、agent 工作区、受管的 SaaS |
| **不可信** | gVisor 或 microVM | 公开代码沙箱、FaaS（AWS Lambda / Fly.io） |
| **敌意** | 独立 VM 或裸金属 | 恶意软件分析、安全研究 |

### 3.2 Docker 隔离适合的场景

**适合**（= 信任等级为「可信」或「半可信」）：

- **托管开发环境 / AI agent 工作区**——代码执行是产品本职，但平台控制镜像和部署。
  纵深防御（网络分段 + 应用层认证 + 资源限制 + 容器内沙箱）可以把风险降到可接受水平。
- **内部工具与服务**——代码由组织编写，容器主要用来打包和资源管理。
- **SaaS 后端隔离**——每租户一个容器，平台完全控制运行内容。
- **开发 / 测试环境**——便利性大于完美隔离，且开发机通常不暴露在公网。

**不适合**（= 信任等级为「不可信」或「敌意」）：

- **公开的代码执行沙箱**——用户能提交任意代码运行（在线 playground、CTF）。
  内核攻击面太大，需要 gVisor 或 microVM。
- **合规要求硬件隔离的行业**——PCI DSS 持卡人环境、FedRAMP 多租户、
  部分 HIPAA 场景通常要求 VM 级隔离。
- **允许安装不可信第三方插件 / 扩展的平台**——租户能带自己的代码进来，
  且平台无法审计。
- **恶意软件分析与安全研究**——对手明确在尝试逃逸。

### 3.3 本平台的定位

dsh 的 agent 会 spawn 进程、跑 shell、写文件——**这是它的本职工作**。
但平台控制镜像（用户不自带镜像）、控制网络（每实例独立网段）、控制凭据（零跨实例共享），
所以信任等级是**「半可信」**。

在这个档位下，Docker 加固后的隔离是可接受的——前提是**每一层都落地且验证过**。
当下面任一条成立时需要重审运行时选择（D2）：

- 客户合规要求内核级隔离
- 允许安装不可信的第三方插件
- 规模上去了需要更高密度
- 出现了影响当前加固措施的新攻击向量

---

## 四、本平台三层速查

| 层 | 已生效 | 可选 | 未做 | 挡不住 |
|---|---|---|---|---|
| **安全隔离** | 每实例一网络；回环发布；独立存储 + Linux 硬配额；零跨实例凭据；MaskedPaths（默认 + DMI）；禁 `--privileged` | 宿主 INPUT 规则（挡容器到宿主非回环服务）；lxcfs 三文件 | CapDrop；no-new-privileges；seccomp 收紧；ReadonlyPaths 显式设置；userns-remap | 共享内核（逃逸即宿主失陷）；egress 过滤；`sysinfo(2)` 直读 |
| **资源隔离** | pids / mem / cpu 上限；磁盘字节 + inode 硬配额（Linux） | — | blkio / 网络带宽限制 | 开发机无磁盘硬配额 |
| **信息泄漏** | DMI 遮罩 | lxcfs（meminfo / uptime / swaps） | — | `loadavg` / `cpuinfo` / `btime` / `diskstats` / `slabinfo`；`sysinfo(2)` 直读 |

（逐项现状与出处以 [ARCHITECTURE](ARCHITECTURE.md) §四/§五、
[SECURITY-HARDENING](SECURITY-HARDENING.md)、[RUNTIME-CONTAINER-EVAL](RUNTIME-CONTAINER-EVAL.md)
为准。）

---

## 外部来源

- Docker 官方文档：[Docker security](https://docs.docker.com/engine/security/)——capabilities / seccomp / 运行时资源限制、masked 与 readonly paths
- Docker 官方文档：[Runtime options with Memory, CPUs, and GPUs](https://docs.docker.com/engine/containers/resource_constraints/)
- systemshardening.com，《Linux /proc and /sys hardening》
- oneuptime，《procMount type isolation》：Kubernetes restricted PSA 与 `procMount: Default`
- HackTricks，Container security — masked paths
- lxcfs 官方仓库 README
- Alibaba Cloud 技术博客，《Using lxcfs to improve container resource visibility》
- openEuler 文档，《proc 文件系统隔离（lxcfs）》
- Linux Containers 论坛，《busybox free inside a container》：`sysinfo(2)` 绕过
- Northflank / Edera，容器运行时隔离对比（普通容器 / gVisor / microVM 的信任分档）
- Google gVisor 文档，[What does gVisor not do?](https://gvisor.dev/docs/architecture_guide/security/)
- Kata Containers 项目，[kata-containers](https://github.com/kata-containers/kata-containers)
