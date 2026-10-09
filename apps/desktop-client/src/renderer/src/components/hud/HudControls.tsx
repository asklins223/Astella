import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronDown } from "lucide-react";

/**
 * The settings centre's own controls.
 *
 * The mockup draws every one of these as a HUD object — a rocker switch, a
 * row of seals, a ledger line, a drawn slider — and none of them is a browser
 * widget. A native `<select>` or `<input type="checkbox">` would open the
 * operating system's own chrome on top of the paper, so each control is drawn
 * and driven here: the browser supplies focus, ARIA and keyboard semantics, the
 * stylesheet supplies the object.
 */

/* ── Switch ──────────────────────────────────────────────────────────────── */

/** The mockup's `.switch`: a rocker that keeps its own pressed state. */
export function HudSwitch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly disabled?: boolean;
}) {
  /**
   * The settle ring is driven by a real toggle, not by `aria-checked`. Keying it
   * off the checked state replays the "you just changed this" ring every time an
   * already-on switch mounts — entering 语音与伴星 with sound on looked like the
   * page had flipped the switch for the reader.
   */
  const [settleSeq, setSettleSeq] = useState(0);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? " on" : ""}`}
      onClick={() => {
        const next = !checked;
        onChange(next);
        if (next) setSettleSeq((value) => value + 1);
      }}
    >
      <i aria-hidden="true" />
      {/* Remounting on a new key is what replays the animation. */}
      {settleSeq > 0 ? <span key={settleSeq} className="switch__settle" aria-hidden="true" /> : null}
    </button>
  );
}

/* ── Segmented choice ────────────────────────────────────────────────────── */

export type SegmentedOption<T extends string> = readonly [value: T, label: string, icon?: ReactNode];

/**
 * Two to four mutually exclusive choices on one track. The selection is shown by
 * a plate that slides under the active label, so changing the value reads as one
 * object moving rather than two buttons swapping colour.
 */
export function HudSegmented<T extends string>({
  value,
  options,
  onChange,
  label,
  compact = false,
  disabled = false,
}: {
  readonly value: T;
  readonly options: ReadonlyArray<SegmentedOption<T>>;
  readonly onChange: (next: T) => void;
  readonly label: string;
  readonly compact?: boolean;
  /** A write that is already in flight: the plate stays where it is and every
   *  option is taken out of the tab order instead of accepting a click the
   *  handler would drop. */
  readonly disabled?: boolean;
}) {
  const index = Math.max(0, options.findIndex(([optionValue]) => optionValue === value));
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (next: number) => {
    const wrapped = (next + options.length) % options.length;
    onChange(options[wrapped][0]);
    buttonRefs.current[wrapped]?.focus();
  };

  return (
    <div
      className={`hud-segmented${compact ? " hud-segmented--compact" : ""}`}
      role="radiogroup"
      aria-label={label}
      style={{ "--hud-seg-index": index, "--hud-seg-count": options.length } as React.CSSProperties}
    >
      <span className="hud-segmented__plate" aria-hidden="true" />
      {options.map(([optionValue, optionLabel, icon], optionIndex) => {
        const active = optionValue === value;
        return (
          <button
            key={optionValue}
            ref={(element) => { buttonRefs.current[optionIndex] = element; }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-disabled={disabled || undefined}
            disabled={disabled}
            tabIndex={active ? 0 : -1}
            className={active ? "is-active" : undefined}
            onClick={() => onChange(optionValue)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(optionIndex + 1);
                return;
              }
              if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(optionIndex - 1);
                return;
              }
              if (event.key === "Home") {
                event.preventDefault();
                move(0);
                return;
              }
              if (event.key === "End") {
                event.preventDefault();
                move(options.length - 1);
              }
            }}
          >
            {icon}
            <span>{optionLabel}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Ledger picker ───────────────────────────────────────────────────────── */

export type PickerOption<T extends string> = readonly [value: T, label: string, detail?: string];

/**
 * The nearest ancestor that actually scrolls. A popover has to flip against the
 * box it is clipped by, which is not always the window: inside the settings card
 * the menu lives in `.settings-body`, whose `overflow: auto` cuts anything that
 * runs past its bottom edge.
 */
function nearestScrollContainer(element: HTMLElement | null): HTMLElement | null {
  let node = element?.parentElement ?? null;
  while (node) {
    const { overflowY } = window.getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

/** Long enough for the exit animation to finish before the menu unmounts. */
const PICKER_EXIT_MS = 130;

/**
 * The mockup's `.write-line` with its chevron, opened as a real list. The menu is
 * drawn on the paper instead of by the operating system, so it keeps the card's
 * radius, type and shadow, and it flips above the trigger when its own scroll
 * container runs out of room below.
 */
export function HudPicker<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
  align = "end",
  variant = "line",
}: {
  readonly value: T;
  readonly options: ReadonlyArray<PickerOption<T>>;
  readonly onChange: (next: T) => void;
  readonly label: string;
  readonly disabled?: boolean;
  readonly align?: "start" | "end";
  /** `line` is the mockup's ledger line; `tag` is its chip in a command row. */
  readonly variant?: "line" | "tag";
}) {
  const [open, setOpen] = useState(false);
  /** Kept mounted for one animation frame budget so the exit mirrors the entry. */
  const [closing, setClosing] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex(([optionValue]) => optionValue === value)));
  const [flipUp, setFlipUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const listId = useId();
  const current = options.find(([optionValue]) => optionValue === value);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setClosing(true);
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => setClosing(false), PICKER_EXIT_MS);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openMenu = () => {
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = undefined;
    setClosing(false);
    setOpen(true);
  };

  useEffect(() => () => {
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    setOpen(false);
    setClosing(false);
  }, []);

  useLayoutEffect(() => () => {
    const menu = menuRef.current;
    if (menu && typeof menu.hidePopover === "function" && menu.matches(":popover-open")) menu.hidePopover();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    setActive(Math.max(0, options.findIndex(([optionValue]) => optionValue === value)));
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    const onResize = () => close(true);
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) close(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
    // Re-seeding the highlight on open is the only reason `value` is read here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [close, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const element = menuRef.current;
    if (!element) return;
    // The browser top layer escapes scroll clipping while retaining the settings' DOM,
    // tokens and event path. The application draws all of the menu's chrome.
    if (typeof element.showPopover === "function" && !element.matches(":popover-open")) element.showPopover();
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    if (typeof element.showPopover === "function") {
      // The top layer resolves percentages against the viewport, so the CSS floor
      // `max(100%, …)` would stretch the list across the whole window — and since
      // `min-width` outranks `max-width`, the 320px cap below cannot save it.
      // Restate the same floor against the trigger, which is what it means in flow.
      const floor = Number.parseFloat(getComputedStyle(element).getPropertyValue("--hud-picker-menu-min")) || 0;
      element.style.position = "fixed";
      element.style.margin = "0";
      element.style.minWidth = `${Math.round(Math.max(floor, trigger.width))}px`;
      element.style.maxWidth = `${Math.min(320, window.innerWidth - 20)}px`;
      const size = element.getBoundingClientRect();
      const below = window.innerHeight - trigger.bottom - 10;
      const above = trigger.top - 10;
      const up = below < size.height + 6 && above > below;
      const height = Math.max(40, Math.min(232, up ? above : below));
      element.style.maxHeight = `${height}px`;
      const width = Math.min(size.width, window.innerWidth - 20);
      element.style.left = `${Math.max(10, Math.min(window.innerWidth - width - 10, align === "end" ? trigger.right - width : trigger.left))}px`;
      element.style.right = "auto";
      element.style.bottom = "auto";
      element.style.top = `${up ? Math.max(10, trigger.top - Math.min(size.height, height) - 6) : trigger.bottom + 6}px`;
      setFlipUp(up);
      element.focus({ preventScroll: true });
      return;
    }
    // Flip against the box that would clip the menu, not against the window.
    const menu = element.getBoundingClientRect();
    const container = nearestScrollContainer(rootRef.current)?.getBoundingClientRect();
    const bounds = container ?? { top: 0, bottom: window.innerHeight };
    const spaceBelow = bounds.bottom - trigger.bottom;
    const spaceAbove = trigger.top - bounds.top;
    setFlipUp(spaceBelow < menu.height + 8 && spaceAbove > spaceBelow);
    // The list owns the keyboard while it is open, so focus moves into it and
    // returns to the trigger on every close path.
    menuRef.current?.focus({ preventScroll: true });
  }, [align, open]);

  useLayoutEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>(`[id="${listId}-${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId, open]);

  const commit = (next: T) => {
    if (!open) return;
    onChange(next);
    close(true);
  };

  const menuMounted = open || closing;

  return (
    <div ref={rootRef} className="hud-picker" data-open={open ? "true" : undefined} data-align={align}>
      <button
        ref={triggerRef}
        type="button"
        className={variant === "tag" ? "tag hud-picker__trigger hud-picker__trigger--tag" : "write-line hud-picker__trigger"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${label}：${current?.[1] ?? "—"}`}
        disabled={disabled}
        onClick={() => {
          if (open) close(true);
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) { openMenu(); return; }
            setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
          }
        }}
      >
        <span className="hud-picker__value">{current?.[1] ?? "—"}</span>
        <ChevronDown className="hud-picker__chevron" size={variant === "tag" ? 11 : 13} aria-hidden="true" />
      </button>

      {menuMounted ? (
        <ul
          ref={menuRef}
          id={listId}
          popover="manual"
          role="listbox"
          aria-label={label}
          aria-activedescendant={`${listId}-${active}`}
          aria-hidden={!open || undefined}
          inert={!open}
          tabIndex={-1}
          data-closing={open ? undefined : "true"}
          className={`hud-picker__menu${flipUp ? " hud-picker__menu--up" : ""}`}
          onKeyDown={(event) => {
            if (!open) return;
            if (event.key === "Tab") { close(true); return; }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
              return;
            }
            if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              setActive(event.key === "Home" ? 0 : options.length - 1);
              return;
            }
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              commit(options[active][0]);
            }
          }}
        >
          {options.map(([optionValue, optionLabel, optionDetail], optionIndex) => {
            const selected = optionValue === value;
            return (
              <li
                key={optionValue}
                id={`${listId}-${optionIndex}`}
                role="option"
                aria-selected={selected}
                className={`hud-picker__option${selected ? " is-selected" : ""}${optionIndex === active ? " is-active" : ""}`}
                onPointerEnter={() => setActive(optionIndex)}
                onClick={() => commit(optionValue)}
              >
                <span>
                  <b>{optionLabel}</b>
                  {optionDetail ? <small>{optionDetail}</small> : null}
                </span>
                {selected ? <Check size={14} aria-hidden="true" /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/* ── Drawn slider ────────────────────────────────────────────────────────── */

/**
 * A value on a range, drawn as a groove with a seal on it. Pointer capture keeps
 * the drag attached to the track, and every arrow key moves it by one step so
 * the control is usable without a pointer.
 *
 * The fill is driven by `scale` rather than `width`, so the part that reads as
 * progress never writes layout while dragging. The seal itself still steps by
 * `left`: positioning it with `translate` would need the track measured on every
 * resize, which is more machinery than a 26px control is worth.
 */
export function HudSlider({
  value,
  min,
  max,
  step,
  onChange,
  label,
  format,
  hint,
}: {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly onChange: (next: number) => void;
  readonly label: string;
  readonly format: (value: number) => string;
  readonly hint?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const ratio = (value - min) / (max - min);
  const percent = `${Math.round(ratio * 1000) / 10}%`;

  const snap = useCallback((raw: number) => {
    const stepped = Math.round((raw - min) / step) * step + min;
    return Math.min(max, Math.max(min, Math.round(stepped * 1000) / 1000));
  }, [max, min, step]);

  const fromPointer = useCallback((clientX: number) => {
    const box = trackRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    onChange(snap(min + ((clientX - box.left) / box.width) * (max - min)));
  }, [max, min, onChange, snap]);

  return (
    <div className="hud-slider">
      <div
        ref={trackRef}
        className="hud-slider__track"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format(value)}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          fromPointer(event.clientX);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          fromPointer(event.clientX);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onKeyDown={(event) => {
          const big = step * 5;
          if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); onChange(snap(value + step)); return; }
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); onChange(snap(value - step)); return; }
          if (event.key === "PageUp") { event.preventDefault(); onChange(snap(value + big)); return; }
          if (event.key === "PageDown") { event.preventDefault(); onChange(snap(value - big)); return; }
          if (event.key === "Home") { event.preventDefault(); onChange(min); return; }
          if (event.key === "End") { event.preventDefault(); onChange(max); }
        }}
      >
        <span className="hud-slider__groove" aria-hidden="true" />
        <span
          className="hud-slider__fill"
          style={{ "--hud-slider-ratio": ratio } as React.CSSProperties}
          aria-hidden="true"
        />
        <span
          className="hud-slider__thumb"
          style={{ left: percent }}
          aria-hidden="true"
        />
      </div>
      <div className="hud-slider__readout">
        <b>{format(value)}</b>
        {hint ? <span>{hint}</span> : null}
      </div>
    </div>
  );
}
