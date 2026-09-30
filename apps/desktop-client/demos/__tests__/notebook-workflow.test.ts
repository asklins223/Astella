// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(new URL("../notebook-workflow.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../notebook-workflow.js", import.meta.url), "utf8");
const icons = readFileSync(new URL("../notebook-icons.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../notebook-workflow.css", import.meta.url), "utf8");
const windows: JSDOM[] = [];

function setup(width = 1440, reduced = false, stored?: string) {
  const dom = new JSDOM(html, { url: "https://notebook-demo.local/", runScripts: "outside-only", pretendToBeVisual: true });
  windows.push(dom);
  const w = dom.window;
  Object.defineProperty(w, "innerWidth", { value: width, writable: true });
  Object.defineProperty(w, "innerHeight", { value: width === 720 ? 405 : 810, writable: true });
  Object.assign(w, {
    structuredClone, Date, setTimeout, clearTimeout,
    matchMedia: (query: string) => ({ matches: query.includes("reduced-motion") ? reduced : true, addEventListener() {} }),
    confirm: vi.fn(() => true)
  });
  w.HTMLElement.prototype.scrollIntoView = vi.fn();
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  if (stored) w.localStorage.setItem("study.notebook-folio-demo.v4", stored);
  w.eval(icons);
  w.eval(script);
  const document = w.document;
  const click = (selector: string) => {
    const target = document.querySelector<HTMLButtonElement>(selector);
    expect(target, selector).toBeTruthy();
    target!.click();
  };
  const act = (name: string) => click('[data-action="' + name + '"]');
  const change = (selector: string, value: string | boolean) => {
    const target = document.querySelector<HTMLInputElement>(selector)!;
    expect(target).toBeTruthy();
    if (typeof value === "boolean") target.checked = value; else target.value = value;
    target.dispatchEvent(new w.Event("change", { bubbles: true }));
  };
  const input = (selector: string, value: string, rich = false) => {
    const target = document.querySelector<HTMLInputElement>(selector)!;
    expect(target).toBeTruthy();
    if (rich) target.innerHTML = value; else target.value = value;
    target.dispatchEvent(new w.Event("input", { bubbles: true }));
  };
  const demo = (w as unknown as { NotebookDemo: { state: any; view: string; detail: any; safeHTML: (html: string) => string } }).NotebookDemo;
  return { dom, w, document, demo, click, act, change, input };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T03:00:00Z")); });
afterEach(() => { windows.splice(0).forEach((dom) => dom.window.close()); vi.clearAllTimers(); vi.useRealTimers(); });

describe("学习册 Demo", () => {
  it("默认只读正文；批注合起；学习入口在滚区之前", () => {
    const { document, demo } = setup();
    expect(demo.view).toBe("reader");
    expect(document.querySelectorAll("[data-annotation]")).toHaveLength(2);
    expect((document.getElementById("side-leaf") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("action-tray") as HTMLElement).hidden).toBe(true);
    expect(document.querySelector(".learning-ribbons")?.compareDocumentPosition(document.getElementById("leaf-scroll")!) & 4).toBeTruthy();
    expect(document.querySelectorAll(".learning-ribbons button")).toHaveLength(3);
    expect(document.querySelector(".companion-character img")?.getAttribute("src")).toBe("companion-cutout.png");
  });
  it("纸面高度链可收缩；长内容留在正文、目录和旁页各自的滚区", () => {
    const { document } = setup();
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const rules = [...style.sheet!.cssRules] as CSSStyleRule[];
    const property = (selector: string, name: string) => {
      const rule = rules.find((candidate) => candidate.selectorText === selector);
      expect(rule, selector).toBeTruthy();
      return rule!.style.getPropertyValue(name).replace(/\s+/g, "");
    };
    expect(property(".desk", "grid-template-rows")).toBe("minmax(0,1fr)");
    expect(property(".folio-layout", "grid-template-rows")).toBe("minmax(0,1fr)");
    for (const selector of [".desk", ".folio", ".folio-cover", ".folio-layout", ".leaf", ".index-leaf", ".side-leaf"]) {
      expect(property(selector, "min-height")).toBe("0");
    }
    for (const selector of [".leaf-scroll", ".toc", ".side-scroll"]) {
      expect(property(selector, "overflow")).toBe("auto");
      expect(property(selector, "min-height")).toBe("0");
      expect(property(selector, "flex")).toBe("1");
    }
    for (const selector of [".leaf-head", ".index-head", ".index-foot", ".side-head", ".action-tray"]) {
      expect(property(selector, "flex")).toBe("none");
    }
  });
  it("回想、线索和原文对照沿用正文的册页高度规则", () => {
    const { w, document, act } = setup();
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const folio = document.getElementById("folio")!;
    const readerHeight = w.getComputedStyle(folio).height;
    expect(readerHeight).toBe("100%");
    act("recall");
    expect(document.querySelector(".recall-question")).toBeTruthy();
    expect(w.getComputedStyle(folio).height).toBe(readerHeight);
    act("hint");
    expect(document.querySelector(".hint")).toBeTruthy();
    expect(w.getComputedStyle(folio).height).toBe(readerHeight);
    act("reveal");
    expect(document.getElementById("answer-fold")).toBeTruthy();
    expect(w.getComputedStyle(folio).height).toBe(readerHeight);
  });
  it("悬停仅短预览，点击在旁侧展开，关闭恢复原句与阅读位置", () => {
    const { w, document, click, act } = setup();
    const anchor = document.querySelector<HTMLElement>('[data-annotation="a1"]')!;
    anchor.dispatchEvent(new w.MouseEvent("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(181);
    expect((document.getElementById("annotation-preview") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("annotation-preview")?.textContent).toContain("声音身份");
    expect((document.getElementById("side-leaf") as HTMLElement).hidden).toBe(true);
    document.getElementById("leaf-scroll")!.scrollTop = 170;
    click('[data-annotation="a1"]');
    expect((document.getElementById("side-leaf") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("side-leaf") as HTMLElement).inert).toBe(false);
    expect(document.getElementById("side-body")?.textContent).toContain("同一个声音跨越语言");
    act("close-side");
    expect((document.getElementById("side-leaf") as HTMLElement).hidden).toBe(true);
    expect(document.activeElement).toBe(anchor);
    expect(document.getElementById("leaf-scroll")!.scrollTop).toBe(170);
  });
  it("再次点原句收起；再次进入不会自动展开所有批注", () => {
    const { click, document, act } = setup();
    click('[data-annotation="a2"]');
    expect((document.getElementById("side-leaf") as HTMLElement).hidden).toBe(false);
    click('[data-annotation="a2"]');
    expect((document.getElementById("side-leaf") as HTMLElement).hidden).toBe(true);
    act("overview"); act("reader");
    expect(document.querySelectorAll('[data-annotation][aria-expanded="true"]')).toHaveLength(0);
    expect(document.querySelectorAll("[data-annotation]")).toHaveLength(2);
  });
  it("同一位置只开一种旁页，固定目录关闭旁页后恢复", () => {
    const { act, document, demo } = setup();
    act("sources");
    expect(document.getElementById("folio")?.dataset.toc).toBe("false");
    act("history");
    expect(demo.detail.type).toBe("history");
    expect(document.getElementById("side-title")?.textContent).toBe("学习记录");
    act("close-side");
    expect(document.getElementById("folio")?.dataset.toc).toBe("true");
    act("pin-toc");
    expect(demo.state.tocPinned).toBe(false);
    act("close-toc");
    expect(document.getElementById("folio")?.dataset.toc).toBe("false");
    act("toc");
    expect(document.getElementById("folio")?.dataset.toc).toBe("true");
  });
  it("正文位置经过速看再返回仍保留", () => {
    const { act, document } = setup();
    document.getElementById("leaf-scroll")!.scrollTop = 230;
    act("overview"); act("reader");
    expect(document.getElementById("leaf-scroll")!.scrollTop).toBe(230);
  });
  it("学习页由真实标题起头，版本和草稿依据留在标题之后", () => {
    const { act, click, document } = setup();
    for (const view of ["overview", "recall"]) {
      act(view);
      const title = document.querySelector("#page-content .page-title")!;
      const meta = document.querySelector("#page-content .note-meta")!;
      expect(document.getElementById("page-content")!.firstElementChild).toBe(title);
      expect(meta.textContent).toContain("笔记 v3");
      expect(title.compareDocumentPosition(meta) & 4).toBeTruthy();
    }
    act("expansion"); click('[data-action="open-draft"][data-id="d1"]');
    const title = document.querySelector("#page-content .page-title")!;
    const origin = document.querySelector("#page-content .draft-origin")!;
    expect(origin.textContent).toContain("笔记 v3");
    expect(title.compareDocumentPosition(origin) & 4).toBeTruthy();
    expect(document.querySelector("#page-content .page-kicker")).toBeNull();
  });
  it("选区能直接写自己的批注，不必经过模型或聊天", () => {
    const { w, document, act, demo } = setup();
    const paragraph = document.querySelector('[data-block="language-body"]')!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!,0); range.setEnd(paragraph.firstChild!,11);
    w.getSelection()!.addRange(range);
    paragraph.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true }));
    expect((document.getElementById("selection-tools") as HTMLElement).hidden).toBe(false);
    act("annotate-selection");
    const writer = document.getElementById("annotation-writing") as HTMLTextAreaElement;
    expect(writer).toBeTruthy(); writer.value = "这句我准备之后再查。";
    act("save-annotation");
    expect(demo.state.annotations.at(-1).personal).toBe(true);
    expect(demo.state.annotations.at(-1).text).toBe("这句我准备之后再查。");
    expect(document.querySelectorAll("[data-annotation]")).toHaveLength(3);
    expect(Object.keys(demo.state.jobs)).toHaveLength(0);
  });
  it("解释生成期间输入的批注保持文字、焦点和选区，关闭后可接回", () => {
    const { w, document, act, input, click, demo } = setup();
    const paragraph = document.querySelector('[data-block="language-body"]')!;
    const range = document.createRange(); range.setStart(paragraph.firstChild!,0); range.setEnd(paragraph.firstChild!,11);
    w.getSelection()!.addRange(range); paragraph.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true }));
    act("explain-selection"); act("write-annotation"); input("#annotation-writing","尚未保存的想法");
    const writer = document.getElementById("annotation-writing") as HTMLTextAreaElement;
    writer.focus(); writer.setSelectionRange(2,5);
    vi.advanceTimersByTime(1801);
    expect((document.getElementById("annotation-writing") as HTMLTextAreaElement).value).toBe("尚未保存的想法");
    expect(document.activeElement?.id).toBe("annotation-writing");
    expect((document.activeElement as HTMLTextAreaElement).selectionStart).toBe(2);
    expect((document.activeElement as HTMLTextAreaElement).selectionEnd).toBe(5);
    const id = demo.state.annotations.at(-1).id;
    act("close-side"); click('[data-annotation="' + id + '"]'); act("write-annotation");
    expect((document.getElementById("annotation-writing") as HTMLTextAreaElement).value).toBe("尚未保存的想法");
    act("save-annotation"); expect(demo.state.annotations.at(-1).comment).toBe("尚未保存的想法");
  });
  it("生成进度可离开、取消和重试；旧内容不会被 loading 清空", () => {
    const { act, demo, document } = setup();
    act("overview"); act("generate-overview");
    expect(demo.state.jobs.overview.status).toBe("running");
    expect(document.querySelector(".overview-points")).toBeTruthy();
    expect(document.querySelector(".progress-state")).toBeTruthy();
    act("reader"); act("overview");
    expect(document.querySelector(".progress-state")).toBeTruthy();
    act("cancel-job");
    vi.advanceTimersByTime(2000);
    expect(demo.state.jobs.overview.status).toBe("cancelled");
    act("generate-overview"); vi.advanceTimersByTime(1801);
    expect(demo.state.jobs.overview.status).toBe("ready");
    expect(document.querySelector(".progress-state")).toBeNull();
  });
  it("失败就地显示，再试后可读；不是伪造成功", () => {
    const { act, demo, change, document } = setup();
    change("#scenario-setting","generation-failed");
    act("overview"); act("generate-overview"); vi.advanceTimersByTime(1801);
    expect(demo.state.jobs.overview.status).toBe("failed");
    expect(document.querySelector(".error-state")).toBeTruthy();
    change("#scenario-setting","normal"); act("retry-job"); vi.advanceTimersByTime(1801);
    expect(demo.state.jobs.overview.status).toBe("ready");
    expect(document.querySelector(".error-state")).toBeNull();
  });
  it("回想不要求输入，线索不展开答案，揭示与自述分别保存", () => {
    const { act, document, demo, click } = setup();
    act("recall");
    expect(document.querySelector("#answer-fold")).toBeNull();
    expect(document.querySelector("#page-content textarea")).toBeNull();
    act("hint");
    expect(document.querySelector(".hint")).toBeTruthy();
    expect(document.querySelector("#answer-fold")).toBeNull();
    act("reveal");
    expect(document.querySelector("#answer-fold")?.textContent).toContain("语气、情绪与停顿");
    click('[data-action="self-report"][data-value="想起一部分"]');
    expect(demo.state.recalls.at(-1).selfReport).toBe("想起一部分");
    act("reader"); act("recall");
    expect(document.querySelector("#answer-fold")).toBeTruthy();
    expect(document.querySelector('[aria-pressed="true"][data-action="self-report"]')?.textContent).toBe("想起一部分");
    const previousBlock = demo.state.recalls.at(-1).block;
    act("new-recall");
    expect(demo.state.recalls.at(-1).block).not.toBe(previousBlock);
    expect(document.querySelector("#answer-fold")).toBeNull();
  });
  it("草稿默认未选；选择不是正式收下", () => {
    const { act, document, change, demo } = setup();
    act("expansion");
    expect(document.querySelectorAll(".draft-book")).toHaveLength(3);
    expect(document.querySelectorAll("input:checked")).toHaveLength(0);
    expect((document.querySelector('[data-action="commit"]') as HTMLButtonElement).disabled).toBe(true);
    change('[data-select-draft="d1"]',true);
    expect((document.querySelector('[data-action="commit"]') as HTMLButtonElement).disabled).toBe(false);
    expect(demo.state.saved).toHaveLength(2);
  });
  it("草稿逐篇编辑与返回保持缓冲，标题目录可定位", () => {
    const { act, click, input, document, demo } = setup();
    act("expansion"); click('[data-action="open-draft"][data-id="d1"]'); act("edit");
    input("#draft-title","修改后的草稿");
    input("#draft-body","<h2>一个新标题</h2><p>一段新的内容。</p>",true);
    expect(document.querySelector("#toc")?.textContent).toContain("一个新标题");
    const block = document.querySelector("#toc button[data-level]")?.getAttribute("data-block");
    expect(document.querySelector('#draft-body [data-block="' + block + '"]')).toBeTruthy();
    act("next-draft"); act("previous-draft");
    expect((document.getElementById("draft-title") as HTMLInputElement).value).toBe("修改后的草稿");
    act("expansion"); click('[data-action="open-draft"][data-id="d1"]');
    expect(document.getElementById("draft-body")?.textContent).toContain("一段新的内容。");
    expect(demo.state.drafts[0].edited).toBe(true);
  });
  it("新插标题有唯一稳定锚点，不会挤占已有标题的目录定位", () => {
    const { act, input, document, w, click } = setup();
    act("edit"); input("#note-body","<h2>先写的标题</h2><p>内容。</p>",true);
    const original = document.querySelector("#note-body h2")!;
    const originalId = original.getAttribute("data-block");
    document.getElementById("note-body")!.insertAdjacentHTML("afterbegin","<h2>插在前面的标题</h2>");
    document.getElementById("note-body")!.dispatchEvent(new w.Event("input", { bubbles: true }));
    const ids = [...document.querySelectorAll("#note-body h2")].map((node) => node.getAttribute("data-block"));
    expect(new Set(ids).size).toBe(2);
    expect(original.getAttribute("data-block")).toBe(originalId);
    click('#toc [data-block="' + originalId + '"]');
    expect(document.querySelector(".located")?.textContent).toBe("先写的标题");
  });
  it("只收下勾选项，提交冻结快照且连点不会重复创建", () => {
    const { act, change, demo, document } = setup();
    act("expansion"); change('[data-select-draft="d1"]',true); change('[data-select-draft="d3"]',true);
    act("commit"); act("commit");
    expect((document.querySelector('[data-select-draft="d1"]') as HTMLInputElement).disabled).toBe(true);
    change('[data-select-draft="d1"]',false);
    expect(demo.state.drafts[0].selected).toBe(true);
    const title = demo.state.jobs.commit.payload.drafts[0].title;
    demo.state.drafts[0].title = "提交之后的变化";
    vi.advanceTimersByTime(1801);
    expect(demo.state.saved).toHaveLength(4);
    expect(demo.state.saved[2].title).toBe(title);
    expect(demo.state.drafts[0].saved).toBe(true);
    expect(demo.state.drafts[1].saved).toBe(false);
    expect(document.querySelectorAll(".success-stamp")).toHaveLength(2);
    act("commit"); vi.advanceTimersByTime(2000);
    expect(demo.state.saved).toHaveLength(4);
  });
  it("收下失败保留编辑与选择，同一身份重试", () => {
    const { act, change, demo, document } = setup();
    change("#scenario-setting","generation-failed"); act("expansion"); change('[data-select-draft="d2"]',true); act("commit");
    const token = demo.state.jobs.commit.token;
    vi.advanceTimersByTime(1801);
    expect(demo.state.saved).toHaveLength(2);
    expect(demo.state.drafts[1].selected).toBe(true);
    expect(document.getElementById("action-tray")?.textContent).toContain("这次没收下");
    change("#scenario-setting","normal"); act("retry-job"); vi.advanceTimersByTime(1801);
    expect(demo.state.jobs.commit.token).toBe(token);
    expect(demo.state.saved).toHaveLength(3);
  });
  it("笔记编辑先留缓冲，保存后成为新版本，旧批注不误挂", () => {
    const { act, input, demo, document, click } = setup();
    act("edit"); input("#note-title","新的笔记标题"); input("#note-body","<h2>新版章节</h2><p>新版本的原文内容。</p>",true);
    act("reader");
    expect(demo.state.note.version).toBe(3);
    act("edit"); expect((document.getElementById("note-title") as HTMLInputElement).value).toBe("新的笔记标题");
    expect(document.querySelector("#toc")?.textContent).toContain("新版章节");
    act("save-note");
    expect(demo.state.note.version).toBe(4);
    expect(document.querySelectorAll("[data-annotation]")).toHaveLength(0);
    act("history"); click('[data-action="open-history"][data-id="h2"]');
    expect(document.querySelectorAll("[data-annotation]")).toHaveLength(2);
    expect(document.getElementById("page-content")?.textContent).toContain("当时的笔记 v3");
    expect(document.getElementById("side-body")?.textContent).toContain("速度与自然度要放在一起看");
    act("reader");
    expect(document.getElementById("page-content")?.textContent).toContain("新的笔记标题");
  });
  it("新版本示例速看使用冻结原句；旧记录仍回旧版", () => {
    const { act, input, demo, document, click } = setup();
    act("edit"); input("#note-body","<h2>新版</h2><p>修改后的第一段。</p><p>修改后的第二段。</p>",true); act("save-note");
    act("overview"); act("generate-overview"); vi.advanceTimersByTime(1801);
    expect(demo.state.overview.version).toBe(4);
    expect(document.querySelector(".overview-points")?.textContent).toContain("修改后的第一段");
    click('[data-action="overview-origin"]');
    expect(document.querySelector(".located")?.textContent).toContain("修改后的第一段");
    act("history"); click('[data-action="open-history"][data-id="h1"]');
    expect(document.querySelector(".note-meta .version-tag")?.textContent).toBe("笔记 v3");
    expect(document.querySelector(".overview-points")?.textContent).toContain("声音身份与所说语言");
  });
  it("资料袋区分原始材料、补充资料、失败与未关联", () => {
    const { act, click, change, document } = setup();
    act("sources");
    expect(document.getElementById("side-body")?.textContent).toContain("原始材料");
    click('[data-source="supplement"]');
    expect(document.querySelector(".source-address")?.getAttribute("rel")).toContain("noopener");
    change("#scenario-setting","source-failed");
    expect(document.getElementById("side-body")?.textContent).toContain("来源暂时没读到");
    expect(document.getElementById("side-body")?.textContent).not.toContain("暂时没有关联来源");
    change("#scenario-setting","no-source");
    expect(document.getElementById("side-body")?.textContent).toContain("暂时没有关联来源");
    expect(document.querySelector(".error-state")).toBeNull();
  });
  it("资料切换与回想重建后保留合理焦点；来源 tab 支持方向键", () => {
    const { act, click, document, w } = setup();
    act("sources");
    document.getElementById("source-tab-supplement")!.focus(); click("#source-tab-supplement");
    expect(document.activeElement?.id).toBe("source-tab-supplement");
    document.activeElement!.dispatchEvent(new w.KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}));
    expect(document.activeElement?.id).toBe("source-tab-original");
    expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
    act("close-side"); act("recall");
    document.querySelector<HTMLElement>('[data-action="hint"]')!.focus(); act("hint");
    expect((document.activeElement as HTMLElement).dataset.action).toBe("reveal");
    act("reveal");
    expect((document.activeElement as HTMLElement).dataset.action).toBe("self-report");
  });
  it("多篇已收下关系能打开并返回原笔记", () => {
    const { act, click, document, demo } = setup();
    act("relations"); expect(document.querySelectorAll(".relation-link")).toHaveLength(2);
    click('[data-action="open-related"][data-id="s1"]');
    expect(demo.view).toBe("related");
    expect(document.getElementById("page-content")?.textContent).toContain("从参考声音到零样本配音");
    expect(document.getElementById("toc")?.textContent).toContain("参考与训练");
    expect(document.getElementById("toc")?.textContent).not.toContain("快一点");
    click('#toc [data-block="heading-0"]');
    expect(demo.view).toBe("related");
    expect(document.querySelector(".located")?.textContent).toBe("参考与训练");
    act("reader");
    expect(demo.view).toBe("reader");
    expect(document.getElementById("page-content")?.textContent).toContain("IndexTTS 2.5");
  });
  it("紧凑画幅默认不挤三列，按需附页关闭后立即恢复焦点", () => {
    const { act, document } = setup(720);
    expect(document.getElementById("folio")?.dataset.toc).toBe("false");
    expect((document.getElementById("leaf") as HTMLElement).inert).toBe(false);
    act("sources");
    expect((document.getElementById("leaf") as HTMLElement).inert).toBe(true);
    expect((document.getElementById("side-leaf") as HTMLElement).inert).toBe(false);
    act("close-side");
    expect((document.getElementById("leaf") as HTMLElement).inert).toBe(false);
    expect(document.querySelector(".companion-character")).toBeTruthy();
    expect((document.getElementById("pin-button") as HTMLButtonElement).disabled).toBe(true);
  });
  it("Off 与系统 reduced-motion 都跳过 WAAPI；关闭不依赖动画完成", () => {
    const { w, act, change, document } = setup(1440,true);
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel() {} }));
    w.HTMLElement.prototype.animate = animate;
    act("sources"); act("close-side"); act("overview");
    expect(animate).not.toHaveBeenCalled();
    expect((document.getElementById("side-leaf") as HTMLElement).hidden).toBe(true);
    change("#motion-setting","off"); act("reader");
    expect(document.getElementById("room")?.dataset.motion).toBe("off");
    expect(document.documentElement.dataset.motion).toBe("off");
    expect(animate).not.toHaveBeenCalled();
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (hover: hover) and (pointer: fine)");
    expect(css).toContain(':root[data-motion="off"] :is(.button,.icon-button,.text-action,.ribbon,.draft-book,.companion-character,.companion-character img) { transform: none !important; }');
  });
  it("快速重开旁页时旧退出不能把新旁页隐藏", async () => {
    const { w, act, document, demo } = setup();
    const animations: { resolve: () => void; cancel: () => void }[] = [];
    w.HTMLElement.prototype.animate = (() => {
      let resolve!: () => void; let reject!: () => void;
      const finished = new Promise<void>((yes,no) => { resolve = yes; reject = no; });
      const cancel = () => reject();
      animations.push({ resolve, cancel });
      return { finished, cancel };
    }) as any;
    act("sources"); act("close-side"); act("history");
    animations.forEach((handle) => handle.resolve()); await Promise.resolve(); await Promise.resolve();
    expect(demo.detail.type).toBe("history");
    expect((document.getElementById("side-leaf") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("side-leaf") as HTMLElement).inert).toBe(false);
  });
  it("本机重开恢复缓冲与任务身份，不重复创建", () => {
    const first = setup();
    first.act("expansion"); first.change('[data-select-draft="d1"]',true); first.act("commit");
    const stored = first.w.localStorage.getItem("study.notebook-folio-demo.v4")!;
    const second = setup(1440,false,stored);
    expect(second.demo.state.jobs.commit.token).toBe(first.demo.state.jobs.commit.token);
    vi.advanceTimersByTime(1801);
    expect(second.demo.state.saved).toHaveLength(3);
    expect(first.demo.state.saved).toHaveLength(3);
  });
  it("可编辑 HTML 经 DOM 白名单清理；保留正常正文", () => {
    const { demo } = setup();
    const cleaned = demo.safeHTML('<h2 onclick="alert(1)">标题</h2><script>alert(1)</script><iframe src="x"></iframe><p><a href="javascript:alert(1)">文字</a><strong>强调</strong></p>');
    expect(cleaned).toContain("<h2>标题</h2>");
    expect(cleaned).toContain("<strong>强调</strong>");
    expect(cleaned).not.toMatch(/script|iframe|onclick|javascript:/);
  });
  it("本地资源齐全；不会依赖 CDN，图标有许可", () => {
    for (const match of [...html.matchAll(/(?:src|href)="([^"]+)"/g)]) {
      if (match[1].startsWith("http")) continue;
      expect(existsSync(fileURLToPath(new URL("../" + match[1],import.meta.url)))).toBe(true);
    }
    for (const match of [...css.matchAll(/url\("([^"]+)"\)/g)]) {
      expect(existsSync(fileURLToPath(new URL("../" + match[1],import.meta.url)))).toBe(true);
    }
    expect(existsSync(fileURLToPath(new URL("../vendor/LICENSE-lucide.txt",import.meta.url)))).toBe(true);
    expect(html).not.toMatch(/https?:\/\/.*(?:\.js|\.css)/);
  });
});
