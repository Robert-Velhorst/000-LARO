import { describe, expect, it } from "vitest";
import { parseRechtspraakRss } from "../../server/rechtspraakIntegration";

const SAMPLE_RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <item>
      <link>https://deeplink.rechtspraak.nl/uitspraak?id=ECLI:NL:RBROT:2026:8948&amp;pk_campaign=rss</link>
      <title>ECLI:NL:RBROT:2026:8948 Rechtbank Rotterdam, 01-07-2026, 12215730 VZ VERZ 26-2279</title>
      <description>Ontbinding arbeidsovereenkomst toegewezen &amp; vergoeding toegekend.</description>
      <pubDate>Fri, 31 Jul 2026 14:02:19 +0200</pubDate>
    </item>
    <item>
      <link>http://untrusted.example/ECLI:NL:HR:2024:AB12</link>
      <title>ECLI:NL:HR:2024:AB12 Hoge Raad, 09-02-2024, 23/00123</title>
      <description>Samenvatting.</description>
    </item>
  </channel>
</rss>`;

describe("parseRechtspraakRss", () => {
  it("keeps each RSS item's metadata and decision date together", () => {
    const [decision] = parseRechtspraakRss(SAMPLE_RSS);

    expect(decision).toMatchObject({
      ecli: "ECLI:NL:RBROT:2026:8948",
      court: "Rechtbank Rotterdam",
      date: "2026-07-01",
      caseNumber: "12215730 VZ VERZ 26-2279",
      summary: "Ontbinding arbeidsovereenkomst toegewezen & vergoeding toegekend.",
      sourceUrl:
        "https://deeplink.rechtspraak.nl/uitspraak?id=ECLI:NL:RBROT:2026:8948&pk_campaign=rss",
    });
  });

  it("accepts alphanumeric ECLI suffixes, bounds output, and rejects non-HTTPS links", () => {
    const decisions = parseRechtspraakRss(SAMPLE_RSS, 2);

    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toMatchObject({
      ecli: "ECLI:NL:HR:2024:AB12",
      court: "Hoge Raad",
      date: "2024-02-09",
      caseNumber: "23/00123",
      sourceUrl: undefined,
    });
    expect(parseRechtspraakRss(SAMPLE_RSS, 1)).toHaveLength(1);
    expect(parseRechtspraakRss(SAMPLE_RSS, Number.NaN)).toHaveLength(2);
  });

  it("rejects oversized feeds before parsing", () => {
    expect(() => parseRechtspraakRss("x".repeat(5 * 1024 * 1024 + 1))).toThrow(
      "exceeded the 5 MB safety limit",
    );
  });
});
