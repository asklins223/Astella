/**
 * 设置页的两个小骨架：设置行与壳内状态句。
 *
 * ## 为什么从 `settings-surface.tsx` 拆出来（2026-09-29）
 *
 * 那个文件 3139 行，其中 `SettingsSurface` 单个函数 2603 行。这两个是里面**耦合最干净**的
 * 两块：一行文字加一个右格、一句话加一颗重试——纯 props，纯 JSX，不读任何页面级状态。
 *
 * 它们先搬出来有两个作用：
 *  1. 给 `settings-surface.tsx` 的拆分立一个可复制的样板（「一块壳 = 一个组件 + 显式 props」），
 *     后面按设置域（外观 / 账户 / 边界 / 复习）切时照着做；
 *  2. 它们是本项目**仅有的**两个 React 骨架级原语（`HudPage` 之外），所以「原语只做这几个」
 *     这件事在代码上开始有了形状——新页面要新增原语时，先在这里加，而不是各页面各造一个。
 *
 * ⚠️ 搬过来时**逐字保留了 JSX**：类名是 `settings-row--selected` / `settings-row__body`，
 * `SettingsInlineState` 用的是 `data-tone` 加 `role="alert" / "status"`（读屏要靠它，
 * 删了就是一处无障碍回退）。第一次拆的时候凭印象重写过一版，把这三样都改了——
 * 类名闭合守卫不会抓（那些类仍然有规则），但屏上会长出另一套行样式。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import type { ReactNode } from "react";

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
