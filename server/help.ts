/**
 * Phase 071 — user guide and help system.
 *
 * Structured, in-app help content served by the `help` router so the Help screen
 * is data-driven and stays in sync with the real workflow. Mirrors the narrative
 * in docs/USER_GUIDE.md.
 */
export interface HelpTopic {
  id: string;
  title: string;
  body: string;
  step?: number; // position in the critical path, if applicable
}

export const HELP_TOPICS: HelpTopic[] = [
  { id: "getting-started", title: "Getting started", step: 0,
    body: "Create an account and sign in. LARO helps you describe a legal case, gather evidence, find suitable lawyers, and prepare outreach — you approve everything before anything is sent." },
  { id: "create-case", title: "Create a case", step: 1,
    body: "Go to Cases → New. Enter the client details and describe the situation. LARO automatically classifies the case into legal areas from your description." },
  { id: "evidence", title: "Add evidence", step: 2,
    body: "Attach documents or connect Gmail/Drive (if configured) to collect supporting materials. Each item keeps its source and a content hash for provenance." },
  { id: "document-map", title: "Reconstruct the document history", step: 3,
    body: "Open a case and choose Timeline, then Document map. Documents are dated stations and event categories are colored routes. Solid links come from source metadata or literal references. Dashed links are review-only similarity suggestions with confidence and supporting reasons. Focus the map on an analyzed participant or legal topic, then select a station to review its dated actions, trace its chain, or open the source document." },
  { id: "matching", title: "Review matched lawyers", step: 4,
    body: "Open a case to see ranked lawyer matches based on expertise, availability, response time and distance. No lawyer is contacted at this stage." },
  { id: "approval", title: "Prepare and approve outreach", step: 5,
    body: "Prepare outreach drafts, then review each one. Approving a draft marks it ready — nothing is sent automatically. You are always shown who will be contacted and a legal disclaimer first." },
  { id: "privacy", title: "Your data & privacy",
    body: "All data stays on your device (and your own configured cloud storage). You can export your data or erase the live account from Settings → Privacy. Recovery copies expire under the configured backup-retention policy." },
  { id: "disclaimer", title: "Important: not legal advice",
    body: "LARO provides assistance and preparation, not definitive legal advice. Always have generated documents and analyses reviewed by a qualified lawyer before relying on them." },
];

export function listHelpTopics(): HelpTopic[] {
  return [...HELP_TOPICS].sort((a, b) => (a.step ?? 99) - (b.step ?? 99));
}

export function getHelpTopic(id: string): HelpTopic | null {
  return HELP_TOPICS.find((t) => t.id === id) ?? null;
}
