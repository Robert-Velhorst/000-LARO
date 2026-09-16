export type ProductAssistantAnswer = {
  answer: string;
  citations: [];
  grounded: false;
  mode: "product_help" | "case_required" | "unavailable";
  notice: string;
};

type ProductTopic = {
  patterns: RegExp[];
  answer: string;
};

const PRODUCT_TOPICS: ProductTopic[] = [
  {
    patterns: [/\b(upload|import|scan|scanner|evidence|document|bestand|bewijs|documenten)\b/i],
    answer: "Open the relevant case and use its evidence area to upload a supported file. In LARO Desktop, you can also open the folder scanner, review the discovered files, and explicitly select the files to upload.",
  },
  {
    patterns: [/\b(create|open|select|find|switch).{0,24}\b(case|dossier)\b/i, /\b(case|dossier).{0,24}\b(create|open|select|find|switch)\b/i],
    answer: "Open Cases from the main navigation to create or open a case. In the assistant, use the case picker above the messages to select the case whose analyzed sources should be used.",
  },
  {
    patterns: [/\b(gmail|google drive|provider|connect|connection|koppelen|verbinden)\b/i],
    answer: "Open Settings or the relevant source connection screen, choose the provider, and complete its authorization flow. Connecting a provider does not by itself approve every document or outgoing action.",
  },
  {
    patterns: [/\b(export|download|zip|csv|rapport|downloaden|exporteren)\b/i],
    answer: "Open the relevant case and choose an available evidence export. CSV provides an evidence index; ZIP packages are checked for missing managed source files before a download is issued.",
  },
  {
    patterns: [/\b(lawyer|outreach|message|draft|advocaat|bericht)\b/i],
    answer: "Open the relevant case and review its matching or outreach workspace. Drafts and recipients must be reviewed before an external message is sent.",
  },
  {
    patterns: [/\b(settings?|privacy|language|provider|instellingen?|taal)\b/i],
    answer: "Open Settings to review language, analysis-provider, privacy, and workflow controls. Read the displayed data-sharing notice before enabling an external analysis option.",
  },
  {
    patterns: [/\b(source|citation|grounded|bron|citaat)\b/i],
    answer: "Select a case before asking about its contents. Case answers use analyzed owned documents, show linked sources when support is available, and refuse to treat case metadata alone as evidence.",
  },
];

const CASE_OR_LEGAL_PATTERNS = [
  /\b(my|our|this|mijn|ons|deze)\s+(case|claim|dispute|lawsuit|dossier|zaak|geschil)\b/i,
  /\b(deadline|limitation|appeal|objection|bezwaar|beroep|termijn|verjaring)\b/i,
  /\b(entitled|liable|liability|rights?|recht op|aansprakelijk|aansprakelijkheid)\b/i,
  /\b(compensation|damages|settlement|vergoeding|schadevergoeding|schikking)\b/i,
  /\b(should|must|can)\s+(i|we)\s+(sue|appeal|object|pay|sign|accept|reject|file|respond)\b/i,
  /\b(will|can)\s+(i|we)\s+win\b/i,
  /\b(legal|lawful|illegal|juridisch|wettelijk|onrechtmatig)\b/i,
];

const PRODUCT_ACTION_PATTERN = /\b(open|create|upload|import|scan|select|connect|configure|export|download|navigate|add|switch|open|maak|upload|importeer|scan|selecteer|verbind|configureer|exporteer|download|voeg|wissel)\b/i;
const DIRECT_NAVIGATION_PATTERN = /\b(where|waar).{0,30}\b(settings|scanner|case picker|evidence|cases|instellingen|dossiers|bewijs)\b/i;

/** No-case assistance is deterministic product help and never calls an LLM. */
export function answerProductQuestion(question: string): ProductAssistantAnswer {
  const normalized = question.normalize("NFKC").trim();
  const topic = PRODUCT_TOPICS.find((candidate) =>
    candidate.patterns.some((pattern) => pattern.test(normalized)) &&
    (PRODUCT_ACTION_PATTERN.test(normalized) || DIRECT_NAVIGATION_PATTERN.test(normalized)));
  if (topic) {
    return {
      answer: topic.answer,
      citations: [],
      grounded: false,
      mode: "product_help",
      notice: "Product help only. No case evidence or legal analysis was used.",
    };
  }

  if (CASE_OR_LEGAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      answer: "Select the relevant case before asking for case facts or legal analysis. LARO can then search that case's analyzed documents and show the supporting sources. It cannot provide an uncited legal conclusion in product-help mode.",
      citations: [],
      grounded: false,
      mode: "case_required",
      notice: "Request not answered: no case was selected and no case evidence was reviewed.",
    };
  }

  if (/^(?:hi|hello|hey|help|hallo|hoi)[.! ]*$/i.test(normalized)) {
    return {
      answer: "I can help you navigate LARO, such as opening a case, adding evidence, connecting a source, or exporting records. Select a case before asking about case facts or legal analysis.",
      citations: [],
      grounded: false,
      mode: "product_help",
      notice: "Product help only. No case evidence or legal analysis was used.",
    };
  }

  return {
    answer: "I can only provide LARO product navigation while no case is selected. Ask how to use a LARO feature, or select a case for source-grounded case questions.",
    citations: [],
    grounded: false,
    mode: "unavailable",
    notice: "No case was selected. The request was not sent to an AI provider.",
  };
}
