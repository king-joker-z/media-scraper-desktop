import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSettingsStore,
  DEFAULT_SETTINGS,
  normalizeSettings
} from '../src/main/core/settings.mjs'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'msd-settings-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('returns defaults when the settings file does not exist', async () => {
  await withTempDir(async (dir) => {
    const store = createSettingsStore(join(dir, 'settings.json'))
    const settings = await store.get()
    assert.equal(settings.concurrency, 5)
    assert.ok(settings.openRouter.models.includes('deepseek/deepseek-chat'))
    assert.ok(settings.promptTemplate.includes('{{parentFolder}}'))
    assert.ok(settings.regexTemplates.length >= 3)
  })
})

test('recovers defaults from a corrupted settings file', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    await writeFile(file, '{not valid json')
    const store = createSettingsStore(file)
    const settings = await store.get()
    assert.deepEqual(settings, normalizeSettings(null))
  })
})

test('update clamps concurrency into 1-20 and persists to disk', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)

    assert.equal((await store.update({ concurrency: 99 })).concurrency, 20)
    assert.equal((await store.update({ concurrency: 0 })).concurrency, 1)
    assert.equal((await store.update({ concurrency: 8 })).concurrency, 8)

    // 新实例从磁盘读回同样的值
    const reloaded = createSettingsStore(file)
    assert.equal((await reloaded.get()).concurrency, 8)
  })
})

test('openRouter patch merges without dropping existing fields', async () => {
  await withTempDir(async (dir) => {
    const store = createSettingsStore(join(dir, 'settings.json'))
    const before = await store.get()
    const after = await store.update({ openRouter: { ...before.openRouter, token: 'sk-or-test' } })
    assert.equal(after.openRouter.token, 'sk-or-test')
    assert.deepEqual(after.openRouter.models, DEFAULT_SETTINGS.openRouter.models)
  })
})

test('normalizeSettings filters malformed model lists and unknown selected model', () => {
  const normalized = normalizeSettings({
    concurrency: 'junk',
    openRouter: { models: ['ok/model', '', 42], selectedModel: 'not-in-list' },
    promptTemplate: '',
    regexTemplates: [{ name: 'x', pattern: 'a', replacement: '', flags: 'g' }, { bad: true }]
  })
  assert.equal(normalized.concurrency, 5)
  assert.deepEqual(normalized.openRouter.models, ['ok/model'])
  assert.equal(normalized.openRouter.selectedModel, 'ok/model')
  assert.ok(normalized.promptTemplate.length > 0)
  assert.equal(normalized.regexTemplates.length, 1)
})
