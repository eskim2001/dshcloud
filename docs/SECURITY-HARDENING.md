# 安全修复与迁移

## 生效前的操作

本次变更包含数据库迁移，不能只替换控制面代码。不要让新旧控制面同时运行。

1. 安排维护窗口，阻断外部实例访问并停止控制面，避免旧代码继续创建、删除实例或投影旧路由。
2. 备份平台 PostgreSQL 和实例数据文件系统。备份须保留实例 ID、所有者与文件的映射。
3. 在仓库根目录运行依赖安装和数据库迁移。迁移命令会读取控制面的环境文件，执行前必须确认目标数据库。

```bash
pnpm install
pnpm --filter @dsh-cloud/server db:migrate
```

4. 启动更新后的控制面。它会重新生成入口路由；确认 Traefik 已加载包含 `Cookie` 的 `authResponseHeaders` 后再开放访问。实例基础镜像不需要为此重建。
5. 此前可能被送进不可信实例的会话应视为潜在暴露，撤销旧会话并要求用户重新登录。仅更新代码不会使已泄漏的普通会话自动失效；已有冒充会话会被平台拒绝。

本说明不表示已对任何现有环境执行上述操作。新存储身份启用后，不可直接回退到按 slug 定位数据的旧控制面。

## 数据与配额

- [迁移 0005](../apps/server/drizzle/0005_instance_storage_identity.sql) 为已有实例设置 `storage_key = slug`，原有文件、挂载点和快照路径不变；新实例获得独立随机存储标识。
- 新数据文件位于 `<HOST_STORAGE_ROOT>/<storage_key>.img`，挂载点为 `<HOST_STORAGE_ROOT>/<storage_key>`，升级快照为同目录下的 `<storage_key>.img.prev`。
- 普通删除保留实例记录中的所有者、存储标识和删除时间，不再出现在活动实例列表，也不占活动实例数配额。彻底清除仍须确认 slug，并先删除对应数据再删除记录。
- 同名重建不会恢复旧内容。保留数据的恢复目前需要运营人员核验归属，不提供自动恢复接口。
- 修复前已删除数据库记录的孤立文件无法自动确定所有者。不要仅凭同名 slug 把它们挂给新实例；先通过备份等可信记录核验。
- 旧 named-volume 迁移脚本仅处理未删除且 `storage_key = slug` 的旧实例，不把旧同名卷复制给新身份的实例。
- 创建实例在 PostgreSQL 事务中锁定用户行，检查有效实例数量及用户配额后预留记录；Docker 操作在事务提交之后执行。

## 认证与入口

- 原生 `/api/auth/admin/*` HTTP 接口关闭；认证插件中的管理员角色不再拥有冒充、修改他人密码或邮箱等原生账号管理权限。平台自己的管理接口仍负责账号封禁、配额、版本、状态及日志。
- 所有控制面非 `GET`、`HEAD`、`OPTIONS` 请求必须携带受信 `Origin`。允许值为控制台自身来源（`CONSOLE_DOMAIN`）和 `EXTRA_TRUSTED_ORIGINS` 中的精确来源。缺失、`null`、实例子域或其他来源返回 403。脚本客户端也必须发送该请求头；它不替代会话认证。
- forward-auth 使用原始 cookie 完成认证，再返回过滤后的 `Cookie`，由可信 Traefik 替换后端请求头。过滤覆盖平台 cookie、安全前缀及分片，保留实例自身的 cookie；过滤不依赖实例内部 Caddy。
- 实例仍共享宿主内核。上述修复不是完整安全审计，也不承诺对宿主或 Docker 管理者加密。

## 域名拆分（D24）的迁移

这一轮**没有数据库迁移**，但有一件事不能省：重建每个实例容器。

1. 改 `apps/server/.env.local`：`BASE_DOMAIN` 从 `platform.lvh.me` 改成 `lvh.me`，新增
   `CONSOLE_DOMAIN=console.lvh.me`。缺 `CONSOLE_DOMAIN` 控制面起不来（env 校验是硬的）。
2. `docker restart dsh-ingress`：`platform.yml` 是单文件 bind mount，改了必须重启入口。
3. 重启控制面（env 变了）。
4. **重建每一个实例容器**（管理台「重建」或 `POST /api/instances/:id/restart`）：`DSH_TRUSTED_HOSTS`
   是建容器时写进环境的，旧容器还认 `*.platform.lvh.me` → 不重建就是「页面能开、API 全 403」。
   卷不受影响。

