declare module './ai.mjs' {
  import type { AiFileInput } from '../../../shared/types'

  export const AI_BATCH_SIZE: number
  export function chatCompletionsUrl(baseUrl: string): string
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
    baseUrl: string
    token: string
    model: string
    template: string
    files: AiFileInput[]
    fetchImpl?: typeof fetch
    /** 每批完成回调：已完成数量 */
    onBatch?: (done: number) => void
  }): Promise<string[]>
}
