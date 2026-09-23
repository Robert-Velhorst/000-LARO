import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { answerProductQuestion } from '../../server/productAssistant';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser } from '../factories';

describe('no-case product assistant boundary', () => {
  it('answers bounded product-navigation questions without legal analysis', () => {
    expect(answerProductQuestion('How do I upload evidence?')).toMatchObject({
      grounded: false,
      mode: 'product_help',
      citations: [],
      notice: expect.stringContaining('Product help only'),
    });
    expect(answerProductQuestion('Where are Settings?')).toMatchObject({
      grounded: false,
      mode: 'product_help',
    });
  });

  it.each([
    'What is the deadline to appeal?',
    'Am I legally entitled to compensation?',
    'Will I win my case?',
    'Should I sue my employer?',
    'What happened in my dossier?',
  ])('requires a selected case for case-specific or legal question: %s', (question) => {
    const result = answerProductQuestion(question);
    expect(result).toMatchObject({
      grounded: false,
      mode: 'case_required',
      citations: [],
    });
    expect(result.answer).toContain('Select the relevant case');
    expect(result.notice).toContain('no case was selected');
  });

  it('does not improvise an answer outside its product-help topics', () => {
    expect(answerProductQuestion('Write a persuasive letter for me.')).toMatchObject({
      grounded: false,
      mode: 'unavailable',
      citations: [],
      notice: 'No case was selected. The request was not sent to an AI provider.',
    });
  });
});

const suite = sqliteAvailable ? describe : describe.skip;

suite('no-case assistant API', () => {
  let app: TestApp;
  const user = buildUser({ id: 'USER_PRODUCT_ASSISTANT', email: 'product-assistant@example.com' });

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(user);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => app?.cleanup());

  it('never calls an external provider for no-case product help or legal requests', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('no-case mode must not call a provider')));
    vi.stubGlobal('fetch', fetchMock);
    const caller = app.makeCaller(user);

    await expect(caller.assistant.ask({ question: 'How do I scan documents?' })).resolves.toMatchObject({
      caseId: null,
      ownerId: user.id,
      mode: 'product_help',
      grounded: false,
      citations: [],
    });
    await expect(caller.assistant.ask({ question: 'What legal deadline applies to my case?' })).resolves.toMatchObject({
      caseId: null,
      ownerId: user.id,
      mode: 'case_required',
      grounded: false,
      citations: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
