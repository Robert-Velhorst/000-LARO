import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { COOKIE_NAME } from "../../shared/const";

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

async function createAccountThroughSignup(page: Page) {
  const email = `a11y-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  await page.goto("/");
  await page.getByRole("button", { name: "Don't have an account? Sign up" }).click();
  await page.getByLabel("Full Name").fill("Accessibility Audit");
  await page.getByLabel("Email Address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("A11yAudit!2026");
  await page.getByRole("button", { name: "Sign Up", exact: true }).click();
  await expect(page.getByRole("dialog", {
    name: /Set up your LARO workspace|Uw LARO-werkruimte instellen/,
  })).toBeVisible();
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const user = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    database.prepare(`INSERT INTO system_config (configKey, configValue, updatedAt) VALUES (?, ?, ?)
      ON CONFLICT(configKey) DO UPDATE SET configValue = excluded.configValue, updatedAt = excluded.updatedAt`)
      .run(`onboarding:state:${user.id}`, JSON.stringify({ status: "complete", currentStepKey: "outreach" }), Math.floor(Date.now() / 1000));
  } finally {
    database.close();
  }
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: /Open account menu|Accountmenu openen/ })).toBeVisible();
  return email;
}

async function createAccount(
  page: Page,
  options: { onboarding?: "active" | "complete"; password?: string } = {},
) {
  // Feature tests get isolated sessions without exhausting the real signup guard.
  const id = `A11Y_${randomUUID()}`;
  const email = `${id.toLowerCase()}@example.test`;
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    database.prepare("INSERT INTO users (id, email, name, password, role, createdAt) VALUES (?, ?, ?, ?, 'user', ?)")
      .run(id, email, "Accessibility Audit", options.password ? bcrypt.hashSync(options.password, 4) : null, Math.floor(Date.now() / 1000));
    if (options.onboarding !== "active") {
      database.prepare("INSERT INTO system_config (configKey, configValue, updatedAt) VALUES (?, ?, ?)")
        .run(`onboarding:state:${id}`, JSON.stringify({ status: "complete", currentStepKey: "outreach" }), Math.floor(Date.now() / 1000));
    }
  } finally {
    database.close();
  }
  const token = jwt.sign({ userId: id }, "laro-a11y-jwt-secret-32-characters-minimum", { expiresIn: "1h" });
  await page.context().addCookies([{
    name: COOKIE_NAME, value: token, url: "http://127.0.0.1:5181", httpOnly: true, sameSite: "Lax",
  }]);
  await page.goto("/", { waitUntil: "networkidle" });
  if (options.onboarding === "active") {
    await expect(page.getByRole("dialog", { name: /Set up your LARO workspace|Uw LARO-werkruimte instellen/ })).toBeVisible();
  } else {
    await expect(page.getByRole("button", { name: /Open account menu|Accountmenu openen/ })).toBeVisible();
  }
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
  await expect.poll(() => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      hasSize: rect.width > 0 && rect.height > 0,
      insideViewport:
        rect.left >= -1
        && rect.top >= -1
        && rect.right <= window.innerWidth + 1
        && rect.bottom <= window.innerHeight + 1,
    };
  })).toEqual({ hasSize: true, insideViewport: true });
}

async function fulfillTrpc(route: Route, json: unknown) {
  const result = { result: { data: { json } } };
  const batch = new URL(route.request().url()).searchParams.has("batch");
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(batch ? [result] : result),
  });
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
            const associatedLabel = (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null)
              || (element.closest("label")?.textContent?.trim() ? element.closest("label") : null);
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

test("Home shows canonical workflow states and registered case destinations", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badApiResponses: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => {
    if (!request.failure()?.errorText?.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}`);
  });
  page.on("response", response => {
    if (response.url().includes("/api/trpc/") && response.status() >= 400) badApiResponses.push(`${response.status()} ${response.url()}`);
  });

  const email = await createAccount(page);
  await expect(page.getByTestId("dashboard-active-cases")).toContainText("0");
  await expect(page.getByTestId("dashboard-outreach-sent")).toContainText("0");
  await expect(page.getByText("No open workflow actions.", { exact: true })).toBeVisible();
  await expect(page.getByText("No recorded activity yet.", { exact: true })).toBeVisible();

  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  const ownerId = (database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
  const workflowCase = `A11Y_HOME_WORKFLOW_${randomUUID()}`;
  const urgentCase = `A11Y_HOME_URGENT_${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    const insertCase = database.prepare(`INSERT INTO cases
      (id, userId, clientName, clientEmail, caseType, caseSummary, urgency, status, legalAreas, createdAt, updatedAt)
      VALUES (?, ?, ?, 'verified@example.test', 'Contract', 'Canonical dashboard browser fixture', ?, ?, ?, ?, ?)`);
    insertCase.run(workflowCase, ownerId, "Workflow dashboard matter", "Medium", "Outreach", '["Contract Law","Employment Law"]', now - 600, now - 600);
    insertCase.run(urgentCase, ownerId, "Urgent dashboard gap", "High", "Intake", '["Administrative Law"]', now - 500, now - 500);
    database.prepare("INSERT INTO evidence (id, caseId, userId, type, title, createdAt, updatedAt) VALUES (?, ?, ?, 'document', 'Dashboard evidence', ?, ?)")
      .run(`A11Y_HOME_EVIDENCE_${randomUUID()}`, workflowCase, ownerId, now - 400, now - 400);
    const lawyerIds = ["DRAFT", "REJECTED", "APPROVED", "SENT", "INTERESTED", "FAILED"]
      .map(state => `A11Y_HOME_LAWYER_${state}_${randomUUID()}`);
    const insertLawyer = database.prepare("INSERT INTO lawyers (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)");
    const insertOutreach = database.prepare("INSERT INTO outreach_status (id, caseId, lawyerId, status, updatedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)");
    const statuses = ["PendingApproval", "Rejected", "Approved", "Sent", "Interested", "Failed"];
    statuses.forEach((status, index) => {
      insertLawyer.run(lawyerIds[index], `Dashboard ${status}`, now - 300 + index, now - 300 + index);
      insertOutreach.run(`A11Y_HOME_OUTREACH_${status}_${randomUUID()}`, workflowCase, lawyerIds[index], status, now - 300 + index, now - 300 + index);
    });
    database.prepare("INSERT INTO email_activity (id, caseId, lawyerId, activityType, subject, sentAt, createdAt) VALUES (?, ?, ?, 'sent', 'Browser outreach sent', ?, ?)")
      .run(`A11Y_HOME_ACTIVITY_${randomUUID()}`, workflowCase, lawyerIds[3], now - 200, now - 200);
  } finally { database.close(); }

  const response = await page.reload({ waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("dashboard-active-cases")).toContainText("2");
  await expect(page.getByTestId("dashboard-filed-evidence")).toContainText("1");
  await expect(page.getByTestId("dashboard-outreach-sent")).toContainText("2");
  const pipeline = page.getByLabel("Outreach pipeline states");
  await expect(pipeline).toContainText("Suggested 6");
  await expect(pipeline).toContainText("Drafted 1");
  await expect(pipeline).toContainText("Approved, unsent 1");
  await expect(pipeline).toContainText("Sent 2");
  await expect(pipeline).toContainText("Responded 1");
  await expect(pipeline).toContainText("Interested 1");

  const actions = page.getByTestId("dashboard-pending-actions");
  await expect(actions.getByText("Exception", { exact: true }).first()).toBeVisible();
  await expect(actions.getByText("Next action", { exact: true }).first()).toBeVisible();
  await expect(actions.getByText("Clarification", { exact: true })).toBeVisible();
  await expect(actions.getByText(/Urgent dashboard gap:.*no evidence/i).first()).toBeVisible();
  const activity = page.getByTestId("dashboard-recent-activity");
  await expect(activity.getByText("Outreach response recorded", { exact: true })).toBeVisible();
  await expect(activity.getByText("Outreach: Browser outreach sent", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("home-canonical-summary.png"), fullPage: true });

  await actions.getByRole("button").filter({ hasText: "Add evidence" }).click();
  await expect(page).toHaveURL(new RegExp(`/cases\\?case=${urgentCase}$`));
  await expect(page.getByRole("dialog").getByText("Urgent dashboard gap", { exact: true }).first()).toBeVisible();
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(badApiResponses).toEqual([]);
});

test("collection monitoring renders canonical jobs and evidence revisions", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badApiResponses: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });
  page.on("response", response => {
    if (response.url().includes("/api/trpc/") && response.status() >= 400) badApiResponses.push(`${response.status()} ${response.url()}`);
  });

  const email = await createAccount(page);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  const caseId = `A11Y_MONITOR_CASE_${randomUUID()}`;
  const completeJobId = randomUUID();
  const zeroJobId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    const ownerId = (database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
    database.prepare(`INSERT INTO cases
      (id, userId, clientName, clientEmail, caseType, caseSummary, urgency, status, legalAreas, createdAt, updatedAt)
      VALUES (?, ?, 'Canonical monitoring matter', 'monitor@example.test', 'Contract', 'Monitoring browser fixture', 'Medium', 'active', '["Contract Law"]', ?, ?)`)
      .run(caseId, ownerId, now - 300, now - 300);
    const completeMonitoring = {
      schemaVersion: 1,
      requestedKeywords: ["contract", "invoice"],
      matchedKeywords: ["contract", "invoice"],
      matchMode: "any",
      requestedSources: ["gmail", "google_drive", "local"],
      completedSources: ["gmail", "google_drive", "local"],
      startedAt: new Date((now - 120) * 1000).toISOString(),
      completedAt: new Date((now - 59) * 1000).toISOString(),
      durationMs: 61_250,
      completeness: "complete",
      processedItems: 3,
      storedItems: 3,
      skippedItems: 0,
      processedBytes: 4_096,
      matchReasons: ["Local filename matched the persisted pull keywords."],
      sources: [
        { source: "gmail", status: "completed", processedItems: 1, storedItems: 1, skippedItems: 0, matchedKeywords: ["invoice"], errors: [] },
        { source: "google_drive", status: "completed", processedItems: 1, storedItems: 1, skippedItems: 0, matchedKeywords: ["contract"], errors: [] },
        { source: "local", status: "completed", processedItems: 1, storedItems: 1, skippedItems: 0, matchedKeywords: ["contract"], errors: [] },
      ],
      revisions: [{
        evidenceId: randomUUID(),
        source: "local",
        title: "contract-revision.txt",
        sourceIdentity: JSON.stringify(["local", "/safe/contract-revision.txt"]),
        contentRevision: "b".repeat(64),
        revisionNumber: 2,
        matchedKeywords: ["contract"],
        matchReason: "Local filename matched the persisted pull keywords.",
      }],
    };
    const zeroMonitoring = {
      ...completeMonitoring,
      requestedKeywords: ["contract"],
      matchedKeywords: ["contract"],
      requestedSources: ["local"],
      completedSources: ["local"],
      startedAt: new Date((now - 30) * 1000).toISOString(),
      completedAt: new Date((now - 29) * 1000).toISOString(),
      durationMs: 720,
      completeness: "complete_zero",
      processedItems: 1,
      storedItems: 0,
      skippedItems: 1,
      processedBytes: 0,
      sources: [{ source: "local", status: "completed", processedItems: 1, storedItems: 0, skippedItems: 1, matchedKeywords: ["contract"], errors: [] }],
      revisions: [],
    };
    const insertJob = database.prepare(`INSERT INTO keyword_pull_jobs
      (id, caseId, userId, status, phase, message, processedWords, totalWords, processedItems, totalItems,
       estimatedSecondsRemaining, result, createdAt, startedAt, updatedAt, completedAt)
      VALUES (?, ?, ?, 'completed', 'finalizing', ?, 0, 0, ?, ?, 0, ?, ?, ?, ?, ?)`);
    insertJob.run(completeJobId, caseId, ownerId, "Pull complete", 3, 3,
      JSON.stringify({ monitoring: completeMonitoring }), now - 120, now - 120, now - 59, now - 59);
    insertJob.run(zeroJobId, caseId, ownerId, "Pull complete - no new evidence revisions", 1, 1,
      JSON.stringify({ monitoring: zeroMonitoring }), now - 30, now - 30, now - 29, now - 29);
  } finally { database.close(); }

  const response = await page.goto("/cases", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await page.getByRole("button", { name: "Open case", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Documents", exact: true }).click();
  await dialog.getByRole("tab", { name: "Monitoring", exact: true }).click();
  const monitoring = dialog.getByTestId("canonical-collection-monitoring");
  await expect(monitoring.getByText("Canonical collection history", { exact: true })).toBeVisible();
  await expect(monitoring.getByText("Complete - no new revisions", { exact: true })).toBeVisible();
  await expect(monitoring.getByText("1m 1s", { exact: true })).toBeVisible();
  await expect(monitoring.getByText("<1s", { exact: true })).toBeVisible();
  await expect(monitoring.getByText("contract-revision.txt", { exact: true })).toBeVisible();
  await expect(monitoring.getByText(/Revision 2: b{64}/)).toBeVisible();
  await expect(monitoring.getByText("Gmail", { exact: true }).first()).toBeVisible();
  await expect(monitoring.getByText("Google Drive", { exact: true }).first()).toBeVisible();
  await expect(monitoring.getByText("Local files", { exact: true }).first()).toBeVisible();
  await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const audit = await new AxeBuilder({ page }).include('[data-testid="canonical-collection-monitoring"]').analyze();
  expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
  await dialog.screenshot({ path: testInfo.outputPath("canonical-collection-monitoring.png") });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(badApiResponses).toEqual([]);
});

test("language selection updates representative workflows and persists across reloads", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badApiResponses: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });
  page.on("response", (response) => {
    if (response.url().includes("/api/trpc/") && response.status() >= 400) {
      badApiResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  const email = await createAccountThroughSignup(page);
  const caseId = `A11Y_I18N_CASE_${randomUUID()}`;
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const owner = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    const now = Math.floor(Date.now() / 1000);
    database.prepare(`INSERT INTO cases
      (id, userId, clientName, clientEmail, caseType, caseSummary, urgency, status, legalAreas, createdAt, updatedAt)
      VALUES (?, ?, 'Bilingual workflow matter', 'language@example.test', 'Contract',
        'Renderer language workflow fixture', 'Medium', 'Matching', '["Contract Law"]', ?, ?)`)
      .run(caseId, owner.id, now, now);
  } finally {
    database.close();
  }

  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("group", { name: "Language" }).getByRole("button", { name: "nl", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(page.getByText("Mijn zaken", { exact: true })).toBeVisible();
  await expect(page.getByText("Juridische ondersteuning, geen juridisch advies.")).toBeVisible();

  await page.getByRole("button", { name: "Documenten", exact: true }).click();
  const inboxNl = page.getByRole("region", { name: "Documenteninbox", exact: true });
  await expect(inboxNl.getByRole("heading", { name: "Documenteninbox", exact: true })).toBeVisible();
  await expect(inboxNl.getByLabel("Documenten uploaden", { exact: true })).toBeAttached();
  await expect(inboxNl.getByRole("group", { name: "Inboxfilter", exact: true })).toContainText("Aandacht vereist");
  await inboxNl.screenshot({ path: testInfo.outputPath("document-inbox-nl.png") });

  const casesNavNl = page.getByRole("button", { name: "Mijn zaken", exact: true });
  await expect(casesNavNl).toBeVisible();
  await casesNavNl.click();
  await expect(page.getByRole("heading", { name: "Dossiers", exact: true })).toBeVisible();
  await expect(page.getByText("1 dossier", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Dossiers zoeken", exact: true })).toBeVisible();
  await page.locator("summary").filter({ hasText: "Filters" }).click();
  await expect(page.getByRole("combobox", { name: "Filteren op dossierstatus", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Filteren op rechtsgebied", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Filteren op periode", exact: true }).click();
  await expect(page.getByRole("option", { name: "Dit jaar", exact: true })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Dossieracties: Bilingual workflow matter", exact: true }).click();
  await page.getByRole("menuitem", { name: "Dossier verwijderen", exact: true }).click();
  const deleteDialog = page.getByRole("dialog").filter({ hasText: "Dit dossier verwijderen?" });
  await expect(deleteDialog).toContainText("standaard 30 dagen");
  await deleteDialog.getByRole("button", { name: "Annuleren", exact: true }).click();
  await page.locator("main").screenshot({ path: testInfo.outputPath("case-search-filters-nl.png") });
  await page.getByRole("button", { name: "Dossier openen", exact: true }).click();
  let dialog = page.getByRole("dialog").first();
  await expect(dialog.getByText("Dossieroverzicht", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Documenten", exact: true }).click();
  await expect(dialog.getByText("Bewijsbeheer", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Bewijs ophalen op trefwoord", { exact: true })).toBeVisible();
  await dialog.screenshot({ path: testInfo.outputPath("case-evidence-nl.png") });
  await dialog.getByRole("button", { name: "Dossierdetails sluiten", exact: true }).click();

  await page.getByRole("button", { name: "Benadering", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Benadering", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Instellingen", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Instellingen", exact: true })).toBeVisible();
  const settingsNavNl = page.getByRole("navigation", { name: "Instellingengroepen" });
  await expect(page.getByText("Documentanalyse", { exact: true })).toBeVisible();
  await settingsNavNl.getByRole("button", { name: "E-mail", exact: true }).click();
  await expect(page.getByText("E-mailservice", { exact: true })).toBeVisible();
  await expect(page.getByText("Tests voor transactionele bezorging zijn alleen beschikbaar voor een beheerder.", { exact: true })).toBeVisible();
  await settingsNavNl.getByRole("button", { name: "Bewijsbronnen", exact: true }).click();
  await expect(page.getByText("Lokale computer", { exact: true })).toBeVisible();
  await settingsNavNl.getByRole("button", { name: "HAI-koppeling", exact: true }).click();
  await expect(page.getByText("Alleen lezen", { exact: true })).toBeVisible();
  await settingsNavNl.getByRole("button", { name: "Gegevens en privacy", exact: true }).click();
  await expect(page.getByText("Accountarchief", { exact: true })).toBeVisible();
  await page.locator("main").screenshot({ path: testInfo.outputPath("settings-security-nl.png") });

  const reloadResponse = await page.reload({ waitUntil: "networkidle" });
  expect(reloadResponse?.status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(page.getByRole("heading", { name: "Instellingen", exact: true })).toBeVisible();
  await expect(page.getByText("Privacy en account", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Accountmenu openen" }).click();
  await page.getByRole("group", { name: "Taal" }).getByRole("button", { name: "en", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText("My Cases", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByText("Privacy and account", { exact: true })).toBeVisible();
  const settingsNavEn = page.getByRole("navigation", { name: "Settings sections" });
  await settingsNavEn.getByRole("button", { name: "Workflow", exact: true }).click();
  await expect(page.getByText("Document analysis", { exact: true })).toBeVisible();
  await expect(page.getByText("External full-document processing", { exact: true })).toBeVisible();
  await page.locator("main").screenshot({ path: testInfo.outputPath("settings-workflow-en.png") });

  await page.getByRole("button", { name: "My Cases", exact: true }).click();
  await expect(page.getByText("1 case", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search cases", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open case", exact: true }).click();
  dialog = page.getByRole("dialog").first();
  await dialog.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(dialog.getByText("Case Overview", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Documents", exact: true }).click();
  await expect(dialog.getByText("Evidence Management", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Pull evidence by keyword", { exact: true })).toBeVisible();
  await dialog.screenshot({ path: testInfo.outputPath("case-evidence-en.png") });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(badApiResponses).toEqual([]);
});

test("onboarding resumes, skips, completes, resets, and stays isolated across accounts", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });
  await page.addInitScript(() => localStorage.setItem("laro.locale", "en"));

  const password = "Onboarding!2026";
  const firstEmail = await createAccount(page, { onboarding: "active", password });
  const guide = page.getByRole("dialog", { name: "Set up your LARO workspace" });
  await expect(guide).toBeVisible();
  await expect(guide.getByText("Step 1 of 3", { exact: true })).toBeVisible();
  await expect(guide.getByText("0 of 3 setup steps completed", { exact: true })).toBeVisible();

  await guide.getByRole("button", { name: "Next", exact: true }).click();
  await expect(guide.getByText("Step 2 of 3", { exact: true })).toBeVisible();
  await guide.getByRole("button", { name: "Continue later", exact: true }).click();
  await expect(guide).toBeHidden();
  const resumeResponse = await page.reload({ waitUntil: "networkidle" });
  expect(resumeResponse?.status()).toBe(200);
  await expect(guide).toBeVisible();
  await expect(guide.getByText("Step 2 of 3", { exact: true })).toBeVisible();
  await guide.getByRole("button", { name: "Skip setup", exact: true }).click();
  await expect(guide).toBeHidden();
  const skippedResponse = await page.reload({ waitUntil: "networkidle" });
  expect(skippedResponse?.status()).toBe(200);
  await expect(guide).toBeHidden();

  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  const secondId = `A11Y_${randomUUID()}`;
  const secondEmail = `${secondId.toLowerCase()}@example.test`;
  const lawyerId = `A11Y_LAWYER_${randomUUID()}`;
  try {
    const now = Math.floor(Date.now() / 1000);
    database.prepare("INSERT INTO users (id, email, name, password, role, createdAt) VALUES (?, ?, 'Second onboarding account', ?, 'user', ?)")
      .run(secondId, secondEmail, bcrypt.hashSync(password, 4), now);
    database.prepare("INSERT INTO lawyers (id, name, email, createdAt, updatedAt) VALUES (?, 'Onboarding Lawyer', ?, ?, ?)")
      .run(lawyerId, `${lawyerId.toLowerCase()}@law.example.test`, now, now);
  } finally {
    database.close();
  }

  const signOut = async () => {
    const accountMenu = page.getByRole("button", { name: "Open account menu" });
    if (!await accountMenu.isVisible()) {
      await page.getByRole("button", { name: "Toggle sidebar" }).click();
      await expect(accountMenu).toBeVisible();
    }
    await accountMenu.click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await expect(page.getByLabel("Email Address", { exact: true })).toBeVisible();
  };
  const signIn = async (email: string) => {
    await page.getByLabel("Email Address", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page.locator("#main-content")).toBeVisible();
    await page.waitForLoadState("networkidle");
  };

  await signOut();
  await signIn(firstEmail);
  await expect(guide).toBeHidden();
  await signOut();
  await signIn(secondEmail);
  await expect(guide).toBeVisible();
  await expect(guide.getByText("Step 1 of 3", { exact: true })).toBeVisible();
  await expect(guide.getByText("0 of 3 setup steps completed", { exact: true })).toBeVisible();

  const milestoneDb = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const now = Math.floor(Date.now() / 1000);
    const caseId = `A11Y_ONBOARDING_CASE_${randomUUID()}`;
    milestoneDb.prepare(`INSERT INTO cases
      (id, userId, clientName, caseType, caseSummary, urgency, status, createdAt, updatedAt)
      VALUES (?, ?, 'Onboarding case', 'Contract', 'Browser onboarding verification', 'Low', 'Intake', ?, ?)`)
      .run(caseId, secondId, now, now);
    milestoneDb.prepare(`INSERT INTO evidence
      (id, caseId, userId, type, source, title, relevant, createdAt, updatedAt)
      VALUES (?, ?, ?, 'document', 'manual', 'Reviewed setup evidence', 1, ?, ?)`)
      .run(`A11Y_ONBOARDING_EVIDENCE_${randomUUID()}`, caseId, secondId, now, now);
    milestoneDb.prepare(`INSERT INTO outreach_status
      (id, caseId, lawyerId, status, createdAt, updatedAt)
      VALUES (?, ?, ?, 'PendingApproval', ?, ?)`)
      .run(`A11Y_ONBOARDING_OUTREACH_${randomUUID()}`, caseId, lawyerId, now, now);
  } finally {
    milestoneDb.close();
  }

  const readyResponse = await page.reload({ waitUntil: "networkidle" });
  expect(readyResponse?.status()).toBe(200);
  await expect(guide.getByText("3 of 3 setup steps completed", { exact: true })).toBeVisible();
  await guide.getByRole("button", { name: /Prepare outreach for review/ }).click();
  await expect(guide.getByText("Step 3 of 3", { exact: true })).toBeVisible();
  await expect(guide.getByRole("button", { name: "Finish setup", exact: true })).toBeEnabled();
  await guide.getByRole("button", { name: "Finish setup", exact: true }).click();
  await expect(guide).toBeHidden();
  await page.reload({ waitUntil: "networkidle" });
  await expect(guide).toBeHidden();

  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Setup guide", exact: true }).click();
  await expect(guide).toBeVisible();
  await expect(guide.getByText("Step 1 of 3", { exact: true })).toBeVisible();
  await expect(guide.getByText("3 of 3 setup steps completed", { exact: true })).toBeVisible();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expectInsideViewport(guide);
    for (const action of ["Skip setup", "Continue later", "Next"]) {
      const control = guide.getByRole("button", { name: action, exact: true });
      await expect(control).toBeVisible();
      await expectInsideViewport(control);
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(audit.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`onboarding-${viewport.name}.png`), fullPage: false });
  }

  await guide.getByRole("button", { name: "Continue later", exact: true }).click();
  await signOut();
  await signIn(firstEmail);
  await expect(guide).toBeHidden();
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("core workflows reflow at 200 percent zoom and remain operable in forced colors", async ({ page }) => {
  await createAccount(page);

  // A 640 CSS-pixel viewport represents a 1280-pixel desktop viewed at 200%.
  await page.setViewportSize({ width: 640, height: 720 });
  for (const route of ["/", "/cases", "/evidence", "/outreach", "/settings"]) {
    await page.goto(route, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
      .toBe(true);
  }

  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/help", { waitUntil: "networkidle" });
  const menuTrigger = page.getByRole("button", { name: "Toggle sidebar" });
  await menuTrigger.focus();
  await expectVisibleKeyboardFocus(page, menuTrigger);
  await page.keyboard.press("Enter");
  await expect(menuTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#laro-mobile-sidebar")).toHaveAttribute("aria-hidden", "false");

  const analysis = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = analysis.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(blocking, formatViolations("/help", "forced-colors", blocking)).toEqual([]);
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
    page.getByRole("button", { name: "Documents", exact: true }),
    page.getByRole("button", { name: "Outreach", exact: true }),
    page.getByRole("button", { name: "Notes", exact: true }),
    page.getByRole("button", { name: "Settings", exact: true }),
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

test("Settings exposes only operational controls and an owned Flask migration", async ({ page }) => {
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
    await expect(page.getByText("Outreach Settings", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Notification Preferences", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Automatic matching", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Backup & restore", { exact: true })).toHaveCount(0);
    if (viewport.name === "mobile") {
      await page.getByRole("combobox", { name: "Settings sections" }).selectOption("security");
    } else {
      await page.getByRole("button", { name: "Security" }).click();
    }
    await expect(page.getByText("Account archive", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download archive" })).toBeVisible();
    await expect(page.getByText("reviewed-workspace")).toBeVisible();
    await expect(page.getByText("2 cases, 37 archived records, 5 files")).toBeVisible();
    await expect(page.getByText("Files verified")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
      .toBe(true);
  }
});

test("case actions can be completed and reopened without refreshing the page", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const email = await createAccount(page);
  const database = new Database(resolve(".laro-a11y.sqlite"));
  const now = Math.floor(Date.now() / 1000);
  try {
    const user = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    database.prepare(`INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, legalAreas, createdAt, updatedAt)
      VALUES (?, ?, 'Action workflow', 'Contract', 'Case action browser verification', 'Medium', 'active', '["contract law"]', ?, ?)`)
      .run(`A11Y_ACTION_${Date.now()}`, user.id, now, now);
  } finally { database.close(); }
  await page.goto("/cases", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open case", exact: true }).click();
  const panel = page.getByRole("region", { name: "Actions and deadlines" });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await panel.getByRole("button", { name: "Add action", exact: true }).click();
  await panel.getByLabel("Action", { exact: true }).fill("Request the missing decision");
  await panel.getByRole("button", { name: "Save action" }).click();
  await expect(panel.getByText("Request the missing decision", { exact: true })).toBeVisible();
  await expect(panel.getByText("No due date", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Complete: Request the missing decision", exact: true }).click();
  await expect(panel.getByText("No open actions.")).toBeVisible();
  await panel.getByRole("button", { name: "Completed", exact: true }).click();
  await panel.getByRole("button", { name: "Reopen: Request the missing decision", exact: true }).click();
  await expect(panel.getByText("No completed actions.")).toBeVisible();
  await panel.getByRole("button", { name: "Open", exact: true }).click();
  await expect(panel.getByText("Request the missing decision", { exact: true })).toBeVisible();
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expectInsideViewport(panel.getByRole("button", { name: "Add action", exact: true }));
    const audit = await new AxeBuilder({ page }).include('[aria-label="Actions and deadlines"]').analyze();
    expect(audit.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: `test-results/case-actions-${viewport.name}.png`, fullPage: false });
  }
  expect(pageErrors).toEqual([]);
});

test("document obligations become reviewable source-backed actions without manual retyping", async ({ page }) => {
  const errors: string[] = [];
  const matchingRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.url().includes("matching.findOfficialLawyers")) matchingRequests.push(request.url()); });
  await createAccount(page);
  await page.goto("/evidence", { waitUntil: "networkidle" });
  const inbox = page.getByRole("region", { name: "Document inbox" });
  await inbox.getByLabel("Upload documents").setInputFiles({ name: "action-source.txt", mimeType: "text/plain",
    buffer: Buffer.from("Zaaknummer: ACTION-QA-2026-3131\nDe gemeente moet uiterlijk 2026-10-12 het besluit toezenden.\nBinnen 6 weken kunt u bezwaar maken.") });
  await expect(inbox.getByText("1 / 1 processed", { exact: true })).toBeVisible({ timeout: 120_000 });
  await page.goto("/cases", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open case", exact: true }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  const proposals = page.getByRole("region", { name: "Suggested actions" });
  await expect(proposals).toBeVisible();
  await proposals.getByRole("button", { name: "Accept proposal" }).first().click();
  await expect(proposals.getByText("Accepted", { exact: true })).toBeVisible();
  const actions = page.getByRole("region", { name: "Actions and deadlines" });
  await expect(actions.getByText("No due date", { exact: true })).toBeVisible();
  await actions.getByText("Action source", { exact: true }).click();
  await expect(actions.getByText("Not a verified legal obligation or deadline", { exact: true }).first()).toBeVisible();
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('[aria-label="Actions and deadlines"]').analyze();
    expect(audit.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: `../artifacts/action-proposals-${viewport.name}.png`, fullPage: false });
  }
  expect(matchingRequests, "reviewing source-based actions must not trigger an unrelated provider search").toEqual([]);
  expect(errors).toEqual([]);
  await page.setViewportSize(VIEWPORTS[0]);
  await page.getByRole("navigation", { name: "Case sections", exact: true }).locator("summary").click();
  await page.getByRole("button", { name: "Lawyers", exact: true }).click();
  const search = page.getByRole("button", { name: "Search NOvA", exact: true });
  await expect(search).toBeEnabled();
  expect(matchingRequests).toEqual([]);
  await search.click();
  // This provisional fixture has no classified legal area. The server detail
  // must stay out of the client-facing envelope and browser console.
  const safeMessage = "The request could not be completed. Please try again.";
  await expect(page.getByRole("alert").filter({ hasText: safeMessage })).toBeVisible();
  await expect(page.getByText("Case must have at least one legal area specified", { exact: true })).toHaveCount(0);
  expect(errors.some((message) => message.includes("Case must have at least one legal area specified"))).toBe(false);
  expect(matchingRequests).toHaveLength(1);
});

test("action execution evidence preserves passages and reversible assessments without auto-completing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await createAccount(page);
  await page.goto("/evidence", { waitUntil: "networkidle" });
  const inbox = page.getByRole("region", { name: "Document inbox" });
  await inbox.getByLabel("Upload documents").setInputFiles({ name: "execution.txt", mimeType: "text/plain",
    buffer: Buffer.from("Zaaknummer: EXECUTION-QA-2026-9171\nDe gemeente moet het besluit toezenden.\nOp 2026-09-04 schreef de gemeente: het besluit is verzonden.") });
  await expect(inbox.getByText("1 / 1 processed", { exact: true })).toBeVisible({ timeout: 120_000 });
  await page.goto("/cases", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open case", exact: true }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("region", { name: "Suggested actions" }).getByRole("button", { name: "Accept proposal" }).first().click();
  const actions = page.getByRole("region", { name: "Actions and deadlines" });
  await actions.getByText("Execution evidence", { exact: true }).click();
  const links = actions.getByRole("region", { name: "Execution evidence links" });
  await links.getByRole("button", { name: "Link evidence", exact: true }).click();
  await links.getByLabel("Evidence document").selectOption({ label: "execution.txt" });
  await links.getByRole("checkbox", { name: /het besluit is verzonden/ }).check();
  await links.getByLabel("Assessment").fill("De gemeente meldt verzending; ontvangst is nog niet bevestigd.");
  await links.getByRole("button", { name: "Save evidence link" }).click();
  await expect(links.getByText("Supports execution", { exact: true })).toBeVisible();
  await expect(links.getByText("User assessment; not independently verified", { exact: true })).toBeVisible();
  await expect(actions.getByRole("button", { name: /^Complete:/ })).toBeVisible();
  await links.getByText("Source passages", { exact: true }).click();
  await expect(links.getByText(/Lines .*het besluit is verzonden/)).toBeVisible();
  const sourceDownload = page.waitForEvent("download");
  await links.getByRole("button", { name: "Open execution source" }).click();
  const original = await sourceDownload;
  expect(readFileSync((await original.path())!, "utf8")).toContain("Zaaknummer: EXECUTION-QA-2026-9171");
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('[aria-label="Execution evidence links"]').analyze();
    expect(audit.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: `../artifacts/action-execution-${viewport.name}.png` });
  }
  await links.getByRole("button", { name: "Withdraw evidence link" }).click();
  await expect(links.getByText("Withdrawn", { exact: true })).toBeVisible();
  await links.getByRole("button", { name: "Restore evidence link" }).click();
  await expect(links.getByText("Withdrawn", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("inbox corrects and reverses dossier assignments without losing the source", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await createAccount(page);
  await page.goto("/evidence", { waitUntil: "networkidle" });
  const inbox = page.getByRole("region", { name: "Document inbox" });
  await inbox.getByLabel("Upload documents").setInputFiles([
    { name: "correct-source.txt", mimeType: "text/plain", buffer: Buffer.from("Zaaknummer: CORRECT-QA-2026-1101\nOp 2026-09-01 moet de gemeente het besluit toezenden.") },
    { name: "target-source.txt", mimeType: "text/plain", buffer: Buffer.from("Zaaknummer: TARGET-QA-2026-2202\nOp 2026-09-02 schreef de gemeente over een andere situatie.") },
  ]);
  await expect(inbox.getByText("2 / 2 processed", { exact: true })).toBeVisible({ timeout: 120_000 });
  await inbox.getByRole("button", { name: "Details: correct-source.txt" }).click();
  const correction = inbox.getByRole("region", { name: "Dossier assignment" });
  await correction.getByRole("button", { name: "Correct dossier", exact: true }).click();
  await correction.getByRole("combobox", { name: "Target dossier", exact: true }).selectOption({ label: "Dossier TARGET-QA-2026-2202" });
  await expect(correction.getByRole("button", { name: "Move document" })).toBeDisabled();
  await correction.getByLabel("Correction reason").fill("Deze brief hoort bij de tweede situatie.");
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await correction.scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('[aria-label="Dossier assignment"]').analyze();
    expect(audit.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: `../artifacts/inbox-correction-${viewport.name}.png` });
  }
  await correction.getByRole("button", { name: "Move document" }).click();
  await expect(correction.getByText("Current dossier: Dossier TARGET-QA-2026-2202", { exact: true })).toBeVisible();
  await expect(correction.getByText("Deze brief hoort bij de tweede situatie.", { exact: true })).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await inbox.getByRole("button", { name: "Download: correct-source.txt" }).click();
  expect(readFileSync((await (await downloaded).path())!, "utf8")).toContain("CORRECT-QA-2026-1101");
  await correction.getByRole("button", { name: "Correct dossier", exact: true }).click();
  await correction.getByRole("combobox", { name: "Target dossier", exact: true }).selectOption({ label: "Dossier CORRECT-QA-2026-1101" });
  await correction.getByLabel("Correction reason").fill("Na controle herstel ik de eerdere koppeling.");
  await correction.getByRole("button", { name: "Move document" }).click();
  await expect(correction.getByText("Current dossier: Dossier CORRECT-QA-2026-1101", { exact: true })).toBeVisible();
  await expect(correction.getByRole("listitem")).toHaveCount(2);
  await page.reload({ waitUntil: "networkidle" });
  await inbox.getByRole("button", { name: "Details: correct-source.txt" }).click();
  await expect(correction.getByText("Current dossier: Dossier CORRECT-QA-2026-1101", { exact: true })).toBeVisible();
  await correction.getByRole("button", { name: "Correction history" }).click();
  await expect(correction.getByRole("listitem")).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("source controls retain paused work and refresh status without reloading", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("laro.locale")) localStorage.setItem("laro.locale", "en");
  });
  const email = await createAccount(page);
  const database = new Database(resolve(".laro-a11y.sqlite"));
  const jobId = crypto.randomUUID();
  try {
    const user = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    const now = Math.floor(Date.now() / 1000);
    // Persisted UI fixture, not an authorized live Google source.
    database.prepare("INSERT INTO document_source_jobs (id,userId,kind,config,status,createdAt,updatedAt) VALUES (?,?, 'gmail', ?, 'paused', ?, ?)")
      .run(jobId, user.id, JSON.stringify({ kind: "gmail", accountId: "disconnected-test-account", query: "", includeSpamTrash: false }), now, now);
    database.prepare("INSERT INTO document_source_work (id,jobId,userId,kind,payload,label,isDocument,status,createdAt,updatedAt) VALUES (?,?,?, 'gmail_page', '{}', 'Gmail inventory', 0, 'queued', ?, ?)")
      .run(`${jobId}-page`, jobId, user.id, now, now);
  } finally { database.close(); }
  await page.goto("/evidence", { waitUntil: "networkidle" });
  const sources = page.getByRole("region", { name: "Document sources" });
  await expect(sources).toBeVisible();
  await expect(sources.getByText("Paused", { exact: true })).toBeVisible();
  await sources.getByRole("button", { name: "Add source" }).click();
  await expect(sources.getByRole("button", { name: "Start source" })).toBeDisabled();
  await expect(sources.getByRole("button", { name: "Check Google access" })).toBeDisabled();
  for (const label of ["Originals saved", "Analyzed", "Filed in dossiers"]) await expect(sources.getByText(label, { exact: true })).toBeVisible();
  await expect(sources.getByRole("button", { name: "Select local source" })).toHaveCount(0);
  await sources.getByRole("button", { name: "Resume source" }).click();
  await expect(sources.getByText("Completed with errors", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(sources.getByRole("button", { name: "Retry unfinished processing" })).toBeVisible();
  await expect(sources.getByRole("button", { name: "Check source for new or changed files" })).toBeVisible();
  await sources.getByRole("button", { name: "Source details" }).click();
  // The handoff maps raw provider errors to a cause and actionable recovery text.
  const failures = sources.getByRole("region", { name: "Source failures" });
  await expect(failures.getByText("Google rejected access or the account connection is no longer available.", { exact: true })).toBeVisible();
  await expect(failures.getByText("Reconnect the Google account in Settings and check its permissions.", { exact: true })).toBeVisible();
  await expect(sources.getByText("Failure code: google_access", { exact: true })).toBeVisible();
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('[aria-label="Document sources"]').analyze();
    expect(audit.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: `test-results/document-sources-${viewport.name}.png`, fullPage: false });
  }
  await page.evaluate(() => localStorage.setItem("laro.locale", "nl"));
  const dutchReload = await page.reload({ waitUntil: "networkidle" });
  expect(dutchReload?.status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  const dutchSources = page.getByRole("region", { name: "Documentbronnen" });
  await expect(dutchSources.getByText("Voltooid met fouten", { exact: true })).toBeVisible();
  await expect(dutchSources.getByRole("button", { name: "Onvoltooide verwerking opnieuw proberen" })).toBeVisible();
  const dutchFailures = dutchSources.getByRole("region", { name: "Bronfouten" });
  await expect(dutchFailures.getByText("Google heeft de toegang geweigerd of de accountkoppeling is niet meer beschikbaar.", { exact: true })).toBeVisible();
  await expect(dutchSources.getByLabel("Voortgang bronverwerking", { exact: true })).toBeVisible();
  await dutchSources.screenshot({ path: test.info().outputPath("document-sources-nl.png") });
});

test("shared Google disconnect review names both capabilities and cancellation preserves multiple accounts", async ({ page }, testInfo) => {
  const email = await createAccount(page);
  const caseId = `GOOGLE_DISCONNECT_${randomUUID()}`;
  const primaryAccountId = `GOOGLE_PRIMARY_${randomUUID()}`;
  const otherAccountId = `GOOGLE_OTHER_${randomUUID()}`;
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const owner = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    const now = Math.floor(Date.now() / 1000);
    database.prepare("INSERT INTO cases (id,userId,clientName,createdAt,updatedAt) VALUES (?,?,?,?,?)")
      .run(caseId, owner.id, "Google disconnect review", now, now);
    const insertAccount = database.prepare("INSERT INTO email_accounts (id,userId,provider,email,status,accessToken,connectedAt,createdAt,updatedAt) VALUES (?,?, 'gmail', ?, 'connected', 'TEST_CIPHERTEXT', ?, ?, ?)");
    insertAccount.run(primaryAccountId, owner.id, "primary-google@example.test", now, now, now);
    insertAccount.run(otherAccountId, owner.id, "other-google@example.test", now, now, now);
    database.prepare(`INSERT INTO auto_collection_settings
      (id,caseId,userId,emailAccountIds,metadata,autoDownloadAttachments,autoDownloadGoogleDriveFiles,isEnabled,updatedAt)
      VALUES (?,?,?,?,?,1,1,1,?)`)
      .run(
        `SETTINGS_${primaryAccountId}`,
        caseId,
        owner.id,
        JSON.stringify([primaryAccountId, otherAccountId]),
        JSON.stringify({ googleDriveSources: [
          { accountId: primaryAccountId, folderIds: ["primary-folder"] },
          { accountId: otherAccountId, folderIds: ["other-folder"] },
        ] }),
        now,
      );
    const insertSource = database.prepare("INSERT INTO evidence_sources (id,caseId,userId,sourceType,status,createdAt) VALUES (?,?,?,?, 'connected', ?)");
    insertSource.run(`SOURCE_GMAIL_${primaryAccountId}`, caseId, owner.id, "Gmail", now);
    insertSource.run(`SOURCE_DRIVE_${primaryAccountId}`, caseId, owner.id, "GoogleDrive", now);
  } finally {
    database.close();
  }

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badResponses: Array<{ status: number; url: string }> = [];
  let disconnectMutations = 0;
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => requestFailures.push(`${request.method()} ${request.url()}`));
  page.on("response", response => { if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() }); });
  page.on("request", request => {
    if (request.method() === "POST" && /providerConnections\.disconnect(?:\?|$)/.test(decodeURIComponent(request.url()))) {
      disconnectMutations += 1;
    }
  });

  const response = await page.goto(`/evidence?view=connections&case=${caseId}`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  const account = page.getByTestId("google-account").filter({ hasText: "primary-google@example.test" });
  await account.getByRole("button", { name: "Disconnect primary-google@example.test", exact: true }).click();
  await expect(account.getByText("Review shared Google disconnect", { exact: true })).toBeVisible();
  await expect(account.getByText("The shared Google OAuth credential will be revoked and removed.", { exact: true })).toBeVisible();
  await expect(account.getByText("Gmail evidence collection will be removed", { exact: true })).toBeVisible();
  await expect(account.getByText("Google Drive evidence collection will be removed", { exact: true })).toBeVisible();
  await expect(account.getByText(/1 scheduled collection configuration.*reference this account/)).toBeVisible();
  await expect(account.getByText("Google disconnect review: Gmail and Google Drive (enabled)", { exact: true })).toBeVisible();
  await expect(account.getByText("2 local Google source record(s) will remain for the 1 other Google account(s).", { exact: true })).toBeVisible();
  await expect(account.getByText("Gmail: 1 record(s) will remain", { exact: true })).toBeVisible();
  await expect(account.getByText("Google Drive: 1 record(s) will remain", { exact: true })).toBeVisible();
  await expect(account.getByText("Collected documents and other Google accounts stay unchanged.", { exact: true })).toBeVisible();
  await expect(account.getByRole("button", { name: "Revoke Gmail and Drive", exact: true })).toBeEnabled();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await account.scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('[aria-label="Google accounts"]').analyze();
    expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await account.screenshot({ path: testInfo.outputPath(`shared-google-disconnect-${viewport.name}.png`) });
  }

  await account.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(account.getByText("Review shared Google disconnect", { exact: true })).toHaveCount(0);
  expect(disconnectMutations).toBe(0);
  const verification = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const accountCount = verification.prepare("SELECT COUNT(*) AS total FROM email_accounts WHERE id IN (?, ?)")
      .get(primaryAccountId, otherAccountId) as { total: number };
    const settings = verification.prepare("SELECT emailAccountIds, metadata FROM auto_collection_settings WHERE id = ?")
      .get(`SETTINGS_${primaryAccountId}`) as { emailAccountIds: string; metadata: string };
    const sourceCount = verification.prepare("SELECT COUNT(*) AS total FROM evidence_sources WHERE id IN (?, ?)")
      .get(`SOURCE_GMAIL_${primaryAccountId}`, `SOURCE_DRIVE_${primaryAccountId}`) as { total: number };
    expect(accountCount.total).toBe(2);
    expect(JSON.parse(settings.emailAccountIds)).toEqual([primaryAccountId, otherAccountId]);
    expect(JSON.parse(settings.metadata).googleDriveSources).toHaveLength(2);
    expect(sourceCount.total).toBe(2);
  } finally {
    verification.close();
  }
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(badResponses).toEqual([]);
});

test("inbox discovers and grows a dossier without preselecting a case", async ({ page }) => {
  await createAccount(page);
  await page.goto("/evidence", { waitUntil: "networkidle" });
  const inbox = page.getByRole("region", { name: "Document inbox" });
  await expect(inbox).toBeVisible();
  await inbox.getByLabel("Upload documents").setInputFiles([
    { name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("Zaaknummer: QA-2026-7451\nOp 2026-08-01 verklaart de gemeente dat het besluit is verzonden.") },
    { name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("Zaaknummer: QA-2026-7451\nOp 2026-08-10 moet de gemeente een ontbrekend document toezenden.") },
  ]);
  await expect(inbox.getByText("2 / 2 processed", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(inbox.getByText("Dossier QA-2026-7451", { exact: true })).toHaveCount(2);
  await inbox.getByRole("button", { name: "Details: first.txt" }).click();
  await expect(inbox.getByText("New provisional dossier from source reference: QA-2026-7451", { exact: true }).first()).toBeVisible();
  await expect(inbox.getByText("Source passages", { exact: true })).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await inbox.getByRole("button", { name: "Download: first.txt" }).click();
  const original = await downloaded;
  expect(original.suggestedFilename()).toBe("first.txt");
  expect(readFileSync((await original.path())!, "utf8")).toContain("Zaaknummer: QA-2026-7451");
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('[aria-label="Document inbox"]').analyze();
    expect(audit.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: `test-results/document-inbox-${viewport.name}.png`, fullPage: false });
  }
  await inbox.getByRole("button", { name: "Open case: first.txt" }).click();
  await expect(page.getByRole("heading", { name: "Evidence Timeline" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show document map" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Chronological events" }).getByText("Details and source: first.txt", { exact: true }).first()).toBeVisible();
});

test("inbox shows a retained discovery explanation without presenting a review as an applied decision", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const email = await createAccount(page);
  await page.goto("/evidence", { waitUntil: "networkidle" });
  const inbox = page.getByRole("region", { name: "Document inbox" });
  const source = "De verhuurder heeft de brief ontvangen.\n\nHet geschil betreft lekkage in de woning.";
  await inbox.getByLabel("Upload documents").setInputFiles({ name: "discovery-review.txt", mimeType: "text/plain", buffer: Buffer.from(source) });
  await expect(inbox.getByText("1 / 1 processed", { exact: true })).toBeVisible({ timeout: 120_000 });
  // This fixture validates presentation, not a live language-model decision.
  const database = new Database(resolve(".laro-a11y.sqlite"));
  try {
    const user = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    database.prepare("UPDATE document_inbox SET discovery = ?, reason = ? WHERE userId = ? AND fileName = ?").run(JSON.stringify({
      action: "review", confidence: "low", caseId: null, title: "", summary: "", provider: "ollama",
      reason: "More than one situation requires review.",
      basis: [{ kind: "situation", citationId: "citation-1", quote: "Het geschil betreft lekkage in de woning.",
        caseCitationId: "case:qa:context", caseQuote: "Eerder gemelde lekkage in de woning." }],
    }), "More than one situation requires review.", user.id, "discovery-review.txt");
  } finally { database.close(); }
  await inbox.getByRole("button", { name: "Details: discovery-review.txt" }).click();
  await inbox.getByText("Dossier decision", { exact: true }).click();
  await expect(inbox.getByText("Not applied; review required | ollama", { exact: true })).toBeVisible();
  await expect(inbox.getByText("Case context (not independent evidence)", { exact: true })).toBeVisible();
  await expect(inbox.getByText("Eerder gemelde lekkage in de woning.", { exact: true })).toBeVisible();
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('[aria-label="Document inbox"]').analyze();
    expect(audit.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: `test-results/discovery-explanation-${viewport.name}.png`, fullPage: false });
  }
  await page.evaluate(() => localStorage.setItem("laro.locale", "nl"));
  const dutchReload = await page.reload({ waitUntil: "networkidle" });
  expect(dutchReload?.status()).toBe(200);
  const dutchInbox = page.getByRole("region", { name: "Documenteninbox", exact: true });
  await dutchInbox.getByRole("button", { name: "Details: discovery-review.txt", exact: true }).click();
  await dutchInbox.getByText("Dossierbeslissing", { exact: true }).click();
  await expect(dutchInbox.getByText("Niet toegepast; beoordeling vereist | ollama", { exact: true })).toBeVisible();
  await expect(dutchInbox.getByText("Dossiercontext (geen zelfstandig bewijs)", { exact: true })).toBeVisible();
  await expect(dutchInbox.getByText("Eerder gemelde lekkage in de woning.", { exact: true })).toBeVisible();
  await dutchInbox.screenshot({ path: testInfo.outputPath("discovery-explanation-nl.png") });
  expect(errors).toEqual([]);
});

test("document reconstruction focuses source-linked participants, topics, and actions", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("laro.locale")) localStorage.setItem("laro.locale", "en");
  });
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
  await page.getByRole("button", { name: "Open case", exact: true }).click();
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Evidence Timeline" })).toBeVisible();
  await page.getByText("Filter documents and links", { exact: true }).click();
  const focus = page.getByRole("combobox", { name: "Focus", exact: true });
  await expect(focus).toContainText("Gemeente Utrecht (1)");
  await expect(focus).toContainText("administrative law (2)");
  await focus.selectOption({ label: "Jan de Vries (1)" });
  await expect(page.getByRole("heading", { name: "Objection submitted", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open source document for Municipal decision issued", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Correct event Objection submitted", exact: true })).toBeVisible();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }
  await page.screenshot({ path: test.info().outputPath("case-reconstruction-focus.png"), fullPage: false });
  await focus.selectOption("all");
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expectInsideViewport(page.getByRole("dialog"));
    for (const orientation of ["horizontal", "vertical"]) {
      await page.getByRole("button", { name: "Show document map", exact: true }).click();
      await page.getByRole("button", { name: `Show ${orientation} map`, exact: true }).click();
      const map = page.getByLabel("Scrollable document reconstruction map", { exact: true });
      await expect(map.locator("svg[role=img]")).toBeVisible();
      const box = await map.boundingBox();
      expect(box!.width).toBeGreaterThan(180);
      expect(box!.height).toBeGreaterThan(100);
      await map.screenshot({ path: test.info().outputPath(`reconstruction-${orientation}-${viewport.name}.png`) });
    }
    await page.getByRole("button", { name: "Show Gantt timeline", exact: true }).click();
    const gantt = page.getByLabel("Evidence Gantt timeline", { exact: true });
    await expect(gantt).toBeVisible();
    await expect(gantt.getByRole("button", { name: /Select Objection/ })).toBeVisible();
    await gantt.screenshot({ path: test.info().outputPath(`reconstruction-gantt-${viewport.name}.png`) });
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
    await expect(page.locator("article").filter({ hasText: "Objection.txt" })).toBeVisible();
    const audit = await new AxeBuilder({ page }).include('[aria-label="Case content"]').analyze();
    expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
  }

  await page.getByRole("button", { name: "Close case details", exact: true }).click();
  await page.evaluate(() => localStorage.setItem("laro.locale", "nl"));
  const dutchReload = await page.reload({ waitUntil: "networkidle" });
  expect(dutchReload?.status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await page.getByRole("button", { name: "Dossier openen", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Dossieronderdeel", exact: true })).toHaveValue("evidence-timeline");
  await expect(page.getByRole("button", { name: "Documentkaart tonen", exact: true })).toBeVisible();
  await page.getByText("Documenten en koppelingen filteren", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Focus", exact: true })).toContainText("Alle deelnemers en onderwerpen");
  await page.getByRole("button", { name: "Documentkaart tonen", exact: true }).click();
  const dutchMap = page.getByLabel("Schuifbare documentreconstructiekaart", { exact: true });
  await expect(dutchMap.locator("svg[role=img]")).toBeVisible();
  await expect(dutchMap).toContainText("Juridische procedure");
  await dutchMap.screenshot({ path: test.info().outputPath("reconstruction-map-nl.png") });
});

test("assistant timeline proposals stay unapplied until explicit review", async ({ page }, testInfo) => {
  const errors: string[] = [];
  const failedRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));
  await page.addInitScript(() => localStorage.setItem("laro.locale", "en"));
  const email = await createAccount(page);
  const database = new Database(resolve(".laro-a11y.sqlite"));
  const now = Math.floor(Date.now() / 1_000);
  const caseId = `A11Y_CORRECTION_${now}`;
  const evidenceId = `${caseId}_SOURCE`;
  const proposalId = `TIMEPROP-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  try {
    const user = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    database.prepare(
      `INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, legalAreas, createdAt, updatedAt)
       VALUES (?, ?, 'Correction review', 'Administrative dispute', 'Explicit correction review QA', 'Medium', 'active', '["administrative law"]', ?, ?)`,
    ).run(caseId, user.id, now, now);
    const text = "Gemeente Utrecht issued the administrative decision on 2026-07-14.";
    const result = analysisResult({ party: "Gemeente Utrecht", date: "2026-07-14", title: "Municipal decision issued", text });
    database.prepare(
      `INSERT INTO evidence (id, caseId, userId, type, source, title, description, mimeType, metadata, relevant, createdAt, updatedAt)
       VALUES (?, ?, ?, 'document', 'manual', 'Municipal decision.txt', ?, 'text/plain', '{}', 1, ?, ?)`,
    ).run(evidenceId, caseId, user.id, text, now, now);
    database.prepare(
      `INSERT INTO document_analyses
       (id, evidenceId, caseId, userId, analysisVersion, contentHash, status, extractionMethod, providerStatus,
        documentType, confidence, summary, result, analyzedChars, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, '2.2.0', ?, 'complete', 'plain_text', 'not_requested',
        'administrative decision', 88, ?, ?, ?, ?, ?)`,
    ).run(`${evidenceId}_ANALYSIS`, evidenceId, caseId, user.id, result.contentHash, result.summary, JSON.stringify(result), result.analyzedChars, now, now);
    const before = {
      date: "2026-07-14", title: "Municipal decision issued", description: text,
      actor: "Gemeente Utrecht", category: "legal", evidenceId, evidenceTitle: "Municipal decision.txt",
    };
    const after = { ...before, date: "2026-07-15" };
    delete (after as Partial<typeof before>).evidenceTitle;
    const proposal = {
      status: "pending", baseRevision: "a".repeat(64), sequence: 1, operation: "update",
      targetKey: `2026-07-14|municipal decision issued|${evidenceId}`,
      before, after, instruction: "Change the decision date to 2026-07-15.",
      reason: "The owner explicitly supplied a corrected date.", provider: "openai", actorUserId: user.id,
      sourceBasis: {
        evidenceId, evidenceTitle: "Municipal decision.txt",
        fields: [{ field: "date", basis: "owner_instruction", citationIds: [], evidenceQuotes: ["2026-07-15"] }],
      },
      proposedAt: new Date().toISOString(), review: null,
    };
    database.prepare(
      `INSERT INTO timeline (id, caseId, userId, eventType, title, description, eventAt, metadata, createdAt)
       VALUES (?, ?, ?, 'ai_timeline_correction_proposal', ?, ?, ?, ?, ?)`,
    ).run(proposalId, caseId, user.id, after.title, proposal.reason, now, JSON.stringify({ evidenceId, timelineCorrectionProposal: proposal }), now);
  } finally {
    database.close();
  }

  await page.goto("/cases", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open case", exact: true }).click();
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Evidence Timeline" })).toBeVisible();
  await page.getByText("Advanced: request an assistant correction", { exact: true }).click();
  const review = page.getByRole("region", { name: "Review correction proposal" });
  await expect(review.getByText("Not applied", { exact: true })).toBeVisible();
  await expect(review.getByText(/2026-07-14.*Municipal decision issued/)).toBeVisible();
  await expect(review.getByText(/2026-07-15.*Municipal decision issued/)).toBeVisible();
  await expect(review.getByText(/owner instruction.*2026-07-15/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Chronological events" }).getByText("14 juli 2026", { exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Confirm and apply" })).toBeVisible();
  await review.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("timeline-correction-review-desktop.png"), fullPage: false });
  await page.setViewportSize(VIEWPORTS[1]);
  await review.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("timeline-correction-review-mobile.png"), fullPage: false });
  const audit = await new AxeBuilder({ page }).include('[aria-labelledby="correction-review-title"]').analyze();
  expect(audit.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
  await review.getByRole("button", { name: "Reject proposal" }).click();
  await expect(page.getByText("Proposal rejected. The timeline was not changed.", { exact: true })).toBeVisible();
  await expect(review).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("workspace preserves navigation, view links and visible settings controls", async ({ page }, testInfo) => {
  await createAccount(page);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(page).toHaveURL(/view=timeline/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Select a case", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Select a case", exact: true })).toBeVisible();
  await page.goto("/settings?section=workflow");
  const toggle = page.getByRole("switch", { name: "Analyze imports automatically", exact: true });
  await expect(toggle).toBeEnabled();
  const checked = await toggle.getAttribute("aria-checked");
  const before = await toggle.evaluate(element => ({ width: element.getBoundingClientRect().width, background: getComputedStyle(element).backgroundColor }));
  expect(before.width).toBeGreaterThanOrEqual(40);
  expect(before.background).not.toBe("rgba(0, 0, 0, 0)");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", checked === "true" ? "false" : "true");
  await expect.poll(() => toggle.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(before.background);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", checked === "true" ? "false" : "true");
  await page.screenshot({ path: testInfo.outputPath("settings-visible-switches.png"), fullPage: true });
  await page.setViewportSize(VIEWPORTS[1]);
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await expect(page.locator("#laro-mobile-sidebar")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("heading", { name: "Documents", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Toggle sidebar" })).toHaveAttribute("aria-expanded", "false");
});

test("assistant preserves an unsent draft while closing and navigating", async ({ page }) => {
  await createAccount(page);
  await page.getByRole("button", { name: "Open LARO assistant" }).click();
  await page.getByRole("textbox", { name: "Message LARO assistant" }).fill("Unsent review draft");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page.getByRole("button", { name: "Open LARO assistant" }).click();
  await expect(page.getByRole("textbox", { name: "Message LARO assistant" })).toHaveValue("Unsent review draft");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("assistant shows its case, ignores legacy storage, and clears context on navigation and refresh", async ({ page }, testInfo) => {
  const email = await createAccount(page);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  const ownerId = (database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
  const caseA = `A11Y_ASSISTANT_A_${randomUUID()}`;
  const caseB = `A11Y_ASSISTANT_B_${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    const insert = database.prepare("INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, createdAt, updatedAt) VALUES (?, ?, ?, 'Contract', 'Assistant context test', 'Low', 'Intake', ?, ?)");
    insert.run(caseA, ownerId, "Matter Alpha", now, now);
    insert.run(caseB, ownerId, "Matter Beta", now, now);
  } finally { database.close(); }

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badApiResponses: string[] = [];
  const asks: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => {
    if (!request.failure()?.errorText?.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}`);
  });
  page.on("response", response => {
    if (response.url().includes("/api/trpc/") && response.status() >= 400) badApiResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("request", request => {
    if (request.url().includes("assistant.ask")) asks.push(request.postData() ?? "");
  });

  await page.evaluate(id => localStorage.setItem("active-case-context-id", id), caseA);
  const reload = await page.reload({ waitUntil: "networkidle" });
  expect(reload?.status()).toBe(200);
  expect(await page.evaluate(() => localStorage.getItem("active-case-context-id"))).toBeNull();
  await page.getByRole("button", { name: "Open LARO assistant" }).click();
  let assistant = page.getByRole("dialog");
  await expect(assistant.getByRole("button", { name: "Case: Product help (no case)" })).toBeVisible();
  await assistant.getByRole("textbox", { name: "Message LARO assistant" }).fill("How do I scan documents?");
  await assistant.getByRole("button", { name: "Send message" }).click();
  await expect(assistant.getByText("Product help", { exact: true })).toBeVisible();
  expect(asks[0]).not.toContain(caseA);
  expect((JSON.parse(asks[0]) as Record<string, { json: { caseId: null } }>)["0"].json.caseId).toBeNull();

  await assistant.getByRole("button", { name: "Case: Product help (no case)" }).click();
  await page.getByRole("button", { name: "Matter Alpha", exact: true }).click();
  await expect(assistant.getByText("Source-grounded case mode: Matter Alpha", { exact: true })).toBeVisible();
  await assistant.getByRole("textbox", { name: "Message LARO assistant" }).fill("What happened in this case?");
  await assistant.getByRole("button", { name: "Send message" }).click();
  await expect(assistant.getByLabel("Answer case identity")).toHaveText("Case: Matter Alpha");
  expect(asks[1]).toContain(caseA);
  await page.screenshot({ path: testInfo.outputPath("assistant-visible-case-alpha.png"), fullPage: true });

  await assistant.getByRole("button", { name: "Case: Matter Alpha" }).click();
  await page.getByRole("button", { name: "Matter Beta", exact: true }).click();
  await expect(assistant.getByText("Source-grounded case mode: Matter Beta", { exact: true })).toBeVisible();
  await expect(assistant.getByLabel("Answer case identity")).toHaveCount(0);
  await assistant.getByRole("textbox", { name: "Message LARO assistant" }).fill("What happened in this case?");
  await assistant.getByRole("button", { name: "Send message" }).click();
  await expect(assistant.getByLabel("Answer case identity")).toHaveText("Case: Matter Beta");
  expect(asks[2]).toContain(caseB);
  expect(asks[2]).not.toContain(caseA);

  await assistant.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page.getByRole("button", { name: "Open LARO assistant" }).click();
  assistant = page.getByRole("dialog");
  await expect(assistant.getByRole("button", { name: "Case: Product help (no case)" })).toBeVisible();
  await expect(assistant.getByLabel("Answer case identity")).toHaveCount(0);
  await assistant.getByRole("button", { name: "Case: Product help (no case)" }).click();
  await page.getByRole("button", { name: "Matter Beta", exact: true }).click();
  const secondReload = await page.reload({ waitUntil: "networkidle" });
  expect(secondReload?.status()).toBe(200);
  await page.getByRole("button", { name: "Open LARO assistant" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Case: Product help (no case)" })).toBeVisible();

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(badApiResponses).toEqual([]);
});

test("assistant case-view selection closes with the case and cannot cross accounts", async ({ page }, testInfo) => {
  const email = await createAccount(page);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  const ownerA = (database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
  const ownerB = `A11Y_${randomUUID()}`;
  const caseA = `A11Y_ASSISTANT_A_${randomUUID()}`;
  const caseB = `A11Y_ASSISTANT_B_${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    database.prepare("INSERT INTO users (id, email, name, password, role, createdAt) VALUES (?, ?, 'Second owner', NULL, 'user', ?)")
      .run(ownerB, `${ownerB.toLowerCase()}@example.test`, now);
    database.prepare("INSERT INTO system_config (configKey, configValue, updatedAt) VALUES (?, ?, ?)")
      .run(`onboarding:state:${ownerB}`, JSON.stringify({ status: "complete", currentStepKey: "outreach" }), now);
    const insert = database.prepare("INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, createdAt, updatedAt) VALUES (?, ?, ?, 'Contract', 'Account context test', 'Low', 'Intake', ?, ?)");
    insert.run(caseA, ownerA, "Owner A matter", now, now);
    insert.run(caseB, ownerB, "Owner B matter", now, now);
  } finally { database.close(); }

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => {
    if (!request.failure()?.errorText?.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}`);
  });

  const casePage = await page.goto(`/cases?case=${caseA}`, { waitUntil: "networkidle" });
  expect(casePage?.status()).toBe(200);
  await page.getByRole("button", { name: "Ask assistant about this case" }).click();
  await expect(page.getByText("Source-grounded case mode: Owner A matter", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("assistant-from-case-view.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close case details" }).click();
  await page.getByRole("button", { name: "Open LARO assistant" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Case: Product help (no case)" })).toBeVisible();

  await page.getByRole("dialog").getByRole("button", { name: "Case: Product help (no case)" }).click();
  await page.getByRole("button", { name: "Owner A matter", exact: true }).click();
  await expect(page.getByText("Source-grounded case mode: Owner A matter", { exact: true })).toBeVisible();
  const tokenB = jwt.sign({ userId: ownerB }, "laro-a11y-jwt-secret-32-characters-minimum", { expiresIn: "1h" });
  await page.context().addCookies([{
    name: COOKIE_NAME, value: tokenB, url: "http://127.0.0.1:5181", httpOnly: true, sameSite: "Lax",
  }]);
  await page.evaluate(() => window.dispatchEvent(new Event("laro:scanner-session-changed")));
  await expect(page.getByText("Source-grounded case mode: Owner A matter", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Owner B matter", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Owner A matter", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open LARO assistant" }).click();
  const assistant = page.getByRole("dialog");
  await expect(assistant.getByRole("button", { name: "Case: Product help (no case)" })).toBeVisible();
  await assistant.getByRole("button", { name: "Case: Product help (no case)" }).click();
  await expect(page.getByRole("button", { name: "Owner B matter", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Owner A matter", exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("assistant-after-account-switch.png"), fullPage: true });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test("notes preserve a draft, save once and reveal the full text without sending mail", async ({ page }, testInfo) => {
  const email = await createAccount(page);
  const outbound: string[] = [];
  page.on("request", request => {
    if (/sendApproved|email\.send/.test(request.url())) outbound.push(request.url());
  });
  await page.goto("/messages", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New note", exact: true }).click();
  const draft = Array.from({ length: 14 }, (_, index) => `Saved note paragraph ${index + 1} with original review details.`).join("\n");
  await page.getByRole("textbox", { name: "Case note message", exact: true }).fill(draft);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Case note message", exact: true })).toHaveValue(draft);
  await page.getByRole("button", { name: "Save Note", exact: true }).click();
  await expect(page.getByText("Note saved. No email was sent.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Read full note", exact: true }).click();
  await expect(page.getByRole("button", { name: "Collapse note", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("article p").filter({ hasText: "Saved note paragraph 14" })).toHaveText(draft);
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).analyze();
    expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`notes-${viewport.name}.png`) });
  }
  const db = new Database(resolve(".laro-a11y.sqlite"));
  try {
    const count = db.prepare("SELECT COUNT(*) AS total FROM messages WHERE content = ? AND userId = (SELECT id FROM users WHERE email = ?)").get(draft, email) as { total: number };
    expect(count.total).toBe(1);
  } finally { db.close(); }
  expect(outbound).toEqual([]);
});

test("case selectors search beyond the first hundred records and keep the chosen context", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badResponses: Array<{ status: number; url: string }> = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });
  page.on("response", response => {
    if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() });
  });
  const email = await createAccount(page);
  const db = new Database(resolve(".laro-a11y.sqlite"));
  const caseIds: string[] = [];
  try {
    const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    const insert = db.prepare("INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, createdAt, updatedAt) VALUES (?, ?, ?, 'Contract', 'Isolated selector test', 'Low', 'Intake', ?, ?)");
    db.transaction(() => {
      for (let index = 0; index < 112; index++) {
        const id = randomUUID();
        caseIds.push(id);
        insert.run(id, user.id, `Case ${String(index + 1).padStart(3, "0")}`, 1700000000 + index, 1700000000 + index);
      }
    })();
  } finally { db.close(); }
  const response = await page.goto("/outreach?view=media", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("button", { name: "Discover", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Case: Select a case", exact: true }).click();
  await page.getByLabel("Find a case").fill("Case 001");
  await page.getByRole("button", { name: "Case 001", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(caseIds[0]));
  await expect(page.getByRole("button", { name: "Discover", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: "Organizations", exact: true }).click();
  await expect(page.getByRole("button", { name: "Case: Case 001", exact: true })).toBeVisible();
  const reloadResponse = await page.reload({ waitUntil: "networkidle" });
  expect(reloadResponse?.status()).toBe(200);
  await expect(page.getByRole("button", { name: "Case: Case 001", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Review draft, not submitted");
  await page.getByLabel("Public URL", { exact: true }).fill("https://example.test/review");
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).analyze();
    expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`outreach-review-${viewport.name}.png`) });
  }
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(badResponses).toEqual([]);
});

test("a demo query parameter cannot bypass authentication", async ({ page }) => {
  await page.goto("/?demo=true", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "Sign In", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open account menu|Accountmenu openen/ })).toHaveCount(0);
});

test("reviewed HAI credentials expose and enforce their case, field, and future-record scope", async ({ page }, testInfo) => {
  const email = await createAccount(page);
  const caseId = `HAI_UI_${randomUUID()}`;
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const owner = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    const now = Math.floor(Date.now() / 1000);
    database.prepare("INSERT INTO cases (id, userId, caseType, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
      .run(caseId, owner.id, "HAI browser verification", "active", now, now);
  } finally {
    database.close();
  }

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const badResponses: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || "failed"}`));
  page.on("response", (response) => { if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`); });

  await page.goto("/settings?section=hai", { waitUntil: "networkidle" });
  await expect(page.getByText("HAI connector", { exact: true })).toBeVisible();
  await page.getByLabel(/HAI browser verification/).check();
  await page.getByRole("switch", { name: "Include cases created later" }).click();
  await page.getByRole("button", { name: "Review and create credential" }).click();

  const dialog = page.getByRole("dialog", { name: "Confirm HAI credential scope" });
  await expect(dialog).toContainText("1 explicitly selected");
  await expect(dialog).toContainText("Future cases: Included automatically");
  const create = dialog.getByRole("button", { name: "Create reviewed credential" });
  await expect(create).toBeDisabled();
  await dialog.getByLabel(/I reviewed the 1 selected case/).check();
  await dialog.getByLabel("I reviewed the exported field categories shown above.").check();
  await dialog.getByLabel("I reviewed whether future cases and analyses enter this grant automatically.").check();
  await expect(create).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("hai-reviewed-grant-dialog.png") });
  await create.click();

  await expect(page.getByRole("textbox", { name: "New HAI credential" })).toBeVisible();
  const credential = page.getByRole("article", { name: "HAI credential HAI connected source" });
  await expect(credential).toContainText("1 selected case");
  await expect(credential).toContainText("Case overview, Analysis summary");
  await expect(credential).toContainText("Future cases: included");
  await expect(credential).toContainText("Future analyses: excluded");
  await expect(credential).toContainText("Not used");
  await expect(credential).toContainText("Revision 1");

  await credential.getByRole("button", { name: "Edit scope" }).click();
  await expect(page.getByRole("switch", { name: "Include cases created later" })).toBeChecked();
  await page.getByRole("switch", { name: "Include cases created later" }).click();
  await page.getByRole("button", { name: "Review scope update" }).click();
  const updateDialog = page.getByRole("dialog", { name: "Confirm HAI scope update" });
  await updateDialog.getByLabel(/I reviewed the 1 selected case/).check();
  await updateDialog.getByLabel("I reviewed the exported field categories shown above.").check();
  await updateDialog.getByLabel("I reviewed whether future cases and analyses enter this grant automatically.").check();
  await updateDialog.getByRole("button", { name: "Update reviewed scope" }).click();
  await expect(credential).toContainText("Future cases: excluded");
  await expect(credential).toContainText("Revision 2");
  await credential.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("hai-reviewed-credential-list.png") });
  const desktopAudit = await new AxeBuilder({ page }).analyze();
  expect(desktopAudit.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  const mobileCredential = page.getByRole("article", { name: "HAI credential HAI connected source" });
  await expect(mobileCredential).toContainText("Revision 2");
  await mobileCredential.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("hai-reviewed-credential-mobile.png") });
  const mobileAudit = await new AxeBuilder({ page }).analyze();
  expect(mobileAudit.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(badResponses).toEqual([]);
});

