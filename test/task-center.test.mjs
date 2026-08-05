import test from 'node:test'
import assert from 'node:assert/strict'
import { clampConcurrency, createTaskCenter } from '../src/main/core/task-center.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('clampConcurrency enforces the 1-20 range with default 5', () => {
  assert.equal(clampConcurrency(5), 5)
  assert.equal(clampConcurrency(0), 1)
  assert.equal(clampConcurrency(-3), 1)
  assert.equal(clampConcurrency(99), 20)
  assert.equal(clampConcurrency('abc'), 5)
  assert.equal(clampConcurrency(undefined), 5)
  assert.equal(clampConcurrency(7.6), 8)
})

test('run processes all items and never exceeds the concurrency limit', async () => {
  const events = []
  const center = createTaskCenter({ emit: (event) => events.push(event) })
  let active = 0
  let maxActive = 0

  const result = await center.run({
    taskId: 't1',
    label: '并发上限测试',
    items: Array.from({ length: 10 }, (_, i) => i),
    concurrency: 3,
    worker: async (item) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await sleep(20)
      active -= 1
      return item * 2
    }
  })

  assert.equal(result.cancelled, false)
  assert.equal(result.completed, 10)
  assert.equal(result.failed, 0)
  assert.ok(maxActive <= 3, `maxActive=${maxActive} should be <= 3`)
  assert.deepEqual(
    result.results.map((r) => r.value),
    Array.from({ length: 10 }, (_, i) => i * 2)
  )
  // 事件序列：start 开头、done 结尾
  assert.equal(events[0].type, 'start')
  assert.equal(events.at(-1).type, 'done')
  assert.equal(events.filter((e) => e.type === 'item-done').length, 10)
})

test('cancel stops scheduling new items and emits cancelled', async () => {
  const events = []
  const center = createTaskCenter({ emit: (event) => events.push(event) })
  let started = 0

  const promise = center.run({
    taskId: 't2',
    label: '取消测试',
    items: Array.from({ length: 10 }, (_, i) => i),
    concurrency: 1,
    worker: async () => {
      started += 1
      if (started === 2) center.cancel('t2')
      await sleep(10)
    }
  })

  const result = await promise
  assert.equal(result.cancelled, true)
  assert.ok(started < 10, `only ${started} items should have started`)
  assert.equal(events.at(-1).type, 'cancelled')
})

test('item errors are collected without aborting the whole run', async () => {
  const events = []
  const center = createTaskCenter({ emit: (event) => events.push(event) })

  const result = await center.run({
    taskId: 't3',
    label: '错误收集测试',
    items: ['a', 'bad', 'c'],
    concurrency: 2,
    worker: async (item) => {
      if (item === 'bad') throw new Error('boom')
      return item
    }
  })

  assert.equal(result.completed, 2)
  assert.equal(result.failed, 1)
  assert.equal(result.cancelled, false)
  const errorEvent = events.find((e) => e.type === 'item-error')
  assert.equal(errorEvent.current, 'bad')
  assert.equal(errorEvent.error, 'boom')
  assert.equal(events.at(-1).type, 'done')
})

test('empty item list completes immediately', async () => {
  const center = createTaskCenter()
  const result = await center.run({
    taskId: 't4',
    label: '空任务',
    items: [],
    worker: async () => {}
  })
  assert.equal(result.completed, 0)
  assert.equal(result.cancelled, false)
})
