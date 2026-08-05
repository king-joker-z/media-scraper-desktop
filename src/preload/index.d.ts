import { ElectronAPI } from '@electron-toolkit/preload'

type ScanPlan = {
  root: string
  keep: { relativePath: string; kind: string; posterFor?: string }[]
  deleteItems: { relativePath: string; kind: string; reason?: string }[]
  moves: { from: string; to: string }[]
  skippedHidden: string[]
  conflicts: { image: string; videos: string[] }[]
  summary: Record<string, number>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      selectWorkspace: () => Promise<string | null>
      scanPlan: (root: string) => Promise<ScanPlan>
    }
  }
}
