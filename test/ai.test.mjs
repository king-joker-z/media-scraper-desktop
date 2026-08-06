import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAiMessages,
  buildPrompt,
  chatCompletionsUrl,
  extractJsonArray,
  requestAiNames
} from '../src/main/modules/rename/ai.mjs'

test('chatCompletionsUrl appends endpoint without double-appending', () => {
  assert.equal(
    chatCompletionsUrl('https://api.deepseek.com'),
    'https://api.deepseek.com/chat/completions'
  )
  assert.equal(
    chatCompletionsUrl('https://api.deepseek.com/'),
    'https://api.deepseek.com/chat/completions'
  )
  // 用户粘贴完整端点时原样使用
  const full = 'https://api.aicodemirror.ai/api/codex/backend-api/codex/v1/chat/completions'
  assert.equal(chatCompletionsUrl(full), full)
})

test('buildPrompt substitutes all template variables', () => {
  const out = buildPrompt('父目录={{parentFolder}} 文件={{fileName}} 扩展={{extension}}', {
    parentFolder: '演唱会',
    fileName: 'abc@111',
    extension: '.mp4'
  })
  assert.equal(out, '父目录=演唱会 文件=abc@111 扩展=.mp4')
})

test('extractJsonArray tolerates markdown fences and surrounding text', () => {
  assert.deepEqual(extractJsonArray('["a","b"]'), ['a', 'b'])
  assert.deepEqual(extractJsonArray('```json\n["a"]\n```'), ['a'])
  assert.deepEqual(extractJsonArray('结果如下：["x", "y"] 希望满意'), ['x', 'y'])
  assert.throws(() => extractJsonArray('没有数组'), /未找到 JSON 数组/)
})

test('buildAiMessages numbers each file', () => {
  const messages = buildAiMessages('改名 {{fileName}}', [
    { parentFolder: 'p', fileName: 'a', extension: '.mp4' },
    { parentFolder: 'p', fileName: 'b', extension: '.mkv' }
  ])
  assert.equal(messages[0].role, 'system')
  assert.ok(messages[1].content.includes('1. 改名 a'))
  assert.ok(messages[1].content.includes('2. 改名 b'))
})

const mockFetchOk = (names) => async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(names) } }] })
})

test('requestAiNames maps response names in order and targets baseUrl', async () => {
  let calledUrl = ''
  const names = await requestAiNames({
    baseUrl: 'https://api.deepseek.com/',
    token: 'sk-test',
    model: 'm',
    template: '{{fileName}}',
    files: [
      { parentFolder: 'p', fileName: 'a@111', extension: '.mp4' },
      { parentFolder: 'p', fileName: 'b@222', extension: '.mp4' }
    ],
    fetchImpl: async (url) => {
      calledUrl = url
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '["干净 a","干净 b"]' } }] })
      }
    }
  })
  assert.deepEqual(names, ['干净 a', '干净 b'])
  assert.equal(calledUrl, 'https://api.deepseek.com/chat/completions')
})

test('requestAiNames requires token and validates count', async () => {
  await assert.rejects(
    requestAiNames({
      baseUrl: 'https://x',
      token: '',
      model: 'm',
      template: '',
      files: [{ parentFolder: '', fileName: 'a', extension: '.mp4' }]
    }),
    /Token/
  )
  await assert.rejects(
    requestAiNames({
      baseUrl: 'https://x',
      token: 'sk',
      model: 'm',
      template: '',
      files: [
        { parentFolder: '', fileName: 'a', extension: '.mp4' },
        { parentFolder: '', fileName: 'b', extension: '.mp4' }
      ],
      fetchImpl: mockFetchOk(['只有一个'])
    }),
    /数量/
  )
})

test('requestAiNames surfaces HTTP errors and batches over 50', async () => {
  await assert.rejects(
    requestAiNames({
      baseUrl: 'https://x',
      token: 'sk',
      model: 'm',
      template: '',
      files: [{ parentFolder: '', fileName: 'a', extension: '.mp4' }],
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
    }),
    /401/
  )

  let calls = 0
  const files = Array.from({ length: 120 }, (_, i) => ({
    parentFolder: 'p',
    fileName: `f${i}`,
    extension: '.mp4'
  }))
  const batchReports = []
  const names = await requestAiNames({
    baseUrl: 'https://x',
    token: 'sk',
    model: 'm',
    template: '',
    files,
    onBatch: (done) => batchReports.push(done),
    fetchImpl: async (_url, init) => {
      calls += 1
      const count = JSON.parse(init.body).messages[1].content.split('\n\n').length
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: { content: JSON.stringify(Array.from({ length: count }, (_, i) => `n${i}`)) }
            }
          ]
        })
      }
    }
  })
  assert.equal(calls, 3) // 50 + 50 + 20
  assert.equal(names.length, 120)
  assert.deepEqual(batchReports, [50, 100, 120]) // 进度回调累计
})
