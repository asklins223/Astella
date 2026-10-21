import { create } from "zustand";
import type { CardScene } from "./card-model";

/** The room keeps one companion; card pages only publish their presentation. */
export const useLearningCardPresentation = create<{
  owner: object | null;
  scene: CardScene | null;
  reward: { active: boolean; at: number };
}>(() => ({ owner: null, scene: null, reward: { active: false, at: 0 } }));

export function isImmersiveCardScene(scene: CardScene | null): boolean {
  return scene === "practice" || scene === "grading" || scene === "celebrate" || scene === "results";
}
