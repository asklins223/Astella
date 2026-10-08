/** Model-authored expression projected onto committed display ranges. No language classifier. */
import { createHash } from "node:crypto";
import {
  readVoiceExpressionTags, stripVoiceExpressionTags, voiceExpressionCue,
  type VoiceControlTag, type VoiceRichTag,
} from "@astella/shared/voice-expression-tags";
import { sanitizeCompanionVisibleText } from "./companion-dialogue-content.ts";
import { resolveFactSpans, type FactSpanValues } from "./companion-fact-spans.ts";
import { purifyVoiceText, TTS_MAX_SEGMENT_CHARS, type CompanionDisplaySegment } from "../lib/tts-segments.ts";

export interface CompanionVoiceExpression {
  readonly displayText: string;
  readonly marks: readonly { offset: number; tag: VoiceControlTag | VoiceRichTag; kind: "control" | "rich" }[];
  readonly codeRanges: readonly { start: number; end: number }[];
}

/** Use exactly the display transform, including fact substitution, to preserve absolute offsets. */
export function projectCompanionVoiceExpression(raw: string, facts?: FactSpanValues): CompanionVoiceExpression {
  const source = raw.trimStart();
  const visible = (text: string): string => {
    const sanitized = sanitizeCompanionVisibleText(text);
    return facts ? resolveFactSpans(sanitized, facts).text : sanitized;
  };
  const displayText = visible(source).trimEnd();
  const marks: CompanionVoiceExpression["marks"][number][] = [];
  for (const mark of readVoiceExpressionTags(source)) {
    // The sentinel keeps trailing spaces/newlines significant until the range is committed.
    const prefix = visible(source.slice(0, mark.start) + "\uE000").slice(0, -1);
    if (!displayText.startsWith(prefix)) continue;
    marks.push({ offset: prefix.length, tag: mark.tag, kind: mark.kind });
  }
  const codeRanges = [...displayText.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$)|\[\^web-[a-zA-Z0-9_-]+\]/g)]
    .map(match => ({ start: match.index!, end: match.index! + match[0].length }));
  return { displayText, marks, codeRanges };
}

export function companionVoiceExpressionBoundaries(expression: CompanionVoiceExpression): number[] {
  return expression.marks.filter(mark => mark.kind === "control").map(mark => mark.offset);
}

/** Independent TTS tasks must repeat the active control; rich sounds belong only to their position. */
export function companionVoiceSegmentExpression(
  expression: CompanionVoiceExpression,
  segment: CompanionDisplaySegment,
  enabled = true,
): { text: string; textSha256: string; cue: ReturnType<typeof voiceExpressionCue> } {
  const spokenRange = (start: number, end: number): string => {
    let piece = expression.displayText.slice(start, end);
    // A display segment can be just one line of a multi-line code block. Exclude
    // code using whole-reply ranges so those fragments never become spoken code.
    for (const range of [...expression.codeRanges].reverse()) {
      const left = Math.max(start, range.start), right = Math.min(end, range.end);
      if (right > left) piece = piece.slice(0, left - start) + " ".repeat(right - left) + piece.slice(right - start);
    }
    const spoken = purifyVoiceText(stripVoiceExpressionTags(piece));
    return (/^\s/.test(piece) ? " " : "") + spoken + (/\s$/.test(piece) ? " " : "");
  };
  const aligned = expression.displayText.slice(segment.displayStart, segment.displayEnd) === segment.displayText;
  const plain = aligned ? spokenRange(segment.displayStart, segment.displayEnd).trim()
    : purifyVoiceText(stripVoiceExpressionTags(segment.displayText));
  let text = plain;
  let cue = voiceExpressionCue(null);
  if (enabled && aligned && plain.length > 0) {
    const active = expression.marks.filter(mark => mark.kind === "control" && mark.offset <= segment.displayStart).at(-1);
    const control = active?.tag ?? null;
    cue = voiceExpressionCue(control);
    let cursor = segment.displayStart;
    let tagged = control && control !== "neutral" ? `[${control}]` : "";
    for (const mark of expression.marks) {
      if (mark.offset < segment.displayStart || mark.offset >= segment.displayEnd) continue;
      if (mark.kind === "control" && mark.offset === segment.displayStart) continue;
      tagged += spokenRange(cursor, mark.offset);
      if (mark.tag !== "neutral") tagged += `[${mark.tag}]`;
      if (mark.kind === "rich" && cue.emotion === "neutral") cue = voiceExpressionCue(mark.tag);
      cursor = mark.offset;
    }
    tagged += spokenRange(cursor, segment.displayEnd);
    text = tagged.replace(/\s+/g, " ").trim();
    // Keep every spoken word if excessive metadata exhausts the bounded wire contract.
    // Normally display segmentation has already reserved 48 characters for expression.
    if (text.length > TTS_MAX_SEGMENT_CHARS) {
      text = control && control !== "neutral" && plain.length + control.length + 2 <= TTS_MAX_SEGMENT_CHARS
        ? `[${control}]${plain}` : plain;
    }
  }
  return { text, textSha256: createHash("sha256").update(text, "utf8").digest("hex"), cue };
}
