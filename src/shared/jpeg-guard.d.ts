declare module './jpeg-guard.mjs' {
  /** JPEG 结构异常描述：kind 为 'junk-before-sos' | 'junk-in-scan' | 'trailing-data' | 'truncated' | 'nested-soi' */
  export interface JpegAnomaly {
    kind: string
    /** 异常起始字节偏移 */
    offset: number
    /** 异常字节数 */
    bytes: number
  }

  export interface JpegAnalysis {
    /** 是否以 SOI 开头的 JPEG */
    jpeg: boolean
    anomalies: JpegAnomaly[]
  }

  /** 按 JPEG 规范遍历标记流，返回结构完整性分析结果。 */
  export function analyzeJpeg(bytes: Uint8Array | Buffer): JpegAnalysis

  /** 是否需要转码修复（非 JPEG 内容或存在除 trailing-data 外的结构异常）。 */
  export function needsJpegRepair(bytes: Uint8Array | Buffer): boolean
}
