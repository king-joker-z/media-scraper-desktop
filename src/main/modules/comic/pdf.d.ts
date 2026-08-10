declare module './pdf.mjs' {
  /** PDF 页面：仅 jpg/png（其他格式由调用方转码为 jpg） */
  export interface PdfPage {
    data: Uint8Array
    width: number
    height: number
    ext: 'jpg' | 'png'
  }

  /** 新建 PDF（一图一页，页尺寸 = 图片像素） */
  export function createPdf(input: { title: string; pages: PdfPage[] }): Promise<Uint8Array>

  /** 增量追加：既有 PDF 末尾顺序补页 */
  export function appendPdf(
    existingBytes: Uint8Array,
    input: { pages: PdfPage[] }
  ): Promise<Uint8Array>

  /** 重新解析 PDF 并校验页数 */
  export function verifyPdfFile(path: string, expectedPages: number): Promise<void>
}
