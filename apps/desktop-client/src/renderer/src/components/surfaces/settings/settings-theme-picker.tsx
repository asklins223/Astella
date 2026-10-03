/** The selected theme expresses a preference; the time-driven theme can change without a new selection. */
import type { ReactElement } from "react";
import { Check, Moon, Sun } from "lucide-react";
import { THEME_PLATES } from "./settings-data-tables.ts";

export function themeLabel(theme: "day" | "night"): string {
  return theme === "day" ? "日间场景" : "夜间场景";
}

export function SettingsThemePicker(props: {
  readonly theme: "day" | "night";
  readonly setTheme: (value: "day" | "night") => void;
  readonly themeMode: "system" | "manual";
  readonly onFollowTime: () => void;
}): ReactElement {
  const { theme, setTheme, themeMode } = props;
  return (
<div className="settings-themes" role="group" aria-label="环境主题">
  <button type="button" className="settings-theme settings-theme--time" aria-pressed={themeMode === "system"} onClick={props.onFollowTime}>
    <span className="settings-theme__plate settings-theme__clock" aria-hidden="true"><Sun size={30} /><span /><Moon size={28} /></span>
    <span className="settings-theme__label">随时间变化</span>
    <small>白天、黄昏和夜晚跟着本地时间变化。</small>
    {themeMode === "system" ? <span className="settings-theme__check" aria-hidden="true"><Check size={13} strokeWidth={3} /></span> : null}
  </button>
  {(["day", "night"] as const).map((value) => {
    const active = themeMode === "manual" && theme === value;
    return (
      <button
        key={value}
        type="button"
        className="settings-theme"
        aria-pressed={active}
        onClick={() => setTheme(value)}
      >
        <span
          className="settings-theme__plate"
          style={{ backgroundImage: `url("${THEME_PLATES[value]}")` }}
          aria-hidden="true"
        />
        <span className="settings-theme__label">
          {value === "day" ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
          {themeLabel(value)}
        </span>
        {active ? (
          <span className="settings-theme__check" aria-hidden="true"><Check size={13} strokeWidth={3} /></span>
        ) : null}
      </button>
    );
  })}
</div>
  );
}
