import { useLayoutEffect, useRef, type RefObject } from "react";
import { useRoomStore } from "../../app/room-store";
import { cardSpringAtRest, stepCardSpring, type CardSpring } from "./card-spring";

type Pose = { x: number; y: number; rotate: number; scale: number; open: number };
type Mode = "full" | "lite" | "off";
type ObjectOptions = { readonly layoutPosition?: boolean };
const resting: Pose = { x: 0, y: 0, rotate: 0, scale: 1, open: 1 };
const units: Record<keyof Pose, string> = { x: "px", y: "px", rotate: "deg", scale: "", open: "" };
const keys = Object.keys(resting) as (keyof Pose)[];

/**
 * 「这张纸在不在屏上」的墙钟上限。
 *
 * 物件的**可见性**就写在这条弹簧的 `open` 通道上（`.card-making-workshop` 的
 * `opacity: clamp(0, var(--card-object-open,1), 1)`），而到场姿态的初值是
 * `open: 0`：屏上先什么都没有，再由 rAF 一帧帧把它抬起来。窗口被遮挡、切到后台、
 * 或主线程正忙着跑制卡任务时 Chromium 会停掉或节流 rAF，于是那张"桌面背景"海报
 * （纯 CSS，立刻画完）铺满了整屏，而纸面停在 `open: 0` —— 用户看到的就是
 * 「生成学习卡只换了一张桌面背景，界面不见了」。
 *
 * 这条兜底只补完**已经选定的目标**：它把 `open` 推到 `targets.open`，从不改目标
 * 本身。所以关着的筛选菜单（目标就是 0）不会被强行点亮，而半路被打断的到位一定会
 * 走完。x/y/rotate 一概不管——它们的非静止目标常常是**故意**停在那里的（选中标记
 * 停在某颗 chip 上、拖拽跟着手指），强拉回静止反而会毁掉正在进行的操作。
 * `mode === "off"` 与系统减少动态本来就立即落位，走的是同一条"直接落位"的路径。
 */
const REVEAL_BUDGET_MS = 1400;

/** One physical object, one pose owner. Retargeting retains both position and speed. */
export function createCardObjectSpring(host: HTMLElement, initial: Partial<Pose> = {}, options: ObjectOptions = {}) {
  let mode: Mode = "full", frame = 0, lastTime = 0, destroyed = false, modeSet = false;
  let settled: (() => void) | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const targets = { ...resting, ...initial };
  const tracks = Object.fromEntries(keys.map(key => [key, { position: targets[key], velocity: 0 }])) as Record<keyof Pose, CardSpring>;
  const isLayoutPosition = (key: keyof Pose) => options.layoutPosition && (key === "x" || key === "y");
  const atRest = () => keys.every(key => cardSpringAtRest(tracks[key], targets[key]));
  const paint = () => {
    for (const key of keys) {
      const value = mode === "lite" && key !== "open" ? isLayoutPosition(key) ? targets[key] : resting[key] : tracks[key].position;
      host.style.setProperty(`--card-object-${key}`, `${value}${units[key]}`);
    }
    host.dataset.objectMotion = mode;
  };
  const clearDeadline = () => { if (deadline !== null) { clearTimeout(deadline); deadline = null; } };
  const finish = () => { clearDeadline(); const callback = settled; settled = null; callback?.(); };
  /** 落位：不管这一段是弹完了、被按 Off 打断的，还是墙钟到点强制收尾的，都走到这里。 */
  const settle = () => {
    cancelAnimationFrame(frame); frame = 0;
    for (const key of keys) tracks[key] = { position: targets[key], velocity: 0 };
    paint(); finish();
  };
  /** 帧不来时也要让这张纸出现在屏上：只补 `open`，其余通道原样留着。 */
  const revealNow = () => {
    clearDeadline();
    tracks.open = { position: targets.open, velocity: 0 };
    paint();
    if (!frame && atRest()) { const callback = settled; settled = null; callback?.(); }
  };
  /** 每次改目标都重开预算：被反复打断的运动不会被一条过期的墙钟拦腰落位。 */
  const armDeadline = () => {
    clearDeadline();
    if (cardSpringAtRest(tracks.open, targets.open)) return;
    deadline = setTimeout(() => { deadline = null; if (!destroyed && !cardSpringAtRest(tracks.open, targets.open)) revealNow(); }, REVEAL_BUDGET_MS);
  };
  const tick = (now: number) => {
    frame = 0;
    if (destroyed) return;
    const dt = Math.min(.04, Math.max(.001, (now - lastTime) / 1000)); lastTime = now;
    for (const key of keys) {
      tracks[key] = mode === "lite" && isLayoutPosition(key)
        ? { position: targets[key], velocity: 0 }
        : stepCardSpring(tracks[key], targets[key], dt, key === "open" ? 420 : 380, key === "open" ? 27 : 23);
      if (cardSpringAtRest(tracks[key], targets[key])) tracks[key] = { position: targets[key], velocity: 0 };
    }
    paint();
    if (keys.some(key => !cardSpringAtRest(tracks[key], targets[key]))) draw();
    else finish();
  };
  function draw() {
    if (destroyed) return;
    if (mode === "off") { settle(); return; }
    if (!frame) { lastTime = performance.now(); frame = requestAnimationFrame(tick); }
  }
  paint();
  // 构造时就上预算：到场姿态初值 `open: 0`，而 pageKey 可能在整段页面里都是
  // 空值（笔记轮次页、加载中的卡片详情）——那时没有人会来调 `target`，物件就得
  // 自己保证不会一直停在看不见的位置。
  armDeadline();
  return {
    target(patch: Partial<Pose>) { Object.assign(targets, patch); if (mode === "lite") paint(); armDeadline(); draw(); },
    kick(patch: Partial<Pose>) { if (mode === "full") for (const key of keys) tracks[key].velocity += patch[key] ?? 0; armDeadline(); draw(); },
    grab(patch: Partial<Pose>) {
      if (mode !== "full") return;
      for (const key of keys) if (patch[key] !== undefined) { tracks[key].position = patch[key]!; tracks[key].velocity = 0; targets[key] = patch[key]!; }
      paint();
    },
    mode(next: Mode) {
      if (modeSet && mode === next) return;
      modeSet = true;
      mode = next;
      if (next !== "full") for (const key of keys) if (key !== "open") {
        if (!isLayoutPosition(key)) targets[key] = resting[key];
        tracks[key] = { position: targets[key], velocity: 0 };
      }
      paint();
      armDeadline();
      draw();
    },
    pose() { return Object.fromEntries(keys.map(key => [key, tracks[key].position])) as Pose; },
    /** 直接落位，不等帧。给"帧不来也必须到位"的那几处用。 */
    snap() { if (destroyed) return; cancelAnimationFrame(frame); frame = 0; for (const key of keys) tracks[key] = { position: targets[key], velocity: 0 }; paint(); if (atRest()) finish(); },
    settled(callback: () => void) { if (!frame) callback(); else settled = callback; },
    destroy() { destroyed = true; cancelAnimationFrame(frame); clearDeadline(); for (const key of keys) host.style.removeProperty(`--card-object-${key}`); delete host.dataset.objectMotion; },
  };
}

