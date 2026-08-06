declare module './ai.mjs' {
  import type { AiFileInput } from '../../../shared/types'

  export const OPENROUTER_URL: string
  export const AI_BATCH_SIZE: number
  export function buildPrompt(
    template: string,
    vars: { parentFolder: string; fileName: string; extension: string }
  ): string
  export function extractJsonArray(content: unknown): unknown[]
  export function buildAiMessages(
    template: string,
    files: AiFileInput[]
  ): { role: string; content: string }[]
  export function requestAiNames(options: {
    token: string
    model: string
    template: string
    files: AiFileInput[]
    fetchImpl?: typeof fetch
  }): Promise<string[]>
}
