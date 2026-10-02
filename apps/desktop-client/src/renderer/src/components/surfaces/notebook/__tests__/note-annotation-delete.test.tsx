// @vitest-environment jsdom
/**
 * 删批注的界面判据（就地两步确认 + 正文里直接删）。
 *
 * 量的都是**不可逆动作必须说清后果**那一族：
 * 1. 第一步**不发任何写操作**——「先不删」必须是零副作用；
 * 2. 确认那句话**说清连带删了什么**，并说明伴星的对话不受影响；
 * 3. 同一个 native confirm 都不许有（它接管整个窗口，HUD 那一瞬变成系统对话框）；
 * 4. 失败时批注**留在屏上**并给出原因，不能纸一合上像删掉了；
 * 5. 旧版快照**不给**删除按钮。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { NoteAnnotationSidePage } from "../note-annotation-side-page";
import { AnnotationDeleteControl, useAnnotationDeleteConfirm } from "../annotation-delete-control";
import { renderHook, act } from "@testing-library/react";
import type { NoteAnnotationV1 } from "@ailearn/shared/note-annotation-contracts";
import type { NoteLearningArtifactTaskV1 } from "@ailearn/shared/note-learning-artifact-contracts";

const ANNOTATION: NoteAnnotationV1 = {
  annotationId: "a-1",
  noteId: "n-1",
  anchor: {
    noteVersionId: "v-1", startBlockOrdinal: 0, startOffset: 0, endBlockOrdinal: 0, endOffset: 7,
    excerpt: "提取练习让大脑", prefix: "", suffix: "重新构建记忆痕迹。",
  },
  explanation: "这是白话解释。",
  sourceMessageId: null,
  generationJobId: "11111111-1111-4111-8111-111111111111",
  revision: 3,
  versionState: "current",
  createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
};

const artifactReady = (): NoteLearningArtifactTaskV1 => ({
  taskId: "t-1", noteId: "n-1", noteVersionId: "v-1", sourceKind: "annotation",
  selectionAnchor: ANNOTATION.anchor, status: "ready",
  artifact: {
    artifactId: "ar-1", noteId: "n-1", noteVersionId: "v-1", sourceKind: "annotation",
    title: "提取练习", subject: "记忆", caution: "示意", contentType: "text/html",
    html: "<html></html>", generatorRef: "v1", createdAt: "2026-10-02T00:00:00.000Z",
  },
  failureReason: null, createdAt: "2026-10-02T00:00:00.000Z",
}) as unknown as NoteLearningArtifactTaskV1;

const sidePage = (props: Partial<Parameters<typeof NoteAnnotationSidePage>[0]> = {}) =>
  render(<NoteAnnotationSidePage
    annotation={ANNOTATION} task={null} artifactTasks={[]} artifactStarting={false} artifactError={null}
    onAsk={() => undefined} onCreateArtifact={() => undefined} onOpenArtifact={() => undefined}
    onRetry={() => undefined} onSettings={() => undefined}
    {...props} />);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("就地两步确认", () => {
  /** 正控制：点第一步只是把按钮变成确认态，一个写操作都不发。 */
  it("第一步不发任何写操作，只把按钮变成确认态", () => {
    const onConfirm = vi.fn();
    const onRequest = vi.fn();
    const view = render(<AnnotationDeleteControl annotation={ANNOTATION} hasArtifact view="idle"
      onRequest={onRequest} onCancel={() => undefined} onConfirm={onConfirm} />);
    fireEvent.click(view.getByRole("button", { name: /删掉这条批注/ }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onRequest).toHaveBeenCalledOnce();
  });

  /**
   * 反面判据：**不许有原生确认框**。
   *
   * 它接管整个窗口，HUD 那一瞬变成系统对话框，而且把「连带删了什么」藏在一行
   * 系统字里。这一条是为了防住将来有人觉得「还是 confirm 简单」而换回去。
   */
  it("不使用 window.confirm：那句后果写在纸上", () => {
    const confirm = vi.spyOn(window, "confirm");
    const view = render(<AnnotationDeleteControl annotation={ANNOTATION} hasArtifact view="confirming"
      onRequest={() => undefined} onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(confirm).not.toHaveBeenCalled();
    expect(view.getByRole("group", { name: "确认删除这条批注" }).textContent).toContain("删掉这条批注？");
    // 「伴星的对话不受影响」那句必须出现在纸上——用户最想知道的正是这一点。
    expect(view.getByRole("group", { name: "确认删除这条批注" }).textContent).toContain("伴星的对话记录不受影响");
  });

  it("有一份做好的演示时，确认那句话提到它会被一起删掉", () => {
    const view = render(<AnnotationDeleteControl annotation={ANNOTATION} hasArtifact view="confirming"
      onRequest={() => undefined} onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(view.getByRole("group").textContent).toContain("互动演示也会被删掉");
  });

  it("短版（记号浮层里）也仍然说清对话不受影响", () => {
    const view = render(<AnnotationDeleteControl annotation={ANNOTATION} hasArtifact compact view="confirming"
      onRequest={() => undefined} onCancel={() => undefined} onConfirm={() => undefined} />);
    const text = view.getByRole("group").textContent ?? "";
    expect(text).toContain("对话记录不受影响");
    // 短版更短：主语省掉，句子不该更长。
    expect(text.length).toBeLessThan("删掉这条批注？和它一起做的那个互动演示也会被删掉。伴星的对话记录不受影响。".length);
  });

  it("「先不删」回到平常那颗按钮，且不写任何东西", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const view = render(<AnnotationDeleteControl annotation={ANNOTATION} hasArtifact view="confirming"
      onRequest={() => undefined} onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.click(view.getByRole("button", { name: "先不删" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("确认态里按 Escape 也是「算了」", () => {
    const onCancel = vi.fn();
    const view = render(<AnnotationDeleteControl annotation={ANNOTATION} hasArtifact view="confirming"
      onRequest={() => undefined} onCancel={onCancel} onConfirm={() => undefined} />);
    fireEvent.keyDown(view.getByRole("group"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("第二步才真的删", () => {
    const onConfirm = vi.fn();
    const view = render(<AnnotationDeleteControl annotation={ANNOTATION} hasArtifact view="confirming"
      onRequest={() => undefined} onCancel={() => undefined} onConfirm={onConfirm} />);
    fireEvent.click(view.getByRole("button", { name: "确定删掉" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

describe("确认状态由页面只存一份", () => {
  /**
   * 两个入口（记号浮层、正文里的附页）是同一个动作——各自存一份会出现
   * 「附页里正问着要不要删，正文里那枚记号还是平常的样子」。这一条钉住它们同源。
   */
  it("两条入口读到的是同一个 confirmingId", () => {
    const { result } = renderHook(() => useAnnotationDeleteConfirm());
    expect(result.current.viewFor(ANNOTATION)).toBe("idle");
    act(() => result.current.request(ANNOTATION));
    expect(result.current.viewFor(ANNOTATION)).toBe("confirming");
    act(() => result.current.cancel());
    expect(result.current.viewFor(ANNOTATION)).toBe("idle");
  });

  it("确认的是 A 时，B 仍是平常那颗按钮", () => {
    const { result } = renderHook(() => useAnnotationDeleteConfirm());
    const other = { ...ANNOTATION, annotationId: "a-2" } as NoteAnnotationV1;
    act(() => result.current.request(ANNOTATION));
    expect(result.current.viewFor(other)).toBe("idle");
  });
});

describe("删批注的附页", () => {
  it("失败：明说批注还在，且不说「已删掉」", () => {
    const view = sidePage({ deleteError: "这条批注刚被别处改过", onDelete: () => undefined });
    expect(view.getByRole("alert").textContent).toContain("批注还在：这条批注刚被别处改过");
    expect(view.queryByText(/已删掉/)).toBeNull();
  });

  it("成功：留一句说清连带删了多少，附页不合上", () => {
    const view = sidePage({ removedNotice: "已删掉这条批注和它做的 1 个互动演示。伴星的对话记录没有动。" });
    expect(view.getByRole("status").textContent).toContain("1 个互动演示");
    expect(view.getByRole("status").textContent).toContain("对话记录没有动");
    expect(view.getByLabelText("原句批注")).toBeTruthy();
  });

  it("旧版快照不给删除入口", () => {
    const view = sidePage({ onDelete: () => undefined, readOnlySnapshot: true });
    expect(view.queryByRole("button", { name: /删掉这条/ })).toBeNull();
  });
});