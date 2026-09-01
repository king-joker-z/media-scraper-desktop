import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyPath,
  computeFingerprint,
  createScanPlan,
  isHiddenName,
  normalizedName,
  predictMoves
} from '../src/main/core/scanner.mjs'

test('classifies mainstream media extensions', () => {
  assert.equal(classifyPath('movie.MKV'), 'video')
  assert.equal(classifyPath('poster.webp'), 'image')
  assert.equal(classifyPath('legacy.nfo'), 'other')
})

test('identifies hidden names and normalizes poster names', () => {
  assert.equal(isHiddenName('.DS_Store'), true)
  assert.equal(isHiddenName('video.mp4'), false)
  assert.equal(normalizedName('视频 6-poster.jpg'), normalizedName('视频_6.mp4'))
  // 全角空格同样忽略
  assert.equal(normalizedName('Movie　A.jpg'), normalizedName('Movie A.mp4'))
})

async function withFixture(structure, fn) {
  const root = await mkdtemp(join(tmpdir(), 'msd-scan-'))
  try {
    for (const [relativePath, content] of Object.entries(structure)) {
      const target = join(root, relativePath)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, content)
    }
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const names = (items) => items.map((item) => item.relativePath).sort()

test('frozen example: 保留匹配对、删除孤儿图与其他文件、生成上移预览', async () => {
  await withFixture(
    {
      'Movie A.mp4': 'v',
      'Movie A.jpg': 'i',
      'Movie B.mp4': 'v',
      'Movie B-poster.jpg': 'i',
      'Orphan.jpg': 'i',
      'notes.nfo': 'x',
      [join('sub', 'Movie C.mp4')]: 'v',
      [join('sub', 'Movie C.png')]: 'i'
    },
    async (root) => {
      const plan = await createScanPlan(root)
      assert.equal(plan.summary.videos, 3)
      assert.equal(plan.summary.images, 4)
      assert.equal(plan.summary.otherFiles, 1)
      assert.deepEqual(
        names(plan.keep.filter((item) => item.kind === 'video')),
        ['Movie A.mp4', 'Movie B.mp4', join('sub', 'Movie C.mp4')].sort()
      )
      const posters = plan.keep.filter((item) => item.kind === 'image')
      assert.equal(posters.length, 3)
      assert.equal(
        posters.find((p) => p.relativePath === 'Movie B-poster.jpg').posterFor,
        'Movie B.mp4'
      )
      assert.deepEqual(names(plan.deleteItems), ['Orphan.jpg', 'notes.nfo'].sort())
      assert.deepEqual(
        plan.moves.map((m) => m.from).sort(),
        [join('sub', 'Movie C.mp4'), join('sub', 'Movie C.png')].sort()
      )
    }
  )
})

test('hidden files and hidden directory subtrees are fully skipped', async () => {
  await withFixture(
    {
      'Movie A.mp4': 'v',
      '.DS_Store': 'x',
      [join('.hidden', 'Secret.mp4')]: 'v',
      [join('.hidden', 'sub', 'Deep.mp4')]: 'v'
    },
    async (root) => {
      const plan = await createScanPlan(root)
      assert.equal(plan.summary.videos, 1)
      assert.equal(plan.summary.hiddenSkipped, 2)
      assert.ok(plan.skippedHidden.some((p) => p.startsWith('.hidden')))
      assert.ok(plan.skippedHidden.includes('.DS_Store'))
    }
  )
})

test('symbolic-link directories are skipped to preserve workspace boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'msd-scan-link-'))
  const external = await mkdtemp(join(tmpdir(), 'msd-external-'))
  try {
    await writeFile(join(root, 'inside.mp4'), 'inside')
    await writeFile(join(external, 'outside.mp4'), 'outside')
    await symlink(external, join(root, 'linked'))

    const plan = await createScanPlan(root)
    assert.deepEqual(names(plan.keep.filter((item) => item.kind === 'video')), ['inside.mp4'])
    assert.ok(plan.skippedHidden.includes('linked'))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test('matching is restricted to the same directory level', async () => {
  await withFixture(
    {
      'A.mp4': 'v',
      [join('sub', 'A.jpg')]: 'i'
    },
    async (root) => {
      const plan = await createScanPlan(root)
      assert.equal(plan.keep.length, 1)
      assert.equal(plan.keep[0].relativePath, 'A.mp4')
      assert.equal(plan.deleteItems.length, 1)
      assert.equal(plan.deleteItems[0].reason, '未匹配同层视频')
    }
  )
})

test('one video with multiple images: -poster wins, losers become delete candidates', async () => {
  await withFixture(
    {
      'V.mp4': 'v',
      'V.jpg': 'i',
      'V-poster.jpg': 'i'
    },
    async (root) => {
      const plan = await createScanPlan(root)
      const poster = plan.keep.find((item) => item.kind === 'image')
      assert.equal(poster.relativePath, 'V-poster.jpg')
      const loser = plan.deleteItems.find((item) => item.kind === 'image')
      assert.equal(loser.relativePath, 'V.jpg')
      assert.equal(loser.reason, '未被选为 poster 的候选图')
      assert.equal(plan.pendingPick.length, 0)
    }
  )
})

test('one video with multiple images: exact same name wins when no -poster exists', async () => {
  await withFixture(
    {
      'W.mp4': 'v',
      'W.jpg': 'i',
      'W .jpg': 'i'
    },
    async (root) => {
      const plan = await createScanPlan(root)
      const poster = plan.keep.find((item) => item.kind === 'image')
      assert.equal(poster.relativePath, 'W.jpg')
      assert.equal(plan.pendingPick.length, 0)
    }
  )
})

test('one video with multiple indistinguishable images goes to pendingPick', async () => {
  await withFixture(
    {
      'X.mp4': 'v',
      'X .jpg': 'i',
      'X_.jpg': 'i'
    },
    async (root) => {
      const plan = await createScanPlan(root)
      assert.equal(plan.keep.length, 1)
      assert.equal(plan.keep[0].kind, 'video')
      assert.equal(plan.deleteItems.length, 0)
      assert.equal(plan.pendingPick.length, 1)
      assert.equal(plan.pendingPick[0].video, 'X.mp4')
      assert.deepEqual(plan.pendingPick[0].candidates.sort(), ['X .jpg', 'X_.jpg'].sort())
      assert.equal(plan.conflicts[0].type, 'video-multi-image')
    }
  )
})

test('one image matching multiple videos is an ambiguity conflict', async () => {
  await withFixture(
    {
      'Dup.mp4': 'v',
      'Dup .mkv': 'v',
      'Dup.jpg': 'i'
    },
    async (root) => {
      const plan = await createScanPlan(root)
      assert.equal(plan.keep.length, 2)
      assert.ok(plan.keep.every((item) => item.kind === 'video'))
      assert.equal(plan.deleteItems.length, 1)
      assert.equal(plan.deleteItems[0].reason, '图片匹配多个视频，按规则不保留')
      assert.equal(plan.conflicts.length, 1)
      assert.equal(plan.conflicts[0].type, 'image-multi-video')
    }
  )
})

test('predictMoves: root keep and hidden names block, collisions get (n)', () => {
  const keep = [
    { relativePath: 'V.mp4', dir: '.', name: 'V.mp4' },
    { relativePath: 'sub1/V.mp4', dir: 'sub1', name: 'V.mp4' },
    { relativePath: 'sub2/V.mp4', dir: 'sub2', name: 'V.mp4' },
    { relativePath: 'sub1/W.mp4', dir: 'sub1', name: 'W.mp4' }
  ]
  const moves = predictMoves(keep, ['.DS_Store'])
  assert.deepEqual(moves, [
    { from: 'sub1/V.mp4', to: 'V (1).mp4', renamed: true },
    { from: 'sub1/W.mp4', to: 'W.mp4', renamed: false },
    { from: 'sub2/V.mp4', to: 'V (2).mp4', renamed: true }
  ])
})

test('kept posters get standardized finalName in plan', async () => {
  await withFixture(
    {
      'Movie A.mp4': 'v',
      'Movie A.jpg': 'i'
    },
    async (root) => {
      const plan = await createScanPlan(root)
      const poster = plan.keep.find((item) => item.kind === 'image')
      assert.equal(poster.finalName, 'Movie A-poster.jpg')
    }
  )
})

test('computeFingerprint changes on content change, stable otherwise', async () => {
  await withFixture(
    {
      'A.mp4': 'v',
      '.hidden-file': 'x'
    },
    async (root) => {
      const fp1 = await computeFingerprint(root)
      assert.equal(await computeFingerprint(root), fp1)
      const { writeFile: wf, utimes } = await import('node:fs/promises')
      await wf(join(root, 'B.mp4'), 'new')
      const fp2 = await computeFingerprint(root)
      assert.notEqual(fp2, fp1)
      await utimes(join(root, 'B.mp4'), new Date(), new Date(Date.now() + 10000))
      assert.notEqual(await computeFingerprint(root), fp2)
      const fp3 = await computeFingerprint(root)
      await wf(join(root, '.hidden-file'), 'changed-content-longer')
      assert.equal(await computeFingerprint(root), fp3)
    }
  )
})

test('fingerprint traversals are cached independently for concurrent workspaces', async () => {
  const first = await mkdtemp(join(tmpdir(), 'msd-scan-first-'))
  const second = await mkdtemp(join(tmpdir(), 'msd-scan-second-'))
  try {
    await writeFile(join(first, 'First.mp4'), 'v')
    await writeFile(join(first, 'First.jpg'), 'i')
    await writeFile(join(second, 'Second.mp4'), 'v')
    await writeFile(join(second, 'Second.jpg'), 'i')
    await Promise.all([computeFingerprint(first), computeFingerprint(second)])
    await rm(join(first, 'First.mp4'))
    const plan = await createScanPlan(first)
    assert.equal(plan.summary.videos, 1)
    assert.deepEqual(names(plan.keep.filter((item) => item.kind === 'video')), ['First.mp4'])
  } finally {
    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })
  }
})

test('scan plan is read-only and never touches the filesystem', async () => {
  await withFixture(
    {
      'Movie A.mp4': 'v',
      'Orphan.jpg': 'i',
      [join('sub', 'Movie C.mp4')]: 'v'
    },
    async (root) => {
      await createScanPlan(root)
      const { access } = await import('node:fs/promises')
      await access(join(root, 'Movie A.mp4'))
      await access(join(root, 'Orphan.jpg'))
      await access(join(root, 'sub', 'Movie C.mp4'))
    }
  )
})

test('目录遍历并发是跨层级的全局上限', async () => {
  await withFixture(
    Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        join(`level-${index % 4}`, `nested-${index}`, 'video.mp4'),
        'v'
      ])
    ),
    async (root) => {
      let active = 0
      let peak = 0
      await createScanPlan(root, {
        concurrency: 3,
        onDirectoryStart: () => {
          active += 1
          peak = Math.max(peak, active)
        },
        onDirectoryFinish: () => {
          active -= 1
        }
      })
      assert.ok(peak <= 3, `峰值 ${peak} 超过全局上限`)
      assert.ok(peak > 1, '应实际并行处理多个目录')
    }
  )
})

test('扫描收到 AbortSignal 后拒绝且不产生计划', async () => {
  await withFixture(
    Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [join(`d-${index}`, 'v.mp4'), 'v'])
    ),
    async (root) => {
      const controller = new AbortController()
      let started = 0
      await assert.rejects(
        () =>
          createScanPlan(root, {
            concurrency: 2,
            signal: controller.signal,
            onDirectoryStart: () => {
              started += 1
              if (started === 2) controller.abort()
            }
          }),
        /扫描已取消/
      )
    }
  )
})
