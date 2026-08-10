import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeRename, recoverRenameJournal } from '../src/main/modules/rename/execute.mjs'
import { executeNfoPlan } from '../src/main/modules/nfo/nfo.mjs'
import { undoOpLog } from '../src/main/modules/undo/undo.mjs'
import { createTaskCenter } from '../src/main/core/task-center.mjs'
import { pathExists, writeTextFile } from '../src/main/core/fs-ops.mjs'
import { writeOpLog } from '../src/main/core/op-log.mjs'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'msd-undo-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const center = () => createTaskCenter()

test('executeRename 成功后 journal 自动删除', async () => {
  await withTempDir(async (root) => {
    const journal = join(root, 'journal.json')
    await writeFile(join(root, 'A.mp4'), 'a')
    const report = await executeRename(
      root,
      [{ videoRel: 'A.mp4', posterRel: null, newStem: 'B' }],
      { taskCenter: center(), taskId: 'j1', journalPath: journal }
    )
    assert.equal(report.renamedCount, 1)
    assert.equal(await pathExists(journal), false)
    assert.equal(await pathExists(join(root, 'B.mp4')), true)
  })
})

test('recoverRenameJournal 把残留临时文件续跑到目标名并删除 journal', async () => {
  await withTempDir(async (root) => {
    // 模拟崩溃现场：阶段一已完成（源文件已改成临时名），阶段二未执行
    const temp = join(root, 'msd_tmp_111_0_v.mp4')
    await writeFile(temp, 'content')
    const journal = join(root, 'journal.json')
    await writeTextFile(
      journal,
      JSON.stringify({ version: 1, ops: [{ rel: 'A.mp4', temp, finalName: 'A-new.mp4' }] })
    )

    const result = await recoverRenameJournal(journal)
    assert.deepEqual(result, { recovered: 1, skipped: 0 })
    assert.equal(await pathExists(join(root, 'A-new.mp4')), true)
    assert.equal(await pathExists(temp), false)
    assert.equal(await pathExists(journal), false)
  })
})

test('recoverRenameJournal 临时文件不存在时跳过（阶段一未执行到该项）', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'A.mp4'), 'a') // 源文件仍在原地
    const journal = join(root, 'journal.json')
    await writeTextFile(
      journal,
      JSON.stringify({
        version: 1,
        ops: [{ rel: 'A.mp4', temp: join(root, 'msd_tmp_1_0_v.mp4'), finalName: 'B.mp4' }]
      })
    )
    const result = await recoverRenameJournal(journal)
    assert.deepEqual(result, { recovered: 0, skipped: 1 })
    assert.equal(await pathExists(join(root, 'A.mp4')), true)
    assert.equal(await pathExists(journal), false)
  })
})

test('recoverRenameJournal 无 journal 返回 null', async () => {
  await withTempDir(async (root) => {
    assert.equal(await recoverRenameJournal(join(root, 'none.json')), null)
  })
})

test('撤销重命名：按日志把新名移回原路径，重复撤销被拒绝', async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'A.mp4'), 'a')
    const report = await executeRename(
      root,
      [{ videoRel: join('sub', 'A.mp4'), posterRel: null, newStem: '01.A' }],
      { taskCenter: center(), taskId: 'u1' }
    )
    assert.equal(await pathExists(join(root, 'sub', '01.A.mp4')), true)

    const logFile = await writeOpLog(root, 'rename', { root, report, summary: '改名 1 项' })
    const undo = await undoOpLog(logFile)
    assert.equal(undo.undone, 1)
    assert.equal(undo.failed.length, 0)
    assert.equal(await pathExists(join(root, 'sub', 'A.mp4')), true)
    assert.equal(await pathExists(join(root, 'sub', '01.A.mp4')), false)

    // 重复撤销被拒绝
    await assert.rejects(undoOpLog(logFile), /已撤销/)
  })
})

test('撤销 NFO 归档：视频/poster 移回根目录，NFO 删除，空目录清理', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'M.mp4'), 'v')
    await writeFile(join(root, 'M-poster.jpg'), 'i')
    const report = await executeNfoPlan(
      root,
      [
        { videoRel: 'M.mp4', stem: 'M', posterRel: 'M-poster.jpg', targetDir: 'M', conflict: false }
      ],
      'actor',
      { taskCenter: center(), taskId: 'u2' }
    )
    assert.equal(report.archivedCount, 1)
    assert.equal(await pathExists(join(root, 'M', 'M.mp4')), true)
    assert.equal(await pathExists(join(root, 'M', 'M.nfo')), true)

    const logFile = await writeOpLog(root, 'nfo', { root, report, summary: '归档 1 个视频' })
    const undo = await undoOpLog(logFile)
    assert.equal(undo.undone, 2) // 视频 + poster
    assert.equal(await pathExists(join(root, 'M.mp4')), true)
    assert.equal(await pathExists(join(root, 'M-poster.jpg')), true)
    // NFO 删除、空目标目录被清理
    assert.equal(await pathExists(join(root, 'M')), false)
    const remaining = await readdir(root)
    assert.ok(!remaining.some((name) => name.endsWith('.nfo')))
  })
})

test('删除类日志不支持撤销', async () => {
  await withTempDir(async (root) => {
    const logFile = await writeOpLog(root, 'dedupe-delete', {
      root,
      report: { deletedCount: 1, failed: [] },
      summary: '删除重复文件 1 个'
    })
    await assert.rejects(undoOpLog(logFile), /不支持撤销/)
  })
})
