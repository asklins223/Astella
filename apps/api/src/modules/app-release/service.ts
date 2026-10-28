import { sql } from "drizzle-orm";
import { DomainError } from "@astella/shared";
import { db } from "../../db/client.ts";
import { compareVersions } from "./version.ts";
export { compareVersions } from "./version.ts";
import type {
  AppReleaseRegistration,
  ClientAssetPlatform,
  ClientAssetsRegistration,
  ReleasePackage,
  ReleasePlatform,
  ServerReleaseRegistration,
} from "./schema.ts";

export class ReleaseCenterError extends DomainError {
  constructor(statusCode: number, code: string, message: string) {
    super({ name: "ReleaseCenterError", code, message, statusCode });
  }
}

export interface AppReleaseRecord {
  id: string;
  platform: ReleasePlatform;
  channel: string;
  version: string;
  build: number;
  tag: string;
  releasedAt: string;
  notes: string | null;
  signed: boolean;
  packages: ReleasePackage[];
  desktopManifest: Record<string, string> | null;
  clientAssetsVersion: string | null;
  isCurrent: boolean;
}

export interface ClientAssetRecord {
  id: string;
  platform: ClientAssetPlatform;
  channel: string;
  version: string;
  baseVersion: string | null;
  manifest: Record<string, unknown>;
  fileCount: number;
  totalBytes: number;
  releasedAt: string;
  isCurrent: boolean;
}

export interface ServerReleaseRecord {
  id: string;
  version: string;
  tag: string;
  commit: string | null;
  imageDigests: Record<string, string> | null;
  releasedAt: string;
  notes: string | null;
  isCurrent: boolean;
}

type Row = Record<string, unknown>;
const asRows = (value: unknown): Row[] => (Array.isArray(value) ? value as Row[] : []);
const iso = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  const text = String(value ?? "");
  if (!text) return "";
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
};

function mapAppRelease(row: Row): AppReleaseRecord {
  return {
    id: String(row.id),
    platform: row.platform as ReleasePlatform,
    channel: String(row.channel),
    version: String(row.version),
    build: Number(row.build ?? 0),
    tag: String(row.tag),
    releasedAt: iso(row.released_at),
    notes: typeof row.notes === "string" ? row.notes : null,
    signed: row.signed === true,
    packages: Array.isArray(row.packages) ? row.packages as ReleasePackage[] : [],
    desktopManifest: row.desktop_manifest && typeof row.desktop_manifest === "object"
      ? row.desktop_manifest as Record<string, string> : null,
    clientAssetsVersion: typeof row.client_assets_version === "string" ? row.client_assets_version : null,
    isCurrent: row.is_current === true,
  };
}

function mapClientAsset(row: Row): ClientAssetRecord {
  return {
    id: String(row.id),
    platform: row.platform as ClientAssetPlatform,
    channel: String(row.channel),
    version: String(row.version),
    baseVersion: typeof row.base_version === "string" ? row.base_version : null,
    manifest: (row.manifest ?? {}) as Record<string, unknown>,
    fileCount: Number(row.file_count ?? 0),
    totalBytes: Number(row.total_bytes ?? 0),
    releasedAt: iso(row.released_at),
    isCurrent: row.is_current === true,
  };
}

function mapServerRelease(row: Row): ServerReleaseRecord {
  return {
    id: String(row.id),
    version: String(row.version),
    tag: String(row.tag),
    commit: typeof row.commit === "string" ? row.commit : null,
    imageDigests: row.image_digests && typeof row.image_digests === "object"
      ? row.image_digests as Record<string, string> : null,
    releasedAt: iso(row.released_at),
    notes: typeof row.notes === "string" ? row.notes : null,
    isCurrent: row.is_current === true,
  };
}


export async function readCurrentRelease(platform: ReleasePlatform, channel: string): Promise<AppReleaseRecord | null> {
  const rows = asRows(await db.execute(sql`
    SELECT * FROM public.app_releases
    WHERE platform = ${platform} AND channel = ${channel} AND is_current
    ORDER BY released_at DESC LIMIT 1`));
  return rows[0] ? mapAppRelease(rows[0]) : null;
}

export async function readReleaseHistory(platform: ReleasePlatform, channel: string, limit = 20): Promise<AppReleaseRecord[]> {
  const rows = asRows(await db.execute(sql`
    SELECT * FROM public.app_releases
    WHERE platform = ${platform} AND channel = ${channel}
    ORDER BY released_at DESC LIMIT ${limit}`));
  return rows.map(mapAppRelease);
}

