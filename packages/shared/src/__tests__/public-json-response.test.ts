import assert from "node:assert/strict";
import test from "node:test";
import { CircuitBreaker, CircuitOpenError } from "../circuit-breaker.ts";
import { decodePublicJsonResponse } from "../public-json-http.ts";

test("HTML gateway timeout retains status and contributes to the circuit breaker", () => {
  const breaker = new CircuitBreaker({ failureThreshold: 2 });
  const response = decodePublicJsonResponse("gateway.example", 504, "Gateway Timeout", "<html>timeout</html>", breaker);
  assert.deepEqual(response, { status: 504, statusText: "Gateway Timeout", body: null });
  assert.equal(breaker.peek("gateway.example"), "closed");
  decodePublicJsonResponse("gateway.example", 502, "Bad Gateway", "unavailable", breaker);
  assert.throws(() => breaker.assertCanAttempt("gateway.example"), CircuitOpenError);
});

test("non-JSON rate limits and authentication errors retain their distinct HTTP status", () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  assert.equal(decodePublicJsonResponse("rate.example", 429, "Too Many Requests", "rate limited", breaker).status, 429);
  assert.equal(breaker.peek("rate.example"), "open");
  assert.equal(decodePublicJsonResponse("auth.example", 401, "Unauthorized", "denied", breaker).status, 401);
  assert.equal(breaker.peek("auth.example"), "closed");
});

test("successful malformed responses fail while valid JSON remains intact", () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  assert.throws(() => decodePublicJsonResponse("bad.example", 200, "OK", "<html>unexpected</html>", breaker), /invalid JSON \(200\)/);
  assert.equal(breaker.peek("bad.example"), "open");
  assert.deepEqual(decodePublicJsonResponse("ok.example", 200, "OK", '{"choices":[]}', breaker).body, { choices: [] });
});
