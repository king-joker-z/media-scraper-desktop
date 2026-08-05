/**
 * 跨进程共享类型：main / preload / renderer 三端唯一的类型来源。
 * 本文件只允许存放类型声明（编译后擦除），不要放运行时代码。
 */

export type FileKind = 'video' | 'image' | 'other'

export interface FileRecord {
  /** 绝对路径 */
  path: string
  /** 相对工作区根的路径（平台分隔符） */
  relativePath: string
  /** 相对工作区根的所在目录，根目录为 '.' */
  dir: string
  name: string
  kind: FileKind
  size: number
}

export interface KeepItem extends FileRecord {
  /** 作为 poster 时指向对应视频的 relativePath */
  posterFor?: string
}

export interface DeleteItem extends FileRecord {
  reason?: string
}

export interface MoveItem {
  from: string
  to: string
}

export type ScanConflict =
  | { type: 'image-multi-video'; image: string; videos: string[] }
  | { type: 'video-multi-image'; video: string; images: string[] }

export interface PendingPick {
  /** 需要人工选择 poster 的视频 relativePath */
  video: string
  /** 候选图片 relativePath 列表 */
  candidates: string[]
}

export interface ScanSummary {
  videos: number
  images: number
  otherFiles: number
  keep: number
  permanentDelete: number
  pendingPick: number
  hiddenSkipped: number
  conflicts: number
}

export interface ScanPlan {
  root: string
  keep: KeepItem[]
  deleteItems: DeleteItem[]
  /** 一视频多图且无法自动裁决时的待选清单（不进入 keep/delete） */
  pendingPick: PendingPick[]
  moves: MoveItem[]
  conflicts: ScanConflict[]
  skippedHidden: string[]
  summary: ScanSummary
}

/* ------------------------------ 设置 ------------------------------ */

export interface RegexTemplate {
  name: string
  pattern: string
  replacement: string
  flags: string
}

export interface OpenRouterSettings {
  token: string
  models: string[]
  selectedModel: string
}

export interface AppSettings {
  /** 全局并发线程数，1-20，默认 5（视频合并除外） */
  concurrency: number
  openRouter: OpenRouterSettings
  /** AI 重命名 prompt 模板，支持 {{parentFolder}} {{fileName}} {{extension}} */
  promptTemplate: string
  regexTemplates: RegexTemplate[]
}

/* ---------------------------- 任务中心 ---------------------------- */

export type TaskEventType = 'start' | 'progress' | 'item-done' | 'item-error' | 'done' | 'cancelled'

export interface TaskEvent {
  type: TaskEventType
  taskId: string
  label: string
  total: number
  completed: number
  failed: number
  /** 当前处理项的可读描述 */
  current?: string
  error?: string
  at: number
}

/* ---------------------------- 媒体探测 ---------------------------- */

export type Orientation = 'landscape' | 'portrait'

export interface MediaInfo {
  container: string
  durationMs: number
  sizeBytes: number
  width: number
  height: number
  orientation: Orientation
  videoCodec: string | null
  audioCodec: string | null
  fps: number
}