test("public health is minimal while detailed diagnostics require an operator session", async ({ page }) => {
  const email = await createAccount(page);
  const healthResponse = await page.request.get("/api/health");
  expect(healthResponse.status()).toBe(200);
  expect(healthResponse.headers()["cache-control"]).toBe("no-store");
  const health = await healthResponse.json();
  expect(Object.keys(health).sort()).toEqual(["dbReady", "status", "timestamp", "version"]);

  const denied = await page.request.get("/api/operator/diagnostics");
  expect(denied.status()).toBe(403);
  expect(await denied.json()).toEqual({ error: "Operator access required" });

  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    database.prepare("UPDATE users SET role = 'operator' WHERE email = ?").run(email);
  } finally {
    database.close();
  }
  const allowed = await page.request.get("/api/operator/diagnostics");
  expect(allowed.status()).toBe(200);
  expect(allowed.headers()["cache-control"]).toBe("no-store");
  expect(await allowed.json()).toMatchObject({
    db: { ready: true },
    backup: { configured: expect.any(Boolean), status: expect.any(String) },
    operations: { totalRequests: expect.any(Number), recentP95LatencyMs: expect.any(Number) },
    jobs: expect.any(Array),
    workers: expect.any(Array),
  });
});

test("authentication exposes password visibility and preserves fields on an inline error", async ({ page }, testInfo) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByLabel("Email Address", { exact: true }).fill("invalid-session@example.test");
  const password = page.getByLabel("Password", { exact: true });
  await password.fill("NotARealAccount!2026");
  await page.getByRole("button", { name: "Show password", exact: true }).click();
  await expect(password).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide password", exact: true }).click();
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toBeVisible();
  await expect(password).toHaveValue("NotARealAccount!2026");
  await page.getByRole("button", { name: "Don't have an account? Sign up" }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("minlength", "8");
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).analyze();
    expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`authentication-${viewport.name}.png`) });
  }
});

