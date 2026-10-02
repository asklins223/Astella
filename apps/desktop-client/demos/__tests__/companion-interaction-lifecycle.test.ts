import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";

const sandbox = { window:{} as any,performance,setTimeout,clearTimeout };
runInNewContext(readFileSync(new URL("../companion-interaction-lifecycle.js",import.meta.url),"utf8"),sandbox);
const { create,lifetimeFor } = sandbox.window.COMPANION_DEMO_LIFECYCLE;

describe("transient companion papers",() => {
  let expired: string[], clock: ReturnType<typeof create>;
  beforeEach(() => {
    vi.useFakeTimers(); expired = [];
    clock = create({ onExpire:(ids:string[]) => expired.push(...ids),now:() => Date.now(),schedule:(fn:()=>void,ms:number) => setTimeout(fn,ms),cancel:(timer:ReturnType<typeof setTimeout>) => clearTimeout(timer) });
  });
  afterEach(() => { clock.clear(); vi.useRealTimers(); });
  const paper = (id:string,type:string,state = "ready") => ({ id,signature:`${type}:${state}`,duration:lifetimeFor({ type,state }) });

  it("keeps pending confirmation while every ordinary paper expires",() => {
    clock.update([paper("image","image"),paper("card","card"),paper("quote","quote"),paper("tool","tool","done"),paper("confirm","proposal","pending")]);
    vi.advanceTimersByTime(8000); expect(expired).toEqual(["tool"]);
    vi.advanceTimersByTime(52000); expect(expired).toContain("quote");
    vi.advanceTimersByTime(30000); expect(expired).toEqual(expect.arrayContaining(["image","card"]));
    vi.advanceTimersByTime(300000); expect(expired).not.toContain("confirm");
  });
  it("does not restart the countdown when unrelated content re-renders",() => {
    const image = paper("image","image"); clock.update([image]);
    vi.advanceTimersByTime(60000); clock.update([image,paper("confirm","proposal","pending")]);
    vi.advanceTimersByTime(29999); expect(expired).toEqual([]);
    vi.advanceTimersByTime(1); expect(expired).toEqual(["image"]);
  });
  it("starts short feedback time on a real tool or confirmation outcome",() => {
    clock.update([paper("tool","tool","running"),paper("confirm","proposal","pending")]);
    vi.advanceTimersByTime(10000);
    clock.update([paper("tool","tool","done"),paper("confirm","proposal","accepted")]);
    vi.advanceTimersByTime(8000); expect(expired).toEqual(["tool"]);
    vi.advanceTimersByTime(2000); expect(expired).toEqual(["tool","confirm"]);
  });
  it("extends reading only during recent activity, without a permanent hover hold",() => {
    clock.update([paper("quote","quote")]); vi.advanceTimersByTime(59000);
    clock.activity("quote"); vi.advanceTimersByTime(3499); expect(expired).toEqual([]);
    vi.advanceTimersByTime(1); expect(expired).toEqual(["quote"]);
  });
  it("pauses hidden pages and discards old scene timers",() => {
    clock.update([paper("quote","quote")]); vi.advanceTimersByTime(10000);
    clock.setHidden(true); vi.advanceTimersByTime(180000); expect(expired).toEqual([]);
    clock.setHidden(false); vi.advanceTimersByTime(49999); expect(expired).toEqual([]);
    clock.clear(); clock.update([paper("new","card")]); vi.advanceTimersByTime(1);
    expect(expired).toEqual([]); vi.advanceTimersByTime(89999); expect(expired).toEqual(["new"]);
  });
});
