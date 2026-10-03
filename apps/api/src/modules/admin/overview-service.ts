/**
 * 运维面板的概览（`/admin/overview`）——服务身份、能力开关、启动信息。
 *
 * ## 为什么开关只能看不能改
 *
 * 仓库的能力开关是**环境变量**，由 `.github/scripts/verify-companion-capability-config.mjs`
 * 双向断言「每个服务恰好声明它真实读取的开关」，且 dev/prod 默认值不同。
 * 面板提供一个"改开关"的开关，写进去的值在下一个进程重启时就被 compose 覆盖——
 * 一个点了没用的控件比没有控件更糟。
 *
 * 所以这里展示的是 `apps/api/src/config/learning-companion-flags.ts` 里**那些函数
 * 此刻的真实返回值**，而不是把 `process.env` 原样倒出来。差别在于：前者回答
 * 「这个部署现在到底能不能用学习运行」，后者回答「环境变量里写了什么」——
 * 后者在一份 .env 与实际运行时不一致时会撒谎。
 */

import {
  isCardGenerationV2Enabled,
  isCompanionDialogueEnabled,
  isCompanionJourneyV2Enabled,
  isCompanionVoiceDialogueEnabled,
  isLearningRunEnabled,
  isMemoryContextEnabled,
  isMemoryVectorRebuildEnabled,
  isPetProfileEnabled,
} from "../../config/learning-companion-flags.ts";
import { adminLogBuffer } from "../../lib/log-buffer.ts";
import { CAPABILITY_LABELS } from "./labels.ts";

export interface CapabilityFlagView {
  key: string;
  label: string;
  enabled: boolean;
  /** 该开关背后的**判据**（可能不止一个条件），供面板展开查看。 */
  detail: string;
}

export interface OverviewSnapshot {
  service: {
    name: string;
    version: string;
    nodeEnv: string;
    pid: number;
    startedAt: string;
    uptimeSeconds: number;
    nodeVersion: string;
  };
  release: { version: string | null; commit: string | null; migrations: string | null };
  database: { poolMax: number | null };
  capabilities: CapabilityFlagView[];
  config: { path: string; exists: boolean };
  logBuffer: { capacity: number; size: number };
}

/** 进程启动时刻。取模块加载时间近似——不需要为此多存一个全局。 */
const PROCESS_STARTED_AT = new Date();

function envVersion(): { version: string | null; commit: string | null } {
  return {
    version: process.env.APP_VERSION?.trim() || null,
    commit: process.env.GIT_COMMIT?.trim() || null,
  };
}

export async function readOverview(configPath: string, configExists: boolean): Promise<OverviewSnapshot> {
  const release = envVersion();
  const dbPoolMax = Number(process.env.DB_POOL_MAX ?? process.env.API_DB_POOL_MAX ?? "");

  const capabilities: CapabilityFlagView[] = [
    {
      key: "LEARNING_RUN_ENABLED",
      ...CAPABILITY_LABELS.LEARNING_RUN_ENABLED,
      enabled: isLearningRunEnabled(),
    },
    {
      key: "CARD_GENERATION_V2_ENABLED",
      ...CAPABILITY_LABELS.CARD_GENERATION_V2_ENABLED,
      enabled: isCardGenerationV2Enabled(),
    },
    {
      key: "COMPANION_DIALOGUE_V1_ENABLED",
      ...CAPABILITY_LABELS.COMPANION_DIALOGUE_V1_ENABLED,
      enabled: isCompanionDialogueEnabled(),
    },
    {
      key: "COMPANION_VOICE_DIALOGUE_V1_ENABLED",
      ...CAPABILITY_LABELS.COMPANION_VOICE_DIALOGUE_V1_ENABLED,
      enabled: isCompanionVoiceDialogueEnabled(),
    },
    {
      key: "COMPANION_JOURNEY_V2",
      ...CAPABILITY_LABELS.COMPANION_JOURNEY_V2,
      enabled: isCompanionJourneyV2Enabled(),
    },
    {
      key: "COMPANION_MEMORY_VECTOR_V1",
      ...CAPABILITY_LABELS.COMPANION_MEMORY_VECTOR_V1,
      enabled: isMemoryVectorRebuildEnabled(),
    },
    {
      // 派生判据，不是单一环境变量：MEMORY_VECTOR_V1 或 JOURNEY_V2 任一为真即开。
      key: "COMPANION_MEMORY_CONTEXT",
      ...CAPABILITY_LABELS.COMPANION_MEMORY_CONTEXT,
      enabled: isMemoryContextEnabled(),
    },
    {
      // 同上：MEMORY_VECTOR 不参与，这里只看 PET_PROFILE_V1 或 JOURNEY_V2。
      key: "COMPANION_PET_PROFILE_V1",
      ...CAPABILITY_LABELS.COMPANION_PET_PROFILE_V1,
      enabled: isPetProfileEnabled(),
    },
  ];

  return {
    service: {
      name: "ailearn-api",
      version: release.version ?? "dev",
      nodeEnv: process.env.NODE_ENV ?? "development",
      pid: process.pid,
      startedAt: PROCESS_STARTED_AT.toISOString(),
      uptimeSeconds: Math.max(0, Math.round((Date.now() - PROCESS_STARTED_AT.getTime()) / 1000)),
      nodeVersion: process.version,
    },
    release: { ...release, migrations: process.env.MIGRATION_COUNT?.trim() || null },
    database: {
      poolMax: Number.isInteger(dbPoolMax) && dbPoolMax > 0 ? dbPoolMax : null,
    },
    capabilities,
    config: { path: configPath, exists: configExists },
    logBuffer: {
      capacity: adminLogBuffer.capacity,
      size: adminLogBuffer.size,
    },
  };
}