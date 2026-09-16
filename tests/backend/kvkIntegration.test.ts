import { afterEach, describe, expect, it, vi } from 'vitest';
import { kvkIntegrationService } from '../../server/kvkIntegration';

describe('KvK open-dataset integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the documented path parameter and normalizes the open-data response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      datumAanvang: '20101231',
      actief: 'J',
      rechtsvormCode: 'BV',
      postcodeRegio: 5,
      activiteiten: [{ sbiCode: '69101', soortActiviteit: 'Hoofdactiviteit' }],
      lidstaat: 'NL',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await kvkIntegrationService.lookupByKvKNumber('59581883');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opendata.kvk.nl/api/v1/hvds/basisbedrijfsgegevens/kvknummer/59581883',
      expect.objectContaining({ method: 'GET' })
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        kvkNumber: '59581883',
        startDate: '2010-12-31',
        isActive: true,
        legalForm: 'BV',
        postalCodeRegion: '05',
        activities: [{ sbiCode: '69101', type: 'main' }],
      },
      source: {
        provider: 'Kamer van Koophandel (KvK)',
        dataset: 'Business Register Open Dataset - Basic Company Information',
        recordUrl: 'https://opendata.kvk.nl/api/v1/hvds/basisbedrijfsgegevens/kvknummer/59581883',
        retrievedAt: expect.any(String),
      },
    });
    expect(result.data?.fieldProvenance).toMatchObject({
      startDate: { sourceField: 'datumAanvang', rawValue: '20101231' },
      activityStatus: { sourceField: 'actief', rawValue: 'J' },
      insolvencyStatus: { sourceField: 'insolventieCode', rawValue: null },
    });
    expect(result.limitations).toContain(
      'No insolventieCode was returned in this response. This does not verify good standing or prove that no insolvency proceeding exists.',
    );
    expect(result.reviewTriage).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('appears to be in good standing');
  });

  it('rejects invalid numbers without calling KVK', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await kvkIntegrationService.lookupByKvKNumber('1234');

    expect(result).toEqual({
      success: false,
      error: 'Invalid KvK number. Must be 8 digits.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized KVK responses before parsing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-length': String(1024 * 1024 + 1) },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await kvkIntegrationService.lookupByKvKNumber('59581883');

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('1 MB response limit'),
    });
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  it('does not turn recent incorporation into shell-company triage', async () => {
    const recentYear = new Date().getFullYear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      datumAanvang: `${recentYear}0101`,
      actief: 'J',
      rechtsvormCode: 'BV',
      postcodeRegio: 10,
      activiteiten: [],
      lidstaat: 'NL',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const result = await kvkIntegrationService.lookupByKvKNumber('11111111');

    expect(result.success).toBe(true);
    expect(result.data?.startDate).toBe(`${recentYear}-01-01`);
    expect(result.reviewTriage).toEqual([]);
    expect(JSON.stringify(result).toLowerCase()).not.toContain('shell company');
  });

  it('keeps inactive and incomplete records factual and marks follow-up as review-only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      datumAanvang: '00000000',
      actief: 'N',
      activiteiten: [],
      lidstaat: 'NL',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const result = await kvkIntegrationService.lookupByKvKNumber('22222222');

    expect(result).toMatchObject({
      success: true,
      data: {
        startDate: null,
        isActive: false,
        legalForm: null,
        postalCodeRegion: null,
        fieldProvenance: {
          activityStatus: { sourceField: 'actief', rawValue: 'N' },
          legalForm: { sourceField: 'rechtsvormCode', rawValue: null },
        },
      },
      reviewTriage: [{
        id: 'inactive_registration',
        reviewOnly: true,
        sourceFields: ['actief'],
      }],
    });
    expect(result.limitations?.join(' ')).toContain('rechtsvormCode');
    expect(JSON.stringify(result)).not.toContain('may complicate enforcement');
  });

  it('reports a no-result response with source identity and no inferred status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));

    const result = await kvkIntegrationService.lookupByKvKNumber('33333333');

    expect(result).toMatchObject({
      success: false,
      error: 'Company not found in KvK registry.',
      source: {
        provider: 'Kamer van Koophandel (KvK)',
        retrievedAt: expect.any(String),
      },
    });
    expect(result.data).toBeUndefined();
    expect(result.reviewTriage).toBeUndefined();
  });

  it('preserves an explicitly returned insolvency code with field provenance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      datumAanvang: '20100101',
      actief: 'N',
      insolventieCode: 'FAIL',
      rechtsvormCode: 'NV',
      postcodeRegio: '7',
      activiteiten: [],
      lidstaat: 'NL',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const result = await kvkIntegrationService.lookupByKvKNumber('44444444');

    expect(result.data?.insolvencyStatus).toEqual({
      type: 'bankruptcy',
      code: 'FAIL',
      label: 'Bankruptcy (Faillissement)',
    });
    expect(result.data?.fieldProvenance.insolvencyStatus).toEqual({
      sourceField: 'insolventieCode',
      rawValue: 'FAIL',
    });
    expect(result.limitations?.join(' ')).not.toContain('No insolventieCode');
  });
});
