import * as Dialog from '@radix-ui/react-dialog'
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchRef
} from 'react-zoom-pan-pinch'
import { useEffect, useRef, useState } from 'react'

function ImageInspectorDialog({
  open,
  src,
  title,
  alt,
  onOpenChange
}: {
  open: boolean
  src: string
  title: string
  alt: string
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const transformRef = useRef<ReactZoomPanPinchRef | null>(null)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        transformRef.current?.zoomIn(0.25)
      } else if (event.key === '-') {
        event.preventDefault()
        transformRef.current?.zoomOut(0.25)
      } else if (event.key === '0') {
        event.preventDefault()
        transformRef.current?.resetTransform()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay inspector-overlay" />
        <Dialog.Content
          className="image-inspector-dialog"
          aria-describedby="image-inspector-help"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <header className="image-inspector-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description id="image-inspector-help">
                滚轮或 + / - 缩放，拖拽平移，按 0 复位。
              </Dialog.Description>
            </div>
            <Dialog.Close className="chip-remove" aria-label="关闭大图检查器">
              关闭
            </Dialog.Close>
          </header>
          <div className="image-inspector-stage">
            <TransformWrapper
              ref={transformRef}
              initialScale={1}
              minScale={0.5}
              maxScale={5}
              centerOnInit
              wheel={{ step: 0.16 }}
              doubleClick={{ mode: 'toggle', step: 1.8 }}
              onTransform={(ref) => setScale(ref.state.scale)}
            >
              {({ zoomIn, zoomOut, resetTransform }) => (
                <>
                  <TransformComponent
                    wrapperClass="image-inspector-transform"
                    contentClass="image-inspector-content"
                  >
                    <img src={src} alt={alt} draggable={false} />
                  </TransformComponent>
                  <div className="image-inspector-controls" aria-label="图片缩放控制">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => zoomOut(0.25)}
                      aria-label="缩小图片"
                    >
                      −
                    </button>
                    <output aria-live="polite">{Math.round(scale * 100)}%</output>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => zoomIn(0.25)}
                      aria-label="放大图片"
                    >
                      +
                    </button>
                    <button type="button" className="secondary" onClick={() => resetTransform()}>
                      适应窗口
                    </button>
                  </div>
                </>
              )}
            </TransformWrapper>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export default ImageInspectorDialog
