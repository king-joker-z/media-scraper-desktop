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

/** 界面主题：跟随系统 / 浅色 / 深色 */
export type ThemeMode = 'system' | 'light' | 'dark'

export interface AppSettings {
  /** 全局并发线程数，1-20，默认 5（视频合并除外） */
  concurrency: number
  /** 扫描子目录并发数，1-16，默认 4（大目录树加速遍历） */
  scanConcurrency: number
  /** FFmpeg/FFprobe 进程池大小，1-8，默认 4（限制同时运行的媒体处理进程数） */
  ffmpegPoolSize: number
  /** 界面主题，默认跟随系统 */
  theme: ThemeMode
  aiProviders: AiProviderConfig[]
  activeProviderId: string
  /** AI 重命名 prompt 模板，支持 {{parentFolder}} {{fileName}} {{extension}} */
  promptTemplate: string
  regexTemplates: RegexTemplate[]
  /** 最近使用的工作区（最新在前，最多 8 个） */
  recentWorkspaces: string[]
  /** 流水线预设列表 */
  pipelinePresets: PipelinePreset[]
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

export type MergeMode = 'all' | 'landscape' | 'portrait'

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

/* ------------------------- 视频去重（F5） ------------------------- */

export interface DupItem {
  relativePath: string
  name: string
  dir: string
  size: number
  media: MediaInfo | null
}

/** 完全重复组：同大小 + 同内容指纹 */
export interface DupGroup {
  hash: string
  sizeBytes: number
  /** 建议保留项（质量最高） */
  keepRel: string
  items: DupItem[]
}

export interface SimilarDupItem extends DupItem {
  /** 同指纹完全重复副本数（含自身） */
  exactCopies: number
}

/** 相似重复组：同分辨率 + 时长相近，但内容指纹不同（同片不同压制） */
export interface SimilarDupGroup {
  key: string
  keepRel: string
  items: SimilarDupItem[]
}

export interface DedupeScanResult {
  exact: DupGroup[]
  similar: SimilarDupGroup[]
}

/* ------------------------- 完整性体检（F3） ------------------------- */

export interface HealthCorruptItem {
  relativePath: string
  error: string
}

export interface HealthReport {
  taskId: string | null
  cancelled: boolean
  /** 工作区视频总数 */
  total: number
  /** 已完成解码校验的数量（取消时 < total） */
  checked: number
  corrupted: HealthCorruptItem[]
  /** 缺 poster 的视频 relativePath */
  missingPoster: string[]
  /** 缺同名 .nfo 的视频 relativePath */
  missingNfo: string[]
  totalBytes: number
  /** 体积最大的前 10 个视频 */
  largest: { relativePath: string; size: number }[]
  durationMs: number
}

/* ------------------------- 存储管理（S4） ------------------------- */

export type StorageCategory = 'frames' | 'merge-temp' | 'op-logs'

export interface StorageStats {
  /** 截帧临时目录占用字节 */
  framesBytes: number
  /** 合并断点续传工作目录占用字节 */
  mergeTempBytes: number
  /** 操作日志目录占用字节 */
  opLogBytes: number
  /** 操作日志份数 */
  opLogCount: number
}

export interface StorageCleanResult {
  category: StorageCategory
  freedBytes: number
}

/* ------------------------- 自动化流水线 ------------------------- */

/** 流水线可编排的模块类型 */
export type PipelineModuleId = 'clean' | 'nfo' | 'dedupe' | 'health'

/** 流水线步骤：一个模块实例 + 可选参数 */
export interface PipelineStep {
  /** 唯一 ID（用于 dnd-kit 排序 key） */
  id: string
  /** 模块类型 */
  module: PipelineModuleId
  /** 是否启用（关闭的步骤执行时跳过） */
  enabled: boolean
}

/** 流水线预设 */
export interface PipelinePreset {
  /** 唯一 ID */
  id: string
  /** 预设名称 */
  name: string
  /** 有序步骤列表 */
  steps: PipelineStep[]
}

/** 单个步骤的执行结果 */
export interface PipelineStepResult {
  module: PipelineModuleId
  success: boolean
  /** 耗时（毫秒） */
  durationMs: number
  /** 步骤产出的摘要文本 */
  summary: string
  /** 错误信息（失败时） */
  error?: string
}

/** 流水线执行报告 */
export interface PipelineReport {
  cancelled: boolean
  results: PipelineStepResult[]
  totalDurationMs: number
}

/* ------------------------- 自动更新（F7） ------------------------- */

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error'
  /** 可用版本号（state = available/downloaded 时存在） */
  version?: string
  /** 下载进度 0-100（state = downloading） */
  percent?: number
  message?: string
}
