import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AiConnectionTestResult,
  AiFileInput,
  AppModule,
  AppSettings,
  CaptureOutcome,
  CleanReport,
  ComicFormat,
  ComicMergeReport,
  ComicScanResult,
  DedupeScanResult,
  GpuCapability,
  MergeResult,
  MergeSourceItem,
  MergeVideoItem,
  NfoPlan,
  NfoPlanItem,
  NfoReport,
  OpLogDetail,
  OpLogSummary,
  PerformanceDiagnostics,
  PosterBatchSaveReport,
  PosterCaptureOptions,
  PosterPicks,
  PosterSaveResult,
  PosterVideoItem,
  ProbeContainerItem,
  RenamePairInput,
  RenamePreflightItem,
  RenameReport,
  ScanPlan,
  StorageCategory,
  StorageCleanResult,
  StorageStats,
  TaskEvent,
  UndoPreflight,
  UndoReport,
  UpdateStatus
} from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      selectWorkspace: (module?: AppModule) => Promise<string | null>
      useWorkspace: (path: string, module?: AppModule) => Promise<string>
      openPath: (target: string) => Promise<void>
      revealPath: (target: string) => Promise<void>
      pathForFile: (file: File) => string
      scanPlan: (root: string) => Promise<ScanPlan>
      getWorkspaceFingerprint: (root: string) => Promise<string>
      executeClean: (plan: ScanPlan, picks: PosterPicks) => Promise<CleanReport>
      /** 仅将可见文件上移到工作区根，不删除、转码或改名 poster。 */
      dissolveFolders: (plan: ScanPlan) => Promise<CleanReport>
      cancelClean: () => Promise<void>
      listPosterVideos: (root: string) => Promise<PosterVideoItem[]>
      capturePosters: (
        root: string,
        relativePaths: string[],
        options?: PosterCaptureOptions
      ) => Promise<{ cancelled: boolean; outcomes: CaptureOutcome[] }>
      capturePosterAt: (videoPath: string, seconds: number) => Promise<string>
      savePoster: (payload: {
        videoPath: string
        chosenFramePath: string
        oldPosterPath: string | null
      }) => Promise<PosterSaveResult>
      savePostersBatch: (
        videos: PosterVideoItem[],
        selections: Record<string, string>
      ) => Promise<PosterBatchSaveReport>
      cancelPosterCapture: () => Promise<void>
      probeContainers: (root: string, relativePaths: string[]) => Promise<ProbeContainerItem[]>
      requestAiNames: (files: AiFileInput[], forceRefresh?: boolean) => Promise<string[]>
      /** 对当前设置中指定的平台和单一模型执行最小请求连通性测试。 */
      testAiConnection: (providerId: string, model: string) => Promise<AiConnectionTestResult>
      preflightRename: (root: string, pairs: RenamePairInput[]) => Promise<RenamePreflightItem[]>
      executeRename: (root: string, pairs: RenamePairInput[]) => Promise<RenameReport>
      cancelRename: () => Promise<void>
      createNfoPlan: (root: string) => Promise<NfoPlan>
      executeNfoArchive: (
        root: string,
        items: NfoPlanItem[],
        actorName: string
      ) => Promise<NfoReport>
      cancelNfo: () => Promise<void>
      scanMergeVideos: (root: string) => Promise<{ videos: MergeVideoItem[]; freeBytes: number }>
      executeMerge: (
        root: string,
        items: MergeVideoItem[],
        outputName: string
      ) => Promise<MergeResult>
      getGpuCapability: () => Promise<GpuCapability>
      /** 本机 GPU 状态快照，仅在设置页用户主动查看时读取。 */
      getPerformanceDiagnostics: () => Promise<PerformanceDiagnostics>
      deleteMergeSources: (
        root: string,
        items: MergeSourceItem[]
      ) => Promise<{
        cancelled: boolean
        deletedCount: number
        failed: { target: string; error: string }[]
      }>
      cancelMerge: () => Promise<void>
      scanDuplicates: (root: string, includeSimilar?: boolean) => Promise<DedupeScanResult>
      deleteDuplicates: (
        root: string,
        relativePaths: string[]
      ) => Promise<{
        cancelled: boolean
        deletedCount: number
        failed: { target: string; error: string }[]
      }>
      cancelDedupeDelete: () => Promise<void>
      scanComics: (root: string, options?: { light?: boolean }) => Promise<ComicScanResult>
      mergeComics: (
        root: string,
        relDirs: string[],
        format: ComicFormat,
        options?: { raw?: boolean; rebuild?: boolean }
      ) => Promise<ComicMergeReport>
      cancelComicMerge: () => Promise<void>
      renameComics: (
        root: string,
        items: Array<{ relDir: string; newName: string }>
      ) => Promise<{
        taskId: string
        cancelled: boolean
        renamedCount: number
        items: Array<{ from: string; to: string }>
        failed: Array<{ target: string; error: string }>
      }>
      cancelComicRename: () => Promise<void>
      deleteComicSources: (
        root: string,
        relDirs: string[]
      ) => Promise<{
        cancelled: boolean
        deletedCount: number
        failed: { target: string; error: string }[]
      }>
      getStorageStats: () => Promise<StorageStats>
      cleanStorage: (category: StorageCategory) => Promise<StorageCleanResult>
      checkUpdates: () => Promise<UpdateStatus>
      downloadUpdate: () => Promise<void>
      installUpdate: () => Promise<void>
      getUpdateStatus: () => Promise<UpdateStatus>
      getAppVersion: () => Promise<string>
      onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
      getSettings: () => Promise<AppSettings>
      /** 选择并预检一个可写的合并临时目录；不会自动保存设置。 */
      selectMergeTempDirectory: () => Promise<string | null>
      /** 设置变更时推送最新归一化配置，常驻页面用于同步展示状态。 */
      onSettingsChange: (callback: (settings: AppSettings) => void) => () => void
      /** 打开系统对话框并导入背景图到应用私有目录 */
      selectBackgroundImage: () => Promise<string | null>
      /** 清除当前背景图，同时删除应用私有副本 */
      clearBackgroundImage: () => Promise<AppSettings>
      updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
      listOpLogs: () => Promise<OpLogSummary[]>
      getOpLogDetail: (file: string) => Promise<OpLogDetail>
      preflightUndoOpLog: (file: string) => Promise<UndoPreflight>
      revealOpLog: (file: string) => Promise<void>
      undoOpLog: (file: string) => Promise<UndoReport>
      /** 操作日志成功写入或原日志更新后通知常驻时间线刷新。 */
      onOpLogsChange: (callback: () => void) => () => void
      /** 请求取消仍在执行且允许取消的任务；返回 false 表示该任务已结束或不可取消。 */
      cancelTask: (taskId: string) => Promise<boolean>
      onTaskEvent: (callback: (event: TaskEvent) => void) => () => void
    }
  }
}

export {}
