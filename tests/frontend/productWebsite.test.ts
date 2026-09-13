import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../public/product.js', import.meta.url), 'utf8');

function mount(fetch: ReturnType<typeof vi.fn>) {
  const status = { textContent: '' };
  const document = { hidden: false, getElementById: () => status, addEventListener: vi.fn() };
  const interval = vi.fn();
  const timeout = vi.fn(() => 'bounded-request');
  runInNewContext(source, { document, fetch, setInterval: interval, AbortSignal: { timeout } });
  return { status, document, timeout, refresh: () => interval.mock.calls[0][0]() };
}

const settle = () => new Promise(resolve => { setImmediate(resolve); });
const response = (dbReady: unknown, ok = true) => ({ ok, json: async () => ({ dbReady }) });

describe('product website connection status', () => {
  it('uses database readiness without implying source or model acceptance', async () => {
    const fetch = vi.fn().mockResolvedValue(response(true));
    const page = mount(fetch);
    await settle();
    expect(page.status.textContent).toContain('API is bereikbaar');
    expect(page.status.textContent).toContain('nog niet bevestigd');
    expect(fetch).toHaveBeenCalledWith('./api/health', {
      credentials: 'omit', cache: 'no-store', signal: 'bounded-request',
    });
    expect(page.timeout).toHaveBeenCalledWith(5000);
  });

  it.each([false, undefined, 'true'])('does not treat %s as readiness', async value => {
    const page = mount(vi.fn().mockResolvedValue(response(value)));
    await settle();
    expect(page.status.textContent).toContain('niet gereed');
  });

  it('recovers from a startup failure without refreshing the page', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('not started')).mockResolvedValue(response(true));
    const page = mount(fetch);
    await settle();
    expect(page.status.textContent).toContain('niet bereikbaar');
    await page.refresh();
    expect(page.status.textContent).toContain('API is bereikbaar');
  });

  it('does not accept unsuccessful responses even with a ready payload', async () => {
    const page = mount(vi.fn().mockResolvedValue(response(true, false)));
    await settle();
    expect(page.status.textContent).toContain('niet gereed');
  });

  it('skips hidden pages and overlapping checks, then rechecks on return', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    const fetch = vi.fn().mockImplementation(() => new Promise(done => { resolve = done; }));
    const page = mount(fetch);
    await page.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(response(true));
    await settle();
    page.document.hidden = true;
    await page.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    page.document.hidden = false;
    fetch.mockResolvedValue(response(false));
    await page.document.addEventListener.mock.calls[0][1]();
    expect(page.status.textContent).toContain('niet gereed');
  });
});
