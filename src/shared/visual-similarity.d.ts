declare module './visual-similarity.mjs' {
  /** 从灰度像素计算 64 位十六进制差值感知哈希。 */
  export function computeDifferenceHash(data: Uint8Array, width: number, height: number): string
  /** 两个十六进制感知哈希的汉明距离（0–64）。 */
  export function hammingDistance(left: string, right: string): number
  /** 返回至少包含两个候选项的稳定相似组（输入索引）。 */
  export function groupSimilarHashes(
    hashes: Array<string | undefined>,
    threshold?: number
  ): number[][]
}
