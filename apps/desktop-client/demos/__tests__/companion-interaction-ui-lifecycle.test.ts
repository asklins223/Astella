import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";

const read = (name:string) => readFileSync(new URL(`../${name}`,import.meta.url),"utf8");

describe("real demo event paths for automatic bubble dismissal",() => {
  let dom:JSDOM, win:any, doc:Document;
  beforeEach(() => {
    vi.useFakeTimers();
    dom = new JSDOM(read("companion-interaction.html"),{ url:"http://localhost/demos/companion-interaction.html",runScripts:"outside-only",pretendToBeVisual:true });
    win = dom.window; doc = win.document;
    win.setTimeout = (fn:()=>void,ms:number) => setTimeout(fn,ms);
    win.clearTimeout = (id:ReturnType<typeof setTimeout>) => clearTimeout(id);
    win.performance.now = () => Date.now();
    win.matchMedia = () => ({ matches:false,addEventListener:() => {} });
    win.ResizeObserver = class { observe() {} };
    win.Element.prototype.animate = () => ({ cancel() {},finished:Promise.resolve() });
    win.Image = class { onload?:()=>void; set src(_value:string) { setTimeout(() => this.onload?.(),0); } };
    win.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
    win.HTMLDialogElement.prototype.close = function() { this.open = false; this.dispatchEvent(new win.Event("close")); };
    for (const file of ["notebook-icons.js","companion-interaction-lifecycle.js","companion-interaction-blocks.js","companion-interaction.js"]) win.eval(read(file));
  });
  afterEach(() => { dom.window.close(); vi.clearAllTimers(); vi.useRealTimers(); });
  const click = (selector:string) => (doc.querySelector(selector) as HTMLElement).click();

  it("shows a real streamed reply then closes it despite stationary keyboard focus",() => {
    click('[data-scene="complete"]'); vi.advanceTimersByTime(1200);
    const reply = doc.getElementById("reply-bubble")!;
    expect(reply.hidden).toBe(false);
    doc.getElementById("reply-body")!.focus();
    expect(doc.activeElement?.id).toBe("reply-body");
    vi.advanceTimersByTime(7000);
    expect(reply.hidden).toBe(true);
    expect(doc.querySelector('#light-extras [data-kind="proposal"]')).not.toBeNull();
    click("#records-button");
    expect(doc.getElementById("message-list")!.textContent).toContain("我把原文和图片放到身边的附页里了");
  });
  it("closes an open image preview at image expiry and preserves pending confirmation and records",() => {
    click('[data-scene="complete"]'); vi.advanceTimersByTime(5000);
    expect(doc.querySelector('#light-extras [data-kind="image"][data-state="ready"]')).not.toBeNull();
    click('#light-extras [data-action="open-image"]');
    const viewer = doc.getElementById("image-viewer") as HTMLDialogElement;
    expect(viewer.open).toBe(true);
    vi.advanceTimersByTime(90500);
    expect(viewer.open).toBe(false);
    expect(doc.querySelector('#light-extras [data-kind="image"]')).toBeNull();
    expect(doc.querySelector('#light-extras [data-kind="proposal"][data-state="pending"]')).not.toBeNull();
    click("#records-button");
    expect(doc.querySelector('#message-list [data-kind="image"]')).not.toBeNull();
  });
  it("closes idle input while preserving its unsent draft",() => {
    const input = doc.getElementById("bubble-input") as HTMLTextAreaElement;
    expect(doc.getElementById("input-bubble")!.hidden).toBe(false);
    input.value = "下次再问的问题"; input.dispatchEvent(new win.Event("input",{ bubbles:true })); input.focus();
    vi.advanceTimersByTime(93000);
    expect(doc.getElementById("input-bubble")!.hidden).toBe(true);
    click("#talk-button");
    expect(doc.getElementById("input-bubble")!.hidden).toBe(false);
    expect(input.value).toBe("下次再问的问题");
  });
  it("closes idle voice preview and restores its edited unsent text on reopening",() => {
    click("#voice-button"); click("#voice-finish"); vi.advanceTimersByTime(800);
    const voice = doc.getElementById("voice-bubble")!, transcript = doc.getElementById("voice-transcript") as HTMLTextAreaElement;
    expect(voice.hidden).toBe(false); expect(voice.dataset.phase).toBe("preview");
    transcript.value = "保留这句语音草稿"; transcript.dispatchEvent(new win.Event("input",{ bubbles:true }));
    vi.advanceTimersByTime(93000); expect(voice.hidden).toBe(true);
    click("#voice-button"); expect(voice.hidden).toBe(false); expect(voice.dataset.phase).toBe("preview");
    expect(transcript.value).toBe("保留这句语音草稿");
  });
});
