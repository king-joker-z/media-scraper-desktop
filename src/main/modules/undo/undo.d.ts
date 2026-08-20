declare module './undo.mjs' {
  import type { UndoPreflight, UndoReport } from '../../../shared/types'
  /** 按操作日志一键撤销；改名采用两段式事务，NFO 仅在关联素材完整恢复后删除。 */
  export function undoOpLog(file: string): Promise<UndoReport>
  /** 执行前只读检查：缺失源与原位置冲突均不会阻塞，最终执行仍会重新检查。 */
  export function preflightUndoOpLog(file: string): Promise<UndoPreflight>
}
