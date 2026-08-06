/** 将本地绝对路径转为 media:// 协议 URL（主进程白名单校验） */
export function mediaUrl(absolutePath: string): string {
  const normalized = absolutePath.replaceAll('\\', '/')
  return `media://local${encodeURI(normalized)}`
}
