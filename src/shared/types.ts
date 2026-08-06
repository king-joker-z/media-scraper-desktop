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

/** AI 平台配置（OpenAI 兼容端点）。token 按平台独立保存，切换平台不清除。 */
export interface AiProviderConfig {
  /** 预设：openrouter / deepseek / aicodemirror；自定义为 custom-<timestamp> */
  id: string
  name: string
  /** OpenAI 兼容 baseUrl，如 https://api.deepseek.com */
  baseUrl: string
  token: string
  models: string[]
  selectedModel: string
}

export interface AppSettings {
  /** 全局并发线程数，1-20，默认 5（视频合并除外） */
  concurrency: number
  aiProviders: AiProviderConfig[]
  activeProviderId: string
  /** AI 重命名 prompt 模板，支持 {{parentFolder}} {{fileName}} {{extension}} */
  promptTemplate: string
  regexTemplates: RegexTemplate[]
}

/* ------------------------- 模块四：封面管理 ------------------------- */

export interface PosterVideoItem {
  path: string
  relativePath: string
  name: string
  size: number
  /** 现存 poster 绝对路径（无则为 null） */
  posterPath: string | null
  posterRelativePath: string | null
}

export interface CaptureOutcome {
  relativePath: string
  frames: string[]
  error?: string
}

export interface PosterSaveResult {
  saved: string
  deletedOld: string[]
}

export interface PosterBatchSaveOutcome {
  relativePath: string
  saved?: string
  error?: string
}

export interface PosterBatchSaveReport {
  cancelled: boolean
  savedCount: number
  failedCount: number
  outcomes: PosterBatchSaveOutcome[]
}

/* ------------------------- 模块三：批量重命名 ------------------------- */

export interface RenamePairInput {
  videoRel: string
  posterRel: string | null
  newStem: string
  /** 仅改扩展名模式：强制目标扩展名（如 .mp4），不改变词干 */
  newExt?: string
}

export interface RenameReport {
  taskId: string
  cancelled: boolean
  renamedCount: number
  items: { from: string; to: string }[]
  failed: { target: string; error: string }[]
  durationMs: number
}

export interface ProbeContainerItem {
  relativePath: string
  container: string
  isMp4: boolean
  error?: string
}

export interface AiFileInput {
  parentFolder: string
  fileName: string
  extension: string
}

/* ------------------------- 模块五：NFO 归档 ------------------------- */

export interface NfoPlanItem {
  videoRel: string
  stem: string
  posterRel: string | null
  /** 目标目录名（相对工作区根） */
  targetDir: string
  /** 目标目录已存在且非空 */
  conflict: boolean
}

export interface NfoPlan {
  root: string
  items: NfoPlanItem[]
  actorDefault: string
}

export interface NfoReport {
  taskId: string
  cancelled: boolean
  archivedCount: number
  failed: { target: string; error: string }[]
  durationMs: number
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
  /** 视频像素格式（如 yuv420p），无视频流时为 null */
  pixFmt: string | null
  /** 音频采样率 Hz */
  sampleRate: number | null
  /** 音频声道数 */
  channels: number | null
}

/* ------------------------- 模块二：视频合并 ------------------------- */

export interface MergeVideoItem extends PosterVideoItem {
  media: MediaInfo | null
}

export type MergeMode = 'all' | 'landscape' | 'portrait' | 'custom'

export interface MergeCompatibility {
  compatible: boolean
  /** 不兼容原因（中文可读） */
  reasons: string[]
  /** 转码统一目标参数（取首个片段） */
  target: {
    width: number
    height: number
    fps: number
    pixFmt: string
  } | null
}

export interface MergePlanInfo {
  outputName: string
  totalBytes: number
  totalDurationMs: number
  estimatedBytes: number
  freeBytes: number
  compatibility: MergeCompatibility
}

export interface MergeResult {
  cancelled: boolean
  outputPath: string | null
  verified: boolean
  /** 校验结论描述 */
  verifyNote: string
  transcoded: boolean
  error?: string
}

export interface MergeSourceItem {
  videoRel: string
  posterRel: string | null
}
