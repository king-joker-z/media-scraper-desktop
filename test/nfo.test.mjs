import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNfoPlan,
  escapeXml,
  executeNfoPlan,
  renderNfoXml
} from '../src/main/modules/nfo/nfo.mjs'
import { createTaskCenter } from '../src/main/core/task-center.mjs'
import { pathExists } from '../src/main/core/fs-ops.mjs'

test('escapeXml escapes special characters', () => {
  assert.equal(escapeXml('a<b>&"c"'), 'a&lt;b&gt;&amp;&quot;c&quot;')
})

test('renderNfoXml matches the frozen format', () => {
  const xml = renderNfoXml({
    title: '58.abcabc',
    posterName: '58.abcabc-poster.jpg',
    actorName: '合集A'
  })
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8" standalone="yes"?>'))
  assert.ok(xml.includes('<title>58.abcabc</title>'))
  assert.ok(xml.includes('<poster>58.abcabc-poster.jpg</poster>'))
  assert.ok(xml.includes('<name>合集A</name>'))
  assert.ok(xml.includes('<role>合集A</role>'))
  assert.ok(xml.includes('<type>Actor</type>'))
  // 无 poster 时省略该行
  const noPoster = renderNfoXml({ title: 't', posterName: null, actorName: 'a' })
  assert.ok(!noPoster.includes('<poster>'))
})

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'msd-nfo-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('createNfoPlan detects target dir conflicts', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'A.mp4'), 'v')
    await writeFile(join(root, 'A-poster.jpg'), 'i')
    await mkdir(join(root, 'B'))
    await writeFile(join(root, 'B', 'existing.txt'), 'x')
    await writeFile(join(root, 'B.mp4'), 'v')

    const plan = await createNfoPlan(root)
    assert.equal(plan.items.length, 2)
    assert.equal(plan.actorDefault, basenameOf(root))
    const a = plan.items.find((i) => i.stem === 'A')
    const b = plan.items.find((i) => i.stem === 'B')
    assert.equal(a.conflict, false)
    assert.equal(a.posterRel, 'A-poster.jpg')
    assert.equal(b.conflict, true)
  })
})

test('executeNfoPlan archives video+poster+nfo into per-video folder', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'Movie.mp4'), 'v')
    await writeFile(join(root, 'Movie-poster.jpg'), 'i')

    const plan = await createNfoPlan(root)
    const report = await executeNfoPlan(root, plan.items, '自定义演员', {
      taskCenter: createTaskCenter(),
      taskId: 'nfo-1',
      concurrency: 2
    })

    assert.equal(report.failed.length, 0)
    assert.equal(report.archivedCount, 1)

    const dir = join(root, 'Movie')
    assert.equal(await pathExists(join(dir, 'Movie.mp4')), true)
    assert.equal(await pathExists(join(dir, 'Movie-poster.jpg')), true)
    const nfo = await readFile(join(dir, 'Movie.nfo'), 'utf8')
    assert.ok(nfo.includes('<title>Movie</title>'))
    assert.ok(nfo.includes('<poster>Movie-poster.jpg</poster>'))
    assert.ok(nfo.includes('<name>自定义演员</name>'))
    // 根目录原文件已移走
    assert.equal(await pathExists(join(root, 'Movie.mp4')), false)
  })
})

function basenameOf(path) {
  return path.split(/[\\/]/).filter(Boolean).pop()
}
