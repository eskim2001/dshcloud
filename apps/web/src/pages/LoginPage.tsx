import { useMutation, useQueryClient } from '@tanstack/react-query'
import { safeLoginRedirect } from '@/lib/login-redirect.js'
import { EyeIcon, EyeOffIcon, Loader2Icon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { LanguageSwitcher } from '@/components/language-switcher.js'
import { ThemeSwitcher } from '@/components/theme-switcher.js'
import { WhaleAnimation } from '@/components/whale-animation.js'
import { Alert, AlertDescription } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field.js'
import { Input } from '@/components/ui/input.js'
import { ApiError, signIn } from '../lib/api.js'
import { sessionKey } from '../lib/use-session.js'
import { useSetupState } from '../lib/use-setup.js'
import './login.css'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  // 演示站才有值（运营方设了 DEMO_EMAIL / DEMO_PASSWORD）。取不到就当没有这个功能 ——
  // 这条请求失败不该影响登录本身，所以不处理 loading / error。
  const demo = useSetupState().data?.demo ?? null

  const mutation = useMutation({
    mutationFn: () => signIn(email, password),
    onSuccess: (user) => {
      queryClient.setQueryData(sessionKey, user)
      const raw = params.get('next')
      const next = raw === null ? '/' : safeNext(raw)
      if (next.startsWith('/')) navigate(next, { replace: true })
      else window.location.assign(next)
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    mutation.mutate()
  }

  // 只填不提交：填进去之后表单里是什么、密码是明文还是圆点，都还看得见，用户按「进入控制台」即可。
  const fillDemo = () => {
    if (demo === null) return
    setEmail(demo.email)
    setPassword(demo.password)
  }

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
            <p className="login-kicker">{t('login.kicker')}</p>
            <h2 className="login-title">{t('login.title')}</h2>
            <p className="login-entry">{t('login.entryHint')}</p>

            {demo !== null && (
              <button type="button" onClick={fillDemo} className="login-demo">
                <span className="login-demo-label">{t('login.demoAccount')}</span>
                <span className="login-demo-row">
                  <span className="login-demo-cred">
                    {demo.email}
                    <span className="login-demo-slash" aria-hidden="true">
                      /
                    </span>
                    {demo.password}
                  </span>
                  <span className="login-demo-fill">{t('login.demoFill')} ›</span>
                </span>
              </button>
            )}

            <form onSubmit={submit} className="login-form">
              <FieldGroup className="flex flex-col gap-4">
                <Field className="flex flex-col gap-1.5 text-left">
                  <FieldLabel htmlFor="email" className="login-label">
                    {t('login.email')}
                  </FieldLabel>
                  <Input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    placeholder="you@example.com"
                    className="login-input"
                  />
                </Field>

                <Field className="flex flex-col gap-1.5 text-left">
                  <FieldLabel htmlFor="password" className="login-label">
                    {t('login.password')}
                  </FieldLabel>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      required
                      minLength={8}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      placeholder="••••••••"
                      className="login-input pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="login-eye-btn"
                      aria-label={
                        showPassword ? t('login.hidePassword') : t('login.showPassword')
                      }
                    >
                      {showPassword ? (
                        <EyeOffIcon className="size-4" />
                      ) : (
                        <EyeIcon className="size-4" />
                      )}
                    </button>
                  </div>
                </Field>
              </FieldGroup>

              {mutation.isError && (
                <Alert variant="destructive" className="py-2.5 text-xs">
                  <AlertDescription>
                    {mutation.error instanceof ApiError
                      ? mutation.error.message
                      : t('common.requestFailed')}
                  </AlertDescription>
                </Alert>
              )}

              <Button
                type="submit"
                disabled={mutation.isPending}
                className="login-btn"
              >
                {mutation.isPending ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2Icon className="size-4 animate-spin" />
                    {t('login.pending')}
                  </span>
                ) : (
                  t('login.submitSignIn')
                )}
              </Button>
            </form>
          </div>
        </main>

        <footer className="login-footer" />
      </section>
    </div>
  )
}

function safeNext(next: string): string {
  return safeLoginRedirect(next, window.location.origin)
}
