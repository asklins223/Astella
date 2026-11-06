import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, get } from "node:http";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { onSseDisconnect } from "../safe-sse-write.ts";

test("a completed GET keeps streaming, and repeated client disconnects release the response exactly once", { timeout: 5000 }, async () => {
  let active = 0;
  let closed = 0;
  let requestClosedBeforeSubscription = 0;
  let responseClosed: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    let requestClosed = false;
    request.once("close", () => { requestClosed = true; });
    request.resume();
    await once(request, "end");
    await setImmediate();
    if (requestClosed) requestClosedBeforeSubscription += 1;
    active += 1;
    onSseDisconnect(request, response, () => {
      active -= 1;
      closed += 1;
      responseClosed?.();
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(": ready\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (let index = 0; index < 20; index += 1) {
      const disconnected = new Promise<void>(resolve => { responseClosed = resolve; });
      const request = get(`http://127.0.0.1:${address.port}/events`);
      request.on("error", () => {});
      const [response] = await once(request, "response");
      await once(response, "data");
      assert.equal(active, 1, "finishing the GET must not close its SSE response");
      request.destroy();
      response.destroy();
      await disconnected;
      assert.equal(active, 0, "the next connection must not inherit a leaked slot");
      assert.equal(closed, index + 1);
    }
    assert.equal(requestClosedBeforeSubscription, 20, "the GET close event already happened before the asynchronous stream opened");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
