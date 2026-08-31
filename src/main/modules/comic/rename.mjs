import { basename, dirname, join } from 'node:path'
import { readComicState } from './scan.mjs'
import { directRename, listDirNames, pathExists, writeAtomicTextFile } from '../../core/fs-ops.mjs'
import {
  COMIC_FAILED_DIR_NAME,
  COMIC_STATE_NAME,
  LEGACY_COMIC_COVER_NAME,
  comicCoverName,
  comicOutputName,
  isComicFailedDirName
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

/** 暂存/提交/恢复阶段的目录改名并发上限：Windows 上文件锁重试相互独立，有限并发显著缩短批量等待 */
const STAGE_CONCURRENCY = 4

const validateName = (root, name) => {
  const value = String(name ?? '').trim()
  if (!value) return '名称为空'
  if (ILLEGAL_NAME_RE.test(value)) return '包含非法字符 \\ / : * ? " < > | 或控制字符'
  if (WINDOWS_RESERVED_NAME_RE.test(value)) return 'Windows 保留设备名，不可用作文件夹名'
  if (TRAILING_DOT_SPACE_RE.test(value)) return '名称末尾不能是点号或空格'
  if (isComicFailedDirName(value))
    return `「${COMIC_FAILED_DIR_NAME}」为系统保留目录名，不可用作漫画名`
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

/** 恢复目录并确认成功：失败时调用方必须上报，避免目录滞留在临时名导致扫描不可见。 */
const restoreDirChecked = async (from, to) => {
  if (!(await pathExists(from))) return true
  try {
    await moveExact(from, to)
  } catch {
    return false
  }
  return !(await pathExists(from))
}

/** 以有限车道并发执行异步任务（index 递增分配）。 */
async function runLanes(total, laneCount, worker) {
  let cursor = 0
  const lane = async () => {
    while (cursor < total) {
      const index = cursor
      cursor += 1
      await worker(index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(laneCount, total) }, lane))
}

/** 锁类错误在 Windows 上可重试后仍失败：给出可行动的提示而非裸英文错误码。 */
const friendlyRenameError = (error, target) => {
  if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error?.code)) {
    return new Error(`「${target}」可能正被其他程序占用（文件锁），稍后重试：${error.message}`)
  }
  return error
}

/**
 * 漫画目录改名：全部先改临时目录，再逐项提交关联产物/封面/清单，支持名称交换和仅大小写改名。
 * 暂存/提交/恢复均为有限并发，避免 Windows 上大批量改名长时间无反馈；
 * 单项校验失败、被占用或锁冲突只记入失败报告，不阻断其余项（原来是一处失败整批回退）。
 */
export async function renameComicDirectories(
  root,
  items,
  { taskCenter, taskId, concurrency = 5, onStageProgress }
) {
  // 校验阶段：非法/冲突项不阻断整批，直接进入失败报告；只有调用方错误（relDir 越界/重复）整体拒绝。
  const invalid = []
  const valid = []
  const seen = new Set()
  for (const item of items) {
    const relDir = String(item.relDir ?? '')
    const newName = String(item.newName ?? '').trim()
    if (!relDir || basename(relDir) !== relDir || relDir === '.' || relDir === '..') {
      throw new Error('漫画目录必须是工作区一级文件夹')
    }
    if (seen.has(relDir)) throw new Error(`漫画目录重复：${relDir}`)
    seen.add(relDir)
    const error = validateName(root, newName)
    if (error) {
      invalid.push({ target: relDir, error })
      continue
    }
    valid.push({ relDir, newName })
  }

  // 目标名称重复（大小写不敏感）按单项失败处理；重复项必须同时移出后续流程，
  // 否则会进入暂存并在提交阶段以「目标目录已存在」再失败一次，同一项报两条错误。
  const names = new Map()
  const deduped = []
  for (const { relDir, newName } of valid) {
    const key = nameKey(newName)
    if (names.has(key)) {
      invalid.push({ target: relDir, error: `目标名称重复：${newName}` })
      continue
    }
    names.set(key, relDir)
    deduped.push({ relDir, newName })
  }

  // 只需检查名称占用；扫描层/IPC 已确保传入项是一级漫画目录。
  // 占用者本身也在改名清单内（暂存阶段会被移走）时才允许落位，支持 A↔B 交换；
  // 占用者不参与改名（如未勾选的同名目录）必须前置拒绝，不能等暂存后提交才发现冲突。
  const stagingKeys = new Set(
    deduped.filter((item) => item.relDir !== item.newName).map((item) => nameKey(item.relDir))
  )
  const existingByKey = new Map((await listDirNames(root)).map((name) => [nameKey(name), name]))
  const active = []
  for (const { relDir, newName } of deduped) {
    const occupant = existingByKey.get(nameKey(newName))
    if (occupant && nameKey(occupant) !== nameKey(relDir) && !stagingKeys.has(nameKey(occupant))) {
      invalid.push({ target: relDir, error: `目标目录「${newName}」已被未参与改名的漫画占用` })
      continue
    }
    if (relDir !== newName) active.push({ relDir, newName })
  }

  const report = { taskId, cancelled: false, renamedCount: 0, items: [], failed: invalid }
  if (active.length === 0) return report

  // 暂存阶段：全部先改到唯一临时名，规避 A↔B 交换冲突。即使仅修改大小写也必须经过临时名，
  // Windows 才能可靠落位到用户指定的大小写。串行时每次改名都可能撞上文件锁重试（最坏单次数秒），
  // 数百部批量改名会长时间无反馈；车道并发显著缩短等待，单项暂存失败只影响该项。
  const staged = []
  let stageDone = 0
  const stageErrors = []
  await runLanes(active.length, STAGE_CONCURRENCY, async (index) => {
    const { relDir, newName } = active[index]
    const tempPath = join(root, `.msd-comic-rename-${crypto.randomUUID()}`)
    onStageProgress?.(stageDone, active.length, `暂存 ${relDir}`)
    try {
      await moveExact(join(root, relDir), tempPath)
      staged.push({ relDir, newName, tempPath })
    } catch (error) {
      stageErrors.push({ target: relDir, error: friendlyRenameError(error, relDir) })
    }
    stageDone += 1
  })
  report.failed.push(...stageErrors)
  if (staged.length === 0) return report

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

  // 目标名唯一性已在上方校验，并行提交互不冲突；文件锁重试相互独立，
  // 串行提交在大批量时明显偏慢，故按车道并发提交（上限 STAGE_CONCURRENCY）。
  const result = await taskCenter.run({
    taskId,
    label: '重命名漫画',
    items: staged,
    concurrency: Math.min(STAGE_CONCURRENCY, concurrency),
    worker: renameOne
  })
  report.cancelled = result.cancelled
  // 未派发、取消或失败的项仍留在临时名：统一回退，保证扫描不会丢失漫画。
  let restored = 0
  await runLanes(staged.length, STAGE_CONCURRENCY, async (index) => {
    const item = staged[index]
    onStageProgress?.(restored, staged.length, `恢复 ${item.relDir}`)
    const ok = await restoreDirChecked(item.tempPath, join(root, item.relDir))
    if (!ok) {
      report.failed.push({
        target: item.relDir,
        error: '改名失败后恢复原目录未成功，目录暂留在临时名，请手动检查'
      })
    }
    restored += 1
  })
  result.results.forEach((entry, index) => {
    if (!entry.ok && !entry.cancelled) {
      report.failed.push({ target: staged[index].relDir, error: entry.error ?? '未知错误' })
    }
  })
  return report
}
