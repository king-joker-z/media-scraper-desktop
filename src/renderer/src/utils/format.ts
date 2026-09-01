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

/** 毫秒 → 片场时码 HH:MM:SS.mmm（小时保留 00 定长，便于等宽对齐） */
export function formatTimecode(ms: number): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0')
  const totalMs = Math.max(0, Math.floor(ms))
  const hours = Math.floor(totalMs / 3_600_000)
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
  const seconds = Math.floor((totalMs % 60_000) / 1000)
  const millis = totalMs % 1000
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`
}

/** 取路径末段（跨平台分隔符；侧边栏工作区/最近列表共用） */
export function basenameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/**
 * 跨平台拼接「绝对根路径 + 相对路径」（渲染端无 Node path 模块）。
 * 统一用正斜杠拼接：主进程 media:// 与 fs 均接受正斜杠（Windows 亦兼容），
 * 避免硬编码 `${root}/${rel}` 在反斜杠根路径下拼出混合格式。
 */
export function joinPath(root: string, rel: string): string {
  const cleanRoot = root.replace(/[\\/]+$/, '')
  const cleanRel = rel.replace(/^[\\/]+/, '')
  return `${cleanRoot}/${cleanRel}`
}
