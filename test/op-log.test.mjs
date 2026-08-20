import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getOpLogDetail,
  listOpLogs,
  markOpLogUndoAttempt,
  readOpLog,
  writeOpLog
} from '../src/main/core/op-log.mjs'

test('writeOpLog + listOpLogs roundtrip with summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-oplog-'))
  try {
    await writeOpLog(dir, 'clean', { report: { deletedCount: 3 }, summary: '删除 3 个文件' })
    // 保证文件名时间戳不同
    await new Promise((r) => setTimeout(r, 5))
    await writeOpLog(dir, 'rename', { report: { renamedCount: 7 }, summary: '改名 7 项' })

    const logs = await listOpLogs(dir)
    assert.equal(logs.length, 2)
    assert.equal(logs[0].module, 'rename') // 新到旧
    assert.equal(logs[1].module, 'clean')
    assert.equal(logs[1].summary, '删除 3 个文件')
    assert.ok(logs[0].file.endsWith('.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeOpLog keeps concurrent same-module operations as independent files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-oplog-'))
  try {
    const files = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writeOpLog(dir, 'rename', { report: { index }, summary: `改名 ${index}` })
      )
    )
    assert.equal(new Set(files).size, 20)
    assert.equal((await listOpLogs(dir, 50)).length, 20)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('markOpLogUndoAttempt persists rollback results and completed marker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-oplog-'))
  try {
    const file = await writeOpLog(dir, 'rename', { report: { items: [{ from: 'a', to: 'b' }] } })
    const log = await readOpLog(file)
    assert.ok(log)
    await markOpLogUndoAttempt(
      file,
      log,
      { module: 'rename', undone: 1, skipped: 0, failed: [] },
      true
    )
    const stored = await readOpLog(file)
    assert.ok(stored?.undoneAt)
    assert.equal(stored?.lastUndoAttempt?.undone, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('getOpLogDetail returns safe detail without an absolute log path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-oplog-'))
  try {
    const file = await writeOpLog(dir, 'rename', {
      root: '/secret/workspace',
      summary: '改名 1 项',
      report: { items: [{ from: 'before.mp4', to: 'after.mp4' }], renamedCount: 1, failed: [] }
    })
    const detail = await getOpLogDetail(dir, file.split('/').pop())
    assert.equal(detail.summary, '改名 1 项')
    assert.equal(detail.workspace, 'workspace')
    assert.deepEqual(detail.items, [{ before: 'before.mp4', after: 'after.mp4', status: 'done' }])
    assert.equal(await getOpLogDetail(dir, '../outside.json'), null)

    const escaped = await writeOpLog(dir, 'comic-delete-sources', {
      root: '/secret/workspace',
      report: { failed: [{ target: '/private/other/library/page.jpg', error: '锁定' }] },
      summary: '失败 1 项'
    })
    const escapedDetail = await getOpLogDetail(dir, escaped.split('/').pop())
    assert.equal(escapedDetail.failures[0].target, '工作区外路径')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('listOpLogs on missing directory returns empty', async () => {
  assert.deepEqual(await listOpLogs('/nonexistent/path/xyz'), [])
})
