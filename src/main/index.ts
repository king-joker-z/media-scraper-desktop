import {
  app,
  shell,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  Notification,
  protocol
} from 'electron'
import { basename, dirname, extname, join } from 'path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import icon from '../../resources/icon.png?asset'
import { computeFingerprint, createScanPlan, IMAGE_EXTENSIONS } from './core/scanner.mjs'
import { activeProvider, createSettingsStore, pushRecentWorkspace } from './core/settings.mjs'
import { createTaskCenter } from './core/task-center.mjs'
import { resolveFfmpegPath } from './core/frames.mjs'
import { probeMediaCached, resolveFfprobePath } from './core/probe.mjs'
import { executeCleanPlan, executeDissolveFolders } from './modules/clean/execute.mjs'
import { executeRename, recoverRenameJournal } from './modules/rename/execute.mjs'
import { requestAiNames, testAiConnection } from './modules/rename/ai.mjs'
import { createNfoPlan, executeNfoPlan } from './modules/nfo/nfo.mjs'
import { deleteMergeSources, mergeVideos } from './modules/merge/merge.mjs'
import { findDuplicates } from './modules/dedupe/dedupe.mjs'
import { preflightUndoOpLog, undoOpLog } from './modules/undo/undo.mjs'
import { scanComicWorkspace } from './modules/comic/scan.mjs'
import { deleteComicSources, mergeComics } from './modules/comic/merge.mjs'
import { renameComicDirectories } from './modules/comic/rename.mjs'
import {
  cleanMovePartials,
  createFileReadStream,
  ensureDir,
  ensureWritableDirectory,
  deleteToTrash,
  dirSizeBytes,
  diskFreeBytes,
  fileMtimeMs,
  fileSize,
  isDirectory,
  listDirNames,
  pathExists,
  permanentDelete,
  recoverStagedOutputs,
  readBinaryFile,
  writeBinaryFile,
  setTrashImpl,
  isStagedOutputName
} from './core/fs-ops.mjs'
import { collectFailures } from './core/task-report.mjs'
import { killAllActiveProcesses, activeProcessCount } from './core/process-registry.mjs'
import { setPoolSize } from './core/ffmpeg-pool.mjs'
import { getOpLogDetail, listOpLogs, writeOpLog } from './core/op-log.mjs'
import { isMediaPathAllowed, mediaUrlPathToLocal } from './core/media-path.mjs'
import { assertRegisteredRoot, assertSafeFileName, resolveInsideRoot } from './core/path-guard.mjs'
import { isMergeOutputName } from '../shared/merge-rules.mjs'
import { isAllowedMainFrameNavigation } from '../shared/navigation-rules.mjs'
import { probeGpuCapability } from './core/nvenc.mjs'
import {
  captureAt,
  captureCandidates,
  computePendingSaves,
  listPosterVideos,
  savePoster
} from './modules/poster/poster.mjs'
import type {
  AiFileInput,
  AppModule,
  AppSettings,
  ComicScanResult,
  ComicFormat,
  ComicPdfQuality,
  MergeSourceItem,
  MergeVideoItem,
  NfoPlanItem,
  PerformanceDiagnostics,
  PosterPicks,
  PosterVideoItem,
  RenamePairInput,
  RenamePreflightItem,
  ScanPlan,
  StorageCategory,
  StorageStats,
  TaskEvent,
  UpdateStatus
} from '../shared/types'

const settingsStore = createSettingsStore(join(app.getPath('userData'), 'settings.json'))
const framesRoot = join(app.getPath('temp'), 'media-scraper-frames')
const backgroundRoot = join(app.getPath('userData'), 'backgrounds')
const opLogDir = join(app.getPath('userData'), 'op-logs')
/** 重命名崩溃恢复 journal（msd_tmp_* 临时文件续跑依据） */
const renameJournalPath = join(app.getPath('userData'), 'rename-journal.json')
/** 合并断点续传工作目录的统一前缀（merge.mjs mergeWorkDir 约定） */
const MERGE_TEMP_PREFIX = 'msd-merge-'
/** 断点目录老化阈值：超过 7 天未修改视为已放弃续传，启动时自动回收磁盘 */
const MERGE_TEMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** 返回最小化的 GPU 排障快照；仅响应用户在设置页的主动请求，不落盘也不上传。 */
const getPerformanceDiagnostics = async (): Promise<PerformanceDiagnostics> => {
  const gpuFeatureStatus = Object.fromEntries(
    Object.entries(app.getGPUFeatureStatus()).map(([name, status]) => [name, String(status)])
  )
  try {
    const gpuInfo: unknown = await app.getGPUInfo('basic')
    const gpuDevice =
      gpuInfo && typeof gpuInfo === 'object'
        ? (gpuInfo as Record<string, unknown>).gpuDevice
        : undefined
    const rawGpus = Array.isArray(gpuDevice) ? gpuDevice : []
    return {
      collectedAt: Date.now(),
      platform: process.platform,
      gpuFeatureStatus,
      gpus: rawGpus.map((gpu) => {
        const device = gpu && typeof gpu === 'object' ? (gpu as Record<string, unknown>) : {}
        return {
          deviceName: String(device.deviceName ?? ''),
          vendorId: String(device.vendorId ?? ''),
          deviceId: String(device.deviceId ?? ''),
          driverVersion: String(device.driverVersion ?? '')
        }
      })
    }
  } catch {
    return { collectedAt: Date.now(), platform: process.platform, gpuFeatureStatus, gpus: [] }
  }
}

// 回收站删除注入（F1）：用户数据删除默认走系统回收站，可在设置改回永久删除
setTrashImpl((target) => shell.trashItem(target))

/** 按设置取删除实现：回收站优先（可恢复），关闭后永久删除 */
const deleteFnOf = (settings: AppSettings): ((target: string) => Promise<void>) =>
  settings.deleteToTrash ? deleteToTrash : permanentDelete

/** 清空截帧缓存目录，返回释放的字节数 */
const cleanFramesCache = async (): Promise<number> => {
  const freed = await dirSizeBytes(framesRoot)
  await permanentDelete(framesRoot).catch(() => {})
  return freed
}

/** 返回当前设置下受应用管理的合并断点目录，不扫描/删除任意用户自定义目录。 */
const mergeTempRoots = (settings: AppSettings): string[] => {
  if (settings.mergeTempLocation === 'custom' && settings.mergeTempCustomPath) {
    return [settings.mergeTempCustomPath]
  }
  if (settings.mergeTempLocation === 'source-disk') {
    return [
      ...settings.recentWorkspaces,
      join(app.getPath('userData'), 'unreachable-merge-temp')
    ].map((root) => join(root, '.msd-merge-temp'))
  }
  return [tmpdir()]
}

/** 清空应用维护的合并工作目录，严格限制为 msd-merge- 前缀子目录。 */
const cleanMergeTempDirs = async (settings: AppSettings): Promise<number> => {
  const results = await Promise.all(
    mergeTempRoots(settings).map(async (root) => {
      const entries = await listDirNames(root).catch(() => [] as string[])
      return Promise.all(
        entries
          .filter((name) => name.startsWith(MERGE_TEMP_PREFIX))
          .map(async (name) => {
            const target = join(root, name)
            const size = await dirSizeBytes(target)
            await permanentDelete(target).catch(() => {})
            return size
          })
      )
    })
  )
  return results.flat().reduce((sum, size) => sum + size, 0)
}

/**
 * 只清理超过 maxAgeMs 未修改的合并断点目录（崩溃/取消后用户已放弃续传的残留），
 * 近期断点保留以支持断点续传。返回释放的字节数。
 */
const cleanStaleMergeTempDirs = async (
  settings: AppSettings,
  maxAgeMs: number
): Promise<number> => {
  const cutoff = Date.now() - maxAgeMs
  const results = await Promise.all(
    mergeTempRoots(settings).map(async (root) => {
      const entries = await listDirNames(root).catch(() => [] as string[])
      return Promise.all(
        entries
          .filter((name) => name.startsWith(MERGE_TEMP_PREFIX))
          .map(async (name) => {
            const target = join(root, name)
            try {
              const mtimeMs = await fileMtimeMs(target)
              if (mtimeMs > cutoff) return 0
              const size = await dirSizeBytes(target)
              await permanentDelete(target).catch(() => {})
              return size
            } catch {
              return 0
            }
          })
      )
    })
  )
  return results.flat().reduce((sum, size) => sum + size, 0)
}

