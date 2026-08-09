import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const read = (relativePath: string) => readFileSync(join(ROOT, relativePath), 'utf8');

describe('production renderer usability regressions', () => {
  it('keeps the cases header and primary actions usable on narrow screens', () => {
    const cases = read('src/renderer/components/Cases.tsx');

    expect(cases).toContain('flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between');
    expect(cases).toContain('text-3xl font-bold');
    expect(cases).toContain('flex w-full gap-2 sm:w-auto');
    expect(cases).not.toContain('<div className="p-6 space-y-6">');
  });

  it('keeps the floating assistant inside mobile viewports and names every control', () => {
    const chat = read('src/renderer/components/ChatWidget.tsx');

    expect(chat).toContain('left-3 right-3');
    expect(chat).toContain('h-[calc(100dvh-1.5rem)]');
    for (const label of [
      'Open LARO assistant',
      'Expand LARO assistant',
      'Minimize LARO assistant',
      'Close LARO assistant',
      'Message LARO assistant',
      'Send message',
    ]) {
      expect(chat).toContain(label);
    }
  });

  it('uses canonical notification state without presenting a fake delete action', () => {
    const notifications = read('src/renderer/components/NotificationCenter.tsx');

    expect(notifications).toContain('!notification.isRead');
    expect(notifications).not.toContain('!notification.read');
    expect(notifications).not.toContain('handleDelete');
    expect(notifications).toContain('Open notifications');
    expect(notifications).toContain('Mark ${notification.title} as read');
  });

  it('keeps shared filters, privacy controls, and case-note fields named', () => {
    const layout = read('src/renderer/components/DashboardLayout.tsx');
    const translations = read('shared/i18n.ts');
    const filters = read('src/renderer/components/SmartSearchFilters.tsx');
    const privacy = read('src/renderer/components/Privacy.tsx');
    const notes = read('src/renderer/components/CommunicationHub.tsx');

    expect(layout).toContain('aria-label={t("nav.expandSidebar")}');
    expect(layout).toContain('aria-label={t("nav.collapseSidebar")}');
    expect(layout).toContain('aria-label={t("nav.accountMenu")}');
    expect(translations).toContain('"nav.expandSidebar"');
    expect(translations).toContain('"nav.collapseSidebar"');
    expect(translations).toContain('"nav.accountMenu"');
    expect(filters).toContain('aria-label="Filter by legal area"');
    expect(filters).toContain('"Search lawyers" : "Search cases"');
    expect(privacy).toContain('aria-label="Allow marketing communication"');
    expect(privacy).toContain('aria-label="Allow usage analytics"');
    expect(notes).toContain('aria-label="Search case notes"');
    expect(notes).toContain('aria-label="Case note message"');
    expect(notes).not.toContain('from "date-fns"');
    expect(notes).not.toContain('All Status');
    expect(notes).not.toContain('Avg Response Time');
    expect(notes).not.toContain('Request Status Update');
  });

  it('does not promise unsupported providers, billing, compliance, or response SLAs', () => {
    const help = read('src/renderer/components/Help.tsx');

    for (const staleClaim of [
      'uses AI to analyze your case details',
      'Most lawyers respond within 24-48 hours',
      'All data is encrypted and stored securely',
      'OneDrive, Slack, and other platforms',
      "we'll get back to you within 24 hours",
      'Billing & Subscription',
    ]) {
      expect(help).not.toContain(staleClaim);
    }

    expect(help).toContain('read-only Gmail and Google Drive');
    expect(help).toContain('aria-expanded={expandedFaq === index}');
    expect(help).toContain('aria-label="Support ticket category"');
  });

  it('uses LARO-owned shell metadata and complete authentication autocomplete hints', () => {
    const shell = read('index.html');
    const auth = read('src/renderer/components/AuthPage.tsx');

    expect(shell).toContain('<title>LARO | Legal Evidence Workspace</title>');
    expect(shell).toContain('href="/laro-logo.png"');
    expect(shell).not.toContain('manuscdn.com');
    expect(auth).toContain('autoComplete="email"');
    expect(auth).toContain('"new-password" : "current-password"');
    expect(auth).toContain('autoComplete="one-time-code"');
  });

  it('keeps the legal-assistance boundary visible throughout the authenticated workspace', () => {
    const layout = read('src/renderer/components/DashboardLayout.tsx');
    const notice = read('src/renderer/components/LegalAdviceNotice.tsx');
    const translations = read('shared/i18n.ts');

    expect(layout).toContain('<LegalAdviceNotice />');
    expect(notice).toContain('role="note"');
    expect(notice).toContain('aria-label={t("legal.noticeLabel")}');
    expect(notice).toContain('t("legal.noticeTitle")');
    expect(notice).toContain('t("legal.noticeBody")');
    expect(translations).toContain('"legal.noticeLabel"');
    expect(translations).toContain('"legal.noticeTitle"');
    expect(translations).toContain('"legal.noticeBody"');
  });

  it('offers local image OCR and analyzes supported evidence automatically', () => {
    const analysis = read('src/renderer/components/AutomatedDocumentAnalysis.tsx');
    const upload = read('src/renderer/components/EnhancedEvidenceUpload.tsx');

    expect(analysis).toContain('.jpg,.jpeg,.png,.gif,.webp,.bmp');
    expect(analysis).toContain('Dutch and English OCR for images');
    expect(analysis).toContain('extraction_confidence');
    expect(upload).toContain('isSupportedDocumentAnalysisMimeType(item.mimeType)');
    expect(upload).toContain('analyzeEvidence.mutateAsync');
    expect(upload).toContain('status: "analyzing"');
  });

  it('keeps KVK lookup aligned with the supported open-data contract', () => {
    const publicRecords = read('src/renderer/components/PublicRecordsPanel.tsx');

    expect(publicRecords).toContain('inputMode="numeric"');
    expect(publicRecords).toContain('pattern="[0-9]{8}"');
    expect(publicRecords).toContain('searchKvk.length !== 8');
    expect(publicRecords).not.toContain('View LinkedIn Profile');
    expect(publicRecords).not.toContain('htmlFor="company-name"');
  });
});
