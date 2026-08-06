declare module './file-hash.mjs' {
  export function hashFileSample(filePath: string, sampleSize?: number): Promise<string>
}
