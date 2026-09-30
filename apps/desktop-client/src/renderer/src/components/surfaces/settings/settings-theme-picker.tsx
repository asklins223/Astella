/**
 * 「环境主题」那两颗：日 / 夜。每颗画一小块母本里那张木纹底板。
 *
 * ## 为什么从 `settings-surface.tsx` 拆出来（2026-09-29）
 *
 * 27 行、只有 `theme` / `setTheme` 两个外部符号——是那份文件里最干净的一块。
 * `THEME_PLATES` 搬进了 `settings-data-tables.ts`，这里直接 import。
 *
 * ⚠️ 两处不能动：`aria-pressed={active}`（色弱与读屏要靠它知道选了哪颗）与那颗
 * `style={{ backgroundImage }}` 的**运行期取值**（图是哪两张随房间配置变的，不是常量）。
 * 这也是本项目少数几处允许内联 style 的地方之一。
 */
import type { ReactElement } from "react";
import { Check, Moon, Sun } from "lucide-react";
import { THEME_PLATES } from "./settings-data-tables.ts";

export function themeLabel(theme: "day" | "night"): string {
  return theme === "day" ? "日间场景" : "夜间场景";
}

export function SettingsThemePicker(props: {
  readonly theme: "day" | "night";
  readonly setTheme: (value: "day" | "night") => void;
}): ReactElement {
  const { theme, setTheme } = props;
  return (
<div className="settings-themes" role="group" aria-label="环境主题">
  {(["day", "night"] as const).map((value) => {
    const active = theme === value;
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
