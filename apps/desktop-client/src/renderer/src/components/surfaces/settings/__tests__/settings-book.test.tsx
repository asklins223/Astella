// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsBook, type SettingsSectionId } from "../settings-book";

afterEach(cleanup);
const renderBook = (section: SettingsSectionId, onSectionChange = vi.fn()) => <SettingsBook
  section={section} onSectionChange={onSectionChange} title="当前设置" loading={false} failure={null}
  onRetry={() => {}} notice={null} failureNotice={null} onDismissNotice={() => {}} footerNote="改动即时生效。"
><p>很长的真实设置内容</p></SettingsBook>;

it("每个分类保留自己的阅读位置，键盘切换和焦点不等待动画", () => {
  const onChange = vi.fn();
  const { container, rerender } = render(renderBook("account", onChange));
  const body = container.querySelector<HTMLElement>(".settings-body")!;
  body.scrollTop = 163; fireEvent.scroll(body);
  fireEvent.keyDown(screen.getByRole("button", { name: "账户与空间" }), { key: "ArrowRight" });
  expect(onChange).toHaveBeenCalledWith("members");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "成员与邀请" }));
  rerender(renderBook("appearance", onChange));
  expect(body.scrollTop).toBe(0);
  body.scrollTop = 48; fireEvent.scroll(body);
  rerender(renderBook("account", onChange));
  expect(body.scrollTop).toBe(163);
});
