/**
 * Per-turn route record (`companion_turn_runs.route`, migration 0442).
 *
 * The record used to carry classifier, speculation and L1 release-router
 * readings. Those entries are gone; what remains is the shape the turn was
 * entered with. The column stays open JSONB so diagnostics can add readings
 * without another migration.
 */

import { logger } from "../../lib/logger.ts";
import { updateRunMeta } from "./companion-agent-events.ts";
import type { AgentEventContext } from "../tools/companion-read-tools.ts";
import type { CompanionEntryMode } from "../turn/companion-entry-mode.ts";
import type { CompanionTurnWorkload } from "../turn/companion-turn-workload.ts";

export interface CompanionRouteRecordV1 {
  readonly version: 1;
  readonly entryMode?: CompanionEntryMode;
  readonly workload?: CompanionTurnWorkload;
}

export interface CompanionRouteRecorderOptions {
  readonly entryMode?: CompanionEntryMode;
  readonly workload?: CompanionTurnWorkload;
}

export interface CompanionRouteRecorder {
  /** One call per turn: writes the record into run meta. Never awaited; a
   * failure only warns and never affects the turn. */
  record(event: AgentEventContext): void;
}

export type CompanionRouteMetaWriter = (
  event: AgentEventContext,
  patch: { route: CompanionRouteRecordV1 },
) => Promise<void>;

export function createCompanionRouteRecorder(
  options: CompanionRouteRecorderOptions = {},
  writeMeta: CompanionRouteMetaWriter = (event, patch) => updateRunMeta(event, patch),
): CompanionRouteRecorder {
  return {
    record(event) {
      const route: CompanionRouteRecordV1 = {
        version: 1,
        ...(options.entryMode ? { entryMode: options.entryMode } : {}),
        ...(options.workload ? { workload: options.workload } : {}),
      };
      void writeMeta(event, { route }).catch((err: unknown) => {
        logger.warn({ runId: event.read.runId, err: err instanceof Error ? err.message : String(err) },
          "companion route record write failed; turn unaffected");
      });
    },
  };
}
