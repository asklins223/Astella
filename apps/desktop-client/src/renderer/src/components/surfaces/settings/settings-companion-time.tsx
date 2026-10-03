import { Clock3 } from "lucide-react";
import { HudPicker } from "../../hud/HudControls";

const HOURS = Array.from({ length: 24 }, (_, value) => { const text = String(value).padStart(2, "0"); return [text, text] as const; });
const MINUTES = Array.from({ length: 60 }, (_, value) => { const text = String(value).padStart(2, "0"); return [text, text] as const; });

/** Two drawn listboxes keep the time editable without opening an OS time widget. */
export function CompanionTimePicker(props: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const [hour, minute] = props.value.split(":");
  return <div className="settings-companion-time" role="group" aria-label={props.label}>
    <Clock3 size={16} aria-hidden="true" />
    <HudPicker label={`${props.label}小时`} value={hour} options={HOURS} disabled={props.disabled} align="start" variant="tag" onChange={next => props.onChange(`${next}:${minute}`)} />
    <span aria-hidden="true">:</span>
    <HudPicker label={`${props.label}分钟`} value={minute} options={MINUTES} disabled={props.disabled} align="start" variant="tag" onChange={next => props.onChange(`${hour}:${next}`)} />
  </div>;
}