export async function registerAppRelease(input: AppReleaseRegistration): Promise<AppReleaseRecord> {
  const rows = asRows(await db.execute(sql`
    INSERT INTO public.app_releases
      (platform, channel, version, build, tag, released_at, notes, signed, packages, desktop_manifest, client_assets_version, is_current)
    VALUES
      (${input.platform}, ${input.channel}, ${input.version}, ${input.build}, ${input.tag}, ${input.releasedAt},
       ${input.notes ?? null}, ${input.signed}, ${JSON.stringify(input.packages)}::jsonb,
       ${input.desktopManifest ? JSON.stringify(input.desktopManifest) : null}::jsonb,
       ${input.clientAssetsVersion ?? null}, false)
    ON CONFLICT (platform, channel, version) DO UPDATE SET
      build = EXCLUDED.build,
      tag = EXCLUDED.tag,
      released_at = EXCLUDED.released_at,
      notes = EXCLUDED.notes,
      signed = EXCLUDED.signed,
      packages = EXCLUDED.packages,
      desktop_manifest = EXCLUDED.desktop_manifest,
      client_assets_version = EXCLUDED.client_assets_version
    RETURNING *`));
  const release = mapAppRelease(rows[0]);
  if (input.activate) {
    // Unsigned mobile builds may be current too. "Current" answers "which
    // build is the newest release", and hot-update assets ride along with it;
    // whether the package itself can be installed is a separate fact that
    // travels as `signed` and is enforced by the client, which only offers a
    // download for a signed package. Refusing to activate unsigned builds left
    // iOS permanently at release_not_found — a dev-signed phone could not even
    // learn that a newer build existed.
    await activateRelease(input.platform, input.channel, input.version);
    return { ...release, isCurrent: true };
  }
  return release;
}

export async function activateRelease(
  platform: ReleasePlatform,
  channel: string,
  version: string,
  options: { force?: boolean } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const currentRows = asRows(await tx.execute(sql`
      SELECT version FROM public.app_releases
      WHERE platform = ${platform} AND channel = ${channel} AND is_current LIMIT 1`));
    const current = currentRows[0] ? String(currentRows[0].version) : null;
    if (!options.force && current && version !== current && compareVersions(version, current) <= 0) {
      throw new ReleaseCenterError(409, "release_downgrade", `版本 ${version} 不大于当前版本 ${current}；回滚请显式 force`);
    }
    await tx.execute(sql`
      UPDATE public.app_releases SET is_current = false
      WHERE platform = ${platform} AND channel = ${channel} AND is_current`);
    const updated = asRows(await tx.execute(sql`
      UPDATE public.app_releases SET is_current = true
      WHERE platform = ${platform} AND channel = ${channel} AND version = ${version}
      RETURNING id`));
    if (updated.length === 0) throw new ReleaseCenterError(404, "release_not_found", `没有找到版本 ${version}`);
  });
}

export async function readCurrentAssets(platform: ClientAssetPlatform, channel: string): Promise<ClientAssetRecord | null> {
  const rows = asRows(await db.execute(sql`
    SELECT * FROM public.client_asset_releases
    WHERE platform = ${platform} AND channel = ${channel} AND is_current
    ORDER BY released_at DESC LIMIT 1`));
  return rows[0] ? mapClientAsset(rows[0]) : null;
}

export async function readAssetVersion(platform: ClientAssetPlatform, channel: string, version: string): Promise<ClientAssetRecord | null> {
  const rows = asRows(await db.execute(sql`
    SELECT * FROM public.client_asset_releases
    WHERE platform = ${platform} AND channel = ${channel} AND version = ${version}
    LIMIT 1`));
  return rows[0] ? mapClientAsset(rows[0]) : null;
}

export async function readAssetHistory(platform: ClientAssetPlatform, channel: string, limit = 20): Promise<ClientAssetRecord[]> {
  const rows = asRows(await db.execute(sql`
    SELECT * FROM public.client_asset_releases
    WHERE platform = ${platform} AND channel = ${channel}
    ORDER BY released_at DESC LIMIT ${limit}`));
  return rows.map(mapClientAsset);
}

export async function registerClientAssets(input: ClientAssetsRegistration): Promise<ClientAssetRecord> {
  const totalBytes = input.files.reduce((sum, file) => sum + file.byteLength, 0);
  const rows = asRows(await db.execute(sql`
    INSERT INTO public.client_asset_releases
      (platform, channel, version, base_version, manifest, file_count, total_bytes, released_at, is_current)
    VALUES
      (${input.platform}, ${input.channel}, ${input.version}, ${input.baseVersion ?? null},
       ${JSON.stringify(input.manifest)}::jsonb, ${input.files.length}, ${totalBytes}, ${input.releasedAt}, false)
    ON CONFLICT (platform, channel, version) DO UPDATE SET
      base_version = EXCLUDED.base_version,
      manifest = EXCLUDED.manifest,
      file_count = EXCLUDED.file_count,
      total_bytes = EXCLUDED.total_bytes,
      released_at = EXCLUDED.released_at
    RETURNING *`));
  const asset = mapClientAsset(rows[0]);
  if (input.activate) {
    await activateAssets(input.platform, input.channel, input.version);
    return { ...asset, isCurrent: true };
  }
  return asset;
}

