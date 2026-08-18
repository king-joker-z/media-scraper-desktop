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

/** 单个 AI 模型的命名请求调优参数。 */
export interface AiModelTuning {
  /** 每个请求携带的文件数（1–100）。 */
  batchSize: number
  /** 同时向该模型发起的请求数（1–10）。 */
  concurrency: number
  /** 单次请求超时秒数（5–900）。 */
  requestTimeoutSeconds: number
}

/** AI 平台配置（OpenAI 兼容端点）。token 按平台独立保存，切换平台不清除。 */
export interface AiProviderConfig {
  /** 预设：openrouter / deepseek / aicodemirror / linkai / hapi；自定义为 custom-<uuid> */
  id: string
  name: string
  /** OpenAI 兼容 baseUrl，如 https://api.deepseek.com */
  baseUrl: string
  token: string
  models: string[]
  selectedModel: string
  /** 按模型 ID 保存的请求调优；未配置的模型使用默认值。 */
  modelTunings: Record<string, AiModelTuning>
  /** DeepSeek 与 LinkAI Direct 思考模式；仅支持的预设读取，默认关闭以缩短轻量命名请求耗时。 */
  thinkingEnabled: boolean
}

/** 界面主题：跟随系统 / 浅色 / 深色 */
export type ThemeMode = 'system' | 'light' | 'dark'

/** 媒体库浏览密度：舒展 / 标准 / 紧凑 */
export type LibraryDensity = 'comfortable' | 'standard' | 'compact'

/** 强调色方案：仅改变品牌色与交互强调，不改变内容层级 */
export type BackgroundFit = 'cover' | 'contain'

/** 工作区背景材质：图片储存于应用数据目录，仅保存主进程导入后的安全路径。 */
export interface BackgroundAppearance {
  imagePath: string
  /** 背景图可见度，0-100 */
  imageOpacity: number
  /** 背景图模糊半径（px），0-32 */
  blur: number
  /** 内容层遮罩不透明度，0-100；调至 0 可显示无蒙层原图 */
  surfaceOpacity: number
  fit: BackgroundFit
}

export type ThemePalette =
  | 'ocean'
  | 'violet'
  | 'forest'
  | 'sunset'
  | 'graphite'
  | 'berry'
  | 'amber'
  | 'jade'
  | 'sky'
  | 'mint'
  | 'lemon'
  | 'rose'
  | 'comic'
  | 'pixel'
  | 'retro'
  | 'editorial'
  | 'glass'
  | 'y2k'
  | 'doodle'
  | 'aero'
  | 'swiss'
  | 'clay'
  | 'paper'
  | 'industrial'
  | 'nordic'
  | 'mecha'
  | 'nautical'
  | 'ink'
  | 'custom'

