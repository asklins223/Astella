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
 * 父子之间只走 `postMessage`（状态与阅读滚轮消息），并且**父侧必须校验
 * `event.source === frame.contentWindow`**（D4 §4.3）。不实现任何"按消息内容执行动作"的
 * 通用通道——那等于把 preload 的桥从后门开回来。
 *
 * 消息形状在这里定死，是因为两侧（模板里的播放器、渲染进程里的宿主）都要用；
 * 校验函数也放这里，好让"父侧怎么判一条消息"成为一条可测的纯逻辑。
 */
export const ARTIFACT_FRAME_CHANNEL = 'ailearn:artifact-frame'

/**
 * 产物报告运行状态（ready／heartbeat／error）与原生滚轮增量（scroll）。
 * 滚轮只驱动包含本 frame 的阅读滚区，不参与运行状态，也不提供任意 DOM 指令。
 */
export type ArtifactFramePhase = 'ready' | 'heartbeat' | 'error' | 'scroll'

export interface ArtifactFrameEvent {
  channel: typeof ARTIFACT_FRAME_CHANNEL
  direction: 'frame->host'
  phase: ArtifactFramePhase
  /** 产物自己登记的步骤数（`ready` 时给出；读不到就是 0）。 */
  stepCount?: number
  /** `error` 的说明。只用于**如实说明**"这份动态内容没能跑起来"，不许当控制指令解析。 */
  detail?: string
  /**
   * 产物当前内容高度（CSS px）。
   *
   * 为什么需要这一格：frame 是**不透明 origin** 里的一份独立文档，父侧量不到它的内容
   * （同源策略下读不到 iframe 的 DOM）。不给高度，宿主只能给一个写死的行高，于是内容
   * 被压进一小格、frame 内部自己出滚动条——那正是"共 4 步"旁边一小块字加一根内滚动条
   * 的来源。高度由**产物自己**报（它量得到自己的内容根节点），
   * 宿主只负责夹一个上限再写进 style，**不拿它当任何执行输入**。
   */
  contentHeight?: number
  /** 原生滚轮只转给 frame 所在的阅读滚区，不开放任意 DOM 操作。 */
  scrollDeltaX?: number
  scrollDeltaY?: number
  scrollDeltaMode?: 0 | 1 | 2
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
  if (phase !== 'ready' && phase !== 'heartbeat' && phase !== 'error' && phase !== 'scroll') return null
  const event: ArtifactFrameEvent = { channel: ARTIFACT_FRAME_CHANNEL, direction: 'frame->host', phase }
  if (phase === 'scroll') {
    if (
      typeof candidate.scrollDeltaY !== 'number' || !Number.isFinite(candidate.scrollDeltaY)
      || typeof candidate.scrollDeltaX !== 'number' || !Number.isFinite(candidate.scrollDeltaX)
      || (candidate.scrollDeltaMode !== 0 && candidate.scrollDeltaMode !== 1 && candidate.scrollDeltaMode !== 2)
    ) return null
    event.scrollDeltaX = Math.max(-1_000, Math.min(1_000, candidate.scrollDeltaX))
    event.scrollDeltaY = Math.max(-1_000, Math.min(1_000, candidate.scrollDeltaY))
    event.scrollDeltaMode = candidate.scrollDeltaMode
    return event
  }
  if (typeof candidate.stepCount === 'number' && Number.isInteger(candidate.stepCount)) {
    event.stepCount = candidate.stepCount
  }
  // 高度只收**有限正数**：NaN／Infinity／负数一律丢掉，宿主那边就不必各自再判一次。
  if (typeof candidate.contentHeight === 'number' && Number.isFinite(candidate.contentHeight) && candidate.contentHeight > 0) {
    event.contentHeight = Math.ceil(candidate.contentHeight)
  }
  if (typeof candidate.detail === 'string') event.detail = candidate.detail.slice(0, 500)
  return event
}

export function artifactFrameMotionMessage(motion: 'full' | 'reduced'): ArtifactFrameCommandMessage {
  return { channel: ARTIFACT_FRAME_CHANNEL, direction: 'host->frame', command: 'motion', motion }
}

/**
 * 宿主的 `postMessage` 只认这一个 targetOrigin：`'*'`。
 *
 * 为什么不是 `ARTIFACT_FRAME_ORIGIN`：frame 带的是 `ARTIFACT_FRAME_SANDBOX`
 * （只有 `allow-scripts`）——它的文档 origin 是**不透明**的，而不透明 origin 永远
 * 不等于任何具名 origin。于是 `postMessage(msg, ARTIFACT_FRAME_ORIGIN)` 会被浏览器
 * **静默丢掉**：宿主以为指令发出去了，frame 一发没收到。2026-10-06 真窗口实测：
 * 同一条 `motion` 指令用产物 origin 发，frame 的 `data-artifact-motion` 一直是
 * `full`、自动播放照跑；换成 `'*'` 立刻变 `reduced` 并停掉播放。
 *
 * 这条通道只有"动效档位"一个非敏感指令（没有正文、没有凭据、没有 DOM 指令），
 * 而 frame 那侧仍按 channel + direction 白名单判据收信；宿主这侧的收信判据也照旧
 * 要求 `event.source === frame.contentWindow`。所以放开 targetOrigin 不等于放开通道。
 */
export const ARTIFACT_FRAME_TARGET_ORIGIN = '*' as const
