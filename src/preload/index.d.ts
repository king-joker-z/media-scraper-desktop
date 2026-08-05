import { ElectronAPI } from '@electron-toolkit/preload'
import type { AppSettings, ScanPlan, TaskEvent } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      selectWorkspace: () => Promise<string | null>
      scanPlan: (root: string) => Promise<ScanPlan>
      getSettings: () => Promise<AppSettings>
      updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
      onTaskEvent: (callback: (event: TaskEvent) => void) => () => void
    }
  }
}

export {}
