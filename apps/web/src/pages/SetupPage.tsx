import { useMutation } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { WhaleAnimation } from '@/components/whale-animation.js'
import './login.css'
import { LanguageSwitcher } from '@/components/language-switcher.js'
import { ThemeSwitcher } from '@/components/theme-switcher.js'
import { Alert, AlertDescription } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { Card, CardContent } from '@/components/ui/card.js'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field.js'
import { Input } from '@/components/ui/input.js'
import { ApiError, probeSetupDomain, submitSetup } from '../lib/api.js'

/**
 * 装机引导：**平台还没配域名时唯一能用的界面**。
 *
 * 这一步是**危险的**：域名一旦提交就落库，控制面带着它重启，会话 cookie 和 better-auth 的
 * baseURL 都按它定死。解析配错 = 控制台进不去，只能上 SSH 救。所以这一页的重点不是"解释清楚"，
 * 而是**让人在按下按钮之前就看见结果**：
 *
 * - 边打字边查泛解析（`/api/setup/probe`），没通就不让提交（要硬来可以，但得显式点一下）
 * - 要加的 DNS 记录**直接算好列出来**，带这台机器的地址，不用人去理解"泛解析"
 * - 出错贴到出错的那个字段上，不说教
 */
export default function SetupPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [typedDomain, setTypedDomain] = useState('')
  const [typedConsoleDomain, setTypedConsoleDomain] = useState('')
  const [override, setOverride] = useState(false)
  const { t } = useTranslation()

  // 走 IP 进来时才知道该把记录指向哪；用域名/内网名进来的，DNS 多半已经通了
  const host = window.location.hostname
  const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)

  // 从地址栏粘过来的是 `https://console.example.com/`，人也会打成大写 —— 先归一化再判断
  const domain = typedDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .replace(/[/?#].*/u, '')
    .replace(/\.$/u, '')
  // 留空 = 控制台就是父域，管理入口在 /admin。填了才用另一台主机。
  const consoleDomain = typedConsoleDomain.trim().toLowerCase() || domain
  const shapeOk = /^[a-z0-9.-]+$/u.test(domain) && domain.includes('.')
    && /^[a-z0-9.-]+$/u.test(consoleDomain) && consoleDomain.includes('.')

  const probe = useDomainProbe(token, domain, consoleDomain, shapeOk)
  useEffect(() => { setOverride(false) }, [domain, consoleDomain])
  const mutation = useMutation({
    mutationFn: () => submitSetup({ token, baseDomain: domain, consoleDomain, email, password }),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    mutation.mutate()
  }

  if (mutation.isSuccess) {
    const { consoleDomain, dns } = mutation.data
    return (
      <Shell>
        <h2 className="login-title">{t('setup.doneTitle')}</h2>
        <div className="flex flex-col gap-4 text-left">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t('setup.doneBody', { domain: consoleDomain, email: mutation.data.email })}
          </p>
          {!dns.resolved && (
            <Alert>
              <AlertDescription>{t('setup.doneDns', { probe: dns.probe })}</AlertDescription>
            </Alert>
          )}
          <p className="text-sm text-muted-foreground">{t('setup.doneClose')}</p>
        </div>
      </Shell>
    )
  }

  const error = mutation.error
  const blocked = probe !== 'ok' && !override

  return (
    <Shell>
      <h2 className="login-title">{t('setup.title')}</h2>
      <form onSubmit={submit} className="login-form">
        <FieldGroup className="flex flex-col gap-4">
          <Field className="flex flex-col gap-1.5 text-left">
            <FieldLabel htmlFor="email" className="login-label">{t('setup.email')}</FieldLabel>
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              className="login-input"
            />
          </Field>

          <Field className="flex flex-col gap-1.5 text-left">
            <FieldLabel htmlFor="password" className="login-label">{t('setup.password')}</FieldLabel>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="login-input"
            />
            <FieldDescription className="text-xs mt-1 text-muted-foreground">{t('setup.passwordHint')}</FieldDescription>
          </Field>

          <Field className="flex flex-col gap-1.5 text-left">
            <FieldLabel htmlFor="baseDomain" className="login-label">{t('setup.domain')}</FieldLabel>
            <Input
              id="baseDomain"
              required
              value={typedDomain}
              onChange={(e) => setTypedDomain(e.target.value)}
              placeholder="example.com"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={probe === 'missing'}
              className="login-input"
            />
            {isIp && domain !== host && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start mt-1 text-xs shadow-sm h-7"
                onClick={() => setTypedDomain(`${host}.sslip.io`)}
              >
                {t('setup.useTempDomain')}
              </Button>
            )}
          </Field>
          <Field className="flex flex-col gap-1.5 text-left">
            <FieldLabel htmlFor="consoleDomain" className="login-label">{t('setup.consoleDomain')}</FieldLabel>
            <Input
              id="consoleDomain"
              value={typedConsoleDomain}
              onChange={(e) => setTypedConsoleDomain(e.target.value)}
              placeholder={domain || 'example.com'}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="login-input"
            />
            <FieldDescription className="text-xs text-muted-foreground">{t('setup.consoleDomainHint')}</FieldDescription>
            <DomainStatus probe={probe} domain={domain} consoleDomain={consoleDomain} host={host} isIp={isIp} />
          </Field>
        </FieldGroup>

        {mutation.isError && (
          <Alert variant="destructive" className="py-2.5 text-xs">
            <AlertDescription>{errorText(error, t)}</AlertDescription>
          </Alert>
        )}

        {blocked && (probe === 'missing' || probe === 'error') && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="self-start p-0 h-auto text-xs"
            onClick={() => setOverride(true)}
          >
            {t('setup.dnsOverride')}
          </Button>
        )}

        <Button type="submit" className="login-btn mt-2" disabled={mutation.isPending || token === '' || !shapeOk || blocked}>
          {mutation.isPending ? t('setup.pending') : t('setup.submit')}
        </Button>

        <p className="text-xs text-muted-foreground text-center mt-2">{t('setup.insecure')}</p>
      </form>
    </Shell>
  )
}

