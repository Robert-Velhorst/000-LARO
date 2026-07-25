import type { DocumentAnalysisResult } from "./documentIntelligence";

export type ReconstructionRoute =
  | "employment"
  | "termination"
  | "communication"
  | "legal"
  | "financial"
  | "other";

export type ReconstructionEvidence = "explicit" | "inferred";

export type ReconstructionRelationship =
  | "attachment_of"
  | "references"
  | "responds_to"
  | "related";

export type ReconstructionDocument = {
  evidenceId: string;
  title: string;
  description: string | null;
  source: string | null;
  type: string;
  metadata: string | null;
  createdAt: Date | null;
  analysis: DocumentAnalysisResult | null;
};

export type ReconstructionEvent = {
  date: string;
  title: string;
  description: string;
  actor: string | null;
  category: ReconstructionRoute;
  source: { evidenceId: string };
};

export type ReconstructionNode = {
  id: string;
  title: string;
  date: string;
  route: ReconstructionRoute;
  summary: string;
  actor: string | null;
  documentType: string;
  source: string | null;
  eventCount: number;
  analysisStatus: "complete" | "missing";
  confidence: number | null;
  participants: string[];
  topics: string[];
  actions: Array<{
    date: string;
    title: string;
    description: string;
    actor: string | null;
  }>;
};

export type ReconstructionEdge = {
  id: string;
  from: string;
  to: string;
  relationship: ReconstructionRelationship;
  evidence: ReconstructionEvidence;
  confidence: number;
  basis: string[];
};

export type ReconstructionPhase = {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  documentIds: string[];
  documentCount: number;
  eventCount: number;
  summary: string;
};

export type ReconstructionChain = {
  id: string;
  documentIds: string[];
  edgeIds: string[];
  startDate: string;
  endDate: string;
  explicitLinkCount: number;
  inferredLinkCount: number;
  confidence: number;
};

export type ReconstructionKeyMoment = {
  documentId: string;
  date: string;
  title: string;
  reason: string;
  verifiedLinkCount: number;
  eventCount: number;
};

export type CaseReconstruction = {
  schemaVersion: 2;
  nodes: ReconstructionNode[];
  edges: ReconstructionEdge[];
  routes: Array<{
    id: ReconstructionRoute;
    label: string;
    documentCount: number;
    eventCount: number;
  }>;
  phases: ReconstructionPhase[];
  chains: ReconstructionChain[];
  keyMoments: ReconstructionKeyMoment[];
  warnings: string[];
};

const ROUTE_ORDER: ReconstructionRoute[] = [
  "communication",
  "legal",
  "financial",
  "employment",
  "termination",
  "other",
];

const ROUTE_LABELS: Record<ReconstructionRoute, string> = {
  communication: "Communication",
  legal: "Legal process",
  financial: "Financial",
  employment: "Employment",
  termination: "Termination",
  other: "Other evidence",
};

const STOP_WORDS = new Set([
  "about", "after", "again", "also", "because", "before", "being", "between", "could", "document",
  "from", "have", "into", "more", "other", "should", "their", "there", "these", "this", "through",
  "under", "where", "which", "would", "your", "aldus", "alleen", "binnen", "daarom", "deze", "documenten",
  "heeft", "hierbij", "moeten", "onder", "over", "worden", "zoals", "zonder",
]);

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const direct = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function dateForDocument(document: ReconstructionDocument, events: ReconstructionEvent[]): string {
  const eventDate = events.map((event) => validDate(event.date)).find(Boolean);
  if (eventDate) return eventDate;
  const metadata = parseMetadata(document.metadata);
  for (const value of [metadata.date, metadata.modifiedTime, metadata.collectedAt]) {
    const parsed = validDate(value);
    if (parsed) return parsed;
  }
  return document.createdAt?.toISOString().slice(0, 10) ?? "Undated";
}

