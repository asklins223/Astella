import assert from "node:assert/strict";
import { test } from "node:test";
import pino from "pino";
import { logger } from "../logger.ts";

// pino's pretty transport is a worker thread that only unrefs itself after its
// `ready` message. Under parallel test startup that message can land after the
// last test finished, so a fully passing file never exits — the process just
// sits on a live MessagePort. Tests must therefore import a transport-free logger.
test("the logger creates no transport worker inside a test child", () => {
  assert.notEqual(process.env.NODE_TEST_CONTEXT, undefined, "this guard only applies inside a test child");
  const stream = (logger as unknown as Record<symbol, { worker?: unknown }>)[pino.symbols.streamSym];
  assert.equal(stream?.worker, undefined, "a thread-stream worker here keeps node --test alive after the last test passes");
  logger.info({ probe: true }, "synthetic log line");
});
