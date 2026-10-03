import { useLayoutEffect, useRef, type RefObject } from "react";
import { HudSpaceMenu } from "./HudSpaceMenu";
import { HudAccountCard } from "./HudAccountCard";
import { useHudPopoverMotion, type HudMenuKind } from "./use-hud-popover-motion";

export function HudControlPopover({ kind, rootRef, spaceRef, accountRef, id, notice, onClose, onOpenAccount, onSwitched }: {
  readonly kind: HudMenuKind | null;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly spaceRef: RefObject<HTMLButtonElement | null>;
  readonly accountRef: RefObject<HTMLButtonElement | null>;
  readonly id: string;
  readonly notice: string | null;
  readonly onClose: () => void;
  readonly onOpenAccount: () => void;
  readonly onSwitched: (name: string) => void;
}) {
  const lastKind = useRef(kind);
  if (kind) lastKind.current = kind;
  const { shown, mode } = useHudPopoverMotion(kind, rootRef, lastKind.current === "space" ? spaceRef : accountRef);
  useLayoutEffect(() => {
    if (kind) rootRef.current?.querySelector<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
  }, [kind, rootRef]);
  if (!shown) return null;
  return (
    <div ref={rootRef} id={id} className={`hud-control-popover ${kind ? "room-control-menu" : "hud-control-popover-exit"}`}
      data-kind={shown} data-motion={mode} inert={!kind || undefined} aria-hidden={!kind || undefined}>
      {shown === "space"
        ? <HudSpaceMenu notice={notice} onClose={onClose} onSwitched={onSwitched} onManage={onOpenAccount} />
        : <HudAccountCard onOpenAccount={onOpenAccount} onClose={onClose} />}
    </div>
  );
}
