import { ElectronAPI } from '@electron-toolkit/preload'
import type { AppSettings, CleanReport, PosterPicks, ScanPlan, TaskEvent } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      selectWorkspace: () => Promise<string | null>
      scanPlan: (root: string) => Promise<ScanPlan>
      executeClean: (plan: ScanPlan, picks: PosterPicks) => Promise<CleanReport>
      cancelClean: () => Promise<void>
      getSettings: () => Promise<AppSettings>
      updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
      onTaskEvent: (callback: (event: TaskEvent) => void) => () => void
    }
  }
}

export {}
