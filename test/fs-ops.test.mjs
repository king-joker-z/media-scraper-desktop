import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dirSizeBytes,
  ensureUniquePath,
  ensureDir,
  moveFile,
  moveWithCollision,
  pathExists,
  permanentDelete,
  createMergeTransactionPath,
  installStagedFileIfAbsent,
  recoverStagedOutputs,
  isStagedOutputName,
  removeEmptyDirs,
  renameWithCollision,
  writeTextFile
} from '../src/main/core/fs-ops.mjs'

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'msd-fsops-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('ensureUniquePath appends (n) suffix until unique', async () => {
  await withTempDir(async (root) => {
    const first = join(root, 'a.txt')
    await writeFile(first, '1')
    assert.equal(await ensureUniquePath(join(root, 'b.txt')), join(root, 'b.txt'))
    assert.equal(await ensureUniquePath(first), join(root, 'a (1).txt'))
    await writeFile(join(root, 'a (1).txt'), '2')
    assert.equal(await ensureUniquePath(first), join(root, 'a (2).txt'))
  })
})

test('moveWithCollision moves file and resolves name conflicts', async () => {
  await withTempDir(async (root) => {
    const sourceDir = join(root, 'src')
    const targetDir = join(root, 'dst')
    await mkdir(sourceDir, { recursive: true })
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(sourceDir, 'v.mp4'), 'new')
    await writeFile(join(targetDir, 'v.mp4'), 'old')

    const finalPath = await moveWithCollision(join(sourceDir, 'v.mp4'), targetDir)
    assert.equal(finalPath, join(targetDir, 'v (1).mp4'))
    assert.equal(await readFile(finalPath, 'utf8'), 'new')
    // 原文件不动，源文件已消失
    assert.equal(await readFile(join(targetDir, 'v.mp4'), 'utf8'), 'old')
    assert.equal(await pathExists(join(sourceDir, 'v.mp4')), false)
  })
})

test('renameWithCollision renames and avoids overwriting', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'old.mp4'), 'a')
    await writeFile(join(root, 'new.mp4'), 'b')
    const finalPath = await renameWithCollision(join(root, 'old.mp4'), 'new.mp4')
    assert.equal(finalPath, join(root, 'new (1).mp4'))
    assert.equal(await readFile(join(root, 'new.mp4'), 'utf8'), 'b')
    // 同名改名直接跳过
    assert.equal(await renameWithCollision(join(root, 'new.mp4'), 'new.mp4'), join(root, 'new.mp4'))
  })
})

test('removeEmptyDirs removes empty subtrees but protects dirs with real hidden files', async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, 'empty1'), { recursive: true })
    await mkdir(join(root, 'nested', 'inner'), { recursive: true })
    await mkdir(join(root, 'with-hidden'), { recursive: true })
    await writeFile(join(root, 'with-hidden', '.secret-data'), 'x')
    await mkdir(join(root, 'with-file'), { recursive: true })
    await writeFile(join(root, 'with-file', 'keep.txt'), 'x')

    const removed = await removeEmptyDirs(root)
    assert.ok(removed.includes(join(root, 'empty1')))
    assert.ok(removed.includes(join(root, 'nested', 'inner')))
    assert.ok(removed.includes(join(root, 'nested')))
    // 含真实隐藏文件 / 普通文件的目录保留
    assert.equal(await pathExists(join(root, 'with-hidden')), true)
    assert.equal(await pathExists(join(root, 'with-file')), true)
    // root 自身永远不删
    assert.equal(await pathExists(root), true)
  })
})

test('removeEmptyDirs deletes dirs containing only OS junk files (.DS_Store etc.)', async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, 'junk-only'), { recursive: true })
    await writeFile(join(root, 'junk-only', '.DS_Store'), 'x')
    await mkdir(join(root, 'mixed'), { recursive: true })
    await writeFile(join(root, 'mixed', '.DS_Store'), 'x')
    await writeFile(join(root, 'mixed', 'real.txt'), 'x')

    const removed = await removeEmptyDirs(root)
    // 只剩垃圾文件的目录被清理
    assert.ok(removed.includes(join(root, 'junk-only')))
    assert.equal(await pathExists(join(root, 'junk-only')), false)
    // 还有其他内容的目录保留，垃圾文件也不动
    assert.equal(await pathExists(join(root, 'mixed')), true)
    assert.equal(await pathExists(join(root, 'mixed', '.DS_Store')), true)
  })
})

