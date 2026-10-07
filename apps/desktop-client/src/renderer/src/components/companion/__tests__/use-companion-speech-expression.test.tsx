// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CompanionSpeechProgress } from "../../../app/companion-voice-playback";
import { useCompanionSpeechExpression } from "../use-companion-speech-expression";

const state = vi.hoisted(() => ({ listener: null as ((progress: CompanionSpeechProgress) => void) | null }));
vi.mock("../../../app/companion-voice-playback", () => ({ subscribeCompanionSpeech: (listener: typeof state.listener) => {
  state.listener = listener; return () => { state.listener = null; };
} }));
afterEach(() => { state.listener = null; });
const progress = (planId: string, phase: CompanionSpeechProgress["phase"], segmentIndex: number,
  emotion?: "happy" | "concerned" | "neutral"): CompanionSpeechProgress => ({ planId, phase, segmentIndex,
  segmentCount: 3, visibleChars: 1, ...(emotion ? { cue: { version: 1, intent: "explain", emotion, intensity: 0.6 } } : {}) });

it("follows played segments, retains expression through progress ticks and ignores an old plan's stop", () => {
  const { result } = renderHook(() => useCompanionSpeechExpression(1, false));
  expect(result.current).toBeNull();
  act(() => state.listener?.(progress("old", "speaking", 0, "happy")));
  expect(result.current?.emotion).toBe("happy");
  const first = result.current;
  act(() => state.listener?.(progress("old", "speaking", 0)));
  expect(result.current).toBe(first);
  act(() => state.listener?.(progress("new", "speaking", 0, "concerned")));
  act(() => state.listener?.(progress("old", "stopped", -1)));
  expect(result.current?.emotion).toBe("concerned");
  act(() => state.listener?.(progress("new", "speaking", 1, "neutral")));
  expect(result.current?.emotion).toBe("neutral");
  act(() => state.listener?.(progress("new", "finished", 2)));
  expect(result.current).toBeNull();
});

it("releases the face on interruption, scope switch and hidden/formal/muted presentation", () => {
  const { result, rerender } = renderHook(({ scope, paused }) => useCompanionSpeechExpression(scope, paused),
    { initialProps: { scope: 1, paused: false } });
  act(() => state.listener?.(progress("one", "speaking", 0, "happy")));
  act(() => state.listener?.(progress("one", "stopped", -1)));
  expect(result.current).toBeNull();
  act(() => state.listener?.(progress("two", "speaking", 0, "happy")));
  rerender({ scope: 2, paused: false });
  expect(result.current).toBeNull();
  act(() => state.listener?.(progress("three", "speaking", 0, "happy")));
  rerender({ scope: 2, paused: true });
  expect(result.current).toBeNull();
  expect(state.listener).toBeNull();
});
