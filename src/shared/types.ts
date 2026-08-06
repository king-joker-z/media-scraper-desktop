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
  /**
   * 计划中的最终文件名：保留的 poster 统一标准化为 <视频基名>-poster.jpg，
   * 预览与执行都以此为准（执行时仍有重名 (n) 兼底）。
   */
  finalName?: string
}

export interface DeleteItem extends FileRecord {
  reason?: string
}

export interface MoveItem {
  from: string
  /** 上移后的目标文件名（含重名 (n) 预测） */
  to: string
  /** 预测会因重名被追加 (n) 后缀 */
  renamed?: boolean
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

export type PlanRisk = 'normal' | 'danger'

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
  /** 删除候选总体积（字节） */
  deleteBytes: number
  /** 危险场景（删除数>50、体积>1GB、无视频）需确认词二次确认 */
  risk: PlanRisk
}

/* ---------------------------- 模块一：清理 ---------------------------- */

/** pendingPick 的人工选择结果：视频 relativePath -> 选中图片 relativePath */
export type PosterPicks = Record<string, string>

export interface CleanReport {
  taskId: string
  cancelled: boolean
  deletedCount: number
  deletedBytes: number
  converted: { from: string; to: string }[]
  renamed: { from: string; to: string }[]
  moved: { from: string; to: string }[]
  removedDirs: string[]
  failed: { target: string; error: string }[]
  durationMs: number
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
