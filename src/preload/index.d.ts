import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AiFileInput,
  AppSettings,
  CaptureOutcome,
  CleanReport,
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
  TaskEvent
} from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      selectWorkspace: () => Promise<string | null>
      scanPlan: (root: string) => Promise<ScanPlan>
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
      scanDuplicates: (root: string) => Promise<
        {
          hash: string
          sizeBytes: number
          items: { relativePath: string; name: string; dir: string; size: number }[]
        }[]
      >
      deleteDuplicates: (
        root: string,
        relativePaths: string[]
      ) => Promise<{
        cancelled: boolean
        deletedCount: number
        failed: { target: string; error: string }[]
      }>
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