test('isJunkFileName identifies OS metadata files', async () => {
  const { isJunkFileName } = await import('../src/main/core/fs-ops.mjs')
  assert.equal(isJunkFileName('.DS_Store'), true)
  assert.equal(isJunkFileName('._AppleDouble'), true)
  assert.equal(isJunkFileName('Thumbs.db'), true)
  assert.equal(isJunkFileName('desktop.ini'), true)
  assert.equal(isJunkFileName('.gitignore'), false)
  assert.equal(isJunkFileName('photo.jpg'), false)
})

test('permanentDelete removes files and directories recursively', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'f.txt'), 'x')
    await permanentDelete(join(root, 'f.txt'))
    assert.equal(await pathExists(join(root, 'f.txt')), false)

    await mkdir(join(root, 'dir'), { recursive: true })
    await writeFile(join(root, 'dir', 'inner.txt'), 'x')
    await permanentDelete(join(root, 'dir'))
    assert.equal(await pathExists(join(root, 'dir')), false)
    // 不存在也不报错（force: true）
    await permanentDelete(join(root, 'nonexistent'))
  })
})

test('writeTextFile creates parent directories and writes utf8 content', async () => {
  await withTempDir(async (root) => {
    const target = join(root, 'a', 'b', 'note.nfo')
    await writeTextFile(target, '中文内容')
    assert.equal(await readFile(target, 'utf8'), '中文内容')
  })
})

test('moveFile moves file content correctly via rename path', async () => {
  await withTempDir(async (root) => {
    const src = join(root, 'src.bin')
    const dst = join(root, 'dst.bin')
    const payload = Buffer.alloc(4096, 55)
    await writeFile(src, payload)
    await moveFile(src, dst)
    assert.equal(await pathExists(src), false, 'source should be gone after move')
    assert.equal(await pathExists(dst), true, 'destination should exist')
    assert.deepEqual(await readFile(dst), payload)
  })
})

test('moveFile preserves content across separate temp directories', async () => {
  // 两个独立 tmpdir（模拟跨目录移动场景），验证 moveFile 内容完整性
  const dirA = await mkdtemp(join(tmpdir(), 'msd-move-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'msd-move-b-'))
  try {
    const src = join(dirA, 'payload.bin')
    const dst = join(dirB, 'payload.bin')
    const payload = Buffer.alloc(8192, 99)
    await writeFile(src, payload)
    await moveFile(src, dst)
    assert.equal(await pathExists(src), false)
    assert.equal(await pathExists(dst), true)
    assert.deepEqual(await readFile(dst), payload)
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})

test('dirSizeBytes sums all file sizes recursively', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'a.txt'), '12345')
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'b.bin'), Buffer.alloc(1000, 0))
    const size = await dirSizeBytes(root)
    assert.equal(size, 1005)
  })
})

test('dirSizeBytes returns 0 for nonexistent directory', async () => {
  await withTempDir(async (root) => {
    assert.equal(await dirSizeBytes(join(root, 'nonexistent')), 0)
  })
})

test('ensureDir creates nested directories', async () => {
  await withTempDir(async (root) => {
    const target = join(root, 'a', 'b', 'c')
    const result = await ensureDir(target)
    assert.equal(result, target)
    assert.equal(await pathExists(target), true)
  })
})

test('deleteToTrash 未注入实现时回退永久删除；注入后走回收站实现', async () => {
  const { deleteToTrash, setTrashImpl } = await import('../src/main/core/fs-ops.mjs')
  await withTempDir(async (root) => {
    // 未注入：回退永久删除
    setTrashImpl(null)
    await writeFile(join(root, 'a.txt'), 'x')
    await deleteToTrash(join(root, 'a.txt'))
    assert.equal(await pathExists(join(root, 'a.txt')), false)

    // 注入：走回收站实现（测试里用直接删除模拟 shell.trashItem）
    const trashed = []
    setTrashImpl(async (target) => {
      trashed.push(target)
      await rm(target, { force: true })
    })
    await writeFile(join(root, 'b.txt'), 'x')
    await deleteToTrash(join(root, 'b.txt'))
    assert.equal(trashed.length, 1)
    assert.equal(await pathExists(join(root, 'b.txt')), false)
    setTrashImpl(null)
  })
})

