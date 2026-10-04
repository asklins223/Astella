import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { useRoomStore } from "../../../app/room-store";
import { paperSpringAtRest, stepPaperSpring, type PaperSpring } from "../../motion/paper-spring";

type Pose = [number, number, number, number, number];
type Track = { values: PaperSpring[]; target: Pose };
const rest = (value: number): PaperSpring => ({ value, velocity: 0 });
const poseAt = (depth: number, width: number): Pose => depth < 0
  ? [-width * .55, 32, -9, .97, 0]
  : depth === 0 ? [0, 0, 0, 1, 1]
  : [depth % 2 ? 5 : -5, -Math.min(depth, 3) * 10, depth % 2 ? 2 : -2, 1 - depth * .015, Math.max(0, 1 - depth * .12)];

/** Sole owner of deck transforms, including the 1:1 drag and its release velocity. */
export function useReviewDeckMotion(deckRef: RefObject<HTMLElement | null>, identity: string) {
  const motion = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  const mode = reduced ? "off" : motion;
  const modeRef = useRef(mode); modeRef.current = mode;
  const tracks = useRef(new Map<HTMLElement, Track>());
  const held = useRef<HTMLElement | null>(null);
  const frame = useRef(0), last = useRef(0);
  /**
   * 「循环正在跑」与「待跑的那一帧」是**两件事**，必须分开记。
   * 早先只用帧号兼任这两件事：卸载时 `cancelAnimationFrame` 把那一帧取走了，帧号却
   * 还留在 ref 里，于是 `start()` 的"已经有循环在跑"永远成立 —— 此后整叠牌再也不排帧。
   * StrictMode（main.tsx 就这么挂的）把卸载也跑一遍，所以这不是假想：牌堆从挂载
   * 那一刻起就没有弹簧，拖完松手只会把牌停在手指放开的地方再也回不来。
   */
  const running = useRef(false);
  const paint = (element: HTMLElement, track: Track) => {
    const [x, y, angle, scale, opacity] = track.values.map(value => value.value);
    element.style.transform = modeRef.current === "full" ? `translate3d(${x}px, ${y}px, 0) rotate(${angle}deg) scale(${scale})` : "none";
    element.style.opacity = String(Math.max(0, Math.min(1, opacity)));
  };
  const tick = (time: number) => {
    const dt = Math.min(.04, Math.max(0, (time - last.current) / 1000)); last.current = time;
    let moving = false;
    for (const [element, track] of tracks.current) {
      if (element === held.current) continue;
      track.values = track.values.map((state, i) => {
        if (modeRef.current === "off" || (modeRef.current === "lite" && i !== 4)) return rest(track.target[i]);
        return stepPaperSpring(state, track.target[i], dt, i === 4 ? 480 : 440, i === 4 ? 38 : 27);
      });
      if (track.values.every((value, i) => paperSpringAtRest(value, track.target[i], i < 3 ? .025 : .001))) track.values = track.target.map(rest);
      else moving = true;
      paint(element, track);
    }
    // 手里那张牌由 `drag` 直接写，不进弹簧；而"还要不要继续跑"也不由它决定，
    // 否则别人全静止的时候这一帧就断了。
    if (moving) frame.current = requestAnimationFrame(tick);
    else { frame.current = 0; running.current = false; }
  };
  const start = () => {
    if (running.current) return;
    running.current = true;
    last.current = performance.now();
    frame.current = requestAnimationFrame(tick);
  };
  useLayoutEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;
    const retarget = () => {
      const cards = [...deck.querySelectorAll<HTMLElement>(".deck-card")];
      for (const [element] of tracks.current) if (!cards.includes(element)) tracks.current.delete(element);
      for (const card of cards) {
        const depth = Number(card.dataset.depth ?? 0);
        const target = poseAt(depth, card.offsetWidth || 520);
        const track = tracks.current.get(card) ?? { values: target.map(rest), target };
        track.target = target;
        if (modeRef.current === "off") track.values = target.map(rest);
        tracks.current.set(card, track); paint(card, track);
      }
      start();
    };
    retarget();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(retarget);
    observer?.observe(deck);
    return () => observer?.disconnect();
  }, [deckRef, identity, mode]);
  // 取消那一帧，并把它交还 —— StrictMode 会把挂载/卸载跑两遍，帧号留在手里
  // 就再也排不出下一帧（`use-tactile-surface.ts` 记着同一条，这里是同一条的第二处）。
  // 手里那张牌也要放开：换了一叠牌之后还按着旧的那张，弹簧会一直跳过它。
  useLayoutEffect(() => () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    last.current = 0;
    running.current = false;
    held.current = null;
    tracks.current.clear();
  }, []);

  const grab = useCallback(() => {
    const card = deckRef.current?.querySelector<HTMLElement>('.deck-card[data-depth="0"]');
    held.current = card ?? null;
    const track = card ? tracks.current.get(card) : null;
    return { x: track?.values[0].value ?? 0, y: track?.values[1].value ?? 0, rotate: track?.values[2].value ?? 0 };
  }, [deckRef]);
  const drag = (x: number, y: number, angle: number) => {
    const card = held.current, track = card ? tracks.current.get(card) : null;
    if (!card || !track) return;
    track.values[0] = rest(x); track.values[1] = rest(y); track.values[2] = rest(angle);
    paint(card, track);
  };
  const release = (velocity = 0) => {
    const card = held.current, track = card ? tracks.current.get(card) : null;
    held.current = null;
    if (track) { track.values[0].velocity = velocity * 1000; track.values[2].velocity = velocity * 30; }
    start();
  };
  return { grab, drag, release };
}
