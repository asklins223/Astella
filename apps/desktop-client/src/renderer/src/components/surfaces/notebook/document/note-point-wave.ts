export interface PointWaveViewport { width: number; height: number; top: number; visibleHeight: number }
type Dot = { x: number; y: number; size: number };

/** A full-coverage holographic surface with spherical swells, shared with the native reader.
 * One continuous mesh belongs to the request. No React updates or note layout per frame.
 */
export function createNotePointWave(canvas: HTMLCanvasElement, identity: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { resize(_view: PointWaveViewport) {}, destroy() {} };
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0, last = 0, elapsed = 0, previousPaint = 0, destroyed = false;
  let geometry: PointWaveViewport = { width: 1, height: 1, top: 0, visibleHeight: 1 };
  let points: Dot[] = [], projected = new Float32Array(0), pointKey = "", layoutKey = "";
  let dotColor = "#2F6BFF";
  let seed = 2166136261;
  for (const char of identity) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  const random = (value: number) => {
    let x = Math.imul(value ^ seed, 0x45d9f3b); x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  };
  const motion = () => {
    const shell = canvas.closest<HTMLElement>(".desktop-app");
    const reduced = query.matches || document.documentElement.classList.contains("reduce-motion")
      || shell?.dataset.motionMode === "off" || shell?.dataset.motionMode === "lite" || shell?.dataset.reducedMotion === "true";
    const paused = document.hidden || document.documentElement.classList.contains("note-background")
      || !!canvas.closest(".note-work-offscreen, .note-ai-work-range.is-offscreen, .note-ai-work-layer.is-paused");
    return { reduced, paused };
  };
  const draw = () => {
    if (!ctx) return;
    const { width, height, top, visibleHeight } = geometry;
    ctx.clearRect(0, 0, width, visibleHeight);
    const t = elapsed;
    const originY = top + visibleHeight / 2;
    for (let index = 0; index < points.length; index++) {
      const p = points[index];
      const a = p.x * .022 + p.y * .009 - t * 1.35;
      const b = p.x * .011 - p.y * .018 + t * .86 + 1.7;
      const rx = p.x - width * .38, ry = p.y - Math.min(height * .43, 460);
      const distance = Math.max(1, Math.hypot(rx, ry));
      const radial = distance * .026 - t * 1.6;
      const z = Math.sin(a) * .42 + Math.sin(b) * .2 + Math.sin(radial) * .38;
      const depth = Math.max(0, Math.min(.999, .5 + z * .55));
      const perspective = 1 + z * .105;
      const normalX = Math.cos(a) * 9 + Math.cos(radial) * rx / distance * 11;
      const normalY = Math.cos(b) * 7 + Math.cos(radial) * ry / distance * 11;
      const offset = index * 4;
      projected[offset] = width / 2 + (p.x - width / 2) * perspective + normalX;
      projected[offset + 1] = visibleHeight / 2 + (p.y - originY) * perspective + normalY + z * 16;
      projected[offset + 2] = (.85 + depth * .75) * p.size;
      projected[offset + 3] = Math.floor(depth * 4);
    }
    // Near crests carry a tight laser halo, while valleys remain visible across the surface.
    ctx.fillStyle = dotColor; ctx.globalAlpha = .10; ctx.beginPath();
    for (let index = 0; index < points.length; index++) {
      const o = index * 4; if (projected[o + 3] < 3) continue;
      const r = projected[o + 2] * 2.5;
      ctx.moveTo(projected[o] + r, projected[o + 1]); ctx.arc(projected[o], projected[o + 1], r, 0, Math.PI * 2);
    }
    ctx.fill();
    for (let bucket = 0; bucket < 4; bucket++) {
      ctx.globalAlpha = [.34, .50, .72, .96][bucket]; ctx.beginPath();
      for (let index = 0; index < points.length; index++) {
        const o = index * 4; if (projected[o + 3] !== bucket) continue;
        const r = projected[o + 2];
        ctx.moveTo(projected[o] + r, projected[o + 1]); ctx.arc(projected[o], projected[o + 1], r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  const tick = (now: number) => {
    frame = 0;
    if (destroyed || !ctx) return;
    const state = motion();
    if (state.paused || state.reduced) { last = 0; draw(); return; }
    if (last) elapsed += Math.min(.1, (now - last) / 1000);
    last = now;
    if (now - previousPaint >= 1000 / 30) { previousPaint = now; draw(); }
    frame = requestAnimationFrame(tick);
  };
  const sync = () => {
    cancelAnimationFrame(frame); frame = 0; last = 0;
    if (destroyed || !ctx) return;
    dotColor = getComputedStyle(canvas).color || "#2F6BFF";
    const state = motion(); draw();
    if (!state.paused && !state.reduced) frame = requestAnimationFrame(tick);
  };
  const observer = new MutationObserver(sync);
  // Changes to these ancestors carry app/system motion preferences and visibility.
  for (let element: HTMLElement | null = canvas.parentElement; element; element = element.parentElement) {
    observer.observe(element, { attributes: true, attributeFilter: ["class", "data-motion-mode", "data-reduced-motion"] });
  }
  query.addEventListener("change", sync); document.addEventListener("visibilitychange", sync);
  return {
    resize(view: PointWaveViewport) {
      const visibleHeight = view.visibleHeight;
      geometry = view;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const nextLayout = [view.width, visibleHeight, dpr].join(":");
      if (nextLayout !== layoutKey) {
        layoutKey = nextLayout;
        canvas.width = Math.max(1, Math.ceil(view.width * dpr)); canvas.height = Math.max(1, Math.ceil(visibleHeight * dpr));
        ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      canvas.style.width = `${view.width}px`; canvas.style.height = `${visibleHeight}px`; canvas.style.top = `${geometry.top}px`;
      const spacing = Math.max(11.5, Math.sqrt((view.width + 96) * (visibleHeight + 224) / 3800));
      const first = Math.floor((view.top - 112) / spacing), end = Math.ceil((view.top + visibleHeight + 112) / spacing);
      const columns = Math.ceil((view.width + 96) / spacing);
      const key = [spacing, first, end, columns].join(":");
      if (key !== pointKey) {
        pointKey = key; points = [];
        for (let row = first; row <= end; row++) for (let column = 0; column < columns; column++) {
          const id = row * 8191 + column * 7;
          points.push({ x: -48 + (column + (row & 1) * .5 + (random(id) - .5) * .18) * spacing,
            y: (row + (random(id + 1) - .5) * .18) * spacing, size: .9 + random(id + 2) * .2 });
        }
        projected = new Float32Array(points.length * 4);
      }
      sync();
    },
    destroy() { destroyed = true; cancelAnimationFrame(frame); observer.disconnect(); query.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync); canvas.width = canvas.height = 1; points = []; projected = new Float32Array(0); },
  };
}
