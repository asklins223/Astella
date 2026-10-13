/* Geometry, interruption and DOM continuity for the portable companion demo. */
(function (scope) {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function spring(t) {
    // Slightly under-damped: a small settling tail, without rubbery overshoot.
    return 1 - Math.exp(-8.5 * t) * (Math.cos(8 * t) + 1.0625 * Math.sin(8 * t));
  }
  function frames(make, count = 48) {
    // The second argument is raw progress: the spring saturates early, so anything
    // that must keep moving to the end of a transition (a fading page) needs it.
    return Array.from({ length: count + 1 }, (_, i) => {
      const offset = i / count;
      return { ...make(i === count ? 1 : spring(offset), offset), offset };
    });
  }
  function panelPlacement(type, origin, size, height) {
    const margin = 12;
    const expanded = ['ask', 'choose-note', 'voice', 'consent', 'agent-work'].includes(type);
    const width = expanded ? size.width - margin * 2 : Math.min(size.width - margin * 2, 304);
    const maxHeight = size.height - 76;
    height = Math.min(height, maxHeight);
    let x = type === 'spaces' ? size.width - width - margin : expanded ? (size.width - width) / 2 : origin.x;
    let y = expanded ? size.height - height - 16 : origin.y + origin.height + 9;
    if (!expanded && y + height > size.height - 16) y = origin.y - height - 10;
    return { x: clamp(x, margin, size.width - width - margin), y: clamp(y, 48, size.height - height - 16), width, height };
  }
  function localRect(rect, root) {
    return { x: rect.left - root.left, y: rect.top - root.top, width: rect.width, height: rect.height };
  }
  function rectTransform(from, to) {
    return { x: from.x - to.x, y: from.y - to.y, sx: Math.max(.04, from.width / to.width), sy: Math.max(.04, from.height / to.height) };
  }
  const transform = ({ x = 0, y = 0, sx = 1, sy = 1 }) => `translate(${x}px, ${y}px) scale(${sx}, ${sy})`;
  // A transition ghost carries the same node keys as the live page it was cloned from.
  // If the reconciler is allowed to match one, the clone is promoted to being the page
  // and its own exit cleanup then deletes the real content.
  const isGhost = node => node.nodeType === 1 && node.hasAttribute('data-ghost');
  function key(node) {
    if (node.nodeType !== 1 || isGhost(node)) return null;
    return node.id || node.dataset.nodeKey || node.dataset.messageId ||
      (node.dataset.action ? `${node.tagName}:${node.dataset.action}:${node.dataset.id || node.dataset.tab || node.dataset.filter || node.dataset.pane || node.dataset.space || node.dataset.text || node.dataset.key || ''}` : null);
  }
  function reconcile(parent, html) {
    const template = document.createElement('template'); template.innerHTML = html;
    patchChildren(parent, template.content);
  }
  function patchChildren(parent, desired) {
    const old = [...parent.childNodes].filter(node => !isGhost(node)); const used = new Set();
    const keyed = new Map(old.map(node => [key(node), node]).filter(([k]) => k));
    let cursor = old[0] || null;
    for (const next of [...desired.childNodes]) {
      const k = key(next);
      let current = k ? keyed.get(k) : old.find(node => !used.has(node) && !key(node) && node.nodeType === next.nodeType && node.nodeName === next.nodeName);
      if (!current || used.has(current) || current.nodeName !== next.nodeName) current = next.cloneNode(true);
      else patchNode(current, next);
      used.add(current);
      if (current !== cursor) parent.insertBefore(current, cursor);
      cursor = current.nextSibling;
    }
    old.forEach(node => { if (!used.has(node)) node.remove(); });
  }
  function patchNode(current, next) {
    if (current.nodeType !== 1) { if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue; return; }
    for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name) && attr.name !== 'style') current.removeAttribute(attr.name);
    for (const attr of [...next.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    if (current.matches('textarea,input')) {
      if (current.type !== 'file' && current.value !== next.value) current.value = next.value;
      return;
    }
    patchChildren(current, next);
  }
  class Motion {
    constructor(root) { this.root = root; this.running = new Map(); this.reduced = matchMedia('(prefers-reduced-motion: reduce)'); this.reduced.addEventListener('change', () => { if (this.off) this.finish(); }); }
    get off() { return this.root.classList.contains('motion-off') || this.reduced.matches; }
    capture(node) {
      const style = getComputedStyle(node);
      const value = { transform: style.transform, opacity: style.opacity, borderRadius: style.borderRadius };
      this.cancel(node); return value;
    }
    cancel(node) { const entry = this.running.get(node); if (entry) { entry.animation.cancel(); this.running.delete(node); } }
    finish() { for (const [node, entry] of this.running) { entry.animation.cancel(); this.running.delete(node); entry.done?.(); } }
    play(node, keyframes, { duration = 440, done } = {}) {
      this.cancel(node);
      if (this.off) { done?.(); return; }
      const animation = node.animate(keyframes, { duration, easing: 'linear', fill: 'both' });
      const entry = { animation, done }; this.running.set(node, entry);
      animation.onfinish = () => { if (this.running.get(node) !== entry) return; this.running.delete(node); animation.cancel(); done?.(); };
    }
    rect(node, from, to, { opacity = .2, done, duration = 460 } = {}) {
      node.style.transformOrigin = '0 0';
      const start = rectTransform(from, to);
      this.play(node, frames(p => ({ transform: transform({ x: start.x * (1-p), y: start.y * (1-p), sx: 1+(start.sx-1)*(1-p), sy: 1+(start.sy-1)*(1-p) }), opacity: opacity+(1-opacity)*clamp(p, 0, 1) })), { duration, done });
    }
    settle(node, current, { done, duration = 400 } = {}) {
      const matrix = new DOMMatrix(current.transform === 'none' ? undefined : current.transform);
      this.play(node, frames(p => ({ transform: transform({ x: matrix.e*(1-p), y: matrix.f*(1-p), sx: 1+(matrix.a-1)*(1-p), sy: 1+(matrix.d-1)*(1-p) }), opacity: Number(current.opacity)+(1-Number(current.opacity))*clamp(p, 0, 1) })), { duration, done });
    }
    dismiss(node, origin, target, done) {
      const current = this.capture(node);
      const matrix = new DOMMatrix(current.transform === 'none' ? undefined : current.transform);
      const end = rectTransform(origin, target);
      this.play(node, frames(p => ({ transform: transform({ x: matrix.e+(end.x-matrix.e)*p, y: matrix.f+(end.y-matrix.f)*p, sx: matrix.a+(end.sx-matrix.a)*p, sy: matrix.d+(end.sy-matrix.d)*p }), opacity: Number(current.opacity)*(1-clamp(p*1.3, 0, 1)) })), { duration: 340, done });
    }
    press(node, release = false) {
      // Do not take over the identity's centering transform.
      if (node.matches('.identity,.scrim')) return;
      const current = this.capture(node); const matrix = new DOMMatrix(current.transform === 'none' ? undefined : current.transform);
      const target = release ? 1 : .965;
      node.style.transform = `scale(${target})`;
      if (this.off) { node.style.transform = ''; return; }
      this.play(node, frames(p => ({ transform: `scale(${matrix.a+(target-matrix.a)*p})` })), { duration: release ? 320 : 150 });
    }
  }
  const api = { clamp, spring, frames, panelPlacement, localRect, rectTransform, reconcile, Motion };
  if (typeof module !== 'undefined') module.exports = api;
  else scope.MOBILE_DEMO_MOTION = api;
})(typeof window !== 'undefined' ? window : this);
