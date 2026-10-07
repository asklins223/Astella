import { randomInt } from "node:crypto";
import { dialogueCases } from "./dialogue-cases.ts";
import { validateCompanionOutput } from "../handlers/companion-dialogue-content.ts";

export interface DialogueReviewSample {
  caseId: string; repeat: number; condition: string; answer: string; structuralOk: boolean;
}

/** No model name, request hash, latency, condition or evaluator prediction goes to the rater. */
export function buildDialogueReviewPacket(samples: DialogueReviewSample[],
  nextIndex: (max: number) => number = max => randomInt(max)) {
  const groups = new Map<string, DialogueReviewSample[]>();
  for (const sample of samples) {
    if (!Number.isSafeInteger(sample.repeat) || sample.repeat < 0 || !dialogueCases.some(c => c.id === sample.caseId))
      throw new Error("Unknown review sample");
    const key = `${sample.caseId}/${sample.repeat}`;
    const group = groups.get(key) ?? [];
    if (group.some(r => r.condition === sample.condition)) throw new Error("Duplicate review condition");
    group.push(sample); groups.set(key, group);
  }
  const shuffle = <T>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = nextIndex(i + 1);
      if (!Number.isInteger(j) || j < 0 || j > i) throw new Error("Invalid review random index");
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  };
  const key: Array<{ responseId: string; caseId: string; repeat: number; condition: string }> = [];
  const packets = shuffle([...groups.values()]).map((group, packetIndex) => {
    const c = dialogueCases.find(c => c.id === group[0]!.caseId)!;
    const responses = shuffle([...group]).map((sample, responseIndex) => {
      const responseId = `p${packetIndex + 1}-r${responseIndex + 1}`;
      key.push({ responseId, caseId: sample.caseId, repeat: sample.repeat, condition: sample.condition });
      const validated = validateCompanionOutput(sample.answer);
      return { responseId, answer: validated.ok ? validated.text : sample.answer,
        deliveryValid: sample.structuralOk && validated.ok };
    });
    return { packetId: `p${packetIndex + 1}`, history: c.history.map(({ role, text }) => ({ role, text })),
      userText: c.userText, criteria: c.criteria, responses,
      ratings: responses.map(r => ({ responseId: r.responseId, factualScope: null, topic: null,
        conversationalAction: null, persona: null, repetition: null, usefulHelp: null, evidence: [], reason: "" })),
      preference: { groupsBestToWorst: [], reason: "", mayTie: true } };
  });
  return { packet: { version: 1, rater: null, instruction:
    "独立阅读上下文与完整回复，按各维度评阅并引用实际片段。允许平局、多种合理表达；问句、短句或第一人称不单独扣分。不要查看映射文件。未独立人工填写前不构成盲评证据。",
    packets }, key: { version: 1, responses: key } };
}
