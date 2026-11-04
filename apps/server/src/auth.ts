import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins/admin'
import { userAc } from 'better-auth/plugins/admin/access'
import type { Db } from './db/client.js'
import { trustedOrigins, type Env } from './env.js'

/**
 * better-auth 的 baseURL。
 *
 * **域名空的时候必须是占位值**：`${PUBLIC_SCHEME}://` 拼出来就是 `"https://"`，better-auth
 * 建上下文时 `new URL()` 直接抛（实测：引导态下 `seed` 就死在这儿）。所以这不是调用方的
 * 策略选择，而是**前置条件** —— 一律兜到这里，别指望每个调用点都记得传 `bootstrap`。
 */
export function authBaseUrl(env: Env): string {
  return env.CONSOLE_DOMAIN === ''
    ? `http://127.0.0.1:${env.PORT}`
    : `${env.PUBLIC_SCHEME}://${env.CONSOLE_DOMAIN}`
}

/**
 * 平台账号体系。**只服务控制面**（`CONSOLE_DOMAIN`）。
 *
 * 控制台 Cookie 不发送到工作空间；工作空间由网关兑换独立会话。
 *
 * 引导态仍由 authBaseUrl 提供占位地址；所有模式均禁止跨子域 Cookie。
 */
export function createAuth(env: Env, db: Db, _opts: { bootstrap?: boolean } = {}) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: authBaseUrl(env),
    basePath: '/api/auth',
    database: drizzleAdapter(db, { provider: 'pg' }),
    trustedOrigins: trustedOrigins(env),
    // 公开注册**关闭**。装平台的人 = 用平台的人，「谁能进来」是 owner 自己的事：
    // 开着注册等于让陌生人到你服务器上开号、建容器、吃 CPU 和磁盘。
    // 账号只有两条路产生——seed 的第一个 owner，和 owner 发的邀请链接；
    // 两条都走 createUserWithPassword（src/account.ts），绕过这个开关。
    emailAndPassword: { enabled: true, disableSignUp: true },
    // 进程内内存桶即可：单机控制面，不做跨进程计数，也不为限速加表。
    // 总窗口 60s；登录 / 注册比其余 auth 路径更紧，挡住对口令的在线穷举。
    // 库默认只在 production 打开，这里显式打开，避免开发和生产各是一套。
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: 'memory',
      customRules: {
        '/sign-in/*': { window: 60, max: 10 },
        '/sign-up/*': { window: 60, max: 5 },
      },
    },
    plugins: [
      // 平台管理员（运营方）。它带来 role / banned 字段，并让 better-auth
      // 在建会话时**拒绝**被封禁的用户——封禁因此是真的封禁，不只是标记。
      admin({
        defaultRole: 'user',
        adminRoles: ['admin'],
        roles: { admin: userAc, user: userAc },
      }),
    ],
    advanced: {
      // 显式指定，别让 better-auth 按请求 Host 猜（实例子域上的请求也会打到它）
      cookiePrefix: env.PUBLIC_SCHEME === 'https' ? '__Host-dsh_cloud' : 'dsh_cloud',
      // Supply __Host ourselves; better-auth otherwise prepends __Secure-.
      useSecureCookies: false,
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: {
        httpOnly: true,
        secure: env.PUBLIC_SCHEME === 'https',
        sameSite: 'lax',
        path: '/',
      },
      // 只认桥接层写入的那一个头。默认列表今天也只有 x-forwarded-for，
      // 但库若把 cf-connecting-ip 加回去，伪造头又能拆桶。不要关掉 IP 追踪。
      ipAddress: {
        ipAddressHeaders: ['x-forwarded-for'],
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
