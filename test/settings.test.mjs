import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activeProvider,
  createSettingsStore,
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
    assert.equal(settings.activeProviderId, 'openrouter')
    const ids = settings.aiProviders.map((p) => p.id)
    assert.ok(ids.includes('openrouter'))
    assert.ok(ids.includes('deepseek'))
    assert.ok(ids.includes('aicodemirror'))
    assert.ok(ids.includes('linkai'))
    assert.ok(ids.includes('hapi'))
    const hapi = settings.aiProviders.find((provider) => provider.id === 'hapi')
    assert.equal(hapi.baseUrl, 'https://hapiopen.cc/v1')
    assert.equal(hapi.selectedModel, 'gpt-5.4-mini')
    assert.equal(hapi.thinkingEnabled, false)
    const linkai = settings.aiProviders.find((provider) => provider.id === 'linkai')
    assert.equal(linkai.baseUrl, 'https://direct.linkai.pics/v1')
    assert.equal(linkai.selectedModel, 'gpt-5.4-mini')
    assert.ok(settings.promptTemplate.includes('文件名'))
    assert.ok(settings.regexTemplates.length >= 3)
  })
})

test('并发 update 串行落盘不丢数据', async () => {
  await withTempDir(async (dir) => {
    const store = createSettingsStore(join(dir, 'settings.json'))
    await store.get()
    // 并发发起多个 update（模拟 StrictMode 双调用/多页面同时写设置）
    await Promise.all([
      store.update({ concurrency: 9 }),
      store.update({ deleteToTrash: false }),
      store.update({ theme: 'dark' })
    ])
    const settings = await store.get()
    assert.equal(settings.concurrency, 9)
    assert.equal(settings.deleteToTrash, false)
    assert.equal(settings.theme, 'dark')
  })
})

test('migrates legacy openRouter settings into providers', () => {
  const migrated = normalizeSettings({
    openRouter: { token: 'sk-or-old', models: ['a/b'], selectedModel: 'a/b' }
  })
  const openrouter = migrated.aiProviders.find((p) => p.id === 'openrouter')
  assert.equal(openrouter.token, 'sk-or-old')
  assert.deepEqual(openrouter.models, ['a/b'])
  assert.equal(openrouter.selectedModel, 'a/b')
  // 其他平台预设补齐
  assert.ok(migrated.aiProviders.find((p) => p.id === 'deepseek'))
})

test('旧设置升级后会补齐新增的内置 AI 平台', () => {
  const upgraded = normalizeSettings({
    aiProviders: [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        token: 'sk-or',
        models: ['model-a'],
        selectedModel: 'model-a'
      },
      {
        id: 'custom-existing',
        name: '我的平台',
        baseUrl: 'https://example.com/v1',
        token: 'sk-custom',
        models: ['model-b'],
        selectedModel: 'model-b'
      }
    ],
    activeProviderId: 'custom-existing'
  })
  assert.equal(upgraded.activeProviderId, 'custom-existing')
  assert.equal(
    upgraded.aiProviders.find((provider) => provider.id === 'linkai').selectedModel,
    'gpt-5.4-mini'
  )
  assert.equal(
    upgraded.aiProviders.find((provider) => provider.id === 'custom-existing').token,
    'sk-custom'
  )
})

test('tokens persist per provider and survive platform switching', async () => {
  await withTempDir(async (dir) => {
    const store = createSettingsStore(join(dir, 'settings.json'))
    let settings = await store.get()

    // 给两个平台分别配置 token
    const withTokens = settings.aiProviders.map((p) =>
      p.id === 'openrouter'
        ? { ...p, token: 'sk-or' }
        : p.id === 'deepseek'
          ? { ...p, token: 'sk-ds' }
          : p
    )
    settings = await store.update({ aiProviders: withTokens })
    // 切换平台
    settings = await store.update({ activeProviderId: 'deepseek' })
    assert.equal(settings.activeProviderId, 'deepseek')
    assert.equal(activeProvider(settings).token, 'sk-ds')

    // 重新加载（模拟重启）：两个 token 都在
    const reloaded = createSettingsStore(join(dir, 'settings.json'))
    const after = await reloaded.get()
    assert.equal(after.aiProviders.find((p) => p.id === 'openrouter').token, 'sk-or')
    assert.equal(after.aiProviders.find((p) => p.id === 'deepseek').token, 'sk-ds')
    assert.equal(after.activeProviderId, 'deepseek')
  })
})

test('update clamps concurrency into 1-20 and persists to disk', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)
    assert.equal((await store.update({ concurrency: 99 })).concurrency, 20)
    assert.equal((await store.update({ concurrency: 0 })).concurrency, 1)
    const reloaded = createSettingsStore(file)
    assert.equal((await reloaded.get()).concurrency, 1)
  })
})

test('recovers defaults from a corrupted settings file', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    await writeFile(file, '{not valid json')
    const store = createSettingsStore(file)
    assert.deepEqual(await store.get(), normalizeSettings(null))
  })
})

test('recovers from .bak backup when main file is corrupted', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)
    // 写入有效配置
    await store.update({ concurrency: 10, activeProviderId: 'deepseek' })
    // 模拟主文件损坏（但 .bak 是上次写入前的备份）
    await writeFile(file, '{broken')
    const recovered = createSettingsStore(file)
    const settings = await recovered.load()
    // 从 .bak 恢复：concurrency 应为 update 前的值（5），activeProviderId 为 openrouter
    assert.equal(settings.concurrency, 5)
    assert.equal(settings.activeProviderId, 'openrouter')
  })
})

