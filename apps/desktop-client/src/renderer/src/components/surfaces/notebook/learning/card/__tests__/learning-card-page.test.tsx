// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NoteLearningCardAttemptV1, NoteLearningCardQuestionV1, NoteLearningCardV1 } from "@astella/shared/note-learning-card-contracts";
import { LearningCardPage } from "../learning-card-page";
import { answerText, hasAnswer, outcome } from "../card-model";
vi.mock("../../../../../../app/client/desktop-client", () => ({ createRequestMeta: () => ({ requestId: "request" }), gatewayErrorMessage: (e: unknown) => e instanceof Error ? e.message : "读取失败", unwrapGatewayResult: <T,>(r: { value: T }) => r.value }));
vi.mock("../../../../../../app/companion-session/companion-voice-playback", () => ({ stopCompanionSpeech: vi.fn() }));
vi.mock("../../../../../companion/voice/companion-notification-voice", () => ({ stopCompanionNotificationSpeech: vi.fn() }));
vi.mock("../../../../../companion/live2d/WindowLive2D", () => ({ WindowLive2D: () => <div aria-label="伴星测试接缝" /> }));
const grounding = { note: [{ blockOrdinal: 2, quote: "中央任命地方官，统一行使行政职权。" }] };
const q = (id: string, type: NoteLearningCardQuestionV1["type"], stem: string): NoteLearningCardQuestionV1 => ({ questionId: id, type, stem, ordinal: Number(id.slice(1)) - 1, options: type === "single_choice" ? ["由中央任命", "地方世袭"] : null, blankCount: null, rightOptions: null, operationArtifactId: null, grounding });
const questions = [q("q1", "single_choice", "地方官如何产生？"), q("q2", "true_false", "地方官是否世袭？"), q("q3", "short_answer", "为什么由中央任命？"), q("q4", "fill_blank", "哪种机构负责地方行政？")];
let card: NoteLearningCardV1, histories: NoteLearningCardAttemptV1[];
const api = { get: vi.fn(), history: vi.fn(), generate: vi.fn(), startAttempt: vi.fn(), answer: vi.fn(), complete: vi.fn() };
const ok = <T,>(value: T) => ({ value });
const attempt = (): NoteLearningCardAttemptV1 => ({ attemptId: "attempt-1", status: "in_progress", score: null, stars: null, summary: null, startedAt: "2026-10-20T01:00:00Z", completedAt: null, answers: [] });
beforeEach(() => {
  vi.clearAllMocks(); histories = [];
  card = { cardId: "card-1", noteId: "note-1", noteVersionId: "version-1", status: "active", questions: structuredClone(questions), omittedQuestionCount: 0, bestScore: 80, bestStars: 4, lastAttempt: null, createdAt: "2026-10-20T01:00:00Z", updatedAt: "2026-10-20T01:00:00Z" };
  api.get.mockImplementation(async () => ok({ card, generating: false }));
  api.history.mockImplementation(async () => ok({ items: structuredClone(histories) }));
  api.startAttempt.mockImplementation(async () => { histories = [attempt()]; return ok({ attemptId: "attempt-1", cardId: "card-1" }); });
  api.answer.mockImplementation(async (input: { questionId: string; answer: unknown }) => {
    histories[0]!.answers = histories[0]!.answers.filter((a) => a.questionId !== input.questionId);
    histories[0]!.answers.push({ questionId: input.questionId, answer: input.answer, score: null, feedback: null, skipped: Boolean((input.answer as { skipped?: boolean })?.skipped), referenceAnswer: null, rubric: null, grounding });
    return ok({ answerId: input.questionId });
  });
  api.complete.mockImplementation(async () => {
    Object.assign(histories[0]!, { status: "completed", score: 50, stars: 2, completedAt: "2026-10-20T01:10:00Z", summary: { text: "本次两道题答对，另外两道跳过，可以回看地方行政的原文。" } });
    histories[0]!.answers = histories[0]!.answers.map((a) => ({ ...a, score: a.skipped ? 0 : 100, referenceAnswer: { optionId: "0" }, feedback: { kind: "objective" } }));
    return ok({ attemptId: "attempt-1", grading: true });
  });
  window.astella = { noteLearningCard: api } as never;
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; });
const mount = () => render(<LearningCardPage noteId="note-1" noteVersionId="version-1" title="秦的地方治理" onClose={vi.fn()} />);
async function start() { mount(); fireEvent.click(await screen.findByRole("button", { name: /开始练习/ })); await screen.findByRole("heading", { name: questions[0]!.stem }); }
const jump = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
it("supports free jumps, false answers, explicit skips, unfinished submission, best stars, and post-submit references", async () => {
  await start(); expect(document.querySelector(".lc-source-evidence")).toBeNull(); expect(screen.queryByText("伴星的小结")).toBeNull();
  jump("A 由中央任命"); jump("第 3 题，未作答");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "可以统一行政" } });
  jump("先跳过"); jump("第 2 题，未作答"); jump("B 错误"); jump("结束并交卷");
  expect(screen.getByText(/还有 1 道未完成/)).toBeTruthy(); jump("跳过未完成题并交卷");
  await waitFor(() => expect(api.complete).toHaveBeenCalledTimes(1));
  const sent = api.answer.mock.calls.map(([input]) => input);
  expect(sent).toContainEqual(expect.objectContaining({ questionId: "q2", answer: false }));
  for (const questionId of ["q3", "q4"]) expect(sent).toContainEqual(expect.objectContaining({ questionId, answer: expect.objectContaining({ skipped: true }) }));
  await screen.findByRole("button", { name: "查看答题详情" }, { timeout: 5000 }); jump("查看答题详情");
  expect(screen.getByText(/最佳 80 分/)).toBeTruthy(); fireEvent.click(screen.getByText(questions[0]!.stem));
  const opened = within(document.querySelector(".lc-review-item[open]") as HTMLElement); expect(opened.getByText(grounding.note[0]!.quote)).toBeTruthy(); expect(opened.getByText("你的作答")).toBeTruthy();
  jump("伴星总结"); expect(screen.getByRole("heading", { name: "给认真练习的你" })).toBeTruthy();
});
it("preserves a draft across free jumps, saved exit and remount using attempt history", async () => {
  await start(); jump("第 3 题，未作答");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "避免地方权力世袭" } });
  jump("第 1 题，未作答"); jump("第 3 题，已作答"); expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("避免地方权力世袭");
  jump("暂时离开"); jump("保存并离开");
  const resume = await screen.findByRole("button", { name: /继续作答/ });
  await waitFor(() => expect(document.activeElement).toBe(resume));
  cleanup(); mount(); fireEvent.click(await screen.findByRole("button", { name: /继续作答/ })); jump("第 3 题，已作答");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("避免地方权力世袭"); expect(api.startAttempt).toHaveBeenCalledTimes(1);
});
it("keeps the draft and blocks completion when saving fails", async () => {
  await start(); api.answer.mockRejectedValue(new Error("网络暂时不可用"));
  jump("A 由中央任命"); jump("结束并交卷"); jump("跳过未完成题并交卷");
  await screen.findByText("网络暂时不可用"); expect(api.complete).not.toHaveBeenCalled(); expect(screen.getByRole("heading", { name: questions[0]!.stem })).toBeTruthy();
});
it("returns keyboard focus to the exact control after cancelling either practice dialog", async () => {
  await start();
  const answer = screen.getByRole("button", { name: "A 由中央任命" });
  answer.focus();
  fireEvent.keyDown(answer, { key: "Escape" });
  const leave = screen.getByRole("dialog", { name: "保存并暂时离开练习" });
  within(leave).getByRole("button", { name: "关闭" }).focus();
  fireEvent(leave, new Event("cancel", { cancelable: true }));
  expect(document.activeElement).toBe(answer);
  expect(leave.hasAttribute("open")).toBe(false);
  const submit = screen.getByRole("button", { name: "结束并交卷" });
  submit.focus(); fireEvent.click(submit);
  const confirmation = screen.getByRole("dialog", { name: "确认交卷" });
  const back = within(confirmation).getByRole("button", { name: "再检查一下" });
  back.focus(); fireEvent.click(back);
  expect(document.activeElement).toBe(submit);
  expect(confirmation.hasAttribute("open")).toBe(false);
  expect(api.complete).not.toHaveBeenCalled();
});
it("sends the selected generation count through the production bridge", async () => {
  api.get.mockImplementation(async () => ok({ card: null, generating: false })); api.generate.mockResolvedValue(ok({ cardId: "card-1", queued: true })); mount();
  fireEvent.click(await screen.findByRole("button", { name: /8.*题.*多想深一点/ })); jump("生成这张学习卡");
  await waitFor(() => expect(api.generate).toHaveBeenCalledWith(expect.objectContaining({ options: { questionCount: 8 } })));
  expect(await screen.findByRole("heading", { name: "正在制作你的学习卡" })).toBeTruthy();
});
it("treats false as an answer, incomplete ordering as unfinished, and zero-score skips separately from errors", () => {
  expect(hasAnswer(questions[1]!, false)).toBe(true); expect(hasAnswer({ ...questions[0]!, type: "ordering" }, { order: ["0"] })).toBe(false); expect(hasAnswer(questions[2]!, { skipped: true })).toBe(false);
  const result = attempt(); result.status = "completed"; result.answers = [{ questionId: "q1", answer: { skipped: true }, score: 0, skipped: true, feedback: null, referenceAnswer: null, rubric: null, grounding }];
  expect(outcome(result, "q1")).toBe("skipped"); result.answers[0]!.skipped = false; expect(outcome(result, "q1")).toBe("wrong");
});

