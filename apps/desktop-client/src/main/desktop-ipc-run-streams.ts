/**
 * run 事件流的账本（`learningRun` 与 `cardGeneration` 两族共用同一份规矩）。
 *
 * ## 它回答的问题
 *
 * "这条 run 的长连接，**什么时候**存在？"
 *
 * 答案只有一个来源：**订阅表**。有一条订阅指向这条 run，就有这条连接；一条都没有，
 * 就必须没有。此前这两件事是分开的，所以连接会攒到服务端的每用户上限：
 *
 *  - 建连句柄要等 `watch…Events` 先 `await ensureConnected()` 才交回来，而"笔记页与
 *    工作台各订阅一次同一条 run"是常态（两边都订）。两次 `ensure…` 落进同一个事件
 *    循环里就各开一条连接，而 `Map` 只留得下其中一个 `stop`——多出来的那条从此
 *    没有任何人能关。
 *  - 写侧（开始生成／审核／保存／停止…）知道 runId，却在**没人订阅**时也顺手开流。
 *  - 窗口重新加载（开发时的热重载、手动刷新）不销毁 `webContents`，旧订阅一直留在
 *    表上，它撑着的那条连接也就没人关。
 *
 * 实测：五个泄漏的 card-generation 连接把服务端的每用户 SSE 上限（5）占满，之后每
 * 一次订阅都被 429 顶回——生成页于是再也收不到任何事件，它停在原地不动，只有手动
 * 按「刷新状态」才动一下，而且会直接跳到候选卡审查。
 *
 * ## 两条纪律
 *
 * 1. **同步占位**。`ensure` 一进来就写进账本，不等连接建好；句柄到手时若账本已经
 *    不要它，当场关掉（见 `wanted`）。这样"同一条 run 被订阅两次"只会开一条连接。
 * 2. **失败要退避**。建不上（限流、还没连上）就不留残骸，记一个墙钟；否则订阅表每
 *    变一次就重试一次，把同一个上限反复再撞一遍（实测一条早已结束的 run 上堆了
 *    487 次请求）。
 */

/**
 * 一条流在账本里的那一格。
 *
 * `wanted === false` 是「已经退订／切空间，只等回执到手就关」——那时还没有句柄可停，
 * 所以这一格是唯一能同时管住"还在建"与"已经建好"两种状态的东西。
 */
export interface RunStreamEntry {
  wanted: boolean;
  stop: (() => void) | null;
}

export interface RunStreamLedger {
  readonly streams: Map<string, RunStreamEntry>;
  /** 建连失败之后的「下次再来」墙钟（epoch 毫秒）。 */
  readonly retryAfter: Map<string, number>;
  /** 本机上"有人碰过"的 run id。写侧登记，订阅侧收口。 */
  readonly tracked: Set<string>;
}

export function createRunStreamLedger(): RunStreamLedger {
  return { streams: new Map(), retryAfter: new Map(), tracked: new Set() };
}

/**
 * 建连失败之后，多久才再试一次。
 *
 * 服务端的每用户 SSE 上限是 5。30 秒足够让限流窗口过去，也不至于让真实进展迟到人眼。
 */
export const RUN_STREAM_RETRY_MS = 30_000;

/** 这一族流与主进程之间真正需要的四件事。**闭包**由 `desktop-ipc.ts` 传进来。 */
export interface RunStreamPorts {
  /** 建一条 SSE。交回的是停止句柄。 */
  readonly watch: (runId: string, onSequence: (sequence: number) => Promise<void> | void) => Promise<() => void>;
  /** 收到一帧就去重读一次严格快照，再把"有新版本了"这件事转给订阅方。 */
  readonly refresh: (runId: string, sequence: number) => Promise<void>;
  /** 此刻**真的有订阅方**的 run id。账本只认这一份。 */
  readonly subscribed: () => ReadonlySet<string>;
  /** 建连那一刻的空间纪元：与当前不一致的流一律当场关掉（纪元一换就是另一个空间）。 */
  readonly workspaceEpoch: () => number;
  /** 建不上流时的收尾。**不给它伪造事件**——渲染层自己有重读路径。 */
  readonly onLost?: () => void;
}

/** 退掉一条流。两种状态都收得住：已建好的当场关，还在建的等回执到手再关。 */
export function cancelRunStream(entry: RunStreamEntry): void {
  entry.wanted = false;
  entry.stop?.();
  entry.stop = null;
}

/** 全收：一条都不留。退订到零、切空间、登出走的是这一条。 */
export function stopRunStreams(ledger: RunStreamLedger): void {
  for (const entry of ledger.streams.values()) cancelRunStream(entry);
  ledger.streams.clear();
  // "谁都不看"了 ⇒ 那些"下次再来"的墙钟也作废：换账号／切空间之后重新订阅时，
  // 不该被上一个空间留下的退避挡住。
  ledger.retryAfter.clear();
}

/**
 * 建一条流，并且**立刻**在账本上占住这一格（纪律 1）。
 *
 * 订阅表里没有这条 run 就不建——写侧只登记（`ledger.tracked.add`），真正开流等订阅
 * 到了再说。少了这一层，每一发写都可能在没人看的情况下占一条长连接。
 */
export function ensureRunStream(ledger: RunStreamLedger, ports: RunStreamPorts, runId: string): void {
  // 订阅表里没有这条 run 就不建——写侧只登记（`ledger.tracked.add`），真正开流等订阅
  // 到了再说。少了这一层，每一发写都可能在没人看的情况下占一条长连接。
  if (!ports.subscribed().has(runId)) return;
  ledger.tracked.add(runId);
  if (ledger.streams.has(runId)) return;
  const epoch = ports.workspaceEpoch();
  const entry: RunStreamEntry = { wanted: true, stop: null };
  ledger.streams.set(runId, entry);
  void ports.watch(runId, async (sequence) => {
    if (!entry.wanted || ports.workspaceEpoch() !== epoch) return;
    await ports.refresh(runId, sequence);
  }).then((stop) => {
    if (!entry.wanted || ports.workspaceEpoch() !== epoch) {
      stop();
      if (ledger.streams.get(runId) === entry) ledger.streams.delete(runId);
      return;
    }
    entry.stop = stop;
  }).catch(() => {
    if (ledger.streams.get(runId) === entry) ledger.streams.delete(runId);
    ledger.retryAfter.set(runId, Date.now() + RUN_STREAM_RETRY_MS);
    ports.onLost?.();
  });
}

/**
 * 账本对齐订阅表：`subscribed` 里没有的**就地停掉**，`subscribed` 里缺的**补上**。
 *
 * 订阅表的每一次增删都要走这里——只在这里对一次账，账本就不可能与"谁在看"分叉。
 * `stopRunStreams` 则是极端情形：一个订阅都不剩，整族收掉。
 */
export function reconcileRunStreams(ledger: RunStreamLedger, ports: RunStreamPorts): void {
  const subscribed = ports.subscribed();
  const now = Date.now();
  for (const runId of [...ledger.tracked]) {
    if (subscribed.has(runId)) continue;
    ledger.tracked.delete(runId);
    ledger.retryAfter.delete(runId);
    const entry = ledger.streams.get(runId);
    if (entry) { cancelRunStream(entry); ledger.streams.delete(runId); }
  }
  for (const runId of subscribed) {
    if (ledger.streams.has(runId)) continue;
    const until = ledger.retryAfter.get(runId);
    if (until !== undefined) {
      if (until > now) continue;
      ledger.retryAfter.delete(runId);
    }
    ensureRunStream(ledger, ports, runId);
  }
}