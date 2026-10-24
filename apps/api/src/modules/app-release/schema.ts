import { z } from "zod";

export const RELEASE_PLATFORMS = ["ios", "android", "macos", "windows"] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];
export const CLIENT_ASSET_PLATFORMS = ["ios", "android"] as const;
export type ClientAssetPlatform = (typeof CLIENT_ASSET_PLATFORMS)[number];

const channelSchema = z.string().trim().min(1).max(32).regex(/^[a-z][a-z0-9-]{0,31}$/);
const versionSchema = z.string().trim().max(64).regex(/^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$/);
const sha256Schema = z.string().trim().regex(/^[a-f0-9]{64}$/);

export const releasePackageSchema = z.object({
  kind: z.enum(["full", "incremental", "blockmap", "manifest"]),
  name: z.string().trim().min(1).max(200),
  url: z.string().url().max(2048),
  mirrorUrl: z.string().url().max(2048).nullable().optional(),
  sha256: sha256Schema,
  byteLength: z.number().int().min(0).max(2 * 1024 * 1024 * 1024),
}).strict();
export type ReleasePackage = z.infer<typeof releasePackageSchema>;

export const appReleaseRegistrationSchema = z.object({
  platform: z.enum(RELEASE_PLATFORMS),
  channel: channelSchema.default("stable"),
  version: versionSchema,
  build: z.number().int().min(0).max(1_000_000).default(0),
  tag: z.string().trim().min(1).max(80),
  releasedAt: z.string().datetime({ offset: true }),
  notes: z.string().max(20_000).nullable().optional(),
  signed: z.boolean().default(false),
  packages: z.array(releasePackageSchema).min(1).max(32),
  desktopManifest: z.record(z.string(), z.string().max(200_000)).nullable().optional(),
  clientAssetsVersion: z.string().trim().max(96).nullable().optional(),
  activate: z.boolean().default(false),
}).strict();
export type AppReleaseRegistration = z.infer<typeof appReleaseRegistrationSchema>;

export const clientAssetFileSchema = z.object({
  path: z.string().trim().min(1).max(300),
  sha256: sha256Schema,
  byteLength: z.number().int().min(0).max(50 * 1024 * 1024),
}).strict();
export const clientAssetManifestFileSchema = clientAssetFileSchema.extend({
  url: z.string().url().max(2048),
}).strict();

export const clientAssetsRegistrationSchema = z.object({
  platform: z.enum(CLIENT_ASSET_PLATFORMS),
  channel: channelSchema.default("stable"),
  version: z.string().trim().min(1).max(96),
  baseVersion: z.string().trim().max(96).nullable().optional(),
  releasedAt: z.string().datetime({ offset: true }),
  manifest: z.object({
    version: z.string().trim().min(1).max(96),
    baseVersion: z.string().trim().max(96).nullable().optional(),
    createdAt: z.string().max(64).optional(),
    files: z.array(clientAssetManifestFileSchema).min(1).max(500),
  }).strict(),
  files: z.array(clientAssetFileSchema).min(1).max(500),
  activate: z.boolean().default(false),
}).strict();
export type ClientAssetsRegistration = z.infer<typeof clientAssetsRegistrationSchema>;

export const activateReleaseSchema = z.object({
  version: z.string().trim().min(1).max(96),
  force: z.boolean().default(false),
}).strict();

export const serverReleaseRegistrationSchema = z.object({
  version: versionSchema,
  tag: z.string().trim().min(1).max(80),
  commit: z.string().trim().max(64).nullable().optional(),
  imageDigests: z.record(z.string(), z.string().max(256)).nullable().optional(),
  releasedAt: z.string().datetime({ offset: true }),
  notes: z.string().max(20_000).nullable().optional(),
  activate: z.boolean().default(true),
}).strict();
export type ServerReleaseRegistration = z.infer<typeof serverReleaseRegistrationSchema>;


export const clientAssetUploadSchema = z.object({
  files: z.array(z.object({
    key: z.string().regex(/^(?:app-assets\/blobs\/[a-f0-9]{64}|app-releases\/(?:ios|android)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/),
    base64: z.string().min(1).max(8 * 1024 * 1024),
  })).min(1).max(500),
}).strict();

export const versionQuerySchema = z.object({
  platform: z.enum(RELEASE_PLATFORMS).default("ios"),
  channel: channelSchema.default("stable"),
}).strict();

export const assetManifestQuerySchema = z.object({
  platform: z.enum(CLIENT_ASSET_PLATFORMS).default("ios"),
  channel: channelSchema.default("stable"),
  version: z.string().trim().min(1).max(96).optional(),
}).strict();
