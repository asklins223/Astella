import { useSyncExternalStore, type CSSProperties } from "react";

export type WritingPreferences = {
  theme: string;
  font: string;
  size: number;
  leading: number;
  width: number;
  focus: boolean;
  typewriter: boolean;
};

const STORAGE_KEY = "note-writing-preferences";
const defaults: WritingPreferences = { theme: "paper", font: "serif", size: 18, leading: 1.9, width: 800, focus: false, typewriter: false };

function number(value: unknown, key: "size" | "leading" | "width", min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : defaults[key];
}

export function readWritingPreferences(): WritingPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<WritingPreferences>;
    return {
      theme: ["paper", "white", "night"].includes(saved.theme ?? "") ? saved.theme! : defaults.theme,
      font: ["serif", "sans", "mono"].includes(saved.font ?? "") ? saved.font! : defaults.font,
      size: number(saved.size, "size", 14, 28),
      leading: number(saved.leading, "leading", 1.4, 2.4),
      width: number(saved.width, "width", 520, 1200),
      focus: saved.focus === true,
      typewriter: saved.typewriter === true,
    };
  } catch {
    return defaults;
  }
}

let cached: WritingPreferences | null = null;
const listeners = new Set<() => void>();

/** `useSyncExternalStore` 要稳定快照，否则每次读取都被当成变化而无限重渲染。 */
function snapshot(): WritingPreferences {
  cached ??= readWritingPreferences();
  return cached;
}

export function updateWritingPreferences(next: WritingPreferences): void {
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 存不下（隐私模式等）时这一份仍要在当前窗口生效，下次打开回到已存的值。
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWritingPreferences(): WritingPreferences {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * 偏好属于**书桌本身**，不属于某一个视图：阅读、编辑与源码共用同一份排版意图。
 * 它此前只由编辑工具栏里的组件写回 workspace，而这块 DOM 在三种视图间复用，
 * 于是「点进编辑再回阅读」会让阅读页突然换一套字号（2026-10-08 用户报）。
 */
export function writingPreferenceAttributes(prefs: WritingPreferences): Record<string, unknown> {
  return {
    "data-writing-theme": prefs.theme,
    "data-writing-font": prefs.font,
    "data-writing-focus": String(prefs.focus),
    "data-typewriter": String(prefs.typewriter),
    style: {
      "--writing-size": `${prefs.size}px`,
      "--writing-leading": String(prefs.leading),
      "--writing-width": `${prefs.width}px`,
    } as CSSProperties,
  };
}
