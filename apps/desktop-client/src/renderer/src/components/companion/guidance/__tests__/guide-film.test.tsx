// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../app/room-store";
import { filmClockStep, useGuideFilm } from "../use-guide-film";

beforeEach(() => useRoomStore.setState({ windowState: "visible" }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("keeps the last frame while narration is still speaking and never skips across a throttled window", () => {
  expect(filmClockStep(9.9, 2, 10, true, "speaking")).toEqual({ time: 10, done: false });
  expect(filmClockStep(10, .05, 10, true, "finished").done).toBe(true);
  expect(filmClockStep(4, 50, 10, false, "silent").time).toBe(4);
  expect(filmClockStep(4, 50, 10, true, "silent").time).toBe(4.25);
});
it("automatically joins chapters, pauses in place, and advances only once", () => {
  vi.useFakeTimers();
  const next = vi.fn(); let film!: ReturnType<typeof useGuideFilm>;
  function Probe() { film = useGuideFilm("room", 0, false, false, next); return null; }
  render(<Probe />);
  act(() => { vi.advanceTimersByTime(4_000); }); expect(film.phase).toBe(1);
  act(() => film.toggle()); const pausedAt = film.elapsed;
  act(() => { vi.advanceTimersByTime(20_000); }); expect(film.elapsed).toBe(pausedAt); expect(next).not.toHaveBeenCalled();
  act(() => film.toggle());
  act(() => { vi.advanceTimersByTime(7_000); }); expect(next).toHaveBeenCalledExactlyOnceWith(1);
  act(() => { vi.advanceTimersByTime(20_000); }); expect(next).toHaveBeenCalledOnce();
});
it("finishes at the invitation to start learning and keeps the real action voluntary", () => {
  vi.useFakeTimers(); const next = vi.fn(); let film!: ReturnType<typeof useGuideFilm>;
  function Probe() { film = useGuideFilm("return", 4, true, false, next); return null; }
  render(<Probe />);
  act(() => { film.reportVoice("preparing"); vi.advanceTimersByTime(10_000); });
  expect(film.finished).toBe(false);
  act(() => { film.reportVoice("finished"); vi.advanceTimersByTime(100); });
  expect(film.finished).toBe(true); expect(film.playing).toBe(false); expect(next).not.toHaveBeenCalled();
  act(() => film.restart()); expect(film.elapsed).toBe(0); expect(film.playing).toBe(true);
});

it("holds the film while the desktop window is hidden without changing the user's play choice", () => {
  vi.useFakeTimers(); const next = vi.fn(); let film!: ReturnType<typeof useGuideFilm>;
  function Probe() { film = useGuideFilm("room", 0, false, false, next); return null; }
  render(<Probe />);
  act(() => { vi.advanceTimersByTime(2_000); });
  act(() => useRoomStore.setState({ windowState: "hidden" })); const time = film.elapsed;
  act(() => { vi.advanceTimersByTime(15_000); }); expect(film.elapsed).toBe(time); expect(film.playing).toBe(true);
  act(() => useRoomStore.setState({ windowState: "visible" }));
  act(() => { vi.advanceTimersByTime(1_000); }); expect(film.elapsed).toBeGreaterThan(time);
});