function routeForDocument(document: ReconstructionDocument, events: ReconstructionEvent[]): ReconstructionRoute {
  if (events.length) {
    const counts = new Map<ReconstructionRoute, number>();
    for (const event of events) counts.set(event.category, (counts.get(event.category) ?? 0) + 1);
    return ROUTE_ORDER.reduce((best, route) =>
      (counts.get(route) ?? 0) > (counts.get(best) ?? 0) ? route : best, events[0].category);
  }
  const haystack = `${document.analysis?.documentType ?? ""} ${document.title} ${document.description ?? ""}`;
  if (/email|correspond|brief|letter|message|bericht/i.test(haystack)) return "communication";
  if (/invoice|factuur|payment|betaling|financial/i.test(haystack)) return "financial";
  if (/employment|werkgever|werknemer|arbeid/i.test(haystack)) return "employment";
  if (/termination|opzeg|ontslag/i.test(haystack)) return "termination";
  if (/decision|besluit|court|rechtbank|judgment|vonnis|legal|bezwaar|beroep/i.test(haystack)) return "legal";
  return "other";
}

function analysisCorpus(document: ReconstructionDocument): string {
  const analysis = document.analysis;
  if (!analysis) return normalizeText(`${document.title} ${document.description ?? ""}`);
  return normalizeText([
    analysis.summary,
    ...analysis.citations.map((item) => item.quote),
    ...analysis.claims.map((item) => item.text),
    ...analysis.obligations.map((item) => item.text),
    ...analysis.legalIssues.map((item) => item.text),
    ...analysis.parties.map((item) => item.text),
  ].join(" "));
}