it("restarts polling after retrying a failed grading job", async () => {
  await start();
  api.complete.mockImplementationOnce(async () => { histories[0]!.status = "grading_failed"; return ok({ attemptId: "attempt-1", grading: true }); });
  jump("A 由中央任命"); jump("结束并交卷"); jump("跳过未完成题并交卷");
  fireEvent.click(await screen.findByRole("button", { name: "重新批改" }, { timeout: 5000 }));
  await screen.findByRole("button", { name: "查看答题详情" }, { timeout: 5000 });
  expect(api.complete).toHaveBeenCalledTimes(2);
});
it("creates a new attempt after generating a card for a new version instead of resuming the old card", async () => {
  card.noteVersionId = "old-version"; histories = [attempt()];
  api.history.mockImplementation(async (input) => ok({ items: input.cardId === "new-card" ? [] : structuredClone(histories) }));
  api.generate.mockImplementation(async () => { card = { ...card, cardId: "new-card", noteVersionId: "version-1", bestScore: null, bestStars: null }; return ok({ cardId: "new-card", queued: true }); });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "按当前版本生成新卡" })); jump("生成这张学习卡");
  fireEvent.click(await screen.findByRole("button", { name: "开始练习" }, { timeout: 5000 }));
  await waitFor(() => expect(api.startAttempt).toHaveBeenCalledWith(expect.objectContaining({ cardId: "new-card" })));
});

