declare module './settings.mjs' {
  import type { AppSettings } from '../../shared/types'

  export const DEFAULT_PROMPT_TEMPLATE: string
  export const DEFAULT_SETTINGS: AppSettings
  export function normalizeSettings(raw: unknown): AppSettings

  export class SettingsStore {
    constructor(filePath: string)
    load(): Promise<AppSettings>
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
  }

  export function createSettingsStore(filePath: string): SettingsStore
}