控制台地址从 `https://platform.lvh.me/` 变成 `https://console.lvh.me/`，旧书签失效一次。

**保留字只挡新建，不影响存量**：`RESERVED_SLUGS` 挂在创建输入上，库里已有的行只做形状校验。
所以存量实例的 slug 即使落进了新的保留字表（本地那个遗留的 `test` 就是），它照样能打开、启停、
删除——只是这个名字不能再被新建占用。保留字表因此可以随时扩充，不会追溯伤到已有租户。

## 已知代价：Set-Cookie 投毒（D24 未解）

控制台和实例共享同一个注册域，所以**实例响应能给浏览器种一枚 `Domain=<BASE_DOMAIN>` 的 cookie**。
利用前提是同一浏览器先后访问两个租户的实例：先访问 A 的实例被种上 cookie，再访问 B 的实例时
那枚 cookie 会被带上。Traefik 的 `headers` 中间件只能整条删 `Set-Cookie`（会连 dsh 自己的会话
cookie 一起删掉），做不到「只删带 `Domain=` 的」。结构解（门改成 host-only cookie + 控制台签发
短时 token）记在 [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)，会动认证链路，另开一轮。

## 跨实例网络隔离（D37）的迁移

这一轮**没有数据库迁移**，但存量实例要**重建一次**才落到自己的网络上。

此前所有实例接在 Docker 默认 `bridge` 上 —— 同一个 L2 广播域，实例之间能互相直连 `8080`
（实测：容器里 ARP 扫 `172.17.0.0/16`，邻居的 `:8080` 有响应）。现在每个实例建容器前先建自己的网络
`dsh-net-<slug>`，容器只接在它上面；删实例时网络一起删。

1. 升级控制面并重启（驱动代码变了）。
2. **重建每一个实例容器**（管理台重启，或 `POST /api/instances/:id/restart`）—— 不重建就不会重新接网络，
   默认 `bridge` 上那个容器照旧通着。卷不受影响。
3. 宿主上的 `docker0` 与历史容器仍留在默认 bridge 上，新容器不再接它。

想同时收掉「容器能访问宿主非回环端口」这一面（`ssh` 等）：`install.sh --harden-host` 会在宿主上写一条
INPUT 规则，**默认不写** —— 它改的是宿主的防火墙。它不影响入口、发布端口与实例出网，`uninstall` 会撤掉。

Docker 默认地址池能分的网络数有限（开发机 28.0.1 实测 12 个；Linux 真机 2026-09-15 实测池子是
172.17–172.31 共 **15 个 /16**，每建一个网络吃一整个 /16），而这里**一个实例一个网络** ——
实例数会被它卡住。撞上时控制台把 daemon 原文和改 `default-address-pools` 的方法一起报出来；
安装脚本**不自动改**宿主的 `daemon.json`（那要重启宿主 Docker）。

想提前扩：在 `daemon.json` 里加
`"default-address-pools": [{"base": "172.16.0.0/12", "size": 24}]`（4096 个 /24），再
`systemctl restart docker`。**2026-09-15 在真机验过**，两点要知道：① 存量网络不受影响，只有新建的
按新池分配；② 默认 `bridge` 会跟着重建，`docker0` 的地址会变（实例不在它上面，入口与出网不受影响）。

## 宿主指纹：把宿主的 /proc 数字挡在实例之外（可选）

实例与宿主**共享内核**，所以 `/proc` 里有一批**宿主全局**的数字：内存总量、开机时长、负载、
磁盘 IO、slab。工作区里读一眼就能指纹宿主（几核、多大内存、哪天开的机），也能当跨租户侧信道用
（推断邻居的负载、宿主的重启）。它不是数据泄漏，是形状泄漏。

**宿主侧的可选项，平台不自动装**：在宿主机上跑 `scripts/proc-hide.sh`（用法见脚本 `-h`）。

1. 宿主上跑那个脚本：装 lxcfs（FUSE 假文件系统）、起服务、自检并如实报告。
2. 重启控制面 —— 探测只在启动时做一次（宿主没装 lxcfs 时平台什么都不做，缺席是常态）。
3. 在控制台里**重建每个实例容器** —— 挂载是建容器时定死的，之前建的容器不会自己拿到。

只挂量过**真生效**的三个。lxcfs 6.0.4 一共提供八个假文件，2026-09-15 装上、2026-09-16 复量，
逐个在同一个容器里挂 / 不挂各读一次（宿主 8G / 4 核，容器 `--memory 2g --cpus 1`）：

