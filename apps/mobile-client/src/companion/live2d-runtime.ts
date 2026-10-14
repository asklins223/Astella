/**
 * 伴星的实时渲染运行时。
 *
 * 与桌面端共用**同一份已批准的**本机资源（`public/assets/companion/` 由
 * `scripts/sync-companion-assets.mjs` 同步过来，不进仓库），加载闸门也照抄：模型 id、
 * `status==='production'`、Owner 已批准、许可允许商用发布——四条缺一就不画，退回纸面静帧。
 * 这不是形式主义：模型作者的条款写着禁止再分发。
 *
 * 画布是**常驻节点**，不随路由重排重建：她在页面切换时不该消失再出现一次。
 */
/** 资源根必须是**绝对** URL：`new URL(path, '/assets/companion/')` 会抛 Invalid base URL。 */
const ASSETS_BASE = new URL('/assets/companion/', window.location.origin)

export type CompanionRuntimeState = 'idle' | 'loading' | 'ready' | 'unavailable'

interface Bounds { x: number; y: number; width: number; height: number }

interface Live2DModel {
  anchor: { set: (x: number, y: number) => void }
  scale: { x: number; set: (value: number) => void }
  position: { x: number; y: number; set: (x: number, y: number) => void }
  autoUpdate: boolean
  motion?: (group: string, index?: number, priority?: number) => void | Promise<unknown>
  internalModel: {
    originalWidth: number
    originalHeight: number
    coreModel: { getDrawableCount: () => number; setParameterValueById: (id: string, value: number) => void }
    getDrawableBounds: (index: number, out: Bounds) => Bounds
    on: (event: string, handler: () => void) => void
    off: (event: string, handler: () => void) => void
  }
  destroy: () => void
}

interface PixiApp {
  stage: { addChild: (child: unknown) => void }
  renderer: {
    resize: (width: number, height: number) => void
    render: (stage: unknown) => void
    gl: WebGLRenderingContext
  }
  start?: () => void
  stop?: () => void
  destroy: (removeView: boolean) => void
}

interface PixiGlobal {
  Application: new (options: Record<string, unknown>) => PixiApp
  live2d: { Live2DModel: { from: (url: string, options: Record<string, unknown>) => Promise<Live2DModel> } }
}

type Box = { left: number; right: number; top: number; bottom: number }

function pixi(): PixiGlobal | null {
  return (window as unknown as { PIXI?: PixiGlobal }).PIXI ?? null
}

function loadScript(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const node = document.createElement('script')
    node.src = new URL(path, ASSETS_BASE).href
    node.onload = () => resolve()
    node.onerror = () => reject(new Error('本机 Live2D 运行资源无法读取'))
    document.head.append(node)
  })
}

let runtimeLoad: Promise<void> | null = null

export class CompanionRuntime {
  private readonly host: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly observer: ResizeObserver
  private readonly beforeUpdate: () => void
  private readonly onVisibilityChange = () => {
    this.host.hidden = !this.seat || document.hidden || this.state === 'unavailable'
    this.position()
    this.run()
  }
  private app: PixiApp | null = null
  private model: Live2DModel | null = null
  private box: Box = { left: 0, right: 1, top: 0, bottom: 1 }
  private seat: HTMLElement | null = null
  private level = 0
  private off = false
  private started = false
  private disposed = false
  state: CompanionRuntimeState = 'idle'
  error: string | null = null

