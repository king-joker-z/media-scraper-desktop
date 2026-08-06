import { mediaUrl } from '../utils/media'

/** 通用视频试看弹窗（合并页预览 / 媒体库点播共用） */
function VideoModal({
  path,
  title,
  onClose
}: {
  path: string
  title: string
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="detail-modal" onClick={(event) => event.stopPropagation()}>
        <div className="detail-header">
          <b>{title}</b>
          <button className="chip-remove" onClick={onClose}>
            关闭
          </button>
        </div>
        <video src={mediaUrl(path)} controls autoPlay className="detail-player" />
      </div>
    </div>
  )
}

export default VideoModal
