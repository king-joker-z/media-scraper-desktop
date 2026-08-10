import { contextBridge, ipcRenderer, webUtils, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AiFileInput,
  AppModule,
  AppSettings,
  CaptureOutcome,
  CleanReport,
  ComicFormat,
  ComicMergeReport,
  ComicScanResult,
  DedupeScanResult,
  HealthReport,
  MergeResult,
  MergeSourceItem,
  MergeVideoItem,
  NfoPlan,
  NfoPlanItem,
  NfoReport,
  PipelineReport,
  PipelineStep,
  PosterBatchSaveReport,
  PosterPicks,
  PosterSaveResult,
  PosterVideoItem,
  ProbeContainerItem,
  RenamePairInput,
  RenameReport,
  ScanPlan,
  StorageCategory,
  StorageCleanResult,
  StorageStats,
  TaskEvent,
  UndoReport,
  UpdateStatus,
  WatchStatus
} from '../shared/types'

const api = {
  selectWorkspace: (module?: AppModule): Promise<string | null> =>
    ipcRenderer.invoke('dialog:select-workspace', module),
  /** 校验并注册工作区（启动恢复 / 拖拽导入 / 最近列表切换；module 区分视频/漫画工作区） */
  useWorkspace: (path: string, module?: AppModule): Promise<string> =>
    ipcRenderer.invoke('workspace:use', path, module),
  /** 系统默认应用打开文件（漫画库打开 EPUB/PDF） */
  openPath: (target: string): Promise<void> => ipcRenderer.invoke('shell:open-path', target),
  /** 取拖拽文件的绝对路径（Electron 39 移除了 File.path，必须走 webUtils） */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  scanPlan: (root: string): Promise<ScanPlan> => ipcRenderer.invoke('workspace:scan-plan', root),
  getWorkspaceFingerprint: (root: string): Promise<string> =>
    ipcRenderer.invoke('workspace:fingerprint', root),
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
  scanMergeVideos: (root: string): Promise<{ videos: MergeVideoItem[]; freeBytes: number }> =>
    ipcRenderer.invoke('merge:scan', root),
  executeMerge: (root: string, items: MergeVideoItem[], outputName: string): Promise<MergeResult> =>
    ipcRenderer.invoke('merge:execute', root, items, outputName),
  deleteMergeSources: (
    root: string,
    items: MergeSourceItem[]
  ): Promise<{
    cancelled: boolean
    deletedCount: number
    failed: { target: string; error: string }[]
  }> => ipcRenderer.invoke('merge:delete-sources', root, items),
  cancelMerge: (): Promise<void> => ipcRenderer.invoke('merge:cancel'),
  scanDuplicates: (root: string, includeSimilar = true): Promise<DedupeScanResult> =>
    ipcRenderer.invoke('dedupe:scan', root, includeSimilar),
  deleteDuplicates: (
    root: string,
    relativePaths: string[]
  ): Promise<{
    cancelled: boolean
    deletedCount: number
    failed: { target: string; error: string }[]
  }> => ipcRenderer.invoke('dedupe:delete', root, relativePaths),
  cancelDedupeDelete: (): Promise<void> => ipcRenderer.invoke('dedupe:cancel'),
  scanHealth: (root: string): Promise<HealthReport> => ipcRenderer.invoke('health:scan', root),
  cancelHealth: (): Promise<void> => ipcRenderer.invoke('health:cancel'),
  scanComics: (root: string): Promise<ComicScanResult> => ipcRenderer.invoke('comic:scan', root),
  mergeComics: (
    root: string,
    relDirs: string[],
    format: ComicFormat,
    options?: { raw?: boolean; rebuild?: boolean }
  ): Promise<ComicMergeReport> => ipcRenderer.invoke('comic:merge', root, relDirs, format, options),
  cancelComicMerge: (): Promise<void> => ipcRenderer.invoke('comic:cancel'),
  deleteComicSources: (
    root: string,
    relDirs: string[]
  ): Promise<{
    cancelled: boolean
    deletedCount: number
    failed: { target: string; error: string }[]
  }> => ipcRenderer.invoke('comic:delete-sources', root, relDirs),
  executePipeline: (root: string, steps: PipelineStep[]): Promise<PipelineReport> =>
    ipcRenderer.invoke('pipeline:execute', root, steps),
  cancelPipeline: (): Promise<void> => ipcRenderer.invoke('pipeline:cancel'),
  getStorageStats: (): Promise<StorageStats> => ipcRenderer.invoke('storage:stats'),
  cleanStorage: (category: StorageCategory): Promise<StorageCleanResult> =>
    ipcRenderer.invoke('storage:clean', category),
  checkUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('update:download'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:get-status'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: UpdateStatus): void => callback(payload)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:update', patch),
  listOpLogs: (): Promise<
    {
      file: string
      module: string
      finishedAt: string
      summary: string
      undone: boolean
      undoable: boolean
    }[]
  > => ipcRenderer.invoke('op-logs:list'),
  revealOpLog: (file: string): Promise<void> => ipcRenderer.invoke('op-logs:reveal', file),
  /** 一键撤销（F2）：按日志反向恢复重命名/NFO 归档 */
  undoOpLog: (file: string): Promise<UndoReport> => ipcRenderer.invoke('op-logs:undo', file),
  /** 目录监控（F4）运行状态 */
  getWatchStatus: (): Promise<WatchStatus> => ipcRenderer.invoke('watch:status'),
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
