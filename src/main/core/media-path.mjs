import { resolve } from 'node:path'

/**
 * media:// 协议路径解析（纯函数，可单测）：
 * 渲染端 mediaUrl() 把本地绝对路径统一为正斜杠并逐段编码，
 * 主进程在此还原与归一化，供白名单校验。
 */

/**
 * media:// URL 解码后的路径 → 本地文件路径。
 * - `/C:/a/b` → `C:/a/b`（Windows 盘符，去掉协议占位的前导斜杠）
 * - `//NAS/share/a` → 保留双斜杠（UNC：win32 resolve 识别为 \\NAS\share）
 * - resolve 归一化 `..` 与分隔符，防路径穿越绕过白名单（如 C:/ws/../elsewhere）
 */
export function mediaUrlPathToLocal(decoded) {
  const raw = /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded
  return resolve(raw)
}

/**
 * 白名单比较用归一化：统一正斜杠、去尾部分隔符、盘符统一大写。
 * Windows 上工作区根来自系统对话框（反斜杠），而 media:// URL 解码后是正斜杠，
 * 不归一化会导致白名单全部误判 403；UNC 路径（\\NAS\share）同样归一为 //NAS/share。
 */
export function normalizeMediaPath(p) {
  let n = String(p).replaceAll('\\', '/').replace(/\/+$/, '')
  if (/^[a-z]:\//.test(n)) n = n[0].toUpperCase() + n.slice(1)
  return n
}

/** 目标路径是否落在任一允许根内（精确匹配或前缀 + 分隔符，防 C:/ws 误配 C:/ws2） */
export function isMediaPathAllowed(filePath, roots) {
  const target = normalizeMediaPath(filePath)
  return roots.some((root) => {
    const normalizedRoot = normalizeMediaPath(root)
    return target === normalizedRoot || target.startsWith(`${normalizedRoot}/`)
  })
}
