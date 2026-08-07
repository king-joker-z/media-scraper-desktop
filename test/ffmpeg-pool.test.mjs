import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  setPoolSize,
  getPoolSize,
  getActiveCount,
  getPendingCount,
  acquire,
  release,
  runPooled
} from '../src/main/core/ffmpeg-pool.mjs'

test('pool starts with default size and zero active', () => {
  setPoolSize(4)
  assert.equal(getPoolSize(), 4)
  assert.equal(getActiveCount(), 0)
  assert.equal(getPendingCount(), 0)
})

test('acquire increments active count, release decrements', async () => {
  setPoolSize(4)
  assert.equal(getActiveCount(), 0)
  await acquire()
  assert.equal(getActiveCount(), 1)
  await acquire()
  assert.equal(getActiveCount(), 2)
  release()
  assert.equal(getActiveCount(), 1)
  release()
  assert.equal(getActiveCount(), 0)
})

test('acquire blocks when pool is full, resumes on release', async () => {
  setPoolSize(2)
  // 占满池
  await acquire()
  await acquire()
  assert.equal(getActiveCount(), 2)

  // 第三个 acquire 应该排队
  let resolved = false
  const pending = acquire().then(() => {
    resolved = true
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(resolved, false)
  assert.equal(getPendingCount(), 1)

  // 释放一个许可，排队的应该被唤醒
  release()
  await pending
  assert.equal(resolved, true)
  assert.equal(getPendingCount(), 0)
  assert.equal(getActiveCount(), 2)

  // 清理
  release()
  release()
  assert.equal(getActiveCount(), 0)
})

test('setPoolSize expand wakes waiting tasks', async () => {
  setPoolSize(1)
  await acquire()
  assert.equal(getActiveCount(), 1)

  let resolved = false
  const pending = acquire().then(() => {
    resolved = true
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(resolved, false)

  // 扩容到 2，等待者应被唤醒
  setPoolSize(2)
  await pending
  assert.equal(resolved, true)
  assert.equal(getActiveCount(), 2)

  release()
  release()
  setPoolSize(4)
  assert.equal(getActiveCount(), 0)
})

test('runPooled executes a command and returns stdout', async () => {
  setPoolSize(4)
  // 用 node --version 作为简单命令（跨平台可用）
  const { stdout } = await runPooled(process.execPath, ['--version'])
  assert.ok(stdout.trim().length > 0)
  assert.equal(getActiveCount(), 0)
})

test('runPooled releases permit on error', async () => {
  setPoolSize(4)
  // 执行一个必然失败的命令
  await assert.rejects(
    runPooled(process.execPath, ['--nonexistent-flag-xyz']),
    (error) => error !== null
  )
  // 许可应该已释放
  assert.equal(getActiveCount(), 0)
})

test('runPooled respects pool size limit', async () => {
  setPoolSize(2)
  // 同时启动 4 个任务，池大小 2，应该最多同时 2 个活跃
  let peakActive = 0
  const tasks = Array.from({ length: 4 }, () =>
    runPooled(process.execPath, ['-e', 'setTimeout(() => {}, 50)']).then(() => {
      peakActive = Math.max(peakActive, getActiveCount())
    })
  )
  await Promise.all(tasks)
  // peakActive 是各任务完成时观察到的活跃数，应 <= 2
  assert.ok(peakActive <= 2, `peakActive should be <= 2, got ${peakActive}`)
  assert.equal(getActiveCount(), 0)
})