function keyTerms(document: ReconstructionDocument): Set<string> {
  const tokens = analysisCorpus(document).split(" ");
  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (token.length < 5 || STOP_WORDS.has(token) || /^\d+$/.test(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return new Set([...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 60).map(([token]) => token));
}

function sharedValues(left: string[], right: string[]): string[] {
  const rightValues = new Map(right.map((value) => [normalizeText(value), value]));
  return [...new Set(left.map(normalizeText).filter(Boolean))]
    .filter((value) => rightValues.has(value))
    .map((value) => rightValues.get(value)!)
    .slice(0, 4);
}

function daysBetween(left: string, right: string): number | null {
  if (left === "Undated" || right === "Undated") return null;
  const delta = Math.abs(Date.parse(right) - Date.parse(left));
  return Number.isFinite(delta) ? Math.round(delta / 86_400_000) : null;
}

function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

function explicitEdges(documents: ReconstructionDocument[], nodes: Map<string, ReconstructionNode>): ReconstructionEdge[] {
  const edges = new Map<string, ReconstructionEdge>();
  const sorted = [...documents].sort((left, right) => {
    const leftNode = nodes.get(left.evidenceId)!;
    const rightNode = nodes.get(right.evidenceId)!;
    return leftNode.date.localeCompare(rightNode.date) ||
      (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0) ||
      left.title.localeCompare(right.title) || left.evidenceId.localeCompare(right.evidenceId);
  });

  for (const attachment of documents) {
    const attachmentMetadata = parseMetadata(attachment.metadata);
    const parentSubject = typeof attachmentMetadata.parentSubject === "string"
      ? normalizeText(attachmentMetadata.parentSubject)
      : "";
    if (typeof attachmentMetadata.attachmentId !== "string" && !parentSubject) continue;
    const parent = documents.find((candidate) => {
      if (candidate.evidenceId === attachment.evidenceId) return false;
      const candidateMetadata = parseMetadata(candidate.metadata);
      const sameMessage = typeof attachmentMetadata.gmailMessageId === "string" &&
        attachmentMetadata.gmailMessageId === candidateMetadata.gmailMessageId &&
        typeof candidateMetadata.attachmentId !== "string";
      return sameMessage || (parentSubject.length > 0 && parentSubject === normalizeText(candidate.title));
    });
    if (!parent) continue;
    const key = edgeKey(parent.evidenceId, attachment.evidenceId);
    edges.set(key, {
      id: `${key}:attachment_of`, from: parent.evidenceId, to: attachment.evidenceId,
      relationship: "attachment_of", evidence: "explicit", confidence: 1,
      basis: ["The imported provider metadata identifies this document as an attachment to the message."],
    });
  }

  for (let laterIndex = 0; laterIndex < sorted.length; laterIndex += 1) {
    const later = sorted[laterIndex];
    const laterMetadata = parseMetadata(later.metadata);
    const laterCorpus = analysisCorpus(later);
    for (let earlierIndex = 0; earlierIndex < laterIndex; earlierIndex += 1) {
      const earlier = sorted[earlierIndex];
      const earlierMetadata = parseMetadata(earlier.metadata);
      const key = edgeKey(earlier.evidenceId, later.evidenceId);
      if (edges.has(key)) continue;
      const sameThread = typeof laterMetadata.gmailThreadId === "string" &&
        laterMetadata.gmailThreadId === earlierMetadata.gmailThreadId;
      if (sameThread) {
        edges.set(key, {
          id: `${key}:responds_to`, from: earlier.evidenceId, to: later.evidenceId,
          relationship: "responds_to", evidence: "explicit", confidence: 0.98,
          basis: ["Both messages carry the same Gmail thread identifier."],
        });
        continue;
      }
      const earlierTitle = normalizeText(earlier.title);
      if (earlierTitle.length >= 8 && laterCorpus.includes(earlierTitle)) {
        edges.set(key, {
          id: `${key}:references`, from: earlier.evidenceId, to: later.evidenceId,
          relationship: "references", evidence: "explicit", confidence: 0.95,
          basis: [`The analyzed text of "${later.title}" names "${earlier.title}".`],
        });
      }
    }
  }
  return [...edges.values()];
}

function inferredEdges(
  documents: ReconstructionDocument[],
  nodes: Map<string, ReconstructionNode>,
  occupiedPairs: Set<string>,
): ReconstructionEdge[] {
  const sorted = [...documents].sort((left, right) => {
    const leftNode = nodes.get(left.evidenceId)!;
    const rightNode = nodes.get(right.evidenceId)!;
    return leftNode.date.localeCompare(rightNode.date) ||
      (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0) ||
      left.evidenceId.localeCompare(right.evidenceId);
  });
  const terms = new Map(sorted.map((document) => [document.evidenceId, keyTerms(document)]));
  const output: ReconstructionEdge[] = [];

  for (let laterIndex = 1; laterIndex < sorted.length; laterIndex += 1) {
    const later = sorted[laterIndex];
    let best: ReconstructionEdge | null = null;
    for (let earlierIndex = Math.max(0, laterIndex - 12); earlierIndex < laterIndex; earlierIndex += 1) {
      const earlier = sorted[earlierIndex];
      const key = edgeKey(earlier.evidenceId, later.evidenceId);
      if (occupiedPairs.has(key)) continue;
      const earlierAnalysis = earlier.analysis;
      const laterAnalysis = later.analysis;
      if (!earlierAnalysis || !laterAnalysis) continue;

      const sharedParties = sharedValues(
        earlierAnalysis.parties.map((item) => item.text),
        laterAnalysis.parties.map((item) => item.text),
      );
      const sharedIssues = sharedValues(
        earlierAnalysis.legalIssues.map((item) => item.text),
        laterAnalysis.legalIssues.map((item) => item.text),
      );
      const laterTerms = terms.get(later.evidenceId)!;
      const sharedTerms = [...terms.get(earlier.evidenceId)!].filter((term) => laterTerms.has(term)).slice(0, 5);
      const earlierNode = nodes.get(earlier.evidenceId)!;
      const laterNode = nodes.get(later.evidenceId)!;
      const distance = daysBetween(earlierNode.date, laterNode.date);
      let confidence = 0.2;
      confidence += Math.min(0.28, sharedParties.length * 0.14);
      confidence += Math.min(0.28, sharedIssues.length * 0.18);
      confidence += Math.min(0.18, sharedTerms.length * 0.045);
      if (earlierNode.route === laterNode.route) confidence += 0.08;
      if (distance !== null && distance <= 30) confidence += 0.08;
      confidence = Math.min(0.89, Number(confidence.toFixed(2)));
      if (confidence < 0.52 || (sharedParties.length === 0 && sharedIssues.length === 0 && sharedTerms.length < 3)) continue;

      const basis = [
        sharedParties.length ? `Shared parties: ${sharedParties.join(", ")}.` : null,
        sharedIssues.length ? `Shared legal issues: ${sharedIssues.join(", ")}.` : null,
        sharedTerms.length ? `Shared analyzed terms: ${sharedTerms.join(", ")}.` : null,
        distance !== null ? `${distance} day${distance === 1 ? "" : "s"} apart.` : null,
      ].filter((item): item is string => Boolean(item));
      const relationship: ReconstructionRelationship = /response|reply|reactie|antwoord|decision|besluit|judgment|vonnis/i
        .test(laterAnalysis.documentType)
        ? "responds_to"
        : "related";
      const candidate: ReconstructionEdge = {
        id: `${key}:${relationship}`,
        from: earlier.evidenceId,
        to: later.evidenceId,
        relationship,
        evidence: "inferred",
        confidence,
        basis,
      };
      if (!best || candidate.confidence > best.confidence) best = candidate;
    }
    if (best) output.push(best);
  }
  return output;
}

function buildPhases(nodes: ReconstructionNode[]): ReconstructionPhase[] {
  const dated = nodes.filter((node) => node.date !== "Undated");
  if (!dated.length) return [];
  const phaseCount = dated.length < 4 ? 1 : dated.length < 9 ? 2 : 3;
  const labels = phaseCount === 1
    ? ["Documented period"]
    : phaseCount === 2
      ? ["Opening record", "Later record"]
      : ["Opening record", "Developing record", "Recent record"];

  return labels.flatMap((label, index) => {
    const start = Math.floor((index * dated.length) / phaseCount);
    const end = Math.floor(((index + 1) * dated.length) / phaseCount);
    const phaseNodes = dated.slice(start, end);
    if (!phaseNodes.length) return [];
    const eventCount = phaseNodes.reduce((sum, node) => sum + node.eventCount, 0);
    const routeLabels = [...new Set(phaseNodes.map((node) => ROUTE_LABELS[node.route]))];
    return [{
      id: `phase-${index + 1}`,
      label,
      startDate: phaseNodes[0].date,
      endDate: phaseNodes[phaseNodes.length - 1].date,
      documentIds: phaseNodes.map((node) => node.id),
      documentCount: phaseNodes.length,
      eventCount,
      summary: `${phaseNodes.length} source document${phaseNodes.length === 1 ? "" : "s"} across ${routeLabels.join(", ")}`
        + `${eventCount ? `, containing ${eventCount} dated action${eventCount === 1 ? "" : "s"}` : ""}.`,
    }];
  });
}

function buildChains(nodes: ReconstructionNode[], edges: ReconstructionEdge[]): ReconstructionChain[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    const left = adjacency.get(edge.from) ?? new Set<string>();
    const right = adjacency.get(edge.to) ?? new Set<string>();
    left.add(edge.to);
    right.add(edge.from);
    adjacency.set(edge.from, left);
    adjacency.set(edge.to, right);
  }
  const visited = new Set<string>();
  const chains: ReconstructionChain[] = [];
  for (const node of nodes) {
    if (visited.has(node.id) || !adjacency.has(node.id)) continue;
    const pending = [node.id];
    const documentIds: string[] = [];
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      documentIds.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) pending.push(neighbor);
      }
    }
    const documentSet = new Set(documentIds);
    const chainEdges = edges.filter((edge) => documentSet.has(edge.from) && documentSet.has(edge.to));
    const sortedDocuments = documentIds
      .map((id) => nodeMap.get(id)!)
      .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
    chains.push({
      id: `chain-${chains.length + 1}`,
      documentIds: sortedDocuments.map((item) => item.id),
      edgeIds: chainEdges.map((edge) => edge.id),
      startDate: sortedDocuments.find((item) => item.date !== "Undated")?.date ?? "Undated",
      endDate: [...sortedDocuments].reverse().find((item) => item.date !== "Undated")?.date ?? "Undated",
      explicitLinkCount: chainEdges.filter((edge) => edge.evidence === "explicit").length,
      inferredLinkCount: chainEdges.filter((edge) => edge.evidence === "inferred").length,
      confidence: Number((chainEdges.reduce((sum, edge) => sum + edge.confidence, 0) / chainEdges.length).toFixed(2)),
    });
  }
  return chains.sort((left, right) => right.documentIds.length - left.documentIds.length || left.id.localeCompare(right.id));
}