test("unavailable data stays distinct from empty results and disabled case actions recover", async ({ page }) => {
  await createAccount(page);
  const failure = /\/api\/trpc\/.*messages\.list/;
  await page.route(failure, route => route.fulfill({
    status: 503, contentType: "application/json",
    body: JSON.stringify([{ error: { json: { message: "Temporary notes outage", code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 503 } } } }]),
  }));
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not load data" })).toBeVisible();
  await expect(page.getByText("No case notes found", { exact: true })).toHaveCount(0);
  await page.unroute(failure);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("No case notes found", { exact: true })).toBeVisible();
  await page.goto("/cases?case=missing-ui-case");
  await expect(page.getByRole("dialog").getByText("Case not found", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export case", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Edit case", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Close case details", exact: true }).click();
  await expect(page).toHaveURL(/\/cases$/);
  await page.goto("/settings?section=security", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Privacy settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Privacy and data", exact: true })).toBeVisible();
});

test("scanner configuration failure offers retry instead of an endless spinner", async ({ page }) => {
  await createAccount(page);
  await page.addInitScript(() => {
    (window as any).__configAttempts = 0;
    (window as any).electronAPI = {
      getConfig: async () => { (window as any).__configAttempts++; throw new Error("Test bridge unavailable"); },
    };
  });
  await page.goto("/?mode=scanner");
  await expect(page.getByRole("heading", { name: "Scanner unavailable", exact: true })).toBeVisible();
  await expect(page.getByText("Test bridge unavailable", { exact: true })).toBeVisible();
  const attempts = await page.evaluate(() => (window as any).__configAttempts);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__configAttempts)).toBeGreaterThan(attempts);
  await expect(page.getByRole("heading", { name: "Scanner unavailable", exact: true })).toBeVisible();
});

