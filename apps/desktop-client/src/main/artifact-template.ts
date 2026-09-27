/**
 * 产物文档的模板（39d W4-1 / D4 §3、§5.1、§6）。
 *
 * 这份模板是**我们写的**，跑在与产物同一份文档里（同一个不透明 origin）。它只负责三件事：
 * 给出渲染落点、把"起来了／还活着／坏了"发给宿主、按宿主指令切静态分镜。
 *
 * 它**不**是沙箱，也不假装是：隔离由 origin ＋ CSP ＋ 主进程请求闸承担（D4 §0/§3）。
 * 产物与模板同文档 ⇒ 产物能改模板的 DOM、能自己发消息——这没关系，父侧只认
 * "source 是这一个 frame 且阶段在白名单里"，其余一律忽略（`shared/artifact-frame.ts`）。
 *
 * 产物接口（D4 §9 留给 W4-1 定的那一条）：
 *   产物在 `#ailearn-artifact-root` 里渲染，并可选地登记
 *   `window.__artifact = { stepCount: n, render(i) }`。
 *   登记了步数，宿主就能切静态分镜（每一步都可见、可读，不丢步骤）；
 *   服务端已生成的静态 section 按 data-artifact-step 计数并原样保留；
 *   其余没有登记的内容按单帧显示。
 */
const ARTIFACT_DOCUMENT_TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>动态讲解</title>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.6 system-ui, -apple-system, "PingFang SC", "Noto Sans SC", sans-serif;
    color: #2b2118; background: transparent;
  }
  #ailearn-artifact-root { display: block; padding: 12px; }
  .ailearn-artifact-pane {
    display: block; padding: 10px 12px; margin: 0 0 10px;
    border: 1px solid rgba(120, 96, 72, 0.35); border-radius: 10px;
  }
  .ailearn-artifact-pane::before {
    content: "第 " attr(data-artifact-step-display) " 步";
    display: block; margin-bottom: 6px; font-size: 12px; opacity: 0.7;
  }
</style>
</head>
<body>
<div id="ailearn-artifact-root"><!--__AILEARN_ARTIFACT__--></div>
<script>
(function () {
  var CHANNEL = 'ailearn:artifact-frame';
  var root = document.getElementById('ailearn-artifact-root');
  var prefersReduced = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
  var motion = prefersReduced ? 'reduced' : 'full';

  function artifact() { return window.__artifact || null; }

  function stepCount() {
    var a = artifact();
    if (!a) return root ? root.querySelectorAll('[data-artifact-step]').length : 0;
    if (typeof a.stepCount === 'number' && isFinite(a.stepCount) && a.stepCount > 0) return a.stepCount;
    if (a.steps && typeof a.steps.length === 'number') return a.steps.length;
    return 0;
  }

  function post(phase, extra) {
    var message = { channel: CHANNEL, direction: 'frame->host', phase: phase };
    if (extra) { for (var key in extra) { message[key] = extra[key]; } }
    try { parent.postMessage(message, '*'); } catch (error) { /* 发不出去就不发：播放器不能因为一条消息把自己拖死 */ }
  }

  function render(step) {
    var a = artifact();
    if (!a || typeof a.render !== 'function') return;
    a.render(step);
  }

  // 静态分镜（D4 §5.1）：每一步各渲染一次并把那一刻的 DOM 铺成一列。
  // 步数不变、内容不丢；如实取舍是 canvas 像素与脚本状态不在快照里。
  function staticStoryboard() {
    // Server-authored panes are already a storyboard; do not duplicate the whole document per step.
    if (!artifact()) return;
    var count = stepCount();
    if (!root || count <= 0) return;
    var snapshots = [];
    for (var i = 0; i < count; i += 1) {
      render(i);
      snapshots.push(root.innerHTML);
    }
    root.innerHTML = '';
    for (var j = 0; j < snapshots.length; j += 1) {
      var pane = document.createElement('section');
      pane.className = 'ailearn-artifact-pane';
      pane.setAttribute('data-artifact-step', String(j));
      pane.setAttribute('data-artifact-step-display', String(j + 1));
      pane.innerHTML = snapshots[j];
      root.appendChild(pane);
    }
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== 'host->frame') return;
    if (data.command === 'motion' && (data.motion === 'full' || data.motion === 'reduced')) {
      motion = data.motion;
      if (motion === 'reduced') staticStoryboard();
    }
  });

  window.addEventListener('error', function (event) {
    post('error', { detail: String((event && event.message) || 'unknown') });
  });

  function announceReady() {
    post('ready', { stepCount: stepCount() });
    if (motion === 'reduced') staticStoryboard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announceReady);
  } else {
    announceReady();
  }

  // 心跳：宿主据此判断"这份动态内容还活着"。循环体写在回调里，不会阻塞解析。
  setInterval(function () { post('heartbeat'); }, 1000);
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
