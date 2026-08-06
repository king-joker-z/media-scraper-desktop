import { ElectronAPI } from '@electron-toolkit/preload'
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
      getSettings: () => Promise<AppSettings>
      updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
      onTaskEvent: (callback: (event: TaskEvent) => void) => () => void
    }
  }
}

export {}
