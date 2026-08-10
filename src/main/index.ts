import { app, shell, BrowserWindow, dialog, ipcMain, net, Notification, protocol } from 'electron'
import { extname, join, sep } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
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
import { healthScan } from './modules/health/health.mjs'
import { runPipeline } from './modules/pipeline/pipeline.mjs'
import { undoOpLog } from './modules/undo/undo.mjs'
import {
  cleanMovePartials,
  deleteToTrash,
  dirSizeBytes,
  diskFreeBytes,
  listDirNames,
  permanentDelete,
  pathExists,
  setTrashImpl
} from './core/fs-ops.mjs'
import { collectFailures } from './core/task-report.mjs'
import { killAllActiveProcesses, activeProcessCount } from './core/process-registry.mjs'
import { setPoolSize } from './core/ffmpeg-pool.mjs'
import { listOpLogs, writeOpLog } from './core/op-log.mjs'
import { watchDirectory } from './core/dir-watch.mjs'
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
  AppSettings,
  MergeSourceItem,
  MergeVideoItem,
  NfoPlanItem,
  PipelineReport,
  PipelineStep,
  PosterPicks,
  PosterVideoItem,
  RenamePairInput,
  ScanPlan,
  StorageCategory,
  StorageStats,
  TaskEvent,
  UpdateStatus,
  WatchStatus
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
const isMediaAllowed = (filePath: string): boolean => {
  const roots = workspaceRoot ? [framesRoot, workspaceRoot] : [framesRoot]
  for (const root of roots) {
    if (filePath === root || filePath.startsWith(root.endsWith(sep) ? root : root + sep))
      return true
  }
  return false
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

/** 注册工作区：media:// 白名单（替换语义）+ 最近工作区持久化 + 目录监控重建 */
const registerWorkspace = async (root: string): Promise<void> => {
  setWorkspaceRoot(root)
  const settings = await settingsStore.get()
  await settingsStore.update({
    recentWorkspaces: pushRecentWorkspace(settings.recentWorkspaces, root)
  })
  // 顺手清理上次跨设备移动崩溃残留的 .msd-part 临时件（S3 兜底）
  void cleanMovePartials(root).catch(() => [])
  await refreshWatcher()
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

/* ------------------------- 目录监控自动流水线（F4） ------------------------- */

let dirWatcher: { close: () => void } | null = null
let watchRunning = false
const watchState = {
  watching: false,
  root: null as string | null,
  error: null as string | null,
  lastRunAt: null as string | null,
  lastSummary: null as string | null,
  lastFingerprint: null as string | null
}

const stopWatcher = (): void => {
  dirWatcher?.close()
  dirWatcher = null
  watchState.watching = false
  watchState.root = null
}

/** 按当前设置与工作区重建目录监控（设置变更/切换工作区时调用） */
async function refreshWatcher(): Promise<void> {
  stopWatcher()
  const settings = await settingsStore.get().catch(() => null)
  if (!settings?.watch.enabled || !workspaceRoot) return
  const root = workspaceRoot
  dirWatcher = watchDirectory(root, {
    debounceMs: settings.watch.debounceMinutes * 60_000,
    onChange: () => {
      void onWorkspaceChanged()
    },
    onError: (error) => {
      watchState.error = `目录监控不可用：${error.message}`
      stopWatcher()
    }
  })
  watchState.watching = true
  watchState.root = root
  watchState.error = null
  // 以当前指纹为基线，仅响应启用之后的新变化；基线异步计算，
  // 不阻塞工作区注册（大目录遍历耗时），期间的变化按最新指纹判定即可
  watchState.lastFingerprint = null
  void computeFingerprint(root, { concurrency: settings.scanConcurrency })
    .then((fingerprint) => {
      if (watchState.lastFingerprint === null) watchState.lastFingerprint = fingerprint
    })
    .catch(() => {})
}

/** 工作区变化静默后：指纹比对防自触发，然后自动执行预设流水线 */
async function onWorkspaceChanged(): Promise<void> {
  // 流水线运行期间自身的文件写入会触发监控，直接忽略（运行后重新落基线指纹）
  if (watchRunning || abortSlots.has('pipeline')) return
  const settings = await settingsStore.get().catch(() => null)
  const root = workspaceRoot
  if (!settings?.watch.enabled || !root) return
  const preset =
    settings.pipelinePresets.find((p) => p.id === settings.watch.presetId) ??
    settings.pipelinePresets[0]
  if (!preset || !preset.steps.some((s) => s.enabled)) return
  const fingerprint = await computeFingerprint(root, {
    concurrency: settings.scanConcurrency
  }).catch(() => null)
  if (!fingerprint || fingerprint === watchState.lastFingerprint) return
  watchRunning = true
  try {
    const report = await executePipelineRun(root, preset.steps, '目录监控流水线')
    watchState.lastRunAt = new Date().toISOString()
    watchState.lastSummary = report.results.map((r) => r.summary).join('；')
    notifyIfBackground('目录监控已自动整理', watchState.lastSummary || '流水线完成')
  } catch {
    // 与手动流水线互斥冲突等情况直接跳过本轮
  } finally {
    watchRunning = false
    // 运行结果作为新基线：流水线自身写入不再触发二次运行
    watchState.lastFingerprint = await computeFingerprint(root, {
      concurrency: settings.scanConcurrency
    }).catch(() => watchState.lastFingerprint)
  }
}

const getWatchStatus = async (): Promise<WatchStatus> => {
  const settings = await settingsStore.get()
  return {
    enabled: settings.watch.enabled,
    watching: watchState.watching,
    root: watchState.root,
    lastRunAt: watchState.lastRunAt,
    lastSummary: watchState.lastSummary,
    error: watchState.error
  }
}

/** 流水线执行（手动触发与目录监控共用同一入口，互斥 + 事件 + 日志收口于此） */
async function executePipelineRun(
  root: string,
  steps: PipelineStep[],
  label = '流水线'
): Promise<PipelineReport> {
  const settings = await settingsStore.get()
  const total = steps.filter((s) => s.enabled).length
  return runExclusiveAbort('pipeline', label, async (signal, taskId) => {
    let completed = 0
    emitTask(taskId, label, { type: 'start', current: '准备执行流水线', total })
    const report = await runPipeline(root, steps, {
      taskCenter,
      concurrency: settings.concurrency,
      deleteFn: deleteFnOf(settings),
      signal,
      onStepStart: (step) => {
        emitTask(taskId, label, { type: 'progress', current: `执行步骤：${step.module}`, total })
      },
      onStepDone: (result) => {
        completed += 1
        emitTask(taskId, label, {
          type: 'progress',
          current: result.summary,
          total,
          completed,
          failed: result.success ? 0 : 1
        })
      }
    })
    emitTask(taskId, label, {
      type: report.cancelled ? 'cancelled' : 'done',
      current: report.cancelled ? '已取消' : '流水线完成',
      total,
      completed
    })
    logOp('pipeline', {
      root,
      steps,
      report,
      summary: report.results.map((r) => r.summary).join('；')
    })
    return report
  })
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
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
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
  ipcMain.handle('dialog:select-workspace', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    const selected = result.canceled ? null : result.filePaths[0]
    if (selected) await registerWorkspace(selected)
    return selected
  })
  // 渲染端恢复/拖拽工作区：校验目录存在后注册（media:// 白名单 + 最近列表）
  ipcMain.handle('workspace:use', async (_event, root: string) => {
    if (!(await pathExists(root))) throw new Error('目录不存在或不可读')
    await registerWorkspace(root)
    return root
  })
  ipcMain.handle('workspace:scan-plan', async (_event, root: string) => {
    setWorkspaceRoot(root)
    const settings = await settingsStore.get()
    return trackScan('扫描工作区', (onProgress) =>
      createScanPlan(root, { onProgress, concurrency: settings.scanConcurrency })
    )
  })
  ipcMain.handle('workspace:fingerprint', async (_event, root: string) => {
    const settings = await settingsStore.get()
    return trackScan('检查工作区变化', (onProgress) =>
      computeFingerprint(root, { onProgress, concurrency: settings.scanConcurrency })
    )
  })
  ipcMain.handle('settings:get', async () => settingsStore.get())
  ipcMain.handle('settings:update', async (_event, patch: Partial<AppSettings>) => {
    const updated = await settingsStore.update(patch)
    // 运行时同步 FFmpeg 进程池大小与目录监控
    if (updated.ffmpegPoolSize) setPoolSize(updated.ffmpegPoolSize)
    if (patch.watch) await refreshWatcher()
    return updated
  })
  ipcMain.handle('clean:execute', async (_event, plan: ScanPlan, picks: PosterPicks) =>
    runExclusive('clean', '清理', async (taskId) => {
      const settings = await settingsStore.get()
      const report = await executeCleanPlan(plan, {
        picks,
        taskCenter,
        taskId,
        concurrency: settings.concurrency,
        deleteFn: deleteFnOf(settings),
        onMoveProgress: (text) =>
          emitTask(taskId, '上移保留文件', { type: 'progress', current: text })
      })
      logOp('clean', {
        root: plan.root,
        report,
        summary: `删除 ${report.deletedCount}，上移 ${report.moved.length}，转码 ${report.converted.length}`
      })
      return report
    })
  )
  ipcMain.handle('clean:cancel', async () => cancelSlot('clean'))

  // ---------- 模块四：封面管理 ----------
  ipcMain.handle('poster:list', async (_event, root: string) => {
    setWorkspaceRoot(root)
    const settings = await settingsStore.get()
    return trackScan('扫描视频列表', (onProgress) =>
      listPosterVideos(root, { onProgress, concurrency: settings.scanConcurrency })
    )
  })
  ipcMain.handle('poster:capture', async (_event, root: string, relativePaths: string[]) =>
    runExclusive('poster', '截帧', async (taskId) => {
      const settings = await settingsStore.get()
      const result = await taskCenter.run({
        taskId,
        label: '截取候选封面',
        items: relativePaths,
        concurrency: settings.concurrency,
        worker: async (relativePath, signal) => {
          const frames = await captureCandidates(join(root, relativePath), framesRoot, {
            ffmpegPath: resolveFfmpegPath(),
            ffprobePath: resolveFfprobePath(),
            signal
          })
          return { relativePath, frames }
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
                  error: entry.error ?? '已取消'
                }
          )
          .filter(Boolean)
      }
    })
  )
  ipcMain.handle('poster:capture-at', async (_event, videoPath: string, seconds: number) =>
    captureAt(videoPath, seconds, framesRoot, { ffmpegPath: resolveFfmpegPath() })
  )
  ipcMain.handle(
    'poster:save',
    async (
      _event,
      payload: { videoPath: string; chosenFramePath: string; oldPosterPath: string | null }
    ) => savePoster(payload)
  )
  ipcMain.handle(
    'poster:save-batch',
    async (_event, videos: PosterVideoItem[], selections: Record<string, string>) =>
      runExclusive('poster', '封面', async (taskId) => {
        const items = computePendingSaves(videos, selections)
        if (items.length === 0)
          return { cancelled: false, savedCount: 0, failedCount: 0, outcomes: [] }
        const settings = await settingsStore.get()
        const result = await taskCenter.run({
          taskId,
          label: '批量保存封面',
          items,
          concurrency: settings.concurrency,
          worker: async (item) => {
            const saved = await savePoster(item)
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
    const settings = await settingsStore.get()
    const result = await taskCenter.run({
      taskId: newTaskId('probe'),
      label: '探测真实容器',
      items: relativePaths,
      concurrency: settings.concurrency,
      worker: async (relativePath) => {
        const info = await probeMedia(join(root, relativePath), resolveFfprobePath())
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
  ipcMain.handle('rename:ai', async (_event, files: AiFileInput[]) => {
    const settings = await settingsStore.get()
    const provider = activeProvider(settings)
    // 接入全局进度条：AI 生成按批次上报进度
    const taskId = newTaskId('ai')
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
        onBatch: (done) => emit('progress', done, `已生成 ${done}/${files.length}`)
      })
      emit('done', files.length, '完成')
      return names
    } catch (error) {
      emit('done', 0, '失败')
      throw error
    }
  })
  ipcMain.handle('rename:execute', async (_event, root: string, pairs: RenamePairInput[]) =>
    runExclusive('rename', '重命名', async (taskId) => {
      // 上次崩溃残留的临时文件先续跑收尾（S8）
      await recoverRenameJournal(renameJournalPath).catch(() => null)
      const settings = await settingsStore.get()
      const report = await executeRename(root, pairs, {
        taskCenter,
        taskId,
        concurrency: settings.concurrency,
        journalPath: renameJournalPath
      })
      logOp('rename', { root, report, summary: `改名 ${report.renamedCount} 项` })
      return report
    })
  )
  ipcMain.handle('rename:cancel', async () => cancelSlot('rename'))

  // ---------- 模块五：NFO 归档 ----------
  ipcMain.handle('nfo:plan', async (_event, root: string) => {
    setWorkspaceRoot(root)
    const settings = await settingsStore.get()
    return trackScan('生成归档计划', (onProgress) =>
      createNfoPlan(root, { onProgress, concurrency: settings.scanConcurrency })
    )
  })
  ipcMain.handle(
    'nfo:execute',
    async (_event, root: string, items: NfoPlanItem[], actorName: string) =>
      runExclusive('nfo', '归档', async (taskId) => {
        const settings = await settingsStore.get()
        const report = await executeNfoPlan(root, items, actorName, {
          taskCenter,
          taskId,
          concurrency: settings.concurrency
        })
        logOp('nfo', { root, actorName, report, summary: `归档 ${report.archivedCount} 个视频` })
        return report
      })
  )
  ipcMain.handle('nfo:cancel', async () => cancelSlot('nfo'))

  // ---------- 模块二：视频合并 ----------
  ipcMain.handle('merge:scan', async (_event, root: string) => {
    setWorkspaceRoot(root)
    const settings = await settingsStore.get()
    // 排除本产品生成的合并产物，避免再次参与合并
    const videos = (
      await trackScan<PosterVideoItem[]>('扫描视频列表', (onProgress) =>
        listPosterVideos(root, { onProgress, concurrency: settings.scanConcurrency })
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
    const freeBytes = await diskFreeBytes(root).catch(() => 0)
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
        const emit = (type: TaskEvent['type'], percent: number, stage: string): void =>
          emitTask(taskId, '视频合并', { type, total: 100, completed: percent, current: stage })
        emit('start', 0, '准备合并')
        const result = await mergeVideos({
          items: items.map((item) => ({ path: item.path, name: item.name, media: item.media })),
          outputDir: root,
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
    const settings = await settingsStore.get()
    const report = await deleteMergeSources(root, items, {
      taskCenter,
      taskId: newTaskId('merge-clean'),
      concurrency: settings.concurrency,
      deleteFn: deleteFnOf(settings)
    })
    logOp('merge-delete-sources', {
      root,
      items,
      report,
      summary: `删除源文件 ${report.deletedCount} 个`
    })
    return report
  })
  ipcMain.handle('merge:cancel', async () => abortSlot('merge'))

  // ---------- 视频去重 ----------
  ipcMain.handle('dedupe:scan', async (_event, root: string) => {
    const settings = await settingsStore.get()
    return findDuplicates(root, {
      taskCenter,
      taskId: newTaskId('dedupe'),
      concurrency: settings.concurrency,
      ffprobePath: resolveFfprobePath()
    })
  })
  ipcMain.handle('dedupe:delete', async (_event, root: string, relativePaths: string[]) => {
    const settings = await settingsStore.get()
    const doDelete = deleteFnOf(settings)
    const result = await taskCenter.run({
      taskId: newTaskId('dedupe-delete'),
      label: '删除重复视频',
      items: relativePaths,
      concurrency: settings.concurrency,
      worker: async (relativePath) => {
        await doDelete(join(root, relativePath))
      }
    })
    const report = {
      cancelled: result.cancelled,
      deletedCount: result.completed,
      failed: [] as { target: string; error: string }[]
    }
    collectFailures(report, result, relativePaths)
    logOp('dedupe-delete', {
      root,
      items: relativePaths,
      report,
      summary: `删除重复文件 ${result.completed} 个`
    })
    return report
  })

  // ---------- 完整性体检（F3） ----------
  ipcMain.handle('health:scan', async (_event, root: string) =>
    runExclusive('health', '体检', async (taskId) => {
      const settings = await settingsStore.get()
      return healthScan(root, {
        taskCenter,
        taskId,
        concurrency: settings.concurrency,
        ffmpegPath: resolveFfmpegPath()
      })
    })
  )
  ipcMain.handle('health:cancel', async () => cancelSlot('health'))

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

  // ---------- 自动化流水线 ----------
  ipcMain.handle('pipeline:execute', async (_event, root: string, steps: PipelineStep[]) =>
    executePipelineRun(root, steps)
  )
  ipcMain.handle('pipeline:cancel', async () => abortSlot('pipeline'))

  // ---------- 目录监控（F4） ----------
  ipcMain.handle('watch:status', async () => getWatchStatus())

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
    installingUpdate = true
    autoUpdater.quitAndInstall()
  })
  ipcMain.handle('update:get-status', async () => updateStatus)
  ipcMain.handle('app:version', async () => app.getVersion())

  // ---------- 操作日志 ----------
  ipcMain.handle('op-logs:list', async () => listOpLogs(opLogDir))
  ipcMain.handle('op-logs:reveal', async (_event, file: string) => {
    shell.showItemInFolder(file)
  })
  // 一键撤销（F2）：按日志反向恢复重命名/NFO 归档
  ipcMain.handle('op-logs:undo', async (_event, file: string) =>
    runExclusive('undo', '撤销', async (taskId) => {
      const settings = await settingsStore.get()
      const report = await undoOpLog(file, {
        taskCenter,
        taskId,
        concurrency: settings.concurrency
      })
      logOp('undo', {
        file,
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
    // 渲染端格式：media://local<encodeURI(绝对路径)>
    const decoded = decodeURIComponent(new URL(request.url).pathname)
    const filePath = /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded
    if (!isMediaAllowed(filePath)) {
      return new Response('Forbidden', { status: 403 })
    }
    // 视频拖动进度条依赖 Range 请求，透传给文件读取
    const fetchHeaders = new Headers()
    const range = request.headers.get('range')
    if (range) fetchHeaders.set('range', range)
    const response = await net.fetch(pathToFileURL(filePath).toString(), {
      headers: fetchHeaders
    })
    // 封面保存是同路径就地覆盖写入，必须禁止图片缓存，否则界面展示旧图
    if (IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())) {
      const headers = new Headers(response.headers)
      headers.set('Cache-Control', 'no-store')
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      })
    }
    return response
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
    stopWatcher()
    if (taskCenter.hasActive() || abortSlots.size > 0) {
      taskCenter.cancelAll()
      for (const controller of abortSlots.values()) controller.abort()
    }
    // 兜底强杀所有活跃子进程（ffmpeg/ffprobe），防退出后孤儿进程死占用 CPU/内存
    if (activeProcessCount() > 0) killAllActiveProcesses()
    if (taskCenter.hasActive() || abortSlots.size > 0) {
      // 给 AbortSignal 传递与在途进程退出留出收尾窗口
      await new Promise((resolve) => setTimeout(resolve, 600))
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
