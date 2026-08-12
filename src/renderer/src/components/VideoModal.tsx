import { useRef } from 'react'
import { mediaUrl, touchPlayPosition } from '../utils/media'

/** 通用视频试看弹窗（合并页预览 / 媒体库点播共用）；传 rememberKey 时记忆播放进度 */
function VideoModal({
  path,
  title,
  rememberKey,
  onClose
}: {
  path: string
  title: string
  /** 传入后按 key 记忆播放进度（localStorage） */
  rememberKey?: string
  onClose: () => void
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const storageKey = rememberKey ? `msd-play-${rememberKey}` : null

  const savePosition = (): void => {
    if (!storageKey || !videoRef.current) return
    const { currentTime, duration } = videoRef.current
    // 看完（距结尾 5 秒内）则清除记录
    if (duration && duration - currentTime < 5) localStorage.removeItem(storageKey)
    else {
      localStorage.setItem(storageKey, String(currentTime))
      // 写入索引供过期清理（30 天未播的记录会被自动移除）
      touchPlayPosition(storageKey)
    }
  }

  // 只在用户真正关闭弹窗时释放媒体，不能放进 effect cleanup：Strict Mode 会模拟卸载导致 src 被提前移除。
  const close = (): void => {
    savePosition()
    const video = videoRef.current
    if (video) {
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
    onClose()
  }

  return (
    <div className="dialog-overlay" onClick={close}>
      <div
        className="detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`播放视频：${title}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="detail-header">
          <b>{title}</b>
          <button className="chip-remove" aria-label="关闭视频播放器" onClick={close}>
            关闭
          </button>
        </div>
        <video
          ref={videoRef}
          src={mediaUrl(path)}
          controls
          autoPlay
          className="detail-player"
          onLoadedMetadata={() => {
            if (storageKey && videoRef.current) {
              const saved = Number(localStorage.getItem(storageKey) ?? 0)
              if (saved > 0 && saved < videoRef.current.duration - 5) {
                videoRef.current.currentTime = saved
              }
            }
          }}
          onPause={savePosition}
        />
      </div>
    </div>
  )
}

export default VideoModal
