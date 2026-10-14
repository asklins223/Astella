import { useEffect, useRef, useState } from 'react'
import { authApi } from '../platform/api.ts'
import { ApiError } from '../platform/api-client.ts'
import { clearSessionError, signInAfterToken, useSession } from '../state/session.ts'
import { Icon } from '../app/icons.tsx'
import { normalizeEmail, remainingCodeWait, rememberCodeWait, type EmailCodePurpose } from './email-code.ts'
import { CompanionSeat } from '../companion/CompanionSeat.tsx'
import '../styles/auth.css'

type Mode = 'login' | 'register' | 'reset'
type Step = 'details' | 'verify'
type LoginMethod = 'password' | 'code'
type FieldName = 'email' | 'password' | 'displayName' | 'code' | 'newPassword' | 'confirmPassword'
type FormError = { message: string; field?: FieldName }
type PendingRequest = { generation: number; controller: AbortController; kind: 'sending' | 'submitting' }

/** Account flows share email identity, while each code belongs to one purpose. */
export function AuthScreen() {
  const session = useSession()
  const [mode, setMode] = useState<Mode>('login')
  const [step, setStep] = useState<Step>('details')
  const [loginMethod, setLoginMethod] = useState<LoginMethod>('password')
  const [email, setEmail] = useState('')
  const [verifiedEmail, setVerifiedEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState<PendingRequest['kind'] | null>(null)
  const [error, setError] = useState<FormError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [, updateClock] = useState(0)
  const formRef = useRef<HTMLFormElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const requestRef = useRef<PendingRequest | null>(null)
  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  const focusAfterTransition = useRef(false)
  const purpose: EmailCodePurpose = mode === 'reset' ? 'reset_password' : mode === 'register' ? 'register' : 'login'
  const codeEmail = step === 'verify' ? verifiedEmail : normalizeEmail(email)
  const resendWait = remainingCodeWait(codeEmail, purpose)
  const passwordLogin = mode === 'login' && loginMethod === 'password'
  const shownError = error?.message ?? session.error
  const title = mode === 'reset'
    ? step === 'verify' ? '设一个新密码' : '找回你的书房'
    : mode === 'register'
      ? step === 'verify' ? '验证你的邮箱' : '从今天，一起学'
      : step === 'verify' ? '用验证码登录' : '回到你的书房'
  const description = step === 'verify'
    ? mode === 'reset' ? '输入邮箱里的验证码，再设置新密码。' : mode === 'register' ? '验证后，为你准备自己的学习书房。' : '输入邮箱里的六位验证码，接着上次的交流。'
    : mode === 'reset' ? '验证账号邮箱后，就能重新设置密码。'
      : mode === 'register' ? '一个账号，手机和桌面接着学。'
        : '同一位伴星，接着上次的交流。'

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      // A dispatched email can still arrive. Record its original mailbox
      // cooldown, without updating an unmounted or changed form.
      if (requestRef.current?.kind !== 'sending') requestRef.current?.controller.abort()
    }
  }, [])

  useEffect(() => {
    if (resendWait <= 0) return
    const timer = window.setInterval(() => updateClock((current) => current + 1), 1000)
    return () => window.clearInterval(timer)
  }, [codeEmail, purpose, resendWait > 0])

  useEffect(() => {
    if (!focusAfterTransition.current) return
    focusAfterTransition.current = false
    formRef.current?.closest('.page-scroll')?.scrollTo({ top: 0, behavior: 'instant' })
    // Focus a heading without opening the keyboard unexpectedly. The next Tab
    // reaches the relevant field; touch users can tap it immediately.
    headingRef.current?.focus({ preventScroll: true })
  }, [mode, step, loginMethod])

  useEffect(() => {
    if (!error?.field || busy) return
    const target = formRef.current?.querySelector<HTMLInputElement>(`[name="${error.field}"]`)
    target?.focus()
    target?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }, [error, busy])

  function focusError(next: FormError) {
    setError(next)
  }

  function invalidateRequest() {
    generationRef.current += 1
    if (requestRef.current?.kind !== 'sending') requestRef.current?.controller.abort()
    requestRef.current = null
    setBusy(null)
  }

  function transition(nextMode: Mode, nextStep: Step = 'details', nextMethod: LoginMethod = loginMethod) {
    invalidateRequest()
    setMode(nextMode)
    setStep(nextStep)
    setLoginMethod(nextMethod)
    if (nextMode !== mode || nextMethod !== loginMethod) {
      setPassword('')
      setConfirmPassword('')
    }
    setCode('')
    setNewPassword('')
    if (nextMode !== 'register') setConfirmPassword('')
    setError(null)
    setNotice(null)
    clearSessionError()
    focusAfterTransition.current = nextMode !== mode || nextStep !== step
  }

  function editField(setter: (value: string) => void, name: FieldName, value: string) {
    setter(value)
    if (error?.field === name || !error?.field) setError(null)
    setNotice(null)
    clearSessionError()
  }

  function emailError(): FormError | null {
    if (!normalizeEmail(email)) return { message: '先填一下你的邮箱。', field: 'email' }
    if (normalizeEmail(email).length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))) {
      return { message: '邮箱格式不完整，例如 name@example.com。', field: 'email' }
    }
    return null
  }

  function validate(): FormError | null {
    const invalidEmail = emailError()
    if (invalidEmail) return invalidEmail
    if (step === 'verify') {
      if (!/^\d{6}$/.test(code)) return { message: '请输入邮箱里的六位数字验证码。', field: 'code' }
      if (mode === 'reset') {
        if (newPassword.length < 8) return { message: '新密码至少需要 8 位。', field: 'newPassword' }
        if (newPassword !== confirmPassword) return { message: '两次输入的密码不一致。', field: 'confirmPassword' }
      }
    } else if (passwordLogin) {
      if (password.length < 4) return { message: '请输入完整的账号密码。', field: 'password' }
    } else if (mode === 'register') {
      if (password.length < 8) return { message: '密码至少需要 8 位。', field: 'password' }
      if (password !== confirmPassword) return { message: '两次输入的密码不一致。', field: 'confirmPassword' }
      if (displayName.trim().length > 32) return { message: '称呼最多 32 个字。', field: 'displayName' }
    }
    return null
  }

  function begin(kind: PendingRequest['kind']): PendingRequest {
    const request = { generation: ++generationRef.current, controller: new AbortController(), kind }
    requestRef.current = request
    setBusy(kind)
    setError(null)
    setNotice(null)
    clearSessionError()
    return request
  }

  function isCurrent(request: PendingRequest): boolean {
    return mountedRef.current && request.generation === generationRef.current
  }

  function finish(request: PendingRequest) {
    if (!isCurrent(request)) return
    requestRef.current = null
    setBusy(null)
  }

  async function boundedRequest<T>(request: PendingRequest, operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          request.controller.abort()
          reject(new ApiError(0, 'auth_timeout', '连接超时，请检查网络后重试。', null))
        }, 20_000)
      })])
    } finally { clearTimeout(timer) }
  }

  async function sendCode() {
    if (busy || requestRef.current) return
    const invalid = step === 'verify' ? null : validate()
    if (invalid) { focusError(invalid); return }
    const requestedEmail = codeEmail
    const requestedPurpose = purpose
    if (remainingCodeWait(requestedEmail, requestedPurpose) > 0) {
      // Returning to the same mailbox reuses the code and its cooldown.
      setVerifiedEmail(requestedEmail)
      setStep('verify')
      setNotice('刚才的验证码仍可使用，请查看邮箱。')
      focusAfterTransition.current = true
      return
    }
    const request = begin('sending')
    try {
      const result = await boundedRequest(request, authApi.requestEmailCode(requestedEmail, requestedPurpose, request.controller.signal))
      rememberCodeWait(requestedEmail, requestedPurpose, result.resendInSeconds)
      if (!isCurrent(request)) return
      setVerifiedEmail(requestedEmail)
      setStep('verify')
      setCode('')
      setNotice(requestedPurpose === 'register' ? '验证码已发送。收件箱没有的话，也看看垃圾邮件。' : '如果这个邮箱已注册，你会收到验证码；也请查看垃圾邮件。')
      updateClock((current) => current + 1)
      focusAfterTransition.current = true
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'resend_too_soon') rememberCodeWait(requestedEmail, requestedPurpose, 60)
      if (isCurrent(request)) focusError(describe(cause, passwordLogin))
    } finally { finish(request) }
  }

  async function submit() {
    if (busy || requestRef.current) return
    const invalid = validate()
    if (invalid) { focusError(invalid); return }
    if (!passwordLogin && step === 'details') { await sendCode(); return }
    const request = begin('submitting')
    const identityEmail = step === 'verify' ? verifiedEmail : normalizeEmail(email)
    try {
      if (mode === 'reset') {
        await boundedRequest(request, authApi.resetPassword({ email: identityEmail, code, newPassword }, request.controller.signal))
        if (!isCurrent(request)) return
        transition('login', 'details', 'password')
        setPassword('')
        setNotice('密码已更新，请用新密码登录。其他设备也需要重新登录。')
        return
      }
      const envelope = mode === 'register'
        ? await boundedRequest(request, authApi.register({ email: identityEmail, password, emailCode: code, ...(displayName.trim() ? { displayName: displayName.trim() } : {}) }, request.controller.signal))
        : passwordLogin
          ? await boundedRequest(request, authApi.login({ email: identityEmail, password, remember: true }, request.controller.signal))
          : await boundedRequest(request, authApi.loginWithCode({ email: identityEmail, code, remember: true }, request.controller.signal))
      if (!isCurrent(request)) return
      await signInAfterToken(envelope.token)
    } catch (cause) {
      if (isCurrent(request)) focusError(describe(cause, passwordLogin))
    } finally { finish(request) }
  }

  const back = () => step === 'verify' ? transition(mode, 'details') : transition('login', 'details', 'password')
  const submitLabel = busy === 'sending' ? '正在发送验证码…' : busy === 'submitting' ? (mode === 'reset' ? '正在更新密码…' : '正在进入书房…')
    : step === 'details' && !passwordLogin ? '发送验证码' : mode === 'reset' ? '更新密码' : mode === 'register' ? '验证并创建账号' : '登录'

  return (
    <>
      <header className="utility-header auth-header">
        {mode === 'login' && step === 'details' ? (
          <span className="auth-brand"><img src="/assets/brand/app-icon.png" alt="" /><span>拾星笔记<small>ASTELLA</small></span></span>
        ) : (
          <>
            <button className="auth-back" type="button" onClick={back} aria-label={step === 'verify' ? '返回填写信息' : '返回登录'}><Icon name="arrow-left" /></button>
            <span className="utility-header-title">{mode === 'reset' ? '找回密码' : mode === 'register' ? '创建账号' : '邮箱登录'}</span>
            <span className="header-end" aria-hidden="true" />
          </>
        )}
      </header>
      <div className="viewport">
        <section className={`page-scroll auth-scroll auth-scroll--${mode}`} aria-label={mode === 'reset' ? '找回密码' : mode === 'register' ? '创建账号' : '登录'}>
          <main className={`auth-flow auth-flow--${mode}`}>
            <div className={`auth-hero auth-hero--${mode} auth-hero--${step}`}>
              <div className="auth-light-orbit" aria-hidden="true" />
              <CompanionSeat variant="scene" />
              <div className="auth-hero-copy" key={`${mode}:${step}`}>
                <p className="auth-kicker">
                  {mode === 'login' ? step === 'verify' ? '书房入口 · 邮箱验证' : '同一间书房 · 手机与桌面'
                    : `${mode === 'register' ? '开始一起学习' : '账号找回'} · ${step === 'details' ? '01' : '02'} / 02`}
                </p>
                <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
                <p>{description}</p>
              </div>
            </div>
            <div className="auth-transition" key={`${mode}:${step}:form`}>
              <form ref={formRef} className={`account-form auth-card auth-card--${mode} auth-card--${step}`} noValidate onSubmit={(event) => { event.preventDefault(); void submit() }} aria-busy={Boolean(busy)}>
              {mode !== 'login' && <AuthSteps mode={mode} step={step} />}
              {mode === 'login' && step === 'details' && (
                <div className="auth-methods" role="group" aria-label="登录方式" data-method={loginMethod}>
                  <button type="button" aria-pressed={loginMethod === 'password'} onClick={() => transition('login', 'details', 'password')}>密码登录</button>
                  <button type="button" aria-pressed={loginMethod === 'code'} onClick={() => transition('login', 'details', 'code')}>邮箱验证码</button>
                </div>
              )}
              {step === 'verify' && (
                <div className="auth-mailbox glass"><Icon name="mail" /><span><small>验证码将发送至</small><strong>{verifiedEmail}</strong></span><button type="button" onClick={() => transition(mode, 'details')}>更换</button></div>
              )}
              {step === 'details' && passwordLogin && (
                <div className="auth-field-stack auth-field-stack--credentials">
                  <Field id="email" label="邮箱" value={email} onChange={(value) => editField(setEmail, 'email', value)} type="email" inputMode="email" enterKeyHint="next" autoComplete="username" placeholder="name@example.com" maxLength={320} disabled={Boolean(busy)} invalid={error?.field === 'email'} />
                  <Field key="login-password" id="password" label="密码" value={password} onChange={(value) => editField(setPassword, 'password', value)} password autoComplete="current-password" placeholder="输入你的密码" maxLength={200} disabled={Boolean(busy)} invalid={error?.field === 'password'} />
                </div>
              )}
              {step === 'details' && mode === 'login' && loginMethod === 'code' && (
                <Field id="email" label="邮箱" value={email} onChange={(value) => editField(setEmail, 'email', value)} type="email" inputMode="email" enterKeyHint="done" autoComplete="username" placeholder="name@example.com" maxLength={320} disabled={Boolean(busy)} invalid={error?.field === 'email'} />
              )}
              {step === 'details' && mode === 'reset' && (
                <Field id="email" label="邮箱" value={email} onChange={(value) => editField(setEmail, 'email', value)} type="email" inputMode="email" enterKeyHint="done" autoComplete="username" placeholder="name@example.com" maxLength={320} disabled={Boolean(busy)} invalid={error?.field === 'email'} />
              )}
              {step === 'details' && mode === 'register' && (
                <div className="auth-field-stack auth-field-stack--registration">
                  <Field id="displayName" label="怎么称呼你" optional value={displayName} onChange={(value) => editField(setDisplayName, 'displayName', value)} autoComplete="nickname" placeholder="留一个喜欢的称呼" maxLength={32} disabled={Boolean(busy)} invalid={error?.field === 'displayName'} />
                  <Field id="email" label="邮箱" value={email} onChange={(value) => editField(setEmail, 'email', value)} type="email" inputMode="email" enterKeyHint="next" autoComplete="username" placeholder="name@example.com" maxLength={320} disabled={Boolean(busy)} invalid={error?.field === 'email'} />
                  <Field id="password" label="设置密码" value={password} onChange={(value) => editField(setPassword, 'password', value)} password autoComplete="new-password" placeholder="至少 8 位" hint="建议使用较长的密码，避免与其他账号相同。" maxLength={200} disabled={Boolean(busy)} invalid={error?.field === 'password'} />
                  <Field id="confirmPassword" label="再输入一次" value={confirmPassword} onChange={(value) => editField(setConfirmPassword, 'confirmPassword', value)} password autoComplete="new-password" placeholder="确认密码" maxLength={200} disabled={Boolean(busy)} invalid={error?.field === 'confirmPassword'} />
                </div>
              )}
              {step === 'verify' && (
                <div className={`auth-field-stack auth-field-stack--verify${mode === 'reset' ? ' auth-field-stack--reset' : ''}`}>
                  <Field id="code" label="邮箱验证码" value={code} onChange={(value) => editField(setCode, 'code', value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" enterKeyHint={mode === 'reset' ? 'next' : 'done'} autoComplete="one-time-code" placeholder="— — — — — —" maxLength={6} disabled={Boolean(busy)} invalid={error?.field === 'code'} />
                  <div className="auth-code-help"><span>没收到？看看垃圾邮件。</span><button type="button" disabled={Boolean(busy) || resendWait > 0} onClick={() => void sendCode()}>{resendWait > 0 ? `${resendWait} 秒后重发` : '重新发送'}</button></div>
                  {mode === 'reset' && <>
                    <Field id="newPassword" label="新密码" value={newPassword} onChange={(value) => editField(setNewPassword, 'newPassword', value)} password autoComplete="new-password" placeholder="至少 8 位" maxLength={200} disabled={Boolean(busy)} invalid={error?.field === 'newPassword'} />
                    <Field id="confirmPassword" label="确认新密码" value={confirmPassword} onChange={(value) => editField(setConfirmPassword, 'confirmPassword', value)} password autoComplete="new-password" placeholder="再输入一次新密码" maxLength={200} disabled={Boolean(busy)} invalid={error?.field === 'confirmPassword'} />
                  </>}
                </div>
              )}
              {passwordLogin && <div className="auth-forgot"><button type="button" onClick={() => transition('reset')}>忘记密码？</button></div>}
              {shownError && <p id="auth-form-error" className="form-error" role="alert">{shownError}</p>}
              {notice && <p className="auth-notice" role="status">{notice}</p>}
              <button type="submit" className="primary auth-submit" disabled={Boolean(busy)}>
                <span>{submitLabel}</span>{busy ? <i className="auth-submit-spin" aria-hidden="true" /> : <Icon name="arrow-right" />}
              </button>
              {step === 'details' && !passwordLogin && resendWait > 0 && <p className="auth-existing-code">已发送过验证码，继续会使用刚才的验证码。</p>}
              {mode === 'login' ? <div className="auth-switch">第一次见面？<button type="button" onClick={() => transition('register')}>创建账号</button></div>
                : <div className="auth-switch">已经有账号？<button type="button" onClick={() => transition('login', 'details', 'password')}>返回登录</button></div>}
              </form>
              <p className="auth-footer"><Icon name="monitor" />同一位伴星 · 接着手机与桌面的学习</p>
            </div>
          </main>
        </section>
      </div>
    </>
  )
}

function AuthSteps({ mode, step }: { mode: 'register' | 'reset'; step: Step }) {
  const active = step === 'verify' ? 2 : 1
  const steps = mode === 'register' ? ['建立账号', '验证邮箱'] : ['确认邮箱', '更新密码']
  return (
    <div className={`auth-steps auth-steps--${mode}`} role="list" aria-label={mode === 'register' ? '创建账号流程' : '找回密码流程'}>
      {steps.map((label, index) => {
        const number = index + 1
        return <span key={label} role="listitem" aria-current={number === active ? 'step' : undefined} data-complete={number < active || undefined}>
          <i>{number < active ? <Icon name="check" /> : `0${number}`}</i>{label}
        </span>
      })}
    </div>
  )
}

function Field(props: {
  id: FieldName; label: string; value: string; onChange: (value: string) => void;
  type?: string; password?: boolean; invalid?: boolean; autoComplete?: string;
  placeholder?: string; inputMode?: 'text' | 'numeric' | 'email'; maxLength?: number;
  disabled?: boolean; optional?: boolean; hint?: string; enterKeyHint?: 'next' | 'done';
}) {
  const [shown, setShown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  return <div className={`account-field auth-field${props.password ? ' auth-password-field' : ''}`}>
    <label htmlFor={`auth-${props.id}`}>{props.label}{props.optional && <small>选填</small>}</label>
    <div className="field-input">
      <input ref={inputRef} id={`auth-${props.id}`} name={props.id} type={props.password ? shown ? 'text' : 'password' : props.type ?? 'text'}
        value={props.value} onChange={(event) => props.onChange(event.target.value)} autoComplete={props.autoComplete}
        autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint={props.enterKeyHint ?? (props.id === 'password' || props.id === 'confirmPassword' ? 'done' : 'next')} inputMode={props.inputMode}
        maxLength={props.maxLength} disabled={props.disabled} placeholder={props.placeholder} aria-invalid={props.invalid || undefined}
        aria-describedby={[props.hint ? `auth-${props.id}-hint` : null, props.invalid ? 'auth-form-error' : null].filter(Boolean).join(' ') || undefined}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          const fields = Array.from(event.currentTarget.form?.querySelectorAll<HTMLInputElement>('input:not([disabled])') ?? [])
          const next = fields[fields.indexOf(event.currentTarget) + 1]
          if (next) { event.preventDefault(); next.focus() }
        }} />
      {props.password && <button type="button" className="password-eye" disabled={props.disabled}
        onPointerDown={(event) => event.preventDefault()} onClick={() => {
          const input = inputRef.current
          const start = input?.selectionStart ?? props.value.length
          const end = input?.selectionEnd ?? start
          setShown((current) => !current)
          requestAnimationFrame(() => { input?.focus({ preventScroll: true }); input?.setSelectionRange(start, end) })
        }} aria-pressed={shown} aria-label={`${shown ? '隐藏' : '显示'}${props.label}`}><Icon name={shown ? 'eye-off' : 'eye'} /></button>}
    </div>
    {props.hint && <small className="auth-field-hint" id={`auth-${props.id}-hint`}>{props.hint}</small>}
  </div>
}

