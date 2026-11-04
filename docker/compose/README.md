# 本地入口栈

`local.yml` 是**唯一**的本地栈：Postgres + Traefik 接入 + 认证前置，跑通「经真实入口访问」——
登录 → 打开实例，并覆盖线上真实的 TLS 与 cookie 条件。

> 生产栈是隔壁的 `prod.yml`（入口与控制面走 host 网络、Postgres 只发布到宿主回环），
> 由 `scripts/install.sh` 装；两者拓扑的差异与理由见 [docker/platform/README.md](../platform/README.md) 与 D33。
> **本文只讲本地**，其中的 `host.docker.internal` 那套是 Docker Desktop 特有的，别搬到生产。

正常不用手工操作：根目录 `pnpm dev` 会起它、等 Postgres 就绪、跑迁移和 seed，再起控制面和管理台。
本文是它坏了的时候的参考。

## 拓扑

```
浏览器 ── :443 ──> Traefik ──┬── Host(`lvh.me`)              → host.docker.internal:5173 (Vite：登录 / /admin / API)
                             ├── Host(`console.lvh.me`)     → 302 到 https://lvh.me（兼容别名）
                             └── Host(`<slug>.lvh.me`)      → forward-auth → host.docker.internal:<hostPort> (实例桥)
```

入口走生产那套：`websecure`（:443）终结 TLS，`PUBLIC_SCHEME=https`、会话 cookie 带 `Secure`——和线上同构。
**不配证书**：Traefik 回落到它内置的默认自签证书（`CN=TRAEFIK DEFAULT CERT`，SAN 是一串随机 hex）。
浏览器会红锁，而且这张证书的主机名和 `lvh.me` 对不上——点「高级 → 继续访问」即可。想要绿锁得自己签一张
SAN 覆盖 `DNS:lvh.me,DNS:*.lvh.me` 的证书装进系统信任库；仓库默认不含这一步，因为不装信任库时自签证书
和默认证书一样是红锁，签它只是多一道工序。

控制面在**宿主**上，Traefik 和实例都跑在 **Docker** 里。实例把它的 bridge 发布到**宿主回环**
（`127.0.0.1:<hostPort>`，端口由控制面从 20000-31999 分配），所以容器里的 Traefik 摸实例
要经 `host.docker.internal`——和 forward-auth 那一跳同路。

## 为什么是 `lvh.me`

`*.lvh.me` 是公共通配 DNS，全网解析到 `127.0.0.1`。于是：

- **不需要本地 DNS 容器**，也不用改 `/etc/resolver`；
- 不会和 Clash 之类占用 :53 的程序撞车（早先用 CoreDNS 容器 + `/etc/resolver` 的方案已删掉）。

控制台放在父域顶点 `lvh.me`（`CONSOLE_DOMAIN=BASE_DOMAIN`），管理路径是 `/admin`。
实例是 `<slug>.lvh.me`。顶点 `Host(`lvh.me`)` 比实例子域少一个标签，租户抢不到这个主机名；
`console.lvh.me` 只跳回顶点。详见 [docs/FORK.md](../../docs/FORK.md)。

不能用 `.localhost`：Chrome 把 `Domain=.localhost` 的会话 cookie 存成 host-only
（Cookie Store API 里 `domain: null`），不会发给 `u1t.localhost`，于是「在控制台登录 → 打开
实例」在浏览器里必然被打回登录页。服务端链路是好的，坏的只是浏览器存 cookie 的域。

## 控制面配置

`pnpm dev` 生成 `apps/server/.env.local` 时用的就是这一组：

