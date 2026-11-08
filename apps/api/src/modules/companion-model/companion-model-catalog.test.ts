import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listingForStoredManifest, selectPublishedCompanionModels } from "./companion-model-catalog.ts";

describe("selectPublishedCompanionModels", () => {
  const whale = { modelId: "companion-live2d-whale-v3", displayName: "大肥鱼", detail: "一直在的那只鲸鱼娘" };
  const fatfish = { modelId: "companion-live2d-fatfish-v4", displayName: "大肥鱼二号", detail: "蓝发女仆，白围裙，领口系着黑蝴蝶结。" };

  it("keeps the legacy manifest when no catalog has been published", () => {
    const published = selectPublishedCompanionModels([], whale, new Set([whale.modelId]));
    assert.deepEqual(published, [whale]);
  });

  it("drops a catalog entry whose manifest object is missing", () => {
    const published = selectPublishedCompanionModels([whale, fatfish], whale, new Set([whale.modelId]));
    assert.deepEqual(published.map(model => model.modelId), [whale.modelId]);
  });

  it("prefers the catalog name when the same model is also the legacy manifest", () => {
    const renamed = { ...whale, displayName: "目录里的名字" };
    const published = selectPublishedCompanionModels([renamed], whale, new Set([whale.modelId]));
    assert.deepEqual(published, [renamed]);
  });

  it("names the pre-catalog whale manifest when the object has no display name", () => {
    assert.deepEqual(listingForStoredManifest({ modelId: whale.modelId }), whale);
  });
});
