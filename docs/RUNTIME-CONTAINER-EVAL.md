# 容器模式评估：Docker + gVisor + XFS 配额

> 2026-09-11。评估「不需要 KVM 的容器方案」能否满足平台的目标、代价是什么。
> **落地情况**：这份评估的结论**已经被采纳** —— 运行时改回了 Docker（见 [ARCHITECTURE §四](ARCHITECTURE.md)）。
> 所以下面「尚未成为决策」那句话读作历史。
>
> ⚠️ **配额这一条没落地，而且只在 Linux 上成立**：本文推的 XFS project quota，2026-09-12 在真宿主上实测
> （Debian 12 / 内核 6.1 / Docker 29）：`mount -o pquota` + `limit -p bhard=10m` → 灌 50 MiB **只写进 10 MiB**，
> **硬限成立**。但 **Docker Desktop（macOS 开发机）的内核把配额整块裁了** —— `CONFIG_XFS_QUOTA` 未设、
> `CONFIG_QFMT_V1/V2` 未设，`mount -o pquota` / `-o usrquota` 一律 **EINVAL**（XFS 本身能挂）。
> 开发机上得走别的路：[OPEN-QUESTIONS #7](OPEN-QUESTIONS.md) 那四种形态里，**btrfs squota 实测可用**
> （`mkfs.btrfs -O squota` + `qgroup limit`）。而**当前实现里配额根本没做** —— 见 [D18](DECISIONS.md) 的落地状态。

## 背景

写这份评估时，实例运行时是 microVM（microsandbox）。隔离最强，但它硬性要求宿主有 KVM。

在一台普通 VPS 上实测（Debian 13、4 核、8G、ext4），这台机器自己就是别人的 KVM guest：

```
Hypervisor vendor:  KVM
vmx 标志:           没有          ← 宿主没开嵌套虚拟化
/dev/kvm:           不存在
modprobe kvm_intel: Operation not supported
```

microsandbox 装得上（`msb --version` 正常），但一建沙箱就崩：

```
msb_krun_vmm-0.1.32/src/linux/vstate.rs:453:
Error creating the Kvm object: Error(2)
```

`Error(2)` 是 ENOENT —— 打不开 `/dev/kvm`。这不是缺依赖或权限问题，是内核层面没有 KVM。

官方也没有本地绕法。维护者在 issue 里回答「硬件虚拟化不是可选的，需要 CPU 自带的 VT-x 或 AMD-V」；排障文档明确写着不提供软件模拟，对不支持的宿主给的替代方案是他们的云；还有一个未关闭的 issue 只是要求「装的时候检查一下 CPU 支不支持 KVM」——要的是报错清楚，不是降级路径。

所以问题是：**买不到能开 KVM 的机器时，有没有别的路？**

## 平台的目标

这些是我们自己写下的约束，评估要逐条对：

- **升级 dsh 不丢数据**。升级 = 换镜像，用户内容靠卷保留。这是最重要的一条。
- **一切用户内容落 `/data`**，包括 workspace；`WORKDIR` 必须在 `/data` 下，否则重建就丢工作区。
- **每实例磁盘硬限**。灌满就 ENOSPC，不是软配额。
- **每实例 CPU / 内存 / pids 限制**。
- **实例之间网络层互不可达**（实现形态见 [ARCHITECTURE §一](ARCHITECTURE.md)）。
- **实例里看不到宿主的真实内容**。
- **假设实例一定会逃逸、一定会沾满资源**。所有设计从一个被攻陷的实例出发。
- **兼容 CI 构建的 OCI 镜像**（多架构）。
- **速度**：启动要快，agent 的日常文件负载不能明显变慢。
- **一行安装**。让不读源码的人把平台装到自己的服务器上。

还有一条隐含的：装机的前置条件越少越好。现在的计划里写着「宿主支持 loop device 与 ext4，这是硬门槛」——那条门槛本身就是这次评估想推掉的东西。

## 方案

```
Docker 容器  +  gVisor（runsc 运行时）  +  XFS project quota（磁盘硬限）
```

三者都是成熟件，各自解决的问题不同。

**Docker** 提供网络命名空间、cgroup 限额和镜像生态。

**gVisor** 是 Google 写的用户态内核。应用的系统调用不直达宿主内核，而是进 gVisor 的 Sentry 进程处理。它有三种平台：`kvm`（用硬件虚拟化，反而不是我们要的）、`ptrace`、`systrap`。后两种都不需要 `/dev/kvm`，其中 `systrap` 自 2023 年中起是默认，官方文档对它的定位原话是「在虚拟机里运行、或者机器没有虚拟化支持时更好的选择」。装上 `runsc`、在 `/etc/docker/daemon.json` 里注册成 runtime，容器加 `--runtime=runsc` 就切过去了。

**XFS project quota** 是内核自带的能力，红帽企业版文档里有专章。它不是外挂的限流器：给一组 inode 打上同一个 project ID，文件系统在**分配块的路径上**同步更新这个 ID 的计数，超了直接返回 ENOSPC。所以它既是硬限（拦在文件系统的写路径里，容器里的进程无论有多少 capability 都改不了），又几乎没有额外开销（一次比较，不是遍历统计）。

对这类负载，它的定位正好填在普通容器和 microVM 之间：

| | 逃逸意味着什么 | 需要 KVM |
|---|---|---|
| 普通容器 | 直接落到宿主内核 | 不需要 |
| gVisor | 要先攻破 Sentry（用户态内核） | 不需要 |
| microVM | 要先破 hypervisor | 需要 |

## 逐项评估

### 升级不丢数据

能做到，而且和 microVM 方案是同一个道理：`/data` 是宿主上的一个目录，升级就是新建容器、重新挂载同一个目录。容器没了目录还在。这一条不依赖运行时。

### 用户内容落 `/data`

实例镜像本来就是这么设计的：`DSH_HOME=/data`，工作目录在 `/data` 下，npm/pnpm 的全局前缀也都指向 `/data`。换运行时不影响。

### 磁盘硬限

能做到，已实测。

XFS project quota 的用法是给每个实例的宿主目录打一个 project ID，再给这个 ID 设块和 inode 两种限额：

```bash
xfs_quota -x -c 'project -s -p /xfsvol/tenant1 1001' /xfsvol
xfs_quota -x -c 'limit -p bhard=100m 1001' /xfsvol
```

在一台机器的 loopback XFS 卷上设 100M 限额，然后在 gVisor 容器里往里灌 200MB：

```
104857600 bytes (100.0MB) copied     ← dd 停在 100MB，不是 200
实际写进: 101 MB
df -h /data  →  100.0M  100%         ← df 报的是配额，不是宿主盘
```

硬限成立，而且 `df` 报配额不报宿主盘 —— 这一条顺带满足了「实例里看不到宿主真实内容」里的容量部分。

代价有六条，都是部署和运维层面的：

宿主要用 XFS，且以 `pquota` 挂载，这是**部署前**就要定的。红帽系发行版默认就是 XFS，但 Debian、Ubuntu 和大多数买来的 VPS 默认是 ext4。ext4 宿主有替代方案：在它上面放一块大的 loopback XFS 镜像，配额在镜像内部做——上面那次实测用的就是这个形态。代价是多一层 loop，好处是不用重做宿主盘，而且整台机器只占一块 loop 设备。

字节配额之外必须同时设 inode 配额。只限字节不限文件数，一个容器可以用几百万个零字节文件把宿主的 inode 耗尽，整台机器的文件系统都会瘫痪。

设限额需要 `CAP_SYS_ADMIN`，这跟平台当时声明的「容器 CapDrop 全部丢弃」加固方向是冲突的，得想清楚这层权限给谁——合理的归属是控制面进程，不是实例容器。

缺权限这件事是隐形的：`xfs_quota report`（读）不需要权限，只有 `limit`（写）需要。所以缺权限要到第一次建实例才暴露。必须在启动时做检查并拒绝启动，否则就成了「看起来配了限额，实际没配」。

最后，重启后要对已有的实例目录重新施加配额（回填），否则限额会静默消失。

**落地状态（2026-09-12，已过期 —— 见文末订正）**：上面这套**还没实现**。当前是 Docker 命名卷 + 把容量记进卷 label ——
**没有硬限**。所以：

- 在 Linux 宿主上接上 project quota 之前，「每实例磁盘硬限」这条需求是**未满足**的；
- macOS 开发机上无解（见开头的 ⚠️），只能退到**软控制**（监控用量、超了告警/停机）——那是"发现后处理"，
  不是"灌不进去"，安全语义差很远；
- ⚠️ 别让 `diskMb` 看起来像生效了：现在它只是一个声明值（记在卷 label 上供展示）。这一点参考了同类项目
  的处理 —— 他们有 PR 专门把「macOS 上磁盘限额被静默忽略」从"什么都不说"改成"警告"。

### CPU / 内存 / pids

Docker 原生支持（`--cpus`、`--memory`、`--pids-limit`，走 cgroup v2）。这比 microVM 那条路更标准——microVM 是给整台 VM 分配，这里是大家熟悉的 cgroup 语义。

### 网络隔离

能做到，已实测。

**2026-09-15 起这套成了采用的形态**（[D37](DECISIONS.md)）：每个实例落在自己的网络 `dsh-net-<slug>` 上。
入选的理由和当时不同 —— 当时采用的是「桥端口只发布到宿主回环 + 入口经 `host.docker.internal` 转发」
（见 [ARCHITECTURE §一](ARCHITECTURE.md)），网络这半被放下了；后来实测默认 bridge 上同网段的实例能直连
邻居的 `:8080`（见 #4），网络这半才接回来。两半互不替代：分段管**实例之间**，只发布到回环管**局域网与宿主**。

实测两个容器分别挂在独立 bridge 上：

| 测什么 | 结果 |
|---|---|
| 容器 A 按 IP 访问容器 B | 不通 |
| 容器 A 按容器名解析 B | 不通 |
| 容器访问外网 | 通（实例需要） |
| **容器访问宿主网关 IP** | **通** |

最后一条值得展开。进一步测「宿主上绑不同地址的服务」：

| 宿主服务绑在 | 容器能否访问 |
|---|---|
| `127.0.0.1` | 不能（回环不跨命名空间） |
| `0.0.0.0` | **能** |

也就是说，容器能摸到宿主上任何绑非回环地址的服务。

平台现在的绑定策略正好符合这个约束：控制面和 Postgres 都绑 `127.0.0.1`，只有 Traefik 绑 `0.0.0.0`（它是入口，本来就对公网开放）。所以没有新增暴露面，但这条从「开发机上的经验」变成了「在真 Linux 上实测过的约束」。

顺带说明这条**没有**结掉什么：上面那张表测的是"容器按 IP 访问**另一个网络上**的容器"，
当时被读成了"跨实例不可达"。2026-09-15 在**同一个默认 bridge** 上测了同一件事，结论相反 ——
邻居容器的 `:8080` 直接有响应（见 [OPEN-QUESTIONS #4](OPEN-QUESTIONS.md)）。所以这一段证明的是
"**分开网络**就够不到"，而不是"平台当时已经是分开的"。

### 实例里看不到宿主的真实内容

只能部分满足，这是容器方案的短板。

容量那一半可以做到（`df` 报配额）。但「宿主的真实内容」做不到完全隐藏——内核是共享的，`/proc` 之类看到的是宿主内核的视图（虽然比普通容器多了 gVisor 的虚拟化），根文件系统也能看出宿主的一些信息。

### 假设一定会逃逸、一定会沾满资源

资源那两条**在 Linux 宿主上**能做到：磁盘是文件系统级的硬限（project quota），CPU 和内存是 cgroup 硬限。
⚠️ 但磁盘那条**还没实现**（见开头的 ⚠️ 与「磁盘硬限」一节的落地状态），macOS 上则做不到。

逃逸那条只做到一半。gVisor 把「逃逸直达宿主内核」变成「逃逸要先攻破 Sentry」，这比共享内核强得多，但它终究是**用软件模拟内核**，不是 CPU 提供的硬件边界。这一点是它和 microVM 之间唯一的、也是本质的差距。

### 兼容 OCI 镜像

能做到，没有额外代价。`runsc` 只是 Docker 的一个 runtime。

### 速度

启动明显更快：容器不起内核，是毫秒级；microVM 要建 VM、起内核，是秒级。密度和内存开销也是容器占优。

代价是 gVisor 的系统调用开销。实测（数字见「实测记录」）：网络为主的负载（`npm install`）慢约 45%，可以接受；但**大量小文件的本地 I/O 慢 5.5 倍**（32ms 对 176ms）。

后面这条是 dsh 的日常形态——`node_modules`、git、编译都是 syscall 密集。绝对值不大，但会随工作量累积，表现为「agent 干活比裸容器迟钝一些」。够不够用，取决于接受度，不是能不能跑。

### 一行安装

这是容器方案最大的价值，而且门槛比现在低。

microVM 要求宿主有 KVM，云上还得挑支持嵌套虚拟化的机型（AWS 只有裸机实例可以，多数 VPS 根本不开），等于把「装机」变成了「先买对机器」。容器方案只要求有 Docker，任何 VPS 都行。

宿主盘要 XFS 这条门槛也能绕（loopback XFS），比「买一台能开 KVM 的机器」便宜得多。

## 实测记录

以下全部在一台普通 VPS（Debian 13、4 核、8G、ext4、**无 KVM**）上完成。

| 测什么 | 结果 |
|---|---|
| 装 Docker 29.8.0 + runsc release-20260907.0 | 成功 |
| 基础容器（假内核 `4.19.0-gvisor`） | 正常 |
| `npm install express`（纯 JS） | 正常 |
| `node-pty` 加 pty 系统调用实际 spawn shell | 正常 |
| `node-gyp` 从源码编译，编出来的 pty 能用 | 正常 |
| 我们的实例镜像完整跑起来（dsh + caddy + `/data`） | 正常，单台稳定运行 10 小时 |
| 三台实例容器同时跑 | 全部正常 |
| 跨实例网络隔离（两个独立 bridge） | 互不可达 |
| 容器访问宿主（绑回环 vs 绑 0.0.0.0） | 回环不可达、0.0.0.0 可达 |
| 上游那个硬链接 bug 的复现 | 不存在 |
| XFS 字节配额（限 100M、灌 200M） | 只写进 100M，`df` 报配额 |
| XFS inode 配额（限 1000 个文件） | 第 1000 个失败 |
| 配额跨卸载重挂 | 存活 |
| 把 `cap_sys_admin+ep` 设在 `xfs_quota` 二进制上 | 非 root 也能设限额 |

关于最后一条：非 root 直接跑是 `cannot set limits: Operation not permitted`；给那个二进制 `setcap` 之后就成功了。不过这条路等于给**任何能执行 `xfs_quota` 的人** `CAP_SYS_ADMIN`，是个提权面。更稳妥的做法是只给控制面进程这个能力（systemd 的 `AmbientCapabilities`）。

### 运行 dsh 的进程沙箱

这条单独说，因为它是「dsh 到底能不能干活」的前提。

dsh 的沙箱候选链是 `bwrap → Landlock → 全部失败就拒绝执行任何命令` —— 这句在**镜像里那个包**里逐条对过（`@deepseek-ai/dsh-sandbox-local` 的 `PLATFORM_CHAINS`：Linux 是 `["bwrap", "landlock"]`；逐档**功能探测**，全灭抛 `SandboxUnavailableError`，它自己的注释写的是 "the command never runs"）。它的 bwrap 参数是：

```
--ro-bind / /  --dev /dev  --unshare-pid  --proc /proc  --die-with-parent
（workspace-write 模式再加 --tmpfs /tmp 和 --bind <workspace> <workspace>）
```

**2026-09-16 同一台真机（Debian 13、dockerd 29.8.0）、同一个实例镜像、两个运行时各测一遍**：

| | bwrap | Landlock | 链的结论 |
|---|---|---|---|
| 默认 runtime（runc） | 不可用。三组参数都停在 `Creating new namespace failed: Operation not permitted`（`unshare -U` 同样 EPERM） | 可用（ABI **6**） | 走得通，靠 Landlock 那一档 |
| gVisor（runsc） | 不可用。同样的报错；只留 `--ro-bind` 时是 `Failed to make / slave: Operation not permitted`（这里 `unshare -U` 是通的，bwrap 照样起不来） | 不可用（gVisor 没实现，errno 38 = ENOSYS） | **两档全灭 → 拒绝执行任何命令** |

也就是说 gVisor 挡住的不是性能，是**这一层**：它接不了 dsh 的进程沙箱，装上去实例里的命令一条都跑不了。
上一版这张表里 gVisor 那格写的是「bwrap 可用」，是错的，见文末「订正（2026-09-16）」。

### 性能

同一台机器、同一镜像：

| 负载 | runc | gVisor | 倍数 |
|---|---|---|---|
| 冷启动 | 426 ms | 430 ms | 1.0 |
| `npm install express`（含网络，三次） | 2146 / 2246 / 2324 ms | 3191 / 3272 / 3413 ms | 约 1.45 |
| 写 2000 个小文件 | 172 ms | 189 ms | 1.1 |
| 本地解包约 850 个小文件 | 32 ms | 176 ms | 5.5 |

前三行是可接受的量级。最后一行值得注意：gVisor 的系统调用开销在「大量小文件的本地 I/O」上被放大到 5.5 倍。绝对值不大（亚秒），但这是 dsh 的日常形态（`node_modules`、git、编译），会随工作量累积。

2026-09-16 复测过一次（同一台机器，但上面已经有一套在跑的部署、四个实例在线，所以**绝对值不能和上表比，只看倍数**）：`npm install` 冷/热各一次，runc 4090 / 1659 ms、gVisor 7302 / 4049 ms —— 1.8 / 2.4 倍；从 `docker run` 到入口 HTTP 答话 12.9 s 对 20.5 s（1.6 倍，这段里 dsh 自己的启动占大头，两个运行时都要等它）。量级和上表一致：够用，但每一档都比 runc 慢一截。

## 还没验的

- **真跑一轮 dsh 对话**。沙箱链那一层验过了（见上），但端到端没跑——需要一个模型 API key。
- **多租户下的长期稳定性**。三台容器只跑了一会儿，单台跑了 10 小时。
- **配额回填的工程实现**。机制验过（配额本身跨重挂存活），但「重启后对已有目录重新施加」的代码还没写。

## 代价与判断

相比 microVM，这条路赚到的是：不需要 KVM（任何 VPS 能装）、启动快一个量级、密度高、内存开销小、CPU 和内存配额语义更标准、只需要一套代码而不是两个运行时驱动、生态成熟。

付出的是：隔离降一档（共享内核到用户态内核，不是硬件边界）、宿主的真实内容藏不住、I/O 密集可能慢 10–30%（未量）、宿主盘要 XFS（有解）、配额那套运维链条长（cap、inode 配额、回填、启动检查），以及 gVisor 系统调用覆盖面的未知边界。

我的判断是这条路的定位应该是 **M1.5 的默认路线，而不是 microVM 的替代品**。

两者不是竞争关系，是两个信任档位。业界的做法是按信任等级分——可信负载用普通容器，中等信任用 gVisor，不可信用 microVM——而不是按部署方便程度分。

对我们具体来说：如果形态是**自托管、单租户**（一个人跑自己的 agent），隔离的对象是「用户和他自己」，gVisor 这一档绰绰有余，共享内核在这个威胁模型下不是问题。如果形态是**多租户托管**（用户之间互不可信），那就该用 microVM——共享内核，哪怕是 gVisor 的用户态内核，也不该承担「租户互不可信」。

这也正是「两种部署方式」这个想法成立的理由，只是分界不是方便程度，是信任等级。

## 证据说明

这篇报告里的结论分三个可信度层级，看的时候请注意区分。

**一手实测**（上面那张表）最可信：同一台机器、同一个镜像、命令可复现。

**官方文档**（XFS project quota 是内核机制、块和 inode 两种配额、gVisor 的 systrap 不需要硬件虚拟化、microsandbox 要求 KVM）可信，这些是产品文档里的事实性描述。

**第三方项目**只是线索。评估过程中参考过一个多租户容器平台（`manifest-network/fred`）的部署和运维文档，它里面有价值的工程细节是：inode 洪水这条攻击面、以及启动时 fail-fast 而不是静默不限额。

但要说明：那个项目是零 star、零 fork 的，它的「我们在生产跑」属于自称，无法独立核实。上面的说法原理上成立、细节具体，但**都没验证过**，落地前要自己测。

需要更正两处。一是本文早期版本说那个项目「生产验证过 XFS project quota」，那是过誉——准确说法是 XFS project quota 是红帽和内核官方的一等特性，配额硬限我在 VPS 上亲手验过，那个项目只是一个低热度的参考实现。二是它说「`setcap` 不够，capability 不跨 execve 传播」，实测**把 cap 设在 `xfs_quota` 二进制上就有效**——它的说法针对的是「设在父进程上、指望传给子进程」那种，两种情况要分开。

另外「gVisor 有 10–30% 系统调用开销」这条来自厂商博客，实测下来网络负载约 45%、小文件本地 I/O 5.5 倍（见「实测记录」）。

## 下一步

如果要推进，按这个顺序：

1. 真跑一轮 dsh 对话。沙箱链和性能都验过了，但端到端没跑——需要一个模型 API key。这是「能不能用」的分水岭。
2. 写配额回填：重启后对已有的实例目录重新施加配额，加上启动时的 fail-fast 检查（缺 `CAP_SYS_ADMIN` 就拒绝启动，别静默不限额）。
3. 定 `CAP_SYS_ADMIN` 的归属。
4. 写 Docker 驱动。运行时接口有 18 个方法要实现，渲染器可以从切到 microVM 之前的 git 历史里捞。
5. 更新计划里 M1.5 的部署前置条件——现在写的「宿主支持 loop device 与 ext4，这是硬门槛」要改成 XFS 或者 loopback XFS。

## 外部来源

- Red Hat Enterprise Linux 8，Limiting storage space usage on XFS with quotas
- gVisor 官方文档，Platforms（systrap / ptrace / kvm）
- microsandbox 官方排障文档（Linux）
- Northflank，MicroVM vs gVisor
- safeguard.sh，gVisor vs Firecracker in 2026
- github.com/manifest-network/fred（低热度参考实现，见上）

## 订正（2026-09-13）

**「容器 CapDrop 全部丢弃」不是现状。** 实例的 `HostConfig` 里没有 `CapDrop`、没有 `SecurityOpt`
（`no-new-privileges`）、也没有 `MaskedPaths` 覆盖 —— 这三项随切 microVM 那轮（`b5d3888` 删掉
`host-storage.ts` 与 `renderers/docker.ts`）一起丢了，改回 Docker 时没恢复。实测 2026-09-13 对一个
运行中的实例 `docker inspect`：`CapDrop: None`、`CapAdd: None`、`SecurityOpt: None`、`MaskedPaths`
是 Docker 的**默认**表、`Config.User=0`（容器里 `tini` / `entrypoint.sh` / `caddy` 全是 root）。
**实例加固的现状以 [ARCHITECTURE §五](ARCHITECTURE.md) 为准**（那张表是对的）。

**「磁盘硬限还没实现」也已过期**：`apps/server/src/instance/pool.ts` 已经落地 —— 池子探针、
`pquota`、每实例一个 project quota（字节 + inode 双限）、设不上就**拒绝启动**，见 D18。

**一条实测补充**：同一台机器上，实例容器里跑
`bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true`
返回 `Creating new namespace failed: Operation not permitted`（退出码 1）。也就是说 D28 装的
bubblewrap 沙箱在这套配置下**用不了**，D30 想修的那个问题重新出现了 —— 但这条只在
Docker Desktop 上测过，原生 Linux 待验。

## 订正（2026-09-16）

**「gVisor 下 bwrap 可用」是错的，而那一格正是「gVisor 能不能用」的全部关键。** 重测见「运行 dsh 的
进程沙箱」那张表：runsc 下 bwrap 与 Landlock **两档全灭**，按包里的 fail-closed 语义，
dsh 在那个容器里**拒绝执行任何命令**（不是慢，是不能跑）。上一版的「可用。dsh 的真实参数逐项跑通」
和跟着它推出来的「不能加 `--unshare-net`」一并作废 —— bwrap 在两个运行时下都走不到那个 netlink 调用。

**链本身这次是从包里读的，不是从文档抄的。** `@deepseek-ai/dsh-sandbox-local`（实例镜像里）：
Linux 链 `["bwrap", "landlock"]`，逐档功能探测，全灭抛 `SandboxUnavailableError`，
注释原文 "the command never runs"。「原生 Linux 待验」这条也了结了：**2026-09-16 在真机上验过**，
runc 下走 Landlock 那一档（ABI 6），实例里的命令照常能跑。

**MaskedPaths 现在设上了，但不是 D30 那个设法。** 驱动里设的是
**Docker 默认那份 + `/proc/interrupts` + `/sys/devices/virtual/dmi`** —— 目的是多遮一条 DMI
（宿主是不是虚拟机、机型），**不是** D30 的「去掉 `/proc` 下的条目让 bwrap 建得起 proc」；
`ReadonlyPaths` 仍未设。（默认那份表在两处 daemon 上就对不齐：开发机 11 条、真机 dockerd 29.8.0
是 12 条，差一个 `/proc/interrupts` —— 所以它是**照抄一份写死的**，不依赖 daemon 版本。）

**D30 的根因（masked/readonly 列表挡着 bwrap 建 proc）在今天的机器上不成立。** 重测里三组参数都停在
**建命名空间**（`Creating new namespace failed` / `Failed to make / slave`），没有一个走到挂 proc。
而且开发机（Docker Desktop，linuxkit 6.10.14）今天**两档全灭**：`CONFIG_SECURITY_LANDLOCK is not set`
（errno 38），bwrap 也起不来 —— root、uid 1000、uid 1000 + `--cap-drop=ALL` 三种都一样；
`--privileged` 下可以，只 `--unshare-user` 也可以。所以那台机器上的 dsh 只有
**不经沙箱的档位**能跑命令（探测层的事实；真会话里没跑过命令，没验）。
