// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AVATAR_MAX_BYTES } from "@astella/shared/desktop-ipc-contracts";
import { SettingsAccountPanel } from "../settings-account-panel";
vi.mock("../avatar-crop-dialog", () => ({ AvatarCropDialog: ({ file }: { file: File }) => <div role="dialog" aria-label="头像取景">{file.name}</div> }));
afterEach(cleanup);
function open() {
  return render(<SettingsAccountPanel profile={{ version: 1, displayName: "我", avatarUrl: null }} displayName="我" busy={null}
    onDisplayNameChange={vi.fn()} onSaveDisplayName={vi.fn(async () => undefined)} onClearAvatar={vi.fn(async () => undefined)}
    onUploadAvatar={vi.fn(async () => ({ ok: true as const }))} />);
}
function choose(size: number) {
  const file = new File(["image"], "avatar.png", { type: "image/png" });
  Object.defineProperty(file, "size", { value: size });
  fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
}
it("3 MB 和恰好 10 MB 的原图进入取景框", () => {
  open(); choose(3 * 1024 * 1024);
  expect(screen.getByRole("dialog", { name: "头像取景" })).toBeTruthy();
  cleanup(); open(); choose(AVATAR_MAX_BYTES);
  expect(screen.getByRole("dialog", { name: "头像取景" })).toBeTruthy();
});
it("超过 10 MB 在解码和上传前提示，重新选择合规图片清除提示", () => {
  open(); choose(AVATAR_MAX_BYTES + 1);
  expect(screen.getByRole("alert").textContent).toContain("超过 10 MB");
  expect(screen.queryByRole("dialog")).toBeNull();
  choose(AVATAR_MAX_BYTES);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("dialog", { name: "头像取景" })).toBeTruthy();
});
