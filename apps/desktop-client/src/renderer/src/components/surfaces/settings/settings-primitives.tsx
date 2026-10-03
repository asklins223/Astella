/** 设置行与局部状态，保留真实状态和可访问文案，由设置册样式统一摆位。 */
import type { ReactNode } from "react";

export type SettingsReadable = {
  readonly statusLine?: string;
  readonly notice?: string;
  readonly metrics?: readonly { readonly label: string; readonly value: string }[];
  readonly filters?: readonly { readonly label: string; readonly value: string }[];
  readonly items?: readonly { readonly label: string; readonly state?: string }[];
};

export function SettingRow({
  mark,
  title,
  detail,
  children,
  selected = false,
}: {
  /** The drawn glyph in front of the copy. Capability lists use it; rows that
   *  are pure label/value pairs leave it out and start at the card's edge. */
  readonly mark?: ReactNode;
  readonly title: ReactNode;
  readonly detail: ReactNode;
  /** The right-hand cell: a chip, a switch, a button, a value — or nothing, in
   *  which case the copy keeps the full width. */
  readonly children?: ReactNode;
  /** 这一行就是当前生效的选择。列表里五行长得一模一样时，"哪个在用"不该靠读小字。 */
  readonly selected?: boolean;
}) {
  return (
    <div className={selected ? "settings-row settings-row--selected" : "settings-row"}>
      {mark ? <span className="settings-row__mark" aria-hidden="true">{mark}</span> : null}
      <span className="settings-row__body">
        <b>{title}</b>
        <small>{detail}</small>
      </span>
      {children ? <span className="settings-row__control">{children}</span> : null}
    </div>
  );
}

export function SettingsInlineState({
  title,
  detail,
  tone = "neutral",
  onRetry,
}: {
  readonly title: string;
  readonly detail: string;
  readonly tone?: "neutral" | "error";
  readonly onRetry?: () => void;
}) {
  return (
    <div className="settings-inline-state" data-tone={tone} role={tone === "error" ? "alert" : "status"}>
      <span>
        <b>{title}</b>
        <small>{detail}</small>
      </span>
      {onRetry ? <button type="button" className="button" onClick={onRetry}>重试</button> : null}
    </div>
  );
}