it("preserves a skipped draft and allows explicitly using it again", async () => {
  await start(); jump("第 3 题，未作答");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "草稿也要保留" } });
  jump("先跳过"); jump("第 3 题，已跳过");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("草稿也要保留");
  jump("使用这份回答"); expect(screen.getByRole("button", { name: "第 3 题，已作答" })).toBeTruthy();
});

it("renders real grading references for choice, multi-choice and false judgments", () => {
  expect(answerText(questions[0]!, { correctOptionId: "0" })).toBe("由中央任命");
  expect(answerText(questions[0]!, { correctOptionIds: ["0", "1"] })).toBe("由中央任命；地方世袭");
  expect(answerText(questions[1]!, { correct: false })).toBe("错误");
});

it("keeps the card landing in its room page and isolates only the immersive answering page", async () => {
  const host = document.createElement("div"); host.id = "root";
  host.innerHTML = '<div class="desktop-app"><div class="desktop-access-gate__room-content"><div class="room-chrome"><button>返回笔记</button></div><div class="companion-presence"><button>伴星</button></div><main id="main-content"><div id="card-mount"></div></main></div><nav class="hud-rail"><button>目录导航</button></nav></div><div class="companion-notifications"><button>通知</button></div>';
  document.body.append(host);
  const view = render(<LearningCardPage noteId="note-1" noteVersionId="version-1" title="秦的地方治理" onClose={vi.fn()} />, { container: document.getElementById("card-mount")! });
  const startButton = await screen.findByRole("button", { name: /开始练习/ });
  const shell = document.querySelector<HTMLElement>(".room-chrome")!, main = document.getElementById("main-content")!;
  expect(document.querySelector('.learning-card-page[data-presentation="desk"]')?.closest("#main-content")).toBe(main);
  expect(shell.inert).not.toBe(true); expect(main.inert).not.toBe(true); expect(host.inert).not.toBe(true);
  fireEvent.click(startButton); await screen.findByRole("heading", { name: questions[0]!.stem });
  expect(document.querySelector('.learning-card-page[data-presentation="immersive"]')?.parentElement).toBe(document.querySelector(".desktop-access-gate__room-content"));
  expect(shell.inert).toBe(true); expect(main.inert).toBe(true);
  expect(document.querySelector<HTMLElement>(".hud-rail")!.inert).toBe(true);
  expect(document.querySelector<HTMLElement>(".companion-notifications")!.inert).toBe(true);
  expect(document.querySelector<HTMLElement>(".companion-presence")!.inert).not.toBe(true);
  jump("暂时离开"); jump("保存并离开"); await screen.findByRole("button", { name: /继续作答/ });
  expect(shell.inert).not.toBe(true); expect(main.inert).not.toBe(true);
  expect(document.querySelector<HTMLElement>(".hud-rail")!.inert).not.toBe(true);
  expect(document.body.dataset.learningCardImmersive).toBeUndefined();
  view.unmount();
});

