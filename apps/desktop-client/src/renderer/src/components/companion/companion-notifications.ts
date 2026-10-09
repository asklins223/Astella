import { create } from "zustand";

export type CompanionNotificationKind = "model" | "task" | "review" | "reminder" | "help";
export type CompanionNotificationAudio = "voice-model-needed" | "voice-model-ready" | "voice-model-failed" | "task-ready" | "task-failed" | "review-due" | "update-installed";

export interface CompanionNotificationAction {
  readonly id: string;
  readonly label: string;
  readonly kind: "navigate" | "confirm" | "cancel";
  /** Returning false keeps the notice open. Rejection keeps it open with a retryable error. */
  readonly run?: () => void | boolean | Promise<void | boolean>;
}

export interface CompanionNotificationInput {
  /** Stable business identity, e.g. task:<taskId>:ready. */
  readonly id: string;
  readonly kind: CompanionNotificationKind;
  readonly title: string;
  readonly body: string;
  readonly source?: string;
  /** Device notices survive workspace changes; other notices belong to a workspace revision. */
  readonly scope: "device" | number;
  readonly delivery?: "immediate" | "when-idle";
  readonly priority?: "normal" | "high";
  readonly actions?: readonly CompanionNotificationAction[];
  readonly audio?: { readonly clip?: CompanionNotificationAudio; readonly text: string };
  readonly expiresAt?: number;
  readonly snoozable?: boolean;
  readonly progress?: { readonly percent: number; readonly label: string };
  readonly onShown?: () => void | Promise<void>;
  readonly onDismiss?: () => void | Promise<void>;
  readonly onSnooze?: () => void | Promise<void>;
  readonly repeat?: boolean;
}

export interface CompanionNotification extends CompanionNotificationInput {
  readonly revision: number;
  readonly occurrence: number;
  readonly createdAt: number;
  readonly state: "unread" | "read" | "snoozed";
  readonly wakeAt?: number;
}

interface NotificationStore {
  readonly items: readonly CompanionNotification[];
  push(input: CompanionNotificationInput): void;
  dismiss(id: string): void;
  remove(id: string): void;
  update(id: string, patch: Partial<Pick<CompanionNotificationInput, "body" | "progress">>): void;
  snooze(id: string, durationMs?: number): void;
  tick(now: number): void;
  clearWorkspace(scope: number): void;
}

let occurrence = 0;
export const useCompanionNotifications = create<NotificationStore>((set) => ({
  items: [],
  push: input => set(state => {
    const previous = state.items.find(item => item.id === input.id);
    if (previous && !input.repeat) return state;
    const next: CompanionNotification = {
      ...input, revision: (previous?.revision ?? 0) + 1, occurrence: ++occurrence, createdAt: Date.now(), state: "unread",
    };
    // Keep unread notices. Only finished history is bounded in this in-window inbox.
    const others = state.items.filter(item => item.id !== input.id);
    const history = others.filter(item => item.state === "read").slice(-30);
    return { items: [...others.filter(item => item.state !== "read"), ...history, next] };
  }),
  dismiss: id => set(state => ({ items: state.items.map(item => item.id === id ? { ...item, state: "read", wakeAt: undefined } : item) })),
  remove: id => set(state => ({ items: state.items.filter(item => item.id !== id) })),
  update: (id, patch) => set(state => ({ items: state.items.map(item => item.id === id ? { ...item, ...patch } : item) })),
  snooze: (id, durationMs = 10 * 60_000) => set(state => ({
    items: state.items.map(item => item.id === id ? { ...item, state: "snoozed", wakeAt: Date.now() + durationMs } : item),
  })),
  tick: now => set(state => {
    let changed = false;
    const items = state.items.flatMap(item => {
      if (item.expiresAt !== undefined && item.expiresAt <= now) { changed = true; return []; }
      if (item.state === "snoozed" && item.wakeAt !== undefined && item.wakeAt <= now) {
        changed = true;
        return [{ ...item, state: "unread" as const, wakeAt: undefined, revision: item.revision + 1 }];
      }
      return [item];
    });
    return changed ? { items } : state;
  }),
  clearWorkspace: scope => set(state => ({ items: state.items.filter(item => item.scope === "device" || item.scope === scope) })),
}));

/** Shared entry for system guidance, background work and learning reminders. */
export function notifyCompanion(input: CompanionNotificationInput): void {
  useCompanionNotifications.getState().push(input);
}

export const notificationKey = (notice: CompanionNotification) => `${notice.id}:${notice.occurrence}:${notice.revision}`;

export function nextCompanionNotification(items: readonly CompanionNotification[], seen: ReadonlySet<string>, busy: boolean): CompanionNotification | null {
  const candidates = items.filter(item => item.state === "unread" && !seen.has(notificationKey(item))
    && (item.expiresAt === undefined || item.expiresAt > Date.now())
    && (!busy || item.delivery === "immediate"));
  return candidates.find(item => item.delivery === "immediate") ?? candidates.find(item => item.priority === "high") ?? candidates[0] ?? null;
}
