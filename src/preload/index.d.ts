import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AiFileInput,
  AppSettings,
  CaptureOutcome,
  CleanReport,
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
  UpdateStatus
} from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      selectWorkspace: () => Promise<string | null>
      useWorkspace: (path: string) => Promise<string>
      pathForFile: (file: File) => string
      scanPlan: (root: string) => Promise<ScanPlan>
      getWorkspaceFingerprint: (root: string) => Promise<string>
      executeClean: (plan: ScanPlan, picks: PosterPicks) => Promise<CleanReport>
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
      requestAiNames: (files: AiFileInput[]) => Promise<string[]>
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
      scanDuplicates: (root: string) => Promise<DedupeScanResult>
      deleteDuplicates: (
        root: string,
        relativePaths: string[]
      ) => Promise<{
        cancelled: boolean
        deletedCount: number
        failed: { target: string; error: string }[]
      }>
      scanHealth: (root: string) => Promise<HealthReport>
      cancelHealth: () => Promise<void>
      executePipeline: (root: string, steps: PipelineStep[]) => Promise<PipelineReport>
      cancelPipeline: () => Promise<void>
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
        { file: string; module: string; finishedAt: string; summary: string }[]
      >
      revealOpLog: (file: string) => Promise<void>
      onTaskEvent: (callback: (event: TaskEvent) => void) => () => void
    }
  }
}

export {}
