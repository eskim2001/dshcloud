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
