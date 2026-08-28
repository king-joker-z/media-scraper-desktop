import { basename, dirname, join } from 'node:path'
import { readComicState } from './scan.mjs'
import { directRename, listDirNames, pathExists, writeAtomicTextFile } from '../../core/fs-ops.mjs'
import {
  COMIC_STATE_NAME,
  LEGACY_COMIC_COVER_NAME,
  comicCoverName,
  comicOutputName
} from '../../../shared/comic-rules.mjs'
import {
  ILLEGAL_NAME_RE,
  MAX_STEM_LENGTH,
  TRAILING_DOT_SPACE_RE,
  WINDOWS_RESERVED_NAME_RE
} from '../../../shared/rename-rules.mjs'

// Windows/macOS 默认卷通常大小写不敏感；NFC 同时规避 macOS 上等价 Unicode 名称的冲突。
const nameKey = (name) => String(name).normalize('NFC').toLocaleLowerCase('en-US')
const WINDOWS_SAFE_PATH_MAX = 240

const validateName = (root, name) => {
  const value = String(name ?? '').trim()
  if (!value) return '名称为空'
  if (ILLEGAL_NAME_RE.test(value)) return '包含非法字符 \\ / : * ? " < > | 或控制字符'
  if (WINDOWS_RESERVED_NAME_RE.test(value)) return 'Windows 保留设备名，不可用作文件夹名'
  if (TRAILING_DOT_SPACE_RE.test(value)) return '名称末尾不能是点号或空格'
  if (value.length > MAX_STEM_LENGTH) return `名称超长（>${MAX_STEM_LENGTH} 字符）`
  const paths = [
    join(root, value, comicOutputName(value, 'epub')),
    join(root, value, comicOutputName(value, 'pdf')),
    join(root, value, comicCoverName(value))
  ]
  if (process.platform === 'win32' && paths.some((path) => path.length > WINDOWS_SAFE_PATH_MAX)) {
    return `名称过长，Windows 兼容路径不能超过 ${WINDOWS_SAFE_PATH_MAX} 个字符`
  }
  return null
}

const moveExact = async (from, to) => {
  // Windows 对仅大小写的 rename 在不同卷/工具链下表现不一致，显式经过临时名保证落位。
  if (from !== to && nameKey(basename(from)) === nameKey(basename(to))) {
    const temp = join(dirname(from), `.msd-comic-case-${crypto.randomUUID()}`)
    await directRename(from, temp)
    return directRename(temp, to)
  }
  return directRename(from, to)
}
const restoreDir = async (from, to) => {
  if (await pathExists(from)) await moveExact(from, to).catch(() => {})
}

/**
 * 漫画目录改名：全部先改临时目录，再逐项提交关联产物/封面/清单，支持名称交换和仅大小写改名。
 * 单项任一关联文件改名失败会完整回退到原目录，避免 Windows 文件锁留下半完成状态。
 */