| 文件 | 不挂（= 宿主值） | 挂上 lxcfs | 结论 |
|---|---|---|---|
| `meminfo` | `MemTotal: 8138036 kB` | `2097152 kB` = 该实例的内存上限 | **生效，挂** |
| `uptime` | `536551`（宿主开机秒数） | `0.09`（容器自己的运行时长） | **生效，挂** |
| `swaps` | `/dev/vda2 partition 2097148 780` | `none virtual 2097148 0` | **生效，挂**（设备名与已用量盖住，`Size` 不变） |
| `loadavg` | `0.50 0.52 0.36 1/480 13` | `0.50 0.52 0.36 1/481 …` | 不生效：三个负载值原样透传，只有进程数是容器的 |
| `stat` | `btime 1788955443` | `btime 1788955443` | 不生效 |
| `cpuinfo` | 4 核、宿主 CPU 型号 | 一模一样 | 不生效（按 cpuset 假，而平台配额走 `NanoCpus`） |
| `diskstats` | 12 行、宿主磁盘计数 | 12 行、同一块盘 | 不生效 |
| `slabinfo` | 213 行 | 213 行 | 不生效 |

逐文件的结论也写在 [apps/server/src/runtime/docker/lxcfs.ts](../apps/server/src/runtime/docker/lxcfs.ts)，
驱动只挂前三个。

**挡不住的**，别以为装了它就没了：`/proc/loadavg` 的三个负载值、`/proc/cpuinfo`（连宿主 CPU 型号
一起透传）、`/proc/stat` 的 `btime`（宿主开机时刻照旧可读）；`/proc/diskstats`、`/proc/slabinfo`
同样是透传 —— 宿主的磁盘设备名与 I/O 计数照旧读得到。

还有一条**绕开 lxcfs** 的：直接调 `sysinfo(2)` 的程序（`busybox` 的 `free`、一些语言的运行时就那么干）
根本不读 `/proc`。2026-09-16 实测：容器里挂着那三个文件时 `/proc/meminfo` 报 2G、`/proc/uptime` 报
0.09 秒，而**同一个容器**里 `sysinfo(2)` 照样返回宿主的 8138036 kB 与 536750 秒运行时。
所以这套的定位是**降低可读性**，不是边界 —— 边界仍是容器本身（见 [ARCHITECTURE](ARCHITECTURE.md) §四）。

宿主是不是虚拟机、机型是什么，走的是另一条路（`/sys/devices/virtual/dmi/id/*`），与 lxcfs 无关：
驱动现在一律用 `MaskedPaths` 遮掉它 —— **换 gVisor 也照漏**，所以这条遮罩与运行时选择无关。

代价与回退：

- lxcfs 停/重启会让**已经在跑的**容器里那几个文件失效：FUSE 连接断，读报
  `Transport endpoint is not connected`（2026-09-16 实测，重启 lxcfs 后容器里 `grep /proc/meminfo`
  就是这个错）。生产上别随意重启 lxcfs，真重启了就把受影响的实例重建一次。
- 回退：`scripts/proc-hide.sh --remove`（停用并禁止开机自启，**保留包**）；`--purge` 连包卸掉。
  **停掉之后要马上重启控制面** —— 它只在启动时探测一次；不重启的话，中间态里**新建**的实例容器会
  **直接起不来**：源路径已经不在了，Docker 会把它建成一个目录，而 `/proc/meminfo` 是文件
  （实测报 `not a directory`）。**已经在跑的**容器里那几个文件也已经断了（同上），重建实例才干净。

## 回归验证

```bash
pnpm typecheck
pnpm test
pnpm --filter @dsh-cloud/server test:security
```

普通测试不启动 Docker 集成环境。`test:security` 要求已运行 Docker，并已具备 `postgres:16-alpine` 与 `traefik:v3.5` 镜像；它只使用新建临时容器、临时数据库、随机回环端口和临时路由文件，结束后自动清理，不读取应用数据库配置。

覆盖：旧数据路径兼容、主机名归属（同一账号可复用已删除实例的 slug，其他账号被拒）、并发配额、真实认证插件拒绝账号接管、真实 Traefik 的 HTTP cookie 过滤及 WebSocket 握手授权。浏览器完整交互、长连接撤权和目标生产宿主的隔离验证仍需另行完成。