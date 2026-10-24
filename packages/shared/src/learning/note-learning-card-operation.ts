import { z } from "zod";

/** Must match `apps/desktop-client/src/shared/artifact-frame.ts` (single wire string). */
const ARTIFACT_FRAME_CHANNEL = "astella:artifact-frame";

export const operationTemplateSchemaV1 = z.enum(["parameter_experiment", "repair_steps"]);
export type OperationTemplateV1 = z.infer<typeof operationTemplateSchemaV1>;

/** The model only supplies content + the target state; the HTML is ours. */
export const operationSpecV1Schema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(800),
  controls: z.array(z.strictObject({
    id: z.string().trim().min(1).max(40),
    label: z.string().trim().min(1).max(120),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive(),
    initial: z.number().finite(),
    unit: z.string().trim().max(20).optional(),
  })).max(3),
  target: z.record(z.string().min(1), z.number().finite()),
  tolerance: z.number().finite().min(0).default(0),
  steps: z.array(z.string().trim().min(1).max(400)).max(8).optional(),
}).superRefine((spec, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (spec.controls.length === 0) {
    if (!spec.steps || spec.steps.length < 2 || new Set(spec.steps).size !== spec.steps.length || Object.keys(spec.target).length) fail("步骤修复需要至少两个不同步骤，且不能混入参数目标");
    return;
  }
  const ids = spec.controls.map((control) => control.id);
  if (new Set(ids).size !== ids.length || Object.keys(spec.target).length !== ids.length || spec.steps?.length) fail("参数实验的目标必须逐一对应不同的控件");
  for (const control of spec.controls) {
    const target = spec.target[control.id];
    if (control.min >= control.max || control.initial < control.min || control.initial > control.max || target === undefined || target < control.min || target > control.max
      || Math.abs((target - control.min) / control.step - Math.round((target - control.min) / control.step)) > 1e-7) fail("参数实验的初始值和目标必须能由控件达到");
  }
});
export type OperationSpecV1 = z.infer<typeof operationSpecV1Schema>;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/**
 * Trusted template renderer. No model text is inserted as markup: every string is
 * escaped, and the only script is the fixed answer emitter below.
 */
