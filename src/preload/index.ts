import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AiFileInput,
  AppSettings,
  CaptureOutcome,
  CleanReport,
  NfoPlan,
  NfoPlanItem,
  NfoReport,
  PosterBatchSaveReport,
  PosterPicks,
  PosterSaveResult,
  PosterVideoItem,
  ProbeContainerItem,
  RenamePairInput,
  RenameReport,
  ScanPlan,
  TaskEvent
} from '../shared/types'

const api = {
  selectWorkspace: (): Promise<string | null> => ipcRenderer.invoke('dialog:select-workspace'),
  scanPlan: (root: string): Promise<ScanPlan> => ipcRenderer.invoke('workspace:scan-plan', root),
  executeClean: (plan: ScanPlan, picks: PosterPicks): Promise<CleanReport> =>
    ipcRenderer.invoke('clean:execute', plan, picks),
  cancelClean: (): Promise<void> => ipcRenderer.invoke('clean:cancel'),
  listPosterVideos: (root: string): Promise<PosterVideoItem[]> =>
    ipcRenderer.invoke('poster:list', root),
  capturePosters: (
    root: string,
    relativePaths: string[]
  ): Promise<{ cancelled: boolean; outcomes: CaptureOutcome[] }> =>
    ipcRenderer.invoke('poster:capture', root, relativePaths),
  capturePosterAt: (videoPath: string, seconds: number): Promise<string> =>
    ipcRenderer.invoke('poster:capture-at', videoPath, seconds),
  savePoster: (payload: {
    videoPath: string
    chosenFramePath: string
    oldPosterPath: string | null
  }): Promise<PosterSaveResult> => ipcRenderer.invoke('poster:save', payload),
  savePostersBatch: (
    videos: PosterVideoItem[],
    selections: Record<string, string>
  ): Promise<PosterBatchSaveReport> => ipcRenderer.invoke('poster:save-batch', videos, selections),
  cancelPosterCapture: (): Promise<void> => ipcRenderer.invoke('poster:cancel'),
  probeContainers: (root: string, relativePaths: string[]): Promise<ProbeContainerItem[]> =>
    ipcRenderer.invoke('rename:probe', root, relativePaths),
  requestAiNames: (files: AiFileInput[]): Promise<string[]> =>
    ipcRenderer.invoke('rename:ai', files),
  executeRename: (root: string, pairs: RenamePairInput[]): Promise<RenameReport> =>
    ipcRenderer.invoke('rename:execute', root, pairs),
  cancelRename: (): Promise<void> => ipcRenderer.invoke('rename:cancel'),
  createNfoPlan: (root: string): Promise<NfoPlan> => ipcRenderer.invoke('nfo:plan', root),
  executeNfoArchive: (root: string, items: NfoPlanItem[], actorName: string): Promise<NfoReport> =>
    ipcRenderer.invoke('nfo:execute', root, items, actorName),
  cancelNfo: (): Promise<void> => ipcRenderer.invoke('nfo:cancel'),
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
