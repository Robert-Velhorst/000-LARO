import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eraseConnectedDesktopScanner, includeConnectedDesktopScanner } from '../../src/renderer/lib/scannerPrivacy';

describe('desktop scanner account archive binding', () => {
  let entries: Map<string, string>;
  const exportScannerHistory = vi.fn();
  const eraseScannerHistory = vi.fn();

  beforeEach(() => {
    entries = new Map([['laroDefaultLocalScanFolders:owner-a', '["/private/a-folder"]']]);
    exportScannerHistory.mockReset();
    eraseScannerHistory.mockReset();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => { entries.set(key, value); },
        removeItem: (key: string) => { entries.delete(key); },
      },
      electronAPI: { exportScannerHistory, eraseScannerHistory },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('refuses to combine an owner A server export with owner B local paths', async () => {
    exportScannerHistory.mockResolvedValue({ ownerId: 'owner-b', scans: [], files: [{ path: '/private/b-file' }] });
    const archive = { data: { _meta: { userId: 'owner-a' } } };
    await expect(includeConnectedDesktopScanner(archive)).rejects.toThrow(/account changed/i);
  });

  it('includes only the confirmed owner\'s folders and history, then erases their local preferences', async () => {
    exportScannerHistory.mockResolvedValue({ ownerId: 'owner-a', scans: [{ id: 'scan-a' }], files: [{ path: '/private/a-file' }] });
    eraseScannerHistory.mockResolvedValue({ scans: 1, files: 1 });
    const archive = await includeConnectedDesktopScanner({ data: { _meta: { userId: 'owner-a' } } });
    expect(archive.data).toMatchObject({
      desktop_scanner_default_folders: ['/private/a-folder'],
      desktop_scanner_scans: [{ id: 'scan-a' }],
      desktop_scanner_files: [{ path: '/private/a-file' }],
    });
    await eraseConnectedDesktopScanner('owner-a');
    expect(eraseScannerHistory).toHaveBeenCalledWith('owner-a');
    expect(entries.has('laroDefaultLocalScanFolders:owner-a')).toBe(false);
  });
});
