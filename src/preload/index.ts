import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AppSettings, CleanReport, PosterPicks, ScanPlan, TaskEvent } from '../shared/types'

const api = {
  selectWorkspace: (): Promise<string | null> => ipcRenderer.invoke('dialog:select-workspace'),
  scanPlan: (root: string): Promise<ScanPlan> => ipcRenderer.invoke('workspace:scan-plan', root),
  executeClean: (plan: ScanPlan, picks: PosterPicks): Promise<CleanReport> =>
    ipcRenderer.invoke('clean:execute', plan, picks),
  cancelClean: (): Promise<void> => ipcRenderer.invoke('clean:cancel'),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:update', patch),
  onTaskEvent: (callback: (event: TaskEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: TaskEvent): void => callback(payload)
    ipcRenderer.on('tasks:event', listener)
    return () => ipcRenderer.removeListener('tasks:event', listener)
  }
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore: legacy non-isolated preload fallback
  window.electron = electronAPI
  // @ts-ignore: legacy non-isolated preload fallback
  window.api = api
}
