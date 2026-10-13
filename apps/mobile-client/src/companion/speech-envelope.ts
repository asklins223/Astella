/**
 * 出声强度包络。
 *
 * 只接受实际音频的强度。2026-10-12 复核移除了由文字 delta 推动的接线，
 * 手机尚无播放器时保持零值；不能用文字增长冒充真实播放或输入音量。
 * 唯一的例外是 `rise()`：那一次由入场明确给峰值，说的是"她刚到"，不是"她在说"。
 */
const RISE_MS = 55
const FALL_MS = 150
const HOLD_MS = 220
const FLOOR = 0.04

export class SpeechEnvelope {
  private level = 0
  private target = 0
  private lastBumpAt = 0
  private entryUntil = 0
  private frame = 0
  private element: HTMLElement | null = null

  attach(element: HTMLElement | null): void {
    this.element = element
    this.write()
  }

  detach(): void {
    this.element = null
  }

  bump(strength = 0.7): void {
    this.target = Math.min(1, Math.max(this.target, strength))
    this.lastBumpAt = performance.now()
    this.start()
  }

  /**
   * 入场那一段：光升到给定的峰值并停在那儿，直到时间走完。
   * 退场交给样式上的那 .55s 淡出，不要再叠一层衰减。
   */
  rise(peak: number, holdMs: number): void {
    const now = performance.now()
    this.target = peak
    this.lastBumpAt = now
    this.entryUntil = now + holdMs
    this.start()
  }

  get(): number {
    return this.level
  }

  start(): void {
    if (this.frame) return
    let previous = performance.now()
    const step = (now: number) => {
      const dt = Math.min(64, now - previous)
      previous = now
      if (now > this.entryUntil && now - this.lastBumpAt > HOLD_MS) this.target = 0
      const rate = this.target > this.level ? RISE_MS : FALL_MS
      this.level += (this.target - this.level) * Math.min(1, dt / rate)
      if (this.level < FLOOR && this.target === 0) {
        this.level = 0
        this.write()
        this.stop()
        return
      }
      this.write()
      this.frame = requestAnimationFrame(step)
    }
    this.frame = requestAnimationFrame(step)
  }

  stop(): void {
    if (!this.frame) return
    cancelAnimationFrame(this.frame)
    this.frame = 0
  }

  /** Off / 系统减少动态：停在静值，帧循环不再跑。 */
  calm(): void {
    this.stop()
    this.entryUntil = 0
    this.level = 0
    this.target = 0
    this.write()
  }

  private write(): void {
    if (this.element) this.element.style.setProperty('--flow-level', this.level.toFixed(3))
  }
}

/**
 * 整屏只有一份流光：脚下那层光、伴星的口型、以后的实时字幕，读的都是这一个包络。
 * 两处各算一份的话，光和嘴一定会各动各的。
 */
export const companionEnvelope = new SpeechEnvelope()
