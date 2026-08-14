import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { resolve } from "node:path";

const ROUTES = [
  "/",
  "/cases",
  "/evidence",
  "/lawyers",
  "/outreach",
  "/help",
  "/settings",
  "/email-settings",
  "/email-preferences",
  "/privacy",
  "/admin",
  "/admin-analytics",
  "/messages",
  "/email",
  "/analytics",
] as const;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

async function createAccount(page: Page) {
  const email = `a11y-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  await page.goto("/");
  await page.getByRole("button", { name: "Don't have an account? Sign up" }).click();
  await page.getByLabel("Full Name").fill("Accessibility Audit");
  await page.getByLabel("Email Address").fill(email);
  await page.getByLabel("Password").fill("A11yAudit!2026");
  await page.getByRole("button", { name: "Sign Up", exact: true }).click();
  await expect(page.getByRole("button", { name: /Open account menu|Accountmenu openen/ })).toBeVisible();
  await page.waitForLoadState("networkidle");
  return email;
}

function formatViolations(
  route: string,
  viewport: string,
  violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: unknown }> }>,
) {
  return violations
    .map((violation) => {
      const targets = violation.nodes.map((node) => JSON.stringify(node.target)).join(", ");
      return `${viewport} ${route}: ${violation.id} (${violation.impact}) ${violation.help}; ${targets}`;
    })
    .join("\n");
}

async function resetKeyboardFocus(page: Page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  });
}

async function expectVisibleKeyboardFocus(page: Page, locator: Locator) {
  await expect(locator).toBeFocused();
  const focusState = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return {
      width: rect.width,
      height: rect.height,
      insideViewport:
        rect.left >= -1
        && rect.top >= -1
        && rect.right <= window.innerWidth + 1
        && rect.bottom <= window.innerHeight + 1,
      hasIndicator:
        Number.parseFloat(style.outlineWidth) > 0
        || (style.boxShadow !== "none" && style.boxShadow.trim() !== ""),
    };
  });
  expect(focusState.width).toBeGreaterThan(0);
  expect(focusState.height).toBeGreaterThan(0);
  expect(focusState.insideViewport).toBe(true);
  expect(focusState.hasIndicator).toBe(true);
}

async function expectInsideViewport(locator: Locator) {
  const geometry = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      insideViewport:
        rect.left >= -1
        && rect.top >= -1
        && rect.right <= window.innerWidth + 1
        && rect.bottom <= window.innerHeight + 1,
    };
  });
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.height).toBeGreaterThan(0);
  expect(geometry.insideViewport).toBe(true);
}

function analysisResult(options: { party: string; date: string; title: string; text: string }) {
  return {
    schemaVersion: 2,
    analysisVersion: "2.2.0",
    contentHash: options.title.toLowerCase().replace(/\s+/g, "-").padEnd(64, "0").slice(0, 64),
    status: "complete",
    extractionMethod: "plain_text",
    extractionConfidence: null,
    providerStatus: "not_requested",
    providerMessage: null,
    documentType: "administrative decision",
    confidence: 88,
    summary: options.text,
    analyzedChars: options.text.length,
    analyzedWords: options.text.split(/\s+/).length,
    truncated: false,
    citations: [{ id: "src-1", quote: options.text, start: 0, end: options.text.length, lineStart: 1, lineEnd: 1 }],
    parties: [{ text: options.party, citations: ["src-1"] }],
    dates: [{ text: options.date, normalized: options.date, citations: ["src-1"] }],
    amounts: [],
    claims: [],
    obligations: [],
    legalIssues: [{ text: "administrative law", citations: ["src-1"] }],
    riskFlags: [],
    timelineEvents: [{
      date: options.date,
      title: options.title,
      text: options.text,
      actor: options.party,
      importance: "high",
      category: "legal",
      citations: ["src-1"],
    }],
  };
}

test("all supported routes pass the blocking renderer accessibility audit", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });

  await createAccount(page);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);

    for (const route of ROUTES) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
        .toBe(true);

      const visibleUnnamedControls = await page.locator("button:visible, input:visible, textarea:visible, select:visible").evaluateAll(
        (elements) => elements
          .filter((element) => {
            const labelledBy = element.getAttribute("aria-labelledby");
            const label = element.getAttribute("aria-label")?.trim();
            const id = element.getAttribute("id");
            const associatedLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
            return !label && !labelledBy && !associatedLabel && !element.textContent?.trim() && !element.getAttribute("title");
          })
          .map((element) => element.outerHTML.slice(0, 240)),
      );
      expect(visibleUnnamedControls, `${viewport.name} ${route} has unnamed visible controls`).toEqual([]);

      const analysis = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = analysis.violations.filter(
        (violation) => violation.impact === "serious" || violation.impact === "critical",
      );
      expect(blocking, formatViolations(route, viewport.name, blocking)).toEqual([]);
    }
  }

  expect(pageErrors, "renderer page errors").toEqual([]);
  expect(requestFailures, "renderer request failures").toEqual([]);
  expect(consoleErrors, "renderer console errors").toEqual([]);
});

test("language selection changes the mounted shell and persists across reloads", async ({ page }) => {
  await createAccount(page);

  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("group", { name: "Language" }).getByRole("button", { name: "nl", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(page.getByText("Mijn zaken", { exact: true })).toBeVisible();
  await expect(page.getByText("Juridische ondersteuning, geen juridisch advies.")).toBeVisible();

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(page.getByText("Mijn zaken", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Accountmenu openen" }).click();
  await page.getByRole("group", { name: "Taal" }).getByRole("button", { name: "en", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText("My Cases", { exact: true })).toBeVisible();
});

test("keyboard navigation exposes the skip link, traps the mobile menu, and keeps interaction states visible", async ({ page }, testInfo) => {
  await createAccount(page);

  await page.setViewportSize(VIEWPORTS[0]);
  await page.goto("/help", { waitUntil: "networkidle" });
  await resetKeyboardFocus(page);

  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await page.keyboard.press("Tab");
  await expectVisibleKeyboardFocus(page, skipLink);
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  await page.goto("/help", { waitUntil: "networkidle" });
  await resetKeyboardFocus(page);
  const desktopFocusOrder = [
    page.getByRole("link", { name: "Skip to main content" }),
    page.getByRole("button", { name: "Collapse sidebar" }),
    page.getByRole("button", { name: "Home", exact: true }),
    page.getByRole("button", { name: "My Cases", exact: true }),
    page.getByRole("button", { name: "Evidence", exact: true }),
    page.getByRole("button", { name: "Outreach", exact: true }),
    page.getByRole("button", { name: "Help & Resources", exact: true }),
    page.getByRole("button", { name: "Open account menu" }),
  ];
  for (const control of desktopFocusOrder) {
    await page.keyboard.press("Tab");
    await expectVisibleKeyboardFocus(page, control);
  }

  const accountMenuTrigger = desktopFocusOrder[desktopFocusOrder.length - 1];
  await page.keyboard.press("Enter");
  const accountMenu = page.locator('[data-slot="dropdown-menu-content"]');
  await expect(accountMenu).toBeVisible();
  await expectInsideViewport(accountMenu);
  await expect(accountMenu.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(accountMenuTrigger).toBeFocused();

  await page.setViewportSize(VIEWPORTS[1]);
  await page.goto("/help", { waitUntil: "networkidle" });
  await resetKeyboardFocus(page);
  await page.keyboard.press("Tab");
  await expectVisibleKeyboardFocus(page, skipLink);
  await page.keyboard.press("Tab");
  const mobileMenuTrigger = page.getByRole("button", { name: "Toggle sidebar" });
  await expectVisibleKeyboardFocus(page, mobileMenuTrigger);
  await page.keyboard.press("Enter");
  await expect(mobileMenuTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#laro-mobile-sidebar")).toHaveAttribute("aria-hidden", "false");

  const mobileMenuClose = page.getByRole("button", { name: "Collapse sidebar" });
  await expectVisibleKeyboardFocus(page, mobileMenuClose);
  await page.keyboard.press("Shift+Tab");
  await expectVisibleKeyboardFocus(page, page.getByRole("button", { name: "Open account menu" }));
  await page.keyboard.press("Escape");
  await expect(mobileMenuTrigger).toBeFocused();

  const notificationTrigger = page.getByRole("button", { name: /Open notifications/ });
  await notificationTrigger.focus();
  await expectVisibleKeyboardFocus(page, notificationTrigger);
  await page.keyboard.press("Enter");
  const notificationPopover = page.locator('[data-slot="popover-content"]');
  await expect(notificationPopover).toBeVisible();
  await expect(notificationPopover.getByText("Notifications", { exact: true })).toBeVisible();
  await expectInsideViewport(notificationPopover);
  await page.screenshot({ path: testInfo.outputPath("mobile-notification-keyboard.png"), fullPage: false });
  await page.keyboard.press("Escape");
  await expect(notificationTrigger).toBeFocused();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize(VIEWPORTS[0]);
  await page.goto("/help", { waitUntil: "networkidle" });
  const firstFaq = page.getByRole("button", { name: "How does LARO find lawyers for my case?" });
  await firstFaq.focus();
  await expectVisibleKeyboardFocus(page, firstFaq);
  await page.keyboard.press("Space");
  await expect(firstFaq).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#faq-answer-0")).toBeVisible();
  const motion = await firstFaq.evaluate((element) => {
    const parseDurations = (value: string) => value.split(",").map((duration) => {
      const normalized = duration.trim();
      return normalized.endsWith("ms")
        ? Number.parseFloat(normalized)
        : Number.parseFloat(normalized) * 1_000;
    });
    const style = window.getComputedStyle(element);
    return {
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      maximumDurationMs: Math.max(
        ...parseDurations(style.animationDuration),
        ...parseDurations(style.transitionDuration),
      ),
    };
  });
  expect(motion.reduced).toBe(true);
  expect(motion.maximumDurationMs).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("desktop-faq-keyboard.png"), fullPage: false });
});

test("Settings presents an owned Flask migration without responsive overflow", async ({ page }) => {
  const email = await createAccount(page);
  const database = new Database(resolve(".laro-a11y.sqlite"));
  try {
    const user = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | undefined;
    expect(user?.id).toBeTruthy();
    const now = Date.now();
    database.prepare(
      `INSERT INTO legacy_import_runs
       (id, sourceRuntime, sourceInstanceId, userId, sourceUserId, sourceUserEmail,
        status, sourceSnapshotHash, recordsImported, casesImported, filesCopied,
        missingFiles, summary, startedAt, completedAt)
       VALUES (?, 'flask', ?, ?, ?, ?, 'completed', ?, 37, 2, 5, 0, '{}', ?, ?)`,
    ).run(
      `A11Y_LEGACY_${now}`,
      "reviewed-workspace",
      user!.id,
      "flask-a11y-owner",
      email,
      "a".repeat(64),
      now - 1_000,
      now,
    );
  } finally {
    database.close();
  }

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Security" }).click();
    await expect(page.getByText("reviewed-workspace")).toBeVisible();
    await expect(page.getByText("2 cases, 37 archived records, 5 files")).toBeVisible();
    await expect(page.getByText("Files verified")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
      .toBe(true);
  }
});

test("document reconstruction focuses source-linked participants, topics, and actions", async ({ page }) => {
  const email = await createAccount(page);
  const database = new Database(resolve(".laro-a11y.sqlite"));
  const now = Math.floor(Date.now() / 1_000);
  const caseId = `A11Y_RECONSTRUCTION_${now}`;
  try {
    const user = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | undefined;
    expect(user?.id).toBeTruthy();
    database.prepare(
      `INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, legalAreas, createdAt, updatedAt)
       VALUES (?, ?, 'Focused reconstruction', 'Administrative dispute', 'Source-linked timeline QA', 'High', 'active', '["administrative law"]', ?, ?)`,
    ).run(caseId, user!.id, now, now);

    const documents = [
      {
        id: `${caseId}_DECISION`, title: "Municipal decision.txt", party: "Gemeente Utrecht",
        date: "2026-07-14", action: "Municipal decision issued",
        text: "Gemeente Utrecht issued the administrative decision on 2026-07-14.",
      },
      {
        id: `${caseId}_OBJECTION`, title: "Objection.txt", party: "Jan de Vries",
        date: "2026-07-20", action: "Objection submitted",
        text: "Jan de Vries submitted an objection under administrative law on 2026-07-20.",
      },
    ];
    const insertEvidence = database.prepare(
      `INSERT INTO evidence (id, caseId, userId, type, source, title, description, mimeType, metadata, relevant, createdAt, updatedAt)
       VALUES (?, ?, ?, 'document', 'manual', ?, ?, 'text/plain', '{}', 1, ?, ?)`,
    );
    const insertAnalysis = database.prepare(
      `INSERT INTO document_analyses
       (id, evidenceId, caseId, userId, analysisVersion, contentHash, status, extractionMethod, providerStatus,
        documentType, confidence, summary, result, analyzedChars, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, '2.2.0', ?, 'complete', 'plain_text', 'not_requested',
        'administrative decision', 88, ?, ?, ?, ?, ?)`,
    );
    for (const [index, document] of documents.entries()) {
      const createdAt = now + index;
      const result = analysisResult({ party: document.party, date: document.date, title: document.action, text: document.text });
      insertEvidence.run(document.id, caseId, user!.id, document.title, document.text, createdAt, createdAt);
      insertAnalysis.run(
        `${document.id}_ANALYSIS`, document.id, caseId, user!.id, result.contentHash,
        result.summary, JSON.stringify(result), result.analyzedChars, createdAt, createdAt,
      );
    }
  } finally {
    database.close();
  }

  await page.goto("/cases", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "View Your Case Details" }).click();
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Evidence Timeline" })).toBeVisible();
  const focus = page.getByLabel("Focus");
  await expect(focus).toContainText("Gemeente Utrecht (1)");
  await expect(focus).toContainText("administrative law (2)");
  await focus.selectOption({ label: "Jan de Vries (1)" });
  await expect(page.getByText("Objection.txt", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Municipal decision.txt", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Dated actions in this document")).toBeVisible();
  await expect(page.getByText("Objection submitted", { exact: true })).toBeVisible();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }
  await page.screenshot({ path: "test-results/case-reconstruction-focus.png", fullPage: false });
});
