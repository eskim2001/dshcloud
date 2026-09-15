# 待验证 / 待定

> 这些不是「难点」，是**信息缺口**。验完就把结论搬进 [DECISIONS.md](DECISIONS.md)，条目从这里删掉。
> 已解决的条目压缩在 §三（存档），保留证据、不保留过程。

## 一、未决（影响架构）

| # | 问题 | 怎么验 | 不验会怎样 |
|---|---|---|---|
| 13 | **门改 host-only cookie + 控制台签发短时 token**（解同注册域的 Set-Cookie 投毒 / 浏览器状态继承） | 设计 token 交换链路 + 真实浏览器双租户复现 | 同注册域下浏览器状态仍是跨租户通道（D24 代价⑤） |

### #13

控制台和实例共享注册域，所以实例响应能给浏览器种一枚 `Domain=<BASE_DOMAIN>` 的 cookie；
Traefik 的 `headers` 中间件只能整条删 `Set-Cookie`，做不到按 `Domain` 过滤（会连 dsh 自己的会话
cookie 一起删）。结构解是**把门改成 host-only cookie**：forward-auth 不再读浏览器直发的会话
cookie，而是由控制台签一枚**短时、单实例、绑定 owner** 的 token，经一次性交换落到实例子域。
它会动认证链路（会话、CSRF、WebSocket 握手都要重新过一遍），所以另开一轮，不夹在 D24 里做。

## 二、已知但故意推迟的

| 项 | 推迟到 |
|---|---|
| **通配证书**（DNS-01，原 #6：DNS provider 选型） | 实例数逼近 ACME 每周约 50 张的上限、或宿主 `80` 端口不可达时。默认走**逐主机 HTTP-01**，不需要 DNS provider，也不再阻塞「能装」（D34） |
| 可观测性（Prometheus / Loki / Grafana） | M2 |
| 备份 / 镜像扫描 / 对象存储 | M2 |
| 插件信任边界（恶意插件） | M2 |
| 出网控制（agent 任意出网） | M2 |

## 三、已解决（存档）

### #8 部署环境：容器 → microVM → **容器**（已回退）

运行时一度从 Docker 换成 microVM（那条 ADR 已删除），后来**又改回 Docker** —— 理由与代价见
[ARCHITECTURE §四](ARCHITECTURE.md)。现状：实例就是 **Docker 容器**（镜像由 `docker/instance-image` 构建），
`/data` 在池化形态下是**宿主存储池上带项目配额的目录**（D18/D35），桥端口**发布到宿主回环**。

> **2026-09-15 更正**：这句原写作「`/data` 是 **Docker 命名卷**」。池化形态下它不成立 ——
> 那是池目录 + XFS project quota；命名卷只是**开发机没有池子时**的回退形态
> （`DockerDriver.createStorage`，那种情况没有硬限）。

当时立的规矩是「**换运行时必须重验隔离结论，不能继承**」。这条**已经重验**了（见 #4）：

- **Linux 宿主上成立** —— 但只覆盖了"够不到宿主回环"这一格：容器够不到宿主回环、也够不到别的容器
  发布的回环端口。**"实例之间"那一格当时没测**，2026-09-15 补上就翻了 —— 默认 bridge 上邻居的
  `:8080` 直接有响应（见 #4）→ 现在靠**每实例一个网络**（`dsh-net-<slug>`，D37）；
- **Docker Desktop 上不成立** —— `host.docker.internal` 代理到宿主 localhost，宿主回环上的服务全开。

代价与残余风险（egress 无解、卷**没有硬容量**等）写在 [ARCHITECTURE §四](ARCHITECTURE.md)。

### #3 / #12 WebSocket 握手与跨源写操作

真实 Traefik 集成测试验证了未登录握手返回 302、非所有者返回 403、所有者返回 101，且平台 cookie 不传给实例后端。控制面写请求现在要求精确受信 `Origin`，实例子域、缺失来源和 `null` 来源均被拒绝。回归命令及迁移注意事项见[安全修复与迁移](SECURITY-HARDENING.md)。这不代表已验证所有浏览器行为或长连接建立后的实时撤权。

### #1 / #2 客户端 `isLoopback` 与 `--trusted-host` → **D15**

