import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  spawnManaged,
  activeProcessCount,
  killAllActiveProcesses
} from '../src/main/core/process-registry.mjs'
import { runPooled, setPoolSize } from '../src/main/core/ffmpeg-pool.mjs'
import { resolveFfmpegPath } from '../src/main/core/frames.mjs'

const node = process.execPath

test('runPooled 正常执行并收集 stdout/stderr', async () => {
  setPoolSize(4)
  const { stdout } = await runPooled(node, ['-e', "process.stdout.write('hi')"])
  assert.equal(stdout, 'hi')
})

test('runPooled 命令失败时 reject 且带 stderrTail', async () => {
  setPoolSize(4)
  await assert.rejects(
    () => runPooled(node, ['--bad-flag']),
    (error) => {
      assert.ok(error.code !== 0 || error.exitCode !== 0)
      assert.equal(typeof error.stderrTail, 'string')
      return true
    }
  )
})

test('runPooled abort 后进程被终止且 reject AbortError', async () => {
  setPoolSize(4)
  const controller = new AbortController()
  const promise = runPooled(node, ['-e', 'setTimeout(() => {}, 60000)'], {
    signal: controller.signal
  })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'AbortError')
    return true
  })
})

test('spawnManaged 完成后注册表清空', async () => {
  const before = activeProcessCount()
  const { code } = await spawnManaged(node, ['-e', 'process.exit(0)'])
  assert.equal(code, 0)
  assert.equal(activeProcessCount(), before)
})

test('killAllActiveProcesses 强杀顽固进程', async () => {
  const controller = new AbortController()
  const promise = spawnManaged(
    node,
    ['-e', "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setTimeout(()=>{},60000)"],
    { signal: controller.signal }
  )
  // 等进程启动
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.ok(activeProcessCount() > 0)
  killAllActiveProcesses()
  // 被强杀后 promise reject 或 resolve（取决于监听顺序），关键看进程被清除
  try {
    await promise
  } catch {
    /* SIGKILL 后 reject */
  }
  assert.equal(activeProcessCount(), 0)
})

test('ffmpeg 真实进程经注册表管理：截帧成功后注册表清空', async () => {
  setPoolSize(4)
  const ffmpeg = resolveFfmpegPath()
  const before = activeProcessCount()
  // 调一个极简 ffmpeg 命令（版本查询）
  await runPooled(ffmpeg, ['-version'])
  assert.equal(activeProcessCount(), before)
})
