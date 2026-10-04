import { useRoomStore } from "../../app/room-store";
import { notifyCompanion } from "./companion-notifications";

export interface CompanionTaskWatch {
  readonly id: string;
  readonly scope: number;
  readonly title: string;
  readonly subject?: string;
  readonly read: () => Promise<{ readonly status: string }>;
  readonly open: () => void;
}

const watches = new Map<string, { watch: CompanionTaskWatch; timer: number; failures: number }>();
const completed = new Set<string>();

/** A view can hand off its real task; its lifetime is no longer the page's lifetime. */
export function watchCompanionTask(watch: CompanionTaskWatch): void {
  const key = `${watch.scope}:${watch.id}`;
  if (watches.has(key) || completed.has(key) || useRoomStore.getState().workspaceScopeRevision !== watch.scope) return;
  const entry = { watch, timer: 0, failures: 0 };
  const poll = async () => {
    if (watches.get(key) !== entry) return;
    if (useRoomStore.getState().workspaceScopeRevision !== watch.scope) { watches.delete(key); return; }
    try {
      const task = await watch.read();
      if (watches.get(key) !== entry || useRoomStore.getState().workspaceScopeRevision !== watch.scope) return;
      entry.failures = 0;
      if (["ready", "completed", "confirmed", "failed", "error", "cancelled"].includes(task.status)) {
        watches.delete(key);
        completed.add(key);
        if (task.status === "cancelled" || task.status === "confirmed") return;
        const ok = task.status === "ready" || task.status === "completed";
        notifyCompanion({
          id: `task:${watch.id}:${task.status}`, scope: watch.scope, kind: "task", source: ok ? "后台任务完成" : "后台任务提醒",
          title: ok ? `${watch.title}准备好了` : `${watch.title}还没完成`,
          body: `${watch.subject ? `《${watch.subject}》\n` : ""}${ok ? "已经保存到这篇笔记里。你可以现在打开，也可以先继续手头的事。" : "这次生成没有完成。打开原来的笔记查看原因，已有内容仍然保留。"}`,
          snoozable: true,
          audio: { clip: ok ? "task-ready" : "task-failed", text: ok ? "你交给我的后台任务完成了，结果已经保存。方便的时候可以打开看看。" : "后台任务这次没有完成。可以打开原来的页面查看原因，再试一次。" },
          actions: [{ id: "open", label: ok ? "打开笔记" : "查看并重试", kind: "navigate", run: watch.open }, { id: "ok", label: "知道了", kind: "confirm" }],
        });
        return;
      }
    } catch (error) {
      entry.failures++;
      // Workspace/auth revocation ends the watch; a transient network failure does not.
      const code = (error as { code?: string } | null)?.code;
      if (["unauthenticated", "auth_required", "reauth_required", "forbidden", "not_found", "stale_workspace"].includes(code ?? "")) { watches.delete(key); return; }
    }
    if (watches.get(key) === entry) entry.timer = window.setTimeout(() => void poll(), Math.min(30_000, 2_400 * 2 ** Math.min(entry.failures, 3)));
  };
  watches.set(key, entry);
  entry.timer = window.setTimeout(() => void poll(), 2_400);
}

export function clearCompanionTaskWatches(scope?: number): void {
  for (const [key, entry] of watches) if (scope === undefined || entry.watch.scope !== scope) {
    window.clearTimeout(entry.timer); watches.delete(key);
  }
  for (const key of completed) if (scope === undefined || !key.startsWith(`${scope}:`)) completed.delete(key);
}
