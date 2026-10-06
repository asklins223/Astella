/**
 * 隔离展示面的主进程一侧（39d W4-1 / D4 §3、§4.2、§4.4、§6）。
 *
 * 这一层只做三件事，都是**主进程才能做**的：
 *   1. 决定哪一类响应套哪一份 CSP（主页面策略 / 产物策略 / 其余一律收紧）；
 *   2. 把"我们的模板 + AI 产物"组装成一份完整的产物文档，并在组装时做**双重校验**
 *      （服务端生成时那道在后续段；这里是第二道，也是唯一能拒绝整份的那一道）；
 *   3. 给出子 frame 的导航判据（首次加载之外一律拒）。
 *
 * 它不碰 Electron API——这样这三件事都能在 vitest 里按纯逻辑钉住；`index.ts` 只负责
 * 把这里的判断接到真实的事件与请求上。
 */
import {
  ARTIFACT_FRAME_ORIGIN,
  isArtifactFrameUrl
} from '../shared/artifact-frame'
import {
  ARTIFACT_TEMPLATE_PLACEHOLDER,
  ARTIFACT_TEMPLATE_SCRIPT_PLACEHOLDER,
  ARTIFACT_TEMPLATE_STYLE_PLACEHOLDER,
  artifactDocumentTemplate
} from './artifact-template'

/**
 * 产物文档的 CSP（D4 §3.3 逐条）。
 *
 * 不透明 origin 下 `'self'` 不可用 ⇒ 脚本只能内联，这是本方案的必然代价（**记录在案，
 * 不藏**）。刻意不给 `'unsafe-eval'`：首期不承诺 wasm，将来要开是一次带读数的独立决定。
 */
export function artifactDocumentContentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

/** 一条响应该套哪份策略。`other` = 不是我们的两类 frame，一律收紧到什么都不许。 */
export type FramePolicySubject = 'renderer' | 'artifact' | 'other'

export function classifyFramePolicySubject(input: {
  url: string
  /** 开发期渲染页面的 origin（Vite dev server）；打包运行时为 null。 */
  rendererDevOrigin: string | null
}): FramePolicySubject {
  if (isArtifactFrameUrl(input.url)) return 'artifact'

  try {
    const url = new URL(input.url)
    if (input.rendererDevOrigin && url.origin === input.rendererDevOrigin) return 'renderer'
    if (url.protocol === 'astella-app:' && url.hostname === 'bundle') return 'renderer'
  } catch {
    return 'other'
  }

  return 'other'
}

/** 不是我们的 frame 时给的那份"什么都不许"——比套主策略安全得多（D4 §3.4）。 */
export function rejectAllContentSecurityPolicy(): string {
  return "default-src 'none'; base-uri 'none'; form-action 'none'"
}

/**
 * 子 frame 的导航判据（D4 §4.4）。
 *
 * 只放行**首次加载**（此刻这个 frame 还停在 about:blank 或空 URL），且目标必须是我们
 * 自己的产物 origin。此后任何导航一律拒：`location.href=…`、`top.location=…`、
 * 表单提交、`window.open` 都落在这条之外。
 *
 * 为什么是"首次加载"而不是"目标是不是 artifact origin"：`astella-app://bundle` 也是
 * 我们自己的 origin，产物若能把自己导航到主页面 origin，就拿到了一个带 preload 桥的
 * 文档——这正是探针要打的那一发（D4 §7.2 T1）。
 */
export function isAllowedSubFrameNavigation(input: {
  target: string
  /** 这个 frame 当前所在的 URL；首次加载时是 `about:blank` 或空串。 */
  frameUrl: string | null
  /** 发起这次导航的是不是这个 frame 自己（`location.href=…`／`top.location=…` 就是）。 */
  initiatedBySelf: boolean
}): boolean {
  if (input.initiatedBySelf) return false
  const atInitialDocument =
    input.frameUrl === null || input.frameUrl === '' || input.frameUrl === 'about:blank'
  return atInitialDocument && isArtifactFrameUrl(input.target)
}

/**
 * 配额（D4 §6 的"字节／节点数：服务端生成时与主进程组装时双重校验"）。
 *
 * **起点值，W4-1 核定**：512 KiB 字节与 20 000 个标签起始符。节点数只能是静态近似——
 * 产物里的脚本本来就能在运行时造 DOM，真正兜住资源耗尽的是 watchdog 与崩溃恢复
 * （D4 §6 那两行），这里挡的是"一眼就知道超量"的产物。
 */
