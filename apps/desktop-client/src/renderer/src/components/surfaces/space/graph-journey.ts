import type { DeepeningLayer, StateFilter } from "./graph-surface-types";
import type { UniverseViewport } from "./understanding-universe";

export type GraphJourney = {
  query: string;
  stateFilter: StateFilter;
  showEvidence: boolean;
  showSources: boolean;
  showLinks: boolean;
  selectedId: string | null;
  layer: DeepeningLayer;
  listMode: boolean;
  viewport: UniverseViewport | null;
  shelfScrollTop: number;
  detailScrollTop: number;
};

// A return ticket, scoped to the real workspace. It is consumed on the next visit.
const journeys = new Map<string, GraphJourney>();
export function rememberGraphJourney(workspaceId: string, journey: GraphJourney) {
  if (journeys.size > 12) journeys.clear();
  journeys.set(workspaceId, journey);
}
export function takeGraphJourney(workspaceId: string) {
  const journey = journeys.get(workspaceId) ?? null;
  journeys.delete(workspaceId);
  return journey;
}
export function clearGraphJourneys() { journeys.clear(); }