test("scanner renders persisted retry state and resumes it without rescanning", async ({ page }, testInfo) => {
  const email = await createAccount(page);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  let ownerId = "";
  try {
    ownerId = (database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
  } finally {
    database.close();
  }
  await page.addInitScript(({ userId, scanId }) => {
    window.localStorage.setItem(`laroScannerActiveScan:${userId}`, scanId);
    (window as any).__stopUploadCalls = 0;
    let uploadListener: ((progress: unknown) => void) | null = null;
    let scanStatus = "upload-paused";
    let files = [
      {
        id: "retry-file",
        path: "/approved/retry.txt",
        name: "retry.txt",
        size: 25,
        mimeType: "text/plain",
        modifiedAt: new Date().toISOString(),
        uploadStatus: "retryable",
        uploadProgress: 0,
        errorMessage: "Network connection interrupted",
      },
      {
        id: "complete-file",
        path: "/approved/complete.txt",
        name: "complete.txt",
        size: 30,
        mimeType: "text/plain",
        modifiedAt: new Date().toISOString(),
        uploadStatus: "completed",
        uploadProgress: 100,
        evidenceId: "EVIDENCE-COMPLETE",
      },
    ];
    (window as any).electronAPI = {
      getConfig: async () => ({ apiUrl: location.origin, deviceName: "browser-test", caseId: "CASE-RESUME" }),
      setConfig: async (value: unknown) => value,
      getSystemInfo: async () => ({ platform: "windows", hostname: "test", username: "test", homeDir: "/", version: "1.3.0" }),
      getAppVersion: async () => "1.3.0",
      openExternal: async () => undefined,
      reportRendererError: async () => undefined,
      selectFolder: async () => null,
      startLocalSource: async () => null,
      startScan: async () => ({ scanId }),
      stopScan: async () => ({ success: true }),
      pauseScan: async () => ({ success: true }),
      resumeScan: async () => ({ success: true }),
      getScanFiles: async () => ({ files }),
      getScanProgress: async () => ({ progress: {
        scanId,
        status: scanStatus,
        totalFiles: 2,
        scannedFiles: 2,
        uploadedFiles: 1,
        failedFiles: 1,
        totalSize: 55,
        uploadedSize: 30,
        currentFile: null,
        errorMessage: scanStatus === "cancelled" ? "Upload cancelled. Approved files can be resumed." : null,
      } }),
      setScanFileSelection: async () => ({ selected: 1, reviewRequired: 0 }),
      startUpload: async () => {
        scanStatus = "completed";
        files = files.map((file) => file.id === "retry-file"
          ? { ...file, uploadStatus: "completed", uploadProgress: 100, errorMessage: undefined, evidenceId: "EVIDENCE-RETRIED" }
          : file);
        queueMicrotask(() => uploadListener?.({
          scanId,
          fileId: "retry-file",
          uploadStatus: "completed",
          uploadedFiles: 2,
          failedFiles: 0,
        }));
        queueMicrotask(() => uploadListener?.({
          scanId,
          done: true,
          status: "completed",
          uploadedFiles: 2,
          failedFiles: 0,
          uploadedSize: 55,
        }));
        return { success: true };
      },
      pauseUpload: async () => ({ success: true }),
      // The desktop process restarted, so there is no paused in-memory worker.
      resumeUpload: async () => ({ success: false }),
      stopUpload: async () => {
        (window as any).__stopUploadCalls++;
        scanStatus = "cancelled";
        files = files.map((file) => file.id === "retry-file"
          ? { ...file, uploadStatus: "cancelled", errorMessage: "Upload cancelled. The approved file can be resumed." }
          : file);
        return { success: true };
      },
      onScanProgress: () => undefined,
      onUploadProgress: (callback: (progress: unknown) => void) => { uploadListener = callback; },
      clearScanProgressListeners: () => undefined,
      clearUploadProgressListeners: () => { uploadListener = null; },
      openScanPanel: async () => undefined,
    };
  }, { userId: ownerId, scanId: "persisted-resume-scan" });

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => requestFailures.push(`${request.method()} ${request.url()}`));
  const response = await page.goto("/?mode=scanner", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByText(/Retry available|Kan worden hervat/, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Resume uploads|Uploads hervatten/ }).click();
  await expect(page.getByText(/Completed|Voltooid/, { exact: true })).toHaveCount(3);
  await expect(page.getByText(/Retry available|Kan worden hervat/, { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("scanner-resumed.png"), fullPage: true });

  // A separate interrupted session can also be cancelled after reopening.
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByText(/Retry available|Kan worden hervat/, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Cancel|Annuleren/ }).click();
  await expect(page.locator("header").getByText(/Cancelled|Geannuleerd/, { exact: true })).toBeVisible();
  await expect(page.getByTitle(/Cancelled|Geannuleerd/)).toBeVisible();
  await expect(page.getByText(/Retry available|Kan worden hervat/, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__stopUploadCalls)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("scanner-cancelled.png"), fullPage: true });

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test("scanner hides an open review immediately when the signed-in account changes", async ({ page }, testInfo) => {
  const email = await createAccount(page);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  const ownerA = (database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
  const ownerB = `A11Y_${randomUUID()}`;
  database.prepare("INSERT INTO users (id, email, name, password, role, createdAt) VALUES (?, ?, ?, NULL, 'user', ?)")
    .run(ownerB, `${ownerB.toLowerCase()}@example.test`, "Second owner", Math.floor(Date.now() / 1000));
  database.prepare("INSERT INTO system_config (configKey, configValue, updatedAt) VALUES (?, ?, ?)")
    .run(`onboarding:state:${ownerB}`, JSON.stringify({ status: "complete", currentStepKey: "outreach" }), Math.floor(Date.now() / 1000));
  database.close();

  await page.addInitScript(({ ownerId }) => {
    window.localStorage.setItem(`laroScannerActiveScan:${ownerId}`, "owner-a-scan");
    (window as any).electronAPI = {
      getConfig: async () => ({ apiUrl: location.origin, deviceName: "browser-test", caseId: "case-a" }),
      setConfig: async (value: unknown) => value,
      getSystemInfo: async () => ({ platform: "windows", hostname: "test", username: "test", homeDir: "/", version: "1.3.0" }),
      getAppVersion: async () => "1.3.0",
      openExternal: async () => undefined,
      reportRendererError: async () => undefined,
      selectFolder: async () => null,
      startLocalSource: async () => null,
      getScanFiles: async () => ({ files: [{
        id: "owner-a-file", path: "/private/owner-a-secret.txt", name: "owner-a-secret.txt",
        size: 12, mimeType: "text/plain", modifiedAt: new Date().toISOString(),
        uploadStatus: "pending", uploadProgress: 0,
      }] }),
      getScanProgress: async () => ({ progress: {
        scanId: "owner-a-scan", status: "review", totalFiles: 1, scannedFiles: 1,
        uploadedFiles: 0, failedFiles: 0, totalSize: 12, uploadedSize: 0,
      } }),
      onScanProgress: () => undefined,
      onUploadProgress: () => undefined,
      clearScanProgressListeners: () => undefined,
      clearUploadProgressListeners: () => undefined,
    };
  }, { ownerId: ownerA });

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => requestFailures.push(`${request.method()} ${request.url()}`));
  const response = await page.goto("/?mode=scanner", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByText("/private/owner-a-secret.txt")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("scanner-owner-a-review.png"), fullPage: true });

  const tokenB = jwt.sign({ userId: ownerB }, "laro-a11y-jwt-secret-32-characters-minimum", { expiresIn: "1h" });
  await page.context().addCookies([{
    name: COOKIE_NAME, value: tokenB, url: "http://127.0.0.1:5181", httpOnly: true, sameSite: "Lax",
  }]);
  await page.evaluate(() => window.dispatchEvent(new Event("laro:scanner-session-changed")));
  await expect(page.getByText("/private/owner-a-secret.txt")).toHaveCount(0);
  await expect(page.getByText("owner-a-secret.txt")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Upload selected|Geselecteerde uploaden/ })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("scanner-owner-b-after-switch.png"), fullPage: true });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test("default scanner folder paths stay with their account after a live switch", async ({ page }, testInfo) => {
  const email = await createAccount(page);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  const ownerA = (database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
  const ownerB = `A11Y_${randomUUID()}`;
  database.prepare("INSERT INTO users (id, email, name, password, role, createdAt) VALUES (?, ?, ?, NULL, 'user', ?)")
    .run(ownerB, `${ownerB.toLowerCase()}@example.test`, "Second owner", Math.floor(Date.now() / 1000));
  database.prepare("INSERT INTO system_config (configKey, configValue, updatedAt) VALUES (?, ?, ?)")
    .run(`onboarding:state:${ownerB}`, JSON.stringify({ status: "complete", currentStepKey: "outreach" }), Math.floor(Date.now() / 1000));
  database.close();

  await page.evaluate(({ ownerA, ownerB }) => {
    localStorage.setItem(`laroDefaultLocalScanFolders:${ownerA}`, JSON.stringify(["/private/owner-a-folder"]));
    localStorage.setItem(`laroDefaultLocalScanFolders:${ownerB}`, JSON.stringify(["/private/owner-b-folder"]));
    localStorage.setItem("laroDefaultLocalScanFolders", JSON.stringify(["/private/unowned-legacy-folder"]));
  }, { ownerA, ownerB });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => requestFailures.push(`${request.method()} ${request.url()}`));
  const response = await page.goto("/settings?section=sources", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByText("/private/owner-a-folder")).toBeVisible();
  await expect(page.getByText("/private/unowned-legacy-folder")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("laroDefaultLocalScanFolders"))).toBeNull();
  await page.screenshot({ path: testInfo.outputPath("scanner-default-folders-owner-a.png"), fullPage: true });

  const tokenB = jwt.sign({ userId: ownerB }, "laro-a11y-jwt-secret-32-characters-minimum", { expiresIn: "1h" });
  await page.context().addCookies([{
    name: COOKIE_NAME, value: tokenB, url: "http://127.0.0.1:5181", httpOnly: true, sameSite: "Lax",
  }]);
  await page.evaluate(() => window.dispatchEvent(new Event("laro:scanner-session-changed")));
  await expect(page.getByText("/private/owner-a-folder")).toHaveCount(0);
  await expect(page.getByText("/private/owner-b-folder")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("scanner-default-folders-owner-b.png"), fullPage: true });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test("privacy navigation and analytics consent stay bound to the signed-in account", async ({ page }, testInfo) => {
  const email = await createAccount(page);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  const ownerA = (database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
  const ownerB = `A11Y_${randomUUID()}`;
  const now = Math.floor(Date.now() / 1_000);
  database.prepare("INSERT INTO users (id, email, name, password, role, createdAt) VALUES (?, ?, ?, NULL, 'user', ?)")
    .run(ownerB, `${ownerB.toLowerCase()}@example.test`, "Second owner", now);
  database.prepare("INSERT INTO system_config (configKey, configValue, updatedAt) VALUES (?, ?, ?)")
    .run(`onboarding:state:${ownerB}`, JSON.stringify({ status: "complete", currentStepKey: "outreach" }), now);
  const insertPreference = database.prepare(
    "INSERT INTO user_preferences (id, userId, key, value, updatedAt) VALUES (?, ?, 'privacy-consent', ?, ?)",
  );
  insertPreference.run(randomUUID(), ownerA, JSON.stringify({ analytics: true }), now);
  insertPreference.run(randomUUID(), ownerB, JSON.stringify({ analytics: false }), now);
  database.close();

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badResponses: Array<{ status: number; url: string }> = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => requestFailures.push(`${request.method()} ${request.url()}`));
  page.on("response", response => {
    if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() });
  });

  await page.getByRole("button", { name: /Open account menu|Accountmenu openen/ }).click();
  await page.getByRole("menuitem", { name: /Privacy and data|Privacy en gegevens/ }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  const response = await page.reload({ waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Privacy and data" })).toBeVisible();
  const analyticsSwitch = page.getByRole("switch", { name: "Allow usage analytics" });
  await expect(analyticsSwitch).toBeChecked();
  await expect(page.getByText("Marketing communication", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Security and resource integrity", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("privacy-owner-a-opted-in.png"), fullPage: true });

  const tokenB = jwt.sign({ userId: ownerB }, "laro-a11y-jwt-secret-32-characters-minimum", { expiresIn: "1h" });
  await page.context().addCookies([{
    name: COOKIE_NAME, value: tokenB, url: "http://127.0.0.1:5181", httpOnly: true, sameSite: "Lax",
  }]);
  await page.evaluate(() => window.dispatchEvent(new Event("laro:scanner-session-changed")));
  await expect(page.getByText("Second owner", { exact: true })).toBeVisible();
  await expect(analyticsSwitch).not.toBeChecked();
  await expect(analyticsSwitch).toBeEnabled();
  await analyticsSwitch.click();
  await expect(analyticsSwitch).toBeChecked();
  await analyticsSwitch.click();
  await expect(analyticsSwitch).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("privacy-owner-b-opted-out.png"), fullPage: true });

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(badResponses).toEqual([]);
});

test("account erasure requires fresh server verification in the rendered privacy flow", async ({ page }, testInfo) => {
  const email = await createAccount(page, { password: 'EraseBrowser!2026' });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const requestFailures: string[] = [];
  const badResponses: Array<{ status: number; url: string }> = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('requestfailed', request => requestFailures.push(`${request.method()} ${request.url()}`));
  page.on('response', response => {
    if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() });
  });

  const response = await page.goto('/privacy', { waitUntil: 'networkidle' });
  expect(response?.status()).toBe(200);
  await page.getByRole('button', { name: 'Start account deletion' }).click();
  await page.getByRole('textbox', { name: 'Confirm signed-in email' }).fill(email);
  await expect(page.getByRole('button', { name: 'Erase account' })).toBeDisabled();
  await expect(page.getByText('Typing the email is a confirmation only.')).toBeVisible();
  await page.getByLabel('Current password for account erasure').fill('EraseBrowser!2026');
  await page.getByRole('button', { name: 'Verify identity' }).click();
  await expect(page.getByText('Identity verified. Complete erasure within five minutes.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Erase account' })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('erasure-server-verification-ready.png'), fullPage: true });
  await page.getByRole('button', { name: 'Erase account' }).click();
  await expect(page.getByRole('button', { name: "Don't have an account? Sign up" })).toBeVisible();
  const database = new Database(resolve('.laro-a11y.sqlite'), { fileMustExist: true });
  try {
    expect(database.prepare('SELECT id FROM users WHERE email = ?').get(email)).toBeUndefined();
  } finally {
    database.close();
  }
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(badResponses).toEqual([]);
});

