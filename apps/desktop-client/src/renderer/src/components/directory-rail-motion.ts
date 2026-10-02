type Box = Readonly<{ left: number; top: number; width: number; height: number; bottom: number }>;
type MotionMode = "full" | "lite" | "off";
type SpringState = Readonly<{ position: number; velocity: number }>;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const centerX = (box: Box) => box.left + box.width / 2;
const centerY = (box: Box) => box.top + box.height / 2;
const mix = (from: number, to: number, progress: number) => from + (to - from) * progress;
export const directoryBox = (element: Element): Box => {
  const { left, top, width, height, bottom } = element.getBoundingClientRect();
  return { left, top, width, height, bottom };
};

/** A damped spring with continuous position and velocity when retargeted. */
export function directorySpring(from: SpringState, target: number, seconds: number, mode: MotionMode): SpringState {
  const stiffness = mode === "lite" ? 500 : 360;
  const damping = mode === "lite" ? 46 : 26;
  const displacement = from.position - target;
  const halfDamping = damping / 2;
  if (halfDamping * halfDamping >= stiffness) {
    const root = Math.sqrt(halfDamping * halfDamping - stiffness);
    const slow = -halfDamping + root;
    const fast = -halfDamping - root;
    const a = (from.velocity - fast * displacement) / (slow - fast);
    const b = displacement - a;
    return { position: target + a * Math.exp(slow * seconds) + b * Math.exp(fast * seconds),
      velocity: a * slow * Math.exp(slow * seconds) + b * fast * Math.exp(fast * seconds) };
  }
  const frequency = Math.sqrt(stiffness - halfDamping * halfDamping);
  const b = (from.velocity + halfDamping * displacement) / frequency;
  const sin = Math.sin(frequency * seconds);
  const cos = Math.cos(frequency * seconds);
  const decay = Math.exp(-halfDamping * seconds);
  const value = displacement * cos + b * sin;
  return { position: target + decay * value,
    velocity: decay * (-halfDamping * value - displacement * frequency * sin + b * frequency * cos) };
}

type FrozenRail = { root: HTMLElement; skin: HTMLElement; top: HTMLElement; middle: HTMLElement; box: Box; chips: Array<{ element: HTMLElement; box: Box }> };

