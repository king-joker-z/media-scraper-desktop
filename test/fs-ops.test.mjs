import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureUniquePath,
  moveWithCollision,
  pathExists,
  permanentDelete,
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