test('atomic write creates .bak backup after first successful write', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)
    await store.update({ concurrency: 10 })
    // 第一次写入后应该有 .bak（虽然是空→有，但 copyFile 失败被忽略）
    await store.update({ concurrency: 15 })
    // 第二次写入后 .bak 应包含上次的 concurrency=10
    const { readFile } = await import('node:fs/promises')
    const bak = JSON.parse(await readFile(`${file}.bak`, 'utf8'))
    assert.equal(bak.concurrency, 10)
  })
})

test('theme, custom palette and recentWorkspaces persist and reload', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)
    await store.update({
      theme: 'dark',
      themePalette: 'custom',
      customAccent: '#f2c230',
      recentWorkspaces: ['/path/a', '/path/b']
    })
    const reloaded = createSettingsStore(file)
    const settings = await reloaded.get()
    assert.equal(settings.theme, 'dark')
    assert.equal(settings.themePalette, 'custom')
    assert.equal(settings.customAccent, '#f2c230')
    assert.deepEqual(settings.recentWorkspaces, ['/path/a', '/path/b'])
  })
})

test('支持思考的平台默认关闭，且可保存开启状态', () => {
  assert.equal(
    normalizeSettings({}).aiProviders.find((p) => p.id === 'deepseek').thinkingEnabled,
    false
  )
  const enabled = normalizeSettings({
    aiProviders: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        token: '',
        models: ['deepseek-v4-flash'],
        selectedModel: 'deepseek-v4-flash',
        thinkingEnabled: true
      }
    ]
  })
  assert.equal(enabled.aiProviders[0].thinkingEnabled, true)
  assert.equal(
    normalizeSettings({}).aiProviders.find((p) => p.id === 'linkai').thinkingEnabled,
    false
  )
})

test('旧版 LinkAI 默认预设会迁移到 Direct 网关与可用模型', () => {
  const settings = normalizeSettings({
    aiProviders: [
      {
        id: 'linkai',
        name: 'LinkAI',
        baseUrl: 'https://linkai.pics/v1',
        token: 'sk-linkai',
        models: ['linkai-auto'],
        selectedModel: 'linkai-auto'
      }
    ],
    activeProviderId: 'linkai'
  })
  const linkai = settings.aiProviders.find((provider) => provider.id === 'linkai')
  assert.equal(linkai.name, 'LinkAI Direct')
  assert.equal(linkai.baseUrl, 'https://direct.linkai.pics/v1')
  assert.deepEqual(linkai.models, ['gpt-5.4-mini'])
  assert.equal(linkai.selectedModel, 'gpt-5.4-mini')
  assert.equal(linkai.token, 'sk-linkai')
})

test('AI 模型请求参数按模型保存并限制安全范围', () => {
  const settings = normalizeSettings({
    aiProviders: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        token: '',
        models: ['model-a', 'model-b'],
        selectedModel: 'model-a',
        modelTunings: {
          'model-a': { batchSize: 12, concurrency: 2 },
          'model-b': { batchSize: 999, concurrency: 0 },
          removed: { batchSize: 5, concurrency: 5 }
        }
      }
    ]
  })
  const provider = settings.aiProviders[0]
  assert.deepEqual(provider.modelTunings['model-a'], { batchSize: 12, concurrency: 2 })
  assert.deepEqual(provider.modelTunings['model-b'], { batchSize: 100, concurrency: 1 })
  assert.equal(provider.modelTunings.removed, undefined)
})

test('NVENC 开关尊重显式值，并兼容旧版 CPU 关闭设置', () => {
  assert.equal(normalizeSettings({ nvencEnabled: true }).nvencEnabled, true)
  assert.equal(normalizeSettings({ nvencEnabled: false }).nvencEnabled, false)
  assert.equal(normalizeSettings({ videoEncoder: 'cpu' }).nvencEnabled, false)
})

test('custom palette preserves a valid custom accent and normalizes invalid values', () => {
  const custom = normalizeSettings({ themePalette: 'custom', customAccent: '#Ab12Cd' })
  assert.equal(custom.themePalette, 'custom')
  assert.equal(custom.customAccent, '#ab12cd')
  assert.equal(
    normalizeSettings({ themePalette: 'custom', customAccent: '#bad' }).customAccent,
    '#1687d9'
  )
})

test('all selectable preset palettes remain valid', () => {
  for (const palette of [
    'ocean',
    'violet',
    'forest',
    'sunset',
    'graphite',
    'berry',
    'amber',
    'jade',
    'sky',
    'mint',
    'lemon',
    'rose'
  ]) {
    assert.equal(normalizeSettings({ themePalette: palette }).themePalette, palette)
  }
})

test('invalid palette falls back to ocean', () => {
  assert.equal(normalizeSettings({ themePalette: 'unknown' }).themePalette, 'ocean')
})

test('normalizeSettings filters malformed providers and models', () => {
  const normalized = normalizeSettings({
    aiProviders: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/',
        token: 't',
        models: ['m1', '', 42],
        selectedModel: 'nope'
      },
      { bad: true }
    ],
    activeProviderId: 'ghost'
  })
  const ds = normalized.aiProviders.find((p) => p.id === 'deepseek')
  assert.equal(ds.baseUrl, 'https://api.deepseek.com') // 尾斜杠清理
  assert.deepEqual(ds.models, ['m1'])
  assert.equal(ds.selectedModel, 'm1') // 非法 selectedModel 回退
  // 无效 provider 被赋予自定义 id 兜底，随后补齐缺失的内置平台。
  assert.equal(normalized.aiProviders.length, 6)
  assert.equal(normalized.activeProviderId, 'deepseek') // ghost 不存在，回退首个
})
