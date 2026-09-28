/**
 * 产物文档的模板（39d W4-1 / D4 §3、§5.1、§6）。
 *
 * 这份模板是**我们写的**，跑在与产物同一份文档里（同一个不透明 origin）。它只负责四件事：
 * 告诉宿主"起来了／还活着／坏了／有多高"，把宿主的动效档位转给产物，以及在文档解析期
 * 把样式与脚本搬到该在的位置。
 *
 * 它**不**是沙箱，也不假装是：隔离由 origin ＋ CSP ＋ 主进程请求闸承担（D4 §0/§3）。
 * 产物与模板同文档 ⇒ 产物能改模板的 DOM、能自己发消息——这没关系，父侧只认
 * "source 是这一个 frame 且阶段在白名单里"，其余一律忽略（`shared/artifact-frame.ts`）。
 *
 * ## 产物接口（D4 §9；2026-09-28 用户裁决后收紧）
 *
 * 产物渲染在 `#ailearn-artifact-root` 里，并**可选**地声明
 * `window.setLessonMotion(motion)`：`'reduced'` 时关掉自动播放与循环动画、停在最有
 * 信息量的那一帧。声明了就受宿主指令管；没声明就由它自己的
 * `prefers-reduced-motion` 决定——我们不替它造一个通用控制条（那正是把教具变回
 * 填好的表格的那一步）。
 *
 * 「共几步」不再由产物登记：讲解的条数是**服务端渲染出来的真实 DOM**（文字等价与依据
 * 回执，frame 之外、永远在屏上），所以步数由 `root` 上的 `data-artifact-outline-count`
 * 数出来——这是我们自己的数据，不依赖产物配合。
 */
const ARTIFACT_DOCUMENT_TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>动态讲解</title>
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.6 system-ui, -apple-system, "PingFang SC", "Noto Sans SC", sans-serif;
    color: #33261c; background: transparent;
  }
  #ailearn-artifact-root { display: block; padding: 12px; }
</style>
<!--__AILEARN_ARTIFACT_STYLES__-->
</head>
<body>
<div id="ailearn-artifact-root"><!--__AILEARN_ARTIFACT__--></div>
<!--__AILEARN_ARTIFACT_SCRIPTS__-->
<script>
(function () {
  var CHANNEL = 'ailearn:artifact-frame';
  var root = document.getElementById('ailearn-artifact-root');
  var prefersReduced = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
  var motion = prefersReduced ? 'reduced' : 'full';

  function post(phase, extra) {
    var message = { channel: CHANNEL, direction: 'frame->host', phase: phase };
    if (extra) { for (var key in extra) { message[key] = extra[key]; } }
    try { parent.postMessage(message, '*'); } catch (error) { /* 发不出去就不发：握手不能把自己拖死 */ }
  }

  // 讲解条数由**我们自己渲染出来的**文字等价数出来，不向产物要。产物是模型的，
  // 让它报自己的步数等于让它决定界面上写"共几步"。
  function outlineCount() {
    if (!root) return 0;
    var declared = Number(root.getAttribute('data-artifact-outline-count'));
    if (isFinite(declared) && declared > 0) return declared;
    return root.querySelectorAll('[data-artifact-outline]').length;
  }

  /** 把动效档位转给产物自己声明的钩子。没声明就什么都不做。 */
  function forwardMotion(next) {
    motion = next;
    var fn = window.setLessonMotion;
    if (typeof fn !== 'function') return;
    try { fn(next); } catch (error) { /* 产物自己的问题：报出去，但不摘 frame */ post('error', { detail: 'setLessonMotion failed' }); }
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== 'host->frame') return;
    if (data.command === 'motion' && (data.motion === 'full' || data.motion === 'reduced')) {
      forwardMotion(data.motion);
    }
  });

  window.addEventListener('error', function (event) {
    post('error', { detail: String((event && event.message) || 'unknown') });
  });

  // ── 高度握手 ────────────────────────────────────────────────────────────
  // 父侧量不到本 frame 的内容（不透明 origin），所以高度由这里报。
  // 不给这一格，宿主只能给一个写死的行高：内容被压进一小格、frame 内部自己出
  // 滚动条，而"共 N 步"飘在旁边——那不是设计，是两边对不上尺寸。
  function contentHeight() {
    var el = document.documentElement;
    var body = document.body;
    return Math.max(
      el ? el.scrollHeight : 0,
      el ? el.offsetHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0
    );
  }

  function reportSize() {
    post('heartbeat', { contentHeight: contentHeight() });
  }

  if (typeof ResizeObserver === 'function') {
    try {
      var ro = new ResizeObserver(reportSize);
      if (document.documentElement) ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    } catch (error) { /* 量不到就退回心跳里带的那一次 */ }
  }

  function announceReady() {
    post('ready', { stepCount: outlineCount(), contentHeight: contentHeight() });
    reportSize();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announceReady);
  } else {
    announceReady();
  }

  // 心跳：宿主据此判断"这份动态内容还活着"。循环体写在回调里，不会阻塞解析。
  // 顺带把当前高度带上去（父侧量不到这边），所以父侧不需要独立的 resize 通道。
  setInterval(function () { post('heartbeat', { contentHeight: contentHeight() }); }, 1000);
})();
</script>
</body>
</html>
`

export function artifactDocumentTemplate(): string {
  return ARTIFACT_DOCUMENT_TEMPLATE
}

/** 组装时用来定位内容落点的标记（`artifact-surface.ts` 与模板之间唯一的约定）。 */
export const ARTIFACT_TEMPLATE_PLACEHOLDER = '<!--__AILEARN_ARTIFACT__-->'

/**
 * 样式与脚本的落点标记。
 *
 * 模型写的那份文档由服务端拆成三段（`round-artifact-doc.ts` 的 `splitArtifactDocumentV1`）：
 * 样式进 `<head>`、标记进内容落点、脚本进 `</body>` 前。落点分开之后，"模型在标记中间
 * 塞一个脚本、脚本跑的时候 DOM 还没排完"这一类时序问题就不由它自己承担了。
 */
export const ARTIFACT_TEMPLATE_STYLE_PLACEHOLDER = '<!--__AILEARN_ARTIFACT_STYLES__-->'
export const ARTIFACT_TEMPLATE_SCRIPT_PLACEHOLDER = '<!--__AILEARN_ARTIFACT_SCRIPTS__-->'
