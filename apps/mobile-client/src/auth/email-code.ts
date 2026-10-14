export type EmailCodePurpose = 'register' | 'login' | 'reset_password'

// Absolute times survive page changes and a backgrounded tab. Passwords and
// verification codes stay in the mounted form; only cooldowns are stored.
const KEY = 'astella.mobile.email-code-cooldowns.v1'
const deadlines = new Map<string, number>()
let loaded = false

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function keyFor(email: string, purpose: EmailCodePurpose): string {
  return `${purpose}:${normalizeEmail(email)}`
}

function loadDeadlines(): void {
  if (loaded) return
  loaded = true
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > Date.now() && value < Date.now() + 86_400_000) {
        deadlines.set(key, value)
      }
    }
  } catch { /* Private browsing can disable sessionStorage; memory still works. */ }
}

export function remainingCodeWait(email: string, purpose: EmailCodePurpose): number {
  loadDeadlines()
  return Math.max(0, Math.ceil(((deadlines.get(keyFor(email, purpose)) ?? 0) - Date.now()) / 1000))
}

export function rememberCodeWait(email: string, purpose: EmailCodePurpose, seconds: number): void {
  loadDeadlines()
  const safeSeconds = Number.isFinite(seconds) ? Math.max(1, Math.min(seconds, 86_400)) : 60
  deadlines.set(keyFor(email, purpose), Date.now() + safeSeconds * 1000)
  for (const [key, value] of deadlines) if (value <= Date.now()) deadlines.delete(key)
  try { sessionStorage.setItem(KEY, JSON.stringify(Object.fromEntries(deadlines))) } catch { /* Keep the in-memory deadline. */ }
}