export interface AppSettings {
  /** 当前激活的功能模块（null = 启动时显示模块选择页） */
  activeModule: AppModule | null
  /** 漫画模块工作区（与视频工作区相互独立） */
  comicWorkspace: string
  /** 漫画模块最近工作区（最新在前，最多 8 个） */
  comicRecentWorkspaces: string[]
  /** 漫画合并默认输出格式 */
  comicFormat: ComicFormat
  /** 全局并发线程数，1-20，默认 5（视频合并除外） */
  concurrency: number
  /** 扫描子目录并发数，1-16，默认 4（大目录树加速遍历） */
  scanConcurrency: number
  /** FFmpeg/FFprobe 进程池大小，1-8，默认 4（限制同时运行的媒体处理进程数） */
  ffmpegPoolSize: number
  /** 启用 NVIDIA NVENC 视频转码加速（Windows 默认开，macOS 默认关） */
  nvencEnabled: boolean
  /** 尝试 NVDEC/CUDA 缩放补边的完整 GPU 流水线；默认关闭，失败自动降级 */
  cudaPipelineEnabled: boolean
  /** 单次合并最多同时转码的片段数，1–4，默认 1（安全串行） */
  mergeTranscodeConcurrency: number
  /** 合并中间段位置：默认工作区同盘；可选系统临时目录或自定义目录 */
  mergeTempLocation: 'source-disk' | 'system' | 'custom'
  /** 自定义合并临时根目录，仅 mergeTempLocation=custom 时生效 */
  mergeTempCustomPath: string
  /** 界面主题，默认跟随系统 */
  theme: ThemeMode
  /** 界面强调色方案，默认海洋蓝 */
  themePalette: ThemePalette
  /** 自定义强调色（#RRGGBB），仅在 custom 方案下使用 */
  customAccent: string
  /** 工作台背景图片与材质参数 */
  backgroundAppearance: BackgroundAppearance
  /** 媒体库海报墙的显示密度 */
  libraryDensity: LibraryDensity
  aiProviders: AiProviderConfig[]
  activeProviderId: string
  /** AI 重命名 prompt 模板，支持 {{parentFolder}} {{fileName}} */
  promptTemplate: string
  regexTemplates: RegexTemplate[]
  /** 最近使用的工作区（最新在前，最多 8 个） */
  recentWorkspaces: string[]
  /** 删除时优先移入系统回收站（可恢复）；关闭后为永久删除 */
  deleteToTrash: boolean
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

/** 候选封面帧的轻量画面质量评分（0-100 为同一视频内的相对评分） */
export interface CandidateFrameScore {
  path: string
  score: number
  clarity: number
  brightness: number
  contrast: number
  blackRatio: number
  /** 与平均灰度接近的像素占比，用于识别纯黑、纯白及纯色背景 */
  uniformRatio: number
  /** 近乎纯色的过场/标题卡，保留供人工查看但不参与自动推荐 */
  rejected: boolean
}

export interface PosterCaptureOptions {
  /** 精细模式：对两分钟内视频额外进行场景切换检测，速度较慢。 */
  precise?: boolean
}

export interface CaptureOutcome {
  relativePath: string
  /** 已按综合评分从高到低排序的候选帧 */
  frames: string[]
  scores: CandidateFrameScore[]
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
  /** 文件所在的直接父目录名；仅在同目录分组标题中发送一次。 */
  parentFolder: string
  /** 不含扩展名、已去除序号前缀的原始文件名。 */
  fileName: string
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

export interface NfoArchivedItem {
  /** 视频的原始相对路径（撤销恢复依据） */
  videoRel: string
  /** poster 的原始相对路径（无为 null） */
  posterRel: string | null
  /** 目标目录名（相对工作区根） */
  targetDir: string
  /** 视频落位后的文件名 */
  videoName: string
  /** poster 落位后的文件名（无为 null） */
  posterName: string | null
  /** 生成的 NFO 文件名 */
  nfoName: string
}

export interface NfoReport {
  taskId: string
  cancelled: boolean
  archivedCount: number
  /** 归档落位明细（一键撤销依据） */
  archived: NfoArchivedItem[]
  failed: { target: string; error: string }[]
  durationMs: number
}

/** 一键撤销（F2）执行报告 */
export interface UndoReport {
  module: string
  /** 成功回退的条目数 */
  undone: number
  /** 已不存在而跳过的条目数 */
  skipped: number
  failed: { target: string; error: string }[]
}

/* ---------------------------- 任务中心 ---------------------------- */

export type TaskEventType =
  'start' | 'progress' | 'item-done' | 'item-error' | 'done' | 'failed' | 'cancelled'

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

export type MergeMode = 'all' | 'landscape' | 'portrait' | 'separate'

export interface MergeCompatibility {
  compatible: boolean
  /** 不兼容原因（中文可读） */
  reasons: string[]
  /** 转码统一目标参数（取最高分辨率代表片段的分辨率与帧率） */
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

export interface GpuCapability {
  checkedAt: number
  nvenc: { available: boolean; reason?: string }
  cudaPipeline: { available: boolean; reason?: string }
}

export interface MergeGpuSummary {
  requested: boolean
  encoder: 'copy' | 'cpu' | 'nvenc'
  pipeline: 'copy' | 'cpu' | 'nvenc' | 'cuda-nvenc'
  hardwareSegments: number
  fallbackSegments: number
  note: string
}

export interface MergeResult {
  cancelled: boolean
  outputPath: string | null
  verified: boolean
  /** 校验结论描述 */
  verifyNote: string
  transcoded: boolean
  /** 本次视频路径：copy 为无重编码拼接；cpu/nvenc 为统一参数转码 */
  videoEncoder?: 'copy' | 'cpu' | 'nvenc'
  /** 用户开启 NVENC 但能力探测失败时的回退原因；供 UI 明确警示 */
  nvencFallbackReason?: string
  /** 本次实际 GPU/CPU 执行汇总，不能以预检结果代替实际执行情况 */
  gpuSummary?: MergeGpuSummary
  /** 实际使用的中间转码目录，便于定位磁盘占用 */
  tempDirectory?: string
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

/* ------------------------- 自动更新（F7） ------------------------- */

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error'
  /** 可用版本号（state = available/downloaded 时存在） */
  version?: string
  /** 下载进度 0-100（state = downloading） */
  percent?: number
  message?: string
}

/* ------------------------- 漫画模块 ------------------------- */

/** 功能模块：视频工坊 / 漫画书房 */
export type AppModule = 'video' | 'comic'

/** 漫画合并输出格式 */
export type ComicFormat = 'epub' | 'pdf'

/** 漫画章节：子文件夹为一章；漫画目录下的扁平图片归入 relDir 为 '' 的虚拟章节 */
export interface ComicChapter {
  /** 章节名（子文件夹名；扁平图片为 ''） */
  name: string
  /** 相对漫画目录（扁平为 ''） */
  relDir: string
  /** 有序图片（相对漫画目录，自然排序） */
  images: string[]
}

/** 已合并产物清单（存于漫画目录 .comic-merge.json） */
export interface ComicMergedState {
  version: 1
  format: ComicFormat
  /** 输出文件名（相对漫画目录） */
  outputName: string
  /** 输出体积（字节） */
  outputBytes: number
  /** 本应用生成并管理的封面文件名；缺失表示旧版本清单 */
  coverName?: string
  /** 已合并章节快照（用于增量更新检测） */
  chapters: ComicChapter[]
  updatedAt: string
}

/** 一部漫画（工作区一级子文件夹） */
export interface Comic {
  /** 漫画名 = 一级子文件夹名 */
  name: string
  /** 相对工作区根 */
  relDir: string
  chapters: ComicChapter[]
  imageCount: number
  /** 封面图（相对漫画目录；无图时为 null；已删源后为 .comic-cover.jpg） */
  coverRel: string | null
  /** 已合并状态（无则未合并） */
  merged: ComicMergedState | null
  /** 相对清单新增的章节（可增量追加） */
  newChapters: ComicChapter[]
  /** 已合并但内容发生变化的章节名（需全量重建） */
  changedChapters: string[]
}

export interface ComicScanResult {
  comics: Comic[]
  totalImages: number
}

/** 单部漫画合并结果 */
export interface ComicMergeItem {
  relDir: string
  name: string
  mode: 'full' | 'update'
  outputName: string
  chapters: number
  images: number
  /** 产物体积（字节） */
  bytes: number
  /** 本次合并的源图片总体积（字节，删源确认用） */
  sourceBytes: number
}

export interface ComicMergeReport {
  taskId: string | null
  cancelled: boolean
  format: ComicFormat
  merged: ComicMergeItem[]
  failed: { target: string; error: string }[]
  durationMs: number
}
