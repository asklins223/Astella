-- 0454: Release Center — 客户端版本、热更新资产与服务端版本记录（2026-10-24）。
--
-- 设计见 docs/plans/app-release-center-2026-10-24.md。PostgreSQL 是“最新版本”的唯一
-- 事实源：iOS / Android / macOS / Windows 的客户端版本、热更新资产清单、服务端部署版本
-- 都记录在这里，客户端只问自家 API，不再在运行时读取 GitHub。
--
-- 这三张表都是全局数据（不按 workspace 隔离），因此**不启用 RLS**、不新增 policy；
-- 与 update_manifest_cache 相同，api 进程需要读写，migrator 需要全部权限。
--> statement-breakpoint
CREATE TABLE public.app_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'macos', 'windows')),
  channel text NOT NULL DEFAULT 'stable' CHECK (channel ~ '^[a-z][a-z0-9-]{0,31}$'),
  version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$'),
  build integer NOT NULL DEFAULT 0,
  tag text NOT NULL,
  released_at timestamptz NOT NULL,
  notes text,
  signed boolean NOT NULL DEFAULT false,
  packages jsonb NOT NULL DEFAULT '[]'::jsonb,
  desktop_manifest jsonb,
  client_assets_version text,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, channel, version)
);
--> statement-breakpoint
CREATE UNIQUE INDEX app_releases_one_current_idx
  ON public.app_releases (platform, channel)
  WHERE is_current;
--> statement-breakpoint
CREATE INDEX app_releases_history_idx
  ON public.app_releases (platform, channel, released_at DESC);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.app_releases TO astella_api;
--> statement-breakpoint
GRANT ALL PRIVILEGES ON public.app_releases TO astella_migrator;
--> statement-breakpoint
CREATE TABLE public.client_asset_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  channel text NOT NULL DEFAULT 'stable' CHECK (channel ~ '^[a-z][a-z0-9-]{0,31}$'),
  version text NOT NULL,
  base_version text,
  manifest jsonb NOT NULL,
  file_count integer NOT NULL DEFAULT 0,
  total_bytes bigint NOT NULL DEFAULT 0,
  released_at timestamptz NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, channel, version)
);
--> statement-breakpoint
CREATE UNIQUE INDEX client_asset_releases_one_current_idx
  ON public.client_asset_releases (platform, channel)
  WHERE is_current;
--> statement-breakpoint
CREATE INDEX client_asset_releases_history_idx
  ON public.client_asset_releases (platform, channel, released_at DESC);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.client_asset_releases TO astella_api;
--> statement-breakpoint
GRANT ALL PRIVILEGES ON public.client_asset_releases TO astella_migrator;
--> statement-breakpoint
CREATE TABLE public.server_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL,
  tag text NOT NULL,
  commit text,
  image_digests jsonb,
  released_at timestamptz NOT NULL,
  notes text,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version)
);
--> statement-breakpoint
CREATE UNIQUE INDEX server_releases_one_current_idx
  ON public.server_releases ((is_current))
  WHERE is_current;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.server_releases TO astella_api;
--> statement-breakpoint
GRANT ALL PRIVILEGES ON public.server_releases TO astella_migrator;
