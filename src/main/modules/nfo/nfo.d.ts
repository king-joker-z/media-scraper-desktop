declare module './nfo.mjs' {
  import type { NfoPlan, NfoPlanItem, NfoReport } from '../../../shared/types'
  import type { TaskCenter } from '../../core/task-center.mjs'

  export function escapeXml(value: unknown): string
  export function renderNfoXml(input: {
    title: string
    posterName: string | null
    actorName: string
  }): string
  export function createNfoPlan(root: string): Promise<NfoPlan>
  export function executeNfoPlan(
    root: string,
    items: NfoPlanItem[],
    actorName: string,
    options: { taskCenter: TaskCenter; taskId: string; concurrency?: number }
  ): Promise<NfoReport>
}
