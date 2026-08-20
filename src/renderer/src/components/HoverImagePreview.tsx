import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface PreviewSize {
  width: number
  height: number
}

interface PreviewPosition extends PreviewSize {
  left: number
  top: number
}

const PREVIEW_MAX_WIDTH = 560
const PREVIEW_MAX_HEIGHT = 620
const PREVIEW_GAP = 18
const VIEWPORT_MARGIN = 12

function sizeForImage(naturalWidth: number, naturalHeight: number): PreviewSize {
  const maxWidth = Math.min(PREVIEW_MAX_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)
  const maxHeight = Math.min(PREVIEW_MAX_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2)
  const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight, 1)
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale))
  }
}

function positionPreview(
  clientX: number,
  clientY: number,
  { width, height }: PreviewSize
): PreviewPosition {
  const fitsRight = clientX + PREVIEW_GAP + width <= window.innerWidth - VIEWPORT_MARGIN
  const preferredLeft = fitsRight ? clientX + PREVIEW_GAP : clientX - PREVIEW_GAP - width

  return {
    width,
    height,
    left: Math.max(
      VIEWPORT_MARGIN,
      Math.min(preferredLeft, window.innerWidth - width - VIEWPORT_MARGIN)
    ),
    top: Math.max(
      VIEWPORT_MARGIN,
      Math.min(clientY - height / 2, window.innerHeight - height - VIEWPORT_MARGIN)
    )
  }
}

function HoverImagePreview({
  src,
  alt,
  children
}: {
  src: string
  alt: string
  children: React.ReactNode
}): React.JSX.Element {
  const [preview, setPreview] = useState<PreviewPosition | null>(null)
  const imageSizeRef = useRef<PreviewSize | null>(null)
  const loadingRef = useRef(false)
  const pointerRef = useRef<{ clientX: number; clientY: number } | null>(null)

  const show = useCallback(
    (clientX: number, clientY: number) => {
      pointerRef.current = { clientX, clientY }
      if (imageSizeRef.current) {
        setPreview(positionPreview(clientX, clientY, imageSizeRef.current))
        return
      }
      if (loadingRef.current) return

      loadingRef.current = true
      const image = new Image()
      image.onload = () => {
        imageSizeRef.current = sizeForImage(image.naturalWidth, image.naturalHeight)
        loadingRef.current = false
        const pointer = pointerRef.current
        if (pointer && imageSizeRef.current) {
          setPreview(positionPreview(pointer.clientX, pointer.clientY, imageSizeRef.current))
        }
      }
      image.onerror = () => {
        loadingRef.current = false
      }
      image.src = src
    },
    [src]
  )

  const hide = useCallback(() => {
    pointerRef.current = null
    setPreview(null)
  }, [])

  return (
    <>
      <span
        className="hover-image-trigger"
        onPointerEnter={(event) => show(event.clientX, event.clientY)}
        onPointerMove={(event) => show(event.clientX, event.clientY)}
        onPointerLeave={hide}
        onFocus={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          show(rect.left + rect.width / 2, rect.top + rect.height / 2)
        }}
        onBlur={hide}
      >
        {children}
      </span>
      {preview &&
        createPortal(
          <span
            className="hover-image-preview"
            style={{
              left: preview.left,
              top: preview.top,
              width: preview.width,
              height: preview.height
            }}
            aria-hidden="true"
          >
            <img src={src} alt={alt} />
          </span>,
          document.body
        )}
    </>
  )
}

export default HoverImagePreview
