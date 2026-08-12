import { app, shell, BrowserWindow, dialog, ipcMain, Notification, protocol } from 'electron'
import { extname, join } from 'path'
import { Readable } from 'node:stream'
import { tmpdir } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import icon from '../../resources/icon.png?asset'
import { computeFingerprint, createScanPlan, IMAGE_EXTENSIONS } from './core/scanner.mjs'
import { activeProvider, createSettingsStore, pushRecentWorkspace } from './core/settings.mjs'
import { createTaskCenter } from './core/task-center.mjs'
import { resolveFfmpegPath } from './core/frames.mjs'
import { probeMedia, probeMediaCached, resolveFfprobePath } from './core/probe.mjs'
import { executeCleanPlan } from './modules/clean/execute.mjs'
import { executeRename, recoverRenameJournal } from './modules/rename/execute.mjs'
import { requestAiNames } from './modules/rename/ai.mjs'
import { createNfoPlan, executeNfoPlan } from './modules/nfo/nfo.mjs'
import { deleteMergeSources, mergeVideos } from './modules/merge/merge.mjs'
import { findDuplicates } from './modules/dedupe/dedupe.mjs'
import { undoOpLog } from './modules/undo/undo.mjs'
import { scanComicWorkspace } from './modules/comic/scan.mjs'
import { deleteComicSources, mergeComics } from './modules/comic/merge.mjs'
import { renameComicDirectories } from './modules/comic/rename.mjs'
import {
  cleanMovePartials,
  createFileReadStream,
  deleteToTrash,
  dirSizeBytes,
  diskFreeBytes,
  fileSize,
  listDirNames,
  permanentDelete,
  pathExists,
  setTrashImpl
} from './core/fs-ops.mjs'
import { collectFailures } from './core/task-report.mjs'
import { killAllActiveProcesses, activeProcessCount } from './core/process-registry.mjs'
import { setPoolSize } from './core/ffmpeg-pool.mjs'
import { listOpLogs, writeOpLog } from './core/op-log.mjs'
import { isMediaPathAllowed, mediaUrlPathToLocal } from './core/media-path.mjs'
import { assertRegisteredRoot, assertSafeFileName, resolveInsideRoot } from './core/path-guard.mjs'
import { isMergeOutputName } from '../shared/merge-rules.mjs'
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
  ComicFormat,
  MergeSourceItem,
  MergeVideoItem,
  NfoPlanItem,
  PosterPicks,
  PosterVideoItem,
  RenamePairInput,
  ScanPlan,
  StorageCategory,
  StorageStats,
  TaskEvent,
  UpdateStatus
} from '../shared/types'

const settingsStore = createSettingsStore(join(app.getPath('userData'), 'settings.json'))
const framesRoot = join(app.getPath('temp'), 'media-scraper-frames')
const opLogDir = join(app.getPath('userData'), 'op-logs')
/** 重命名崩溃恢复 journal（msd_tmp_* 临时文件续跑依据） */
const renameJournalPath = join(app.getPath('userData'), 'rename-journal.json')
/** 合并断点续传工作目录的统一前缀（merge.mjs mergeWorkDir 约定） */
const MERGE_TEMP_PREFIX = 'msd-merge-'

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

/** 清空系统临时目录下的全部合并工作目录，返回释放的字节数 */
const cleanMergeTempDirs = async (): Promise<number> => {
  const entries = await listDirNames(tmpdir()).catch(() => [] as string[])
  const results = await Promise.all(
    entries
      .filter((name) => name.startsWith(MERGE_TEMP_PREFIX))
      .map(async (name) => {
        const target = join(tmpdir(), name)
        const size = await dirSizeBytes(target)
        await permanentDelete(target).catch(() => {})
        return size
      })
  )
  return results.reduce((sum, size) => sum + size, 0)
}