it("shows the most recently completed attempt first, including a resumed older attempt", async () => {
  histories = [
    { ...attempt(), attemptId: "newer-start", status: "completed", score: 94, stars: 5, startedAt: "2026-10-20T03:00:00Z", completedAt: "2026-10-20T03:10:00Z" },
    { ...attempt(), attemptId: "later-finish", status: "completed", score: 6, stars: 1, startedAt: "2026-10-20T01:00:00Z", completedAt: "2026-10-20T11:47:00Z" },
  ];
  mount(); await screen.findByRole("button", { name: /再练一次/ });
  const recent = document.querySelector(".lc-last-score")!;
  expect(recent.textContent).toContain("6 / 100"); expect(recent.textContent).not.toContain("94 / 100");
  jump("查看本次答题与总结");
  expect(document.querySelector(".lc-report-score")!.textContent).toContain("6 分");
});

it("opens the selected result question, then returns keyboard focus to that exact question entry", async () => {
  histories = [{ ...attempt(), status: "completed", score: 50, stars: 2, completedAt: "2026-10-20T01:10:00Z" }];
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /第 3 题，.*查看详情/ }));
  const opened = document.querySelector<HTMLDetailsElement>('.lc-review-item[data-question-id="q3"]')!;
  await waitFor(() => expect(opened.open).toBe(true));
  expect(document.querySelectorAll(".lc-review-item[open]")).toHaveLength(1);
  expect(document.activeElement).toBe(opened.querySelector("summary"));
  expect(within(opened).getByText("你的作答")).toBeTruthy();
  jump("回到学习卡");
  const origin = screen.getByRole("button", { name: /第 3 题，.*查看详情/ });
  // A user can press Tab immediately after returning; focus cannot wait for a timer.
  expect(document.activeElement).toBe(origin);
});

it("returns to the actual historical attempt entry after reviewing its report", async () => {
  histories = [
    { ...attempt(), status: "completed", score: 50, stars: 2, completedAt: "2026-10-20T02:10:00Z" },
    { ...attempt(), attemptId: "older-attempt", status: "completed", score: 100, stars: 5, completedAt: "2026-10-20T01:10:00Z" },
  ];
  mount(); await screen.findByRole("button", { name: "查看本次答题与总结" });
  fireEvent.click(document.querySelector<HTMLButtonElement>('.lc-history-list button')!);
  expect(document.querySelector(".lc-report-score")!.textContent).toContain("100 分");
  expect(document.querySelectorAll(".lc-review-item[open]")).toHaveLength(0);
  jump("回到学习卡");
  await waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-card-focus="attempt:older-attempt"]')));
});

it("keeps the normal directory and room island available on both the report and celebration", async () => {
  histories = [{ ...attempt(), status: "completed", score: 50, stars: 2, completedAt: "2026-10-20T01:10:00Z" }];
  const host = document.createElement("div"); host.id = "root";
  host.innerHTML = '<div class="desktop-app"><div class="desktop-access-gate__room-content"><div class="room-chrome"><button>灵动岛</button></div><main id="main-content"><div id="card-mount"></div></main></div><nav class="hud-rail"><button>目录导航</button></nav></div>';
  document.body.append(host);
  render(<LearningCardPage noteId="note-1" noteVersionId="version-1" title="秦的地方治理" onClose={vi.fn()} />, { container: document.getElementById("card-mount")! });
  fireEvent.click(await screen.findByRole("button", { name: "查看本次答题与总结" }));
  const chrome = document.querySelector<HTMLElement>(".room-chrome")!, rail = document.querySelector<HTMLElement>(".hud-rail")!;
  expect(document.body.dataset.learningCardFocus).toBeUndefined();
  expect(document.getElementById("main-content")!.inert).toBe(true);
  expect(chrome.inert).not.toBe(true); expect(rail.inert).not.toBe(true);
  expect(screen.getByRole("heading", { name: "练习结果" })).toBeTruthy();
  jump("重看庆祝");
  expect(screen.getByRole("heading", { name: "练习完成" })).toBeTruthy();
  expect(chrome.inert).not.toBe(true); expect(rail.inert).not.toBe(true);
  expect(document.body.dataset.learningCardFocus).toBeUndefined();
});

