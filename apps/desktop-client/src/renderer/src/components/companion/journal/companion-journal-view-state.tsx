import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useCompanionResultPreview } from "./companion-result-preview";

const JournalDisclosureContext = createContext<Map<string, boolean> | null>(null);

/** Call in the persistent drawer owner, above the paper's mount boundary. */
export function useCompanionJournalViewState(conversationId: string | null) {
  return useMemo(() => new Map<string, boolean>(), [conversationId]);
}

export function CompanionJournalViewState({ choices, children }: {
  readonly choices: Map<string, boolean>;
  readonly children: ReactNode;
}) {
  return <JournalDisclosureContext.Provider value={choices}>{children}</JournalDisclosureContext.Provider>;
}

/** Only explicit choices persist. Automatic expansion follows the current stream. */
export function useJournalDisclosure(key: string, autoOpen = false) {
  const fallback = useCompanionResultPreview(state => state.disclosures);
  const choices = useContext(JournalDisclosureContext) ?? fallback;
  const [choice, setChoice] = useState<{ key: string; choices: typeof choices; open: boolean | undefined }>(() => ({
    key, choices, open: choices?.get(key),
  }));
  const expanded = choice.key === key && choice.choices === choices
    ? choice.open ?? autoOpen : choices?.get(key) ?? autoOpen;
  const toggle = () => {
    choices?.set(key, !expanded);
    setChoice({ key, choices, open: !expanded });
  };
  return [expanded, toggle] as const;
}