function describe(error: unknown, passwordLogin: boolean): FormError {
  if (error instanceof ApiError) {
    if (error.code === 'client_update_required') return { message: '注册流程已更新，请刷新页面后再试。' }
    if (error.code === 'email_channel_unavailable') return { message: '邮箱验证服务暂时不可用，请稍后重试。已有账号可使用密码登录。' }
    if (error.code === 'email_send_failed') return { message: '验证码邮件没有发出去，请稍后重试。', field: 'email' }
    if (error.code === 'invalid_credentials' || error.status === 401) return passwordLogin ? { message: '邮箱或密码不正确，请检查后重试。', field: 'password' } : { message: '邮箱或验证码不正确，请重新获取验证码。', field: 'code' }
    if (error.code === 'email_already_registered' || error.code === 'email_exists') return { message: '这个邮箱已注册，可以直接登录。', field: 'email' }
    if (error.code === 'invalid_email_code' || error.code === 'invalid_code') return { message: '验证码不正确，请检查邮箱中的六位数字。', field: 'code' }
    if (error.code === 'expired_code') return { message: '验证码已过期，请重新发送。', field: 'code' }
    if (error.code === 'code_attempts_exhausted') return { message: '这枚验证码尝试次数已用完，请重新发送。', field: 'code' }
    if (error.status === 0) return { message: '连接暂时不可用，请检查网络后重试。' }
    if (error.status >= 500) return { message: '账号服务暂时不可用，请稍后重试。' }
    if (error.status === 429) return { message: error.message || '操作太频繁，请稍后再试。' }
    if (error.code === 'account_unavailable') return { message: '账号状态已变化，请返回重新验证邮箱。' }
    return { message: error.message || '操作没有完成，请稍后再试。' }
  }
  if (error instanceof TypeError) return { message: '连接暂时不可用，请检查网络后重试。' }
  return { message: error instanceof Error ? error.message : '操作没有完成，请稍后再试。' }
}
