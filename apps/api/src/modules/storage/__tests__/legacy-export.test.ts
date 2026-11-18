import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyReply, FastifyRequest } from "fastify";
import { objectExportHook } from "../exports.ts";

test("legacy export returns its original body without using remote storage", async () => {
  const previousMode = process.env.STORAGE_MODE;
  process.env.STORAGE_MODE = "remote";
  try {
    const payload = '{"notes":[]}';
    const request = {
      headers: {},
      url: "/export/workspace",
      session: { workspaceId: "workspace", userId: "user" },
    } as unknown as FastifyRequest;
    const reply = { statusCode: 200 } as FastifyReply;
    assert.equal(await objectExportHook(request, reply, payload), payload);
  } finally {
    if (previousMode === undefined) delete process.env.STORAGE_MODE;
    else process.env.STORAGE_MODE = previousMode;
  }
});