type Probe = 'idle' | 'checking' | 'ok' | 'missing' | 'error'

/** 边打字边查泛解析。停手 450ms 再发，别把人家的 DNS 打爆。 */
function useDomainProbe(token: string, domain: string, consoleDomain: string, shapeOk: boolean): Probe {
  const key = JSON.stringify([token, domain, consoleDomain])
  const [result, setResult] = useState<{ key: string; state: Probe }>({ key: '', state: 'idle' })

  useEffect(() => {
    if (token === '' || !shapeOk) {
      return
    }
    setResult({ key, state: 'checking' })
    let alive = true
    const timer = setTimeout(() => {
      probeSetupDomain(token, domain, consoleDomain)
        .then((r) => {
          if (alive) setResult({ key, state: r.resolved ? 'ok' : 'missing' })
        })
        .catch(() => {
          if (alive) setResult({ key, state: 'error' })
        })
    }, 450)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [token, domain, consoleDomain, shapeOk, key])

  if (token === '' || !shapeOk) return 'idle'
  return result.key === key ? result.state : 'checking'
}

/**
 * 域名那一格下面的**实时状态**。没通的时候直接把要加的记录列出来 —— 带着这台机器的地址，
 * 让人复制粘贴就行，而不是去理解"泛解析"是什么意思。
 */
function DomainStatus(props: {
  probe: Probe
  domain: string
  consoleDomain: string
  host: string
  isIp: boolean
}): ReactNode {
  const { t } = useTranslation()
  if (props.probe === 'idle') return null

  if (props.probe === 'checking') {
    return <FieldDescription>{t('setup.dnsChecking')}</FieldDescription>
  }

  if (props.probe === 'ok') {
    return <FieldDescription>{t('setup.dnsOk', { domain: props.consoleDomain })}</FieldDescription>
  }
  if (props.probe === 'error') return <FieldDescription>{t('setup.dnsError')}</FieldDescription>

  return (
    <div className="flex flex-col gap-2">
      <FieldDescription>{t('setup.dnsMissing')}</FieldDescription>
      <div className="rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-[11px] leading-5">
        <div>{props.consoleDomain}</div>
        <div>{`*.${props.domain}`}</div>
      </div>
      {props.isIp && (
        <FieldDescription>{t('setup.dnsPointTo', { host: props.host })}</FieldDescription>
      )}
    </div>
  )
}

/** 登录页那套外壳：品牌 + 语言/主题切换，内容居中。 */
function Shell({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="login-container">
      {/* ── Left: Brand Stage ── */}
      <section className="login-stage">
        <div className="login-stage-content">
          <div className="login-whale-wrap">
            <div className="login-hero-glow" aria-hidden="true" />
            <WhaleAnimation className="login-whale" />
          </div>
          <div className="login-brand">
            <h1 className="login-wordmark">
              dsh<span className="login-wordmark-cloud">cloud.</span>
            </h1>
            <p className="login-subtitle">{t('login.subtitle')}</p>
          </div>
        </div>
      </section>

      {/* ── Right: Form ── */}
      <section className="login-panel">
        <header className="login-header">
          <LanguageSwitcher />
          <ThemeSwitcher />
        </header>

        <main className="login-main">
          <div className="login-form-wrap">
            {children}
          </div>
        </main>

        <footer className="login-footer" />
      </section>
    </div>
  )
}

/**
 * 服务端只回状态码和机器可读的 `error`，文案在这一层翻。**说清哪儿错了**，别夹带设计理由。
 * 409 和 400 各有两个含义，靠 `error` 字段区分（它落在 `ApiError.message` 上，见 api.ts）。
 */
function errorText(error: unknown, t: TFunction): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return t('setup.errToken')
    if (error.status === 409) {
      return error.message === 'account-exists' ? t('setup.errAccountExists') : t('setup.errConfigured')
    }
    if (error.status === 400) {
      return error.message === 'invalid-account' ? t('setup.errAccount') : t('setup.errDomain')
    }
  }
  return t('common.requestFailed')
}
