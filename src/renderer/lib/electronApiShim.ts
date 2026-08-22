export const isElectron = (): boolean =>
  typeof window !== 'undefined' && typeof (window as any).electronAPI !== 'undefined';

export function getElectronAPI() {
  if (isElectron()) return (window as any).electronAPI;
  return {
    getConfig:          () => Promise.resolve({ apiUrl: 'http://localhost:3000', deviceName: 'browser', caseId: null }),
    setConfig:          (c: any) => Promise.resolve(c),
    getSystemInfo:      () => Promise.resolve({ platform: 'browser', hostname: 'browser', username: 'browser', homeDir: '/', version: '0.0.0' }),
    getAppVersion:      () => Promise.resolve('0.0.0'),
    openExternal:       (url: string) => { window.open(url, '_blank'); return Promise.resolve(); },
    reportRendererError: (report: unknown) => { console.error('Renderer error report', report); return Promise.resolve(); },
    selectFolder:       () => Promise.resolve(null),
    startScan:          () => Promise.reject(new Error('Folder scanning requires LARO Desktop')),
    stopScan:           () => Promise.reject(new Error('Folder scanning requires LARO Desktop')),
    pauseScan:          () => Promise.reject(new Error('Folder scanning requires LARO Desktop')),
    resumeScan:         () => Promise.reject(new Error('Folder scanning requires LARO Desktop')),
    getScanFiles:       () => Promise.resolve({ files: [] }),
    setScanFileSelection: () => Promise.reject(new Error('Folder scanning requires LARO Desktop')),
    startUpload:        () => Promise.reject(new Error('Folder scanning requires LARO Desktop')),
    pauseUpload:        () => Promise.reject(new Error('Folder scanning requires LARO Desktop')),
    resumeUpload:       () => Promise.reject(new Error('Folder scanning requires LARO Desktop')),
    onScanProgress:     () => {},
    onUploadProgress:   () => {},
    clearScanProgressListeners: () => {},
    clearUploadProgressListeners: () => {},
  };
}
