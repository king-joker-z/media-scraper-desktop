import { app, shell, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron'
import { join, sep } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createScanPlan } from './core/scanner.mjs'
import { createSettingsStore } from './core/settings.mjs'
import { createTaskCenter } from './core/task-center.mjs'
import { resolveFfmpegPath } from './core/frames.mjs'
import { resolveFfprobePath } from './core/probe.mjs'
import { executeCleanPlan } from './modules/clean/execute.mjs'
import {
  captureAt,
  captureCandidates,
  listPosterVideos,
  savePoster
} from './modules/poster/poster.mjs'
import type { AppSettings, PosterPicks, ScanPlan, TaskEvent } from '../shared/types'

const settingsStore = createSettingsStore(join(app.getPath('userData'), 'settings.json'))
const framesRoot = join(app.getPath('temp'), 'media-scraper-frames')

/**
 * media:// 自定义协议：向渲染进程提供本地图片/视频。
 * 只允许访问已选工作区与截帧临时目录，防止任意文件读取。
 */
const allowedRoots = new Set<string>([framesRoot])
const allowMediaRoot = (root: string): void => {
  allowedRoots.add(root)
}
const isMediaAllowed = (filePath: string): boolean => {
  for (const root of allowedRoots) {
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

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8',
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

let activeCleanTaskId: string | null = null
let activePosterTaskId: string | null = null

function registerIpcHandlers(): void {
  ipcMain.handle('dialog:select-workspace', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    const selected = result.canceled ? null : result.filePaths[0]
    if (selected) allowMediaRoot(selected)
    return selected
  })
  ipcMain.handle('workspace:scan-plan', async (_event, root: string) => {
    allowMediaRoot(root)
    return createScanPlan(root)
  })
  ipcMain.handle('settings:get', async () => settingsStore.get())
  ipcMain.handle('settings:update', async (_event, patch: Partial<AppSettings>) =>
    settingsStore.update(patch)
  )
  ipcMain.handle('clean:execute', async (_event, plan: ScanPlan, picks: PosterPicks) => {
    if (activeCleanTaskId) throw new Error('已有清理任务在执行中')
    const settings = await settingsStore.get()
    activeCleanTaskId = `clean-${Date.now()}`
    try {
      return await executeCleanPlan(plan, {
        picks,
        taskCenter,
        taskId: activeCleanTaskId,
        concurrency: settings.concurrency
      })
    } finally {
      activeCleanTaskId = null
    }
  })
  ipcMain.handle('clean:cancel', async () => {
    if (activeCleanTaskId) taskCenter.cancel(activeCleanTaskId)
  })

  // ---------- 模块四：封面管理 ----------
  ipcMain.handle('poster:list', async (_event, root: string) => {
    allowMediaRoot(root)
    return listPosterVideos(root)
  })
  ipcMain.handle('poster:capture', async (_event, root: string, relativePaths: string[]) => {
    if (activePosterTaskId) throw new Error('已有截帧任务在执行中')
    const settings = await settingsStore.get()
    activePosterTaskId = `poster-${Date.now()}`
    const taskId = activePosterTaskId
    try {
      const result = await taskCenter.run({
        taskId,
        label: '截取候选封面',
        items: relativePaths,
        concurrency: settings.concurrency,
        worker: async (relativePath) => {
          const frames = await captureCandidates(join(root, relativePath), framesRoot, {
            ffmpegPath: resolveFfmpegPath(),
            ffprobePath: resolveFfprobePath()
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
    } finally {
      activePosterTaskId = null
    }
  })
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
  ipcMain.handle('poster:cancel', async () => {
    if (activePosterTaskId) taskCenter.cancel(activePosterTaskId)
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.mediascraper.desktop')

  protocol.handle('media', (request) => {
    // 渲染端格式：media://local<encodeURI(绝对路径)>
    const decoded = decodeURIComponent(new URL(request.url).pathname)
    const filePath = /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded
    if (!isMediaAllowed(filePath)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