export async function activateAssets(platform: ClientAssetPlatform, channel: string, version: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE public.client_asset_releases SET is_current = false
      WHERE platform = ${platform} AND channel = ${channel} AND is_current`);
    const updated = asRows(await tx.execute(sql`
      UPDATE public.client_asset_releases SET is_current = true
      WHERE platform = ${platform} AND channel = ${channel} AND version = ${version}
      RETURNING id`));
    if (updated.length === 0) throw new ReleaseCenterError(404, "asset_release_not_found", `没有找到资产版本 ${version}`);
  });
}

export async function readCurrentServerRelease(): Promise<ServerReleaseRecord | null> {
  const rows = asRows(await db.execute(sql`
    SELECT * FROM public.server_releases WHERE is_current ORDER BY released_at DESC LIMIT 1`));
  return rows[0] ? mapServerRelease(rows[0]) : null;
}

export async function readServerReleaseHistory(limit = 20): Promise<ServerReleaseRecord[]> {
  const rows = asRows(await db.execute(sql`
    SELECT * FROM public.server_releases ORDER BY released_at DESC LIMIT ${limit}`));
  return rows.map(mapServerRelease);
}

export async function registerServerRelease(input: ServerReleaseRegistration): Promise<ServerReleaseRecord> {
  const rows = asRows(await db.execute(sql`
    INSERT INTO public.server_releases
      (version, tag, commit, image_digests, released_at, notes, is_current)
    VALUES
      (${input.version}, ${input.tag}, ${input.commit ?? null},
       ${input.imageDigests ? JSON.stringify(input.imageDigests) : null}::jsonb,
       ${input.releasedAt}, ${input.notes ?? null}, false)
    ON CONFLICT (version) DO UPDATE SET
      tag = EXCLUDED.tag,
      commit = EXCLUDED.commit,
      image_digests = EXCLUDED.image_digests,
      released_at = EXCLUDED.released_at,
      notes = EXCLUDED.notes
    RETURNING *`));
  const release = mapServerRelease(rows[0]);
  if (input.activate) {
    await activateServerRelease(input.version);
    return { ...release, isCurrent: true };
  }
  return release;
}

export async function activateServerRelease(version: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE public.server_releases SET is_current = false WHERE is_current`);
    const updated = asRows(await tx.execute(sql`
      UPDATE public.server_releases SET is_current = true WHERE version = ${version} RETURNING id`));
    if (updated.length === 0) throw new ReleaseCenterError(404, "server_release_not_found", `没有找到服务端版本 ${version}`);
  });
}

export interface ReleaseOverview {
  server: { current: ServerReleaseRecord | null; history: ServerReleaseRecord[] };
  desktop: { current: AppReleaseRecord[]; history: AppReleaseRecord[] };
  ios: { current: AppReleaseRecord | null; history: AppReleaseRecord[] };
  android: { current: AppReleaseRecord | null; history: AppReleaseRecord[] };
  assets: {
    ios: { current: ClientAssetRecord | null; history: ClientAssetRecord[] };
    android: { current: ClientAssetRecord | null; history: ClientAssetRecord[] };
  };
}

/** 运维面板的版本控制总览：每个发布线的当前指针 + 最近历史。 */
export async function readReleaseOverview(): Promise<ReleaseOverview> {
  const [serverCurrent, serverHistory, iosCurrent, iosHistory, androidCurrent, androidHistory,
    macosHistory, windowsHistory, iosAssetCurrent, iosAssetHistory, androidAssetCurrent, androidAssetHistory] = await Promise.all([
    readCurrentServerRelease(),
    readServerReleaseHistory(20),
    readCurrentRelease("ios", "stable"),
    readReleaseHistory("ios", "stable", 20),
    readCurrentRelease("android", "stable"),
    readReleaseHistory("android", "stable", 20),
    readReleaseHistory("macos", "stable", 20),
    readReleaseHistory("windows", "stable", 20),
    readCurrentAssets("ios", "stable"),
    readAssetHistory("ios", "stable", 20),
    readCurrentAssets("android", "stable"),
    readAssetHistory("android", "stable", 20),
  ]);
  return {
    server: { current: serverCurrent, history: serverHistory },
    desktop: { current: [...macosHistory, ...windowsHistory].filter((release) => release.isCurrent), history: [...macosHistory, ...windowsHistory] },
    ios: { current: iosCurrent, history: iosHistory },
    android: { current: androidCurrent, history: androidHistory },
    assets: {
      ios: { current: iosAssetCurrent, history: iosAssetHistory },
      android: { current: androidAssetCurrent, history: androidAssetHistory },
    },
  };
}


/** 桌面更新清单：Release Center 的当前版本寄存器；没有时调用方回退 GitHub 缓存。 */
export async function readDesktopUpdateManifest(channelFile: "latest.yml" | "latest-mac.yml"): Promise<string | null> {
  const platform: ReleasePlatform = channelFile === "latest.yml" ? "windows" : "macos";
  const release = await readCurrentRelease(platform, "stable");
  const manifest = release?.desktopManifest?.[channelFile];
  return typeof manifest === "string" && manifest.trim().length > 0 ? manifest : null;
}
