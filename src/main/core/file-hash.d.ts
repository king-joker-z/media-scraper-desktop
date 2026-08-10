declare module './file-hash.mjs' {
  export function hashFileSample(filePath: string, sampleSize?: number): Promise<string>
  /** 带缓存的采样哈希：按 path+mtime+size 命中，LRU 淘汰 */
  export function hashFileSampleCached(
    filePath: string,
    sampleSize?: number,
    hashFn?: (filePath: string, sampleSize?: number) => Promise<string>
  ): Promise<string>
  export function clearHashCache(): void
}
