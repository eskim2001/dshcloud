# 决策记录（ADR）

> 每条：**决策 / 理由 / 备选 / 何时重审**。改了这里要同步 [ARCHITECTURE.md](ARCHITECTURE.md)。

## D1 · 每实例一个容器，不是子进程

- **决策**：一实例一容器，独立数据卷；网络层靠**桥端口只发布到宿主回环**。
- **理由**：子进程 + setuid/iptables 是软隔离（社区项目 [dsh-server-login](https://github.com/pointer-a/dsh-server-login) 模式 A 的做法），跨实例边界不硬。容器能给出网络、文件、凭据三条硬边界。
- **备选**：同机子进程（否）；每实例一 VM（M4 再说）。
- **重审**：客户要求内核级隔离时 → D2。
- **2026-09-15 更新**：这句原来还跟着"（不是"独立网络"—— 见 §四）"，那是错的：实例**需要**自己的网络，
  D37 已经落地（`dsh-net-<slug>`）。发布端口仍然只到宿主回环，两条一起才是这道边界 ——
  「只发布到回环」挡的是局域网与宿主，挡不住默认 bridge 上同网段的邻居。

## D2 · MVP 用 Docker，不上 microVM

- **决策**：runtime 用 Docker；`instance-spec` 的 renderer 保持可插拔。
- **理由**：跨实例的威胁已由「每实例一个 Docker 网络（D37）+ 桥端口只发布到宿主回环 + 每实例门 token」堵住；microVM 的三笔代价（密度、小文件 I/O、`/dev/kvm` 可用性）现在付，是为一个还没有客户的问题付账。dsh 的 `npm install` / 编译负载正好打中 microVM 的 virtiofs 弱项。
- **备选**：Kata Containers / Firecracker（要 `/dev/kvm`，多数云主机不支持嵌套虚拟化）；gVisor（一行切换，但 pty / syscall 兼容性风险不对称）。
- **升级路径**：K8s + Kata（containerd runtimeClass），**不要**裸 Firecracker。
- **重审**：客户合规要求内核隔离 / 允许装不可信第三方插件 / 规模上去了要密度。
- **2026-09-15 更新**：上面那句原来写的是"已由「桥端口只发布到宿主回环 + 每实例门 token」堵住
  （Linux 上实测：容器够不到宿主回环）"—— 实测的那条和结论之间隔了一层：默认 bridge 上同网段的实例
  能**直连邻居的 `:8080`**（2026-09-15 实测，见 D37）。结论不变（仍不上 microVM），
  但跨实例这条边界得靠 D37 的网络分段。

## D4 · 子域，不是子路径

- **决策**：实例 dsh 在 `<slug>.app.example.com`。
- **理由**：dsh 的 SPA 用绝对路径，子路径载不动静态资源（[dsh-server-login](https://github.com/pointer-a/dsh-server-login) 的 README 里验证过）。
- **代价**：通配证书 → DNS-01 challenge → **依赖 DNS provider**。**D34 已绕开这条**：默认不发通配证书，
  改成逐主机 HTTP-01，于是不需要 provider。

## D5 · MVP 不做 iframe 外壳

- **决策**：dsh 占满整页，不做外层包裹。
- **理由**：同源 iframe 无安全边界（agent 代码与外壳同源）；跨域 iframe 受 `SameSite=Lax` 限制，要子域同站才行。且外壳与访问控制正交，晚于闭环。
- **重审**：需要平台统一导航 / 统一文件视图时。

## D6 · 容器内转发器用 Caddy

- **决策**：容器内 Caddy 监听 `:8080` → 转发 `127.0.0.1:3080`，并校验 header 门。
- **理由**：dsh **拒绝绑 `0.0.0.0`**，容器内转发器是架构必需，不是可选。Caddy 一个 Caddyfile 就够，别在闭环没通之前优化基础设施。
- **备选**：自写 ~80 行 Go 代理（更轻、和 K8s 阶段 sidecar 同一二进制）；nginx（省内存、配置丑）；socat（最轻但纯 TCP，看不懂 header）。
- **重审**：上规模后换成自写 Go 代理（`dsh-bridge`）。

## D7 · 用官方 `--trusted-host`，不做 Host/Origin 伪装

- **决策**：优先用官方 flag，去掉 [dsh-deploy](https://github.com/mervyn-teo/dsh-deploy) 那种 sed 补丁和 [dsh-gateway](https://github.com/clarknu/dsh-gateway) 那种 loopback 伪装。
- **理由**：少一层 hack，升级 dsh 不会因补丁失效而静默坏掉。
- **风险**：要确认它的语义是"跳过 Host 检查"还是"赋予 loopback 特权"（后者 + 可伪造 Host = 提权）。见 OPEN-QUESTIONS #2。

## D8 · 访问控制三道门

- **决策**：① 实例各占一个自己的 Docker 网络（D37）+ 桥端口**只发布到宿主回环**；另有每实例门 token 兜底 ② Traefik 前置认证覆盖页面/API/WS，且做**授权**（登录者 == owner）③ 桥的 header 门（HMAC，每实例独立密钥）。
- **理由**：③ 是**纵深防御**，不是唯一拦阻——跨实例这道边界由 ① 给。**这句话原来写过头了**（2026-09-15 更正）：实测过的是"容器够不到宿主回环""够不到别的容器**发布到 `127.0.0.1`** 的端口"，而**邻居容器自己那个 IP 从来没测过** —— 一测就通（默认 bridge 上同网段，见 D37）。更要命的是这条路上 ③ 挡不住：桥上转发的是明文，同网段容器 ARP 欺骗就能把 token 抓走。但**Docker Desktop 上还有一层不是**：任何容器都能经它的魔法网关摸到宿主回环上发布的端口（包括**平台自己**的控制面 / Traefik / Postgres），那一层 ③ 就是最后一道 → ③ 必须保留，不能被当成"可省的冗余"。
- **注意：漏挂认证不会报错，只有洞**。门② 的认证是**逐条 router 显式挂上去**的（`buildTraefikConfig` 里的 `middlewares: [authName]`，见 `apps/server/src/instance/traefik.ts`），**不是"默认拒绝"**。漏挂的 router 在 Traefik 里是**合法配置**：照常路由、照常 200，没有告警、没有日志、没有测试会失败。
  - **对实例路由，门③ 把它兜成了 fail-closed**：gate token 只在认证 + 授权通过后才由 forward-auth 返回（`apps/server/src/http/forward-auth.ts`），经 `authResponseHeaders` 注入上游，容器内 Caddy 缺 header 即 403（`docker/instance-image/Caddyfile`）。所以漏挂表现为 **403，不是裸奔**。
  - **代价是这个错误变得不可见**：未认证用户拿到 403，和门② 正常工作时长得一模一样——你不会知道门② 其实没生效。门③ 只把它从"洞"变成了"沉默的配置错误"。
  - **真正会变成洞的场景**：① 新增路由指向**非实例后端**（平台 API、预览 / metrics / 新 sidecar）——那些后端没有 Caddy 门；② 为了让路由通而塞一个静态 header 中间件伪造 `X-Platform-Token`，架空门③；③ 客户端自带 `X-Platform-Token`（Traefik 默认**透传客户端 header**，只在 forward-auth 成功时覆盖）——token 泄露即失效；④ 门③ 的 token 由平台级 `PLATFORM_SECRET` 派生，该密钥泄露 → 所有实例的门一起倒。
  - **规则**：所有实例路由必须由 `buildTraefikConfig` 生成（唯一挂认证的地方）；新增任何非实例路由必须显式回答"谁来认证"；必须有自动化攻击测试（见 PLAN 验收表）——因为漏挂的唯一症状是"没有症状"。

## D9 · 只做平台层，不碰 dsh 内部

- **决策**：密钥存储、模型端点、凭据子系统是 dsh 自己的功能，平台不设计、不深挖。
- **理由**：这是刻意的产品边界——平台只负责「把 dsh 安全地租出去」，不替 dsh 做产品决策。
- **唯一保留的平台级判断**：隔离边界本身——不要把共享 key 塞进多租户容器。

## D10 · 插件只收标准 client 包

- **决策**：只接受标准 `@deepseek-ai/dsh-client-*` 包（`export inject` + `ctx.slots.inject`），**禁手写** `window.__ModuleLoader__.load`。
- **理由**：手写 loader 会**静默不渲染**（实测结论：手写 loader 静默不渲染）。"只收标准包"解决的是兼容性，**不是**安全性——插件安全是 M2 的独立课题。

## D11 · dsh 版本 pin 死，升级前跑回归

- **决策**：dsh 版本当**被验证的依赖**，不自动跟进。
- **理由**：dsh 还在 0.x，插件契约与 `/data` 布局可能变，而我们的"升级不丢"承诺正建立在其上。

## D12 · rootfs 可写，不做只读根

- **决策**：容器 rootfs **可写**；npm / pnpm 的全局前缀指向 `/data`，agent 装的东西随升级保留。只读 rootfs 降级为**可选加固**。
- **理由**：dsh 是**编码 agent**，装依赖 / 装 CLI 工具是日常。只读 rootfs 会把它捆住，而**跨实例安全并不依赖它**——边界是网络 / 文件 / 凭据（见 §四）。收益也小：攻击者已有代码执行，二进制从 `/data` 照样能跑，而 `/data` 本来就要持久化。
- **备选**：只读 rootfs + 全部可写路径指到 `/data`（否——agent 装不了系统包）。
- **附带**：tini 装在镜像里作 PID 1（agent 会大量 spawn 子进程，必须有东西回收僵尸），不依赖 Docker 的 `Init`。
- **重审**：客户合规要求只读根时。

## D13 · 容器内预装 pnpm，且全局前缀落卷

- **决策**：镜像里预装 pnpm（与 npm 并存）；`NPM_CONFIG_PREFIX` / `PNPM_HOME` / `PNPM_STORE_DIR` 全部指向 `/data`。
- **理由**：agent 会在用户项目里用 pnpm；预装省得它自己装。全局前缀落卷是为了**升级不丢**——否则重建容器后 agent 装过的工具全没了。

## D14 · 入口 token 由桥注入，不进浏览器 URL

- **决策**：平台把「打开 dsh」指向**裸实例域名**（`https://<slug>.<base>/`，没有专门路径）；容器内桥在 **「无 cookie 的 `GET /`」** 上补 dsh 的入口 token 再转发。entrypoint 从 dsh 启动输出里抓 token，`export DSH_LAUNCH_TOKEN` 后起 Caddy（Caddyfile 用 `{env.DSH_LAUNCH_TOKEN}`）。
- **理由**：dsh 每次启动随机生成入口 token，首次访问必须带在 query 上才能换 cookie，且没有 flag / 配置能固定或关闭（`ConnectionConfig` 只有 `recovery` / `cookieMaxAgeDays`）。桥注入让 token **不进浏览器 URL / 历史 / Referer**。触发条件从「精确路径 `/__open`」改成「没有 cookie」之后，用户**直接输域名就能进**——换完 cookie dsh 自己 303 回 `/`，地址栏始终是裸域名。
- **备选**：平台直接给带 token 的链接（token 进浏览器历史）；forward-auth 按"有没有 Cookie"302（启发式）；关掉 dsh 的 browser-auth（动 dsh 安全功能，且 `connection` 插件兼做 RPC 传输，多半关不掉）。
- **代价**：
  1. entrypoint 解析 dsh 的启动输出 —— 格式耦合，靠 D11 的版本 pin + 升级前回归兜住；抓不到时首页会 401，entrypoint 打警告。
  2. **新触发条件多依赖两个 cookie 事实**：名字前缀是 `dsh-auth-`、且「cookie 失效时还能被重新引导」。Caddy 验不了签名，所以「cookie 在但无效」（换过实例/卷、别的端口留下的同名 cookie）由 **401 自愈**兜底——把非 `/api` 的 401 换成带 token 的地址。**dsh 一旦改 cookie 名字、或不再下发 cookie，症状会变成首页 303 死循环**（不再是 401）——已用伪造改名 cookie 的后端实测确认。
- **重审**：dsh 提供固定或可配置的入口 token 时。

## D15 · 用平台插件解锁客户端 `isLoopback`，不补丁官方 bundle

- **决策**：实例镜像带一个 8 行宿主插件 [`docker/instance-image/owns-host.mjs`](../docker/instance-image/owns-host.mjs)，
  经官方 `--patch` 覆盖层（`owns-host.yml`）插进 web profile，往 index 注入
  `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }`，把客户端 `isLoopback` 判真。
- **理由**：`isLoopback` 在浏览器里由 `location.hostname` 算
  （[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `packages/client/connection/src/client/index.ts:227`），**代理改不了**；
  不判真则 `persistence='memory'`，设置面终态不可用（用户连 API key 都填不了，阻断验收表 #3）。
  走 dsh 公开扩展点（`webServer` 的 `webserver/index-inject` 行 + 官方 `--patch`），**不改官方文件**——
  对标项目的 sed 补丁（dsh-deploy、deepseek-harness-fnos）升级即失效，我们不跟。
- **服务端不需要动**（2026-09-09 实测，0.1.2-rc.1，容器内直连 3080、Host=实例域名）：
  `/api` 只有两道闸——Host/Origin 围栏（官方 `--trusted-host` 已放行）+ 浏览器 cookie。
  `settings/describe` → `ok:true`；`settings/mutate`、`credentials/set → describe → unset`
  全部到达 handler 并成功。**没有"特权 RPC 钉死回环"这回事**（修正早先引自社区项目
  [dsh-deploy](https://github.com/mervyn-teo/dsh-deploy) 注释的判断）。
- **代价**：主动放弃"客户端回环"这层兜底——若 dsh 以后给 `isLoopback` 加新消费者（本机专属能力），
  等于也对我们用户开放。拦阻靠服务端三道门（D8），**门不能漏挂**。
- **风险**：`__DSH_TRANSPORT__` / `ownsHost` 是 dsh 内部约定，升级后可能改名 → 设置面**静默**变坏。
  兜底：插件文件缺失或解析失败时 dsh 直接退出（响亮失败，已实测）；升级前必跑验收表
  「升级后设置页仍可用」。
- **坑**：`--patch` 是**启动器**选项，必须写在 web app 自己的参数（`--host/--port/--no-open`）**之前**，
  否则被当成 app 选项 → `error: unknown option '--patch'` → 实例 crash-loop（已踩）。
- **重审**：dsh 给出官方开关（`--trusted-host` 的客户端对等物）时换回官方。

## D16 · 实例状态查询时从 Docker 现算，DB 只记意图

- **决策**：列表 / 详情 / 管理面的 `status` 在**请求时**用一次 `docker ps -a` 现算
  （[`apps/server/src/instance/runtime-status.ts`](../apps/server/src/instance/runtime-status.ts)）；
  DB 的 `instances.status` 降级为**意图**（编排动作、对账器仍读它；路由投影见 D25，
  已经改成读容器事实、只在取不到时退回它）。
  状态词汇加 `restarting` / `paused`，并把 Docker 原文（`Restarting (3) 20 seconds ago`）
  透成 `statusText`。前端不再把 `running` 当落定态：编排中 3 秒轮询，其余 10 秒兜底。
- **理由**：D15 验收时 `--patch` 参数顺序错导致 crash-loop，**列表和详情都显示「运行中」**。
  根因两层：① 语义——对账器把 `restarting` 折进 `LIVE_CONTAINER`（这是对的，容器会自己回来），
  所以采样再快也不会显示「重启中」；② 传输——DB 快照被当事实返回，前端又把 `running` 当落定态
  直接停止轮询，两个错误叠成「永远显示运行中」。
  同类平台看起来「实时」，实测也只是**按需 `docker ps -a` + 5–10 秒轮询**，没有事件流 / WS / 采样器——
  我们缺的是「查询时取事实」，不是「实时」。
- **备选**：① 调小对账周期（治不了：折进 running 是语义问题）；② 订阅 Docker events 流
  （准，但要长连接 + 断线重放 + 多控制面实例协调，MVP 不值）；③ 每实例一次 `inspect`
  （N 次往返，不如一次 `docker ps -a`）。
- **代价**：每次列表/详情多一次 `docker ps -a`——**按 `dsh-instance-` 前缀过滤**后约 35ms
  （不过滤要扫宿主上全部容器，开发机 63 个约 400ms）；前端常驻 10 秒轮询，
  稳定态也轮——这是准确性的价钱。**取不到 Docker 时回退 DB 快照并告警**：
  宁可显示旧值，也不谎报「全部已停止」。
- **重审**：实例上百、`docker ps -a` 成瓶颈时（改事件流 + 内存快照）；或 dsh 侧给出
  平台可直接问的状态接口。

## D17 · 配额创建时由用户定，之后只有管理员能改

- **决策**：CPU / 内存 / pids 在**创建实例时**由用户配置（`POST /api/instances`，默认 1 核 /
  2048MB）；**创建后用户不可改**，只有管理员能改。磁盘配额等 #7 选型定了再补，权限规则同上。
- **理由**：资源配额直接对应成本，用户自助改 = 自助扩容，要配套计费 / 风控 / 下限，MVP 不值。
  管理员改覆盖真实场景：欠费降配、投诉调大。
- **实现**（改动很小）：`restart` 已经是**从 DB 行重建容器**——`provisioner.ts` 的
  `applyRuntime` → `specOf(row)` 直接读 `row.cpus / memoryMb / pidsLimit`，与升级换镜像同一条路。
  所以「改 DB 配额 → 触发 restart」即可生效，**不需要新写 Docker 逻辑**。
  （备选，未采用：`docker update`（dockerode `container.update()`）可对**运行中**容器改 Memory /
  NanoCpus / PidsLimit，不重建；但内存下调不能低于当前用量、`MemorySwap` 要一起改，
  而且和「换镜像」变成两条路径。重建几秒就够，不值。）
- **已实现（2026-09-09）**：`PATCH /api/admin/instances/:id/quota` + 管理台实例行的「改配额」对话框。
  `provisioner.setQuota` 的顺序：先落库 → 删旧容器（Docker 的 Memory / NanoCpus / PidsLimit
  **只在建容器时生效**）→ 原本在跑的按新规格重建（中断几秒），原本停着的**保持停止**、
  只删容器并清 `containerId`——否则 `start` 会复用旧容器、带着旧配额起来。
  校验上限取 `instance-spec` 的 64 核 / 256GB，**比用户自助创建的 8 核 / 16GB 宽**
  （管理员可按合同给更高规格）。实测：1 核 / 512MB / 128 pids → 2 核 / 1024MB / 256，
  容器重建、`/data` 里的文件还在；停止态改配额后仍为 stopped。
- **待补**：磁盘配额的可改性见 D18（扩容在线、缩容停机，已实现）。
- **重审**：要开放用户自助扩容（配计费）时。

## D18 · 磁盘配额：一个 XFS 池 + 每实例一个 project ID

- **决策**：实例数据落在**一个池子**里 —— `HOST_STORAGE_ROOT` 必须是一块 **XFS 且以 `pquota` 挂载**的文件系统；
  池子里每个实例一个目录，按 **project quota** 设硬上限：`limit -p bhard=<diskMb> ihard=<n>`。
  **字节和 inode 两个都要设** —— 只限字节不限文件数，一个实例能用几百万个零字节文件把宿主 inode 耗尽。
  宿主不是 XFS（Debian/Ubuntu 默认 ext4）时，在它上面放**一块大的 loopback XFS 镜像**当池子；
  **整机只有一个 loop**，不是每实例一个。
- **理由**：
  1. 硬限由文件系统在**分配块的路径上**强制，容器里有多少 capability 都改不了；
  2. 池化之后**没有每实例的 loop / mount** —— 也就没有"宿主 / daemon 重启后挂载全消失、要按序恢复"那一整套
     内核态状态要管（早期形态的 `on-failure:5`、先恢复挂载再拉实例、fail-loud 检查全都因此退场）；
  3. 扩缩容就是**改一个数字**（`limit -p bhard=…`）：扩容直接改；**缩容也能做** —— 已用超了新限额时表现为
     "拒绝再写"、数据不丢（对比：每实例一个 loop+ext4 时 ext4 **缩不了**，只能重建 + 迁移）；
  4. 实例里 `df` 报的是**配额**、不是宿主盘，所以"实例看不到宿主真实容量"这条仍然成立。
- **实测（2026-09-12，Debian 12 / 内核 6.1 / Docker 29）**：
  - `mount -o pquota` + `limit -p bhard=10m` → 灌 50 MiB **只写进 10 MiB**，是硬限；
  - 项目目录的 `statfs` 报**配额**：池子 960 MiB / 项目目录 256.0 MiB
    （前提：目录要带 `PROJINHERIT` —— `xfs_quota project -s` 会设；只打 project ID 不设继承标志则不报）；
  - 建实例 ~7 ms；I/O 吞吐与"每实例一个 loop 镜像"**无差别**（74 vs 78 MB/s）。
- **代价（要说清的）**：
  1. **隔离从"物理"变成"逻辑"** —— 每实例一个镜像时，盘就那么大，配额逻辑错了也写不出去；池化之后**全靠配额设对了**。
     而设配额要 `CAP_SYS_ADMIN`，缺权限时是**静默失败**（`xfs_quota report` 读不要权限，只有 `limit` 要）。
     → **必须有一条启动自检**：验证限额真的能设上，不成**拒绝启动**。这是本决策的硬前提，不是可选项。
  2. 池子是一块文件系统：它满了 / 坏了是**全局**影响（这正是配额存在的理由）。
  3. 复制（升级前快照）必须给新目录**一个新的 project ID**，否则用量会算进原实例的账、甚至撞它的限额。
  4. 宿主侧要特权来建池 / 设限额；控制面手里的 docker socket 已等价于宿主 root，所以这不是新增特权面。
- **开发机（macOS / Docker Desktop）：不做硬限。** `createStorage` 照常建卷，但**打一行警告**说"本机不强制磁盘配额"。
  理由：它的 linuxkit 内核把配额整块裁了（`CONFIG_XFS_QUOTA` 未设、`QFMT_V1/V2` 未设，`mount -o pquota` 一律 EINVAL）。
  行业惯例也是如此 —— 开发机不强制、生产机硬限（K8s 那套用 XFS project quota 代替驱逐）。
- **被取代的形态**：「每实例一个 loop 文件 + ext4，文件系统大小即配额」+ 特权 `nsenter` 助手容器。
  它两边都能跑、当年也实测通过，代价是每实例一个 loop/mount、重启恢复顺序、以及一个特权容器面。**已弃用。**
- **重审**：Docker / containerd 给出原生的每卷配额时；或宿主侧的配额能力（`CAP_SYS_ADMIN`）拿不到时。


## D19 · 升级 / 回滚：换镜像前给 `/data` 打快照

- **决策**：升级 = 换镜像（铁律 3），用户内容靠数据文件系统保留。为了「升级失败不丢数据」，
  `instance` 表新增 `previous_image`（**非空 = 有一份升级前的数据快照可回滚**）。快照本体在宿主上
  `<HOST_STORAGE_ROOT>/<slug>.img.prev`，**不进库、不算实例配额**；每实例只保留最近一份，
  下次升级覆盖。
- **权限**：**用户面**只能选平台**已发布**的版本（`image_release` 表，见 D21）∩ 宿主上已有；
  **管理面**可任选宿主上任意本地 tag（`setImage(id, image, { allowAny: true })`），仍限平台自己的镜像仓库。
- **准入四道**（`assertImageAllowed`）：引用合法（`ImageRefSchema`）→ 是平台自己的仓库
  （`imageRepo(image) === imageRepo(默认版本)`，挡住「换成别人的镜像」）→ 已发布列表
  （用户面，见 D21）/ 跳过（管理面 `allowAny`）→ **宿主上真的有**（`listImageTags()`）。
  最后一道必须过：否则 Docker 会去 registry 拉，控制面在私有网络里未必连得上，
  失败信息用户看不懂（会以为平台坏了）。
- **顺序与退路**（`provisioner.setImage`）：校验（什么都没碰）→ 停容器 → 快照 →
  落库（`image` = 新版、`previous_image` = 旧版、`containerId: null`）→ 重建。
  - 快照失败（多半宿主空间不够）：**不落库**，按原规格把实例恢复起来，抛 `ImageRejectedError`
    （「升级前打快照失败，实例未改动：…」）。数据一个字节没动。
  - 新镜像起不来：**自动回滚**——`restoreSnapshot` + 旧镜像重建，抛 `ImageUpgradeFailedError`；
    回滚也失败则标 `error` 并响亮报错。
  - 原本停着的实例只落库，新镜像等用户下次 `start` 生效。
  - 三种预期内失败统一走 `isImageFailure` → HTTP 400（实例面与管理面同一套语义）。
- **快照实现**：特权助手容器里 `cp --sparse=always`（宿主 GNU coreutils **9.1**，实测 4MB 零块
  → 目标 alloc=0）。所以快照实占 ≈ **已用字节**，不是配额大小；回滚用 `mv` 同目录 rename，
  **耗时与数据量无关**。停机时间 = 停容器 + 复制已用数据 + 启动（100MB 秒级，10GB 一两分钟）
  ——UI 上写清楚。
- **自动回滚的坑（自查发现）**：不能复用 `rollbackImage`——失败的 `restart` 已把 `status` 写成
  `error`，照当前行判断 `wasRunning` 就会**不重建**，实例留在「没容器」状态。改为私有
  `rollbackTo(id, previousImage, rebuild)`，由 `setImage` 传**升级前**的 `wasRunning`。
- **实测（2026-09-09，`pnpm check:storage` 21 项全通过）**：快照实占 9MB（配额 256MB，
  稀疏复制不按配额算）→ 改数据 → 回滚后内容回到快照那一刻 → 快照被消费（不能回滚第二次）
  → `mv` 后数据文件仍在。单测：`provisioner.test.ts` 19 例覆盖准入四道、升级落库与快照顺序、
  快照失败不落库、新镜像起不来自动回滚、停着只落库、回滚消费快照。
- **代价 / 待补**：① 快照吃宿主**真实**空间（≈ 已用字节）——D18 的「宿主容量告警」要把它算进去；
  ② 只有一层快照，再升级会覆盖上一份；③ 停机时间随数据量增长，用户面必须给预期（已写）；
  ④ `migrate-to-img.ts` 那类一次性脚本不属于长期资产，用一次就该删。
- **重审**：要支持多层快照、或宿主换成 LVM / btrfs 能做在线快照时。

## D20 · 首个管理员：seed 引导 + 管理台授予，ADMIN_EMAILS 退役

- **决策**：第一个管理员由一次性命令 `pnpm --filter @dsh-cloud/server db:seed` 建出——邮箱 / 密码来自
  `.env.local` 的 `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`，**只在「一个管理员都没有」时生效**，
  已有管理员就直接跳过。`ADMIN_EMAILS`（启动时按环境变量提权）整个删除。之后授予 / 撤销走管理台的
  `PATCH /api/admin/users/:id/role`，且**最后一名管理员不可降级**。
- **理由**：`ADMIN_EMAILS` 有三个毛病：① 只对**已存在**的账号提权，而「先配 env 再注册」是最自然的
  顺序 → 那次启动静默地什么都不做，无日志无报错；② 零管理员时自锁——`/admin` 全 403，唯一出路是
  手改 env 再重启进程；③ 只升不降，配置文件推断不出真实权限。seed 把「引导」和「管理」分开：
  引导是一次性的、显式的、幂等的（重跑无副作用，也是管理员被删光后的恢复路径），管理则长期留在
  管理台里——不必再造第二个管理入口（带参 CLI 的 create / promote / 重置密码会和界面重复，
  密码还会进 shell 历史与进程列表）。
- **备选**：setup 页面（首次访问引导，否——多一套「未初始化」状态机及它的绕过风险）；
  带参 CLI（否——与管理台重复）；保留 `ADMIN_EMAILS`（否——见上）。
- **代价**：① `user.role` 仍是唯一真相，但「谁是管理员」不再能从配置文件看出来，部署后要问数据库
  或管理台；② seed 不重置已存在账号的密码（那要 better-auth 内部 API），所以「只有一个管理员且
  忘了密码」目前无解，需要时再补重置流程；③ 最后一名管理员不可降级是个**不变量**，由 `app.ts` 里
  「查目标 → 数管理员 → 写」三步实现，两步之间有个极窄的并发窗口（两个管理员同时自降），
  单运营者场景不值得上事务。
- **重审**：出现多运营者并发操作、或需要「管理员自助重置密码」时。

## D21 · 镜像版本进库：`image_release` 表 + 管理台「镜像管理」页，运行时不再读镜像 env

- **决策**：「平台用哪个镜像」不再由 env 决定，改成 `image_release` 表是**唯一真相**：
  `ref`（完整镜像引用，唯一）/ `is_default` / `published_at`。
  - **运行时从库里取**：新建实例记「默认版本」那一行（`provisioner.create` → `findDefaultImageRelease`）；
    用户面能自助升到的版本 = 已发布 ∩ 宿主上真有；管理面仍可任选宿主上的平台仓库镜像（D19 不变）。
  - **管理台新增「镜像管理」页**：发布 / 下架 / 设为默认，对应 `/api/admin/images` 四条路由
    （ref 走 body——tag 里的 `:` 和 registry 里的 `/` 进 path 会被编码坑）。
  - **`db:seed` 只引导第一版**：版本表为空时用 `SEED_IMAGE`（缺省 `dsh-instance:0.1.0`）建一行并设为默认；
    非空就跳过。`SEED_IMAGE` 只被 seed 读，**不进 `src/env.ts`**（和 `SEED_ADMIN_*` 同档）。
    → **已被 D22 取消**：`SEED_IMAGE` 删除，
    `db:seed` 只管管理员；第一版的引导入口是管理台「镜像管理」页。
  - `INSTANCE_IMAGE` / `INSTANCE_STABLE_IMAGES` 两个 env 变量**删除**。
- **理由**：和 `ADMIN_EMAILS`（D20）是同一类毛病——**会变、且运行时被查询的状态，塞在启动时读一次的 env 里**。
  具体症状：① 换一版要改 env + 重启控制面；② `INSTANCE_STABLE_IMAGES` 默认空，实例建起来后用户面
  「换版本」下拉是空的，得有人想起来去填；③「哪个是默认版本」在 env 里只是个约定，数据库、管理台、
  实例行三处看不出关系。
- **「至多一个默认」由数据库兜住**：部分唯一索引 `unique index on (is_default) where is_default`
  （与 `instance_slug_unique` 同款写法），不靠应用层自觉。换默认走事务：先把旧的置 false，
  再把目标置 true——**顺序不能反**，否则撞索引。
- **默认版本不可下架**（400「默认版本不能下架，先把别的版本设为默认」）：否则表里可能一个默认都没有，
  新建实例就断了。一旦 seed 过，表里永远至少有一行、永远有默认。
- **发布的前置**：引用合法 → 与当前默认版本**同仓库**（仓库名从默认版本推）→ 宿主上真的有。
  表为空时不允许发布（400「先跑 db:seed」）——seed 是唯一引导入口，否则「哪个仓库是我们的」无从判断。
  → **已被 D22 修正**：仓库名改由配置 `INSTANCE_IMAGE_REPO` 给出，发布不再依赖表里已有行，
  空表可以直接发第一版。
- **运行时没有默认版本 → 响亮失败**：`create` 抛 `ImageRejectedError`（「平台还没有默认镜像版本：
  先跑 db:seed，或在「镜像管理」里指定」），`POST /api/instances` 映射成 400。**不**回退到某个 env
  默认值——静默用过期镜像比报错更糟。（文案里的 `db:seed` 已按 D22 改成「在「镜像管理」里发布一版
  并设为默认」；行为不变。）
- **备选**：继续用 env（否，见上）；拿 `instance` 表里最新一版当默认（否——「最新」和「平台认可」是两回事，
  灰度 / 回退需要一个显式指针）；已发布列表存成 JSON 一行（否——发布 / 下架 / 设默认都要读改写整行，
  并发下会丢更新）。
- **代价**：① 换镜像仓库（比如上新 registry）没有路径——得清空表重跑 seed；→ **已被 D22 解掉**
  （仓库是配置项，改 `INSTANCE_IMAGE_REPO` 即可）；② 下架不影响已在用该版本的
  实例（它保留自己的 `image`，只是不再出现在用户面列表里）；③「可发布候选」是库 ∩ 宿主两个来源，
  镜像在不在宿主上仍要问 Docker。→ **已被 D23 补上第三个来源**（注册表快照 `image_catalog`），
  三态在接口层派生。
- **重审**：要支持多 registry / 镜像 digest pin / 批量滚动升级时（tag 命名与 CI 已在 D22 定下；
  多 registry 仍待定）。

## D22 · 实例镜像：单版本源 + OCI label + CI 推公开 GHCR

- **决策**：镜像的来源做出来——可重复构建、可追溯、可分发。
  - **tag = `<dsh版本>_<修订号>`**，如 `0.1.2-rc.1_1`。`_` 是唯一无歧义的分隔符：上游 dsh 全是
    prerelease（实测 `0.1.0-rc.8` / `0.1.2-rc.1` / `0.1.5-alpha.2`，都含 `-` 和 `.`），而 `_` SemVer
    不允许、Docker tag 允许。修订号是**单调递增整数**，从 1 开始，不是第二套 semver。
  - **单一版本源** `docker/instance-image/VERSION`（一行）。本地 `build.sh` 和 CI 都从它读，
    tag 与装进去的 dsh 版本不可能漂。Dockerfile **删掉 `DSH_VERSION` 的默认值**，缺参数**响亮失败**
    （静默装一个过期版本比报错糟得多）；两条 `test` 断言（`dsh --version` / `pnpm --version` 等于传入值）
    是「tag 与内容一致」的机器校验。
  - **tag 不可重建**：CI 推送前 `HEAD /v2/<repo>/manifests/<tag>`，已存在就失败（「bump VERSION 的修订号」）。
  - **事实进 OCI label**：`org.opencontainers.image.*`（`version` = `<dsh版本>_<修订号>`、`source`、
    `revision` = git sha、`created`）+ `io.dsh-cloud.dsh.version` / `io.dsh-cloud.image.revision`。
    tag 给人看，label 给机器读——`docker inspect` 就能回答「这版里是哪个 dsh」。
  - **仓库** `ghcr.io/eskim2001/dsh-instance`（GitHub `eskim2001/dshcloud`），由
    `.github/workflows/instance-image.yml` 推送。触发**只有 `workflow_dispatch`**：tag 不可变，
    VERSION 是唯一旋钮，发布必须是「人 + 改修订号」的刻意动作。包**公开**，读不需要 PAT，
    但仍要走匿名 token 换取（`ghcr.io/token?scope=repository:...`），不是裸 GET。
  - **两个架构一个 tag**：`linux/amd64` 和 `linux/arm64` 各在**原生 runner** 上构建（公开仓库的
    ARM runner 免费），按 digest 推、两个都成功后再合成一个 manifest list 标签。**不用 QEMU**——
    否则 `node-pty` 这类原生模块要在模拟的 arm64 里编译，慢且容易出怪问题。任一架构失败就不建
    tag（宁可没有，不要一个只有单架构的 tag）。
  - **本地构建用同一个全名**（只是没推上去）：`.env.local` 里 `INSTANCE_IMAGE_REPO` 一个值同时管
    本地和线上，下一轮同步 / 发布不用换命名。
  - **平台仓库改成配置项 `INSTANCE_IMAGE_REPO`**，并**取消 `SEED_IMAGE` 与 seed 的镜像引导**（修正 D21）：
    空表本来就意味着「创建不了实例」（`create` 响亮失败），不需要 seed 来引导第一版；引导入口就是
    管理台「镜像管理」页。原先的发布守卫靠**默认版本**推「我们的仓库」，表空就无从判断——改成配置后
    空表也能发第一版。
  - 本轮 dsh 走 **npm 已发布版本**；从上游源码构建的变体是下一轮。
- **理由**：D21 把「平台用哪个镜像」挪进了库，但镜像本身还是手敲 tag 的本地构建——tag 不表达内容、
  「发布」只检查「宿主上有个同名镜像」，所以**发布 ≠ 可重复构建**。这里补的是来源：版本单源 +
  不可变 tag + 机器可读 label + CI 产出。`INSTANCE_IMAGE_REPO` 本来也是下一轮同步 GHCR 需要的
  （同步得知道列哪个 repo），顺手解掉 D21 代价①。
- **备选**：tag 用平台自己的版本号（否——平台没有版本号，且与 dsh 版本的关系会漂）；
  `-` / `.` 做分隔符（否——上游 prerelease 里就有，分不出边界）；`+` build metadata（否——Docker tag 非法）；
  跟随 npm dist-tag（否——`latest` / `next` 是可变指针，要跟不可变的版本号）；push 触发 CI（否——
  Dockerfile 一改要么撞守卫（红）、要么绕过守卫换 tag（漂））；私有包 + PAT（否——公开就能读，
  少一把要轮换的凭据）；单 job 加 QEMU 出多架构（否——原生模块在模拟架构里编译，慢且易出怪问题，
  公开仓库的 ARM runner 免费，没有理由模拟）。
- **代价**：① base 镜像（`node:24-*` / `caddy`）仍是可变 tag，所以才需要修订号——同 tag 不同天重建
  未必同字节；② 多架构要跑两台 runner、构建时间翻倍（换来的是发布产物在 Apple Silicon 上直接能拉，
  不必本地再建一份）；
  ③ DB 里存的仍是 `ref` 字符串而非 digest，回滚记录因此不是内容级可验证的；
  ④ GHCR 新建的包**默认私有**，首次推送后要手动改成 Public，否则匿名拉取 401；
  ⑤ 控制台侧（同步 GHCR 标签进库、三态状态机、手动「同步」按钮、「本地优先缺了自动 pull」）**未做**，
  必须先有真实 GHCR 标签。→ **已由 D23 解掉**（2026-09-10）。
- **重审**：要做源码变体 / base 镜像 digest pin 时。（「控制台同步落地」已由 D23 解掉。）

## D23 · 镜像目录：`image_catalog` 快照 + 派生三态 + SSE 下载 + 缺镜像自动 pull

- **决策**：把「注册表上有什么」变成控制台看得见的东西。
  - **新表 `image_catalog`**（`ref` PK / `digest` / `synced_at`）存**可丢弃快照**：同步时整批重建
    （upsert + `prune`，上游删掉的 tag 跟着消失）。`image_release` 不动，继续只表达「我们的发布决定」。
  - **三态派生、不落库**：在 `image_release` 里 = **已发布**；否则宿主上有 = **已下载**；否则在
    catalog 里 = **未下载**。宿主存在性是**运行时事实**（`docker rmi` / `prune` 随时会变），存库必漂；
    接口同时给 `onHost`，好看出「已发布但宿主上被删了」。
  - **tag 形状卡住**：`<dsh版本>_<修订号>`（`^[A-Za-z0-9][A-Za-z0-9.\-]*_[1-9][0-9]*$`）。包是公开的，
    任何 collaborator 都能推 `latest` 之类垃圾 tag，而 `ImageRefSchema` 只挡非法字符。同步被过滤掉的
    tag **报数量**（不静默），发布同样按形状准入。
  - **下载走 SSE**（`GET /api/admin/images/pull?ref=…`，GET 是因为 `EventSource` 只支持 GET）：
    `docker pull` 的流是**逐行 JSON**（不是容器日志那种多路复用帧，别 `demuxFrames`），失败是
    **HTTP 200 + 流内 `{"error":…}`**。沿用 `log-stream.ts` 的约定：鉴权 / 仓库 / 形状校验在 hijack
    之前（失败走 4xx），`x-accel-buffering: no`、15s 心跳、`end` 事件后客户端 `close()`。
    **打开拉取流失败也走流内 `error` 事件，不回 502**——`EventSource` 读不到非 200 响应的 body，
    回 502 前端只能显示一句没头没尾的「下载失败」，而真实原因（「manifest 没有 arm64」之类）恰恰
    是最该看见的。所以这条路由的 HTTP 状态**恒为 200**，失败信号只有 `error` 事件。
    鉴权后不查 catalog——管理员有权拉平台仓库里任何形状合法的 tag，包括刚推上来还没同步过的那版。
  - **发布语义不变**（仍要求宿主上已有）；「下载」按钮负责把「未下载」变成「已下载」。
  - **自动 pull 收在 `applyRuntime()` 一处**（create / restart / 换镜像全覆盖），进程内
    `Map<ref, Promise>` 去重。**先查本地再校验仓库**——仓库这道只该拦「真的要出网拉」的，
    D22 之前那些裸 tag 的实例镜像明明在宿主上，照它拒会连重启都做不到。`assertImageAllowed`
    第 4 道从「宿主上已有」放宽成「catalog ∪ 宿主」，免得 `setImage` 先打了数据快照、删了容器
    才在 pull 上失败。
  - **新建时可选版本**（`GET /api/images` 返回全部已发布版本，新建弹窗里是下拉；不选就用默认版本）：
    创建**不要求宿主上已有**（`assertImageAllowed(..., { requireLocal: false })`）——它没有停机窗口，
    `applyRuntime` 本来就会自动拉。这与升级的差别是有意的（见代价⑥）：升级在打完快照、删掉容器之后
    才发现要长 pull，窗口不可预期。用户面能选的仍只是**已发布**的版本，仓库 / tag 形状两道照旧。
  - **顺带补一个既有的洞**：`boot.ts` 启动时把 `provisioning` 的行标成 error（「平台重启中断了创建」）。
    `createInstanceRecord` 先写 `provisioning`，而对账器跳过非 running/stopped、启动恢复只拉 running——
    进程在创建中途崩掉就留下**永久僵尸行**。加了 pull 之后这个窗口从秒级变成分钟级，所以这轮补上。
- **理由**：D22 之后 GHCR 上有真实标签了，但控制台对上游一无所知——GHCR 上存在、宿主上没下载的版本
  完全看不见；「可发布」全靠宿主本地状态推断，没有 digest；实例镜像被 prune 掉之后 `restart` 直接
  `No such image`（遗留实例 `test` 就是这么坏的）。
- **备选**：给 `image_release` 加 `state` / `digest` 列（否——同步的删除语句必须豁免已发布行，
  漏一处就删掉默认版本，新建实例直接坏）；宿主存在性也落库（否——运行时事实，必漂）；三态存成一列
  （否——两个真相源）；下载走 POST + 轮询作业表（否——这一轮不值得引入作业表，代价见下）；
  下载走 WebSocket（否——已有 SSE 约定，`EventSource` 自带重连）。
- **代价**：① 控制面多了一条到 registry 的**出网依赖**（同步 + 匿名 token 换取都要出网，失败是 502
  而非内部错误）；② **没有作业表**——下载靠 SSE 连接活着，关掉页面不会取消 `docker pull`（docker 那头
  继续跑），也没有断点续传 / 取消按钮；进程内去重只在单进程成立；③ digest 是 **manifest list** 的
  digest（`Docker-Content-Digest`），不是单架构内容哈希，只用来展示 / 比对版本，别当一致性证明；
  ④ catalog 有 **TTL 语义**——页面必须显示「上次同步」，否则「未下载」可能只是没同步过；
  ⑤ 自动 pull 让 create / restart 的最坏耗时从秒级变成分钟级（正常路径是管理员先点「下载」）；
  ⑥ 用户面 `stable` 仍保持「已发布 ∩ 宿主已有」，**不**让用户升级触发长 pull。
- **重审**：要下载取消 / 断点续传 / 跨进程去重（引入作业表）时；要做 base 镜像 digest pin 或私有包
  凭据轮换时；上游 tag 命名规则变了时。


## D24 · 域名拆分：`BASE_DOMAIN` 退成父域，控制台搬到 `CONSOLE_DOMAIN`

- **决策**：把「父域」和「控制台自己的主机名」拆成两个变量，并给实例命名加上纵深防御。
  - **`BASE_DOMAIN` 是父域**（本地 `lvh.me`，生产 `xxxx.app`）：实例主机名 = `<slug>.<BASE_DOMAIN>`，
    会话 cookie 的 `Domain=.<BASE_DOMAIN>`。**新增 `CONSOLE_DOMAIN`**（本地 `console.lvh.me`）：
    它决定 better-auth 的 `baseURL`、`trustedOrigins` 和未登录时的跳转目标。
    `env.ts` 的 `superRefine` 断言 `CONSOLE_DOMAIN` 是 `BASE_DOMAIN` 的**子域**
    （父域本身不行——`<父域>` 那一层留给实例命名空间），配错起不来。
  - **保留字扩充 + 创建路径兜底**：`RESERVED_SLUGS` 按组扩到 80 条（平台自用 / 认证 / 基础设施 /
    环境 / 监控 / 常见服务词，含 `console`、`platform`）；创建处理器再显式拒绝
    「slug 等于 `CONSOLE_DOMAIN` 的首段」——控制台域名可以配成静态表之外的词。
  - **软删的 slug 绑定原 owner**：`createInstanceRecord` 事务里查同 slug 的**任意行**（含软删），
    属于别人就 `SlugTakenError`。partial unique index 不动，所以**同一 owner 仍可重建同名**，
    purge 之后彻底释放。
  - **优先级是显式的**：开发态控制台 router 设 `priority: 1000`；实例 router **不设** priority。
    这样即使有 slug 撞上控制台 label，控制台也稳赢，不依赖 Traefik「规则长度相同则行为未定义」。
  - **注册面测试**：`http/route-surface.test.ts` 把全部已注册 GET 路由钉在一份白名单上，
    新增 GET 必须过一次人工决定（铁律 6：漏挂认证不报错）。
- **理由**：原来 `BASE_DOMAIN` 一个变量同时当控制台主机名和实例后缀，于是控制台主机名
  （`platform.<base>`）落在实例命名空间里。任何登录用户建一个 slug = `platform` 的实例，就渲染出
  规则长度与 `platform-web` 完全相同的 router；Traefik 平手行为未定义，而 forward-auth 的未登录
  跳转又指向同一个主机——最坏是**控制台全站打不开 + 所有租户的所有实例一起不可用**，一次 API 调用
  即可触发。拆开之后两者不再共享主机名，抢注在结构上不可能；保留字和 priority 只是纵深防御。
  另一条理由是浏览器状态按域名归属（cookie / localStorage / service worker）：主机名回收给另一个
  租户就等于把上一个租户的浏览器状态继承过去，所以软删的 slug 必须继续绑定原 owner。
- **备选**：只加保留字、不拆变量（否——控制台域名是可配置的，静态表永远滞后，且语义仍然混着）；
  实例 slug 强制随机后缀（否——用户要自选、要可读，而且不解决「控制台占用根域」的结构问题）；
  cookie 改 host-only + 控制台签发短时 token（**另开一轮**，会动认证链路，见 OPEN-QUESTIONS）；
  入口剥 `Set-Cookie`（否——Traefik 的 `headers` 中间件只能整条删，会连 dsh 自己的会话 cookie
  一起删掉，做不到「只删带 `Domain=` 的」）。
- **代价**：① 控制台地址变了（本地 `platform.lvh.me` → `console.lvh.me`），书签要改一次；
  ② **所有实例容器必须重建**——`DSH_TRUSTED_HOSTS` 是建容器时写进环境的，不重建就是「页面能开、
  API 全 403」（迁移步骤见 SECURITY-HARDENING.md）；③ 本地 cookie 域从 `.platform.lvh.me` 放宽到
  `.lvh.me`（覆盖本机所有 `lvh.me` 子域；生产是注册域本身，无差异）；④ 保留 slug 会累积，跨 owner 不得复用，而且**没有自动释放的时机**
  （实例删掉之后名字仍属于原 owner，见 D31）；⑤ **Set-Cookie 投毒仍未解**：同注册域下实例响应能种
  `Domain=<base>` 的 cookie，利用前提是「同一浏览器先后访问两个租户的实例」，结构解另开一轮；
  ⑥ **保留字只挡新建，不追溯存量**：`RESERVED_SLUGS` 是**创建期命名政策**，只挂在创建输入上
  （`CreateBodySchema`）；`InstanceSlugSchema` 只管形状，库里已有的行一律放行。最初的实现把保留字
  也放进 `InstanceSlugSchema`，于是 `specOf` 对存量行再判一次——扩表会让 slug 恰好落进新表的实例
  **打不开（门上 404）也删不掉（purge 500）**，等于把租户锁在门外。现在存量保留字实例照常可访问、
  可启停、可删除，只是这个名字不能再被新建占用。
- **重审**：把门改成 host-only cookie + 控制台签发短时 token 时；入口换成能按域名过滤 `Set-Cookie`
  的方案时；控制台需要再拆出多个主机名（如 `admin.` / `api.`）时——那时该引入一张显式的
  「平台保留主机名」表，而不是继续往 `RESERVED_SLUGS` 里加词。

## D25 · 路由投影按**容器事实**裁决，失败收尾补投影一次

- **决策**：Traefik 投影的准入判据从 DB `status` 换成**容器的实时状态**
  （[`apps/server/src/instance/routes-sync.ts`](../apps/server/src/instance/routes-sync.ts) 的
  `routableInstanceSlugs`）：容器处于 `running` / `restarting` / `paused` 就投影，`exited` /
  `created` / `dead` 或**容器根本不在**就不投影。只有编排进行中（`provisioning` / `removing`）
  例外——这两个窗口里容器死活都不算数，一律不投影。`containerStates` **取不到**（Docker 抖了）
  时退回 DB 意图，并按失败即关闭处理：只投影 `status === 'running'` 的行。
  配套地，所有失败收尾（`InstanceProvisioner.failWith`）在写 `error` + `lastError` 之后
  **重新投影一次路由**，投影自身失败只告警、不覆盖原始错误。
- **理由**：D16 之后 `status` 只记**意图**，一次失败的操作就把它写成 `error`，而容器往往还好好地
  跑着。照意图投影的问题是**路由只减不增**：`remove` 的第一步就是「置 `removing` → 投影一次」
  把路由摘掉（有意如此，先摘再删容器），若后面某一步失败，catch 写 `error` 却不补投影，
  对账器又跳过 `error` 行——**再也没有任何人把这条路由加回来**。用户看到「实例突然 404」，
  真实原因却是「上一次操作失败了」，两码事，而且没有任何日志或告警把这两件事联系起来。
  改成按事实裁决后，这条链路自己就闭合了：容器还在 → 路由还在 → 用户照常打开；
  容器真没了 → 没路由 → 页面上的「启动」重建（`start` 有 `containerId === null` 的回落）。
- **备选**：① 只在 catch 里补一次投影、判据仍看 `status`（否——`status` 已经是 `error`，
  补投影等于什么都不做）；② 让对账器也处理 `error` 行（否——`error` 是「等用户决断」的落定态，
  对账器自动改写它会让失败原因一闪而过，用户看不到）；③ 把 `error` 从 DB 里拆成独立的
  「事实」列（否——Docker 已经是事实的真相，再存一份就是第三个可能过期的副本）。
- **代价**：① 投影前多一次 `docker ps -a`（和 D16 同一份开销，按 `dsh-instance-` 前缀过滤约 35ms），
  且**所有**改路由的路径（创建 / 启停 / 删除 / 对账）都要带上它；② 取不到 Docker 时路由会
  短暂变窄——这是有意的取向，宁可少投影一条（用户重试或下一轮对账修回来），也不要多投影一条
  绕过门的裸路由；③ 「DB 记 `stopped`、容器却真在跑」时会被投影（外部 `docker start` 或
  上一次 stop 停在中间），此时以事实为准是对的，DB 由 45 秒的对账收敛。
- **注意（有意的不一致）**：这样会让「列表里显示**错误**、实例却**打得开**」同时出现
  （列表状态走 `resolveRuntimeStatus`，`error` 是短路返回的意图）。这不是 bug：状态回答
  「需不需要你管」，路由回答「能不能连上」。UI 上的错误文案本来就要指向 `lastError` 里的原因，
  而不是暗示「已经不可用了」。
- **重审**：引入异步作业表 / 编排状态机时（那时「进行中」不再只有 `provisioning` / `removing`
  两个词，`IN_FLIGHT` 需要跟着状态机走）；或控制面变成多实例部署、投影需要跨进程协调时。

## D26 · 本地开发不签证书：`local.yml` 靠 Traefik 默认自签证书

- **决策**：本地 `:443` 入口（[`docker/compose/local.yml`](../docker/compose/local.yml)）
  **不再准备静态证书**——删掉 `docker/traefik/dynamic-dev/tls.yml` 与 `certs/` 挂载，让 Traefik
  在没配到证书时回落到它内置的默认自签证书（`CN=TRAEFIK DEFAULT CERT`）。README 里那条
  `openssl req` 签发步骤一并删除。生产路径不受影响：证书仍走 file provider 的静态证书
  （[`apps/server/src/instance/traefik.ts`](../apps/server/src/instance/traefik.ts) 的 `tls: {}`
  语义不变），`TRAEFIK_CERT_RESOLVER` 也仍是「空 / ACME」二选一。
- **理由**：自签证书只在「装进系统信任库 → 拿到绿锁」这一条路上有意义；不装信任库时，自签证书
  和默认证书**都是红锁**，用户操作完全一样（点「继续访问」）。而签证书带来一串持续成本：
  新 clone 必须先签、多一个 `certs/` 目录、多一个单文件 bind mount（改了必须重启入口）、
  换域名或证书过期要重签。默认证书这条路的 `:443` 是零配置的：TLS 照样加密、`Secure` cookie
  行为不变、生产同构的验证目标（TLS 终结在入口 + cookie 带 `Secure`）照样达成。代价只是错误类型
  从「不受信任」变成「不受信任 + 主机名不匹配」，对真人浏览器没有实际差别。
  （本 ADR 写作时还有一条 `:80` 明文的 `quickstart.yml`，它本来就不涉及证书；
  那条栈已由 D27 删除，现在只剩 `local.yml` 一条。）
- **备选**：① 入口容器启动时用 init 容器现签一张——否，签出来仍是自签、仍红锁，白白多一个组件；
  ② 保留签发步骤但降级成「可选文档」——否，文档一写就会有人照做，而它默认不带来收益；
  ③ 换成 `mkcert` 本地 CA——否，那要求所有人装一个额外工具并把它做进信任链，是给「想要绿锁」
  的人准备的路，不是默认路径。
- **代价**：① 默认证书**每次容器启动重新生成**（SAN 是一串随机 hex）且不含 `lvh.me`，所以
  永远无法进信任库、永远红锁——想要绿锁只能自己补回签发流程；② 强制校验证书的客户端
  （`curl`、脚本、CI、Playwright 未开 `ignoreHTTPSErrors`）必须显式关校验，且**名字不匹配
  连「装信任库」都救不了**——自签证书至少还能签一次、装进信任库后让这些客户端干净通过，
  默认证书做不到；③ 万一某个域上了 HSTS，名字不匹配会从「警告 + 继续」变成无「继续」按钮的
  硬拦（本地 `lvh.me` 不是 HSTS 预载域，不受影响）。
- **重审**：本地要接自动化验收时（Playwright / CI 跑真浏览器且不关证书校验）——那时需要一张
  可被信任的证书，把签发 + 装信任库的流程补回来，或改用 `mkcert` 本地 CA。


## D27 · 一条命令的本地开发栈：`pnpm dev`

- **决策**：把「clone → install → 跑起来」压成 `pnpm install` + `pnpm dev`。新增
  [`scripts/dev.mjs`](../scripts/dev.mjs)：预检（依赖 / 端口 3000 + 5173 / Docker daemon /
  Compose v2）→ 生成 [`apps/server/.env.local`](../apps/server/.env.local)（只在缺失时写，
  已存在只校验、一个字节都不改；两个 secret 用 `crypto.randomBytes` 现生、不打印）→
  `docker compose -f docker/compose/local.yml up -d` → 轮询 `pg_isready` → `db:migrate` →
  `db:seed` → `detached` 起控制面（`dev:local`，带 `--watch`）和管理台 → 等 Vite 真的应答了
  才打印 URL 和凭据。配套：**Postgres 进本地栈**（`docker/compose/local.yml` 加 `postgres`
  服务 + `dsh-pgdata` named volume，只绑 `127.0.0.1:55432`）；删掉零证书的 `quickstart.yml`
  与 `dynamic-quickstart/platform.yml`，本地只剩一条栈；`vite.config.ts` 加 `strictPort: true`。
- **理由**：原来要 8 步手工，其中「裸 `docker run` 起 Postgres」「手填两个 ≥32 字符 secret」
  「两个终端分别起 server / web」都是纯摩擦，且每一步都有静默失败模式（`db:migrate` 在
  `DATABASE_URL` 缺失时按 drizzle.config 的兜底**连到 `localhost:5432` 的另一个库**；Vite
  默认会自动换端口，一换 Traefik 的 `host.docker.internal:5173` 就 502）。目标是「打开
  `https://console.lvh.me` 一切就绪」，那就必须把端口、env、数据库、迁移、seed 全部收进一个
  有预检的入口——失败要**在动 Docker 之前**说出来，否则留下半起状态更难查。
- **备选**：① 另建 `dev.yml`、`include` 或 `extends` 复用入口配置——否，Traefik 服务只有一个
  消费者，复用只会引入 Compose 版本门槛和相对路径坑；② 固定开发密码写死进文档——否，
  `seed.ts` **永不覆盖已有用户的密码**（只提权），写死会骗到有存量库的人，所以脚本改成读
  `.env.local` 里的实际值、并在「已有管理员」时明说旧密码不变；③ 预检 3000 / 5173 之外的
  `80` / `443` / `55432`——否，那三条是本栈自己要占的，预检会在「上次没拆栈」时误报，交给
  compose 的报错路径；④ 退出时 `docker compose down`——否，那样每次 `pnpm dev` 都要重等
  Postgres 起来，改成留着栈、用 `pnpm dev:down` 显式停。
- **代价**：① 本地多一个常驻 Postgres 容器和一个 named volume（`down -v` 才清）；
  ② 控制面**启动时**就要求 Docker daemon 活着（本来也要 —— 建实例、读状态、投影路由全走它，
  daemon 挂了 boot 就崩），现在这个前提被显式预检并写成文档；③ 固定凭据只适用于本地，且**只在全新库上
  成立**（见备选②）；④ 3000 / 5173 被写死这件事从隐含变成显式（`strictPort` + 预检），
  代价是「端口被占」时不再有 Vite 的自动退让，必须清掉占用者；⑤ 零证书的 `quickstart.yml`
  没了，不想碰证书警告的人只能自己签一张。
- **重审**：控制面端口变得可配时（要同时改 `vite.config.ts` 的 proxy 目标和
  `dynamic-dev/platform.yml` 的 upstream，否则预检的硬编码就是错的）；或把本地栈拆成
  「只要控制台」和「要打开实例」两档时（当前 `pnpm dev` 明确定义为**只到控制台可用**，
  不预拉实例镜像、不管宿主存储）。


## D28 · 容器内沙箱：装 bubblewrap 让能力可用，模式交给用户

> ⚠️ **2026-09-16 复测：bwrap 那一档在容器里起不来。** 真机（Debian 13、dockerd 29.8.0，runc / runsc
> 两个运行时）与开发机（三种权限配置）都试过，报错一律落在**建命名空间**。所以这条「装 bwrap 让沙箱
> 可用」**没有兑现**：生产 Linux 上真正兜住的是**下一档 Landlock**（ABI 6），开发机（内核仍没有
> Landlock）**两档全灭**——那台机器上只有不经沙箱的档位能跑命令。决策本身（装 bwrap、且不替用户
> 选模式）没变，但**别把 bwrap 当保障**。见 [RUNTIME-CONTAINER-EVAL](RUNTIME-CONTAINER-EVAL.md)
> 的「订正（2026-09-16）」。

- **决策**：实例镜像装 `bubblewrap`（构建时剥掉 setuid 位），让 dsh 的 Linux 进程沙箱
  后端可用；**平台不注入 `DSH_PERMISSION_MODE`**（或任何等价手段）去决定沙箱模式——
  用哪一档、什么时候切，是用户在 dsh 会话里的选择。
- **理由**：dsh 的 Linux 候选链是 `bwrap → Landlock → fail closed`，两档全灭时它
  **拒绝执行任何命令**（不是「某条命令越界被拦」）。而 Docker Desktop 的内核没编 Landlock
  （实测 `# CONFIG_SECURITY_LANDLOCK is not set`，且 `CONFIG_LSM` 也不含 `landlock`），
  那个内核由 Docker 自行编译、**用户不可配置**；镜像里原先也没有 bwrap → 每个实例的 bash
  都是死的。平台侧设 `danger-full-access` 固然能让命令跑起来，但那是**越权**：权限模式是
  用户在自己会话里的选择，而且该环境变量会**连带**把 `approval.policy` 从 `ask` 切成
  `never`（dsh 的 `@deepseek-ai/dsh-base` 组合里 `sandbox-policy` 与 `approval` 两处都读
  这个变量），等于平台替用户决定「放开到哪一档、要不要人工审批」。
  平台只负责让沙箱**可用**，不替用户选。
- **备选**：① 平台设 `DSH_PERMISSION_MODE=danger-full-access`——否，越权 + 连带改审批，
  `docker.test.ts` 有断言守着这条不被加回去；② 改宿主运行时（Colima / Lima）或在 macOS
  原生跑 dsh，那能拿到 Landlock / Seatbelt——否，要换运行时，且「宿主内核配置不可控」
  这件事本身就该绕开，而不是依赖一个可用性会随版本回归的内核；③ 不装 bwrap、只靠用户在
  UI 里切 `danger-full-access`——否，那三档里只有一档能用，「在 dsh 里切模式」是空头承诺。
- **代价**：① 镜像多一个包（构建期 apt 装 + 剥 setuid）；② 默认仍是 `workspace-write`，
  所以「装依赖 / 装 CLI」（写工作区之外）需要用户自己在会话里切到 `danger-full-access`；
  ③ 这层沙箱是「同世界」的进程级隔离，与容器**共享内核**，**不构成跨实例边界**——
  那条边界仍是容器（D1）。
- **重审**：宿主内核开始带 Landlock 时（可以去掉 bwrap 这档，留着也无害）；或 dsh 改了
  候选链语义时。
- **补充**：装 bwrap 只是**必要条件**，而且实测这一档在容器里起不来（见本条开头那个 ⚠️）——
  下面 D30 那套「清掉 masked/readonly 屏蔽就能让 bwrap 工作」今天也不成立。

## D29 · 卷内属主只能在平台侧落地（容器内降不了权）

> ⚠️ **这条的配置前提和它的实现都不在当前代码里。** `host-storage.ts`（下面引用的 `mountScript`）
> 在切 microVM 那轮被删，改回 Docker 时没恢复 —— 全仓现在**没有一处 `chown`**；驱动也**不设**
> `CapDrop` / `no-new-privileges`（见 [ARCHITECTURE §五](ARCHITECTURE.md)）。
> 实测（2026-09-13）对一个运行中的实例：`CapDrop: None`、`Config.User=0`，容器里**所有进程都是
> root**（`tini` / `entrypoint.sh` / `caddy`）。所以下面「dsh 以 uid 1000 跑」「容器内连 uid 0 都没有
> capability、`setpriv`/`su`/`gosu` 全 EPERM」这两条**当前都不成立**，属主问题也不会以当时那个形式
> 出现（root 写哪儿都行）。**原文保留是为了记住当时的判断依据，别当现状读。**

- **决策**：实例卷里 `/data/home` 与工作区的属主，由**平台**在挂载脚本里 chown
  （`host-storage.ts` 的 `mountScript` —— **该文件已不存在**，见本条开头，
  非递归、只碰 home 子树），既不靠镜像层，也不靠 entrypoint。
- **理由**：三件事叠出来的 —— ① 镜像里 `chown -R dsh:dsh /data` 作用于**镜像层**的
  `/data`，而运行时 `/data` 被实例自己的文件系统 bind **整个覆盖**
  （`renderers/docker.ts` 的 `Binds` —— **该文件已不存在**），
  那次 chown 运行时根本看不到；② 挂载脚本原来只 `chown` 挂载根，管不到里面的 `home`；
  ③ dsh 以 uid 1000 跑，写不进别人的目录 → `EACCES`。**为什么不能放 entrypoint**：
  容器跑 `CapDrop: ALL`，容器内连 uid 0 都没有 capability（实测 `CapEff: 0`），
  `setpriv` / `su` / `gosu` 全部 `EPERM` —— 降权这条路在容器内根本不存在。
- **备选**：① entrypoint 以 root 起、chown 后 `gosu` 降权——否，实测不可能（见上）；
  ② 平台侧只做一次性初始化、不放进挂载脚本——否，放进挂载脚本才有**自愈**
  （`ensure()` 每次开机都跑，属主被外部改坏也能修回来）；③ 对整个 `/data` 递归 chown
  ——否，浪费且会碰到 ext4 固有的 `lost+found`（`drwx------ root`）。
- **代价**：① 每次开机多两条命令（非递归，可忽略）；② `lost+found` 与 entrypoint 自建
  的那批目录不在管辖内，属主出问题要单独看。
- **未解**：**`/data/home` 那个 root 属主究竟是谁建的仍未坐实**（模拟空目录 bind 到
  `/data` 时 Docker 反而保留 1000:1000，没复现出 root）。修法不依赖这个答案——无论谁建的
  都能被上面那句 chown 修掉——但要知道这里留了个未解的点。
- **重审**：宿主存储换成 Docker named volume 时（镜像层 chown 的语义不同了，要重新判断
  谁负责属主）。

## D30 · 覆盖 Docker 默认路径屏蔽：清掉 `/proc` 下的条目，bwrap 才建得起 proc

> ⚠️ **这条的决策没有实现，而且它的根因今天不成立。** 驱动里现在**设了** `MaskedPaths`，但设的是
> **Docker 默认那份 + `/proc/interrupts` + `/sys/devices/virtual/dmi`** —— 目的是多遮一条 DMI
> （宿主是不是虚拟机、机型），与这条的意图（放开 `/proc` 下的条目、让 bwrap 建得起 proc）**相反**；
> `ReadonlyPaths` 仍未设，驱动拿到的是 Docker 默认那 5 条（见 [ARCHITECTURE §五](ARCHITECTURE.md)）。
> 根因也不成立：2026-09-16 在真机（runc / runsc）与开发机（root、uid 1000、`--cap-drop=ALL` 三种）
> 上重测，bwrap 的失败点**一律落在建命名空间**，没有一次走到挂 proc —— 与这条开头 2026-09-13
> 那条记录一致（`Creating new namespace failed: Operation not permitted`）。**下面的矩阵是当时那台
> 开发机上的记录，不是 Docker 的通用行为，别照它去改驱动。** 见
> [RUNTIME-CONTAINER-EVAL](RUNTIME-CONTAINER-EVAL.md) 的「订正（2026-09-16）」。

- **决策**：容器 HostConfig 显式写死 `MaskedPaths: ['/sys/firmware']` 与
  `ReadonlyPaths: ['/sys/devices/virtual/powercap']` —— 即从 Docker 的默认列表里**去掉
  `/proc` 下的全部条目**，`/sys` 那两条保留。
- **理由**：D28 装 bwrap 是**必要但不充分**的。dsh 的探测跑的是
  `bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true`，
  在平台加固下报 `Can't mount proc on /proc: Operation not permitted`。根因不在 bwrap
  缺不缺 capability：Docker 默认的 masked/readonly 列表含 `/proc` 下的条目，bwrap 在新
  PID namespace 里建 procfs 会被它们挡掉。实测矩阵（同一镜像、同一内核）：

  | 容器配置 | 探测 |
  |---|---|
  | `CapDrop: ALL` + `no-new-privileges`（当时平台现状） | FAIL |
  | 同上 + `--cap-add SYS_ADMIN` / `--cap-add ALL` / `seccomp=unconfined` / `apparmor=unconfined` | 全 FAIL |
  | `--privileged` | OK |
  | 只清 `/proc` 下的屏蔽、保留 `/sys` 两条 | **OK** |

  另测：只留 `/proc` 条目 → FAIL，只留 `/sys` 条目 → OK；清掉任一侧都不够，必须两侧的
  `/proc` 条目都去掉。
- **备选**：① `--privileged`——否，架构 §五明令禁止；② 加回 capability（含 SYS_ADMIN）
  ——否，实测无效，说明不是权限级别问题；③ 恢复 bwrap 的 setuid 位——否，
  `no-new-privileges` 本来就会忽略它，且上一条已证 SYS_ADMIN 都没用；④ 用 dsh 的
  `runnerCommand` 配置绕开内置 profile——否，那要平台自己重实现沙箱 profile，脆弱，
  且违背「不越过 dsh 管沙箱」的立场（D28）。
- **代价**：丢掉一批 `/proc` 下的屏蔽。其中只有 `/proc/sched_debug` 是全局可读（可能泄漏
  内核指针、削弱 KASLR）；其余（`/proc/kcore`、`/proc/keys`、`/proc/timer_list`、
  `/proc/latency_stats`、`/proc/timer_stats`、`/proc/acpi`、`/proc/asound`、`/proc/scsi`
  等）都是 root-only `0400`，而实例当时以 uid 1000 跑且 `CapDrop: ALL`，够不到（**现在两者都不是**：
  实例以 root 跑、也没 drop capabilities，见本条开头）；`/proc/sys`、
  `/proc/bus`、`/proc/fs`、`/proc/irq` 那几条只读保护同样因非 root 而不可写。这层是
  纵深防御，不是跨实例边界——边界仍是容器（D1），内核残余风险本就已接受（§四）。
- **重审**：宿主内核开始带 Landlock 时（bwrap 那档可以退场，屏蔽可以加回来）；或 dsh 改了
  bwrap profile args（不再要求新 PID namespace 时）。**原生 Linux 上复验过了（2026-09-16）**：
  不需要这处改动 —— bwrap 在容器里根本起不来，与 masked/readonly 列表无关；生产上真正兜住
  沙箱的是 **Landlock 那一档**（见本条开头那个 ⚠️）。

## D31 · 删除就是删除：数据真删，主机名留给原 owner

- **决策**：用户面只有一个删除动作 —— **删容器、删访问地址、删数据（含升级快照）、清配额账**，
  不可恢复；确认方式沿用从前「彻底删除」那套（手打子域名）。取消"删除但保留数据"这条路，
  也**不做回收站**。唯一留下的是**主机名**：那一行不删，退役成占位并继续绑定原 owner
  （`createInstanceRecord` 查同 slug 的**任意行**，含已删除的），本人可同名重建，别人不行。
- **理由**：
  1. **用户说"删除"，就该是删除。** 从前的实际体验是：点「删除」→ 实例从列表消失 → 用户以为
     数据没了；而数据其实一直躺在宿主上，界面里没有任何入口能看到它，`findInstanceById` 又过滤掉
     了已删除的行（连 purge 都够不到）。于是想找回只能找运营"核验" —— **既占着空间，又不由用户
     掌控**，比"真删"和"能恢复"都糟。
  2. **想留着的人本来就有别的表达方式**：「停止」就是"留着但不跑"，而且可见、可控、随时再起来。
     删除不必兼职当"保留"。
  3. **主机名必须继续绑定原 owner**（D24 的理由）：域名一旦回收给另一个租户，上一个租户在这个
     域名下的浏览器状态（cookie / localStorage / service worker）就被继承过去了。所以"数据没了"
     与"名字还是他的"是两件事，得分开处理。
  4. **不做回收站**：那是把"我们不敢真删"变成用户必须理解的一个状态；它要解决的只是手滑，而手滑
     该由删除当下的确认来挡（手打子域名），不是事后 30 天的中间态。
- **备选**：① 回收站 + 保留期（否——把内部的不确定变成用户的负担，误解成本更高）；② 保留数据并
  补一个"恢复"入口（否——用户要的是删干净；托管方不该替他保管还悄悄扣着空间）；③ 硬删整行、连
  主机名一起释放（否——浏览器状态继承，见理由 3）；④ 保留期到期自动 purge（否——同 ①，还多一个
  没人记得住的定时器）；⑤ **导出**（想要数据的人需要一条明路 —— 那是**另一个功能**，不是删除的
  替代，目前未实现）。
- **代价**：① **没有恢复路径**：手滑就是真丢，所以确认必须够重（手打子域名，文案写明不可恢复）。
  ② 主机名只增不减、**永远没有自动释放的时机** —— 要彻底释放得运营手工处理。
  ③ 删除要多做几步（真删数据目录 / 快照 + 清配额账），而那条路本来就要停容器，感知差异不大。
- **重审**：用户开始要求"误删恢复"，或平台要做备份 / 归档（M2）时 —— 那时恢复的正当来源是**备份**，
  不是"留着没删干净"。

## D32 · 平台镜像：一个容器，控制面同源提供管理台

- **决策**：平台自己也出镜像（`ghcr.io/<owner>/dsh-cloud`，多架构，CI 构建推公开 GHCR，交付形态同
  D22 的实例镜像）。镜像里**一个**进程跑控制面，并
  **同源**提供管理台静态文件（`@fastify/static`，`WEB_DIST_DIR=/app/web`）。本地开发那条路不变：
  `WEB_DIST_DIR` 留空 = 该路由根本不注册，管理台仍由 Vite dev server 提供。
- **理由**：
  1. 仓库里现在**只有实例镜像**（`docker/instance-image/`）。控制面靠 `tsx` 解释执行、管理台靠 Vite
     dev server —— 两者都不是能装到别人机器上的形态。「一键安装」缺的其实是这一步，不是安装脚本。
  2. **同源**省掉第二个容器或 nginx：管理台与 `/api` 同源之后，CSRF 面、受信 `Origin` 白名单、cookie
     域都不需要额外分支，本地 Vite `server.proxy` 的语义也原样落到生产。
  3. 走 CI 而不是「宿主上构建」：宿主不需要 Node / pnpm / 仓库源码，产物可复现、按 tag 固定。
- **备选**：① 管理台单独一个 nginx 容器（否——多一个容器加一份配置，只为发几个静态文件）；
  ② 在宿主上构建平台镜像（否——把工具链和源码带到每个宿主，构建耗时压在安装路径上）；
  ③ 继续拿 `pnpm dev` 当交付（否——那是开发栈）。
- **代价**：① 多一个 GHCR 包，安装要能连 GHCR（预检项）；② 运行镜像必须带 `xfsprogs` 与 `util-linux`
  —— 控制面直接 shell 出 `xfs_quota` / `mkfs.xfs` / `losetup`（`instance/pool.ts`），不是纯 Node 镜像。
- **重审**：管理台要做成可独立替换的部署单元（多前端 / 灰度），或静态资源要交给 CDN 时。

## D33 · 生产入口用 host 网络

- **决策**：生产拓扑里 **Traefik 与控制面都 `network_mode: host`**，Postgres 单独一个 bridge 网络、
  只发布到 `127.0.0.1`。实例容器不变（桥端口发布到宿主回环）。
- **理由**：实例端口发布在**宿主回环**上，所以入口必须**就在宿主的网络命名空间里**才够得到它。
  这是 [OPEN-QUESTIONS #4](OPEN-QUESTIONS.md) 实测（2026-09-12，Debian 12 / Docker 29）逼出来的：
  Linux 上容器既够不到宿主回环、也够不到别的容器发布到 `127.0.0.1` 的端口（全 `ECONNREFUSED`）；
  够得到的是 Docker Desktop 的 `host.docker.internal`（代理到宿主 localhost）——**那是开发机特性，
  不是 Docker 通例**。`local.yml` 的入口拓扑正架在那条特性上，所以**不能照搬到 Linux**。
- **备选**：① 把实例端口发布到 `0.0.0.0`（否——跨实例边界从「发布到回环」退化成「网络可达」，
  只剩每实例门 token 兜底）；② 落地 D3（**可行但推迟**
  ——`TRAEFIK_CONTAINER` 至今是死变量，D3 从未实现；它要给每建一个实例多一次 `network connect`，
  并新增「入口能直连所有实例网」这个面）；③ 入口在宿主上裸跑、不进容器（否——那就得在宿主上装
  Traefik 并自己管生命周期，与镜像化交付冲突）。
- **代价**：① `80` / `443` 以及控制面的 `:3000` 在宿主上必须空闲（预检拦）；② 入口层没有容器网络
  隔离，控制面直接绑宿主回环。可接受：要守住的那条边界是**实例**，而 Linux 上实例仍然够不到宿主回环。
- **重审**：多机 / 入口不在本机时（入口与实例不再同一网络命名空间，得回到 ② 或引入覆盖网络）；
  或 Docker 给出让容器安全访问宿主回环的机制时。
- **2026-09-15 更新**：备选② 那件事还没做——`TRAEFIK_CONTAINER` 仍然是死变量。但 **D37 落地了**，
  别把两件事混起来：D37 只让**实例容器自己**各占一个网络
  （`dsh-net-<slug>`），入口这条路一点没动，仍是"发布到宿主回环 + 入口转发"。
  唯一的交集是：实例网络多了，备选② 真要做时 `network connect` 的目标从默认 bridge 换成
  `dsh-net-<slug>`。

## D34 · TLS 默认逐主机 ACME HTTP-01，通配证书推迟

- **决策**：默认给**每台主机**单独签一张 Let's Encrypt 证书 —— 控制台一张、每个
  `<slug>.<BASE_DOMAIN>` 一张，走 **HTTP-01**（challenge 落在 `web` entryPoint）。
  `certificatesResolvers` 写在 Traefik **静态配置**里（安装脚本渲染 ACME 邮箱），
  `TRAEFIK_CERT_RESOLVER=le` 传给控制面。逃生口 `--no-acme`：resolver 留空 + 自备证书丢进
  file provider（等价 D26 那一档，只是搬到生产）。
- **理由**：
  1. **通配证书**只能走 DNS-01，而 DNS provider 的选型与凭据管理正是 #6 卡住的地方；但通配
     **A 记录**（`*.<BASE_DOMAIN> → 本机`）任何 DNS 服务商都支持、不需要 API。于是逐主机 HTTP-01
     就能拿到真证书。
  2. 实例侧**不用改代码**：`index.ts` 已经按 `TRAEFIK_CERT_RESOLVER` 发 `tls.certResolver`，只需设值。
  3. 结果是 **#6 不再是「能装」的阻塞项** —— 降级为推迟项（见 [OPEN-QUESTIONS](OPEN-QUESTIONS.md) §二）。
- **备选**：① DNS-01 通配（**推迟**——要选 provider、把 DNS API 凭据交给平台容器、还要处理凭据轮换）；
  ② 自签 + 让用户手工信任（否——生产不该顶着红锁）；③ 边缘终结，CDN / 反代持证书（部分部署下合理，
  就是 `--no-acme` 那条）；④ 全站 `tls: {}` 吃默认自签证书（否——同 ②）。
- **代价**：① `80` 必须对公网可达，否则签不下来；② Let's Encrypt 每注册域**每周约 50 张**上限 ——
  一个实例一张，邀请制规模够用，实例数上去会撞到；③ `acme.json` 必须持久化（重启不能变成重签风暴）
  且权限 `600`。
- **重审**：实例数逼近频率上限、或宿主 `80` 不可达（家宽封 `80`、只放 `443`）时 —— 那时回到 ①。
- **2026-09-14 更新**：装机不再问了，所以 ①**ACME 邮箱**没有了（`--email` 删掉，渲染时把
  `email:` 那行直接删）—— 证书照签，丢的只是过期提醒，而 Traefik 自己会续签；
  ② **`--no-acme` 逃生口删掉了**（装机不再给配置入口）。自备证书那条路要回来得换个入口
  （控制台设置或安装后的手工步骤），现在只有 ACME 一条。

## D35 · 存储池由安装器在宿主上预置，控制面只拿 CAP_SYS_ADMIN

- **决策**：池子（XFS + `pquota`，或 D18 的
  loopback 镜像形态）由**安装脚本在宿主上**建好并**持久化**（`fstab` 或 systemd mount unit，重启后仍在）；
  控制面容器**只做能力探针和设配额**，给 `cap_add: [SYS_ADMIN]`，**不用 `--privileged`**。
- **理由**：
  1. `xfs_quota limit`（写配额）要 `CAP_SYS_ADMIN`，**缺权限时是静默失败**（`index.ts` 的注释就是
     为这条写的：带着"看起来有配额"跑着，比直接报错糟得多）。这条写路径必须在容器里真的能成功，
     给它一个 capability 是让 `pool.ts` 的探针**有意义**的前提。
  2. **建池不能进容器**：容器命名空间里 `mount` 出来的块设备，**宿主和 Docker daemon 都看不见**，
     实例 bind `${HOST_STORAGE_ROOT}/<key>` 时会解析到空目录 —— 那是 D18 那种静默失效的翻版，
     而且更隐蔽（探针在容器里是成功的）。宿主的事交给宿主做。
- **备选**：① `--privileged`（否——`SYS_ADMIN` 是这条路径的最小集，§五 明令禁止 privileged 那一档）；
  ② 恢复那个被删掉的 `nsenter` 助手容器（否——往宿主命名空间里钻，比直接给一个 capability 更难审计）；
  ③ 容器内建 loopback 池（否——见理由 2）。
- **代价**：① 控制面带 `CAP_SYS_ADMIN` **又挂着 `docker.sock`**，等于宿主 root —— 这本来就已经是宿主
  root（`docker.sock` 本身就是那个权限），**不新增信任面**，但必须在文档里讲明白，别让「控制面跑在容器里」
  听起来像隔离；§五 那条禁令说的是**实例**，不是控制面；② 安装器要在宿主上做挂载并写持久化，
  比纯 `compose up` 多几步，幂等更难做对。
- **重审**：宿主换 btrfs squota（[#7](OPEN-QUESTIONS.md) 已实测通过，不需要 loop 建池）时；
  或 Docker 原生支持 XFS project quota 时。

## D36 · 不填域名也能装：引导态 + 在面板里配域名

- **决策**：装机**可以不给** `--domain`。不给就是**引导态**：控制面照旧只听宿主回环
  （`127.0.0.1:3000`，绑定一行不改），暴露面是 `:80` 上**一条控制面自己写的动态 catch-all
  router**（`dynamic/bootstrap.yml`），唯一入口是 token 门保护的 `/setup`。操作者填域名后：
  写 `platform_setting` → **立刻删掉那条 catch-all（暴露当场关闭）** → 重启自己换身份
  （cookie 域与 better-auth 的 baseURL 都是**启动期**配置）。
  域名的来源固定为：**env 优先 → DB 其次 → 都没有才是引导态**。
- **理由**：
  1. 装机那一步是「一键部署」最后的摩擦。域名确实不是门牌、是身份模型的一部分（父域 cookie
     覆盖控制台与全部实例子域），**但"必须在装机时给"不是身份模型的要求** —— 那只是当初实现
     （安装脚本渲染静态 router + `env.ts` 硬校验）的产物。
  2. 三条实测（2026-09-13，真 Traefik **v3.5.6**）把形态定死了：① 静态
     `entryPoints.web.http.redirections` 会把 `:80` 上**所有**请求 301 掉，连我们的 catch-all
     一起 —— 所以跳转**必须**是动态的；② 动态 `redirectScheme` + `service: noop@internal`
     可用（v3.5 认）；③ ACME HTTP-01 的挑战路径由 Traefik **内部先接管**，既不被跳转拦、
     也不落到 router。结论：跳转搬到动态侧之后，「引导期没有跳转 / 配好后出现」都只是写文件。
  3. **暴露面靠"删一条路由"关闭**，不是靠改绑定或重启：删文件即摘除（同实测）。所以
     「配完就关」是免费的，而且**先投影关暴露、再重启**这个顺序让最坏情况（重启失败）也是安全的。
  4. **一次性 token**，而不是「首个注册者当管理员」：公网机器上后者等于"谁先扫到谁当管理员"，
     与邀请制定位（D20、拒绝公开注册）直接冲突。
- **备选**：① 像同类平台那样把面板直接绑在公网端口、不做门（否 —— 见理由 4；而且要么多开一个
  防火墙口，要么事后靠重启换绑定）；② 给引导期上 HTTPS（LE 的 IP 证书已 GA，但 6 天有效、
  Traefik 对 IP 标识符的支持还不完整 —— 为几分钟的窗口不值得）；③ 只给 SSH 隧道引导
  （否 —— 把门槛从"会配 DNS"换成"会 SSH 端口转发"，没更简单）；④ 把 cookie 域动态化，省掉
  那次重启（否 —— 那是动认证链路，按铁律另议）。
- **代价**：① 引导期是**明文 HTTP 直接对公网**，唯一屏障是那枚 token（单次、配完即失效）——
  所以引导态的**路由面必须保持极小**，`route-surface.test.ts` 有一份专门的白名单盯着它；
  ② 配完域名要**重启一次控制面**（秒级；实例不受影响），且此刻已登录的会话会因 cookie 域变化失效；
  ③ 泛解析仍然要操作者自己配（不接 DNS API，见 [#6](OPEN-QUESTIONS.md)），面板只**检查并警告**；
  ④ 控制面从写一个动态文件变成写三个（`platform.yml` / `redirect.yml` / `bootstrap.yml`），
  每次启动按状态幂等对齐。
- **重审**：接上 DNS API 时（#6）—— 那时面板能自己写记录、甚至签通配证书，引导期可以更短；
  或 cookie 域做成运行时可换时（那次重启也省了）。
- **2026-09-14 更新**（结论不变，形态变了）：
  ① 装机**只有一条路** —— `--domain` / `--email` / `--admin-email` 三个参数删掉了，装机不问
  域名、也不建账号，控制面**总是**以引导态起来；
  ② 引导口不再是"`:80` 上一条 catch-all"，而是控制面**自己在专用端口上对外**（引导态绑
  `0.0.0.0`，端口从 3000 起自动挑第一个空闲的，安装脚本只打印那一行地址）—— `:80` 那条
  catch-all 保留，作为"防火墙只放行 80/443"的机器的第二条路；
  ③ **首个管理员也由引导页建**（先建号、再落域名），所以 `seed_admin` 从装机路径上消失了
  （`scripts/seed.ts` 留着做恢复与本地开发）；
  ④ 域名的来源只剩 DB —— env 那两项装机时**恒为空**，那条优先级留给本地开发与手工覆盖。

## D37 · 每实例一个 Docker 网络

- **决策**：驱动建容器**之前**先 `ensureNetwork`，实例落在**自己的 bridge 网络** `dsh-net-<slug>` 上
  （`HostConfig.NetworkMode` 一项就够，实测容器真的落到那个网络上）；实例删掉时网络一起删。
  **网络建不出来就抛错，不退回默认 bridge。**
- **理由**：接在默认 `bridge` 上，所有实例同处一个 L2 广播域。实测（2026-09-15，Docker 28.0.1）：
  在实例容器里 ARP 扫 `172.17.0.0/16`，`172.17.0.2` / `172.17.0.3` 的 `:8080` 都有响应。
  于是三件事一起成立——直连邻居端口、扫邻居端口、ARP 欺骗；而这条路上唯一一道门是容器内 Caddy
  的 header 门（D8 门③），它认的那枚 token 正好**明文过桥**（TLS 在入口就终结了），
  同网段容器骗下宿主→邻居那条链路就能抓走。网络分开之后这三条同时消失：跨网段地址不可达，
  实例里 `ip neigh` 连邻居的表项都没有。
- **备选**：① 留在默认 bridge 上、靠宿主 iptables 分隔（否 —— Docker 自己会写 inter-bridge
  规则，但 `firewalld` reload 会把这些规则冲掉且 Docker 不重建（CVE-2025-54410，
  `≤ 25.0.12` 与 `26.0.0-rc1`–`27.x`），隔离**静默失效**）；② 起 `--internal` 网络
  （否 —— 实例要出网装包，`--internal` 把出网一起切了）；③ 把实例端口发布到 `0.0.0.0`
  （否 —— 见 D33 备选①）；④ 每实例一个自定义 bridge 网络（**采用**）。
- **代价**：① **网络数 = 实例数**，而默认地址池分不了几个网络 —— 实测（2026-09-15）
  在 Docker Desktop 28.0.1 上**只够 12 个**，第 13 个回
  `all predefined address pools have been fully subnetted`；Linux 真机（dockerd 29.8.0、没配
  `default-address-pools`）2026-09-15 量到的是**池子共 15 个 /16**（172.17–172.31，每个自建网络
  吃一整个 /16，从 172.18 起逐个分配）—— 换成 `size: 24` 之后是几千个（照做步骤见
  [SECURITY-HARDENING](SECURITY-HARDENING.md)）。
  所以这条失败路径必须可读：`networkCreateError` 保留 daemon 原文，再补一句改
  `default-address-pools` 的 `size` 的照做动作。**安装脚本不自动改 `daemon.json`** ——
  那要动宿主 Docker 的配置并重启它，为一件还没撞上的事不值；② 每个网络多占一个子网、一个网关地址
  和几条 Docker 写的 iptables 链（隔离正是靠它）；③ **只对新容器生效** —— 存量实例仍是默认
  bridge 上那个容器，隔离要等它被重建（控制台重启 / 换镜像 / 改配额都会重建）。
- **重审**：实例数逼近地址池容量时（那时要么让安装脚本扩池、要么换覆盖网络方案）；
  或 Docker 原生给出"每容器独立 L2"的开关时。
- **2026-09-15 更新**：这条**不是** D33 备选② 说的"落地 D3"。D3 讲的是把**入口**接进每个实例网络
  （`TRAEFIK_CONTAINER` 那个变量），本条只改**实例容器自己**落在哪个网络上：入口那条路一点没动，
  仍是「实例端口发布到宿主回环 + 入口转发」，D33 备选② 保持推迟。
  另外**它不解决同一个宿主的暴露面**：容器仍然够得到宿主上绑非回环地址的服务
  （Linux 上容器→宿主是 INPUT 路径），这跟网络分段是两件事 —— 那条留给 `install.sh --harden-host`，
  默认不写。
