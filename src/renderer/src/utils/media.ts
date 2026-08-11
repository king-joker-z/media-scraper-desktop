import { mediaUrl as encodeMediaUrl } from '../../../shared/media-url.mjs'

/** 将本地绝对路径转为 media:// 协议 URL（主进程白名单校验） */
export function mediaUrl(absolutePath: string): string {
  return encodeMediaUrl(absolutePath)
}

/* ---------------- 播放进度记忆（localStorage，带 30 天过期清理） ---------------- */

const PLAY_INDEX_KEY = 'msd-play-index'
const PLAY_KEY_PREFIX = 'msd-play-'
/** 播放进度保留时长：30 天 */
const PLAY_POSITION_TTL_MS = 30 * 24 * 60 * 60 * 1000

type PlayIndex = Record<string, number>

function readIndex(): PlayIndex {
  try {
    const raw = localStorage.getItem(PLAY_INDEX_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 记录一次播放进度时间戳（VideoModal 保存进度时调用） */
export function touchPlayPosition(storageKey: string): void {
  const index = readIndex()
  index[storageKey] = Date.now()
  try {
    localStorage.setItem(PLAY_INDEX_KEY, JSON.stringify(index))
  } catch {
    // 存储满时静默失败
  }
}

/**
 * 清理过期播放进度：超过 30 天未播放的记录连同索引一并删除，
 * 防止 localStorage 随视频积累无限增长。应用启动时调用一次。
 */
export function prunePlayPositions(now = Date.now()): void {
  const index = readIndex()
  const next: PlayIndex = {}
  let changed = false
  for (const [key, at] of Object.entries(index)) {
    if (typeof at === 'number' && now - at < PLAY_POSITION_TTL_MS) {
      next[key] = at
    } else {
      localStorage.removeItem(key)
      changed = true
    }
  }
  // 索引外的孤儿 key（老版本直接写的 msd-play-*）无法批量枚举，保持原样
  if (changed || Object.keys(index).length !== Object.keys(next).length) {
    try {
      localStorage.setItem(PLAY_INDEX_KEY, JSON.stringify(next))
    } catch {
      // 忽略
    }
  }
}

export { PLAY_KEY_PREFIX }