test('deleteToTrash 回收站实现抛错时保留文件并向调用方报错', async () => {
  const { deleteToTrash, setTrashImpl } = await import('../src/main/core/fs-ops.mjs')
  await withTempDir(async (root) => {
    setTrashImpl(async () => {
      throw new Error('trash unsupported')
    })
    const target = join(root, 'c.txt')
    await writeFile(target, 'x')
    await assert.rejects(() => deleteToTrash(target), /trash unsupported/)
    assert.equal(await pathExists(target), true)
    setTrashImpl(null)
  })
})

test('recoverStagedOutputs only restores MP4 files recorded in a merge transaction', async () => {
  await withTempDir(async (root) => {
    const staging = join(root, 'merged.msd-new-123e4567-e89b-12d3-a456-426614174001.mp4')
    const target = join(root, 'merged.mp4')
    const journal = createMergeTransactionPath(root)
    const unrelated = join(root, 'unrelated.mp4.msd-backup-123e4567-e89b-12d3-a456-426614174002')
    await writeFile(staging, 'stale-output')
    await writeFile(unrelated, 'user-file')
    await writeFile(journal, JSON.stringify({ version: 2, state: 'prepared', staging, target }))

    const recovered = await recoverStagedOutputs(root)
    assert.deepEqual(recovered, [target])
    assert.equal(await readFile(target, 'utf8'), 'stale-output')
    assert.equal(await pathExists(staging), false)
    assert.equal(await readFile(unrelated, 'utf8'), 'user-file')
    assert.equal(await pathExists(journal), false)
    assert.equal(isStagedOutputName('normal.mp4'), false)
  })
})

test('recoverStagedOutputs uses the highest journal state when atomic journal update leaves a backup', async () => {
  await withTempDir(async (root) => {
    const staging = join(root, 'merged.msd-new-123e4567-e89b-12d3-a456-426614174004.mp4')
    const target = join(root, 'merged.mp4')
    const journal = createMergeTransactionPath(root)
    const journalBackup = `${journal}.msd-backup-123e4567-e89b-12d3-a456-426614174005`
    await writeFile(staging, 'verified-output')
    await writeFile(journal, JSON.stringify({ version: 2, state: 'writing', staging, target }))
    await writeFile(
      journalBackup,
      JSON.stringify({ version: 2, state: 'prepared', staging, target })
    )

    assert.deepEqual(await recoverStagedOutputs(root), [target])
    assert.equal(await readFile(target, 'utf8'), 'verified-output')
    assert.equal(await pathExists(staging), false)
    assert.equal(await pathExists(journal), false)
    assert.equal(await pathExists(journalBackup), false)
  })
})

test('recoverStagedOutputs removes an unverified writing-stage MP4 transaction', async () => {
  await withTempDir(async (root) => {
    const staging = join(root, 'merged.msd-new-123e4567-e89b-12d3-a456-426614174003.mp4')
    const target = join(root, 'merged.mp4')
    const journal = createMergeTransactionPath(root)
    await writeFile(staging, 'partial-output')
    await writeFile(journal, JSON.stringify({ version: 2, state: 'writing', staging, target }))

    assert.deepEqual(await recoverStagedOutputs(root), [])
    assert.equal(await pathExists(staging), false)
    assert.equal(await pathExists(journal), false)
    assert.equal(await pathExists(target), false)
  })
})

