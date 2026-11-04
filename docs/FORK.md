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

**生产**：对外入口仍应是 Traefik（或其它反向代理）；不要把控制面业务端口直接暴露到公网。

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

本版只做**全局**资源封顶；每用户仍只有实例**个数**配额（`MAX_INSTANCES_PER_USER` / `user.instance_quota`），**未做**每用户资源封顶。
