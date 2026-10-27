import { allowedMainRouteV2Schema, type CompanionContentBlockV1 } from "@astella/shared";
import { logger } from "../../lib/logger.ts";
import type { AgentToolExecutionResult } from "../tools/companion-tool-result.ts";

/** Fresh and replayed tool receipts use the same route validation and block order. */
export function companionExecutionBlocks(
  result: Pick<AgentToolExecutionResult, "route" | "routeLabel" | "blocks">,
  source: { runId: string; toolName?: string; fallbackLabel: string },
): CompanionContentBlockV1[] {
  const blocks: CompanionContentBlockV1[] = [];
  if (result.route) {
    const route = allowedMainRouteV2Schema.safeParse(result.route);
    if (route.success) blocks.push({ type: "nav",
      label: (result.routeLabel ?? source.fallbackLabel).slice(0, 80), route: route.data });
    else logger.warn({ runId: source.runId, tool: source.toolName },
      "companion agent produced a route outside the allowed main-route schema; nav block dropped");
  }
  return [...blocks, ...(result.blocks ?? [])];
}
