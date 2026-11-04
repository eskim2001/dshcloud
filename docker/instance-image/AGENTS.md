# 实例镜像：dsh 版本升级检查清单

这个目录里的 `Dockerfile` 和 `entrypoint.sh` 对 **DeepSeek Harness 的内部行为**做了一批假设。
dsh 是快速迭代的上游，这些假设会**悄悄失效**——构建自检大多测不出来，
症状通常落在「实例起来了但功能坏掉」。

**每次升 `VERSION` 里的 dsh 版本，把下面「假设表」过一遍。**

## 怎么查：读镜像里的源码，不要翻 GitHub

dsh 的源码就在构建出来的镜像里，**比仓库准**——那是我们实际要发的那一版。

```bash
docker build -t dsh-check --build-arg DSH_VERSION=<版本> --build-arg REVISION=check docker/instance-image
docker run --rm --entrypoint sh dsh-check -c 'ls /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
```

包分两处：`@deepseek-ai/dsh/lib/`（启动器本体）与 `…/dsh/node_modules/@deepseek-ai/`（各功能包）。
每个包自带中英 README（讲设计意图），`lib/*.js` 是实际行为——**对不上时以代码为准**。

## 假设表

| # | 假设 | 依赖位置 | 失效症状 |
|---|---|---|---|
| 1 | 入口 token 的生成方式与寿命 + cookie 名字前缀 | `entrypoint.sh` 抓取、`Caddyfile` 的 `@first` / `@heal` | 首页 401；cookie 契约一变则**重定向死循环** |
| 2 | 启动输出里 `token=` 那行的格式 | `entrypoint.sh` 的 sed | 同上（抓不到 token） |
| 3 | CLI 顺序：`dsh web --patch X --host Y` | `entrypoint.sh` 的命令行 | `error: unknown option`，实例 crash-loop |
| 4 | `owns-host.mjs` 依赖的事件名 `webserver/index-inject` | 平台插件 | **设置面静默失效**（无报错） |
| 5 | 客户端用 `window.__DSH_TRANSPORT__.ownsHost` 判 `isLoopback` | 同上 | 同上 |
| 6 | `/api` 信任围栏读 `--trusted-host` | `DSH_TRUSTED_HOSTS` | 页面能开、API 全 403 |
| 7 | 会话目录名编码 cwd | `entrypoint.sh` 里 `cd "$HOME/workspace"` | 用户「历史会话全没了」（实际还在，换了前缀） |
| 8 | 进程沙箱候选链 `bwrap → Landlock → fail closed` | 镜像里同时装 bwrap、且依赖 Landlock | 实例里**任何命令都执行不了** |
| 9 | `dsh --version` 输出格式 | `Dockerfile` 构建自检 | 构建失败（响亮） |
| 10 | `node-pty` 仍是依赖、仍要编译 | `Dockerfile` 构建自检 | 构建失败（响亮） |
| 11 | `dsh plugin` 转发给 pnpm | 镜像里有可用 pnpm 的理由 | 插件功能不可用 |

只有 #9 #10 有自动防线，**其余都得手工**。

---

## 本轮已确认（2026-09-12，dsh 0.1.5-rc.2）

### #1 / #2 入口 token

源码 `@deepseek-ai/dsh-client-connection/lib/index.js`：

```js
const SECRET_BYTES = 32;
const DAY_MILLISECONDS = 1440 * 60 * 1e3;
const PROCESS_LAUNCH_TOKENS = new WeakMap();        // ← 进程内记忆

function processLaunchToken(owner) {
	const existing = PROCESS_LAUNCH_TOKENS.get(owner);
	if (existing !== void 0) return existing;
	const created = encodeBase64Url(randomBytes(SECRET_BYTES));
	PROCESS_LAUNCH_TOKENS.set(owner, created);
	return created;
}
```

| 维度 | 事实 |
|---|---|
| 生成 | `base64url(randomBytes(32))` = 256 bit → **43 字符** |
| 寿命 | 进程内记忆（WeakMap 按 owner）→ 重启换新 |
| 出口 | **只打印一次**（`ANNOUNCED_ROOTS` 拦重复），且只有 stdout 这一个——不落盘、无 IPC |
| 比较 | `timingSafeEqual` + 等长校验 |
| 交换 | `GET /` + 恰好一个 `token` query + authority 合法 + 匹配 → 下发签名 cookie |
| cookie 寿命 | **默认 30 天**（`cookieMaxAgeDays`，可配） |
| cookie 名 | `dsh-auth-<base64url(sha256(authority))>` → 按域名分名 |
| cookie 属性 | `Max-Age; Path=/; Expires; HttpOnly; SameSite=Strict`（**无 Secure**） |
| 签名密钥 | 持久化在 `/data/.credentials.yaml` → 活过重启和升级 |