/** 记录一条操作日志（不阻塞主流程） */
const logOp = (module: string, payload: object): void => {
  writeOpLog(opLogDir, module, payload).catch(() => {})
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
const registerVideoRootForRead = (root: string): string => {
  if (!workspaceRoot) setWorkspaceRoot(root)
  return requireVideoRoot(root)
}
const registerComicRootForRead = (root: string): string => {
  if (!comicRoot) setComicRoot(root)
  return requireComicRoot(root)
}
const requireRelPath = (root: string, relativePath: string): string =>
  resolveInsideRoot(root, relativePath)
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

/**
 * 路径归一化（白名单比较用）：统一为正斜杠、去尾部分隔符、盘符统一大写。
 * Windows 上工作区根来自系统对话框（反斜杠），而 media:// URL 解码后是正斜杠，
 * 不归一化会导致白名单全部误判 403（封面/视频全挂）。
 */
const isMediaAllowed = (filePath: string): boolean => {
  const roots = [framesRoot]
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
    if (event.type === 'start' || event.type === 'done' || event.type === 'cancelled') {
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
  try {
    return await fn(taskId)
  } finally {
    taskSlots.delete(slot)
  }
}

const cancelSlot = (slot: string): void => {
  const taskId = taskSlots.get(slot)
  if (taskId) taskCenter.cancel(taskId)
}

// AbortController 型互斥槽（合并/流水线不走 TaskCenter 的取消协议）
const abortSlots = new Map<string, AbortController>()

async function runExclusiveAbort<T>(
  slot: string,
  label: string,
  fn: (signal: AbortSignal, taskId: string) => Promise<T>
): Promise<T> {
  if (abortSlots.has(slot)) throw new Error(`已有${label}任务在执行中`)
  const controller = new AbortController()
  abortSlots.set(slot, controller)
  try {
    return await fn(controller.signal, newTaskId(slot))
  } finally {
    abortSlots.delete(slot)
  }
}

const abortSlot = (slot: string): void => {
  abortSlots.get(slot)?.abort()
}

/**
 * 慢扫描进度上报：400ms 内完成的扫描不打扰（小目录无感）；
 * 大目录扫描期间经全局进度条展示「已发现 N 个文件」。
 */
async function trackScan<T>(
  label: string,
  fn: (onProgress: (scanned: number) => void) => Promise<T>
): Promise<T> {
  const taskId = newTaskId('scan')
  const emit = (type: TaskEvent['type'], current?: string): void =>
    emitTask(taskId, label, { type, current })
  let started = false
  const timer = setTimeout(() => {
    started = true
    emit('start', '扫描目录中…')
  }, 400)
  const onProgress = (scanned: number): void => {
    if (started) emit('progress', `已发现 ${scanned} 个文件`)
  }
  try {
    return await fn(onProgress)
  } finally {
    clearTimeout(timer)
    if (started) emit('done')
  }
}

/** 注册工作区：media:// 白名单 + 最近工作区持久化；视频模块附加目录监控重建 */
const registerWorkspace = async (root: string, module: AppModule = 'video'): Promise<void> => {
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

function createWindow(theme: string): void {
  const mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: theme === 'dark' ? '#1c1c1e' : '#f5f6f8',
    title: 'Media Scraper',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
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
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
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
  // 渲染端恢复/拖拽工作区：校验目录存在后注册（media:// 白名单 + 最近列表）
  ipcMain.handle('workspace:use', async (_event, root: string, module: AppModule = 'video') => {
    if (!(await pathExists(root))) throw new Error('目录不存在或不可读')
    await registerWorkspace(root, module)
    return root
  })
  ipcMain.handle('workspace:scan-plan', async (_event, root: string) => {
    const safeRoot = registerVideoRootForRead(root)
    const settings = await settingsStore.get()
    return trackScan('扫描工作区', (onProgress) =>
      createScanPlan(safeRoot, { onProgress, concurrency: settings.scanConcurrency })
    )
  })
  // 指纹仅为只读的 UI 刷新提示：不改变 media:// 白名单，也不作为任何写操作授权。
  // 页面常驻切换时可能带着上一轮 workspace 触发尾随 fingerprint，允许其自然失败并由渲染端忽略。
  ipcMain.handle('workspace:fingerprint', async (_event, root: string) => {
    const settings = await settingsStore.get()
    return trackScan('检查工作区变化', (onProgress) =>
      computeFingerprint(root, { onProgress, concurrency: settings.scanConcurrency })
    )
  })
  ipcMain.handle('settings:get', async () => settingsStore.get())
  ipcMain.handle('settings:update', async (_event, patch: Partial<AppSettings>) => {
    const updated = await settingsStore.update(patch)
    // 运行时同步 FFmpeg 进程池大小
    if (updated.ffmpegPoolSize) setPoolSize(updated.ffmpegPoolSize)
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
  ipcMain.handle('clean:cancel', async () => cancelSlot('clean'))

  // ---------- 模块四：封面管理 ----------
  ipcMain.handle('poster:list', async (_event, root: string) => {
    const safeRoot = requireVideoRoot(root)
    const settings = await settingsStore.get()
    return trackScan('扫描视频列表', (onProgress) =>
      listPosterVideos(safeRoot, { onProgress, concurrency: settings.scanConcurrency })
    )
  })
  ipcMain.handle('poster:capture', async (_event, root: string, relativePaths: string[]) =>
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
              signal
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
  ipcMain.handle('poster:capture-at', async (_event, videoPath: string, seconds: number) => {
    const safeVideo = requireFileInRoots(
      videoPath,
      workspaceRoot ? [workspaceRoot] : [],
      '视频文件'
    )
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('截帧时间无效')
    return captureAt(safeVideo, seconds, framesRoot, { ffmpegPath: resolveFfmpegPath() })
  })
  ipcMain.handle(
    'poster:save',
    async (
      _event,
      payload: { videoPath: string; chosenFramePath: string; oldPosterPath: string | null }
    ) => {
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
    }
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
            const saved = await savePoster({ ...item, deleteFn: deleteFnOf(settings) })
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
        const info = await probeMedia(requireRelPath(safeRoot, relativePath), resolveFfprobePath())
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
        const names = await requestAiNames({
          baseUrl: provider.baseUrl,
          token: provider.token,
          model: provider.selectedModel,
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
          emit('item-error', 0, '失败')
          emitTask(taskId, label, {
            type: 'done',
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
    return trackScan('生成归档计划', (onProgress) =>
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
    const settings = await settingsStore.get()
    // 排除本产品生成的合并产物，避免再次参与合并
    const videos = (
      await trackScan<PosterVideoItem[]>('扫描视频列表', (onProgress) =>
        listPosterVideos(safeRoot, { onProgress, concurrency: settings.scanConcurrency })
      )
    ).filter((v) => !isMergeOutputName(v.name))
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
  ipcMain.handle(
    'merge:execute',
    async (_event, root: string, items: MergeVideoItem[], outputName: string) =>
      runExclusiveAbort('merge', '合并', async (signal, taskId) => {
        const safeRoot = requireVideoRoot(root)
        assertSafeFileName(outputName)
        items.forEach((item) => requireFileInRoots(item.path, [safeRoot], '合并源文件'))
        const emit = (type: TaskEvent['type'], percent: number, stage: string): void =>
          emitTask(taskId, '视频合并', { type, total: 100, completed: percent, current: stage })
        emit('start', 0, '准备合并')
        const result = await mergeVideos({
          items: items.map((item) => ({ path: item.path, name: item.name, media: item.media })),
          outputDir: safeRoot,
          outputName,
          ffmpegPath: resolveFfmpegPath(),
          ffprobePath: resolveFfprobePath(),
          signal,
          onProgress: (percent, stage) => emit('progress', percent, stage)
        })
        emit(result.cancelled ? 'cancelled' : 'done', 100, result.verifyNote)
        return result
      })
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
    const tmpEntries = await listDirNames(tmpdir())
    const mergeTargets = tmpEntries
      .filter((name) => name.startsWith(MERGE_TEMP_PREFIX))
      .map((name) => join(tmpdir(), name))
    const [mergeSizes, framesBytes, opLogBytes, opLogFiles] = await Promise.all([
      Promise.all(mergeTargets.map(dirSizeBytes)),
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
      freedBytes = await cleanMergeTempDirs()
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
  ipcMain.handle('comic:scan', async (_event, root: string) =>
    trackScan('扫描漫画工作区', async () => scanComicWorkspace(registerComicRootForRead(root)))
  )
  ipcMain.handle(
    'comic:merge',
    async (
      _event,
      root: string,
      relDirs: string[],
      format: ComicFormat,
      options: { raw?: boolean; rebuild?: boolean } = {}
    ) =>
      runExclusive('comic-mutate', '漫画工作区操作', async (taskId) => {
        const safeRoot = requireComicRoot(root)
        relDirs.forEach((relDir) => requireComicDir(safeRoot, relDir))
        const settings = await settingsStore.get()
        const report = await mergeComics(safeRoot, {
          relDirs,
          format,
          raw: options.raw === true,
          rebuild: options.rebuild === true,
          taskCenter,
          taskId,
          concurrency: settings.concurrency,
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
  ipcMain.handle('comic:cancel', async () => cancelSlot('comic-mutate'))
  ipcMain.handle(
    'comic:rename',
    async (_event, root: string, items: Array<{ relDir: string; newName: string }>) =>
      runExclusive('comic-mutate', '漫画工作区操作', async (taskId) => {
        const safeRoot = requireComicRoot(root)
        items.forEach((item) => requireComicDir(safeRoot, item.relDir))
        const settings = await settingsStore.get()
        const report = await renameComicDirectories(safeRoot, items, {
          taskCenter,
          taskId,
          concurrency: settings.concurrency
        })
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
  ipcMain.handle('comic:rename-cancel', async () => cancelSlot('comic-mutate'))
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
  ipcMain.handle('op-logs:reveal', async (_event, file: string) => {
    shell.showItemInFolder(requireFileInRoots(file, [opLogDir], '操作日志'))
  })
  // 系统默认应用打开文件（漫画库打开 EPUB/PDF）
  ipcMain.handle('shell:open-path', async (_event, target: string) => {
    const safeTarget = requireFileInRoots(target, comicRoot ? [comicRoot] : [], '漫画产物')
    if (!['.epub', '.pdf'].includes(extname(safeTarget).toLowerCase()))
      throw new Error('只允许打开 EPUB 或 PDF')
    const error = await shell.openPath(safeTarget)
    if (error) throw new Error(error)
  })
  // 一键撤销（F2）：按日志反向恢复重命名/NFO 归档
  ipcMain.handle('op-logs:undo', async (_event, file: string) =>
    runExclusive('undo', '撤销', async (taskId) => {
      const safeFile = requireFileInRoots(file, [opLogDir], '操作日志')
      const settings = await settingsStore.get()
      const report = await undoOpLog(safeFile, {
        taskCenter,
        taskId,
        concurrency: settings.concurrency
      })
      logOp('undo', {
        file: safeFile,
        report,
        summary: `撤销 ${report.module}：回退 ${report.undone} 项，跳过 ${report.skipped} 项`
      })
      return report
    })
  )
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.mediascraper.desktop')

  // 初始化 FFmpeg 进程池大小
  const initSettings = await settingsStore.get()
  setPoolSize(initSettings.ffmpegPoolSize)

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
  createWindow(settings?.theme === 'dark' ? 'dark' : 'light')

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0)
      createWindow(settings?.theme === 'dark' ? 'dark' : 'light')
  })
})

// 退出前收尾：取消全部在途任务（在途 ffmpeg 经 AbortSignal 被杀），
// 强杀残留子进程防死占用，自动清理截帧缓存与合并临时目录（操作日志保留不自动清），完成后退出
let quitting = false
app.on('before-quit', (event) => {
  if (quitting || installingUpdate) return
  event.preventDefault()
  quitting = true
  void (async () => {
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
    await Promise.all([cleanFramesCache(), cleanMergeTempDirs()])
    app.quit()
  })()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
