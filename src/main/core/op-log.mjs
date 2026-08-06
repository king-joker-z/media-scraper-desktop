import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeTextFile } from './fs-ops.mjs'

/**
 * 操作日志（冻结稿：永久删除不可恢复，留档可查）。
 * 每个执行任务落一份 JSON 到 userData/op-logs/。
 */

export async function writeOpLog(dir, module, payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${stamp}-${module}.json`)
  await writeTextFile(
    file,
    JSON.stringify({ module, finishedAt: new Date().toISOString(), ...payload }, null, 2)
  )
  return file
}

/** 最近的日志摘要（新到旧）。 */
export async function listOpLogs(dir, limit = 50) {
  let files = []
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const sorted = files
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
  const logs = []
  for (const file of sorted) {
    try {
      const raw = JSON.parse(await readFile(join(dir, file), 'utf8'))
      logs.push({
        file: join(dir, file),
        module: raw.module ?? '?',
        finishedAt: raw.finishedAt ?? '',
        summary: raw.summary ?? ''
      })
    } catch {
      // 损坏日志跳过
    }
  }
  return logs
}
