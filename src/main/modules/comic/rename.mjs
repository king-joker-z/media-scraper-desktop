import { basename, join } from 'node:path'
import { readComicState } from './scan.mjs'
import { directRename, renameWithCollision, writeAtomicTextFile } from '../../core/fs-ops.mjs'
import { comicCoverName, comicOutputName } from '../../../shared/comic-rules.mjs'
import {
  ILLEGAL_NAME_RE,
  MAX_STEM_LENGTH,
  TRAILING_DOT_SPACE_RE,
  WINDOWS_RESERVED_NAME_RE
} from '../../../shared/rename-rules.mjs'

/** 漫画目录改名：先全部改为临时目录，再落到目标名，支持 A <-> B 交换。 */
const validateName = (name) => {
  const value = String(name ?? '').trim()
  if (!value) return '名称为空'
  if (ILLEGAL_NAME_RE.test(value)) return '包含非法字符 \\ / : * ? " < > | 或控制字符'
  if (WINDOWS_RESERVED_NAME_RE.test(value)) return 'Windows 保留设备名，不可用作文件夹名'
  if (TRAILING_DOT_SPACE_RE.test(value)) return '名称末尾不能是点号或空格'
  if (value.length > MAX_STEM_LENGTH) return `名称超长（>${MAX_STEM_LENGTH} 字符）`
  return null
}

/**
 * @param {string} root
 * @param {Array<{relDir: string, newName: string}>} items
 * @param {{taskCenter: object, taskId: string, concurrency?: number}} options
 */
export async function renameComicDirectories(root, items, { taskCenter, taskId, concurrency = 5 }) {
  const unique = new Map()
  for (const item of items) {
    const relDir = String(item.relDir ?? '')
    const newName = String(item.newName ?? '').trim()
    if (!relDir) throw new Error('漫画目录不能为空')
    if (unique.has(relDir)) throw new Error(`漫画目录重复：${relDir}`)
    const error = validateName(newName)
    if (error) throw new Error(`「${relDir}」：${error}`)
    unique.set(relDir, newName)
  }
  const names = new Map()
  for (const [relDir, newName] of unique) {
    const key = newName.toLowerCase()
    if (names.has(key)) throw new Error(`目标名称重复：${newName}`)
    names.set(key, relDir)
  }

  const active = [...unique].filter(([relDir, newName]) => relDir !== newName)
  const report = { taskId, cancelled: false, renamedCount: 0, items: [], failed: [] }
  if (active.length === 0) return report

  const staged = []
  try {
    // 两段式第一段不经 TaskCenter：必须先完成所有目录脱离原名，才能安全处理交换。
    for (const [relDir, newName] of active) {
      const tempName = `.msd-comic-rename-${crypto.randomUUID()}`
      const tempPath = join(root, tempName)
      await directRename(join(root, relDir), tempPath)
      staged.push({ relDir, newName, tempPath })
    }
  } catch (error) {
    for (const item of staged.reverse()) {
      await directRename(item.tempPath, join(root, item.relDir)).catch(() => {})
    }
    throw error
  }

  const result = await taskCenter.run({
    taskId,
    label: '重命名漫画',
    items: staged,
    concurrency,
    worker: async (item, signal) => {
      if (signal?.aborted) throw new Error('已取消')
      const targetPath = await renameWithCollision(item.tempPath, item.newName, { signal })
      const finalName = basename(targetPath)
      const state = await readComicState(targetPath)
      if (state) {
        const oldOutput = join(targetPath, state.outputName)
        const nextOutputName = comicOutputName(finalName, state.format)
        if (state.outputName !== nextOutputName) {
          const outputPath = await renameWithCollision(oldOutput, nextOutputName, { signal })
          state.outputName = basename(outputPath)
        }
        const oldCover = join(targetPath, comicCoverName(item.relDir))
        const nextCoverName = comicCoverName(finalName)
        await renameWithCollision(oldCover, nextCoverName, { signal }).catch(() => {})
        await writeAtomicTextFile(
          join(targetPath, '.comic-merge.json'),
          JSON.stringify(state, null, 2)
        )
      }
      report.items.push({ from: item.relDir, to: finalName })
      report.renamedCount += 1
    }
  })
  report.cancelled = result.cancelled
  result.results.forEach((entry, index) => {
    if (!entry.ok && !entry.cancelled) {
      report.failed.push({ target: staged[index].relDir, error: entry.error ?? '未知错误' })
    }
  })
  return report
}
