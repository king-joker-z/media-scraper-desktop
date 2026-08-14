import { ElectronAPI } from '@electron-toolkit/preload'
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
  MergeResult,
  MergeSourceItem,
  MergeVideoItem,
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
  StorageCategory,
  StorageCleanResult,
  StorageStats,
  TaskEvent,
  UndoReport,
  UpdateStatus
} from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      selectWorkspace: (module?: AppModule) => Promise<string | null>
      useWorkspace: (path: string, module?: AppModule) => Promise<string>
      openPath: (target: string) => Promise<void>
      revealPath: (target: string) => Promise<void>
      pathForFile: (file: File) => string
      scanPlan: (root: string) => Promise<ScanPlan>
      getWorkspaceFingerprint: (root: string) => Promise<string>
      executeClean: (plan: ScanPlan, picks: PosterPicks) => Promise<CleanReport>
      /** 仅将可见文件上移到工作区根，不删除、转码或改名 poster。 */
      dissolveFolders: (plan: ScanPlan) => Promise<CleanReport>
      cancelClean: () => Promise<void>
      listPosterVideos: (root: string) => Promise<PosterVideoItem[]>
      capturePosters: (
        root: string,
        relativePaths: string[]
      ) => Promise<{ cancelled: boolean; outcomes: CaptureOutcome[] }>
      capturePosterAt: (videoPath: string, seconds: number) => Promise<string>
      savePoster: (payload: {
        videoPath: string
        chosenFramePath: string
        oldPosterPath: string | null
      }) => Promise<PosterSaveResult>
      savePostersBatch: (
        videos: PosterVideoItem[],
        selections: Record<string, string>
      ) => Promise<PosterBatchSaveReport>
      cancelPosterCapture: () => Promise<void>
      probeContainers: (root: string, relativePaths: string[]) => Promise<ProbeContainerItem[]>
      requestAiNames: (files: AiFileInput[], forceRefresh?: boolean) => Promise<string[]>
      executeRename: (root: string, pairs: RenamePairInput[]) => Promise<RenameReport>
      cancelRename: () => Promise<void>
      createNfoPlan: (root: string) => Promise<NfoPlan>
      executeNfoArchive: (
        root: string,
        items: NfoPlanItem[],
        actorName: string
      ) => Promise<NfoReport>
      cancelNfo: () => Promise<void>
      scanMergeVideos: (root: string) => Promise<{ videos: MergeVideoItem[]; freeBytes: number }>
      executeMerge: (
        root: string,
        items: MergeVideoItem[],
        outputName: string
      ) => Promise<MergeResult>
      deleteMergeSources: (
        root: string,
        items: MergeSourceItem[]
      ) => Promise<{
        cancelled: boolean
        deletedCount: number
        failed: { target: string; error: string }[]
      }>
      cancelMerge: () => Promise<void>
      scanDuplicates: (root: string, includeSimilar?: boolean) => Promise<DedupeScanResult>
      deleteDuplicates: (
        root: string,
        relativePaths: string[]
      ) => Promise<{
        cancelled: boolean
        deletedCount: number
        failed: { target: string; error: string }[]
      }>
      cancelDedupeDelete: () => Promise<void>
      scanComics: (root: string) => Promise<ComicScanResult>
      mergeComics: (
        root: string,
        relDirs: string[],
        format: ComicFormat,
        options?: { raw?: boolean; rebuild?: boolean }
      ) => Promise<ComicMergeReport>
      cancelComicMerge: () => Promise<void>
      renameComics: (
        root: string,
        items: Array<{ relDir: string; newName: string }>
      ) => Promise<{
        taskId: string
        cancelled: boolean
        renamedCount: number
        items: Array<{ from: string; to: string }>
        failed: Array<{ target: string; error: string }>
      }>
      cancelComicRename: () => Promise<void>
      deleteComicSources: (
        root: string,
        relDirs: string[]
      ) => Promise<{
        cancelled: boolean
        deletedCount: number
        failed: { target: string; error: string }[]
      }>
      getStorageStats: () => Promise<StorageStats>
      cleanStorage: (category: StorageCategory) => Promise<StorageCleanResult>
      checkUpdates: () => Promise<UpdateStatus>
      downloadUpdate: () => Promise<void>
      installUpdate: () => Promise<void>
      getUpdateStatus: () => Promise<UpdateStatus>
      getAppVersion: () => Promise<string>
      onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
      getSettings: () => Promise<AppSettings>
      updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
      listOpLogs: () => Promise<
        {
          file: string
          module: string
          finishedAt: string
          summary: string
          undone: boolean
          undoable: boolean
        }[]
      >
      revealOpLog: (file: string) => Promise<void>
      undoOpLog: (file: string) => Promise<UndoReport>
      onTaskEvent: (callback: (event: TaskEvent) => void) => () => void
    }
  }
}

export {}
