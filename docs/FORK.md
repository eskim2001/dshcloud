# Fork / 小机部署备注

本仓库 fork 面向 **Linux 宿主 + 小机资源** 的自部署场景。相对上游的本地绑定与平台封顶说明如下。

## 控制面 / Vite 监听地址

本地开发拓扑常是：**Traefik 跑在容器里，控制面与 Vite 跑在宿主**。

| 环境 | `127.0.0.1` 回环对容器是否可达 |
|---|---|
| Docker Desktop | 可达（`host.docker.internal` 代理到宿主 localhost） |
| Linux Docker | **不可达**（host-gateway 如 `172.17.0.1` 摸不到宿主 loopback） |

因此默认：

- 控制面：`CONTROL_PLANE_LISTEN_HOST=0.0.0.0`（见 `apps/server/src/env.ts`）
- workspace-gateway：同一 `CONTROL_PLANE_LISTEN_HOST`（Traefik → `host.docker.internal:gatewayPort`）。勿与实例内 dsh `web --host`（保持 `127.0.0.1`）混淆
- Vite：`server.host = 0.0.0.0`（可用 `VITE_DEV_SERVER_HOST` 覆盖）

仅在 Docker Desktop、或反代与控制面同宿主且只走回环时，可改回 `127.0.0.1`。

### 生产建议

生产（反代与控制面同机）建议显式 `CONTROL_PLANE_LISTEN_HOST=127.0.0.1`，勿把业务端口直接对公网。对外入口仍应是 Traefik（或其它反向代理）。

Linux 开发（Traefik 容器 + 控制面宿主）常用 `0.0.0.0`：容器经 host-gateway 够不到宿主回环。代码默认保持 `0.0.0.0`，不因这条建议改掉开发拓扑。

这是**控制面进程**的监听地址。不要和实例里 dsh 的 `--host 127.0.0.1` 混在一起：后者是容器内 dsh 只听回环，由实例里的 Caddy 反代，跟 `CONTROL_PLANE_LISTEN_HOST` 不是同一个开关。

## `DSH_TRUSTED_HOSTS`

`DSH_TRUSTED_HOSTS` 在建容器时写入环境（见 `packages/instance-spec`）。公网域名的取值、以及改域名之后的回归，须由运维和 dsh 钉点确认，然后**重建实例**才会进到已有容器。本 PR 不改启动参数。

## 同域 `/admin`（M2）

浏览器管理入口是**父域顶点上的路径**，不再把 `console.` 子域当作唯一入口。

| 主机 | 作用 |
|---|---|
| `https://<BASE_DOMAIN>/admin` | **主入口**。登录、会话、`/api/*` 与管理台同一来源。`CONSOLE_DOMAIN` 可以就等于 `BASE_DOMAIN` |
| `https://console.<BASE_DOMAIN>/…` | 兼容别名。只在顶点模式下由 Traefik **302** 回顶点，不在上面建会话 |
| `https://<slug>.<BASE_DOMAIN>/` | 工作空间。比顶点多一个标签，`Host` 规则对不上控制台 |

为什么父域当控制台主机名抢不走：实例路由是 `Host(`<slug>.<父域>`)`，控制台是 `Host(`<父域>`)`，priority 1000。`console` 仍是保留 slug，别名那条规则同样 priority 1000。

开发态静态文件是 `docker/traefik/dynamic-dev/platform.yml`（`lvh.me` → Vite，`console.lvh.me` → 跳到 `https://lvh.me`）。生产由控制面 `projectPlatformRoutes` 投影同一形状；`WEB_DIST_DIR` 为空时（本地 Vite）控制面不写这份文件。

会话 cookie 仍是 host-only（`__Host-` / 不设 Domain）。写请求的 Origin 只信规范主机 `CONSOLE_DOMAIN`，不信 `console.` 别名，也不信实例子域。

已有的 `apps/server/.env.local` 若仍是 `CONSOLE_DOMAIN=console.lvh.me`，改成 `CONSOLE_DOMAIN=lvh.me` 再对上这份入口。`pnpm dev` 不会改已存在的 env 文件。

## 平台性能封顶（honcho 小机对齐）

| 变量 | 默认 | 含义 |
|---|---|---|
| `PLATFORM_MAX_CPUS` | `2` | 单实例 CPU 上限 |
| `PLATFORM_MAX_MEMORY_MB` | `2048` | 单实例内存上限 |
| `PLATFORM_MAX_PIDS` | `512` | 单实例 PIDs 上限 |
| `PLATFORM_MAX_DISK_MB` | `10240` | 单实例磁盘声明上限 |
| `PLATFORM_MAX_RUNNING` | `3` | 全局同时 `running` 上限；**`0` = 不限制** |
| `PLATFORM_IDLE_CULL_MINUTES` | `45` | 空闲回收分钟数；**`0` = 关闭** |

资源有三层，从宽到严取更小的那个：

| 层 | 存在哪 | 含义 |
|---|---|---|
| 平台封顶 | `PLATFORM_MAX_CPUS` / `MEMORY_MB` / `PIDS` / `DISK_MB` | 全站单实例硬顶。谁都不能越过 |
| 每用户封顶 | `user.cpu_quota` / `memory_mb_quota` / `pids_quota` / `disk_mb_quota` | NULL = 用平台。管理员写入必须 ≤ 平台；生效值 = min(平台, 用户) |
| 实例档位 | 创建或改配额时的 `cpus` / `memoryMb` / `pidsLimit` / `diskMb` | 这一档的具体数字，不得越过该用户的有效封顶 |

个数配额仍是 `MAX_INSTANCES_PER_USER` / `user.instance_quota`，和上面的单实例资源封顶分开。用户自助创建与管理员改实例都会再裁到 owner 的有效封顶；同时 running / 空闲回收仍是全站的，不按用户收。