```dotenv
DATABASE_URL=postgres://dshcloud:dshcloud@127.0.0.1:55432/dsh_cloud
BASE_DOMAIN=lvh.me                                 # 父域：实例是 <slug>.lvh.me
CONSOLE_DOMAIN=lvh.me                              # 控制台主机名 = 父域；管理入口 /admin
PUBLIC_SCHEME=https
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_CERT_RESOLVER=                              # 空——没有静态证书，落到 Traefik 默认证书
FORWARD_AUTH_ADDRESS=http://host.docker.internal:3000/auth/verify
TRAEFIK_ROUTES_PATH=./traefik-dynamic/routes.yml    # 仓库内，compose 挂到 /etc/traefik/dynamic
INSTANCE_UPSTREAM_HOST=host.docker.internal         # Traefik 在容器里，实例后端必须经宿主
```

Postgres 的宿主端口是 `127.0.0.1:55432`（只绑回环），数据在 named volume `dsh-pgdata` 里——
`down` 不丢，`down -v` 才清空。

## 手工起停

```bash
docker compose -f docker/compose/local.yml up -d
```

```bash
docker compose -f docker/compose/local.yml down
```

控制面和管理台仍要自己起（两个终端，仓库根目录）：

```bash
pnpm --dir apps/server dev:local
```

```bash
pnpm dev:web
```

浏览器访问 `https://lvh.me/admin`（**不要用 `localhost:5173`**——主机名不对，会话在规范主机上）。
`https://console.lvh.me/` 会跳到顶点。

实例镜像不用本地构建：管理台「镜像管理」页点「同步」→ 对某个版本「下载」→「发布」→「设为默认」，
新建实例时会自动拉取。只有改了 `docker/instance-image/` 才需要
`./docker/instance-image/build.sh`。

## 会踩的坑

1. **Clash 的 PAC 会拦 `lvh.me`**：`curl` 通、浏览器打不开就是它。Verge → 订阅页 → 卡片 → 编辑规则，
   加 `DOMAIN-SUFFIX,lvh.me,DIRECT`（全局 `profiles/Merge.yaml` 的 `prepend-rules` 自 v1.7.x 起
   不生效）。

2. **改了入口静态配置要重启入口容器**（`docker/traefik/dynamic-dev/platform.yml`）：`platform.yml` 是
   单文件 bind mount，Docker Desktop 在容器创建时就把内容快照进 VM，之后宿主上的改动不会同步进去
   （表现为平台域名 404、容器里看到旧内容甚至被截断）。

   ```bash
   docker restart dsh-ingress
   ```

   实例路由不受影响——`routes.yml` 在目录挂载里，`watch: true` 会实时加载。

3. **入口容器重建（`up -d` / `down` 后重起）不影响实例路由。** 这里从前写着「Traefik 被接进每个
   实例网络（D3），重建后附着就没了、实例会 502，要重启控制面把它接回去」—— 那个机制**从未实现**：
   代码里没有 `attachIngress`，也没有任何容器网络 `connect`，实例容器也不设 `NetworkMode`。
   真实拓扑是实例把桥端口发布到**宿主回环**，入口按 `INSTANCE_UPSTREAM_HOST:<hostPort>` 转发过去
   （本地那份是 `host.docker.internal`；`local.yml` 的 `extra_hosts` 保证重建后仍然有它）。
   生产走 host 网络出于同一个理由（见 D33）。`restart traefik` 不重建容器，自然也不受影响。

4. **改了 `BASE_DOMAIN` 之后要重建实例容器**：`DSH_TRUSTED_HOSTS` 是建容器时写进环境的，
   旧容器还认旧域名。走 `POST /api/instances/:id/restart` 或管理台的「重建」，卷不受影响。

5. **端口被占**：`:80` / `:443` 是 Traefik 的，`:3000` / `:5173` 是控制面和管理台的，
   `:55432` 是 Postgres 的。除了 Postgres（本栈自己占着），其余被占 `pnpm dev` 会提前报错。
   找占用者：`lsof -nP -iTCP:443 -sTCP:LISTEN`。

6. **想从零重来**：

   ```bash
   docker compose -f docker/compose/local.yml down -v
   ```

   再删掉 `apps/server/.env.local`（它会重新生成两个 secret）。`down -v` 会**删掉数据库**。
