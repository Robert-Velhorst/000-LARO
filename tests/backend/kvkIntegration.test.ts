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
    });
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
});
