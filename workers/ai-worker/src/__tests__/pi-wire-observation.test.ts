import assert from "node:assert/strict";
import { test } from "node:test";
import { PiWireObservation } from "../lib/providers/pi-wire-observation.ts";

// Regression for a production duplicate-message bug: two independent
// `companion_send_message` calls arrived in one chat-completions delta without
// an `index`, and the accumulator keyed both on index 0. Names and arguments
// were concatenated, so the host saw one tool call whose text was two
// paragraphs glued together, and only one bubble was ever published.
const chatDelta = (toolCalls: unknown[]) => ({
  choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
});
const finish = { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };

function parse(events: unknown[]) {
  const wire = new PiWireObservation("mimo-agent", "openai-completions", true, () => {}, undefined);
  for (const event of events) wire.observe(event);
  wire.validate();
  return wire.observedCalls();
}

test("two calls in one delta without index stay two separate calls", () => {
  const calls = parse([
    chatDelta([
      { id: "call_first", function: { name: "companion_send_message", arguments: '{"text":"嘿，来了。"}' } },
      { id: "call_second", function: { name: "companion_send_message", arguments: '{"text":"今天先干哪件事？"}' } },
    ]),
    finish,
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => JSON.parse(call.arguments).text), ["嘿，来了。", "今天先干哪件事？"]);
  assert.notEqual(calls[0]!.id, calls[1]!.id);
});

test("fragments sharing an index and id merge into one call", () => {
  const calls = parse([
    chatDelta([{ index: 0, id: "call_join", function: { name: "companion_send_message", arguments: '{"text":"半' } }]),
    chatDelta([{ index: 0, id: "call_join", function: { arguments: '句。"}' } }]),
    finish,
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.arguments, '{"text":"半句。"}');
});

test("calls without ids keep their index and are rejected by validation", () => {
  // The accumulator keys id-less fragments by index so two calls never merge.
  // A call still lacking an id at the end is malformed, which validate() must
  // refuse rather than dispatch under a shared identity.
  const wire = new PiWireObservation("mimo-agent", "openai-completions", true, () => {}, undefined);
  for (const event of [
    chatDelta([{ index: 0, function: { name: "lookup", arguments: '{"query":"a"}' } }]),
    chatDelta([{ index: 1, function: { name: "lookup", arguments: '{"query":"b"}' } }]),
    finish,
  ]) wire.observe(event);
  assert.equal(wire.observedCalls().length, 2);
  assert.deepEqual(wire.observedCalls().map(call => JSON.parse(call.arguments).query), ["a", "b"]);
  assert.throws(() => wire.validate(), /malformed tool arguments/);
});

test("an initial call ID binds later index-only argument fragments to the same call", () => {
  const calls = parse([
    chatDelta([{ index: 0, id: "call_streamed", function: { name: "lookup", arguments: '{"query":' } }]),
    chatDelta([{ index: 0, function: { arguments: '"fragmented' } }]),
    chatDelta([{ index: 0, function: { arguments: ' query"}' } }]),
    finish,
  ]);
  assert.deepEqual(calls, [{ id: "call_streamed", name: "lookup", arguments: '{"query":"fragmented query"}' }]);
});

test("interleaved index-only fragments retain their independent initial IDs", () => {
  const calls = parse([
    chatDelta([
      { index: 0, id: "call_a", function: { name: "lookup", arguments: '{"query":"' } },
      { index: 1, id: "call_b", function: { name: "lookup", arguments: '{"query":"' } },
    ]),
    chatDelta([{ index: 1, function: { arguments: 'b"}' } }, { index: 0, function: { arguments: 'a"}' } }]),
    finish,
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => [call.id, JSON.parse(call.arguments).query]), [["call_a", "a"], ["call_b", "b"]]);
});

test("an ID arriving after the initial index fragment promotes the existing call", () => {
  const calls = parse([
    chatDelta([{ index: 0, function: { name: "look", arguments: '{"query":' } }]),
    chatDelta([{ index: 0, id: "call_late_id", function: { name: "up", arguments: '"x"}' } }]),
    finish,
  ]);
  assert.deepEqual(calls, [{ id: "call_late_id", name: "lookup", arguments: '{"query":"x"}' }]);
});
