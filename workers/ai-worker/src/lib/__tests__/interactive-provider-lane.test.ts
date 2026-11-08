import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enterInteractiveProviderLane,
  interactiveProviderLaneDepth,
  leaveInteractiveProviderLane,
  runWhenInteractiveProviderIdle,
} from "../interactive-provider-lane.ts";

test("a background model call waits until the live reply leaves the lane", async () => {
  assert.equal(interactiveProviderLaneDepth(), 0);
  enterInteractiveProviderLane();
  let started = false;
  const pending = runWhenInteractiveProviderIdle(async () => {
    started = true;
    return "done";
  }, new AbortController().signal);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(started, false);
  leaveInteractiveProviderLane();
  assert.equal(await pending, "done");
  assert.equal(interactiveProviderLaneDepth(), 0);
});
