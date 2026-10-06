// @vitest-environment jsdom
/**
 * 「个人档案」到取景框的接线契约：
 *
 * - 选中的文件**先进取景框**，只有「使用这张」才把裁剪产物交给上传——原文件不能
 *   从旁路溜上去，那正是这次要修的事；
 * - 上传走完之前框不收：网慢时「正在上传…」必须看得见；失败就地显示原因、
 *   裁剪结果不丢，可以直接再试；
 * - 取消与 Escape 不动数据，焦点还给「更换…」；
 * - 读不出来的图片要有说法和回头路。
 *
 * jsdom 画不出画布：这里桩掉 2d 上下文与 toBlob，几何本身由
 * `avatar-crop-geometry.test.ts` 用纯数验证。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../app/room-store";
import { SettingsAccountPanel, type AvatarUploadOutcome } from "../settings-account-panel";

const SOURCE_BITMAP = { width: 800, height: 600, close: vi.fn() };

let ctx: {
  setTransform: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  translate: ReturnType<typeof vi.fn>;
  rotate: ReturnType<typeof vi.fn>;
  scale: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  imageSmoothingQuality: string;
};

beforeEach(() => {
  ctx = {
    setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
    translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(), drawImage: vi.fn(),
    imageSmoothingQuality: "low",
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(( callback, type) => {
    callback(new Blob(["cropped"], { type: type ?? "image/webp" }));
  });
  vi.stubGlobal("createImageBitmap", vi.fn(async () => SOURCE_BITMAP));
});

afterEach(() => {
  cleanup();
  useRoomStore.getState().setReducedMotion(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderPanel(overrides: {
  readonly onUploadAvatar?: (file: File) => Promise<AvatarUploadOutcome>;
} = {}) {
  const uploadAvatar = vi.fn(overrides.onUploadAvatar ?? (async (_file: File): Promise<AvatarUploadOutcome> => ({ ok: true })));
  render(
    <SettingsAccountPanel
      profile={{ version: 1, displayName: "读者", avatarUrl: null }}
      displayName="读者"
      busy={null}
      onDisplayNameChange={vi.fn()}
      onSaveDisplayName={vi.fn(async () => {})}
      onUploadAvatar={uploadAvatar}
      onClearAvatar={vi.fn(async () => {})}
    />,
  );
  return { uploadAvatar };
}

function pickFile(name: string, type = "image/png") {
  const input = screen.getByLabelText("更换…") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["raw"], name, { type })] } });
  return input;
}

async function openCropper(name: string) {
  const input = pickFile(name);
  await screen.findByRole("dialog");
  const confirm = screen.getByText("使用这张") as HTMLButtonElement;
  await waitFor(() => expect(confirm.disabled).toBe(false));
  return { input, confirm };
}

describe("设置页头像取景框", () => {
  it("看过的文件只有确认之后才上传，交出去的是裁剪产物", async () => {
    const { uploadAvatar } = renderPanel();
    const { confirm } = await openCropper("portrait.png");

    expect(screen.getByText("调整头像")).toBeTruthy();
    expect(uploadAvatar).not.toHaveBeenCalled();

    fireEvent.click(confirm);
    await waitFor(() => expect(uploadAvatar).toHaveBeenCalledTimes(1));
    const cropped = uploadAvatar.mock.calls[0]![0];
    expect(cropped.name).toBe("portrait.webp");
    expect(cropped.type).toBe("image/webp");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("上传走完之前框不收：圆孔里亮着「正在上传…」", async () => {
    const gate = deferred<AvatarUploadOutcome>();
    renderPanel({ onUploadAvatar: () => gate.promise });
    const { confirm } = await openCropper("portrait.png");

    fireEvent.click(confirm);
    expect((await screen.findByRole("status")).textContent).toContain("正在上传…");
    // 框还在，控制项都锁着；主按钮自己也说明在忙。
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByRole("button", { name: "正在上传…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "右转" }) as HTMLButtonElement).disabled).toBe(true);

    gate.resolve({ ok: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("上传失败：原因就地显示，裁剪结果不丢，能直接再试一次", async () => {
    const attempts: File[] = [];
    renderPanel({
      onUploadAvatar: async (file) => {
        attempts.push(file);
        return attempts.length === 1 ? { ok: false, message: "网络开小差了，头像没有传上去。" } : { ok: true };
      },
    });
    const { confirm } = await openCropper("portrait.png");

    fireEvent.click(confirm);
    expect((await screen.findByRole("alert")).textContent).toContain("网络开小差了，头像没有传上去。");
    expect(screen.getByRole("dialog")).toBeTruthy();
    // 提交按钮禁用时焦点掉给了 body，失败回到可试状态后要把它收回来。
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "再试一次" })));

    fireEvent.click(screen.getByRole("button", { name: "再试一次" }));
    await waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts[1]!.type).toBe("image/webp");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("上传中取消：框可以走，迟到的结果不写回也不炸", async () => {
    const gate = deferred<AvatarUploadOutcome>();
    renderPanel({ onUploadAvatar: () => gate.promise });
    const { confirm } = await openCropper("portrait.png");

    fireEvent.click(confirm);
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // 上传在后头照走：失败的结果此时无人接收，只能被安心扔掉。
    gate.reject(new Error("太晚了"));
    await Promise.resolve();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("取消不上传，焦点回到「更换…」", async () => {
    const { uploadAvatar } = renderPanel();
    const { input } = await openCropper("portrait.png");

    fireEvent.click(screen.getByText("取消"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(uploadAvatar).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it("Escape 与取消同路", async () => {
    const { uploadAvatar } = renderPanel();
    await openCropper("portrait.png");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(uploadAvatar).not.toHaveBeenCalled();
  });

  it("右转 90°：减少动态时立即写进取景几何", async () => {
    useRoomStore.getState().setReducedMotion(true);
    renderPanel();
    await openCropper("portrait.png");

    ctx.rotate.mockClear();
    fireEvent.click(screen.getByText("右转"));
    expect(ctx.rotate).toHaveBeenCalledWith(Math.PI / 2);
  });

  it("读不出来的图片：说清楚原因，只留关闭，不上传", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => { throw new Error("broken"); }));
    const { uploadAvatar } = renderPanel();
    pickFile("broken.png");

    expect(await screen.findByText(/没能读出来/)).toBeTruthy();
    expect(screen.queryByText("使用这张")).toBeNull();
    fireEvent.click(screen.getByText("关闭"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(uploadAvatar).not.toHaveBeenCalled();
  });
});