/** 操作日志成功落盘后广播，常驻设置页可即时刷新。 */
const sendOpLogChange = (): void => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('op-logs:changed')
}
/** 记录一条操作日志（不阻塞主流程） */
const logOp = (module: string, payload: object): void => {
  writeOpLog(opLogDir, module, payload)
    .then(sendOpLogChange)
    .catch(() => {})
}

/**
 * media:// 自定义协议：向渲染进程提供本地图片/视频。
 * 只允许访问「当前工作区」与截帧临时目录（切换工作区时替换旧白名单，不累积），
 * 防止任意文件读取。
 */
let workspaceRoot: string | null = null
const setWorkspaceRoot = (root: string): void => {
  workspaceRoot = root
}
// 漫画模块工作区（与视频工作区并存，media:// 白名单双根）
let comicRoot: string | null = null
const setComicRoot = (root: string): void => {
  comicRoot = root
}

const requireVideoRoot = (root: string): string =>
  assertRegisteredRoot(root, workspaceRoot, '视频工作区')
const requireComicRoot = (root: string): string =>
  assertRegisteredRoot(root, comicRoot, '漫画工作区')
const requireRelPath = (root: string, relativePath: string): string =>
  resolveInsideRoot(root, relativePath)

/**
 * 只读预检：将视频与关联 poster 展开为真实目标路径，区分批内重复、
 * 本批会释放的交换目标以及外部占用。执行阶段仍以 fs-ops 的安全改名为最终准则。
 */
const buildRenamePreflight = async (
  root: string,
  pairs: RenamePairInput[]
): Promise<RenamePreflightItem[]> => {
  const sourcePaths = new Set<string>()
  const targets = new Map<string, string[]>()
  const items = pairs.map((pair) => {
    const videoTargetRel = join(
      dirname(pair.videoRel),
      `${pair.newStem}${pair.newExt ?? extname(pair.videoRel)}`
    )
    const posterTargetRel =
      pair.posterRel && !pair.newExt
        ? join(dirname(pair.posterRel), `${pair.newStem}-poster.jpg`)
        : null
    const sourceVideo = requireRelPath(root, pair.videoRel)
    sourcePaths.add(sourceVideo)
    if (pair.posterRel) sourcePaths.add(requireRelPath(root, pair.posterRel))
    const targetVideo = requireRelPath(root, videoTargetRel)
    const targetPoster = posterTargetRel ? requireRelPath(root, posterTargetRel) : null
    for (const target of [targetVideo, targetPoster]) {
      if (!target) continue
      const key = target.normalize('NFC').toLocaleLowerCase('en-US')
      const owners = targets.get(key) ?? []
      owners.push(pair.videoRel)
      targets.set(key, owners)
    }
    return { pair, videoTargetRel, posterTargetRel, targetVideo, targetPoster }
  })

  return Promise.all(
    items.map(async (item) => {
      const targetPaths = [item.targetVideo, item.targetPoster].filter(Boolean) as string[]
      const externalCollisions = await Promise.all(
        targetPaths.map(async (target) => {
          if (sourcePaths.has(target) || !(await pathExists(target))) return null
          return target
        })
      )
      const duplicate = targetPaths.some((target) => {
        const owners = targets.get(target.normalize('NFC').toLocaleLowerCase('en-US')) ?? []
        return owners.length > 1
      })
      return {
        videoRel: item.pair.videoRel,
        targetRel: item.videoTargetRel,
        posterTargetRel: item.posterTargetRel,
        batchDuplicate: duplicate,
        externalCollisions: externalCollisions
          .filter((target): target is string => Boolean(target))
          .map((target) => {
            const relative = target.slice(root.length).replace(/^[\\/]+/, '')
            return relative || basename(target)
          })
      }
    })
  )
}
/** 漫画模型限定工作区一级目录，拒绝章节等嵌套路径。 */
const requireComicDir = (root: string, relDir: string): string => {
  if (relDir === '.' || relDir === '..') throw new Error('漫画目录必须是工作区一级文件夹')
  assertSafeFileName(relDir)
  return resolveInsideRoot(root, relDir)
}
const requireFileInRoots = (filePath: string, roots: string[], label: string): string => {
  if (!isMediaPathAllowed(filePath, roots)) throw new Error(`${label}不在允许范围内`)
  return filePath
}
const requireComicOutput = (target: string): string => {
  const safeTarget = requireFileInRoots(target, comicRoot ? [comicRoot] : [], '漫画产物')
  if (!['.epub', '.pdf'].includes(extname(safeTarget).toLowerCase()))
    throw new Error('只允许打开 EPUB 或 PDF')
  return safeTarget
}

/**
 * 路径归一化（白名单比较用）：统一为正斜杠、去尾部分隔符、盘符统一大写。
 * Windows 上工作区根来自系统对话框（反斜杠），而 media:// URL 解码后是正斜杠，
 * 不归一化会导致白名单全部误判 403（封面/视频全挂）。
 */
const isMediaAllowed = (filePath: string): boolean => {
  const roots = [framesRoot, backgroundRoot]
  if (workspaceRoot) roots.push(workspaceRoot)
  if (comicRoot) roots.push(comicRoot)
  return isMediaPathAllowed(filePath, roots)
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

const sendTaskEvent = (event: TaskEvent): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('tasks:event', event)
  }
}

/** 设置变更后广播完整归一化配置，供常驻页面即时刷新而无需重新挂载。 */
const sendSettingsChange = (settings: AppSettings): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('settings:changed', settings)
  }
}

/**
 * 事件节流：进度类事件高频合并（120ms 刷新一次），终止类事件立即送达，
 * 避免大量文件处理时 IPC 洪峰导致渲染进程卡顿。
 */
const createThrottledEmitter = (
  send: (event: TaskEvent) => void,
  intervalMs = 120
): ((event: TaskEvent) => void) => {
  const pending = new Map<string, TaskEvent>()
  let timer: NodeJS.Timeout | null = null
  const flush = (): void => {
    timer = null
    for (const event of pending.values()) send(event)
    pending.clear()
  }
  return (event) => {
    // 失败事件必须立即送达：若与终态事件一起被节流合并，用户会只看到“结束”而丢失失败原因。
    if (
      event.type === 'start' ||
      event.type === 'item-error' ||
      event.type === 'done' ||
      event.type === 'failed' ||
      event.type === 'cancelled'
    ) {
      if (pending.has(event.taskId)) {
        pending.delete(event.taskId)
      }
      send(event)
      return
    }
    pending.set(event.taskId, event)
    if (!timer) timer = setTimeout(flush, intervalMs)
  }
}

const broadcastTaskEvent = createThrottledEmitter(sendTaskEvent)

// 全局任务中心：统一并发调度，事件实时推送给渲染进程（任务中心抽屉）
export const taskCenter = createTaskCenter({ emit: broadcastTaskEvent })

/* ------------------------- 任务 ID 与互斥槽（Q1/S7） ------------------------- */

// 任务 ID：毫秒时间戳 + 自增序号，同毫秒连发也不碰撞（原先纯 Date.now() 会撞号）
let taskSeq = 0
const newTaskId = (prefix: string): string => `${prefix}-${Date.now()}-${(taskSeq += 1)}`

/** 任务事件快捷发送：补齐默认值，调用方只传差异字段 */
const emitTask = (
  taskId: string,
  label: string,
  patch: Partial<TaskEvent> & { type: TaskEvent['type'] }
): void => {
  broadcastTaskEvent({ total: 0, completed: 0, failed: 0, at: Date.now(), ...patch, taskId, label })
}

// TaskCenter 型互斥槽：同一模块同时只允许一个执行任务
const taskSlots = new Map<string, string>()
/** 任务 ID 到取消入口的映射；仅暴露白名单任务，防止 renderer 直接操作任意主进程任务。 */
const taskCancels = new Map<string, () => void>()
// 仅主进程保留扫描快照；不接受渲染端传回的章节数据，避免 IPC 伪造或遗漏页面。
const comicScanSnapshots = new Map<string, ComicScanResult>()
// AI 命名是网络任务，不经过 TaskCenter worker；单独保存 controller 以响应同一个“取消重命名”入口。
const aiTaskControllers = new Map<string, AbortController>()

