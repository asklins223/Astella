/**
 * 伴星形象目录：客户端能看到的名单、名字和介绍都从这里来。
 *
 * 对象存储里的 `catalog.json` 是发布名单。每一条还要能对上真实的清单对象，
 * 对不上的（登记了但文件没传上去）不会出现在返回里。
 * 2026-11-05 之前只有一份平铺清单，没有目录文件；那一份仍然算已发布，
 * 名字用当时客户端一直显示的那句，避免老部署突然变成空白名单。
 */
import { z } from "zod";
import {
  companionModelCatalogEntryV1Schema,
  type CompanionModelCatalogEntryV1,
} from "@astella/shared/companion-shell-contracts";

export type { CompanionModelCatalogEntryV1 };

export const companionModelCatalogDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  models: z.array(companionModelCatalogEntryV1Schema).max(32),
});

const publishedBeforeCatalog: Record<string, { displayName: string; detail: string }> = {
  "companion-live2d-whale-v3": {
    displayName: "大肥鱼",
    detail: "一直在的那只鲸鱼娘",
  },
};

export function listingForStoredManifest(manifest: {
  modelId: string;
  displayName?: string;
  detail?: string;
}): CompanionModelCatalogEntryV1 {
  const known = publishedBeforeCatalog[manifest.modelId];
  return companionModelCatalogEntryV1Schema.parse({
    modelId: manifest.modelId,
    displayName: manifest.displayName ?? known?.displayName ?? manifest.modelId,
    detail: manifest.detail ?? known?.detail ?? "",
  });
}

/**
 * 目录条目加上旧的单模型清单，再丢掉对象存储里没有清单的那些。
 * 同一 modelId 只留目录里的那条（名字以发布目录为准）；目录没有时才用旧清单。
 */
export function selectPublishedCompanionModels(
  catalog: readonly CompanionModelCatalogEntryV1[],
  legacy: CompanionModelCatalogEntryV1 | null,
  availableModelIds: ReadonlySet<string>,
): CompanionModelCatalogEntryV1[] {
  const models = [...catalog];
  if (legacy && !models.some(model => model.modelId === legacy.modelId)) models.unshift(legacy);
  const seen = new Set<string>();
  return models.filter(model => {
    if (seen.has(model.modelId) || !availableModelIds.has(model.modelId)) return false;
    seen.add(model.modelId);
    return true;
  });
}
