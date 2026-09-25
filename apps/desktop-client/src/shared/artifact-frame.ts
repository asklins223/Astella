/**
 * 动态讲解产物 frame 的**单一来源**（39d W4-1 / D4 §3、§4.3）。
 *
 * 为什么把这个契约单独放一层：同一个 origin 与同一个 sandbox 属性要出现在**三个地方**
 * ——主进程（协议分流与 CSP）、渲染进程（嵌 frame 的那一处）、隔离探针（在真窗口里
 * 造同一个 frame 并打越权语料）。三处各写一遍字符串，就是三个来源；这一层保证它们
 * 永远一样。D4 §7.4 的红线也钉在这里：`allow-scripts` 绝不许与 `allow-same-origin`
 * 同时出现（那个组合下 frame 可以自己摘掉沙箱属性）。
 */

export const ARTIFACT_SCHEME = 'ailearn-app'

/**
 * 第二个 host。它不是新协议：`ailearn-app` 已注册成 standard + secure，
 * 所以 `ailearn-app://artifact` 是一个与 `ailearn-app://bundle` **不同源**的正常 origin。
 */
export const ARTIFACT_HOST = 'artifact'

export const ARTIFACT_FRAME_ORIGIN = `${ARTIFACT_SCHEME}://${ARTIFACT_HOST}`

/**
 * 给出的能力**只有这一项**。不给 `allow-same-origin`（不透明 origin：没有存储、
 * 拿不到父窗口）、不给 `allow-forms` / `allow-popups` / `allow-modals` /
 * `allow-top-navigation*` / `allow-downloads` / `allow-presentation` / `allow-pointer-lock`。
 */
export const ARTIFACT_FRAME_SANDBOX = 'allow-scripts'

/** 产物 id 的形状。它同时是路径安全的那道闸：只认 uuid，没有 `..`／`/` 可写。 */
export const ARTIFACT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isArtifactId(value: unknown): value is string {
  return typeof value === 'string' && ARTIFACT_ID_PATTERN.test(value)
}

export function artifactFrameUrl(artifactId: string): string {
  if (!isArtifactId(artifactId)) {
    throw new Error('artifactFrameUrl 只接受 uuid 形状的产物 id')
  }
  return `${ARTIFACT_FRAME_ORIGIN}/${artifactId}`
}

/** 这一条 URL 是不是"我们自己的产物 origin 下的一份产物"（凭据／端口／查询串一律不收）。 */
export function isArtifactFrameUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === `${ARTIFACT_SCHEME}:` &&
    url.hostname === ARTIFACT_HOST &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    isArtifactId(url.pathname.replace(/^\/+/, '').split('/')[0] ?? '')
  )
}

/**
 * 父子之间只走 `postMessage`（同一个通道名下两类消息），并且**父侧必须校验
 * `event.source === frame.contentWindow`**（D4 §4.3）。不实现任何"按消息内容执行动作"的
 * 通用通道——那等于把 preload 的桥从后门开回来。
 *
 * 消息形状在这里定死，是因为两侧（模板里的播放器、渲染进程里的宿主）都要用；
 * 校验函数也放这里，好让"父侧怎么判一条消息"成为一条可测的纯逻辑。
 */
export const ARTIFACT_FRAME_CHANNEL = 'ailearn:artifact-frame'

/**
 * 首期只有两件事要走这条通道：产物**说自己起来了**（ready／heartbeat，主进程的
 * 计时器据此判断"没起来就退回静态分镜"）与**说自己坏了**（error）。播放控制
 * （步进／暂停／重播）等宿主那一侧的面落地时再加——本轮不预先发明它们。
 */
export type ArtifactFramePhase = 'ready' | 'heartbeat' | 'error'

export interface ArtifactFrameEvent {
  channel: typeof ARTIFACT_FRAME_CHANNEL
  direction: 'frame->host'
  phase: ArtifactFramePhase
  /** 产物自己登记的步骤数（`ready` 时给出；读不到就是 0）。 */
  stepCount?: number
  /** `error` 的说明。只用于**如实说明**"这份动态内容没能跑起来"，不许当控制指令解析。 */
  detail?: string
}

export interface ArtifactFrameCommandMessage {
  channel: typeof ARTIFACT_FRAME_CHANNEL
  direction: 'host->frame'
  command: 'motion'
  /** `reduced` = 切静态分镜（每一步都可见、可读，不丢步骤、不丢判断依据）。 */
  motion: 'full' | 'reduced'
}

/**
 * 父侧的消息判据（纯函数，可测）：通道名对不对、方向对不对、阶段在不在白名单里。
 * **它不检查 source**——source 只能在事件回调里拿到，宿主那一侧必须另做
 * `event.source === frame.contentWindow`；两者是"且"的关系，缺一不可。
 */
export function parseArtifactFrameEvent(data: unknown): ArtifactFrameEvent | null {
  if (typeof data !== 'object' || data === null) return null
  const candidate = data as Record<string, unknown>
  if (candidate.channel !== ARTIFACT_FRAME_CHANNEL) return null
  if (candidate.direction !== 'frame->host') return null
  const phase = candidate.phase
  if (phase !== 'ready' && phase !== 'heartbeat' && phase !== 'error') return null
  const event: ArtifactFrameEvent = { channel: ARTIFACT_FRAME_CHANNEL, direction: 'frame->host', phase }
  if (typeof candidate.stepCount === 'number' && Number.isInteger(candidate.stepCount)) {
    event.stepCount = candidate.stepCount
  }
  if (typeof candidate.detail === 'string') event.detail = candidate.detail.slice(0, 500)
  return event
}

export function artifactFrameMotionMessage(motion: 'full' | 'reduced'): ArtifactFrameCommandMessage {
  return { channel: ARTIFACT_FRAME_CHANNEL, direction: 'host->frame', command: 'motion', motion }
}