export function useCardObjectSpring(ref: RefObject<HTMLElement | null>, initial: Partial<Pose> = {}, options: ObjectOptions = {}) {
  const mode = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  const controller = useRef<ReturnType<typeof createCardObjectSpring> | null>(null);
  const host = useRef<HTMLElement | null>(null);
  const initialRef = useRef(initial);
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    if (host.current !== ref.current) {
      controller.current?.destroy();
      host.current = ref.current;
      controller.current = ref.current ? createCardObjectSpring(ref.current, initialRef.current, optionsRef.current) : null;
    }
    controller.current?.mode(reduced ? "off" : mode);
  });
  useLayoutEffect(() => () => { controller.current?.destroy(); controller.current = null; host.current = null; }, [ref]);
  return controller;
}

export function useCardPaperArrival(ref: RefObject<HTMLElement | null>, pageKey: string | null) {
  const object = useCardObjectSpring(ref, { y: 34, rotate: -2.5, open: 0 });
  const lastKey = useRef<string | null>(null);
  const budget = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!object.current) return;
    // 到场是这一族里**唯一**把 `open: 0` 当过程量的用法（别的物件关掉就是关掉），
    // 所以"必须出现在屏上"这条兜底也放在这一层：pageKey 整段为空时没有人会来调
    // `target`，帧不来时也不会有人来推——纸面会一直停在看不见的位置，而纯 CSS 的
    // 背景海报立刻就画满了屏（2026-10-04 实机：生成学习卡只换了一张桌面背景）。
    if (budget.current === null) {
      budget.current = window.setTimeout(() => {
        budget.current = null;
        if (!object.current || object.current.pose().open >= 1) return;
        object.current.target(resting);
        object.current.snap();
      }, REVEAL_BUDGET_MS);
    }
    if (!pageKey || lastKey.current === pageKey) return;
    object.current.target(resting);
    if (lastKey.current) object.current.kick({ y: 420, rotate: -38 });
    lastKey.current = pageKey;
  });
  useLayoutEffect(() => () => { if (budget.current !== null) { window.clearTimeout(budget.current); budget.current = null; } }, []);
  return object;
}

/**
 * 「这张纸一直在屏上，只是刚被放上来」的到场。
 *
 * 与 `useCardPaperArrival` 只差初值里的 `open`，而那一个数决定的是**能不能用**：
 * 后者从 `open: 0` 起步，纸面要靠 rAF 一帧帧抬起来才看得见，于是帧被节流的时候
 * （窗口被遮挡、切到后台、主线程正忙着跑制卡任务）用户看到的就是「点生成学习卡只换
 * 了一张桌面背景，内容卡片迟迟不出现」（2026-10-04 实机：等 2–3 秒，有时更久）。
 *
 * **内容在不在屏上不该由入场动画决定**。这一档初值就是 `open: 1`：第一帧画出来，到位
 * 过程只剩一段很短的位移与转角（读者仍然看得出纸是被放上来的），而"帧不来"最多让
 * 位移停在半路，不会让内容消失——`REVEAL_BUDGET_MS` 那道兜底在这一档根本用不上。
 */
export function useCardVisibleArrival(ref: RefObject<HTMLElement | null>, pageKey: string | null) {
  const object = useCardObjectSpring(ref, { y: 18, rotate: -1.2, open: 1 });
  const lastKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!object.current || !pageKey || lastKey.current === pageKey) return;
    object.current.target(resting);
    if (lastKey.current) object.current.kick({ y: 220, rotate: -20 });
    lastKey.current = pageKey;
  });
  return object;
}
