/**
 * 「这次启动已经告诉过服务端了吗」——主动气泡展示前的唯一闸门（2026-10-16）。
 *
 * 为什么需要它：启动问候是对**某一次启动**说的话，生成要十几秒。上一次启动没被看见的那条
 * 会留在投递队列里，而这一次启动的投影可能在"这次启动还没登记"的那几秒里就把它递过来了。
 * 真窗口实测（发行渲染包 + 本地栈）：服务端在 12:29:42.539 把旧问候作废（`suppressed`），
 * 客户端仍在 12:29:43.4 把同一句旧问候显示了出来——它拿的是作废之前那次投影读取的结果。
 * 作废是记账，拦不住已经在手上的负载；判据必须也放在展示这一侧。
 *
 * 规矩：这次启动的 `app.started` 观察**拿到成功回执之后**，才允许把投影里的主动气泡显示出来。
 * 同时投影提供方在闸门开启时重读一次——服务端那时已经收掉了旧问候，重读回来的队列是干净的。
 * 被闸门挡下的气泡既不回执也不丢：投递还是 `queued`，下一次投影刷新照样会来。
 *
 * 窗口起在后台（没有焦点）时这条闸门保持关闭：她本来就不该对着没在看的人开口；
 * 用户真的把窗口调到前台时，`foreground` 那条观察会补发这一次启动的 `app.started`，
 * 闸门随之开启。
 */

let registeredAt: number | null = null;
const listeners = new Set<() => void>();

/** 这一刻之前到达的投影负载不用于展示主动气泡；null = 这次启动还没登记。 */
export function companionLaunchRegisteredAt(): number | null {
  return registeredAt;
}

export function isCompanionLaunchRegistered(): boolean {
  return registeredAt !== null;
}

/** 这次启动已经与宿主登记过（`app.started` 观察成功了）。只认第一次。 */
export function markCompanionLaunchRegistered(now: number = Date.now()): void {
  if (registeredAt !== null) return;
  registeredAt = now;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* 一个订阅者出错不该拖住其余订阅者 */ }
  }
}

export function subscribeCompanionLaunchRegistration(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 测试用：把这个窗口的登记状态清回未登记。 */
export function resetCompanionLaunchRegistrationForTests(): void {
  registeredAt = null;
  listeners.clear();
}