/** 以互斥方式运行一个 TaskCenter 任务：占槽 → 执行 → 释放；取消经 cancelSlot 传播 */
async function runExclusive<T>(
  slot: string,
  label: string,
  fn: (taskId: string) => Promise<T>
): Promise<T> {
  if (taskSlots.has(slot)) throw new Error(`已有${label}任务在执行中`)
  const taskId = newTaskId(slot)
  taskSlots.set(slot, taskId)
  registerTaskCancel(taskId, () => cancelSlot(slot))
  try {
    return await fn(taskId)
  } finally {
    taskCancels.delete(taskId)
    taskSlots.delete(slot)
  }
}

const cancelSlot = (slot: string): void => {
  const taskId = taskSlots.get(slot)
  if (taskId) taskCenter.cancel(taskId)
}

// AbortController 型互斥槽（合并/流水线不走 TaskCenter 的取消协议）
const abortSlots = new Map<string, AbortController>()
/** 只读扫描不占独占操作槽，但工作区切换与退出时必须可统一中止。 */
const scanControllers = new Set<AbortController>()

async function runExclusiveAbort<T>(
  slot: string,
  label: string,
  fn: (signal: AbortSignal, taskId: string) => Promise<T>
): Promise<T> {
  if (abortSlots.has(slot)) throw new Error(`已有${label}任务在执行中`)
  const controller = new AbortController()
  const taskId = newTaskId(slot)
  abortSlots.set(slot, controller)
  registerTaskCancel(taskId, () => abortSlot(slot))
  try {
    return await fn(controller.signal, taskId)
  } finally {
    taskCancels.delete(taskId)
    abortSlots.delete(slot)
  }
}

const abortSlot = (slot: string): void => {
  abortSlots.get(slot)?.abort()
}

const registerTaskCancel = (taskId: string, cancel: () => void): void => {
  taskCancels.set(taskId, cancel)
}

const cancelTask = (taskId: string): boolean => {
  const cancel = taskCancels.get(taskId)
  if (!cancel) return false
  cancel()
  return true
}

/**
 * 慢扫描进度上报：400ms 内完成的扫描不打扰（小目录无感）；
 * 大目录扫描期间经全局进度条展示「已发现 N 个文件」。
 */
async function trackScan<T>(
  label: string,
  fn: (signal: AbortSignal, onProgress: (scanned: number) => void) => Promise<T>
): Promise<T> {
  const taskId = newTaskId('scan')
  const controller = new AbortController()
  scanControllers.add(controller)
  const emit = (type: TaskEvent['type'], current?: string): void =>
    emitTask(taskId, label, { type, current })
  let started = false
  let failed = false
  const timer = setTimeout(() => {
    started = true
    emit('start', '扫描目录中…')
  }, 400)
  const onProgress = (scanned: number): void => {
    if (started) emit('progress', `已发现 ${scanned} 个文件`)
  }
  try {
    return await fn(controller.signal, onProgress)
  } catch (error) {
    if (controller.signal.aborted) {
      emit('cancelled', '扫描已取消')
      throw new Error('扫描已取消')
    }
    const message = error instanceof Error ? error.message : String(error)
    // 失败必须带终态，避免进度卡因只收到 item-error 而永久停在“进行中”。
    emitTask(taskId, label, { type: 'item-error', current: '扫描失败', error: message })
    failed = true
    // 即使扫描在 400ms 展示阈值前失败，也要补发终态，防止 item-error 单独生成悬挂卡片。
    emit('failed', '扫描失败')
    throw error
  } finally {
    clearTimeout(timer)
    scanControllers.delete(controller)
    if (started && !failed && !controller.signal.aborted) emit('done')
  }
}

/** 注册工作区：media:// 白名单 + 最近工作区持久化；视频模块附加目录监控重建 */
const registerWorkspace = async (root: string, module: AppModule = 'video'): Promise<void> => {
  // 已发起的扫描读取的是旧工作区快照，切换后没有继续完成的价值，也不能回写新页面。
  for (const controller of scanControllers) controller.abort()
  const settings = await settingsStore.get()
  if (module === 'comic') {
    setComicRoot(root)
    await settingsStore.update({
      comicWorkspace: root,
      comicRecentWorkspaces: pushRecentWorkspace(settings.comicRecentWorkspaces, root)
    })
    return
  }
  setWorkspaceRoot(root)
  await settingsStore.update({
    recentWorkspaces: pushRecentWorkspace(settings.recentWorkspaces, root)
  })
  // 顺手清理上次跨设备移动崩溃残留的 .msd-part 临时件（S3 兜底）
  void cleanMovePartials(root).catch(() => [])
}

/* ------------------------- 自动更新（F7） ------------------------- */

let updateStatus: UpdateStatus = { state: 'idle' }
const sendUpdateStatus = (patch: UpdateStatus): void => {
  updateStatus = { ...updateStatus, ...patch }
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('update:status', updateStatus)
  }
}

let installingUpdate = false

/** 窗口是否处于后台（失焦或最小化），后台时用系统通知打扰用户 */
const isWindowBackground = (): boolean => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return true // 无聚焦窗口 = 最小化或隐藏
  return !win.isFocused() || win.isMinimized()
}

/** 发送系统通知（仅窗口处于后台时），点击通知聚焦窗口 */
const notifyIfBackground = (title: string, body: string): void => {
  if (!isWindowBackground()) return
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body, silent: false })
  notification.on('click', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  notification.show()
}