export async function renameComicDirectories(
  root,
  items,
  { taskCenter, taskId, concurrency = 5, onStageProgress }
) {
  const unique = new Map()
  for (const item of items) {
    const relDir = String(item.relDir ?? '')
    const newName = String(item.newName ?? '').trim()
    if (!relDir || basename(relDir) !== relDir || relDir === '.' || relDir === '..') {
      throw new Error('漫画目录必须是工作区一级文件夹')
    }
    if (unique.has(relDir)) throw new Error(`漫画目录重复：${relDir}`)
    const error = validateName(root, newName)
    if (error) throw new Error(`「${relDir}」：${error}`)
    unique.set(relDir, newName)
  }

  const names = new Map()
  for (const [relDir, newName] of unique) {
    const key = nameKey(newName)
    if (names.has(key)) throw new Error(`目标名称重复：${newName}`)
    names.set(key, relDir)
  }

  // 只需检查名称占用；扫描层/IPC 已确保传入项是一级漫画目录。
  const existingByKey = new Map((await listDirNames(root)).map((name) => [nameKey(name), name]))
  for (const [relDir, newName] of unique) {
    const occupant = existingByKey.get(nameKey(newName))
    if (occupant && !unique.has(occupant) && nameKey(occupant) !== nameKey(relDir)) {
      throw new Error(`目标目录「${newName}」已被未参与改名的漫画占用`)
    }
  }

  // 即使仅修改大小写也必须经过临时名，Windows 才能可靠落位到用户指定的大小写。
  const active = [...unique].filter(([relDir, newName]) => relDir !== newName)
  const report = { taskId, cancelled: false, renamedCount: 0, items: [], failed: [] }
  if (active.length === 0) return report

  // 暂存阶段串行改名（Windows 上每次都可能撞上文件锁重试，最坏单次数秒），
  // 此前完全没有进度反馈，批量改名时界面如同卡死；这里持续上报进度。
  const staged = []
  try {
    for (const [relDir, newName] of active) {
      const tempPath = join(root, `.msd-comic-rename-${crypto.randomUUID()}`)
      onStageProgress?.(staged.length, active.length, `暂存 ${relDir}`)
      await moveExact(join(root, relDir), tempPath)
      staged.push({ relDir, newName, tempPath })
    }
  } catch (error) {
    let rolledBack = 0
    for (const item of staged.reverse()) {
      onStageProgress?.(rolledBack, staged.length, `回退 ${item.relDir}`)
      await restoreDir(item.tempPath, join(root, item.relDir))
      rolledBack += 1
    }
    throw error
  }

  const renameOne = async (item, signal) => {
    if (signal?.aborted) throw new Error('已取消')
    const targetPath = join(root, item.newName)
    let outputMove = null
    let coverMove = null
    let state = null
    try {
      // 所有参与项已移至临时名；目标若仍存在即为外部竞争，宁可失败也不静默追加 (n)。
      if (await pathExists(targetPath)) throw new Error(`目标目录已存在：${item.newName}`)
      await moveExact(item.tempPath, targetPath)
      state = await readComicState(targetPath)
      if (state) {
        const oldOutput = join(targetPath, state.outputName)
        const nextOutputName = comicOutputName(item.newName, state.format)
        if (state.outputName !== nextOutputName && (await pathExists(oldOutput))) {
          const nextOutput = join(targetPath, nextOutputName)
          if (await pathExists(nextOutput)) throw new Error(`目标产物已存在：${nextOutputName}`)
          await moveExact(oldOutput, nextOutput)
          outputMove = { from: nextOutput, to: oldOutput }
          state.outputName = nextOutputName
        }

        const oldCoverName = (await pathExists(join(targetPath, comicCoverName(item.relDir))))
          ? comicCoverName(item.relDir)
          : LEGACY_COMIC_COVER_NAME
        const oldCover = join(targetPath, oldCoverName)
        const nextCoverName = comicCoverName(item.newName)
        if (oldCoverName !== nextCoverName && (await pathExists(oldCover))) {
          const nextCover = join(targetPath, nextCoverName)
          if (await pathExists(nextCover)) throw new Error(`目标封面已存在：${nextCoverName}`)
          await moveExact(oldCover, nextCover)
          coverMove = { from: nextCover, to: oldCover }
        }
        state.coverName = (await pathExists(join(targetPath, nextCoverName)))
          ? nextCoverName
          : undefined
        await writeAtomicTextFile(
          join(targetPath, COMIC_STATE_NAME),
          JSON.stringify(state, null, 2)
        )
      }
      report.items.push({ from: item.relDir, to: item.newName })
      report.renamedCount += 1
    } catch (error) {
      if (coverMove) await restoreDir(coverMove.from, coverMove.to)
      if (outputMove) await restoreDir(outputMove.from, outputMove.to)
      await restoreDir(targetPath, item.tempPath)
      throw error
    }
  }

  // 目录/关联文件改名共享一个工作区，串行提交避免与目标名和文件锁重试相互竞争。
  const result = await taskCenter.run({
    taskId,
    label: '重命名漫画',
    items: staged,
    concurrency: Math.min(1, concurrency),
    worker: renameOne
  })
  report.cancelled = result.cancelled
  // 未派发、取消或失败的项仍留在临时名：统一回退，保证扫描不会丢失漫画。
  let restored = 0
  for (const item of staged) {
    onStageProgress?.(restored, staged.length, `恢复 ${item.relDir}`)
    await restoreDir(item.tempPath, join(root, item.relDir))
    restored += 1
  }
  result.results.forEach((entry, index) => {
    if (!entry.ok && !entry.cancelled) {
      report.failed.push({ target: staged[index].relDir, error: entry.error ?? '未知错误' })
    }
  })
  return report
}
