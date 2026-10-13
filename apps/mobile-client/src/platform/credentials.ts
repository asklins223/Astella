/**
 * 会话凭据的本机存放。
 *
 * 浏览器里只有一个可用位置（localStorage），没有钥匙串弹窗，也不会在关标签后
 * 把凭据写到别处。真正的吊销靠服务端：改密、退出所有设备、成员被移出都会删行。
 */
const KEY = 'astella.mobile.session.v1'

let memory: string | null = null

function readStorage(): string | null {
  if (memory !== null) return memory
  try {
    memory = localStorage.getItem(KEY)
  } catch {
    // 隐私模式下 localStorage 会直接抛：内存里那份仍然可用，只是不留到下次。
    memory = null
  }
  return memory
}

export function getToken(): string | null {
  return readStorage()
}

export function saveToken(token: string): void {
  memory = token
  try {
    localStorage.setItem(KEY, token)
  } catch {
    /* 留内存那份 */
  }
}

export function clearToken(): void {
  memory = null
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