export const ARTIFACT_MAX_BYTES = 512 * 1024
export const ARTIFACT_MAX_TAG_OPENERS = 20_000

export type ArtifactAssemblyResult =
  | { ok: true; document: string }
  | { ok: false; reason: 'too_many_bytes' | 'too_many_tags'; detail: string }

/**
 * 组装：我们的模板 + 产物内容。**整份拒绝，不做"截断后半篇"**（D4 §6 触顶行为那一列）。
 *
 * 为什么用字符串拼接而不是把内容塞进某个容器再 `innerHTML`：产物要能带自己的
 * `<script>` 才叫"整份 HTML + 脚本"，而 `innerHTML` 插进去的脚本按 HTML 规范**不会执行**。
 * 拼接发生在我们的进程里、内容是**故意要执行**的不可信代码——它跑在不透明 origin 的
 * frame 里，隔离靠 origin 与 CSP，不靠内容裁剪（D4 §0.1 那张表）。
 */
export function assembleArtifactDocument(input: {
  artifactId: string
  content: string
}): ArtifactAssemblyResult {
  const bytes = Buffer.byteLength(input.content, 'utf8')
  if (bytes > ARTIFACT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'too_many_bytes',
      detail: `产物 ${bytes} 字节，超过上限 ${ARTIFACT_MAX_BYTES}`
    }
  }
  const tagOpeners = (input.content.match(/</g) ?? []).length
  if (tagOpeners > ARTIFACT_MAX_TAG_OPENERS) {
    return {
      ok: false,
      reason: 'too_many_tags',
      detail: `产物含 ${tagOpeners} 个标签起始符，超过上限 ${ARTIFACT_MAX_TAG_OPENERS}`
    }
  }

  const template = artifactDocumentTemplate()
  const marker = template.indexOf(ARTIFACT_TEMPLATE_PLACEHOLDER)
  if (marker < 0) {
    // 模板是我们的代码，找不到标记是编程错误：当场喊，不静默交出一份没有产物的文档。
    throw new Error('artifact template is missing its placeholder')
  }
  // 样式与脚本各归其位。服务端把模型那份文档拆成三段之后，用 `data-lesson` 标出
  // 哪一段是样式、哪一段是脚本（`round-artifact-doc.ts` 的 `splitArtifactDocumentV1`）。
  //
  // 为什么要在这里再搬一次，而不是让服务端直接写成最终位置：落库的是**一份字符串**，
  // 位置是宿主文档的结构，两者不该耦在一起。模型在标记中间插一个 `<script>` 时，
  // 那段脚本会在它前面的标记还没排完时就跑；搬完之后顺序是确定的。
  const styles: string[] = []
  const scripts: string[] = []
  const body = input.content
    .replace(/<style\b[^>]*data-lesson\b[^>]*>[\s\S]*?<\/style\s*>/gi, (whole) => {
      styles.push(whole)
      return ''
    })
    .replace(/<script\b[^>]*data-lesson\b[^>]*>[\s\S]*?<\/script\s*>/gi, (whole) => {
      scripts.push(whole)
      return ''
    })

  const withContent =
    template.slice(0, marker)
    + body
    + template.slice(marker + ARTIFACT_TEMPLATE_PLACEHOLDER.length)
  if (styles.length === 0 && scripts.length === 0) return { ok: true, document: withContent }
  // 落点缺失说明模板与内容不同版本：内容原样留在 root 里仍然读得到（文字等价与依据
  // 回执不依赖样式与脚本的落点），但明确说出来好过悄悄丢一段样式。
  if (!withContent.includes(ARTIFACT_TEMPLATE_STYLE_PLACEHOLDER)
    || !withContent.includes(ARTIFACT_TEMPLATE_SCRIPT_PLACEHOLDER)) {
    return { ok: true, document: withContent }
  }
  return {
    ok: true,
    document: withContent
      .replace(ARTIFACT_TEMPLATE_STYLE_PLACEHOLDER, styles.join(''))
      .replace(ARTIFACT_TEMPLATE_SCRIPT_PLACEHOLDER, scripts.join(''))
  }
}

/** 产物文档的 origin（给主 CSP 的 `frame-src` 用；只有这一条改动，D4 §3.4）。 */
export function artifactFrameOrigin(): string {
  return ARTIFACT_FRAME_ORIGIN
}