function freezeRail(rail: HTMLElement): FrozenRail {
  const box = directoryBox(rail);
  const root = rail.cloneNode(true) as HTMLElement;
  root.removeAttribute("data-rail-morphing");
  root.classList.add("nav-morph-ghost");
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("inert", "");
  const originals = [rail, ...rail.querySelectorAll<HTMLElement>("*")];
  const copies = [root, ...root.querySelectorAll<HTMLElement>("*")];
  // The copy remains inside the HUD scope, including its pseudo-elements.
  // Grid alignment must be explicit: omitting place-items made every icon
  // jump left as soon as the frozen rail replaced the live flex column.
  const paintProperties = ["display", "box-sizing", "width", "height", "padding", "margin", "font", "color",
    "background", "border", "border-radius", "box-shadow", "opacity", "visibility", "transform",
    "place-items", "place-content", "text-align", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"];
  originals.forEach((original, index) => {
    const copy = copies[index];
    const style = getComputedStyle(original);
    for (const property of paintProperties) copy.style.setProperty(property, style.getPropertyValue(property));
    copy.style.transition = "none";
    copy.style.animation = "none";
  });
  const sourceStyle = getComputedStyle(rail);
  const chips = [...rail.querySelectorAll<HTMLElement>(".nav-chip")].map((original, index) => {
    const element = root.querySelectorAll<HTMLElement>(".nav-chip")[index];
    const chipBox = directoryBox(original);
    Object.assign(element.style, { position: "absolute", left: `${chipBox.left - box.left}px`, top: `${chipBox.top - box.top}px`,
      width: `${chipBox.width}px`, height: `${chipBox.height}px`, margin: "0", opacity: "1", visibility: "visible", transform: "none" });
    return { element, box: chipBox };
  });
  root.querySelector(".nav-collapse")?.remove();
  root.querySelector(".nav-island-copy")?.remove();
  Object.assign(root.style, { position: "fixed", left: `${box.left}px`, top: `${box.top}px`, right: "auto", bottom: "auto",
    width: `${box.width}px`, height: `${box.height}px`, padding: "0", margin: "0", border: "0", background: "transparent",
    boxShadow: "none", backdropFilter: "none", overflow: "visible", transform: "none", transition: "none",
    zIndex: "45", pointerEvents: "none" });
  const skin = document.createElement("span");
  skin.className = "directory-rail-skin";
  skin.style.setProperty("--directory-skin-color", sourceStyle.backgroundColor);
  skin.style.setProperty("--directory-skin-line", sourceStyle.borderTopColor);
  const [top, middle, bottom] = [document.createElement("i"), document.createElement("i"), document.createElement("i")];
  middle.style.height = `${Math.max(0, box.height - 44)}px`;
  skin.append(top, middle, bottom);
  root.prepend(skin);
  rail.parentElement?.append(root);
  return { root, skin, top, middle, box, chips };
}

/** One visual column for both directions; the live controls adopt intent immediately. */
export function createDirectoryRailMotion() {
  let frozen: FrozenRail | null = null;
  let expandedButton: Box | null = null;
  let collapsedButton: Box | null = null;
  let collapsedRail: Box | null = null;
  let liveRail: HTMLElement | null = null;
  let animations: Animation[] = [];
  let timer: number | null = null;
  let command: { start: number; from: SpringState; target: number; mode: MotionMode } | null = null;
  let generation = 0;

  const cancelAnimations = () => { for (const animation of animations) animation.cancel(); animations = []; };
  const finish = () => {
    generation += 1;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    cancelAnimations();
    frozen?.root.remove();
    frozen = null;
    liveRail?.removeAttribute("data-rail-morphing");
    liveRail = null;
    command = null;
  };

  // Capture the expanded paint before its authored layout is changed.
  const prepare = (rail: HTMLElement, collapsed: boolean, willAnimate: boolean) => {
    if (!willAnimate || frozen || collapsed) return;
    frozen = freezeRail(rail);
    expandedButton = directoryBox(rail.querySelector(".nav-collapse")!);
  };

  const run = (rail: HTMLElement, wasCollapsed: boolean, collapsed: boolean, mode: MotionMode, previousRail: Box, previousButton: Box) => {
    if (mode === "off" || typeof rail.animate !== "function") { finish(); return; }
    const now = document.timeline?.currentTime;
    const start = typeof now === "number" ? now : performance.now();
    const target = collapsed ? 1 : 0;
    const from = command ? directorySpring(command.from, command.target, Math.max(0, (start - command.start) / 1000), command.mode)
      : { position: wasCollapsed ? 1 : 0, velocity: 0 };
    if (!frozen) {
      frozen = freezeRail(rail);
      expandedButton = directoryBox(rail.querySelector(".nav-collapse")!);
    }
    if (collapsed) {
      collapsedRail = directoryBox(rail);
      collapsedButton = directoryBox(rail.querySelector(".nav-collapse")!);
    } else if (!command) {
      collapsedRail = previousRail;
      collapsedButton = previousButton;
    }
    if (!expandedButton || !collapsedButton || !collapsedRail) { finish(); return; }
    if (timer !== null) window.clearTimeout(timer);
    cancelAnimations();
    liveRail = rail;
    rail.dataset.railMorphing = "true";
    command = { start, from, target, mode };
    const id = ++generation;
    const duration = mode === "full" ? 720 : 480;
    const count = mode === "full" ? 61 : 41;
    const samples = Array.from({ length: count }, (_, index) => {
      const offset = index / (count - 1);
      const state = directorySpring(from, target, duration * offset / 1000, mode);
      return { offset, progress: index === count - 1 ? target : state.position };
    });
    const animate = (element: Element, frame: (progress: number) => Keyframe) => {
      const animation = element.animate(samples.map(({ offset, progress }) => ({ offset, ...frame(progress) })), { duration, easing: "linear", fill: "both" });
      // All layers share a clock; no independently delayed ghost/pill phases.
      animation.startTime = start;
      animations.push(animation);
      return animation;
    };
    const { box, skin, top, middle, chips } = frozen;
    const compact = collapsedRail;
    const compactButton = collapsedButton;
    animate(skin, progress => ({ transform: `translate3d(${(centerX(compact) - centerX(box)) * progress}px, ${(compact.bottom - box.bottom) * progress}px, 0) scaleX(${mix(1, compact.width / box.width, progress)})`,
      opacity: 1 - clamp((progress - 0.8) / 0.2) }));
    animate(top, progress => ({ transform: `translateY(${box.height - Math.max(44, mix(box.height, compact.height, progress))}px)` }));
    animate(middle, progress => ({ transform: `scaleY(${Math.max(0, mix(box.height, compact.height, progress) - 44) / Math.max(1, box.height - 44)})` }));
    for (const chip of chips) {
      animate(chip.element, progress => ({ transform: `translate3d(${(centerX(compact) - centerX(box)) * progress}px, ${(centerY(compactButton) - centerY(chip.box)) * progress}px, 0)`,
        opacity: clamp(1 - progress / 0.66) }));
    }
    const button = rail.querySelector<HTMLElement>(".nav-collapse")!;
    const destination = directoryBox(button);
    const fullButton = expandedButton;
    animate(button, progress => ({ transform: `translate3d(${mix(centerX(fullButton), centerX(compactButton), progress) - centerX(destination)}px, ${mix(centerY(fullButton), centerY(compactButton), progress) - centerY(destination)}px, 0) scale(${mix(fullButton.width, compactButton.width, progress) / destination.width}, ${mix(fullButton.height, compactButton.height, progress) / destination.height})` }));
    const arrow = button.querySelector("svg");
    if (arrow) animate(arrow, progress => ({ transform: `rotate(${180 * progress}deg)` }));
    const settle = () => { if (generation === id) finish(); };
    animations[0].onfinish = settle;
    // Backgrounded windows can stop their animation clock; always release the
    // frozen paint and restore the destination, with no delayed stale callback.
    timer = window.setTimeout(settle, duration + 400);
  };
  return { prepare, run, finish };
}
