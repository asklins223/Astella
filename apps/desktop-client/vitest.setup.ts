import { configure } from '@testing-library/react'

/**
 * React 19 只在 `IS_REACT_ACT_ENVIRONMENT` 为真时让 `act` 真的把更新冲干净。
 * 这个标记原来没给：Testing Library 的 `render`/`fireEvent` 于是只在 stderr 留一句
 * "The current testing environment is not configured to support act(...)"，而 passive
 * effect 与状态更新被排到渲染**之后**——`fireEvent` 紧接一句同步 `getByRole` 的用例
 * 就成了运气：本地单跑基本赶得上，CI 全量并行时赶不上。v1.4.0 两轮发布 CI 各红一条，
 * 形状都是这个（一条点了提交却没发出租约上报，一条粘贴后找不到「开始解析」），
 * 本地 406 文件全量跑都复现不出来。
 *
 * 这里给的是 Testing Library 官方要求的那个开关，不是往生产代码里塞兜底：
 * 改的是"测试环境怎么解释 act"，用例断言的内容一个字没动。
 */
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * 放宽 Testing Library 的异步等待上限（默认 1000ms）。
 *
 * 这只影响"轮询等 UI 更新"的等待时长，不影响任何断言内容：真正没渲染出来的东西
 * 照样会失败，只是晚几秒。放宽的原因见 `vitest.config.ts`——全量并行跑时机器负载高，
 * 默认 1s 会让**单跑通过**的用例随机变红。
 */
configure({ asyncUtilTimeout: 5_000 })

/**
 * jsdom 没实现 `HTMLMediaElement` 的 `play()/load()`，而 `play()` 返回的是 `undefined`
 * ——于是生产代码里那句 `element.play().catch(...)` 在测试环境抛
 * `Cannot read properties of undefined`。它作为**未捕获异常**落在用例结束之后：
 * vitest 在摘要里记 `Errors 2`，**exit code 却还是 0**，所以"全绿"里一直藏着两条。
 *
 * 补的是真浏览器的语义（返回一个 Promise），不是往生产代码里塞可选链兜底：
 * 那种写法会让"媒体 API 永远返回 Promise"这个真实合同在代码里消失。
 * 用例自己往实例上赋 `play` 的（试听与"放不出来"那两条）不受影响——实例属性优先于原型。
 */
if (typeof HTMLMediaElement !== "undefined") {
  HTMLMediaElement.prototype.load = () => undefined
  HTMLMediaElement.prototype.play = () => Promise.resolve()
}

/**
 * jsdom 没实现 `Range.prototype.getClientRects`，而 ProseMirror 的
 * `EditorView.scrollToSelection` 会对选区那个 Range 调它（`singleRect`）——
 * 报出来的是**未捕获异常** `target.getClientRects is not a function`：用例照样通过、
 * exit code 照样 0，只在摘要里留一个 `Errors` 段（同上面媒体那条的形状）。
 *
 * 补的是真浏览器的语义（返回一个 DOMRectList 形状），不是往生产代码里塞可选链：
 * 那条路的产物只是滚动位置，jsdom 里没有布局可量。
 */
if (typeof Range !== "undefined") {
  const emptyRectList = () => {
    const list: DOMRect[] = []
    return Object.assign(list, { item: (index: number) => list[index] ?? null }) as unknown as DOMRectList
  }
  Range.prototype.getClientRects = emptyRectList as unknown as Range["getClientRects"]
  Range.prototype.getBoundingClientRect = () => new DOMRect()
}

// jsdom has no viewport observer. Exercise lazy CodeMirror node views as visible;
// asynchronous delivery matches the browser and lets their constructor finish first.
if (typeof window !== "undefined" && typeof IntersectionObserver === "undefined") {
  class VisibleIntersectionObserver implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = "0px"
    readonly thresholds = [0]
    private targets = new Set<Element>()
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.targets.add(target)
      queueMicrotask(() => {
        if (!this.targets.has(target)) return
        const rect = target.getBoundingClientRect()
        this.callback([{ target, isIntersecting: true, intersectionRatio: 1, time: performance.now(), boundingClientRect: rect, intersectionRect: rect, rootBounds: null }], this)
      })
    }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
    takeRecords(): IntersectionObserverEntry[] { return [] }
  }
  globalThis.IntersectionObserver = VisibleIntersectionObserver
}
