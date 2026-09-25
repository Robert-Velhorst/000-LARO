const LEGACY_UNOWNED_KEY = 'laroDefaultLocalScanFolders';
const ownerKey = (ownerId: string) => `laroDefaultLocalScanFolders:${ownerId}`;

function discardUnownedFolders(): void {
  // The legacy shared value cannot safely be assigned to whichever account
  // happens to sign in next. This removes the old path-bearing preference.
  window.localStorage.removeItem(LEGACY_UNOWNED_KEY);
}

export function readDefaultScannerFolders(ownerId?: string | null): string[] {
  try {
    discardUnownedFolders();
    if (!ownerId) return [];
    const raw = window.localStorage.getItem(ownerKey(ownerId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export function writeDefaultScannerFolders(ownerId: string, paths: string[]): void {
  if (!ownerId) throw new Error('Sign in before saving scanner folders');
  discardUnownedFolders();
  window.localStorage.setItem(ownerKey(ownerId), JSON.stringify(paths));
  window.dispatchEvent(new CustomEvent('laro:default-folders-changed', { detail: { ownerId } }));
}

export function eraseDefaultScannerFolders(ownerId: string): void {
  discardUnownedFolders();
  if (ownerId) window.localStorage.removeItem(ownerKey(ownerId));
}