  constructor(
    private readonly root: HTMLElement,
    private readonly readLevel: () => number,
    private readonly onStateChange: (state: CompanionRuntimeState, error: string | null) => void,
  ) {
    this.host = document.createElement('div')
    this.host.className = 'scene-model-layer'
    this.host.hidden = true
    this.host.setAttribute('aria-hidden', 'true')
    this.canvas = document.createElement('canvas')
    this.host.append(this.canvas)
    root.append(this.host)
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      this.fail('图形资源中断，请刷新重试')
    })
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    this.beforeUpdate = () => {
      this.position()
      this.setLevel(this.readLevel())
    }
    // 开发期把这一份挂到 window 上：舞台不亮时能从外部读到 pixi 的真实状态，
    // 而不是靠猜（2026-10-12 实测就是这么定位到没画的）。生产构建里被摇掉。
    if (import.meta.env.DEV) (window as unknown as { __companionRuntime?: unknown }).__companionRuntime = this
    this.observer = new ResizeObserver(() => this.position())
    this.observer.observe(root)
  }

  /** seat 是舞台上「她该站在哪」那块空位；Off 时不再自更新，只留一张定住的画面。 */
  sync(seat: HTMLElement | null, off: boolean): void {
    if (this.seat !== seat) {
      // 要盯的是 seat 而不只是整屏：气泡长高、屏上多一行，座位高度就变了，
      // 只看 `.phone` 的话画布停在旧尺寸（实测 478 vs 381，她被压出座位）。
      if (this.seat) this.observer.unobserve(this.seat)
      if (seat) this.observer.observe(seat)
      this.seat = seat
    }
    this.off = off
    this.host.hidden = !seat || document.hidden || this.state === 'unavailable'
    this.position()
    if (seat && !this.started) {
      this.started = true
      void this.init()
    }
    this.run()
  }

  /** Keep the companion visibly alive, and let her acknowledge the start of a turn. */
  setActivity(activity: 'idle' | 'waiting' | 'thinking' | 'acting' | 'streaming', off: boolean): void {
    this.host.dataset.activity = off ? 'still' : activity
  }

  playMotion(group: 'Bubble', index = 0): void {
    if (this.disposed || this.off || this.host.hidden || this.state !== 'ready' || !this.model?.motion) return
    try {
      void Promise.resolve(this.model.motion(group, index, 3)).catch(() => undefined)
    } catch {
      // A missing optional motion must never interrupt the conversation or model stage.
    }
  }

  private position(): void {
    // 释放之后 observer 还可能递进来一次排队的回调：那时 app 已经拆掉，
    // 再碰它就是控制台里那条 "reading 'stop' of null"（实测过两遍）。
    if (this.disposed || !this.seat?.isConnected) return
    const root = this.root.getBoundingClientRect()
    const seat = this.seat.getBoundingClientRect()
    const scaleX = this.root.clientWidth / Math.max(1, root.width)
    const scaleY = this.root.clientHeight / Math.max(1, root.height)
    const variant = this.seat.dataset.companionSeat ?? 'scene'
    if (this.host.dataset.seat !== variant) this.host.dataset.seat = variant
    const placement = {
      left: `${(seat.left - root.left) * scaleX}px`,
      top: `${(seat.top - root.top) * scaleY}px`,
      width: `${seat.width * scaleX}px`,
      height: `${seat.height * scaleY}px`,
    }
    for (const [key, value] of Object.entries(placement)) {
      if (this.host.style[key as 'left' | 'top' | 'width' | 'height'] !== value) this.host.style[key as 'left' | 'top' | 'width' | 'height'] = value
    }
    if (this.state === 'ready' && (this.canvas.clientWidth !== this.seat.clientWidth || this.canvas.clientHeight !== this.seat.clientHeight)) this.fit()
  }

  private fit(): void {
    const seat = this.seat
    if (this.disposed || !this.app || !this.model || !seat) return
    const width = Math.max(1, seat.clientWidth)
    const height = Math.max(1, seat.clientHeight)
    const internal = this.model.internalModel
    const box = this.box
    this.app.renderer.resize(width, height)
    const scale =
      Math.min(
        width / (Math.max(0.05, box.right - box.left) * internal.originalWidth),
        height / (Math.max(0.05, box.bottom - box.top) * internal.originalHeight),
      ) * 0.88
    this.model.scale.set(scale)
    this.model.position.set(
      width / 2 + (internal.originalWidth * scale) / 2 - ((box.left + box.right) * internal.originalWidth * scale) / 2,
      height * 0.98 - box.bottom * internal.originalHeight * scale + (internal.originalHeight * scale) / 2,
    )
    this.app.renderer.render(this.app.stage)
  }

  private measure(): void {
    const internal = this.model?.internalModel
    if (!internal) return
    const out: Bounds = { x: 0, y: 0, width: 0, height: 0 }
    let left = Infinity
    let right = -Infinity
    let top = Infinity
    // 这四个初值的符号就是"求最小/求最大"本身：bottom 写错成 Infinity，
    // 裁切框高度会算成 Infinity，缩放随即变成 0 —— 她明明加载好了却什么都不画。
    let bottom = -Infinity
    for (let index = 0; index < internal.coreModel.getDrawableCount(); index++) {
      const bounds = internal.getDrawableBounds(index, out)
      if (bounds.width <= 0 || bounds.height <= 0) continue
      left = Math.min(left, bounds.x)
      right = Math.max(right, bounds.x + bounds.width)
      top = Math.min(top, bounds.y)
      bottom = Math.max(bottom, bounds.y + bounds.height)
    }
    this.box = Number.isFinite(left)
      ? {
          left: left / internal.originalWidth,
          right: right / internal.originalWidth,
          top: 1 - bottom / internal.originalHeight,
          bottom: 1 - top / internal.originalHeight,
        }
      : { left: 0, right: 1, top: 0, bottom: 1 }
  }

  /** 只裁到有墨的范围：模型的画布比可见轮廓大一圈，不裁会把她顶出这一屏。 */
  private cropVisibleInk(): void {
    if (!this.app || !this.model) return
    const gl = this.app.renderer.gl
    const width = this.canvas.width
    const height = this.canvas.height
    const pixels = new Uint8Array(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    let x1 = width
    let x2 = 0
    let y1 = height
    let y2 = 0
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        if (pixels[(y * width + x) * 4 + 3] < 40) continue
        x1 = Math.min(x1, x)
        x2 = Math.max(x2, x)
        y1 = Math.min(y1, y)
        y2 = Math.max(y2, y)
      }
    }
    if (x2 <= x1 || y2 <= y1) return
    const resolution = (this.app.renderer as unknown as { resolution?: number }).resolution ?? 1
    const internal = this.model.internalModel
    const scale = this.model.scale.x
    this.box = {
      left: ((x1 / resolution - this.model.position.x) / scale + internal.originalWidth / 2) / internal.originalWidth,
      right: ((x2 / resolution - this.model.position.x) / scale + internal.originalWidth / 2) / internal.originalWidth,
      top: (((height - y2) / resolution - this.model.position.y) / scale + internal.originalHeight / 2) / internal.originalHeight,
      bottom: (((height - y1) / resolution - this.model.position.y) / scale + internal.originalHeight / 2) / internal.originalHeight,
    }
  }

  setLevel(value: number): void {
    if (this.disposed) return
    this.level = this.off ? 0 : Math.max(0, Math.min(1, value))
    this.host.dataset.mouthLevel = this.level.toFixed(2)
    this.model?.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', this.level)
  }

  private run(): void {
    if (!this.model || !this.app || this.disposed) return
    // StrictMode 下会先卸一次再挂一次：已释放的那个实例可能仍有排队的回调进来，
    // 所有对 pixi 应用的操作都要能在"已经拆掉"之后安静地什么都不做。
    if (this.app.stage == null) return
    const active = !this.host.hidden && !this.off
    this.model.autoUpdate = active
    if (active) this.app.start?.()
    else {
      this.app?.stop?.()
      this.setLevel(this.readLevel())
      this.app.renderer.render(this.app.stage)
    }
  }

  private fail(reason: string): void {
    this.state = 'unavailable'
    this.error = reason
    this.host.hidden = true
    this.app?.stop?.()
    this.onStateChange(this.state, this.error)
  }

  private async init(): Promise<void> {
    this.state = 'loading'
    this.onStateChange(this.state, null)
    try {
      const response = await fetch(new URL('live2d-v3/whale/manifest.json', ASSETS_BASE))
      if (!response.ok) throw new Error('模型清单无法读取')
      const manifest = (await response.json()) as {
        modelId?: string
        status?: string
        ownerApproved?: { by?: string }
        modelLicense?: { commercialReleaseAllowed?: boolean }
      }
      if (
        manifest.modelId !== 'companion-live2d-whale-v3'
        || manifest.status !== 'production'
        || manifest.ownerApproved?.by !== 'Owner'
        || manifest.modelLicense?.commercialReleaseAllowed !== true
      ) {
        throw new Error('本机模型许可登记未通过')
      }
      runtimeLoad ??= (async () => {
        for (const path of ['vendor/pixi.min.js', 'vendor/live2dcubismcore.min.js', 'vendor/cubism4.min.js']) await loadScript(path)
      })()
      await runtimeLoad
      if (this.disposed) return
      const global = pixi()
      if (!global) throw new Error('本机 Live2D 运行资源无法读取')
      this.app = new global.Application({
        view: this.canvas,
        width: 320,
        height: 400,
        antialias: true,
        backgroundAlpha: 0,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      })
      const model = await global.live2d.Live2DModel.from(new URL('live2d-v3/whale/c_0120.model3.json', ASSETS_BASE).href, {
        autoInteract: false,
      })
      if (this.disposed) {
        model.destroy()
        return
      }
      this.model = model
      model.anchor.set(0.5, 0.5)
      this.app.stage.addChild(model)
      model.internalModel.on('beforeModelUpdate', this.beforeUpdate)
      this.measure()
      this.fit()
      this.cropVisibleInk()
      this.fit()
      this.state = 'ready'
      this.onStateChange(this.state, null)
      this.run()
      // This model's idle motion is authored as a loop. Without starting it,
      // autoUpdate only redraws the same neutral pose, which made every seat
      // look like a pasted sticker even though the Live2D canvas was running.
      try { void Promise.resolve(model.motion?.('Idle', 0, 1)).catch(() => undefined) } catch { /* Keep the static pose as a safe fallback. */ }
    } catch (error) {
      if (!this.disposed) this.fail(error instanceof Error ? error.message : 'Live2D 无法加载')
    }
  }

  dispose(): void {
    // 幂等：重复释放会让 pixi 在已拆掉的 ticker 上再停一次，控制台留一条
    // "reading 'stop' of null"——开发期 StrictMode 每次挂载都会走两遍。
    if (this.disposed) return
    this.disposed = true
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.observer.disconnect()
    this.model?.internalModel.off('beforeModelUpdate', this.beforeUpdate)
    this.model?.destroy()
    this.app?.destroy(false)
    this.app = null
    this.model = null
    this.host.remove()
  }
}
