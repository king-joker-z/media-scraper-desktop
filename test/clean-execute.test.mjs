import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScanPlan } from '../src/main/core/scanner.mjs'
import { createTaskCenter } from '../src/main/core/task-center.mjs'
import { executeCleanPlan, executeDissolveFolders } from '../src/main/modules/clean/execute.mjs'
import { pathExists } from '../src/main/core/fs-ops.mjs'

// 1x1 PNG
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function withFixture(structure, fn) {
  const root = await mkdtemp(join(tmpdir(), 'msd-clean-'))
  try {
    for (const [relativePath, content] of Object.entries(structure)) {
      const target = join(root, relativePath)
      await mkdir(join(target, '..'), { recursive: true })
      if (content === 'PNG') await writeFile(target, Buffer.from(PNG_BASE64, 'base64'))
      else await writeFile(target, content)
    }
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const listRoot = async (root) => (await readdir(root)).sort()

test('仅解散文件夹会保留所有可见文件，不删除或标准化 poster', async () => {
  await withFixture(
    {
      [join('sub', 'A.mp4')]: 'video',
      [join('sub', 'A.png')]: 'image',
      [join('sub', 'notes.nfo')]: 'note',
      'A.mp4': 'root-video',
      [join('.hidden', 'keep.txt')]: 'hidden'
    },
    async (root) => {
      const report = await executeDissolveFolders(await createScanPlan(root), {
        taskCenter: createTaskCenter(),
        taskId: 'test-dissolve',
        concurrency: 2
      })
      assert.equal(report.deletedCount, 0)
      assert.equal(report.converted.length, 0)
      assert.equal(report.moved.length, 3)
      assert.equal(await readFile(join(root, 'A (1).mp4'), 'utf8'), 'video')
      assert.equal(await readFile(join(root, 'A.png'), 'utf8'), 'image')
      assert.equal(await readFile(join(root, 'notes.nfo'), 'utf8'), 'note')
      assert.equal(await pathExists(join(root, '.hidden', 'keep.txt')), true)
    }
  )
})

test('执行层忽略计划中伪造的绝对路径，始终限制在工作区内', async () => {
  await withFixture(
    {
      'Movie.mp4': 'video',
      'Orphan.jpg': 'image'
    },
    async (root) => {
      const outside = join(tmpdir(), `msd-outside-${crypto.randomUUID()}.jpg`)
      await writeFile(outside, 'must remain')
      try {
        const plan = await createScanPlan(root)
        plan.deleteItems[0].path = outside
        await executeCleanPlan(plan, {
          taskCenter: createTaskCenter(),
          taskId: 'test-untrusted-clean-path'
        })
        assert.equal(await pathExists(outside), true)
        assert.equal(await pathExists(join(root, 'Orphan.jpg')), false)
      } finally {
        await rm(outside, { force: true })
      }
    }
  )
})

test('end-to-end: 冻结稿示例树清理后目录结构正确', async () => {
  await withFixture(
    {
      'A.mp4': 'v',
      'A.jpg': 'i',
      'B.mp4': 'v',
      'B-poster.png': 'PNG',
      'Orphan.jpg': 'i',
      'notes.nfo': 'x',
      [join('sub', 'C.mp4')]: 'v',
      [join('sub', 'C.jpg')]: 'i',
      [join('.hidden', 'keep.txt')]: 'x'
    },
    async (root) => {
      const plan = await createScanPlan(root)
      const taskCenter = createTaskCenter()
      const report = await executeCleanPlan(plan, {
        picks: {},
        taskCenter,
        taskId: 'test-clean',
        concurrency: 4
      })

      assert.equal(report.cancelled, false)
      assert.equal(report.failed.length, 0)

      const rootEntries = await listRoot(root)
      // A 保留并标准化 poster 名；B 的 png 转成 jpg；C 上移；隐藏目录保留
      assert.deepEqual(rootEntries, [
        '.hidden',
        'A-poster.jpg',
        'A.mp4',
        'B-poster.jpg',
        'B.mp4',
        'C-poster.jpg',
        'C.mp4'
      ])
      // B-poster.jpg 是真实 JPEG（FFD8 魔数）
      const converted = await readFile(join(root, 'B-poster.jpg'))
      assert.equal(converted[0], 0xff)
      assert.equal(converted[1], 0xd8)
      // 删除项消失、空子目录被清理、隐藏目录原样保留
      assert.equal(await pathExists(join(root, 'Orphan.jpg')), false)
      assert.equal(await pathExists(join(root, 'notes.nfo')), false)
      assert.equal(await pathExists(join(root, 'sub')), false)
      assert.equal(await pathExists(join(root, '.hidden', 'keep.txt')), true)

      assert.equal(report.deletedCount, 2) // Orphan.jpg + notes.nfo
      assert.equal(report.converted.length, 1)
      assert.equal(report.moved.length, 2) // sub 下两个文件
      assert.ok(report.removedDirs.length >= 1)
    }
  )
})

test('end-to-end: pendingPick 人工选择生效，落选图被删除', async () => {
  await withFixture(
    {
      [join('sub', 'D.mp4')]: 'v',
      [join('sub', 'D .jpg')]: 'i',
      [join('sub', 'D-.jpg')]: 'i'
    },
    async (root) => {
      const plan = await createScanPlan(root)
      assert.equal(plan.pendingPick.length, 1)
      const video = plan.pendingPick[0].video

      const taskCenter = createTaskCenter()
      const report = await executeCleanPlan(plan, {
        picks: { [video]: join('sub', 'D-.jpg') },
        taskCenter,
        taskId: 'test-pick',
        concurrency: 2
      })

      assert.equal(report.failed.length, 0)
      assert.deepEqual(await listRoot(root), ['D-poster.jpg', 'D.mp4'])
      // 被选中的 D-.jpg 成为 poster（原名即 jpg，仅改名）
      assert.equal(report.renamed.length, 1)
      assert.equal(report.deletedCount, 1) // 落选的 D .jpg
    }
  )
})

test('refuses to execute when any pendingPick is unresolved', async () => {
  await withFixture(
    {
      [join('sub', 'D.mp4')]: 'v',
      [join('sub', 'D .jpg')]: 'i',
      [join('sub', 'D-.jpg')]: 'i'
    },
    async (root) => {
      const plan = await createScanPlan(root)
      const taskCenter = createTaskCenter()
      await assert.rejects(
        executeCleanPlan(plan, { picks: {}, taskCenter, taskId: 'test-refuse' }),
        /尚未选择 poster/
      )
      // 未做任何写操作
      assert.deepEqual((await readdir(join(root, 'sub'))).sort(), ['D .jpg', 'D-.jpg', 'D.mp4'])
    }
  )
})

test('root-level name collision on move gets (n) suffix at runtime', async () => {
  await withFixture(
    {
      'V.mp4': 'root-video',
      [join('sub', 'V.mp4')]: 'sub-video'
    },
    async (root) => {
      const plan = await createScanPlan(root)
      const taskCenter = createTaskCenter()
      const report = await executeCleanPlan(plan, {
        picks: {},
        taskCenter,
        taskId: 'test-collision',
        concurrency: 1
      })
      assert.equal(report.failed.length, 0)
      const entries = await listRoot(root)
      assert.equal(entries.length, 2)
      assert.ok(entries.includes('V.mp4'))
      assert.ok(entries.includes('V (1).mp4'))
      // 内容不覆盖：根目录原文件保持原样
      assert.equal(await readFile(join(root, 'V.mp4'), 'utf8'), 'root-video')
    }
  )
})
