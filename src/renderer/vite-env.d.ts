/// <reference types="vite/client" />

/** Exposed by Electron preload (`src-main/preload.ts`) when running in desktop shell */
interface Window {
  electronAPI?: {
    openScanPanel: () => Promise<void>;
    getConfig: () => Promise<unknown>;
    setConfig: (config: unknown) => Promise<unknown>;
    selectFolder: () => Promise<string[] | null>;
    startLocalSource?: () => Promise<{ id: string } | null>;
    exportScannerHistory?: () => Promise<{ ownerId: string; scans: unknown[]; files: unknown[] }>;
    eraseScannerHistory?: (ownerId: string) => Promise<{ scans: number; files: number }>;
  };
}

interface ImportMetaEnv {
  readonly VITE_FASTAPI_URL: string;
  readonly VITE_EXPRESS_URL: string;
  readonly VITE_GO_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