`--trusted-host` 只放宽服务端 `/api` 的 Host/Origin 围栏（它自己的 help 写明 "not an auth layer"），**解不开客户端**门：`isLoopback` 由浏览器里的 `location.hostname` 算，代理改不了。远程域名下它的后果是**终态**而非降级——设置面 `persistence = 'memory'`、`settings-mirror` 永不发起读取，模型提供方页面直接报 `settings are unavailable in this browser`，**连 API key 都填不了**。

社区做法是「服务端 + 客户端两处一起解锁」（改 bundle 或打补丁）。我们的做法见 [D15](DECISIONS.md)：走官方 `--patch` 扩展点注入 `__DSH_TRANSPORT__ = { ownsHost: true }`，**不改官方文件**。服务端侧实测只需 `--trusted-host`（2026-09-09，0.1.2-rc.1：`settings/describe`、`settings/mutate`、`credentials/set → describe → unset` 全部到达 handler 并成功）。

### #4 宿主回环 / 别的容器的发布端口，容器够得到吗 → **已实测（2026-09-12、2026-09-15）**

**Linux 宿主：够不到。** 实测（Debian 12 / Docker 29，从容器内发起）：宿主回环上的监听、以及
**别的容器发布到 `127.0.0.1` 的端口**，经 `host.docker.internal` 和网桥网关 **全部 `ECONNREFUSED`**。

⚠️ **但这条测的是"发布到回环的端口"，不是"邻居容器自己那个容器 IP"** —— 结论一度被读成
"跨实例不可达"。2026-09-15 补测最后一格，结果相反：默认 bridge 上同网段的两个实例，在容器里
ARP 扫 `172.17.0.0/16` 就能看到邻居 `172.17.0.2:8080` / `172.17.0.3:8080` **有响应**
（Docker 28.0.1；默认 bridge 一份网段发给所有容器是 Docker 的通用行为，真 Linux 上按
[PLAN](../PLAN.md) 验收表复核）。所以"只发布到宿主回环"挡的是**局域网与宿主**，
实例之间得靠**每实例一个网络**（`dsh-net-<slug>`）—— 2026-09-15 起接进来，见 [D37](DECISIONS.md)。

**Docker Desktop（macOS / Windows）：够得到。** 它的 `host.docker.internal` 是**代理到宿主 localhost** 的
魔法别名，于是宿主回环上的**任何**监听（实例端口、控制面 API、Postgres）对所有容器开放。这是**开发机特有**，
不是 Docker 的通例。

→ 结论：生产 Linux 上「每实例一个网络 + 桥端口只发布到宿主回环」两条合起来守住实例之间的边界；
开发机上要接受"控制面 / DB 对实例容器可见"这个风险（或让它们改听 unix socket），
而且**实例之间在开发机上仍有一条路**（`host.docker.internal` 够得到别的实例发布的桥端口）。
**跨实例那条最后仍有门兜底**（每实例 token），但拦住它的是门，不是网络。

### #5 workspace 根 → **铁律 1**

`dsh` 的 workspace 由 `HOME` / `WORKDIR` 决定。实例镜像里 `HOME=/data/home`、`WORKDIR=/data/home/workspace`，都在 `/data` 卷下，容器重建不丢。

### #7 磁盘配额 → **D18**

Linux 上做磁盘配额只有四条路：文件系统级三条 + 块设备级一条。编排器（Docker / Nomad / k3s）都只是**转手**，换编排器不解决这个问题（K8s 的 `ephemeral-storage` 限额本身就是用 XFS/ext4 project quota 实现的）。

| 路径 | 硬限 | 开发机可测 | 生产要求 |
|---|---|---|---|
| XFS project quota | ✓ | ✗ | 部署前定 XFS + `pquota` |
| ext4 project quota | ✓（可被 `CAP_SYS_RESOURCE` 绕过） | ✗ | ext4 + `prjquota` |
| btrfs qgroup / squota | ✓ | ✓ 实测通过 | 一块 btrfs 盘 + 每实例一个子卷；内核 ≥ 6.7 |
| 独立块设备（loop / LVM / 云盘） | ✓ | ✓ | 每实例一块盘 / 一个 LV，密度高时运维成本爆 |

开发机实测（macOS + Docker Desktop，LinuxKit 6.10.14）：XFS + `prjquota` → `quota support not available in this kernel`；ext4 + `prjquota` → 内核没编 `CONFIG_QUOTA`；btrfs squota → ✓（`mkfs.btrfs -O squota` → `qgroup limit 10M` → dd 停在 9.89 MiB）。即 **Docker Desktop 内核没编 quota 子系统**。

