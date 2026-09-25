import { eraseDefaultScannerFolders, readDefaultScannerFolders } from './scannerDefaultFolders';

type AccountArchive = { data: Record<string, unknown> };

function archiveOwnerId(archive: AccountArchive): string | null {
  const meta = archive.data._meta;
  if (!meta || typeof meta !== 'object') return null;
  const ownerId = (meta as { userId?: unknown }).userId;
  return typeof ownerId === 'string' ? ownerId : null;
}

/** A server archive cannot establish which account owns this desktop's scanner paths. */
export async function includeConnectedDesktopScanner<T extends AccountArchive>(archive: T): Promise<T> {
  const ownerId = archiveOwnerId(archive);
  const data = ownerId ? {
    ...archive.data,
    desktop_scanner_default_folders: readDefaultScannerFolders(ownerId),
  } : archive.data;
  const api = window.electronAPI;
  if (!api) return { ...archive, data };
  if (!api.exportScannerHistory) throw new Error('Desktop scanner export is unavailable');
  if (!ownerId) throw new Error('Account export is missing its owner identity');
  const history = await api.exportScannerHistory();
  if (history.ownerId !== ownerId) throw new Error('Account changed during scanner export');
  return {
    ...archive,
    data: {
      ...data,
      desktop_scanner_scans: history.scans,
      desktop_scanner_files: history.files,
    },
  };
}

/** Bind local erasure to the account confirmed in the UI, in either desktop mode. */
export async function eraseConnectedDesktopScanner(ownerId: string): Promise<void> {
  const api = window.electronAPI;
  if (api) {
    if (!api.eraseScannerHistory) throw new Error('Desktop scanner erasure is unavailable');
    await api.eraseScannerHistory(ownerId);
  }
  eraseDefaultScannerFolders(ownerId);
}
