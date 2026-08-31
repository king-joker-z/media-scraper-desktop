/**
 * 仅允许主窗口留在应用入口：
 * - 开发环境允许同一 Vite origin（HMR 与前端路由均不受影响）；
 * - 打包环境只允许实际加载的 file:// 入口文件。
 */
export function isAllowedMainFrameNavigation(target, appEntryUrl) {
  try {
    const targetUrl = new URL(target)
    const entryUrl = new URL(appEntryUrl)
    if (entryUrl.protocol === 'http:' || entryUrl.protocol === 'https:') {
      return targetUrl.origin === entryUrl.origin
    }
    return (
      entryUrl.protocol === 'file:' &&
      targetUrl.protocol === 'file:' &&
      targetUrl.pathname === entryUrl.pathname
    )
  } catch {
    return false
  }
}
