import { useCallback, useId, type ReactNode } from "react";
import { X } from "lucide-react";

export function HudBubbleHeader({ title, hint, icon, onClose }: {
  readonly title: string;
  readonly hint: string;
  readonly icon: ReactNode;
  readonly onClose?: () => void;
}) {
  return (
    <header className="hud-bubble-header">
      <span className="hud-bubble-header__icon" aria-hidden="true">{icon}</span>
      <div><h2>{title}</h2><p>{hint}</p></div>
      {onClose ? <button type="button" className="hud-bubble-close" aria-label={`关闭${title}`} onClick={onClose}>
        <X size={17} aria-hidden="true" />
      </button> : null}
    </header>
  );
}

/** Confirmation is an explicit choice inside the bubble, with a safe focus target. */
export function HudBubbleConfirmation({ title, children, confirmLabel, busy, onConfirm, onCancel }: {
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const titleId = useId();
  const focusCancel = useCallback((element: HTMLButtonElement | null) => { element?.focus(); }, []);
  return (
    <section className="hud-bubble-confirm" data-tactile-page="true" aria-labelledby={titleId} aria-busy={busy || undefined}>
      <h3 id={titleId}>{title}</h3>
      <p>{children}</p>
      <div className="hud-bubble-confirm__actions">
        <button type="button" className="hud-bubble-button" data-hud-cancel="true" disabled={busy}
          ref={focusCancel} onClick={onCancel}>取消</button>
        <button type="button" className="hud-bubble-button" data-tone="peach" disabled={busy} onClick={onConfirm}>
          {busy ? "正在处理…" : confirmLabel}
        </button>
      </div>
    </section>
  );
}
