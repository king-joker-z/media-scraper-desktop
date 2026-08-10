import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * 主进程文件边界校验：IPC 传来的相对路径只能落在指定根目录内。
 * 仅依赖 node:path，供所有会读写本地文件的模块复用。
 */
export function resolveInsideRoot(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('路径不能为空')
  }
  if (isAbsolute(relativePath)) throw new Error('不允许使用绝对路径')
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, relativePath)
  const diff = relative(resolvedRoot, target)
  if (diff === '..' || diff.startsWith(`..${sep}`) || isAbsolute(diff)) {
    throw new Error('路径超出工作区范围')
  }
  return target
}

/** 仅允许一个文件名，禁止目录分隔符、盘符和路径穿越。 */
export function assertSafeFileName(name) {
  if (typeof name !== 'string' || !name.trim() || basename(name) !== name) {
    throw new Error('输出文件名无效')
  }
  return name
}

/** 根目录必须与主进程已登记的工作区一致，避免 IPC 任意指定磁盘路径。 */
export function assertRegisteredRoot(root, registeredRoot, label = '工作区') {
  if (!registeredRoot || resolve(root) !== resolve(registeredRoot)) {
    throw new Error(`${label}未登记或已切换，请重新选择工作区`)
  }
  return resolve(registeredRoot)
}