function buildKeyMoments(nodes: ReconstructionNode[], edges: ReconstructionEdge[]): ReconstructionKeyMoment[] {
  return nodes
    .map((node) => {
      const verifiedLinkCount = edges.filter((edge) =>
        edge.evidence === "explicit" && (edge.from === node.id || edge.to === node.id)).length;
      const reasons = [
        node.eventCount ? `${node.eventCount} source-linked dated action${node.eventCount === 1 ? "" : "s"}` : null,
        verifiedLinkCount ? `${verifiedLinkCount} verified document link${verifiedLinkCount === 1 ? "" : "s"}` : null,
      ].filter((item): item is string => Boolean(item));
      return { node, score: node.eventCount * 3 + verifiedLinkCount * 2, verifiedLinkCount, reasons };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.node.date.localeCompare(right.node.date))
    .slice(0, 8)
    .map(({ node, verifiedLinkCount, reasons }) => ({
      documentId: node.id,
      date: node.date,
      title: node.title,
      reason: reasons.join(" and "),
      verifiedLinkCount,
      eventCount: node.eventCount,
    }));
}

export function buildCaseReconstruction(options: {
  documents: ReconstructionDocument[];
  events: ReconstructionEvent[];
}): CaseReconstruction {
  const eventsByDocument = new Map<string, ReconstructionEvent[]>();
  for (const event of options.events) {
    const bucket = eventsByDocument.get(event.source.evidenceId) ?? [];
    bucket.push(event);
    eventsByDocument.set(event.source.evidenceId, bucket);
  }

  const nodes = options.documents.map((document): ReconstructionNode => {
    const documentEvents = (eventsByDocument.get(document.evidenceId) ?? [])
      .sort((left, right) => left.date.localeCompare(right.date));
    const analysis = document.analysis;
    const participants = [...new Set([
      ...documentEvents.map((event) => event.actor).filter((actor): actor is string => Boolean(actor?.trim())),
      ...(analysis?.parties.map((party) => party.text).filter(Boolean) ?? []),
    ])].sort((left, right) => left.localeCompare(right));
    const topics = [...new Set(analysis?.legalIssues.map((issue) => issue.text).filter(Boolean) ?? [])]
      .sort((left, right) => left.localeCompare(right));
    return {
      id: document.evidenceId,
      title: document.title,
      date: dateForDocument(document, documentEvents),
      route: routeForDocument(document, documentEvents),
      summary: analysis?.summary || document.description || "This document has not been analyzed yet.",
      actor: documentEvents.find((event) => event.actor)?.actor ?? analysis?.parties[0]?.text ?? null,
      documentType: analysis?.documentType || document.type,
      source: document.source,
      eventCount: documentEvents.length,
      analysisStatus: analysis ? "complete" : "missing",
      confidence: analysis?.confidence ?? null,
      participants,
      topics,
      actions: documentEvents.map((event) => ({
        date: event.date,
        title: event.title,
        description: event.description,
        actor: event.actor,
      })),
    };
  }).sort((left, right) => left.date.localeCompare(right.date) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const explicit = explicitEdges(options.documents, nodeMap);
  const occupied = new Set(explicit.map((edge) => edgeKey(edge.from, edge.to)));
  const inferred = inferredEdges(options.documents, nodeMap, occupied);
  const edges = [...explicit, ...inferred].sort((left, right) =>
    nodeMap.get(left.to)!.date.localeCompare(nodeMap.get(right.to)!.date) || left.id.localeCompare(right.id));

  const routes = ROUTE_ORDER.flatMap((route) => {
    const routeNodes = nodes.filter((node) => node.route === route);
    if (!routeNodes.length) return [];
    return [{
      id: route,
      label: ROUTE_LABELS[route],
      documentCount: routeNodes.length,
      eventCount: routeNodes.reduce((sum, node) => sum + node.eventCount, 0),
    }];
  });
  const missingAnalysis = nodes.filter((node) => node.analysisStatus === "missing").length;
  const warnings = [
    missingAnalysis
      ? `${missingAnalysis} document${missingAnalysis === 1 ? " has" : "s have"} not been analyzed; those stations use metadata only.`
      : null,
    inferred.length
      ? "Dashed links are analytical suggestions, not established causation. Review their basis before relying on them."
      : null,
  ].filter((item): item is string => Boolean(item));

  return {
    schemaVersion: 2,
    nodes,
    edges,
    routes,
    phases: buildPhases(nodes),
    chains: buildChains(nodes, edges),
    keyMoments: buildKeyMoments(nodes, edges),
    warnings,
  };
}
