import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAiMessages,
  buildPrompt,
  chatCompletionsUrl,
  clearAiCache,
  extractJsonArray,
  fetchWithRetry,
  requestAiNames,
  readAiResponseContent
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

test('requestAiNames caches results within the session', async () => {
  clearAiCache()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '["cached-name"]' } }] })
    }
  }
  const file = { parentFolder: 'p', fileName: 'a', extension: '.mp4' }
  const options = { baseUrl: 'https://x', token: 'sk', model: 'm', template: 't', fetchImpl }
  const first = await requestAiNames({ ...options, files: [file] })
  const second = await requestAiNames({ ...options, files: [file] })
  assert.equal(calls, 1) // 第二次完全命中缓存，不发请求
  assert.deepEqual(first, ['cached-name'])
  assert.deepEqual(second, ['cached-name'])
  // 混合场景：一缓存一未命中，只请求未命中的
  const third = await requestAiNames({
    ...options,
    files: [file, { parentFolder: 'p', fileName: 'b', extension: '.mp4' }],
    fetchImpl: async () => {
      calls += 1
      return { ok: true, json: async () => ({ choices: [{ message: { content: '["b-name"]' } }] }) }
    }
  })
  assert.equal(calls, 2)
  assert.deepEqual(third, ['cached-name', 'b-name']) // 顺序与输入一致
})

test('fetchWithRetry retries network errors and 5xx, not 4xx', async () => {
  // 网络错误两次后成功
  let calls = 0
  const ok = await fetchWithRetry(
    'https://x',
    {},
    {
      retryDelayMs: 1,
      fetchImpl: async () => {
        calls += 1
        if (calls < 3) throw new TypeError('socket hangup')
        return { ok: true, status: 200 }
      }
    }
  )
  assert.equal(ok.ok, true)
  assert.equal(calls, 3)

  // 5xx 重试后仍失败 → 抛最后一次响应
  let calls5xx = 0
  const resp = await fetchWithRetry(
    'https://x',
    {},
    {
      retryDelayMs: 1,
      fetchImpl: async () => {
        calls5xx += 1
        return { ok: false, status: 502 }
      }
    }
  )
  assert.equal(resp.status, 502)
  assert.equal(calls5xx, 3)

  // 400 不重试
  let calls4xx = 0
  const resp4xx = await fetchWithRetry(
    'https://x',
    {},
    {
      retryDelayMs: 1,
      fetchImpl: async () => {
        calls4xx += 1
        return { ok: false, status: 400 }
      }
    }
  )
  assert.equal(resp4xx.status, 400)
  assert.equal(calls4xx, 1)

  // 网络错误全部耗尽 → 抛错
  await assert.rejects(
    fetchWithRetry(
      'https://x',
      {},
      { retryDelayMs: 1, fetchImpl: async () => Promise.reject(new Error('down')) }
    ),
    /重试 2 次/
  )
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

test('readAiResponseContent accepts SSE data events from compatible providers', async () => {
  const content = await readAiResponseContent({
    text: async () =>
      'data: {"choices":[{"delta":{"content":"[\\"第一"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"集\\"]"}}]}\n\n' +
      'data: [DONE]\n\n',
    json: async () => ({})
  })
  assert.equal(content, '["第一集"]')
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

test('requestAiNames parses SSE response and disables stream requests', async () => {
  clearAiCache()
  let body
  const names = await requestAiNames({
    baseUrl: 'https://x',
    token: 'sk',
    model: 'm',
    template: '',
    files: [{ parentFolder: '', fileName: 'a', extension: '.mp4' }],
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return {
        ok: true,
        text: async () =>
          'data: {"choices":[{"message":{"content":"[\\"已整理\\"]"}}]}\n\ndata: [DONE]\n'
      }
    }
  })
  assert.deepEqual(names, ['已整理'])
  assert.equal(body.stream, false)
})

test('requestAiNames surfaces HTTP errors and batches over 50', async () => {
  clearAiCache()
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
  assert.equal(calls, 6) // 20 × 6，单路小批次避免兼容服务超时
  assert.equal(names.length, 120)
  assert.deepEqual(batchReports, [20, 40, 60, 80, 100, 120]) // 进度回调累计
})
