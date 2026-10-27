/**
 * Two structural read-outs of a reply, kept out of the dialogue content module
 * so its size stays where the guard expects it.
 *
 * Neither of these looks at the request: one asks whether a stream has fallen
 * into a repetition loop, the other whether the reply describes a picture. The
 * first is answered by the shape of the text, the second by whether the turn
 * actually holds an image receipt.
 */

/**
 * Is this stream stuck repeating itself?
 *
 * A degraded model can loop one sentence for thousands of deltas (2026-10-27
 * soak: one sentence repeated to 3,289 deltas, holding the run open for 426s
 * because every delta reset the idle watchdog). The signal is structural, not
 * lexical: the tail of the reply is built from very few distinct sentences.
 *
 * The window starts where a genuine loop is unmistakable. A short repetitive
 * answer is already covered by the collapse gate and ends on its own; firing
 * earlier would cut legitimate repetitive content the user asked for.
 */
export function companionStreamRepeatsItself(text: string): boolean {
  if (text.length < 1_500) return false;
  const tail = text.slice(-1_000);
  const sentences = tail.split(/[。！？!?\n]+/u).map(part => part.trim()).filter(part => part.length >= 6);
  if (sentences.length < 10) return false;
  const distinct = new Set(sentences).size;
  // Few distinct sentences across many repeats is a loop; ordinary prose keeps
  // most of its sentences distinct.
  return distinct <= Math.max(2, Math.floor(sentences.length / 8));
}

const IMAGE_CONTENT_DESCRIPTION = new RegExp([
  // Any picture noun followed by a statement about its contents: "图里写的是 X",
  // "截图里显示答案是 B", "照片上写着公式". The window is generous because the
  // noun and the verb can be several words apart; questions are excluded below,
  // so a wide window does not turn "图里写了什么？" into a claim.
  "(?:图|图片|截屏|截图|照片|画面|图表)[^。！？\\n]{0,10}"
    + "(?:里|中|上|里面|当中)[^。！？\\n]{0,14}"
    + "(?:写着|写了|写的是|显示|显示着|是|有|画着|标着|列出|列出的是|包含|内容|文字|答案|标题|公式|表格|数据|数字)",
  // The content noun carries the claim even without a location word.
  "(?:图|图片|截屏|截图|照片|画面)[^。！？\\n]{0,6}(?:文字|内容|标题|答案|公式|表格|数据|数字)"
    + "[^。！？\\n]{0,8}(?:是|为|写着|显示|包含|如下)",
].join("|"), "gu");

/**
 * Does the reply describe what is *in* a picture?
 *
 * The model may receive an attachment as a name plus an assetId rather than as
 * pixels (only a vision turn or a read tool sends the bytes). Without a receipt
 * any such description is invented, however confidently it is phrased — the
 * observed failure mode is a fluent, fully made-up account of a screenshot.
 */
export function claimsImageContent(text: string): boolean {
  // A question about the picture asks for a read; it does not report one.
  const statements = text.split("\n").filter(line => !/[？?]\s*$/u.test(line.trim())).join("\n").trim();
  if (!statements) return false;
  // The pattern carries `g`, so its lastIndex has to be reset: leaving it set
  // made every second call miss (caught by the unit test, not in production).
  IMAGE_CONTENT_DESCRIPTION.lastIndex = 0;
  return IMAGE_CONTENT_DESCRIPTION.test(statements);
}