喂给 agent shell 的 `DSH_WEB_URL` 是**不含 token** 的干净 URL——token 只在那一行 stdout 里。

**三条影响**：

1. **token 每次启动换新** → 每次重启后都要重新引导一次。现在 Caddy 在「无 cookie 的
   `GET /`」上注入 `DSH_LAUNCH_TOKEN`（entrypoint 每次启动重新抓），是对的——**别改成缓存的**。
   ⚠️ 这条依赖**两个** cookie 事实：名字前缀是 `dsh-auth-`、且「cookie 失效时还能被重新
   引导」。Caddy 验不了签名，「cookie 在但无效」由 401 自愈（`@heal`）兜底。
   **dsh 一旦改 cookie 名字、或不再下发 cookie，症状会变成首页 303 死循环**（不再出现在
   401 断点上）——看 `docker logs` 里 Caddy 的 303 洪水确认。
2. **cookie 活 30 天且跨升级有效** → 用户升级实例后不会被登出。是否预期，需产品确认。
3. **cookie 按 authority 命名** → 换公开域名 = 所有人重新登录。

### #3 CLI 顺序（实测）

| 写法 | 结果 |
|---|---|
| `dsh web --patch <path> --host …` | ✅ |
| `dsh --patch <path> web --host …` | ❌ `error: web takes none of parent --profile, --from-default-profile, --patch, …` |
| `dsh --profile web --patch … --host …` | ✅（老写法，等价） |

**规则**：子命令在前，`--patch` 跟在子命令后、但在 app 参数（`--host` 等）之前。
顺带：`dsh web` 就是 `--profile web` 的官方别名。

### #4 / #5 平台插件 owns-host

`owns-host.yml` 往配置树顶层插一个条目（`--dump-config` 可见，占 3 行）；
`owns-host.mjs` 监听 `webserver/index-inject`，注入 `window.__DSH_TRANSPORT__ = {ownsHost: true}`。

客户端据此判 `isLoopback`。为假时 `persistence` 变成 `memory`，
**设置既不读 Host 也不写 Host**（`enqueue` / `load` / `ensure` 三处直接 return），
「设置文档」视图也不挂载 → **用户配不了模型**。这就是我们要注入它的理由。

⚠️ **失效是静默的**：事件名或判定逻辑一变，插件加载了却什么都不做，没有任何报错。
验证手法：起个实例，页面里 grep `__DSH_TRANSPORT__`（带 patch 有、不带没有，实测差 68 字节）。

### `--expose-internals`（HMR；0.1.6-alpha.1 仍需要）

早期 entrypoint 用 `node --expose-internals "$(command -v dsh)" --profile web` 启动，
理由是「HMR 插件构造时硬校验这个 flag」。**2026-09-12 对 0.1.5-rc.2 曾记为「不需要」——对当前 npm `@deepseek-ai/dsh@0.1.6-alpha.1` 错误。**

`@deepseek-ai/cordis-plugin-hmr` 在 `lib/index.js` 仍检查 `process.execArgv` 是否含 `--expose-internals`；
缺则实例崩溃：`(@deepseek-ai/cordis-plugin-hmr): --expose-internals is required for HMR service`。

entrypoint 已用 `NODE_OPTIONS=…--expose-internals` 注入（不改 `dsh web` CLI，也不走 `node $(command -v dsh)`），
避免 pnpm bin 是 shell 脚本时的 SyntaxError。升 dsh 版本时再实测一次是否仍硬校验。

---

## 升级时怎么跑

```bash
# 1. 改 VERSION 里的 dsh 版本号
# 2. 构建（自检覆盖 #9 #10）
./docker/instance-image/build.sh
# 3. 手工过一遍假设表里其余那些
docker run --rm --entrypoint sh <镜像> -c '<逐条查>'
# 4. 真跑一个实例，浏览器里交互一遍
docker run -d -p 18080:8080 -e DSH_TRUSTED_HOSTS=localhost:18080 <镜像>
#    打开 http://localhost:18080/
```

**第 4 步不能省。** 构建自检只证明「dsh 装上了、node-pty 能加载」，
证明不了「页面能用」——`--expose-internals` 就是典型：带不带都能构建成功。
