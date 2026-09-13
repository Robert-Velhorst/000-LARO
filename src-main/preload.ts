/**
 * Electron preload script
 * Exposes safe IPC methods to the renderer process
 */

import { contextBridge, ipcRenderer } from 'electron';
const IPC_CHANNELS = {
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  SYSTEM_INFO: 'system:info',
  APP_VERSION: 'app:version',
  FOLDER_SELECT: 'folder:select',
  SOURCE_FOLDER_START: 'source:folder:start',
  SCAN_START: 'scan:start',
  SCAN_STOP: 'scan:stop',
  SCAN_PAUSE: 'scan:pause',
  SCAN_RESUME: 'scan:resume',
  SCAN_PROGRESS: 'scan:progress',
  SCAN_FILES_GET: 'scan:files:get',
  SCAN_FILES_SELECT: 'scan:files:select',
  UPLOAD_START: 'upload:start',
  UPLOAD_PAUSE: 'upload:pause',
  UPLOAD_RESUME: 'upload:resume',
  UPLOAD_PROGRESS: 'upload:progress',
  EVIDENCE_UPDATED: 'evidence:updated',
  OPEN_EXTERNAL: 'open:external',
  RENDERER_ERROR_REPORT: 'renderer:error-report',
};

ipcRenderer.on(IPC_CHANNELS.EVIDENCE_UPDATED, (_event, detail) => {
  window.dispatchEvent(new CustomEvent('laro:evidence-updated', { detail }));
});

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Configuration
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET),
  setConfig: (config: any) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SET, config),
  
  // System info
  getSystemInfo: () => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_INFO),
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_VERSION),
  openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url),
  reportRendererError: (report: { message: string; stack?: string; componentStack?: string; route?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.RENDERER_ERROR_REPORT, report),
  
  // Folder selection
  selectFolder: () => ipcRenderer.invoke(IPC_CHANNELS.FOLDER_SELECT),
  startLocalSource: () => ipcRenderer.invoke(IPC_CHANNELS.SOURCE_FOLDER_START),
  
  // Scanning
  startScan: (config: any) => ipcRenderer.invoke(IPC_CHANNELS.SCAN_START, config),
  stopScan: () => ipcRenderer.invoke(IPC_CHANNELS.SCAN_STOP),
  pauseScan: () => ipcRenderer.invoke(IPC_CHANNELS.SCAN_PAUSE),
  resumeScan: () => ipcRenderer.invoke(IPC_CHANNELS.SCAN_RESUME),
  getScanFiles: (scanId: string) => ipcRenderer.invoke(IPC_CHANNELS.SCAN_FILES_GET, scanId),
  setScanFileSelection: (scanId: string, fileIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCAN_FILES_SELECT, scanId, fileIds),
  
  // Upload
  startUpload: (scanId: string) => ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_START, scanId),
  pauseUpload: () => ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_PAUSE),
  resumeUpload: () => ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_RESUME),
  
  // Event listeners
  onScanProgress(callback: (progress: any) => void) {
    ipcRenderer.on(IPC_CHANNELS.SCAN_PROGRESS, (_: any, progress: any) => callback(progress));
  },
  onUploadProgress(callback: (progress: any) => void) {
    ipcRenderer.on(IPC_CHANNELS.UPLOAD_PROGRESS, (_: any, progress: any) => callback(progress));
  },
  clearScanProgressListeners: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.SCAN_PROGRESS),
  clearUploadProgressListeners: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.UPLOAD_PROGRESS),

  // Open scan panel — added to electronAPI
  openScanPanel: () => ipcRenderer.invoke('scan:open-panel'),

});

// TypeScript declaration for window.electronAPI
declare global {
  interface Window {
    electronAPI: {
      getConfig: () => Promise<any>;
      setConfig: (config: any) => Promise<any>;
      getSystemInfo: () => Promise<any>;
      getAppVersion: () => Promise<string>;
      openExternal: (url: string) => Promise<void>;
      reportRendererError: (report: { message: string; stack?: string; componentStack?: string; route?: string }) => Promise<void>;
      selectFolder: () => Promise<string[] | null>;
      startLocalSource: () => Promise<{ id: string } | null>;
      startScan: (config: any) => Promise<{ scanId: string }>;
      stopScan: () => Promise<{ success: boolean }>;
      pauseScan: () => Promise<{ success: boolean }>;
      resumeScan: () => Promise<{ success: boolean }>;
      getScanFiles: (scanId: string) => Promise<{ files: any[] }>;
      setScanFileSelection: (scanId: string, fileIds: string[]) => Promise<{ selected: number }>;
      startUpload: (scanId: string) => Promise<{ success: boolean }>;
      pauseUpload: () => Promise<{ success: boolean }>;
      resumeUpload: () => Promise<{ success: boolean }>;
      onScanProgress: (callback: (progress: any) => void) => void;
      onUploadProgress: (callback: (progress: any) => void) => void;
      clearScanProgressListeners: () => void;
      clearUploadProgressListeners: () => void;
      openScanPanel: () => Promise<void>;
    };
  }
}
