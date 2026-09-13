import type { DiscoveryCase } from "../../server/dossierDiscovery";

const housing: DiscoveryCase = { id: "fixture-housing", title: "Parkstraat: lekkage en herstel", metadata: null,
  summary: "Jan de Vries huurt de woning aan de Parkstraat 12 van Woningstichting Rivieren. Het geschil betreft aanhoudende lekkage in de slaapkamer en het uitblijven van herstel door de verhuurder." };
const benefits: DiscoveryCase = { id: "fixture-benefits", title: "Afwijzing bijstand", metadata: null,
  summary: "Jan de Vries heeft bij de gemeente Waterdam een bijstandsuitkering aangevraagd. De gemeente heeft de aanvraag afgewezen wegens ontbrekende bankafschriften. Jan bestrijdt deze afwijzing." };

export const dossierDiscoveryCases: Array<{ id: string; source: string; cases: DiscoveryCase[];
  expectedAction: "create" | "assign" | "review"; expectedCaseId: string | null }> = [
  { id: "new-situation-no-reference", cases: [], expectedAction: "create", expectedCaseId: null,
    source: "Jan de Vries huurt de woning aan de Parkstraat 12 van Woningstichting Rivieren.\n\nEr is een geschil over aanhoudende lekkage in de slaapkamer en het uitblijven van herstel door de verhuurder." },
  { id: "follow-up-no-reference", cases: [housing, benefits], expectedAction: "assign", expectedCaseId: housing.id,
    source: "Geachte Woningstichting Rivieren, ik ben Jan de Vries, huurder van Parkstraat 12.\n\nNaar aanleiding van mijn eerdere klacht over de lekkende slaapkamer vraag ik opnieuw om reparatie. Er is nog geen monteur langs geweest." },
  { id: "same-person-different-situation", cases: [housing], expectedAction: "create", expectedCaseId: null,
    source: "Jan de Vries heeft bij de gemeente Waterdam een bijstandsuitkering aangevraagd.\n\nDe gemeente heeft de aanvraag afgewezen wegens ontbrekende bankafschriften. Jan wil tegen deze afwijzing bezwaar maken." },
  { id: "multiple-independent-situations", cases: [housing, benefits], expectedAction: "review", expectedCaseId: null,
    source: "Deze notitie van Jan de Vries gaat over twee losse zaken.\n\nWoningstichting Rivieren heeft de lekkage in de slaapkamer aan Parkstraat 12 nog niet hersteld.\n\nDaarnaast heeft de gemeente Waterdam mijn aanvraag voor bijstand afgewezen wegens ontbrekende bankafschriften. Deze aanvraag heeft niets met de woningreparatie te maken." },
  { id: "competing-cases-uncertain-address", cases: [housing, { ...housing, id: "fixture-other-home", title: "Marktstraat: lekkage", summary: housing.summary.replace("Parkstraat 12", "Marktstraat 8") }],
    expectedAction: "review", expectedCaseId: null,
    source: "Jan de Vries schrijft aan Woningstichting Rivieren over de lekkende slaapkamer.\n\nHij vraagt wanneer de verhuurder de schade gaat herstellen. Een adres staat niet in deze brief." },
  { id: "negation-and-future-repair", cases: [housing, benefits], expectedAction: "assign", expectedCaseId: housing.id,
    source: "Jan de Vries schrijft over zijn klacht bij Woningstichting Rivieren voor de lekkage op Parkstraat 12.\n\nIk trek mijn klacht niet in. U zegt dat de monteur volgende week zal komen, maar het herstel heeft nog niet plaatsgevonden." },
];
