import test from 'node:test'
import assert from 'node:assert/strict'
import { createLruCache } from '../src/main/core/lru-cache.mjs'
import { collectFailures, finishReport } from '../src/main/core/task-report.mjs'

test('LRU 超限只淘汰最旧条目，而不是全清', () => {
  const cache = createLruCache(3)
  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3)
  cache.set('d', 4) // a 应被淘汰，b/c 保留
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('b'), 2)
  assert.equal(cache.get('c'), 3)
  assert.equal(cache.get('d'), 4)
  assert.equal(cache.size, 3)
})

test('LRU get 命中提升为最新，延缓淘汰', () => {
  const cache = createLruCache(2)
  cache.set('a', 1)
  cache.set('b', 2)
  cache.get('a') // a 变最新
  cache.set('c', 3) // b 是最旧的，应淘汰 b 而不是 a
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('c'), 3)
})

test('collectFailures 只收集失败项并取指定字段为 target', () => {
  const report = { failed: [] }
  collectFailures(
    report,
    {
      results: [
        { ok: true, value: 1 },
        { ok: false, error: '磁盘满' },
        { ok: false, cancelled: true }
      ]
    },
    [{ rel: 'a.mp4' }, { rel: 'b.mp4' }, { rel: 'c.mp4' }],
    'rel'
  )
  assert.deepEqual(report.failed, [{ target: 'b.mp4', error: '磁盘满' }])
})

test('collectFailures 不传 key 时条目本身即 target（字符串列表）', () => {
  const report = { failed: [] }
  collectFailures(report, { results: [{ ok: false, error: 'x' }] }, ['dup.mp4'])
  assert.deepEqual(report.failed, [{ target: 'dup.mp4', error: 'x' }])
})

test('finishReport 写入取消标记与耗时', () => {
  const report = { cancelled: false, durationMs: 0 }
  const out = finishReport(report, Date.now() - 50, true)
  assert.equal(out.cancelled, true)
  assert.ok(out.durationMs >= 0)
})
