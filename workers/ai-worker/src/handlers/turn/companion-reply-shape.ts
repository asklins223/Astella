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
