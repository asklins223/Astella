import { useSyncExternalStore } from "react";

/**
 * 「让伴星读这篇」的待发送附件（2026-11 文件关联）。
 *
 * 稿纸是模态的，伴星对话在它后面；按钮先把这一份存进模块，稿纸关掉、对话打开时
 * 输入框上方就挂着这张文件签。用户自己按发送才真正上传并随回合走——按钮的语义
 * 是「把这篇交给她读」，不是「替用户提问」。
 */
export type PendingCompanionFile = {
  readonly path: string;
  readonly name: string;
  /** 当前编辑器里的正文；发送时写进 turn 的 file block，伴星据此回答。 */
  readonly text: string;
};

let pending: PendingCompanionFile | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function requestCompanionFileAttachment(file: PendingCompanionFile): void {
  pending = file;
  emit();
}

export function peekPendingCompanionFile(): PendingCompanionFile | null {
  return pending;
}

export function clearPendingCompanionFile(): void {
  if (!pending) return;
  pending = null;
  emit();
}

export function usePendingCompanionFile(): PendingCompanionFile | null {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => pending,
    () => null,
  );
}
