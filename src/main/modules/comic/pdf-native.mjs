import { createFileWriteStream, overwriteFileRange } from '../../core/fs-ops.mjs'
import { verifyPdfFile } from './pdf.mjs'

/**
 * 自建流式 PDF 写入器。
 * 每次仅持有一页 JPEG；图像预处理由调用方使用 Sharp 完成，此处只写入标准 PDF 对象和 JPEG
 * DCT 数据，不依赖 Sharp/libvips 的 PDF 输出能力。
 */

export const STREAM_PDF_ENGINE = {
  id: 'stream-pdf',
  label: '自建流式 PDF 写入器'
}

const MAX_PAGE_DIM = 14000

const pdfEscape = (value) =>
  String(value).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')

const pageObjectId = (index) => 4 + index * 3
const contentObjectId = (index) => pageObjectId(index) + 1
const imageObjectId = (index) => pageObjectId(index) + 2

/**
 * 为写流维持整个生命周期的 error 监听，同时正确等待背压和 finish。
 * 仅在暂存路径中使用，调用方必须在失败时丢弃该暂存文件。
 */
function createStreamWriter(stream) {
  let streamError = null
  const onError = (error) => {
    streamError = error
  }
  stream.on('error', onError)
  const throwIfFailed = () => {
    if (streamError) throw streamError
  }
  return {
    async write(chunk) {
      throwIfFailed()
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'binary')
      if (stream.write(buffer)) {
        throwIfFailed()
        return
      }
      await new Promise((resolve, reject) => {
        const onDrain = () => {
          cleanup()
          resolve()
        }
        const onWriteError = (error) => {
          cleanup()
          reject(error)
        }
        const cleanup = () => {
          stream.off('drain', onDrain)
          stream.off('error', onWriteError)
        }
        stream.once('drain', onDrain)
        stream.once('error', onWriteError)
      })
      throwIfFailed()
    },
    async finish() {
      throwIfFailed()
      await new Promise((resolve, reject) => {
        const onFinish = () => {
          cleanup()
          resolve()
        }
        const onFinishError = (error) => {
          cleanup()
          reject(error)
        }
        const cleanup = () => {
          stream.off('finish', onFinish)
          stream.off('error', onFinishError)
        }
        stream.once('finish', onFinish)
        stream.once('error', onFinishError)
        stream.end()
      })
      throwIfFailed()
    },
    destroy() {
      stream.destroy()
    }
  }
}

/**
 * 组装一个 JPEG 页的 PDF 对象。纯函数保留给无外网 CI 测试。
 * @param {{index: number, width: number, height: number, imageLength: number}} page
 */
export function buildNativePdfPageObjects({ index, width, height, imageLength }) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error('PDF 页面尺寸无效')
  }
  if (!Number.isInteger(imageLength) || imageLength < 1) throw new Error('PDF 图像数据为空')
  const scale = Math.min(1, MAX_PAGE_DIM / width, MAX_PAGE_DIM / height)
  const pageWidth = Math.max(1, Math.round(width * scale))
  const pageHeight = Math.max(1, Math.round(height * scale))
  const pageId = pageObjectId(index)
  const contentId = contentObjectId(index)
  const imageId = imageObjectId(index)
  const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im${index} Do\nQ\n`
  return {
    pageId,
    contentId,
    imageId,
    pageWidth,
    pageHeight,
    page: `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im${index} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
    content: `${contentId} 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream\nendobj\n`,
    imageStart: `${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageLength} >>\nstream\n`
  }
}

/**
 * 流式写入 PDF，pages 按顺序产出 {data,width,height,ext}；仅接受已确认兼容的 RGB JPEG。
 * @param {{outputPath: string, title: string, pageCount: number, pages: AsyncIterable<{data: Buffer, width: number, height: number, ext: string}>, signal?: AbortSignal, onPage?: (count: number) => void}} input
 */
