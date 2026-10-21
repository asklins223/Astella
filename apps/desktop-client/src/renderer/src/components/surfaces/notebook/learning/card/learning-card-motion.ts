/** Finite decorative reward; every animation is disposable and never gates controls. */
export function playLearningCardReward(root: HTMLElement, score: number, reduced: boolean): () => void {
  const layer = root.querySelector<HTMLElement>(".lc-celebration-effects");
  const counter = root.querySelector<HTMLElement>("[data-award-score]");
  const animations: Animation[] = [], timers: ReturnType<typeof setTimeout>[] = [];
  let raf = 0, alive = true;
  const stop = () => {
    alive = false; cancelAnimationFrame(raf); timers.forEach(clearTimeout);
    animations.forEach((animation) => animation.cancel()); layer?.replaceChildren();
    if (counter) counter.textContent = String(score);
  };
  if (reduced || !layer || !counter || typeof layer.animate !== "function") return stop;
  const later = (fn: () => void, delay: number) => timers.push(setTimeout(() => { if (alive) fn(); }, delay));
  const colors = ["#c69a39", "#f3d678", "#aac58b", "#d3a77c", "#d4e9c8", "#eacdb5", "#9ebba7"];
  const width = layer.clientWidth, height = layer.clientHeight;
  for (const side of [-1, 1]) for (let index = 0; index < 36; index++) {
    const paper = document.createElement("i"), size = 5 + index % 5 * 1.4;
    Object.assign(paper.style, { position: "absolute", left: `${side < 0 ? -12 : width + 12}px`, top: `${height * (.7 + index % 8 * .02)}px`, width: `${size}px`, height: `${index % 6 === 0 ? size : size * .5}px`, borderRadius: index % 6 === 0 ? "50%" : "1px", background: colors[index % colors.length], opacity: "0" });
    layer.append(paper);
    const travel = -side * width * (.25 + index % 11 * .027), rise = height * (.58 + index % 7 * .055), spin = side * (150 + index % 9 * 61);
    const duration = 2300 + index % 7 * 170, delay = (side < 0 ? 650 : 820) + index % 6 * 31;
    animations.push(paper.animate([
      { offset: 0, transform: "translate3d(0,0,0) rotate(0)", opacity: 0 },
      { offset: .06, opacity: .95 },
      { offset: .28, transform: `translate3d(${travel * .58}px,${-rise * .83}px,0) rotate(${spin * .4}deg)`, opacity: .92 },
      { offset: .52, transform: `translate3d(${travel}px,${-rise}px,0) rotate(${spin * .7}deg)`, opacity: .9 },
      { offset: .78, transform: `translate3d(${travel * 1.26}px,${-rise * .42}px,0) rotate(${spin}deg)`, opacity: .75 },
      { offset: 1, transform: `translate3d(${travel * 1.42}px,${height * .5}px,0) rotate(${spin * 1.4}deg)`, opacity: 0 },
    ], { duration, delay, easing: "linear", fill: "both" }));
    later(() => paper.remove(), delay + duration + 50);
  }
  for (const [cx, cy, delay] of [[.14, .19, 1050], [.88, .26, 1260], [.76, .73, 1510]]) for (let index = 0; index < 10; index++) {
    const ray = document.createElement("i"), angle = index / 10 * Math.PI * 2;
    Object.assign(ray.style, { position: "absolute", left: `${width * cx!}px`, top: `${height * cy!}px`, width: "3px", height: index % 2 ? "13px" : "5px", borderRadius: "2px", background: colors[index % colors.length], opacity: "0" });
    layer.append(ray);
    animations.push(ray.animate([{ transform: `translate(${Math.cos(angle) * 9}px,${Math.sin(angle) * 9}px) rotate(${index * 36}deg)`, opacity: 0 }, { offset: .15, opacity: .8 }, { transform: `translate(${Math.cos(angle) * 56}px,${Math.sin(angle) * 56}px) rotate(${index * 36 + 40}deg)`, opacity: 0 }], { duration: 650, delay, fill: "both", easing: "cubic-bezier(.23,1,.32,1)" }));
    later(() => ray.remove(), delay! + 700);
  }
  counter.textContent = "0";
  later(() => {
    const start = performance.now();
    const frame = (now: number) => {
      if (!alive) return;
      const progress = Math.min(1, (now - start) / 510);
      counter.textContent = String(Math.round(score * (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }, 110);
  document.addEventListener("visibilitychange", stop, { once: true });
  return () => { stop(); document.removeEventListener("visibilitychange", stop); };
}