it("retries a missing summary while retaining the completed report and earned score", async () => {
  histories = [{ ...attempt(), status: "completed", score: 50, stars: 2, completedAt: "2026-10-20T01:10:00Z" }];
  api.complete.mockImplementation(async () => { histories[0]!.summary = { text: "这次的题目已经核对，可以回看原文再练。" }; return ok({ attemptId: "attempt-1", grading: false }); });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "查看本次答题与总结" })); jump("伴星总结"); jump("重试总评");
  await screen.findByText("这次的题目已经核对，可以回看原文再练。");
  expect(api.complete).toHaveBeenCalledWith(expect.objectContaining({ attemptId: "attempt-1", summaryOnly: true }));
  expect(document.querySelector(".lc-report-score")!.textContent).toContain("50 分");
  expect(api.startAttempt).not.toHaveBeenCalled();
});
it("refreshes an existing summary while retaining it during work and after a failed update", async () => {
  const original = "这是一份仍可阅读的旧总评。";
  histories = [{ ...attempt(), status: "completed", score: 50, stars: 2, completedAt: "2026-10-20T01:10:00Z", summary: { text: original } }];
  api.complete.mockImplementation(async () => { histories[0]!.summary = { text: original, status: "pending" }; return ok({ attemptId: "attempt-1", grading: false, jobId: "summary-job" }); });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "查看本次答题与总结" })); jump("伴星总结"); jump("重新生成总评");
  await screen.findByText(/正在重新整理总评/); expect(screen.getByText(original)).toBeTruthy();
  expect(screen.getByRole("button", { name: "正在生成总评…" }).hasAttribute("disabled")).toBe(true);
  histories[0]!.summary = { text: original, status: "failed" };
  await screen.findByText(/上方仍是原来的总评/, {}, { timeout: 4000 });
  expect(screen.getByText(original)).toBeTruthy(); expect(screen.getByRole("button", { name: "重新生成总评" }).hasAttribute("disabled")).toBe(false);
  expect(document.querySelector(".lc-report-score")!.textContent).toContain("50 分");
  expect(api.startAttempt).not.toHaveBeenCalled(); expect(api.answer).not.toHaveBeenCalled();
});

it("opens historical card versions with their own stars and saved attempts", async () => {
  const latest = { ...card, bestScore: null, bestStars: null }, old = { ...card, cardId: "old-card", noteVersionId: "old-version", bestScore: 100, bestStars: 5 };
  const versions = [{ cardId: latest.cardId, noteVersionId: latest.noteVersionId, versionNo: 2, status: "active", createdAt: latest.createdAt }, { cardId: old.cardId, noteVersionId: old.noteVersionId, versionNo: 1, status: "stale", createdAt: old.createdAt }];
  api.get.mockImplementation(async input => ok({ card: input.cardId === old.cardId ? old : latest, generating: false, versions }));
  mount(); const picker = await screen.findByRole("combobox", { name: "学习卡版本" });
  expect(screen.getByLabelText("尚无星级")).toBeTruthy();
  fireEvent.change(picker, { target: { value: "old-card" } });
  await screen.findByLabelText("最佳 5 星");
  expect(api.get).toHaveBeenLastCalledWith(expect.objectContaining({ cardId: "old-card" }));
  expect(api.generate).not.toHaveBeenCalled();
});

it("presents actual question numbers in summaries instead of internal identifiers", async () => {
  const { summaryText } = await import("../card-model");
  const id = "06aca320-b505-45b3-9572-dacaf5948879";
  expect(summaryText({ text: `${id}答对，06aca320可以继续练习。` }, [id])).toBe("第1题答对，第1题可以继续练习。");
  const collision = "06aca320-c505-45b3-9572-dacaf5948879";
  expect(summaryText("06aca320", [id, collision])).toBe("06aca320");
});

it("quietly reports questions discarded by validation without changing the kept question list", async () => {
  mount();
  await screen.findByRole("button", { name: /开始练习/ });
  expect(screen.queryByText(/未通过校验/)).toBeNull();
  cleanup(); document.body.innerHTML = "";
  card.omittedQuestionCount = 2;
  mount();
  const notice = await screen.findByText("有 2 道题未通过校验，没有收录");
  expect(notice.closest(".lc-card-omitted")).toBeTruthy();
  expect(document.querySelector(".lc-card-length")?.textContent).toContain("4 道题");
  expect(document.querySelectorAll(".lc-card-contents>li")).toHaveLength(4);
});
