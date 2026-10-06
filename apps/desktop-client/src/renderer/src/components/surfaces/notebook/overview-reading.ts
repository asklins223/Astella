import type { NoteOverviewV1 } from "@astella/shared/note-overview-contracts";
import { plainCompanionBubbleText } from "../../companion/companion-markdown";

/** Reshape stored prose, without adding conclusions or assigning invented source locations. */
export function overviewReading(overview: NoteOverviewV1) {
  const paragraphs = overview.body.trim().split(/\n\s*\n/u);
  if (overview.points?.length) return {
    gist: paragraphs[0] ?? "", notes: paragraphs.slice(1).join("\n\n"),
    points: overview.points.map(point => ({ text: point.explanation, references: [{ blockOrdinal: point.blockOrdinal, quote: point.quote }] })),
    references: [] as NoteOverviewV1["references"],
  };
  const gist = paragraphs[0] ?? "";
  const points: { text: string; references: NoteOverviewV1["references"] }[] = [];
  const notes: string[] = [];
  for (const line of paragraphs.slice(1).join("\n\n").split("\n")) {
    const numbered = line.match(/^\s*\d+[.、)]\s*(.+)$/u);
    if (numbered) { points.push({ text: numbered[1], references: [] }); continue; }
    const point = points.at(-1);
    if (/^\s*原文[：:]/u.test(line) && point) {
      const quote = line.replace(/^\s*原文[：:]\s*/u, "").replace(/^[“"‘]|[”"’]$/gu, "");
      const matched = overview.references.find(reference => reference.quote === quote);
      if (matched) point.references.push(matched);
      else point.text += `\n${line}`;
    } else if (point && line.trim()) point.text += `\n${line}`;
    else if (line.trim() && !/^先记住这几件事[：:]?$/u.test(line.trim())) notes.push(line);
  }
  const assigned = new Set(points.flatMap(point => point.references.map(reference => reference.quote)));
  return { gist, points, notes: notes.join("\n"), references: overview.references.filter(reference => !assigned.has(reference.quote)) };
}

export function pointLead(text: string) {
  // A short point is the content to scan, not a label for a disclosure. Keeping
  // only its opening sentence used to hide the useful explanation behind a
  // generic “这段揭示了…” introduction.
  if (text.length <= 220) return { lead: text, remainder: "" };
  const plain = plainCompanionBubbleText(text);
  const preview = plain.slice(0, 200);
  const boundary = Math.max(preview.lastIndexOf("。"), preview.lastIndexOf("！"), preview.lastIndexOf("？"));
  return { lead: `${boundary >= 50 ? preview.slice(0, boundary + 1) : preview.trimEnd()}…`, remainder: text };
}
