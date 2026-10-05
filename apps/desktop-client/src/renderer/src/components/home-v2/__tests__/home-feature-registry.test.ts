import { describe, expect, it } from "vitest";
import {
  HOME_FEATURE_IDS,
  HOME_FEATURE_REGION_IDS,
  HOME_FEATURE_REGISTRY_V1,
  getHomeFeature,
  homeFeatureRegistryIssues,
  homeFeaturesForRegion,
} from "../home-feature-registry.ts";

describe("HomeFeatureRegistryV1", () => {
  it("declares every feature id exactly once with complete copy", () => {
    expect(HOME_FEATURE_REGISTRY_V1).toHaveLength(HOME_FEATURE_IDS.length);
    expect(new Set(HOME_FEATURE_REGISTRY_V1.map((feature) => feature.id)).size).toBe(HOME_FEATURE_IDS.length);
    expect(homeFeatureRegistryIssues()).toEqual([]);
  });

  it("hangs every room feature on one of the four objects in the room", () => {
    const regionFeatureIds = HOME_FEATURE_REGION_IDS.flatMap((region) => homeFeaturesForRegion(region).map((feature) => feature.id));
    const expectedRegionIds = HOME_FEATURE_REGISTRY_V1.filter((feature) => feature.region !== "system").map((feature) => feature.id);
    expect(new Set(regionFeatureIds)).toEqual(new Set(expectedRegionIds));
  });

  it("no longer carries the catalog page that used to duplicate the room", () => {
    // 2026-10-05 用户决定：魔法目录整页删除。那张全屏清单里的每一条都已经是房间里
    // 四件东西上的一个入口，所以「catalog」这条功能本身不该再存在。
    expect(HOME_FEATURE_IDS).not.toContain("catalog");
    expect(HOME_FEATURE_REGISTRY_V1.map((feature) => feature.id)).not.toContain("catalog");
  });

  it("keeps every implemented surface executable and leaves write-only features pending", () => {
    expect(getHomeFeature("companion-center").availability).toBe("native");
    expect(HOME_FEATURE_REGISTRY_V1.filter((feature) => feature.availability === "native").map((feature) => feature.id)).toEqual([
      "continue",
      "today-review",
      "current-notebook",
      "all-notes",
      "sources",
      "global-search",
      "current-target",
      "understanding-graph",
      "companion-center",
      "settings",
    ]);
    for (const feature of HOME_FEATURE_REGISTRY_V1.filter((candidate) => candidate.availability === "pending")) {
      expect(feature.pendingTitle).toBeTruthy();
      expect(feature.pendingDetail).toBeTruthy();
    }
  });
});
