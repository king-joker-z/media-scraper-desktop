import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  selectWorkspace: (): Promise<string | null> => ipcRenderer.invoke('dialog:select-workspace'),
  scanPlan: (root: string): Promise<unknown> => ipcRenderer.invoke('workspace:scan-plan', root)
}

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
