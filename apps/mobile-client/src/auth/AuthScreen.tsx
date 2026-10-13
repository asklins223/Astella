import { useEffect, useState } from 'react'
import { authApi } from '../platform/api.ts'
import { ApiError } from '../platform/api-client.ts'
import { clearSessionError, signInAfterToken, useSession } from '../state/session.ts'
import { Icon } from '../app/icons.tsx'

type Mode = 'login' | 'register'
type Step = 'form' | 'verify'

/**
 * 登录与创建账号。
 *
 * 结构与类名照 demo 的 `mobile-companion-centers.js`：`header.utility-header`
 * （`.auth-brand`／`.utility-header-title`）→ `.viewport > .page-scroll.utility-scroll`
 * → `.auth-page.login-page > .login-scene + .login-heading + form.account-form.login-card.glass`。
 * 她在那儿是**见面**的一部分（半身像 + 一句"回到你的书房"），不是装饰。
 *
 * 注册比 demo 多一步：产品规则是默认强制邮箱验证码两步，`verify` 那一步沿用同一套字段壳。
 */
export function AuthScreen() {
  const session = useSession()
  const [mode, setMode] = useState<Mode>('login')
  const [step, setStep] = useState<Step>('form')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [code, setCode] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [resendWait, setResendWait] = useState(0)
  const canSubmit = Boolean(
    email.trim()
    && (mode === 'login'
      ? password.length > 0
      : password.length >= 8 && (step === 'form' || code.trim().length > 0)),
  )

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    clearSessionError()
    try {
      if (mode === 'login') {
        const envelope = await authApi.login({ email, password, remember })
        await signInAfterToken(envelope.token)
        return
      }
      if (step === 'form') {
        const result = await authApi.requestEmailCode(email, 'register')
        setStep('verify')
        setResendWait(result.resendInSeconds)
        setNotice(`验证码发到 ${email.trim()}`)
        return
      }
      const envelope = await authApi.register({
        email,
        password,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        emailCode: code,
      })
      await signInAfterToken(envelope.token)
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setBusy(false)
    }
  }

  const backToLogin = () => {
    setMode('login')
    setStep('form')
    setResendWait(0)
    setError(null)
    setNotice(null)
    clearSessionError()
  }
  const backFromRegistration = () => {
    if (mode === 'register' && step === 'verify') {
      setStep('form')
      setCode('')
      setResendWait(0)
      setError(null)
      setNotice(null)
      clearSessionError()
      return
    }
    backToLogin()
  }
  const resendCode = async () => {
    setBusy(true)
    setError(null)
    clearSessionError()
    try {
      const result = await authApi.requestEmailCode(email, 'register')
      setResendWait(result.resendInSeconds)
      setNotice(`验证码已重新发到 ${email.trim()}。可在 ${result.resendInSeconds} 秒后再次获取。`)
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setBusy(false)
    }
  }
  const shownError = error?.message ?? session.error

  useEffect(() => {
    if (resendWait <= 0) return
    const timer = window.setTimeout(() => setResendWait((current) => Math.max(0, current - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [resendWait])

  return (
    <>
      <header className="utility-header">
        {mode === 'login' ? (
          <span className="auth-brand">
            <i>✦</i>拾星笔记<small>ASTELLA</small>
          </span>
        ) : (
          <>
            <button className="icon-button glass top-left" type="button" onClick={backFromRegistration} aria-label={step === 'verify' ? '返回注册信息' : '返回登录'}>
              <Icon name="arrow-left" />
            </button>
            <span className="utility-header-title">{step === 'verify' ? '验证邮箱' : '创建账号'}</span>
          </>
        )}
        <span className="header-end" aria-hidden="true" />
      </header>

      <div className="viewport">
        <section className="page-scroll utility-scroll" data-view-key={mode} aria-label={mode === 'login' ? '登录' : '创建账号'}>
          <div className={`auth-page ${mode === 'login' ? 'login-page' : 'registration-page'}`}>
            {mode === 'login' ? (
              <>
                <div className="login-scene">
                  <span className="portrait">
                    <img src="/assets/companion-static.png" alt="蓝发伴星的完整半身形象" />
                  </span>
                </div>
                <div className="login-heading">
                  <h1>回到你的书房</h1>
                  <p>同一位伴星，接着上次的交流。</p>
                </div>
              </>
            ) : (
              <>
                <div className="auth-welcome">
                  <div className="auth-introduction">
                    <h1>
                      从今天，
                      <br />
                      一起学。
                    </h1>
                  </div>
                  <span className="portrait">
                    <img src="/assets/companion-static.png" alt="蓝发伴星的完整半身形象" />
                  </span>
                </div>
                <p className="auth-description">一个账号，同一位伴星。</p>
              </>
            )}

            <form
              className={`account-form${mode === 'login' ? ' login-card glass' : ''}`}
              noValidate
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              {mode === 'login' ? (
                <div className="login-fields">
                  <Field id="email" label="邮箱" value={email} onChange={(value) => { setEmail(value); clearSessionError() }} type="email" autoComplete="username" placeholder="name@example.com" invalid={error?.field === 'email'} />
                  <Field id="password" label="密码" value={password} onChange={(value) => { setPassword(value); clearSessionError() }} type="password" autoComplete="current-password" placeholder="输入你的密码" password invalid={error?.field === 'password'} />
                </div>
              ) : (
                <>
                  {step === 'form' && <Field id="displayName" label="怎么称呼你" value={displayName} onChange={(value) => { setDisplayName(value); clearSessionError() }} glass autoComplete="nickname" placeholder="留一个喜欢的称呼" />}
                  <Field id="email" label="邮箱" value={email} onChange={(value) => { setEmail(value); clearSessionError() }} type="email" glass autoComplete="username" placeholder="name@example.com" invalid={error?.field === 'email'} readOnly={step === 'verify'} />
                  {step === 'form' && <Field id="password" label="密码" value={password} onChange={(value) => { setPassword(value); clearSessionError() }} type="password" glass autoComplete="new-password" placeholder="至少 8 位" password />}
                  {step === 'verify' && <Field id="code" label="邮箱验证码" value={code} onChange={(value) => { setCode(value); clearSessionError() }} glass inputMode="numeric" autoComplete="one-time-code" placeholder="六位数" />}
                </>
              )}
              {mode === 'register' && step === 'verify' && (
                <button type="button" className="secondary auth-resend" disabled={busy || resendWait > 0} onClick={() => void resendCode()}>
                  {busy ? '正在发送…' : resendWait > 0 ? `${resendWait} 秒后可重发` : '重新发送验证码'}
                </button>
              )}

              <label className="account-check">
                <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                保持登录
              </label>

              <p id="form-error" className="form-error" role="alert" hidden={!shownError}>
                {shownError}
              </p>
              {notice && <p className="auth-demo-note">{notice}</p>}

              <button type="submit" className="primary" disabled={busy || !canSubmit}>
                {busy ? '正在处理…' : mode === 'login' ? '登录' : step === 'form' ? '发验证码' : '创建账号，进入书房'}
              </button>

              <p className="auth-switch">
                {mode === 'login' ? (
                  <>
                    第一次见面？
                    <button type="button" onClick={() => { setMode('register'); setError(null); clearSessionError() }}>
                      创建账号 <Icon name="chevron-right" />
                    </button>
                  </>
                ) : (
                  <>
                    已经有账号？
                    <button type="button" onClick={backToLogin}>去登录</button>
                  </>
                )}
              </p>
            </form>

            <p className="auth-demo-note">笔记在手机上只能读；要改正文，跟伴星说一声。</p>
          </div>
        </section>
      </div>
    </>
  )
}

function Field(props: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  glass?: boolean
  password?: boolean
  invalid?: boolean
  autoComplete?: string
  placeholder?: string
  readOnly?: boolean
  inputMode?: 'none' | 'text' | 'numeric' | 'tel' | 'search' | 'email' | 'url' | 'decimal'
}) {
  const { id, label, value, onChange, type = 'text', glass, password, invalid, autoComplete, placeholder, readOnly, inputMode } = props
  const [shown, setShown] = useState(false)
  return (
    <div className="account-field">
      <label htmlFor={`field-${id}`}>{label}</label>
      <div className={`field-input${glass ? ' glass' : ''}`}>
        <input
          id={`field-${id}`}
          name={id}
          type={password && !shown ? 'password' : type}
          value={value}
          autoComplete={autoComplete}
          placeholder={placeholder}
          readOnly={readOnly}
          inputMode={inputMode}
          aria-invalid={invalid ? 'true' : undefined}
          aria-describedby="form-error"
          onChange={(event) => onChange(event.target.value)}
        />
        {password && (
          <button type="button" className="password-eye" onClick={() => setShown((current) => !current)} aria-pressed={shown} aria-label={`${shown ? '隐藏' : '显示'}${label}`}>
            <Icon name={shown ? 'eye-off' : 'eye'} />
          </button>
        )}
      </div>
    </div>
  )
}

function describe(error: unknown): { message: string; field?: string } {
  if (error instanceof ApiError) {
    if (error.code === 'client_update_required') return { message: '注册流程已更新，请刷新页面后再试。' }
    if (error.code === 'email_channel_unavailable') return { message: '邮箱验证码暂时不可用，请稍后再试。' }
    if (error.code === 'invalid_credentials') return { message: '邮箱或密码不对。', field: 'password' }
    if (error.status === 401) return { message: '邮箱或密码不对。', field: 'password' }
    if (error.code === 'email_already_registered') return { message: '这个邮箱已经有账号了，直接登录就好。', field: 'email' }
    if (error.code === 'invalid_email_code') return { message: '验证码不对，或者已经过期。', field: 'code' }
    if (error.status === 0) return { message: '连接暂时不可用，请检查网络后重试。' }
    if (error.status >= 500) return { message: '登录服务暂时不可用，请稍后再试。' }
    return { message: error.message }
  }
  if (error instanceof TypeError) return { message: '连接暂时不可用，请检查网络后重试。' }
  return { message: error instanceof Error ? error.message : '没成功' }
}