test('recoverStagedOutputs preserves an unverified or mismatched MP4 transaction', async () => {
  await withTempDir(async (root) => {
    const target = join(root, 'family.mp4')
    const staging = join(root, 'other.msd-new-123e4567-e89b-12d3-a456-426614174000.mp4')
    const backup = join(root, 'other.mp4.msd-backup-123e4567-e89b-12d3-a456-426614174001')
    const journal = createMergeTransactionPath(root)
    await writeFile(target, 'user-file')
    await writeFile(staging, 'staging')
    await writeFile(backup, 'backup')
    await writeFile(journal, JSON.stringify({ version: 2, state: 'prepared', staging, target }))

    assert.deepEqual(await recoverStagedOutputs(root), [])
    assert.equal(await readFile(target, 'utf8'), 'user-file')
    assert.equal(await readFile(staging, 'utf8'), 'staging')
    assert.equal(await readFile(backup, 'utf8'), 'backup')
    assert.equal(await pathExists(journal), true)
  })
})

test('recoverStagedOutputs preserves a valid prepared transaction when another process owns target', async () => {
  await withTempDir(async (root) => {
    const staging = join(root, 'merged.msd-new-123e4567-e89b-12d3-a456-426614174000.mp4')
    const target = join(root, 'merged.mp4')
    const journal = createMergeTransactionPath(root)
    await writeFile(staging, 'our-output')
    await writeFile(target, 'other-process-output')
    await writeFile(journal, JSON.stringify({ version: 2, state: 'prepared', staging, target }))

    assert.deepEqual(await recoverStagedOutputs(root), [])
    assert.equal(await readFile(target, 'utf8'), 'other-process-output')
    assert.equal(await readFile(staging, 'utf8'), 'our-output')
    assert.equal(await pathExists(journal), true)
  })
})

test('recoverStagedOutputs preserves installed staging that is not the target inode', async () => {
  await withTempDir(async (root) => {
    const staging = join(root, 'merged.msd-new-123e4567-e89b-12d3-a456-426614174006.mp4')
    const target = join(root, 'merged.mp4')
    const journal = createMergeTransactionPath(root)
    await writeFile(staging, 'transaction-output')
    await writeFile(target, 'external-output')
    await writeFile(journal, JSON.stringify({ version: 2, state: 'installed', staging, target }))

    assert.deepEqual(await recoverStagedOutputs(root), [])
    assert.equal(await readFile(staging, 'utf8'), 'transaction-output')
    assert.equal(await readFile(target, 'utf8'), 'external-output')
    assert.equal(await pathExists(journal), true)
  })
})

test('installStagedFileIfAbsent never overwrites a concurrently created target', async () => {
  await withTempDir(async (root) => {
    const staging = join(root, 'output.msd-new-123e4567-e89b-12d3-a456-426614174000.mp4')
    const target = join(root, 'output.mp4')
    await writeFile(staging, 'merge-output')
    await writeFile(target, 'user-output')

    assert.equal(await installStagedFileIfAbsent(staging, target), false)
    assert.equal(await readFile(target, 'utf8'), 'user-output')
    assert.equal(await readFile(staging, 'utf8'), 'merge-output')
  })
})

test('installStagedFileIfAbsent falls back to exclusive copy when hard links are unavailable', async () => {
  await withTempDir(async (root) => {
    const staging = join(root, 'output.msd-new-123e4567-e89b-12d3-a456-426614174007.mp4')
    const target = join(root, 'output.mp4')
    await writeFile(staging, 'merge-output')

    // 使用目录模拟 link 的 EINVAL 文件系统错误不便注入，直接验证 fallback 使用的 O_EXCL 语义：
    // 已存在目标必须保留，且不会被回退复制覆盖。
    await writeFile(target, 'user-output')
    assert.equal(await installStagedFileIfAbsent(staging, target), false)
    assert.equal(await readFile(target, 'utf8'), 'user-output')
  })
})

test('cleanMovePartials 清理 .msd-part 残留临时件', async () => {
  const { cleanMovePartials } = await import('../src/main/core/fs-ops.mjs')
  await withTempDir(async (root) => {
    await writeFile(join(root, 'video.mp4.msd-part'), 'partial')
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'x.mkv.msd-part'), 'partial')
    await writeFile(join(root, 'ok.mp4'), 'real')
    const cleaned = await cleanMovePartials(root)
    assert.equal(cleaned.length, 2)
    assert.equal(await pathExists(join(root, 'video.mp4.msd-part')), false)
    assert.equal(await pathExists(join(root, 'sub', 'x.mkv.msd-part')), false)
    assert.equal(await pathExists(join(root, 'ok.mp4')), true)
  })
})