function setupAutoUpdate(): void {
  // 仅打包后启用（开发环境没有 publish 目标）
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus({ state: 'available', version: info.version })
    notifyIfBackground('发现新版本', `v${info.version} 已可用，点击前往设置下载`)
  })
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ state: 'none' }))
  autoUpdater.on('download-progress', (progress) =>
    sendUpdateStatus({ state: 'downloading', percent: Math.round(progress.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus({ state: 'downloaded', version: info.version })
    notifyIfBackground('更新已就绪', `v${info.version} 已下载完成，点击重启安装`)
  })
  autoUpdater.on('error', (error) => sendUpdateStatus({ state: 'error', message: error.message }))
  // 启动静默检查一次（失败只落状态，不打扰用户）
  autoUpdater.checkForUpdates().catch(() => {})
}

function resolveWindowTheme(theme: AppSettings['theme'] | undefined): 'dark' | 'light' {
  return theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
    ? 'dark'
    : 'light'
}

function syncWindowChrome(window: BrowserWindow, theme: AppSettings['theme'] | undefined): void {
  const resolvedTheme = resolveWindowTheme(theme)
  const isDark = resolvedTheme === 'dark'
  window.setBackgroundColor(isDark ? '#1c1c1e' : '#f5f6f8')
  if (process.platform === 'win32') {
    window.setTitleBarOverlay({
      color: isDark ? '#101828' : '#f4f6fa',
      symbolColor: isDark ? '#f9fafb' : '#182230',
      height: 36
    })
  }
}

function createWindow(theme: AppSettings['theme']): void {
  const resolvedTheme = resolveWindowTheme(theme)
  const mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    // 兼容 Windows 分屏与高 DPI 小尺寸窗口；渲染端在 980px 以下会切换为紧凑布局。
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: resolvedTheme === 'dark' ? '#1c1c1e' : '#f5f6f8',
    title: 'Media Scraper',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
      : process.platform === 'win32'
        ? {
            // Windows 使用系统标题栏按钮；高 DPI 和多显示器缩放由系统原生绘制处理。
            titleBarStyle: 'hidden',
            titleBarOverlay: {
              color: resolvedTheme === 'dark' ? '#101828' : '#f4f6fa',
              symbolColor: resolvedTheme === 'dark' ? '#f9fafb' : '#182230',
              height: 36
            }
          }
        : {}),
    // Windows/Linux 窗口与任务栏图标（PNG 即可；exe 图标由 electron-builder 的 win.icon 注入 .ico）
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 明确锁定隔离边界：渲染端只能使用 contextBridge 暴露的最小 API，不能获得 Node 能力。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url)
      if (url.protocol === 'https:' || url.protocol === 'http:')
        void shell.openExternal(url.toString())
    } catch {
      // 非法 URL 直接拒绝
    }
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  const appEntryUrl =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? process.env['ELECTRON_RENDERER_URL']
      : pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (isAllowedMainFrameNavigation(target, appEntryUrl)) return
    event.preventDefault()
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(appEntryUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('dialog:select-workspace', async (_event, module: AppModule = 'video') => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    const selected = result.canceled ? null : result.filePaths[0]
    if (selected) await registerWorkspace(selected, module)
    return selected
  })
  // 渲染端恢复/拖拽工作区：仅允许可访问的目录注册（media:// 白名单 + 最近列表）。
  ipcMain.handle('workspace:use', async (_event, root: string, module: AppModule = 'video') => {
    if (!(await isDirectory(root))) throw new Error('请选择存在且可读的目录')
    await registerWorkspace(root, module)
    return root
  })
  ipcMain.handle('workspace:scan-plan', async (_event, root: string) => {
    const safeRoot = requireVideoRoot(root)
    const settings = await settingsStore.get()
    return trackScan('扫描工作区', (signal, onProgress) =>
      createScanPlan(safeRoot, { onProgress, concurrency: settings.scanConcurrency, signal })
    )
  })
  // 指纹仅为已登记工作区的只读 UI 刷新提示，不可借由 IPC 遍历任意本地目录。
  ipcMain.handle('workspace:fingerprint', async (_event, root: string) => {
    let safeRoot: string
    try {
      safeRoot = requireVideoRoot(root)
    } catch {
      safeRoot = requireComicRoot(root)
    }
    const settings = await settingsStore.get()
    return trackScan('检查工作区变化', (signal, onProgress) =>
      computeFingerprint(safeRoot, { onProgress, concurrency: settings.scanConcurrency, signal })
    )
  })
  ipcMain.handle('settings:get', async () => settingsStore.get())
  ipcMain.handle('settings:select-merge-temp-directory', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择合并临时目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    await ensureWritableDirectory(result.filePaths[0])
    return result.filePaths[0]
  })
  ipcMain.handle('background:select-image', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择工作台背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null

    const source = result.filePaths[0]
    const extension = extname(source).toLowerCase()
    if (!['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'].includes(extension)) {
      throw new Error('请选择 JPG、PNG、WebP、GIF 或 AVIF 图片')
    }
    const data = await readBinaryFile(source)
    const maxBytes = 15 * 1024 * 1024
    if (data.byteLength > maxBytes) throw new Error('背景图片不能超过 15 MB')

    // 原子写入会先落同目录暂存文件，首次导入前必须确保私有目录已存在。
    await ensureDir(backgroundRoot)
    const target = join(backgroundRoot, `${randomUUID()}${extension}`)
    await writeBinaryFile(target, data)
    const settings = await settingsStore.get()
    const previous = settings.backgroundAppearance.imagePath
    const updated = await settingsStore.update({
      backgroundAppearance: { ...settings.backgroundAppearance, imagePath: target }
    })
    if (previous && isMediaPathAllowed(previous, [backgroundRoot])) {
      await permanentDelete(previous).catch(() => {})
    }
    return updated.backgroundAppearance.imagePath
  })
  ipcMain.handle('background:clear-image', async () => {
    const settings = await settingsStore.get()
    const previous = settings.backgroundAppearance.imagePath
    const updated = await settingsStore.update({
      backgroundAppearance: { ...settings.backgroundAppearance, imagePath: '' }
    })
    if (previous && isMediaPathAllowed(previous, [backgroundRoot])) {
      await permanentDelete(previous).catch(() => {})
    }
    return updated
  })
  ipcMain.handle('settings:update', async (_event, patch: Partial<AppSettings>) => {
    const current = await settingsStore.get()
    const tempLocation = patch.mergeTempLocation ?? current.mergeTempLocation
    const customTempPath = String(patch.mergeTempCustomPath ?? current.mergeTempCustomPath).trim()
    // 选择“自定义”只切换模式，目录值作为草稿由用户选择/保存后才校验并落盘。
    // 合并执行前仍会对空路径与可写性做最终检查。
    if (tempLocation === 'custom' && customTempPath && patch.mergeTempCustomPath !== undefined) {
      if (!customTempPath) throw new Error('请先选择可写的合并临时目录')
      try {
        await ensureWritableDirectory(customTempPath)
      } catch (error) {
        throw new Error(
          `合并临时目录不可写：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    const updated = await settingsStore.update(patch)
    // 运行时同步 FFmpeg 进程池大小
    if (updated.ffmpegPoolSize) setPoolSize(updated.ffmpegPoolSize)
    for (const window of BrowserWindow.getAllWindows()) syncWindowChrome(window, updated.theme)
    sendSettingsChange(updated)
    return updated
  })
  ipcMain.handle('clean:execute', async (_event, plan: ScanPlan, picks: PosterPicks) =>
    runExclusive('clean', '清理', async (taskId) => {
      const safeRoot = requireVideoRoot(plan.root)
      for (const item of [...plan.keep, ...plan.deleteItems])
        requireRelPath(safeRoot, item.relativePath)
      for (const move of plan.moves) requireRelPath(safeRoot, move.from)
      for (const [video, image] of Object.entries(picks)) {
        requireRelPath(safeRoot, video)
        requireRelPath(safeRoot, image)
      }
      const safePlan = { ...plan, root: safeRoot }
      const settings = await settingsStore.get()
      const report = await executeCleanPlan(safePlan, {
        picks,
        taskCenter,
        taskId,
        concurrency: settings.concurrency,
        deleteFn: deleteFnOf(settings),
        onMoveProgress: (text) =>
          emitTask(taskId, '上移保留文件', { type: 'progress', current: text })
      })
      logOp('clean', {
        root: safeRoot,
        report,
        summary: `删除 ${report.deletedCount}，上移 ${report.moved.length}，转码 ${report.converted.length}`
      })
      return report
    })
  )
  ipcMain.handle('clean:dissolve-folders', async (_event, plan: ScanPlan) =>
    runExclusive('clean', '解散文件夹', async (taskId) => {
      const safeRoot = requireVideoRoot(plan.root)
      for (const item of [...plan.keep, ...plan.deleteItems])
        requireRelPath(safeRoot, item.relativePath)
      for (const pending of plan.pendingPick) {
        requireRelPath(safeRoot, pending.video)
        pending.candidates.forEach((relativePath) => requireRelPath(safeRoot, relativePath))
      }
      const settings = await settingsStore.get()
      return executeDissolveFolders(
        { ...plan, root: safeRoot },
        {
          taskCenter,
          taskId,
          concurrency: settings.concurrency,
          onMoveProgress: (text) =>
            emitTask(taskId, '解散文件夹', { type: 'progress', current: text })
        }
      )
    })
  )
  ipcMain.handle('clean:cancel', async () => cancelSlot('clean'))

  // ---------- 模块四：封面管理 ----------
  ipcMain.handle('poster:list', async (_event, root: string) => {
    const safeRoot = requireVideoRoot(root)
    const settings = await settingsStore.get()
    return trackScan('扫描视频列表', (_signal, onProgress) =>
      listPosterVideos(safeRoot, { onProgress, concurrency: settings.scanConcurrency })
    )
  })
  ipcMain.handle(
    'poster:capture',
    async (_event, root: string, relativePaths: string[], options: { precise?: boolean } = {}) =>
      runExclusive('poster', '截帧', async (taskId) => {
        const safeRoot = requireVideoRoot(root)
        relativePaths.forEach((relativePath) => requireRelPath(safeRoot, relativePath))
        const settings = await settingsStore.get()
        const result = await taskCenter.run({
          taskId,
          label: '截取候选封面',
          items: relativePaths,
          concurrency: settings.concurrency,
          worker: async (relativePath, signal) => {
            const scores = await captureCandidates(
              requireRelPath(safeRoot, relativePath),
              framesRoot,
              {
                ffmpegPath: resolveFfmpegPath(),
                ffprobePath: resolveFfprobePath(),
                signal,
                precise: options.precise === true
              }
            )
            return { relativePath, frames: scores.map((entry) => entry.path), scores }
          }
        })
        return {
          cancelled: result.cancelled,
          outcomes: result.results
            .map((entry, index) =>
              entry.ok
                ? entry.value
                : {
                    relativePath: relativePaths[index],
                    frames: [],
                    scores: [],
                    error: entry.error ?? '已取消'
                  }
            )
            .filter(Boolean)
        }
      })
  )
  ipcMain.handle('poster:capture-at', async (_event, videoPath: string, seconds: number) =>
    runExclusive('poster', '封面', async () => {
      const safeVideo = requireFileInRoots(
        videoPath,
        workspaceRoot ? [workspaceRoot] : [],
        '视频文件'
      )
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error('截帧时间无效')
      return captureAt(safeVideo, seconds, framesRoot, { ffmpegPath: resolveFfmpegPath() })
    })
  )
  ipcMain.handle(
    'poster:save',
    async (
      _event,
      payload: { videoPath: string; chosenFramePath: string; oldPosterPath: string | null }
    ) =>
      runExclusive('poster', '封面', async () => {
        requireFileInRoots(payload.videoPath, workspaceRoot ? [workspaceRoot] : [], '视频文件')
        requireFileInRoots(
          payload.chosenFramePath,
          [framesRoot, ...(workspaceRoot ? [workspaceRoot] : [])],
          '封面来源'
        )
        if (payload.oldPosterPath)
          requireFileInRoots(payload.oldPosterPath, workspaceRoot ? [workspaceRoot] : [], '旧封面')
        const settings = await settingsStore.get()
        return savePoster({ ...payload, deleteFn: deleteFnOf(settings) })
      })
  )
  ipcMain.handle(
    'poster:save-batch',
    async (_event, videos: PosterVideoItem[], selections: Record<string, string>) =>
      runExclusive('poster', '封面', async (taskId) => {
        const safeRoot = requireVideoRoot(workspaceRoot ?? '')
        const items = computePendingSaves(videos, selections)
        for (const item of items) {
          requireFileInRoots(item.videoPath, [safeRoot], '视频文件')
          requireFileInRoots(item.chosenFramePath, [framesRoot, safeRoot], '封面来源')
          if (item.oldPosterPath) requireFileInRoots(item.oldPosterPath, [safeRoot], '旧封面')
        }
        if (items.length === 0)
          return { cancelled: false, savedCount: 0, failedCount: 0, outcomes: [] }
        const settings = await settingsStore.get()
        const result = await taskCenter.run({
          taskId,
          label: '批量保存封面',
          items,
          concurrency: settings.concurrency,
          worker: async (item, signal) => {
            if (signal.aborted) throw new Error('已取消')
            const saved = await savePoster({ ...item, deleteFn: deleteFnOf(settings), signal })
            return { relativePath: item.relativePath, saved: saved.saved }
          }
        })
        const outcomes = result.results.map((entry, index) =>
          entry.ok
            ? entry.value
            : {
                relativePath: items[index].relativePath,
                error: entry.cancelled ? '已取消' : (entry.error ?? '未知错误')
              }
        )
        return {
          cancelled: result.cancelled,
          savedCount: outcomes.filter((o) => o.saved).length,
          failedCount: outcomes.filter((o) => o.error).length,
          outcomes
        }
      })
  )
  ipcMain.handle('poster:cancel', async () => cancelSlot('poster'))

  // ---------- 模块三：批量重命名 ----------
  ipcMain.handle('rename:probe', async (_event, root: string, relativePaths: string[]) => {
    const safeRoot = requireVideoRoot(root)
    relativePaths.forEach((relativePath) => requireRelPath(safeRoot, relativePath))
    const settings = await settingsStore.get()
    const result = await taskCenter.run({
      taskId: newTaskId('probe'),
      label: '探测真实容器',
      items: relativePaths,
      concurrency: settings.concurrency,
      worker: async (relativePath) => {
        const info = await probeMediaCached(
          requireRelPath(safeRoot, relativePath),
          resolveFfprobePath()
        )
        return {
          relativePath,
          container: info.container,
          isMp4: info.container.includes('mp4') || info.container.includes('mov')
        }
      }
    })
    return result.results.map((entry, index) =>
      entry.ok
        ? entry.value
        : {
            relativePath: relativePaths[index],
            container: '',
            isMp4: false,
            error: entry.ok ? undefined : (entry.error ?? '探测失败')
          }
    )
  })
  ipcMain.handle('rename:ai:test-connection', async (_event, providerId: string, model: string) => {
    const settings = await settingsStore.get()
    const provider = settings.aiProviders.find((item) => item.id === providerId)
    if (!provider) throw new Error('找不到要测试的 AI 平台')
    if (!provider.models.includes(model))
      throw new Error('该模型不属于当前平台，请重新选择后再测试')
    const tuning = provider.modelTunings[model]
    const result = await testAiConnection({
      baseUrl: provider.baseUrl,
      token: provider.token,
      model,
      apiProtocol: provider.apiProtocol,
      thinkingEnabled: provider.thinkingEnabled ? true : undefined,
      temperature: tuning?.temperature,
      topP: tuning?.topP,
      temperatureEnabled: tuning?.temperatureEnabled,
      topPEnabled: tuning?.topPEnabled,
      requestTimeoutMs: tuning?.requestTimeoutSeconds
        ? Math.min(tuning.requestTimeoutSeconds * 1000, 60_000)
        : undefined
    })
    return { providerName: provider.name, model, ...result }
  })
  ipcMain.handle('rename:ai', async (_event, files: AiFileInput[], forceRefresh = false) =>
    // AI 仅生成内存预览；使用独立槽，避免单条重新生成阻塞实际文件改名。
    runExclusive('rename-ai', 'AI 命名', async (taskId) => {
      const settings = await settingsStore.get()
      const provider = activeProvider(settings)
      const controller = new AbortController()
      aiTaskControllers.set(taskId, controller)
      const label = `AI 生成命名（${provider.name}）`
      const emit = (type: TaskEvent['type'], completed: number, stage: string): void =>
        emitTask(taskId, label, { type, completed, total: files.length, current: stage })
      try {
        emit('start', 0, provider.selectedModel)
        const modelTuning = provider.modelTunings[provider.selectedModel]
        const names = await requestAiNames({
          baseUrl: provider.baseUrl,
          token: provider.token,
          model: provider.selectedModel,
          apiProtocol: provider.apiProtocol,
          batchSize: modelTuning?.batchSize,
          batchConcurrency: modelTuning?.concurrency,
          requestTimeoutMs: modelTuning?.requestTimeoutSeconds
            ? modelTuning.requestTimeoutSeconds * 1000
            : undefined,
          temperature: modelTuning?.temperature,
          topP: modelTuning?.topP,
          temperatureEnabled: modelTuning?.temperatureEnabled,
          topPEnabled: modelTuning?.topPEnabled,
          maxOutputTokens: modelTuning?.maxOutputTokens,
          // 默认关闭时不发送扩展字段；用户主动开启才透传，避免兼容网关因未知参数报错。
          thinkingEnabled: provider.thinkingEnabled ? true : undefined,
          template: settings.promptTemplate,
          files,
          useCache: !forceRefresh,
          signal: controller.signal,
          onBatch: (done) => emit('progress', done, `已生成 ${done}/${files.length}`)
        })
        emit('done', files.length, '完成')
        return names
      } catch (error) {
        const cancelled = controller.signal.aborted || (error as Error)?.name === 'AbortError'
        if (cancelled) {
          emit('cancelled', 0, '已取消')
        } else {
          // 先报告失败细节，再发送终态，确保全局进度条不会停留在“进行中”。
          const message = error instanceof Error ? error.message : String(error)
          emitTask(taskId, label, {
            type: 'item-error',
            completed: 0,
            failed: 1,
            total: files.length,
            current: 'AI 命名失败',
            error: message
          })
          emitTask(taskId, label, {
            type: 'failed',
            completed: 0,
            failed: 1,
            total: files.length,
            current: '失败'
          })
        }
        throw error
      } finally {
        aiTaskControllers.delete(taskId)
      }
    })
  )
  ipcMain.handle('rename:preflight', async (_event, root: string, pairs: RenamePairInput[]) => {
    const safeRoot = requireVideoRoot(root)
    pairs.forEach((pair) => {
      requireRelPath(safeRoot, pair.videoRel)
      if (pair.posterRel) requireRelPath(safeRoot, pair.posterRel)
    })
    return buildRenamePreflight(safeRoot, pairs)
  })
  ipcMain.handle('rename:execute', async (_event, root: string, pairs: RenamePairInput[]) =>
    runExclusive('rename', '重命名', async (taskId) => {
      const safeRoot = requireVideoRoot(root)
      pairs.forEach((pair) => {
        requireRelPath(safeRoot, pair.videoRel)
        if (pair.posterRel) requireRelPath(safeRoot, pair.posterRel)
      })
      // 上次崩溃残留的临时文件先续跑收尾（S8）
      await recoverRenameJournal(renameJournalPath).catch(() => null)
      const settings = await settingsStore.get()
      const report = await executeRename(safeRoot, pairs, {
        taskCenter,
        taskId,
        concurrency: settings.concurrency,
        journalPath: renameJournalPath
      })
      logOp('rename', { root: safeRoot, report, summary: `改名 ${report.renamedCount} 项` })
      return report
    })
  )
  ipcMain.handle('rename:cancel', async () => {
    cancelSlot('rename')
    cancelSlot('rename-ai')
    for (const controller of aiTaskControllers.values()) controller.abort()
  })

  // ---------- 模块五：NFO 归档 ----------
  ipcMain.handle('nfo:plan', async (_event, root: string) => {
    const safeRoot = requireVideoRoot(root)
    const settings = await settingsStore.get()
    return trackScan('生成归档计划', (_signal, onProgress) =>
      createNfoPlan(safeRoot, { onProgress, concurrency: settings.scanConcurrency })
    )
  })
  ipcMain.handle(
    'nfo:execute',
    async (_event, root: string, items: NfoPlanItem[], actorName: string) =>
      runExclusive('nfo', '归档', async (taskId) => {
        const safeRoot = requireVideoRoot(root)
        items.forEach((item) => {
          requireRelPath(safeRoot, item.videoRel)
          requireRelPath(safeRoot, item.targetDir)
          if (item.posterRel) requireRelPath(safeRoot, item.posterRel)
        })
        const settings = await settingsStore.get()
        const report = await executeNfoPlan(safeRoot, items, actorName, {
          taskCenter,
          taskId,
          concurrency: settings.concurrency
        })
        logOp('nfo', {
          root: safeRoot,
          actorName,
          report,
          summary: `归档 ${report.archivedCount} 个视频`
        })
        return report
      })
  )
  ipcMain.handle('nfo:cancel', async () => cancelSlot('nfo'))

  // ---------- 模块二：视频合并 ----------
  ipcMain.handle('merge:scan', async (_event, root: string) => {
    const safeRoot = requireVideoRoot(root)
    // 恢复断电/强制退出残留的 MP4 backup，清理已被正式输出替代的暂存件。
    await recoverStagedOutputs(safeRoot).catch(() => [])
    const settings = await settingsStore.get()
    // 排除本产品生成的合并产物和未提交暂存件，避免半成品再次参与合并。
    const videos = (
      await trackScan<PosterVideoItem[]>('扫描视频列表', (_signal, onProgress) =>
        listPosterVideos(safeRoot, { onProgress, concurrency: settings.scanConcurrency })
      )
    ).filter((v) => !isMergeOutputName(v.name) && !isStagedOutputName(v.name))
    const probed = await taskCenter.run({
      taskId: newTaskId('merge-probe'),
      label: '读取媒体信息',
      items: videos,
      concurrency: settings.concurrency,
      worker: async (video) => {
        try {
          return { ...video, media: await probeMediaCached(video.path, resolveFfprobePath()) }
        } catch {
          return { ...video, media: null }
        }
      }
    })
    const freeBytes = await diskFreeBytes(safeRoot).catch(() => 0)
    return {
      videos: probed.results.map((entry, index) =>
        entry.ok ? entry.value : { ...videos[index], media: null }
      ),
      freeBytes
    }
  })
  ipcMain.handle('gpu:capability', async () => probeGpuCapability(resolveFfmpegPath()))
  ipcMain.handle('performance:diagnostics', getPerformanceDiagnostics)
  ipcMain.handle(
    'merge:execute',
    async (_event, root: string, items: MergeVideoItem[], outputName: string) => {
      let progressTaskId: string | null = null
      try {
        return await runExclusiveAbort('merge', '合并', async (signal, taskId) => {
          progressTaskId = taskId
          const safeRoot = requireVideoRoot(root)
          assertSafeFileName(outputName)
          if (items.length < 2) throw new Error('至少需要选择两个视频片段')
          if (extname(outputName).toLowerCase() !== '.mp4') {
            throw new Error('合并输出文件必须使用 .mp4 扩展名')
          }
          items.forEach((item) => requireFileInRoots(item.path, [safeRoot], '合并源文件'))
          const emit = (
            type: TaskEvent['type'],
            percent: number,
            stage: string,
            encoder?: TaskEvent['encoder']
          ): void =>
            emitTask(taskId, '视频合并', {
              type,
              total: 100,
              completed: percent,
              current: stage,
              encoder
            })
          emit('start', 0, '准备合并')
          const settings = await settingsStore.get()
          const configuredTempDirectory =
            settings.mergeTempLocation === 'system'
              ? tmpdir()
              : settings.mergeTempLocation === 'custom' && settings.mergeTempCustomPath
                ? settings.mergeTempCustomPath
                : join(safeRoot, '.msd-merge-temp')
          try {
            await ensureWritableDirectory(configuredTempDirectory)
          } catch (error) {
            throw new Error(
              `合并临时目录不可写：${error instanceof Error ? error.message : String(error)}`
            )
          }
          const result = await mergeVideos({
            items: items.map((item) => ({ path: item.path, name: item.name, media: item.media })),
            outputDir: safeRoot,
            outputName,
            ffmpegPath: resolveFfmpegPath(),
            ffprobePath: resolveFfprobePath(),
            signal,
            nvencEnabled: settings.nvencEnabled,
            cudaPipelineEnabled: settings.cudaPipelineEnabled,
            mergeTranscodeConcurrency: settings.mergeTranscodeConcurrency,
            tempDirectory: configuredTempDirectory,
            onProgress: (percent, stage) =>
              emit(
                'progress',
                percent,
                stage,
                stage.includes('回退 CPU')
                  ? 'fallback'
                  : stage.includes('NVIDIA')
                    ? 'nvenc'
                    : stage.includes('CPU')
                      ? 'cpu'
                      : undefined
              )
          })
          const finalEncoder: TaskEvent['encoder'] = result.nvencFallbackReason
            ? 'fallback'
            : result.videoEncoder === 'nvenc'
              ? 'nvenc'
              : result.videoEncoder === 'cpu'
                ? 'cpu'
                : result.videoEncoder === 'copy'
                  ? 'copy'
                  : undefined
          if (result.cancelled) {
            emit('cancelled', 100, result.verifyNote, finalEncoder)
          } else if (result.verified) {
            emit('done', 100, result.verifyNote, finalEncoder)
          } else {
            const diagnostic = {
              root: safeRoot,
              outputName,
              itemCount: items.length,
              result,
              summary: `合并失败：${result.verifyNote}`
            }
            // 失败诊断异步持久化，保留主进程返回的原始错误和阶段，避免 UI/IPC 边界吞掉细节。
            logOp('merge-failure', diagnostic)
            const message = result.error || result.verifyNote
            emitTask(taskId, '视频合并', {
              type: 'item-error',
              total: 100,
              completed: 0,
              failed: 1,
              current: '合并失败',
              error: message
            })
            emitTask(taskId, '视频合并', {
              type: 'failed',
              total: 100,
              completed: 0,
              failed: 1,
              current: '失败'
            })
          }
          return result
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 运行前校验、配置读取等异常发生在 mergeVideos 之外，也必须结束已创建的进度任务。
        if (progressTaskId) {
          taskCancels.delete(progressTaskId)
          emitTask(progressTaskId, '视频合并', {
            type: 'failed',
            total: 100,
            completed: 0,
            failed: 1,
            current: '合并启动失败',
            error: message
          })
        }
        const details =
          error && typeof error === 'object'
            ? {
                code: 'code' in error ? String(error.code) : undefined,
                stack: error instanceof Error ? error.stack : undefined
              }
            : undefined
        // 包含工作区、输入规模及原始异常；用户无需从截图转录错误即可供后续定位。
        logOp('merge-ipc-error', {
          root,
          outputName,
          itemCount: items.length,
          error: message,
          details,
          summary: `合并 IPC 异常：${message}`
        })
        throw error
      }
    }
  )
  ipcMain.handle('merge:delete-sources', async (_event, root: string, items: MergeSourceItem[]) => {
    const safeRoot = requireVideoRoot(root)
    items.forEach((item) => {
      requireRelPath(safeRoot, item.videoRel)
      if (item.posterRel) requireRelPath(safeRoot, item.posterRel)
    })
    const settings = await settingsStore.get()
    const report = await deleteMergeSources(safeRoot, items, {
      taskCenter,
      taskId: newTaskId('merge-clean'),
      concurrency: settings.concurrency,
      deleteFn: deleteFnOf(settings)
    })
    logOp('merge-delete-sources', {
      root: safeRoot,
      items,
      report,
      summary: `删除源文件 ${report.deletedCount} 个`
    })
    return report
  })
  ipcMain.handle('merge:cancel', async () => abortSlot('merge'))
  ipcMain.handle('tasks:cancel', async (_event, taskId: string) => cancelTask(taskId))

  // ---------- 视频去重 ----------
  ipcMain.handle('dedupe:scan', async (_event, root: string, includeSimilar = true) => {
    const safeRoot = requireVideoRoot(root)
    const settings = await settingsStore.get()
    return findDuplicates(safeRoot, {
      taskCenter,
      taskId: newTaskId('dedupe'),
      concurrency: settings.concurrency,
      ffprobePath: resolveFfprobePath(),
      includeSimilar: includeSimilar !== false
    })
  })
  ipcMain.handle('dedupe:delete', async (_event, root: string, relativePaths: string[]) => {
    const safeRoot = requireVideoRoot(root)
    relativePaths.forEach((relativePath) => requireRelPath(safeRoot, relativePath))
    return runExclusive('dedupe-delete', '删除重复视频', async (taskId) => {
      const settings = await settingsStore.get()
      const doDelete = deleteFnOf(settings)
      const result = await taskCenter.run({
        taskId,
        label: '删除重复视频',
        items: relativePaths,
        concurrency: settings.concurrency,
        worker: async (relativePath, signal) => {
          if (signal?.aborted) throw new Error('已取消')
          await doDelete(requireRelPath(safeRoot, relativePath))
        }
      })
      const report = {
        cancelled: result.cancelled,
        deletedCount: result.completed,
        failed: [] as { target: string; error: string }[]
      }
      collectFailures(report, result, relativePaths)
      logOp('dedupe-delete', {
        root: safeRoot,
        items: relativePaths,
        report,
        summary: `删除重复文件 ${result.completed} 个`
      })
      return report
    })
  })
  ipcMain.handle('dedupe:cancel', async () => cancelSlot('dedupe-delete'))

  // ---------- 存储管理（S4） ----------
  ipcMain.handle('storage:stats', async (): Promise<StorageStats> => {
    const settings = await settingsStore.get()
    const mergeRoots = mergeTempRoots(settings)
    const mergeSizes = await Promise.all(
      mergeRoots.map(async (root) => {
        const entries = await listDirNames(root).catch(() => [] as string[])
        const targets = entries
          .filter((name) => name.startsWith(MERGE_TEMP_PREFIX))
          .map((name) => join(root, name))
        const sizes = await Promise.all(targets.map(dirSizeBytes))
        return sizes.reduce((sum, size) => sum + size, 0)
      })
    )
    const [framesBytes, opLogBytes, opLogFiles] = await Promise.all([
      dirSizeBytes(framesRoot),
      dirSizeBytes(opLogDir),
      listDirNames(opLogDir)
    ])
    return {
      framesBytes,
      mergeTempBytes: mergeSizes.reduce((sum, size) => sum + size, 0),
      opLogBytes,
      opLogCount: opLogFiles.filter((f) => f.endsWith('.json')).length
    }
  })
  ipcMain.handle('storage:clean', async (_event, category: StorageCategory) => {
    let freedBytes = 0
    if (category === 'frames') {
      freedBytes = await cleanFramesCache()
    } else if (category === 'merge-temp') {
      freedBytes = await cleanMergeTempDirs(await settingsStore.get())
    } else {
      freedBytes = await dirSizeBytes(opLogDir)
      const files = await listDirNames(opLogDir)
      await Promise.all(
        files.filter((f) => f.endsWith('.json')).map((f) => permanentDelete(join(opLogDir, f)))
      )
    }
    return { category, freedBytes }
  })

  // ---------- 漫画模块 ----------
  ipcMain.handle('comic:scan', async (_event, root: string, options: { light?: boolean } = {}) => {
    const safeRoot = requireComicRoot(root)
    const result = await trackScan('扫描漫画工作区', async (signal) =>
      scanComicWorkspace(safeRoot, { ...options, signal })
    )
    comicScanSnapshots.set(safeRoot, result)
    return result
  })
  ipcMain.handle(
    'comic:merge',
    async (
      _event,
      root: string,
      relDirs: string[],
      format: ComicFormat,
      options: { raw?: boolean; pdfQuality?: ComicPdfQuality; rebuild?: boolean } = {}
    ) =>
      runExclusiveAbort('comic-mutate', '漫画工作区操作', async (signal, taskId) => {
        const safeRoot = requireComicRoot(root)
        relDirs.forEach((relDir) => requireComicDir(safeRoot, relDir))
        const settings = await settingsStore.get()
        const report = await mergeComics(safeRoot, {
          relDirs,
          format,
          raw: options.raw === true,
          pdfQuality: options.pdfQuality,
          rebuild: options.rebuild === true,
          taskCenter,
          taskId,
          snapshots: comicScanSnapshots.get(safeRoot)?.comics ?? [],
          bookConcurrency: settings.comicBookConcurrency,
          pageConcurrency: settings.comicPageConcurrency,
          signal,
          onProgress: ({ completed, total, current, done, cancelled }) => {
            emitTask(`${taskId}-pages`, '漫画页处理进度', {
              type: cancelled ? 'cancelled' : done ? 'done' : 'progress',
              completed,
              total,
              current
            })
          }
        })
        logOp('comic-merge', {
          root: safeRoot,
          format,
          report,
          summary: `合并漫画 ${report.merged.length} 部（${format}）${
            report.failed.length > 0 ? `，失败 ${report.failed.length} 部` : ''
          }`
        })
        return report
      })
  )
  ipcMain.handle('comic:cancel', async () => abortSlot('comic-mutate'))
  ipcMain.handle(
    'comic:rename',
    async (_event, root: string, items: Array<{ relDir: string; newName: string }>) =>
      runExclusiveAbort('comic-mutate', '漫画工作区操作', async (signal, taskId) => {
        const safeRoot = requireComicRoot(root)
        items.forEach((item) => requireComicDir(safeRoot, item.relDir))
        const settings = await settingsStore.get()
        // 暂存/恢复阶段在 TaskCenter 派发前/后执行，Windows 上带锁重试可能耗时较长，
        // 经同一任务 ID 持续上报进度，避免界面看起来像卡死。
        let stageNotified = false
        let report
        try {
          report = await renameComicDirectories(safeRoot, items, {
            taskCenter,
            taskId,
            concurrency: settings.concurrency,
            signal,
            onStageProgress: (completed, total, current) => {
              stageNotified = true
              emitTask(taskId, '重命名漫画', { type: 'progress', current, completed, total })
            },
            onLockRetry: (relDir, info) =>
              emitTask(taskId, '重命名漫画', {
                type: 'progress',
                current: `「${relDir}」等待文件锁释放（第 ${info.attempt} 次，${info.delayMs}ms）`
              })
          })
        } catch (error) {
          // 暂存阶段失败发生在 TaskCenter 派发之前，必须补发终态事件，
          // 否则任务洋岛卡片会一直停在“进行中”。
          if (stageNotified) {
            emitTask(taskId, '重命名漫画', {
              type: 'failed',
              current: '重命名失败',
              error: error instanceof Error ? error.message : String(error)
            })
          }
          throw error
        }
        logOp('comic-rename', {
          root: safeRoot,
          report,
          summary: `重命名漫画 ${report.renamedCount} 部${
            report.failed.length > 0 ? `，失败 ${report.failed.length} 部` : ''
          }`
        })
        return report
      })
  )
  ipcMain.handle('comic:rename-cancel', async () => abortSlot('comic-mutate'))
  ipcMain.handle('comic:delete-sources', async (_event, root: string, relDirs: string[]) => {
    const safeRoot = requireComicRoot(root)
    relDirs.forEach((relDir) => requireComicDir(safeRoot, relDir))
    const settings = await settingsStore.get()
    return runExclusive('comic-mutate', '漫画工作区操作', async (taskId) => {
      const report = await deleteComicSources(safeRoot, {
        relDirs,
        taskCenter,
        taskId,
        concurrency: settings.concurrency,
        deleteFn: deleteFnOf(settings)
      })
      logOp('comic-delete-sources', {
        root: safeRoot,
        report,
        summary: `删除漫画源图片 ${report.deletedCount} 张`
      })
      return report
    })
  })

  // ---------- 自动更新（F7） ----------
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { state: 'error', message: '开发环境不支持检查更新' }
    sendUpdateStatus({ state: 'checking' })
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      sendUpdateStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
    return updateStatus
  })
  ipcMain.handle('update:download', async () => {
    if (!app.isPackaged) return
    sendUpdateStatus({ state: 'downloading', percent: 0 })
    await autoUpdater.downloadUpdate().catch((error) => {
      sendUpdateStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    })
  })
  ipcMain.handle('update:install', async () => {
    if (taskCenter.hasActive() || abortSlots.size > 0 || activeProcessCount() > 0) {
      throw new Error('仍有任务在运行，请等待完成或先取消后再安装更新')
    }
    installingUpdate = true
    autoUpdater.quitAndInstall()
  })
  ipcMain.handle('update:get-status', async () => updateStatus)
  ipcMain.handle('app:version', async () => app.getVersion())

  // ---------- 操作日志 ----------
  ipcMain.handle('op-logs:list', async () => listOpLogs(opLogDir))
  ipcMain.handle('op-logs:get-detail', async (_event, file: string) => {
    assertSafeFileName(file)
    const detail = await getOpLogDetail(opLogDir, file)
    if (!detail) throw new Error('日志不存在或已损坏')
    return detail
  })
  ipcMain.handle('op-logs:preflight-undo', async (_event, file: string) => {
    const safeFile = requireFileInRoots(join(opLogDir, file), [opLogDir], '操作日志')
    return preflightUndoOpLog(safeFile)
  })
  ipcMain.handle('op-logs:reveal', async (_event, file: string) => {
    shell.showItemInFolder(requireFileInRoots(join(opLogDir, file), [opLogDir], '操作日志'))
  })
  // 系统默认应用打开文件（漫画库打开 EPUB/PDF）
  ipcMain.handle('shell:open-path', async (_event, target: string) => {
    const error = await shell.openPath(requireComicOutput(target))
    if (error) throw new Error(error)
  })
  // 在系统文件管理器中定位漫画产物（Windows Explorer / macOS Finder）。
  ipcMain.handle('shell:reveal-path', async (_event, target: string) => {
    shell.showItemInFolder(requireComicOutput(target))
  })
  // 一键撤销（F2）：按日志反向恢复重命名/NFO 归档
  ipcMain.handle('op-logs:undo', async (_event, file: string) =>
    runExclusive('undo', '撤销', async (taskId) => {
      const safeFile = requireFileInRoots(join(opLogDir, file), [opLogDir], '操作日志')
      const settings = await settingsStore.get()
      const report = await undoOpLog(safeFile, {
        taskCenter,
        taskId,
        concurrency: settings.concurrency
      })
      sendOpLogChange()
      return report
    })
  )
}

// Windows 双击快捷方式或更新期间重复启动时，共享 userData 会导致设置和任务状态互相覆盖。
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const existing = BrowserWindow.getAllWindows()[0]
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  electronApp.setAppUserModelId('com.mediascraper.desktop')

  // 初始化 FFmpeg 进程池大小
  const initSettings = await settingsStore.get()
  setPoolSize(initSettings.ffmpegPoolSize)

  // 磁盘兜底回收（不阻塞窗口创建）：
  // 1. 截帧缓存整目录清理——正常退出时 before-quit 已清，这里只兜住强杀/崩溃的残留；
  // 2. 超过 7 天未动的合并断点目录视为放弃续传，自动回收（近期断点保留）。
  void permanentDelete(framesRoot).catch(() => {})
  void cleanStaleMergeTempDirs(initSettings, MERGE_TEMP_MAX_AGE_MS).catch(() => {})

  // 上次崩溃遗留的重命名临时文件按 journal 续跑收尾（S8）
  await recoverRenameJournal(renameJournalPath).catch(() => null)

  protocol.handle('media', async (request) => {
    // 渲染端格式：media://local<逐段 encodeURIComponent(正斜杠绝对路径)>
    const decoded = decodeURIComponent(new URL(request.url).pathname)
    // 盘符去前导斜杠、UNC 保留双斜杠、resolve 归一化 .. 防路径穿越（如 C:/ws/../elsewhere）
    const filePath = mediaUrlPathToLocal(decoded)
    if (!isMediaAllowed(filePath)) return new Response('Forbidden', { status: 403 })

    let size
    try {
      size = await fileSize(filePath)
    } catch {
      return new Response('Not Found', { status: 404 })
    }

    const isImage = IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
      ...(isImage ? { 'Cache-Control': 'no-store' } : {})
    })
    const range = request.headers.get('range')
    if (!range) {
      const stream = createFileReadStream(filePath)
      return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers })
    }

    // 不经 file:// 转发，而是协议层直接返回标准 206；Windows Chromium 可稳定拖动进度条。
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
    if (!match)
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    const [, startText, endText] = match
    let start = startText ? Number(startText) : 0
    let end = endText ? Number(endText) : size - 1
    if (!startText && endText) {
      start = Math.max(0, size - Number(endText))
      end = size - 1
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    end = Math.min(end, size - 1)
    if (end < start)
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    const stream = createFileReadStream(filePath, { start, end })
    headers.set('Content-Length', String(end - start + 1))
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers })
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  setupAutoUpdate()
  const settings = await settingsStore.get().catch(() => null)
  createWindow(settings?.theme ?? 'system')
  nativeTheme.on('updated', () => {
    void settingsStore
      .get()
      .then((current) => {
        if (current.theme !== 'system') return
        for (const window of BrowserWindow.getAllWindows()) syncWindowChrome(window, current.theme)
      })
      .catch(() => {})
  })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      void settingsStore
        .get()
        .then((current) => createWindow(current.theme))
        .catch(() => {})
    }
  })
})

// 退出前收尾：取消全部在途任务（在途 ffmpeg 经 AbortSignal 被杀），
// 强杀残留子进程防死占用。合并断点目录必须保留，避免退出时大量递归 I/O 争用，
// 并维持「取消后可续传」语义；用户可在存储管理中显式清理。
let quitting = false
app.on('before-quit', (event) => {
  if (quitting || installingUpdate) return
  event.preventDefault()
  quitting = true
  void (async () => {
    for (const controller of scanControllers) controller.abort()
    if (taskCenter.hasActive() || abortSlots.size > 0) {
      taskCenter.cancelAll()
      for (const controller of abortSlots.values()) controller.abort()
    }
    // 先给在途进程优雅收尾的机会（POSIX SIGTERM / Windows stdin 'q'）。
    // Windows 写大型 MP4 的 moov 或网络盘落盘可能较慢，保留更长窗口后才兜底强杀。
    if (activeProcessCount() > 0) {
      const deadline = Date.now() + (process.platform === 'win32' ? 10_000 : 3_000)
      while (activeProcessCount() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      // 兜底强杀残留子进程（ffmpeg/ffprobe），防退出后孤儿进程死占用 CPU/内存
      if (activeProcessCount() > 0) killAllActiveProcesses()
    }
    await cleanFramesCache()
    app.quit()
  })()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
