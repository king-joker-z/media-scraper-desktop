import { app, shell, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createScanPlan } from './core/scanner.mjs'
import { createSettingsStore } from './core/settings.mjs'
import { createTaskCenter } from './core/task-center.mjs'
import type { AppSettings, TaskEvent } from '../shared/types'

const settingsStore = createSettingsStore(join(app.getPath('userData'), 'settings.json'))

const broadcastTaskEvent = (event: TaskEvent): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('tasks:event', event)
  }
}

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

function registerIpcHandlers(): void {
  ipcMain.handle('dialog:select-workspace', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('workspace:scan-plan', async (_event, root: string) => createScanPlan(root))
  ipcMain.handle('settings:get', async () => settingsStore.get())
  ipcMain.handle('settings:update', async (_event, patch: Partial<AppSettings>) =>
    settingsStore.update(patch)
  )
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.mediascraper.desktop')

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
