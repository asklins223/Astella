// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NoteLearningCardAttemptV1, NoteLearningCardV1 } from "@astella/shared/note-learning-card-contracts";
import { useRoomStore } from "../../../../../../app/home/room-store";
import { LearningCardCelebration } from "../learning-card-celebration";
import { useLearningCardPresentation } from "../learning-card-presentation";
const capture = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock("../learning-card-motion", () => ({ playLearningCardReward: () => capture.stop }));
const card = { questions: [{ questionId: "q" }], bestScore: 80, bestStars: 4 } as NoteLearningCardV1;
const result = { score: 67, stars: 3, answers: [{ questionId: "q", score: 100, skipped: false }] } as NoteLearningCardAttemptV1;
const originalMotion = { motionMode: useRoomStore.getState().motionMode, reducedMotion: useRoomStore.getState().reducedMotion };
let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers(); capture.stop.mockClear();
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
  media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  window.matchMedia = vi.fn().mockReturnValue(media);
});
afterEach(() => { cleanup(); vi.useRealTimers(); useRoomStore.setState(originalMotion); });
const lights = () => document.querySelectorAll(".lc-award-star[data-lit]").length;
it("lights earned stars sequentially, cues the room companion, replays and cancels on exit", () => {
  const onDetails = vi.fn();
  const { unmount } = render(<LearningCardCelebration card={card} result={result} onDetails={onDetails} onCard={vi.fn()} />);
  expect(document.querySelector(".lc-celebration-character")).toBeNull();
  expect(useLearningCardPresentation.getState().reward.active).toBe(true);
  expect(lights()).toBe(0);
  act(() => { vi.advanceTimersByTime(649); }); expect(lights()).toBe(0);
  act(() => { vi.advanceTimersByTime(1); }); expect(lights()).toBe(1);
  act(() => { vi.advanceTimersByTime(280); }); expect(lights()).toBe(2);
  act(() => { vi.advanceTimersByTime(280); }); expect(lights()).toBe(3);
  act(() => { vi.advanceTimersByTime(4600); }); expect(useLearningCardPresentation.getState().reward.active).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "再庆祝一次" }));
  expect(lights()).toBe(0); expect(useLearningCardPresentation.getState().reward.active).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "查看答题详情" })); expect(onDetails).toHaveBeenCalledTimes(1);
  unmount(); expect(capture.stop).toHaveBeenCalled(); expect(useLearningCardPresentation.getState().reward.active).toBe(false);
});
it("motion Off retains all earned stars without starting a companion celebration", () => {
  useRoomStore.setState({ motionMode: "off" });
  render(<LearningCardCelebration card={card} result={result} onDetails={vi.fn()} onCard={vi.fn()} />);
  expect(lights()).toBe(3); expect(useLearningCardPresentation.getState().reward.active).toBe(false);
  expect(screen.getByText(/本次得分 67，3 星/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "查看答题详情" }) as HTMLButtonElement).disabled).toBe(false);
});
it("a system reduced-motion change settles the running reward immediately", () => {
  render(<LearningCardCelebration card={card} result={result} onDetails={vi.fn()} onCard={vi.fn()} />);
  act(() => { vi.advanceTimersByTime(650); }); expect(lights()).toBe(1);
  act(() => { media.matches = true; media.addEventListener.mock.calls[0]![1](); });
  expect(lights()).toBe(3); expect(capture.stop).toHaveBeenCalled();
  expect(useLearningCardPresentation.getState().reward.active).toBe(false);
});
