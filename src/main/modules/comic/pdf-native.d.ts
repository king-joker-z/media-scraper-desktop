declare module './pdf-native.mjs' {
  export const STREAM_PDF_ENGINE: {
    id: 'stream-pdf'
    label: string
  }

  export function buildNativePdfPageObjects(input: {
    index: number
    width: number
    height: number
    imageLength: number
  }): {
    pageId: number
    contentId: number
    imageId: number
    pageWidth: number
    pageHeight: number
    page: string
    content: string
    imageStart: string
  }

  export function createNativePdfFile(input: {
    outputPath: string
    title: string
    pageCount: number
    pages: AsyncIterable<{ data: Buffer; width: number; height: number; ext: string }>
    signal?: AbortSignal
    onPage?: (count: number) => void
    /** 仅供测试注入写流；生产环境默认使用统一 fs-ops 写流。 */
    createWriteStream?: (
      path: string,
      options?: import('node:fs').WriteStreamOptions
    ) => import('node:stream').Writable
  }): Promise<{ pageCount: number; engine: 'stream-pdf' }>

  /** 完整解析暂存 PDF；会额外将文件读入内存以保证提交可靠性。 */
  export function verifyNativePdfFile(path: string, expectedPages: number): Promise<void>
}
