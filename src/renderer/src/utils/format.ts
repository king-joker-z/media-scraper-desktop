export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 毫秒时长 → m:ss（媒体库/去重/合并列表共用，原先三处复制） */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 取路径末段（跨平台分隔符；侧边栏工作区/最近列表共用） */
export function basenameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}
