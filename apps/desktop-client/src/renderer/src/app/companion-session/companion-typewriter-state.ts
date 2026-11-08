import { stableCompanionMarkdownPrefix } from "./companion-markdown-boundary";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const glyphCost = (text: string) => /^[\x00-\x7f]+$/u.test(text) ? 1 : 3;

/** 收包和显现各有自己的时钟；正式消息替换草稿时保留已有的字。 */
export class CompanionTypewriterState {
  target = "";
  visible = "";
  private characters: string[] = [];
  private costs: number[] = [];
  private cursor = 0;
  private credit = 0;
  private complete = true;
  private available = 0;
  get busy() { return this.visible !== this.target; }
  get canAdvance() { return this.cursor < this.available; }
  setTarget(text: string, complete = true) {
    if (text === this.target && complete === this.complete) return;
    this.complete = complete;
    this.target = text;
    this.characters = Array.from(segmenter.segment(text), part => part.segment);
    this.costs = this.characters.map(glyphCost);
    this.available = complete ? this.characters.length : Array.from(segmenter.segment(stableCompanionMarkdownPrefix(text))).length;
    const shown = Array.from(segmenter.segment(this.visible), part => part.segment);
    this.cursor = 0;
    while (this.cursor < shown.length && shown[this.cursor] === this.characters[this.cursor]) this.cursor++;
    this.visible = this.characters.slice(0, this.cursor).join("");
  }
  advance(elapsedMs: number) {
    if (!this.canAdvance) { this.credit = 0; return; }
    this.credit += Math.min(32, Math.max(0, elapsedMs)) * 0.11;
    // 同一时间预算：英文约 110 字符／秒，中文约 37 字／秒；不因积压提速。
    while (this.cursor < this.available && this.credit >= this.costs[this.cursor]!) {
      this.credit -= this.costs[this.cursor]!;
      this.visible += this.characters[this.cursor]!;
      this.cursor++;
    }
    if (!this.canAdvance) this.credit = 0;
  }
  finish() { this.visible = this.target; this.cursor = this.characters.length; this.credit = 0; }
}


const liveResponses = new Map<string, CompanionTypewriterState>();
export function prepareCompanionTypewriter(identity: string, target?: string): CompanionTypewriterState {
  let model = liveResponses.get(identity);
  if (!model) {
    model = new CompanionTypewriterState(); liveResponses.set(identity, model);
    if (liveResponses.size > 100) liveResponses.delete(liveResponses.keys().next().value!);
  }
  if (target !== undefined) model.setTarget(target);
  return model;
}
export function findCompanionTypewriter(identity: string) { return liveResponses.get(identity); }

export function resetCompanionTypewriters() { liveResponses.clear(); }