export async function createNativePdfFile({
  outputPath,
  title,
  pageCount: expectedPageCount,
  pages,
  signal,
  onPage,
  createWriteStream = createFileWriteStream
}) {
  const writer = createStreamWriter(createWriteStream(outputPath))
  let appendWriter = null
  const offsets = [0]
  let offset = 0
  let pageCount = 0
  const write = async (chunk) => {
    if (signal?.aborted) throw new Error('已取消')
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'binary')
    await writer.write(buffer)
    offset += buffer.length
  }
  const writeObject = async (id, content) => {
    offsets[id] = offset
    await write(content)
  }
  try {
    await write('%PDF-1.7\n%\xFF\xFF\xFF\xFF\n')
    await writeObject(1, '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /PageMode /UseNone >>\nendobj\n')
    // Pages 根对象在全部页数确定后回填。预留空间按已扫描页数计算，不随图片数据增长。
    offsets[2] = offset
    const pagesPlaceholder = Buffer.alloc(Math.max(1024, expectedPageCount * 24 + 256), 0x20)
    await write(pagesPlaceholder)
    await writeObject(
      3,
      `3 0 obj\n<< /Title (${pdfEscape(title)}) /Producer (${pdfEscape(STREAM_PDF_ENGINE.label)}) >>\nendobj\n`
    )
    for await (const page of pages) {
      if (page.ext !== 'jpg' || !Buffer.isBuffer(page.data)) {
        throw new Error('流式 PDF 仅接受 RGB JPEG 页面')
      }
      const objects = buildNativePdfPageObjects({
        index: pageCount,
        width: page.width,
        height: page.height,
        imageLength: page.data.length
      })
      await writeObject(objects.pageId, objects.page)
      await writeObject(objects.contentId, objects.content)
      await writeObject(objects.imageId, objects.imageStart)
      await write(page.data)
      await write('\nendstream\nendobj\n')
      pageCount += 1
      onPage?.(pageCount)
    }
    if (pageCount === 0) throw new Error('没有可写入 PDF 的页面')
    if (pageCount !== expectedPageCount) throw new Error('PDF 页面数量在写入期间发生变化')
    const kids = Array.from({ length: pageCount }, (_, index) => `${pageObjectId(index)} 0 R`).join(
      ' '
    )
    const root = `2 0 obj\n<< /Type /Pages /Count ${pageCount} /Kids [${kids}] >>\nendobj\n`
    if (Buffer.byteLength(root) > pagesPlaceholder.length)
      throw new Error('PDF 页数超过流式写入器上限')
    // 页树必须位于预留区开头；先结束流再用随机写覆盖，避免 Windows 打开句柄冲突。
    await writer.finish()
    await overwriteFileRange(outputPath, Buffer.from(root), offsets[2])
    const xrefOffset = offset
    const xref = ['xref', `0 ${offsets.length}`, '0000000000 65535 f ']
    for (let id = 1; id < offsets.length; id += 1) {
      xref.push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n `)
    }
    const trailer = `${xref.join('\n')}\ntrailer\n<< /Size ${offsets.length} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    // 追加 xref 需重新打开；文件未正式提交，仍处于安全 staging。
    appendWriter = createStreamWriter(createWriteStream(outputPath, { flags: 'a' }))
    await appendWriter.write(trailer)
    await appendWriter.finish()
    return { pageCount, engine: STREAM_PDF_ENGINE.id }
  } catch (error) {
    writer.destroy()
    appendWriter?.destroy()
    throw error
  }
}

/**
 * 用 pdf-lib 完整解析并核对页数，防止只含 PDF 头/页对象/EOF 的损坏文件通过校验。
 * 这会在提交暂存文件前额外将整本 PDF 读入内存；以一次短暂峰值交换正式产物的可靠性。
 */
export async function verifyNativePdfFile(path, expectedPages) {
  await verifyPdfFile(path, expectedPages)
}