export function renderOperationTemplateV1(template: OperationTemplateV1, spec: OperationSpecV1): string {
  const controls = spec.controls.map((control) => `
    <label class="op-control">
      <span>${escapeHtml(control.label)}</span>
      <input type="range" data-control="${escapeHtml(control.id)}" min="${control.min}" max="${control.max}" step="${control.step}" value="${control.initial}" />
      <output data-output="${escapeHtml(control.id)}" data-unit="${escapeHtml(control.unit ?? "")}">${control.initial}${escapeHtml(control.unit ?? "")}</output>
    </label>`).join("");
  const steps = template === "repair_steps" && spec.steps
    ? `<p>按正确顺序选择步骤；再次按下可撤回。下方会保留你的选择顺序。</p><div class="op-sequence" aria-live="polite"><strong>已选顺序</strong><ol id="picked-order"></ol><p id="picked-empty">还未选择步骤。</p><button type="button" id="undo-step">撤回上一步</button> <button type="button" id="reset-steps">重新开始</button></div><ol class="op-steps">${[...spec.steps].reverse().map((step) => `<li><button type="button" aria-pressed="false" data-step="${escapeHtml(step)}">${escapeHtml(step)}</button></li>`).join("")}</ol>`
    : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root { color-scheme: light dark; --op-ink:#25354f; --op-muted:#60708b; --op-paper:#f8fbff; --op-surface:#ffffff; --op-edge:#d8e4f4; --op-accent:#285fe8; --op-selected:#e6f1ff; --op-font:16px; }
  @media (prefers-color-scheme: dark) { :root { --op-ink:#e5efff; --op-muted:#a2b3cc; --op-paper:#142238; --op-surface:#1c2d47; --op-edge:#384c6b; --op-accent:#9ac5ff; --op-selected:#27466d; } }
  body { margin:0; padding:16px; font:var(--op-font)/1.65 ui-rounded,system-ui,sans-serif; color:var(--op-ink); background:var(--op-paper); overflow-wrap:anywhere; }
  h1 { font-size:1.25em; margin:0 0 6px; }
  p { margin:0 0 14px; color:var(--op-muted); }
  .op-control { display:grid; gap:6px; margin:0 0 14px; }
  input[type=range] { width:100%; accent-color:var(--op-accent); min-height:44px; }
  output { font-variant-numeric: tabular-nums; color:var(--op-accent); }
  .op-steps { display:grid; gap:8px; padding:0; list-style:none; }
  .op-steps button { width:100%; padding:10px 12px; border:1px solid var(--op-edge); border-radius:12px; background:var(--op-surface); color:var(--op-ink); min-height:44px; text-align:left; font:inherit; }
  .op-steps button[aria-pressed=true] { border-color:var(--op-accent); background:var(--op-selected); }
  .op-sequence { padding:12px; border:1px solid var(--op-edge); border-radius:12px; }
  .op-sequence button { min-height:44px; padding:8px 12px; color:var(--op-ink); background:var(--op-surface); border:1px solid var(--op-edge); border-radius:10px; font:inherit; }
  button:disabled { opacity:.55; }
  @media (prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important; transition:none!important; scroll-behavior:auto!important; } }
  :focus-visible { outline:3px solid var(--op-accent); outline-offset:3px; }
</style></head><body>
<h1>${escapeHtml(spec.title)}</h1>
<p>${escapeHtml(spec.prompt)}</p>
${steps}
${controls}
<script>
  const channel = ${JSON.stringify(ARTIFACT_FRAME_CHANNEL)};
  const contentHeight = () => Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
  const send = (phase, extra = {}) => parent.postMessage({ channel, direction: "frame->host", phase, contentHeight: contentHeight(), ...extra }, "*");
  let readOnly = false;
  const controls = [...document.querySelectorAll("[data-control]")];
  const update = () => {
    if (readOnly) return;
    const values = {};
    for (const input of controls) {
      values[input.dataset.control] = Number(input.value);
      const output = document.querySelector('[data-output="' + input.dataset.control + '"]');
      if (output) output.textContent = input.value + (output.dataset?.unit || "");
    }
    send("answer", { answer: { kind: "controls", values } });
  };
  for (const input of controls) input.addEventListener("input", update);
  const picked = [];
  const renderPicked = () => {
    const list = document.getElementById?.("picked-order");
    if (list) { list.replaceChildren(...picked.map(step => { const item = document.createElement("li"); item.textContent = step; return item; })); }
    const empty = document.getElementById?.("picked-empty");
    if (empty) empty.hidden = picked.length > 0;
    for (const button of document.querySelectorAll("[data-step]")) button.setAttribute("aria-pressed", String(picked.includes(button.dataset.step)));
    for (const id of ["undo-step", "reset-steps"]) { const button = document.getElementById?.(id); if (button) button.disabled = readOnly || picked.length === 0; }
  };
  const emitSteps = () => { renderPicked(); send("answer", { answer: { kind: "steps", steps: [...picked] } }); };
  document.getElementById?.("undo-step")?.addEventListener("click", () => { if (!readOnly) { picked.pop(); emitSteps(); } });
  document.getElementById?.("reset-steps")?.addEventListener("click", () => { if (!readOnly) { picked.length = 0; emitSteps(); } });
  for (const button of document.querySelectorAll("[data-step]")) button.addEventListener("click", () => {
    if (readOnly) return;
    const index = picked.indexOf(button.dataset.step);
    if (index >= 0) picked.splice(index, 1); else picked.push(button.dataset.step);
    emitSteps();
  });
  addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== parent || !message || message.channel !== channel || message.direction !== "host->frame" || message.command !== "restore-answer") return;
    readOnly = message.readOnly === true;
    for (const control of document.querySelectorAll("input,button")) control.disabled = readOnly;
    renderPicked();
    const answer = message.answer;
    if (!answer || typeof answer !== "object") return;
    if (answer.kind === "controls" && answer.values && typeof answer.values === "object") {
      for (const input of controls) {
        const value = answer.values[input.dataset.control];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        input.value = String(Math.max(Number(input.min), Math.min(Number(input.max), value)));
        const output = document.querySelector('[data-output="' + input.dataset.control + '"]');
        if (output) output.textContent = input.value + (output.dataset?.unit || "");
      }
    }
    if (answer.kind === "steps" && Array.isArray(answer.steps)) {
      picked.length = 0;
      for (const step of answer.steps) if (typeof step === "string" && !picked.includes(step) && [...document.querySelectorAll("[data-step]")].some(button => button.dataset.step === step)) picked.push(step);
      renderPicked();
    }
  });
  renderPicked();
  if (typeof ResizeObserver !== "undefined" && document.body) new ResizeObserver(() => send("heartbeat")).observe(document.body);
  send("ready", { stepCount: controls.length });
  setInterval(() => { if (!document.hidden) send("heartbeat"); }, 1000);
</script></body></html>`;
}

/** Host-side grading: the template cannot self-report a score. */
export function gradeOperationAnswerV1(spec: OperationSpecV1, answer: unknown): { score: number; detail: string } {
  if (!answer || typeof answer !== "object") return { score: 0, detail: "没有收到操作结果。" };
  const value = answer as { kind?: unknown; values?: unknown; steps?: unknown };
  if (value.kind === "controls" && value.values && typeof value.values === "object") {
    const values = value.values as Record<string, unknown>;
    const ids = Object.keys(spec.target);
    const hits = ids.filter((id) => {
      const actual = values[id];
      return typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - spec.target[id]!) <= spec.tolerance;
    }).length;
    const score = Math.round((hits / Math.max(1, ids.length)) * 100);
    return { score, detail: `命中 ${hits}/${ids.length} 个目标值。` };
  }
  if (value.kind === "steps" && Array.isArray(value.steps) && spec.steps) {
    const actual = value.steps.filter((step): step is string => typeof step === "string");
    if (actual.length !== value.steps.length || new Set(actual).size !== actual.length || actual.some((step) => !spec.steps!.includes(step))) return { score: 0, detail: "操作结果包含无效步骤。" };
    const hits = spec.steps.filter((step, index) => actual[index] === step).length;
    const score = Math.round((hits / Math.max(1, spec.steps.length)) * 100);
    return { score, detail: `步骤顺序命中 ${hits}/${spec.steps.length}。` };
  }
  return { score: 0, detail: "操作结果格式无法判分。" };
}