被排除的思路：Docker `--storage-opt size=`（只限容器可写层，管不到 volume，且本机被静默忽略）；`--ulimit fsize=`（只限单文件）；JuiceFS / CephFS 目录配额（最终一致，要引元数据服务）；软配额（会超，是计费手段不是隔离）。

**选定的形态**：每实例一个宿主稀疏文件 + loop + ext4，**文件系统大小即配额**，宿主级操作走特权助手容器。只依赖宿主自带工具，开发机端到端可验。见 [D18](DECISIONS.md)。

✅ **D18 已实现**（2026-09-12，`4149d9f`）：`apps/server/src/instance/pool.ts` 里有池子判定
（XFS + `pquota`；探针会**真设一次限额再读回来**校验 Hard 列的值，不是只看"是不是 XFS"）、
每实例一个 project quota（字节 + inode 双限，**已释放的 ID 不复用**）、宿主不是 XFS 时建**一块**
loopback XFS 镜像、设不上就**拒绝启动**；驱动按 `enforced` 决定 bind 池子目录还是退回命名卷
（`runtime/docker/driver.ts` 的 `Binds`）。

（本节早先写过「D18 的实现目前不存在」—— 那描述的是切 microVM 那轮删掉 `host-storage.ts`、
改回 Docker 还没补上时的状态，已经过期。）

**后续实测（2026-09-12）**，给上面那张表补一格、并收窄一条：

- **Linux 宿主上 XFS project quota 成立且是硬限**（Debian 12 / 内核 6.1）：`mount -o pquota` + `bhard=10m` → 灌 50 MiB **只写进 10 MiB**。
- "开发机可测"那列：**XFS / ext4 都做不到** —— Docker Desktop 的 linuxkit 内核把配额裁了（`CONFIG_XFS_QUOTA` 未设、`QFMT_V1/V2` 未设，`mount -o pquota` / `-o usrquota` 一律 EINVAL）；**btrfs 可以**（表里那条 ✓ 复现无误）。

### #9 / #10 / #11 数据模型 / 实例标识 / runtime 抽象 → **已实现**

用户 ↔ 实例 ↔ 角色落在 `apps/server/src/db/schema.ts`；slug 到容器名 / 网络名 / 存储路径的映射由平台按白名单正则生成；runtime 抽象收口在 `packages/instance-spec`（换 K8s / microVM 只换这一层）。

### dsh 入口一次性 token → **D14**

`dsh web` 每次启动 `randomBytes` 生成入口 token，没有 flag / 配置能固定或关闭。做法：桥在**无 cookie 的 `GET /`** 上注入 token 再转发（从前是 `/__open` 这条精确路径），**token 不进浏览器 URL / 历史 / Referer**，用户直接输裸域名即可。见 [D14](DECISIONS.md)。

### 引导态寻址：静态跳转 vs 动态 router、与 ACME 共存 → **已实测（2026-09-13）**

为「不填域名也能装」（引导口复用 :80 上一条**动态**路由）先验了四条，真 Traefik **v3.5.6**、一次性容器：

| 验的 | 结果 |
|---|---|
| 静态 `entryPoints.web.http.redirections` + :80 上一条显式 router | **跳转赢**：一切 301，显式 router 完全不生效 |
| 改用动态 router 出跳转（`redirectScheme` + `service: noop@internal`） | 可用，正确 301；`noop@internal` 在 v3.5 认 |
| 动态 catch-all（或跳转 router）与 ACME HTTP-01 挑战共存 | **兼容**：`/.well-known/acme-challenge/<token>` 由 ACME provider 内部接管（日志 `Cannot retrieve the ACME challenge for …`），既不被跳转拦、也不落到 router |
| `/dynamic` 下三个文件，删其中一个 | 只摘掉它那条路由，其余路由不受影响 |

结论：**HTTP→HTTPS 跳转不能用静态的**——它在引导态会把 catch-all 一起拦掉，而静态配置又没法按状态变化
（改它就得重启 Traefik）。跳转改由控制面渲染成动态 router，于是「配好域名后立即生效、引导期没有跳转」
两件事都不用重启。落地见 [DECISIONS.md](DECISIONS.md) 里引导态装机那条。
