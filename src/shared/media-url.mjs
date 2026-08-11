/**
 * 将本地绝对路径编码为 media:// URL。
 * 此规则由渲染端与 Node 回归测试共用，防止两端各自实现后发生漂移。
 */
export function mediaUrl(absolutePath) {
  const normalized = String(absolutePath).replaceAll('\\', '/')
  const encoded = normalized.split('/').map(encodeURIComponent).join('/')
  // URL 的 host 必须固定为 local。普通绝对路径需要额外的 /，使 C: 落在 pathname 内；
  // UNC 路径保留原本的双斜杠，供主进程还原为 \\server\share。
  return normalized.startsWith('//')
    ? `media://local${encoded}`
    : `media://local/${encoded.replace(/^\/+/, '')}`
}
