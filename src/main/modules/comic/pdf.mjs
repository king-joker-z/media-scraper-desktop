import { PDFDocument } from 'pdf-lib'

/**
 * PDF 漫画书构建器（pdf-lib，纯 JS）：
 * - 一图一页，页尺寸 = 图片像素（1px = 1pt），阅读器按页适配；
 * - JPEG/PNG 直接嵌入不重编码（体积小、速度快、零画质损失）；
 * - PDF 规范单页上限 14400pt：条漫长图按比例缩页框（图像数据不变，仅显示缩放）；
 * - 支持增量追加：load 既有 PDF 后顺序补页（原页面字节级保留）。
 *
 * 页面对象：{ data: Uint8Array, width: number, height: number, ext: 'jpg'|'png' }
 * （其他格式由调用方先经 sharp 转码为 jpg）
 */

const MAX_PAGE_DIM = 14000

async function embedPage(doc, page) {
  const image = page.ext === 'png' ? await doc.embedPng(page.data) : await doc.embedJpg(page.data)
  const scale = Math.min(1, MAX_PAGE_DIM / page.width, MAX_PAGE_DIM / page.height)
  const width = Math.max(1, Math.round(page.width * scale))
  const height = Math.max(1, Math.round(page.height * scale))
  const pdfPage = doc.addPage([width, height])
  pdfPage.drawImage(image, { x: 0, y: 0, width, height })
}

/**
 * 新建 PDF。
 * @param {{title: string, pages: Array}} input
 * @returns {Promise<Uint8Array>}
 */
export async function createPdf({ title, pages }) {
  const doc = await PDFDocument.create()
  doc.setTitle(title)
  doc.setProducer('Media Scraper Desktop')
  doc.setCreationDate(new Date())
  for (const page of pages) await embedPage(doc, page)
  return doc.save()
}

/**
 * 增量追加：既有 PDF 末尾顺序补页。
 * @param {Uint8Array} existingBytes
 * @param {{pages: Array}} input
 * @returns {Promise<Uint8Array>}
 */
export async function appendPdf(existingBytes, { pages }) {
  const doc = await PDFDocument.load(existingBytes, { updateMetadata: false })
  doc.setModificationDate(new Date())
  for (const page of pages) await embedPage(doc, page)
  return doc.save()
}