test("lawyer comparison normalizes legacy rows and only shows a canonical match with a case", async ({ page }, testInfo) => {
  const email = await createAccount(page);
  const marker = `CompareBeacon${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const caseId = randomUUID();
  const currentLawyerId = randomUUID();
  const legacyLawyerId = randomUUID();
  const caseName = `${marker} Client`;
  const currentName = `${marker} Current Lawyer`;
  const legacyName = `${marker} Legacy Lawyer`;
  const now = Math.floor(Date.now() / 1_000);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  let ownerId = "";
  try {
    ownerId = (database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
    database.prepare("INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, legalAreas, preferredLanguages, createdAt, updatedAt) VALUES (?, ?, ?, 'Employment', 'Comparison browser case', 'Low', 'Matching', '[\"Employment Law\"]', '[\"Dutch\"]', ?, ?)")
      .run(caseId, ownerId, caseName, now, now);
    database.prepare(`
      INSERT INTO lawyers (
        id, name, firmName, city, legalAreas, languages, experienceYears,
        currentlyAccepting, caseStop, permanentlyFiltered, barAssociationStatus,
        caseLoad, capacityPercentage, averageResponseTimeHours,
        totalOutreaches, totalResponses, totalAcceptances, createdAt, updatedAt
      ) VALUES (?, ?, 'Current Comparison Firm', 'Amsterdam', ?, '["Dutch","English"]', '12',
        'Yes', 'No', 'No', 'Good Standing', '6', '25', '36', '10', '8', '4', ?, ?)
    `).run(currentLawyerId, currentName, JSON.stringify([{ area: "Employment Law" }, "Civil Law"]), now, now);
    database.prepare(`
      INSERT INTO lawyers (
        id, name, firm, city, legalAreas, languages, experienceYears,
        currentlyAccepting, caseStop, permanentlyFiltered, barAssociationStatus,
        caseLoad, capacityPercentage, averageResponseTimeHours,
        totalOutreaches, totalResponses, totalAcceptances, createdAt, updatedAt
      ) VALUES (?, ?, 'Legacy Comparison Firm', 'Utrecht', 'Employment Law; Social Security Law', 'Dutch | English', 'unknown',
        'Limited', 'No', 'No', 'Good Standing', 'not-recorded', '140', '', 'broken', '4', '9', ?, ?)
    `).run(legacyLawyerId, legacyName, now, now);
  } finally {
    database.close();
  }

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badResponses: Array<{ status: number; url: string }> = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });
  page.on("response", response => {
    if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() });
  });

  const response = await page.goto("/lawyers", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await page.getByRole("textbox", { name: "Search lawyers", exact: true }).fill(marker);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText(currentName, { exact: true })).toBeVisible();
  await expect(page.getByText(legacyName, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Compare Mode", exact: true }).click();
  await page.getByRole("button", { name: "Select to Compare", exact: true }).first().click();
  await page.getByRole("button", { name: "Select to Compare", exact: true }).first().click();
  const comparison = page.getByRole("region", { name: "Lawyer comparison", exact: true });
  await expect(comparison).toBeVisible();
  await expect(comparison.getByText("80.0% (8/10)", { exact: true })).toBeVisible();
  await expect(comparison.getByText("50.0% (4/8)", { exact: true })).toBeVisible();
  await expect(comparison.getByText("Social Security Law", { exact: true })).toBeVisible();
  await expect(comparison.getByText(/% case match/)).toHaveCount(0);
  await expect(comparison.getByRole("button", { name: /shortlist|contact/i })).toHaveCount(0);

  await page.getByRole("button", { name: "Case: No case selected", exact: true }).click();
  await page.getByLabel("Find a case", { exact: true }).fill(caseName);
  await page.getByRole("button", { name: caseName, exact: true }).click();
  await expect(comparison.getByText(/% case match/)).toHaveCount(2);
  await expect(comparison.getByText("Canonical match basis", { exact: true })).toHaveCount(2);
  await expect(page.getByText(/Searching for:/)).toHaveCount(0, { timeout: 15_000 });

  const audit = await new AxeBuilder({ page }).include('[aria-label="Lawyer comparison"]').analyze();
  expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
  await comparison.screenshot({ path: testInfo.outputPath("canonical-lawyer-comparison.png") });

  const verified = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const count = verified.prepare("SELECT COUNT(*) AS total FROM outreach_status WHERE caseId = ?").get(caseId) as { total: number };
    expect(count.total).toBe(0);
  } finally {
    verified.close();
  }

  await page.locator(`[data-comparison-lawyer="${currentLawyerId}"]`).getByRole("button", { name: "View profile", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/lawyers/${currentLawyerId}$`));
  await expect(page.getByRole("heading", { name: currentName, exact: true })).toBeVisible();
  expect(badResponses).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test("assistant binds answers to selected clarifications and reports applied versus review outcomes", async ({ page }, testInfo) => {
  const email = await createAccount(page);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const primaryCaseId = `A11Y_CLAR_PRIMARY_${suffix}`;
  const reviewCaseId = `A11Y_CLAR_REVIEW_${suffix}`;
  let ownerId = "";
  try {
    ownerId = (database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
    const insert = database.prepare(`
      INSERT INTO cases (id, userId, clientName, clientEmail, caseType, caseSummary, urgency, status, legalAreas, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Math.floor(Date.now() / 1000);
    insert.run(primaryCaseId, ownerId, "Primary area client", "primary@example.test", "Employment Law",
      "Clarification browser verification", "Normal", "Matching", JSON.stringify(["Employment Law", "Administrative Law"]), now, now);
    insert.run(reviewCaseId, ownerId, "Review note client", null, "Employment Law",
      "Clarification review verification", "Normal", "Matching", JSON.stringify(["Employment Law"]), now, now);
  } finally {
    database.close();
  }

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });

  const response = await page.reload({ waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await page.getByRole("button", { name: "Open LARO assistant" }).click();
  const assistant = page.getByRole("dialog");
  await expect(assistant.getByText(/Which is the primary area for lawyer matching\?/)).toBeVisible();
  await expect(assistant.getByText(/Which verified email address should be used for this case\?/)).toBeVisible();

  const primaryQuestion = assistant.getByText(/Which is the primary area for lawyer matching\?/).locator("..");
  await primaryQuestion.getByRole("button", { name: "Answer" }).click();
  await expect(primaryQuestion.getByRole("button", { name: "Selected" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Message LARO assistant").fill("Administrative Law");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(assistant.getByText("Case field updated and lawyer matching refreshed.", { exact: true })).toBeVisible();
  await expect(assistant.getByText("Applied outcome: primary_legal_area_applied", { exact: true })).toBeVisible();

  const reviewQuestion = assistant.getByText(/Which verified email address should be used for this case\?/).locator("..");
  await reviewQuestion.getByRole("button", { name: "Answer" }).click();
  await page.getByLabel("Message LARO assistant").fill("resolved");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(assistant.getByText("Answer saved as a case note for review; case and matching fields were not changed.", { exact: true })).toBeVisible();
  await expect(assistant.getByText("Not applied: contact_email_requires_review", { exact: true })).toBeVisible();

  const verified = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const primary = verified.prepare("SELECT legalAreas, caseType FROM cases WHERE id = ?").get(primaryCaseId) as { legalAreas: string; caseType: string };
    expect(JSON.parse(primary.legalAreas)).toEqual(["Administrative Law"]);
    expect(primary.caseType).toBe("Administrative Law");
    const review = verified.prepare("SELECT clientEmail FROM cases WHERE id = ?").get(reviewCaseId) as { clientEmail: string | null };
    expect(review.clientEmail).toBeNull();
    const answers = verified.prepare(`
      SELECT kind, answer, applied, reviewStatus FROM clarification_questions
      WHERE userId = ? AND caseId IN (?, ?) ORDER BY caseId
    `).all(ownerId, primaryCaseId, reviewCaseId) as Array<{ kind: string; answer: string; applied: number; reviewStatus: string }>;
    expect(answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "primary_legal_area", answer: "Administrative Law", applied: 1, reviewStatus: "applied" }),
      expect.objectContaining({ kind: "contact_email", answer: "resolved", applied: 0, reviewStatus: "needs_review" }),
    ]));
  } finally {
    verified.close();
  }

  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("clarification-outcomes.png"), fullPage: true });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test("outreach initiation creates one reviewable draft set and remains idempotent in the mounted case workspace", async ({ page }, testInfo) => {
  const email = await createAccount(page);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const caseId = `A11Y_OUTREACH_CASE_${suffix}`;
  const lawyerId = `A11Y_OUTREACH_LAWYER_${suffix}`;
  const legalArea = `Browser Atomic Law ${suffix}`;
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  let ownerId = "";
  try {
    ownerId = (database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
    const now = Math.floor(Date.now() / 1000);
    database.prepare(`
      INSERT INTO cases (id, userId, clientName, clientEmail, caseType, caseSummary, urgency, status, legalAreas, createdAt, updatedAt)
      VALUES (?, ?, 'Atomic outreach client', 'atomic-outreach@example.test', ?, 'Atomic outreach browser verification', 'Normal', 'Matching', ?, ?, ?)
    `).run(caseId, ownerId, legalArea, JSON.stringify([legalArea]), now, now);
    database.prepare(`
      INSERT INTO lawyers (
        id, name, email, legalAreas, barAssociationStatus, caseStop, currentlyAccepting,
        permanentlyFiltered, caseLoad, experienceYears, totalOutreaches, totalResponses,
        totalAcceptances, languages, createdAt, updatedAt
      ) VALUES (?, 'Atomic Review Lawyer', 'atomic-lawyer@example.test', ?, 'Good Standing', 'No', 'Yes',
        'No', '5', '10', '0', '0', '0', '[]', ?, ?)
    `).run(lawyerId, JSON.stringify([legalArea]), now, now);
  } finally {
    database.close();
  }

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const sendRequests: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => { if (/sendApproved|email\.send/.test(request.url())) sendRequests.push(request.url()); });
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });

  const response = await page.goto("/cases", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await page.getByRole("button", { name: "Open case", exact: true }).click();
  const caseDialog = page.getByRole("dialog");
  await caseDialog.getByText("More", { exact: true }).click();
  await caseDialog.getByRole("button", { name: "Lawyers", exact: true }).click();
  await caseDialog.getByRole("button", { name: "Search NOvA", exact: true }).click();
  await expect(caseDialog.getByText("Atomic Review Lawyer", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(caseDialog.getByText("Verified-data score (max 230)", { exact: true })).toBeVisible();

  await caseDialog.getByRole("button", { name: "Start Outreach", exact: true }).click();
  await expect(page.getByText("1 outreach draft(s) prepared for review", { exact: true })).toBeVisible();
  await caseDialog.getByRole("button", { name: "Start Outreach", exact: true }).click();
  await expect(page.getByText("Outreach is up to date", { exact: true })).toBeVisible();

  const verified = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const storedCase = verified.prepare("SELECT status FROM cases WHERE id = ? AND userId = ?").get(caseId, ownerId) as { status: string };
    expect(storedCase.status).toBe("Outreach");
    const drafts = verified.prepare("SELECT lawyerId, status FROM outreach_status WHERE caseId = ?").all(caseId) as Array<{ lawyerId: string; status: string }>;
    expect(drafts).toEqual([{ lawyerId, status: "PendingApproval" }]);
    const auditCount = verified.prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE entityId = ? AND action = 'outreach.initiated'").get(caseId) as { total: number };
    expect(auditCount.total).toBe(1);
  } finally {
    verified.close();
  }

  const audit = await new AxeBuilder({ page }).include('[aria-label="Case content"]').analyze();
  expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
  await caseDialog.screenshot({ path: testInfo.outputPath("atomic-outreach-review.png") });
  expect(sendRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test("global search opens every result on a registered, reload-safe deep link", async ({ page }, testInfo) => {
  const email = await createAccount(page);
  const marker = `RouteBeacon${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const caseId = randomUUID();
  const lawyerId = randomUUID();
  const evidenceId = randomUUID();
  const documentId = randomUUID();
  const communicationId = randomUUID();
  const foreignDocumentId = randomUUID();
  const caseName = `${marker} Case`;
  const lawyerName = `${marker} Lawyer`;
  const evidenceTitle = `${marker} Evidence`;
  const documentName = `${marker} Document`;
  const communicationSubject = `${marker} Communication`;
  const foreignSecret = `${marker} Foreign Secret`;
  const now = Math.floor(Date.now() / 1_000);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const owner = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    const foreignUserId = randomUUID();
    const foreignCaseId = randomUUID();
    database.prepare("INSERT INTO users (id, email, name, role, createdAt) VALUES (?, ?, 'Foreign Search User', 'user', ?)")
      .run(foreignUserId, `${foreignUserId}@example.test`, now);
    database.prepare("INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, createdAt, updatedAt) VALUES (?, ?, ?, 'Contract', 'Search routing case', 'Low', 'Intake', ?, ?)")
      .run(caseId, owner.id, caseName, now, now);
    database.prepare("INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, createdAt, updatedAt) VALUES (?, ?, 'Foreign Case', 'Contract', 'Foreign case', 'Low', 'Intake', ?, ?)")
      .run(foreignCaseId, foreignUserId, now, now);
    database.prepare("INSERT INTO lawyers (id, name, firmName, city, legalAreas, languages, createdAt, updatedAt) VALUES (?, ?, 'Route Firm', 'Amsterdam', '[\"Contract\"]', '[]', ?, ?)")
      .run(lawyerId, lawyerName, now, now);
    database.prepare("INSERT INTO evidence (id, caseId, userId, type, source, title, description, fileName, createdAt, updatedAt) VALUES (?, ?, ?, 'document', 'manual', ?, 'Selected evidence detail', 'route-evidence.pdf', ?, ?)")
      .run(evidenceId, caseId, owner.id, evidenceTitle, now, now);
    database.prepare("INSERT INTO documents (id, caseId, userId, name, title, type, folder, content, uploadedAt, createdAt) VALUES (?, ?, ?, ?, ?, 'letter', 'case-file', 'Selected document detail', ?, ?)")
      .run(documentId, caseId, owner.id, documentName, documentName, now, now);
    database.prepare("INSERT INTO communications (id, caseId, userId, channel, type, direction, subject, body, content, timestamp, createdAt) VALUES (?, ?, ?, 'internal', 'note', 'inbound', ?, 'Selected communication detail', 'Selected communication detail', ?, ?)")
      .run(communicationId, caseId, owner.id, communicationSubject, now, now);
    database.prepare("INSERT INTO documents (id, caseId, userId, name, title, type, content, uploadedAt, createdAt) VALUES (?, ?, ?, ?, ?, 'letter', 'Do not disclose', ?, ?)")
      .run(foreignDocumentId, foreignCaseId, foreignUserId, foreignSecret, foreignSecret, now, now);
  } finally {
    database.close();
  }

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badResponses: Array<{ status: number; url: string }> = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });
  page.on("response", response => {
    if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() });
  });

  const activate = async (title: string) => {
    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Search LARO", exact: true })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Search query", exact: true }).fill(title);
    const result = dialog.getByRole("button").filter({ hasText: title });
    await expect(result).toBeVisible();
    await result.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toHaveCount(0);
  };
  const returnHome = async () => {
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
  };

  const firstResponse = await page.goto("/", { waitUntil: "networkidle" });
  expect(firstResponse?.status()).toBe(200);

  await activate(caseName);
  await expect(page).toHaveURL(new RegExp(`/cases\\?case=${caseId}$`));
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("dialog")).toBeVisible();
  await returnHome();

  await activate(lawyerName);
  await expect(page).toHaveURL(new RegExp(`/lawyers/${lawyerId}$`));
  await expect(page.getByRole("heading", { name: lawyerName, exact: true })).toBeVisible();
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: lawyerName, exact: true })).toBeVisible();
  await returnHome();

  await activate(evidenceTitle);
  await expect(page).toHaveURL(new RegExp(`/evidence\\?view=items&evidence=${evidenceId}$`));
  await expect(page.locator('[data-search-result="evidence"]').getByRole("heading", { name: evidenceTitle, exact: true })).toBeVisible();
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator('[data-search-result="evidence"]').getByRole("heading", { name: evidenceTitle, exact: true })).toBeVisible();
  await returnHome();

  await activate(documentName);
  await expect(page).toHaveURL(new RegExp(`/evidence\\?view=items&document=${documentId}$`));
  await expect(page.locator('[data-search-result="document"]').getByRole("heading", { name: documentName, exact: true })).toBeVisible();
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator('[data-search-result="document"]').getByRole("heading", { name: documentName, exact: true })).toBeVisible();
  await returnHome();

  await activate(communicationSubject);
  await expect(page).toHaveURL(new RegExp(`/messages\\?communication=${communicationId}$`));
  await expect(page.locator('[data-search-result="communication"]').getByRole("heading", { name: communicationSubject, exact: true })).toBeVisible();
  await page.reload({ waitUntil: "networkidle" });
  const communicationSelection = page.locator('[data-search-result="communication"]');
  await expect(communicationSelection.getByRole("heading", { name: communicationSubject, exact: true })).toBeVisible();
  const audit = await new AxeBuilder({ page }).include('[data-search-result="communication"]').analyze();
  expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
  await communicationSelection.screenshot({ path: testInfo.outputPath("global-search-communication.png") });

  const foreignResponse = await page.goto(`/evidence?view=items&document=${foreignDocumentId}`, { waitUntil: "networkidle" });
  expect(foreignResponse?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Record not found or inaccessible", exact: true })).toBeVisible();
  await expect(page.getByText(foreignSecret, { exact: true })).toHaveCount(0);

  const deleteDb = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    deleteDb.prepare("DELETE FROM communications WHERE id = ?").run(communicationId);
  } finally {
    deleteDb.close();
  }
  const deletedResponse = await page.goto(`/messages?communication=${communicationId}`, { waitUntil: "networkidle" });
  expect(deletedResponse?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Record not found or inaccessible", exact: true })).toBeVisible();

  expect(badResponses).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test("global search renders literal results as incomplete instead of a false empty state", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badResponses: Array<{ status: number; url: string }> = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });
  page.on("response", response => {
    if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() });
  });

  const email = await createAccount(page);
  const marker = `Browser%_Literal${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const caseId = randomUUID();
  const lawyerId = randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const owner = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    database.prepare("INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, createdAt, updatedAt) VALUES (?, ?, ?, 'Contract', 'Literal partial-state case', 'Low', 'Intake', ?, ?)")
      .run(caseId, owner.id, `${marker} Case`, now, now);
    database.prepare("INSERT INTO lawyers (id, name, firmName, city, legalAreas, languages, createdAt, updatedAt) VALUES (?, ?, 'Legacy Firm', 'Amsterdam', '{malformed', '[]', ?, ?)")
      .run(lawyerId, `${marker} Lawyer`, now, now);
  } finally {
    database.close();
  }

  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog");
  const query = dialog.getByRole("textbox", { name: "Search query", exact: true });
  await query.fill(marker);
  await expect(dialog.getByTestId("global-search-incomplete")).toContainText("Search is incomplete");
  await expect(dialog.getByTestId("global-search-incomplete").getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(dialog.getByRole("button").filter({ hasText: `${marker} Case` })).toBeVisible();
  await expect(dialog.getByRole("button").filter({ hasText: `${marker} Lawyer` })).toBeVisible();
  await expect(dialog.getByText("No results found.", { exact: true })).toHaveCount(0);

  const audit = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
  await dialog.screenshot({ path: testInfo.outputPath("global-search-partial-desktop.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await expectInsideViewport(dialog);
  await dialog.screenshot({ path: testInfo.outputPath("global-search-partial-mobile.png") });

  await query.fill(`NoCompleteMatch${randomUUID().replaceAll("-", "")}`);
  await expect(dialog.getByText("No results found.", { exact: true })).toBeVisible();
  await expect(dialog.getByTestId("global-search-incomplete")).toHaveCount(0);

  expect(badResponses).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test("public research renders complete, empty, partial, unavailable, and failed states without false absence claims", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("laro.locale")) localStorage.setItem("laro.locale", "en");
  });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badResponses: Array<{ status: number; url: string }> = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => requestFailures.push(`${request.method()} ${request.url()}`));
  page.on("response", response => { if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() }); });

  const email = await createAccount(page);
  const caseId = `A11Y_PUBLIC_RESEARCH_${randomUUID()}`;
  const now = Math.floor(Date.now() / 1_000);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const owner = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    database.prepare(
      `INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, createdAt, updatedAt)
       VALUES (?, ?, 'Public research browser review', 'Company records', 'Case-scoped public research fixture', 'Low', 'Intake', ?, ?)`,
    ).run(caseId, owner.id, now, now);
  } finally {
    database.close();
  }

  const receipt = (
    source: "kvk_open_dataset" | "rechtspraak_rss" | "koop_bwb_sru",
    completeness: "complete" | "partial" | "unavailable" | "failed",
    resultCount: number | null,
    empty = false,
  ) => ({
    contractVersion: "case-public-research-v1",
    recordId: `RESEARCH_${source}_${completeness}_${resultCount}`,
    caseId,
    source,
    normalizedQuery: source === "kvk_open_dataset" ? "12345678" : "example query",
    retrievedAt: "2026-09-19T12:00:00.000Z",
    resultCount,
    completeness,
    empty,
  });
  let kvkAttempt = 0;
  await page.route("**/api/trpc/gapAnalysis.lookupCompany*", async route => {
    kvkAttempt += 1;
    if (kvkAttempt === 1) {
      await fulfillTrpc(route, {
        success: false,
        outcome: "unavailable",
        error: "The KvK open dataset is temporarily unavailable. Retry the research later.",
        failureCode: "http_503",
        research: receipt("kvk_open_dataset", "unavailable", null),
      });
      return;
    }
    if (kvkAttempt === 2) {
      await fulfillTrpc(route, {
        success: false,
        outcome: "empty",
        error: "No company record matched this KvK number.",
        failureCode: "not_found",
        research: receipt("kvk_open_dataset", "complete", 0, true),
      });
      return;
    }
    await fulfillTrpc(route, {
      success: true,
      outcome: "complete",
      data: {
        kvkNumber: "12345678",
        startDate: "2010-01-01",
        isActive: false,
        insolvencyStatus: { type: "bankruptcy", code: "FAIL", label: "Bankruptcy (Faillissement)" },
        legalForm: "BV",
        postalCodeRegion: "10",
        activities: [],
        fieldProvenance: {
          startDate: { sourceField: "datumAanvang", rawValue: "20100101" },
          activityStatus: { sourceField: "actief", rawValue: "N" },
          insolvencyStatus: { sourceField: "insolventieCode", rawValue: "FAIL" },
          legalForm: { sourceField: "rechtsvormCode", rawValue: "BV" },
          postalCodeRegion: { sourceField: "postcodeRegio", rawValue: "10" },
        },
      },
      source: {
        provider: "Kamer van Koophandel (KvK)",
        dataset: "Business Register Open Dataset - Basic Company Information",
        recordUrl: "https://opendata.kvk.nl/example",
        documentationUrl: "https://developers.kvk.nl/documentation/open-dataset-basis-bedrijfsgegevens-api",
        retrievedAt: "2026-09-19T12:00:00.000Z",
      },
      limitations: [],
      reviewTriage: [],
      research: receipt("kvk_open_dataset", "complete", 1),
    });
  });
  await page.route("**/api/trpc/gapAnalysis.searchCourtRecords*", route => fulfillTrpc(route, {
    success: true,
    outcome: "partial",
    totalResults: 0,
    decisions: [],
    retrievedAt: "2026-09-19T12:00:00.000Z",
    legalSignificance: "No matching published decisions were returned. This does not prove that no litigation exists.",
    coverageNotice: "The RSS source is not a complete litigation-history register.",
    opponentHistory: {
      success: true,
      outcome: "partial",
      totalCases: 0,
      wonCases: 0,
      lostCases: 0,
      recentCases: [],
      patterns: [],
      retrievedAt: "2026-09-19T12:00:00.000Z",
    },
    research: receipt("rechtspraak_rss", "partial", 0),
  }));
  await page.route("**/api/trpc/gapAnalysis.searchLegislation*", route => fulfillTrpc(route, {
    success: false,
    query: "bestuursrecht",
    asOfDate: "2026-09-19",
    retrievedAt: "2026-09-19T12:00:00.000Z",
    results: [],
    totalAvailable: null,
    completeness: "failed",
    source: "KOOP Basiswettenbestand SRU 2.0",
    coverageNotice: "No legal-source conclusion is available from this failed provider attempt.",
    error: "KOOP legislation search returned a response LARO could not safely use. No conclusion was recorded.",
    failureCode: "invalid_provider_response",
    research: receipt("koop_bwb_sru", "failed", null),
  }));

  const response = await page.goto(`/evidence?view=gaps&case=${caseId}`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Evidence coverage and source availability" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Public Records", exact: true }).click();
  await page.getByLabel("KvK Number").fill("12345678");
  await page.getByRole("button", { name: "Search KvK Registry", exact: true }).click();
  await expect(page.getByTestId("research-state-unavailable")).toContainText("No zero-result, status, insolvency, or absence conclusion was recorded.");
  await page.getByRole("button", { name: "Search KvK Registry", exact: true }).click();
  await expect(page.getByTestId("research-state-empty")).toContainText("Complete response — no matches");
  await page.getByRole("button", { name: "Search KvK Registry", exact: true }).click();
  await expect(page.getByTestId("research-state-complete")).toContainText("Complete provider response");
  await expect(page.getByText("Bankruptcy (Faillissement)", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Court Records", exact: true }).click();
  await page.getByLabel("Company Name").fill("No Published Match BV");
  await page.getByRole("button", { name: "Search Court Records", exact: true }).click();
  await expect(page.getByTestId("research-state-partial")).toContainText("absence is not established");
  await expect(page.getByText("Zero in this partial source is not evidence that no published decisions exist.", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Legislation", exact: true }).click();
  await page.getByLabel("Law or regulation").fill("bestuursrecht");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("research-state-failed")).toContainText("Research failed");
  await expect(page.getByTestId("research-state-failed")).toContainText("No zero-result, status, insolvency, or absence conclusion was recorded.");

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include("#main-content").analyze();
    expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`public-research-${viewport.name}.png`), fullPage: true });
  }

  await page.evaluate(() => localStorage.setItem("laro.locale", "nl"));
  const dutchReload = await page.reload({ waitUntil: "networkidle" });
  expect(dutchReload?.status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(page.getByRole("heading", { name: "Bewijsdekking en bronbeschikbaarheid" })).toBeVisible();
  await expect(page.getByText("Juridische grondslag: onbekend", { exact: true })).toBeVisible();
  await expect(page.getByText(/Inventaris — invoerrecords: 0;/)).toBeVisible();
  await expect(page.getByText("juridische grondslag onbekend", { exact: true })).toBeVisible();
  await expect(page.getByText(/Deze momentopname inventariseert alleen records die momenteel voor LARO zichtbaar zijn/)).toBeVisible();
  await expect(page.getByText(/Vraag een bevoegde advocaat om de toepasselijke bronnen voor de juridische grondslag vast te stellen/)).toBeVisible();
  await page.getByRole("tab", { name: "Openbare registers", exact: true }).click();
  await expect(page.getByRole("tab", { name: "KvK-bedrijfsregister", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Rechtbankgegevens", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Wetgeving", exact: true })).toBeVisible();
  await expect(page.getByText("Zoeken in Nederlands bedrijfsregister (KvK)", { exact: true })).toBeVisible();
  await expect(page.getByLabel("KvK-nummer", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Wetgeving", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Officiële Nederlandse wetgeving", exact: true })).toBeVisible();
  await expect(page.getByLabel("Wet of regeling", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("public-research-nl.png"), fullPage: true });

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(badResponses).toEqual([]);
});

test("coverage review renders exact revisions and unknown legal basis without merit scores", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badResponses: Array<{ status: number; url: string }> = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });
  page.on("response", response => {
    if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() });
  });

  const email = await createAccount(page);
  const caseId = `A11Y_COVERAGE_${randomUUID()}`;
  const now = Math.floor(Date.now() / 1_000);
  const started = now - (45 * 86_400);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const owner = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    database.prepare(
      `INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, createdAt, updatedAt)
       VALUES (?, ?, 'Coverage browser review', 'General records review', 'Revision-bound coverage fixture', 'Low', 'Intake', ?, ?)`,
    ).run(caseId, owner.id, now, now);
    database.prepare(
      `INSERT INTO timeline (id, caseId, userId, eventType, title, description, eventAt, metadata, createdAt)
       VALUES (?, ?, ?, 'request', 'Recorded information request', 'Request recorded in LARO', ?, ?, ?)`,
    ).run(`${caseId}_START`, caseId, owner.id, started, JSON.stringify({ reviewStatus: "reviewed" }), started);
    database.prepare(
      `INSERT INTO timeline (id, caseId, userId, eventType, title, description, eventAt, metadata, createdAt)
       VALUES (?, ?, ?, 'recorded_event', 'Later recorded event', 'Later event recorded in LARO', ?, ?, ?)`,
    ).run(`${caseId}_END`, caseId, owner.id, now, JSON.stringify({ reviewStatus: "reviewed" }), now);
    database.prepare(
      `INSERT INTO evidence (id, caseId, userId, type, source, title, description, metadata, relevant, createdAt, updatedAt)
       VALUES (?, ?, ?, 'document', 'manual', 'Reviewed browser record', 'Coverage browser source record', ?, 1, ?, ?)`,
    ).run(
      `${caseId}_EVIDENCE`,
      caseId,
      owner.id,
      JSON.stringify({ reviewStatus: "reviewed", contentHash: "d".repeat(64) }),
      now,
      now,
    );
  } finally {
    database.close();
  }

  const route = `/evidence?view=gaps&case=${caseId}`;
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    const response = await page.goto(route, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Evidence coverage and source availability" }))
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Legal basis: Unknown", { exact: true })).toBeVisible();
    await expect(page.getByText("evidence-coverage-v1", { exact: false })).toBeVisible();
    const revisions = page.locator("details").filter({ hasText: "Exact inputs and revisions" });
    await revisions.locator("summary").click();
    await expect(revisions).toContainText(`timeline_event:${caseId}_START`);
    await expect(revisions).toContainText(`evidence_record:${caseId}_EVIDENCE`);
    await expect(page.getByText("Completeness Score", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Case Strength", { exact: true })).toHaveCount(0);
    await expect(page.getByText("No critical gaps detected", { exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include("#main-content").analyze();
    expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`coverage-review-${viewport.name}.png`), fullPage: true });
  }

  expect(badResponses).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test("coverage review hides derived results and distinguishes stale, running, failed, and unavailable states", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badResponses: Array<{ status: number; url: string }> = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });
  page.on("response", response => {
    if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() });
  });

  const email = await createAccount(page);
  const caseId = `A11Y_GAP_FRESHNESS_${randomUUID()}`;
  const runId = `${caseId}_RUN`;
  const now = Math.floor(Date.now() / 1_000);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const owner = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    database.prepare(
      `INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, createdAt, updatedAt)
       VALUES (?, ?, 'Freshness state review', 'Records review', 'Gap-analysis state fixture', 'Low', 'Intake', ?, ?)`,
    ).run(caseId, owner.id, now, now);
    database.prepare(
      `INSERT INTO communication_gaps (id, caseId, data, createdAt) VALUES (?, ?, ?, ?)`,
    ).run(`${caseId}_HIDDEN_GAP`, caseId, JSON.stringify({
      context: "STALE DERIVED GAP MUST STAY HIDDEN",
      significance: "critical",
    }), now);
    database.prepare(
      `INSERT INTO case_strength_analysis (id, caseId, data, createdAt) VALUES (?, ?, ?, ?)`,
    ).run(runId, caseId, JSON.stringify({
      contractVersion: "evidence-coverage-v1",
      contractStatus: "current",
      analysisStatus: "stale",
      inputRevision: "1".repeat(64),
      caseRevision: "2".repeat(64),
      sourceRevision: "3".repeat(64),
      inputs: [],
      staleReason: "inputs_changed",
    }), now);
  } finally {
    database.close();
  }

  const setState = (analysisStatus: "running" | "failed" | "unavailable", extra: Record<string, unknown> = {}) => {
    const stateDatabase = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
    try {
      stateDatabase.prepare("UPDATE case_strength_analysis SET data = ? WHERE id = ?").run(JSON.stringify({
        contractVersion: "evidence-coverage-v1",
        contractStatus: "current",
        analysisStatus,
        inputRevision: "1".repeat(64),
        caseRevision: "2".repeat(64),
        sourceRevision: "3".repeat(64),
        inputs: [],
        ...extra,
      }), runId);
    } finally {
      stateDatabase.close();
    }
  };

  const response = await page.goto(`/evidence?view=gaps&case=${caseId}`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("gap-analysis-state-stale")).toContainText("Coverage review is stale");
  await expect(page.getByText("STALE DERIVED GAP MUST STAY HIDDEN", { exact: true })).toHaveCount(0);

  setState("running");
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByTestId("gap-analysis-state-running")).toContainText("Coverage review is running");

  setState("failed", {
    failureCode: "analysis_failed",
    failureMessage: "The coverage review failed before a current result was saved.",
  });
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByTestId("gap-analysis-state-failed")).toContainText("Coverage review failed");
  await expect(page.getByTestId("gap-analysis-state-failed")).toContainText("Earlier derived results remain hidden");

  setState("unavailable");
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByTestId("gap-analysis-state-unavailable")).toContainText("Coverage review is unavailable");
  await expect(page.getByText("STALE DERIVED GAP MUST STAY HIDDEN", { exact: true })).toHaveCount(0);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include("#main-content").analyze();
    expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`gap-analysis-state-${viewport.name}.png`), fullPage: true });
  }

  expect(badResponses).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test("reviewed legal draft persists and downloads the exact immutable snapshot", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badResponses: Array<{ status: number; url: string }> = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });
  page.on("response", response => {
    if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() });
  });
  await page.addInitScript(() => localStorage.setItem("laro.locale", "en"));

  const email = await createAccount(page);
  const caseId = `A11Y_LEGAL_DRAFT_${randomUUID()}`;
  const now = Math.floor(Date.now() / 1_000);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const owner = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    database.prepare(
      `INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, createdAt, updatedAt)
       VALUES (?, ?, 'Reviewed draft browser case', 'Records review', 'Immutable draft download fixture', 'Low', 'Intake', ?, ?)`,
    ).run(caseId, owner.id, now, now);
  } finally {
    database.close();
  }

  const response = await page.goto(`/evidence?view=gaps&case=${caseId}`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Evidence coverage and source availability" }))
    .toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Legal Docs", exact: true }).click();

  await page.getByLabel("Recipient name or organization").fill("Reviewed Browser Records Office");
  await page.getByLabel("Complete postal address").fill("Snapshot Street 19\n1234 AB Utrecht\nNetherlands");
  await page.getByLabel("I verified this exact name, complete address, and provenance for the intended recipient.")
    .check();
  await page.getByRole("button", { name: "Save reviewed recipient", exact: true }).click();
  await expect(page.getByText(/Revision 1 reviewed/)).toBeVisible();

  await page.getByRole("button", { name: "Generate persisted preview", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Records Request" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Reviewed Browser Records Office");
  await expect(dialog).toContainText("Snapshot Street 19");
  await expect(dialog.getByText(/^SHA-256 [a-f0-9]{64}$/)).toBeVisible();
  await dialog.getByLabel("I reviewed this exact recipient, content, source revision, and SHA-256 snapshot.")
    .check();
  await dialog.getByRole("button", { name: "Confirm review and lock snapshot", exact: true }).click();
  const exactDownload = dialog.getByRole("button", { name: "Download exact persisted text", exact: true });
  await expect(exactDownload).toBeVisible();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`reviewed-legal-draft-${viewport.name}.png`), fullPage: true });
  }

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exactDownload.click(),
  ]);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const downloadedBytes = readFileSync(downloadPath!);

  const verificationDatabase = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const snapshot = verificationDatabase.prepare(
      `SELECT id, status, contentBase64, contentHash, byteLength, fileName
       FROM legal_draft_snapshots WHERE caseId = ?`,
    ).get(caseId) as {
      id: string;
      status: string;
      contentBase64: string;
      contentHash: string;
      byteLength: number;
      fileName: string;
    };
    expect(snapshot.status).toBe("reviewed");
    expect(download.suggestedFilename()).toBe(snapshot.fileName);
    expect(downloadedBytes).toEqual(Buffer.from(snapshot.contentBase64, "base64"));
    expect(downloadedBytes).toHaveLength(snapshot.byteLength);
    expect(createHash("sha256").update(downloadedBytes).digest("hex")).toBe(snapshot.contentHash);

    const owner = verificationDatabase.prepare("SELECT id FROM users WHERE email = ?")
      .get(email) as { id: string };
    const audits = verificationDatabase.prepare(
      `SELECT action, details FROM audit_logs
       WHERE userId = ?
         AND action IN ('legal_draft.recipient_reviewed', 'legal_draft.reviewed', 'legal_draft.downloaded')`,
    ).all(owner.id) as Array<{ action: string; details: string }>;
    expect(audits.map(item => item.action).sort()).toEqual([
      "legal_draft.downloaded",
      "legal_draft.recipient_reviewed",
      "legal_draft.reviewed",
    ]);
    expect(audits.map(item => item.details).join(" ")).not.toContain("Reviewed Browser Records Office");
    expect(audits.map(item => item.details).join(" ")).not.toContain("Snapshot Street 19");
  } finally {
    verificationDatabase.close();
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Draft version history", { exact: true })).toBeVisible();
  await expect(page.getByText("reviewed", { exact: true })).toBeVisible();

  expect(badResponses).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test("typed notifications render safe actions and suppress unavailable destinations", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badResponses: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
  });
  await page.addInitScript(() => localStorage.setItem("laro.locale", "en"));

  const email = await createAccount(page);
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  const suffix = randomUUID();
  const caseId = `A11Y_NOTIFICATION_CASE_${suffix}`;
  const otherUserId = `A11Y_NOTIFICATION_OTHER_${suffix}`;
  const foreignCaseId = `A11Y_NOTIFICATION_FOREIGN_${suffix}`;
  const lawyerId = `A11Y_NOTIFICATION_LAWYER_${suffix}`;
  const evidenceId = `A11Y_NOTIFICATION_EVIDENCE_${suffix}`;
  try {
    const owner = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    const now = Math.floor(Date.now() / 1000);
    database.prepare("INSERT INTO users (id, email, name, role, createdAt) VALUES (?, ?, 'Other notification owner', 'user', ?)")
      .run(otherUserId, `${otherUserId.toLowerCase()}@example.test`, now);
    database.prepare(
      `INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, createdAt, updatedAt)
       VALUES (?, ?, 'Notification browser case', 'Employment', 'Typed notification browser fixture', 'Medium', 'Matching', ?, ?)`,
    ).run(caseId, owner.id, now, now);
    database.prepare(
      `INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, createdAt, updatedAt)
       VALUES (?, ?, 'Foreign notification case', 'Employment', 'Must not be exposed', 'Medium', 'Matching', ?, ?)`,
    ).run(foreignCaseId, otherUserId, now, now);
    database.prepare("INSERT INTO lawyers (id, name, email, createdAt, updatedAt) VALUES (?, 'Notification Lawyer', ?, ?, ?)")
      .run(lawyerId, `${lawyerId.toLowerCase()}@law.example.test`, now, now);
    database.prepare(
      "INSERT INTO outreach_status (id, caseId, lawyerId, status, createdAt, updatedAt) VALUES (?, ?, ?, 'Interested', ?, ?)",
    ).run(`A11Y_NOTIFICATION_OUTREACH_${suffix}`, caseId, lawyerId, now, now);
    database.prepare(
      `INSERT INTO evidence (id, caseId, userId, type, source, title, relevant, createdAt, updatedAt)
       VALUES (?, ?, ?, 'document', 'manual', 'Notification evidence', 1, ?, ?)`,
    ).run(evidenceId, caseId, owner.id, now, now);

    const insertNotification = database.prepare(`
      INSERT INTO notifications
        (id, userId, kind, title, body, actionUrl, metadata, caseId, lawyerId, evidenceFileId, dedupKey, read, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    insertNotification.run(
      `A11Y_NOTIFICATION_RESPONSE_${suffix}`,
      owner.id,
      "lawyer_response",
      "Browser lawyer response",
      "The lawyer response is ready.",
      `/cases?case=${encodeURIComponent(caseId)}`,
      JSON.stringify({ response: "Interested" }),
      caseId,
      lawyerId,
      null,
      `browser-lawyer-response:${suffix}`,
      now + 3,
    );
    insertNotification.run(
      `A11Y_NOTIFICATION_EVIDENCE_ROW_${suffix}`,
      owner.id,
      "evidence_uploaded",
      "Browser evidence uploaded",
      "The evidence is available.",
      `/evidence?view=items&case=${encodeURIComponent(caseId)}&evidence=${encodeURIComponent(evidenceId)}`,
      JSON.stringify({ source: "manual" }),
      caseId,
      null,
      evidenceId,
      `browser-evidence:${suffix}`,
      now + 2,
    );
    insertNotification.run(
      `A11Y_NOTIFICATION_UNAVAILABLE_${suffix}`,
      owner.id,
      "case_status_change",
      "Unavailable foreign destination",
      "This destination must stay disabled.",
      `/cases?case=${encodeURIComponent(foreignCaseId)}`,
      JSON.stringify({ confidential: true }),
      foreignCaseId,
      null,
      null,
      `browser-unavailable:${suffix}`,
      now + 1,
    );
  } finally {
    database.close();
  }

  const reloadResponse = await page.reload({ waitUntil: "networkidle" });
  expect(reloadResponse?.status()).toBe(200);
  const trigger = page.getByRole("button", { name: /Open notifications/ });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await trigger.click();
    const popover = page.locator('[data-slot="popover-content"]');
    await expect(popover).toBeVisible();
    const lawyerResponse = popover.locator('[data-notification-kind="lawyer_response"]');
    const evidenceUploaded = popover.locator('[data-notification-kind="evidence_uploaded"]');
    const unavailable = popover.locator('[data-notification-id^="A11Y_NOTIFICATION_UNAVAILABLE_"]');
    await expect(lawyerResponse.getByRole("img", { name: "lawyer response notification" })).toBeVisible();
    await expect(evidenceUploaded.getByRole("img", { name: "evidence uploaded notification" })).toBeVisible();
    await expect(lawyerResponse).toHaveAttribute("data-notification-destination", "available");
    await expect(evidenceUploaded).toHaveAttribute("data-notification-destination", "available");
    await expect(unavailable).toHaveAttribute("data-notification-destination", "unavailable");
    await expect(unavailable.getByText("Destination unavailable", { exact: true })).toBeVisible();
    await expect(unavailable.getByRole("button", { name: "View", exact: true })).toHaveCount(0);
    const audit = await new AxeBuilder({ page }).include('[data-slot="popover-content"]').analyze();
    expect(audit.violations.filter(item => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`typed-notifications-${viewport.name}.png`), fullPage: false });
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
  }

  await page.setViewportSize(VIEWPORTS[0]);
  await trigger.click();
  const lawyerResponse = page.locator('[data-notification-kind="lawyer_response"]');
  await lawyerResponse.getByRole("button", { name: "View", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/cases\\?case=${caseId}$`));
  await expect(page.getByRole("dialog")).toBeVisible();

  expect(badResponses).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test("folder-first collection is visibly saved but not scheduled until keywords exist", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badApiResponses: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (!failure.includes("ERR_ABORTED")) requestFailures.push(`${request.method()} ${request.url()}: ${failure}`);
  });
  page.on("response", (response) => {
    if (response.url().includes("/api/trpc/") && response.status() >= 400) {
      badApiResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  const email = await createAccount(page);
  const caseId = `A11Y_FOLDER_SCHEDULE_${randomUUID()}`;
  const database = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    const owner = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    const now = Math.floor(Date.now() / 1000);
    database.prepare(
      `INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, createdAt, updatedAt)
       VALUES (?, ?, 'Folder-first browser case', 'Contract', 'Saved source schedule fixture', 'Medium', 'Intake', ?, ?)`,
    ).run(caseId, owner.id, now, now);
    database.prepare(
      `INSERT INTO auto_collection_settings
       (id, caseId, userId, keywords, keywordMatchMode, emailAccountIds, autoDownloadAttachments,
        autoDownloadGoogleDriveFiles, isEnabled, status, metadata, updatedAt)
       VALUES (?, ?, ?, '[]', 'any', '[]', 1, 1, 0, 'configured', ?, ?)`,
    ).run(
      `A11Y_FOLDER_SETTINGS_${randomUUID()}`,
      caseId,
      owner.id,
      JSON.stringify({ localFolderPaths: ["/approved/browser-folder"] }),
      now,
    );
  } finally {
    database.close();
  }

  const response = await page.goto(`/cases?case=${caseId}`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Folder-first browser case", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Documents", exact: true }).click();
  const status = dialog.getByTestId("local-folder-schedule-status");
  await expect(status).toContainText("Saved source only");
  await expect(status).toContainText("add keywords in Auto-Collection Settings");
  await page.screenshot({ path: testInfo.outputPath("folder-source-not-scheduled.png"), fullPage: false });

  const updateDatabase = new Database(resolve(".laro-a11y.sqlite"), { fileMustExist: true });
  try {
    updateDatabase.prepare(
      "UPDATE auto_collection_settings SET keywords = ?, isEnabled = 1, status = 'active' WHERE caseId = ?",
    ).run(JSON.stringify(["contract"]), caseId);
  } finally {
    updateDatabase.close();
  }

  const reloadResponse = await page.reload({ waitUntil: "networkidle" });
  expect(reloadResponse?.status()).toBe(200);
  const reloadedDialog = page.getByRole("dialog");
  await reloadedDialog.getByRole("button", { name: "Documents", exact: true }).click();
  await expect(reloadedDialog.getByTestId("local-folder-schedule-status"))
    .toContainText("Scheduled collection is active");

  expect(badApiResponses).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});
