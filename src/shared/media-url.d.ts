declare module './media-url.mjs' {
  /** 将本地绝对路径编码为 media:// URL（渲染端与回归测试共用）。 */
  export function mediaUrl(absolutePath: string): string
}
