import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listOpLogs, markOpLogUndone, readOpLog, writeOpLog } from '../src/main/core/op-log.mjs'

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

test('markOpLogUndone atomically keeps a readable undo marker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-oplog-'))
  try {
    const file = await writeOpLog(dir, 'rename', { report: { items: [{ from: 'a', to: 'b' }] } })
    const log = await readOpLog(file)
    assert.ok(log)
    await markOpLogUndone(file, log)
    assert.ok((await readOpLog(file))?.undoneAt)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('listOpLogs on missing directory returns empty', async () => {
  assert.deepEqual(await listOpLogs('/nonexistent/path/xyz'), [])
})
