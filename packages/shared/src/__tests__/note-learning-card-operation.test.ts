import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  gradeOperationAnswerV1,
  operationSpecV1Schema,
  renderOperationTemplateV1,
} from "../learning/note-learning-card-operation.ts";

const spec = operationSpecV1Schema.parse({
  title: "调出稳定的电流",
  prompt: "把两个参数调到目标值。",
  controls: [
    { id: "voltage", label: "电压", min: 0, max: 12, step: 1, initial: 0, unit: "V" },
    { id: "resistance", label: "电阻", min: 1, max: 10, step: 1, initial: 5, unit: "Ω" },
  ],
  target: { voltage: 6, resistance: 3 },
  tolerance: 0,
});

describe("note learning card operation questions", () => {
  it("grades control states on the host", () => {
    assert.equal(gradeOperationAnswerV1(spec, { kind: "controls", values: { voltage: 6, resistance: 3 } }).score, 100);
    assert.equal(gradeOperationAnswerV1(spec, { kind: "controls", values: { voltage: 6, resistance: 4 } }).score, 50);
    assert.equal(gradeOperationAnswerV1(spec, { kind: "controls", values: { voltage: 3, resistance: 3 } }).score, 50);
  });

  it("renders a trusted template without injecting model text as markup", () => {
    const html = renderOperationTemplateV1("parameter_experiment", spec);
    assert.ok(html.includes("data-control=\"voltage\""));
    assert.ok(html.includes("frame->host"));
    assert.ok(!html.includes("<script src="));
  });

  it("supports a second, keyboard-operable steps template without revealing its correct order", () => {
    const repair = operationSpecV1Schema.parse({ title: "修复流程", prompt: "按顺序选择步骤。", controls: [], target: {}, steps: ["先观察", "再验证", "最后总结"] });
    const html = renderOperationTemplateV1("repair_steps", repair);
    assert.ok(html.indexOf('data-step="最后总结"') < html.indexOf('data-step="先观察"'));
    assert.match(html, /aria-pressed="false"/);
    assert.match(html, /:focus-visible/);
    assert.equal(gradeOperationAnswerV1(repair, { kind: "steps", steps: repair.steps }).score, 100);
    assert.equal(gradeOperationAnswerV1(repair, { kind: "steps", steps: ["先观察", "最后总结", "再验证"] }).score, 33);
  });

  it("rejects missing or unreachable targets rather than awarding an impossible experiment", () => {
    assert.equal(operationSpecV1Schema.safeParse({ ...spec, target: {} }).success, false);
    assert.equal(operationSpecV1Schema.safeParse({ ...spec, target: { voltage: 99, resistance: 3 } }).success, false);
    assert.equal(operationSpecV1Schema.safeParse({ ...spec, controls: [], steps: [] }).success, false);
    assert.equal(gradeOperationAnswerV1(spec, { kind: "controls", values: { voltage: "6", resistance: "3" } }).score, 0);
  });
});

it("restores bounded saved controls only from the actual parent and emits no grading result", async () => {
  const { runInNewContext } = await import("node:vm");
  const listeners = new Map<string, (event: unknown) => void>();
  const inputs = spec.controls.map((control) => ({ dataset: { control: control.id }, min: String(control.min), max: String(control.max), value: String(control.initial), addEventListener: (_: string, listener: (event: unknown) => void) => listeners.set(control.id, listener) }));
  const outputs = new Map(spec.controls.map((control) => [control.id, { textContent: String(control.initial) }]));
  const sent: Array<{ phase: string; answer?: { values: Record<string, number> } }> = [];
  const parent = { postMessage: (message: typeof sent[number]) => sent.push(message) };
  let receive: (event: unknown) => void = () => {};
  const html = renderOperationTemplateV1("parameter_experiment", spec);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  runInNewContext(script, { parent, setInterval: () => 1, addEventListener: (_: string, listener: typeof receive) => { receive = listener; }, document: { querySelectorAll: (selector: string) => selector === "[data-control]" ? inputs : [], querySelector: (selector: string) => outputs.get(selector.match(/data-output="([^"]+)"/)?.[1] ?? "") } });
  const data = { channel: "astella:artifact-frame", direction: "host->frame", command: "restore-answer", answer: { kind: "controls", values: { voltage: 99, resistance: 3 } } };
  receive({ source: {}, data }); assert.equal(inputs[0]!.value, "0");
  receive({ source: parent, data }); assert.equal(inputs[0]!.value, "12"); assert.equal(inputs[1]!.value, "3");
  listeners.get("voltage")!({});
  assert.equal(sent.at(-1)!.phase, "answer"); assert.equal(sent.at(-1)!.answer!.values.voltage, 12);
  assert.ok(sent.every((message) => !("score" in message)));
});

it("steps expose the chosen order, support undo/reset, replay exactly and recover editable state", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { JSDOM } = require("jsdom");
  const repair = operationSpecV1Schema.parse({title:"步骤修复",prompt:"按顺序选择",controls:[],target:{},steps:["观察","验证","总结"]});
  const html = renderOperationTemplateV1("repair_steps",repair);
  const dom = new JSDOM(html,{runScripts:"outside-only"});
  const w = dom.window;
  try {
    w.eval(html.match(/<script>([\s\S]*?)<\/script>/)![1]!);
    const steps = [...w.document.querySelectorAll("[data-step]")] as any[];
    steps.find(button=>button.dataset.step==="验证").click();
    steps.find(button=>button.dataset.step==="观察").click();
    const order = () => [...w.document.querySelectorAll("#picked-order li")].map((item:any)=>item.textContent);
    assert.deepEqual(order(),["验证","观察"]);
    w.document.getElementById("undo-step").click(); assert.deepEqual(order(),["验证"]);
    const restore = (readOnly: boolean, values: string[]) => w.dispatchEvent(new w.MessageEvent("message",{source:w,data:{channel:"astella:artifact-frame",direction:"host->frame",command:"restore-answer",readOnly,answer:{kind:"steps",steps:values}}}));
    restore(true,["总结","观察","总结"]);
    assert.deepEqual(order(),["总结","观察"],"replay preserves chosen order while removing duplicate invalid states");
    assert.ok(steps.every(button=>button.disabled));
    steps[0].click(); assert.deepEqual(order(),["总结","观察"]);
    restore(false,["验证"]); assert.ok(steps.every(button=>!button.disabled));
    steps.find(button=>button.dataset.step==="观察").click(); assert.deepEqual(order(),["验证","观察"]);
    w.document.getElementById("reset-steps").click(); assert.deepEqual(order(),[]);
    assert.equal(w.document.getElementById("picked-empty").hidden,false);
  } finally { w.close(); }
});
