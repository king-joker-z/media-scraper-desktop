import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AppSettings,
  CaptureOutcome,
  CleanReport,
  PosterPicks,
  PosterSaveResult,
  PosterVideoItem,
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
      cancelPosterCapture: () => Promise<void>
      getSettings: () => Promise<AppSettings>
      updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
      onTaskEvent: (callback: (event: TaskEvent) => void) => () => void
    }
  }
}

export {}
