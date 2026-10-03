// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopNoteVersionItem } from "@ailearn/shared/desktop-surface-contracts";
import { VersionHistory } from "../version-history";

afterEach(cleanup);

const versions = (current: string): DesktopNoteVersionItem[] => [1, 2].map((versionNo) => ({
  versionId: `v${versionNo}`, versionNo, current: current === `v${versionNo}`,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
}));
const props = {
  versions: versions("v2"), loading: false, failure: null, restoringVersionId: null,
  editable: true, dirty: false, formatRelative: () => "刚刚", onReload: vi.fn(), onRestore: vi.fn(),
};

it("恢复按钮替换成当前标记后，焦点落在已恢复版本的回执", () => {
  const { rerender } = render(<VersionHistory {...props} />);
  const restore = screen.getByRole("button", { name: "恢复这一版" });
  restore.focus();
  fireEvent.click(restore);
  rerender(<VersionHistory {...props} loading restoringVersionId="v1" />);
  expect(document.activeElement).toBe(document.body);
  rerender(<VersionHistory {...props} versions={versions("v1")} />);
  expect(document.activeElement).toBe(screen.getByRole("listitem", { name: "v1，当前版本" }));
});

it("恢复期间移到笔记别处的焦点不会被迟到回执拉回", () => {
  const { rerender } = render(<><button>别处</button><VersionHistory {...props} /></>);
  const restore = screen.getByRole("button", { name: "恢复这一版" });
  restore.focus();
  fireEvent.click(restore);
  rerender(<><button>别处</button><VersionHistory {...props} loading restoringVersionId="v1" /></>);
  screen.getByRole("button", { name: "别处" }).focus();
  rerender(<><button>别处</button><VersionHistory {...props} versions={versions("v1")} /></>);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "别处" }));
});
