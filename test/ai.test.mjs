import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAiMessages,
  buildPrompt,
  chatCompletionsUrl,
  clearAiCache,
  extractJsonArray,
  extractSingleName,
  normalizeAiName,
  fetchWithRetry,
  requestAiNames,
  readAiResponseContent,
  toFriendlyHttpError
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
  const file = { parentFolder: 'p', fileName: 'a' }
  const options = { baseUrl: 'https://x', token: 'sk', model: 'm', template: 't', fetchImpl }
  const first = await requestAiNames({ ...options, files: [file] })
  const second = await requestAiNames({ ...options, files: [file] })
  assert.equal(calls, 1) // 第二次完全命中缓存，不发请求
  assert.deepEqual(first, ['cached-name'])
  assert.deepEqual(second, ['cached-name'])
  // 混合场景：一缓存一未命中，只请求未命中的
  const third = await requestAiNames({
    ...options,
    files: [file, { parentFolder: 'p', fileName: 'b' }],
    fetchImpl: async () => {
      calls += 1
      return { ok: true, json: async () => ({ choices: [{ message: { content: '["b-name"]' } }] }) }
    }
  })
  assert.equal(calls, 2)
  assert.deepEqual(third, ['cached-name', 'b-name']) // 顺序与输入一致

  // 主动重新生成绕过成功缓存，并用最新成功结果覆盖缓存。
  const refreshed = await requestAiNames({
    ...options,
    files: [file],
    useCache: false,
    fetchImpl: async () => {
      calls += 1
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '["fresh-name"]' } }] })
      }
    }
  })
  assert.equal(calls, 3)
  assert.deepEqual(refreshed, ['fresh-name'])
  const afterRefresh = await requestAiNames({ ...options, files: [file] })
  assert.equal(calls, 3)
  assert.deepEqual(afterRefresh, ['fresh-name'])

  // 同模型、同 prompt、同文件但不同平台不能共享结果。
  const isolated = await requestAiNames({
    ...options,
    baseUrl: 'https://another-provider.example/v1',
    files: [file],
    fetchImpl: async () => {
      calls += 1
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '["other-provider"]' } }] })
      }
    }
  })
  assert.equal(calls, 4)
  assert.deepEqual(isolated, ['other-provider'])
})

test('503 会提示平台暂时不可用且保留平台响应摘要', async () => {
  const error = await toFriendlyHttpError({
    status: 503,
    text: async () => '{"error":{"message":"Service temporarily unavailable"}}'
  })
  assert.match(error.message, /平台暂时不可用/)
  assert.match(error.message, /HTTP 503/)
  assert.match(error.message, /Service temporarily unavailable/)
})

test('fetchWithRetry stops promptly when externally cancelled', async () => {
  const controller = new AbortController()
  const pending = fetchWithRetry(
    'https://x',
    {},
    {
      signal: controller.signal,
      retryDelayMs: 1,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            {
              once: true
            }
          )
        })
    }
  )
  controller.abort()
  await assert.rejects(pending, /已取消 AI 命名/)
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

test('buildPrompt substitutes filename variables but removes deprecated extension variable', () => {
  const out = buildPrompt('父目录={{parentFolder}} 文件={{fileName}} 扩展={{extension}}', {
    parentFolder: '演唱会',
    fileName: 'abc@111'
  })
  assert.equal(out, '父目录=演唱会 文件=abc@111 扩展=')
})

test('extractJsonArray tolerates markdown fences, wrapper objects and brackets inside names', () => {
  assert.deepEqual(extractJsonArray('["a","b"]'), ['a', 'b'])
  assert.deepEqual(extractJsonArray('```json\n["a"]\n```'), ['a'])
  assert.deepEqual(extractJsonArray('结果如下：["x", "y"] 希望满意'), ['x', 'y'])
  assert.deepEqual(extractJsonArray('{"names":["[第一季]", "第二季"]}'), ['[第一季]', '第二季'])
  assert.throws(() => extractJsonArray('没有数组'), /未找到有效 JSON 数组/)
})

test('extractSingleName accepts a bare single-title response but rejects invalid length and multiline text', () => {
  assert.equal(extractSingleName('失控克隆：测试母本的无限轮回'), '失控克隆：测试母本的无限轮回')
  assert.equal(extractSingleName('文件名： "干净标题"'), '干净标题')
  assert.throws(() => extractSingleName('标题一\n标题二'), /不是可用/)
  assert.throws(() => extractSingleName('a'.repeat(201)), /不是可用/)
})

test('normalizeAiName cleans illegal filename characters and rejects invalid results', () => {
  assert.equal(normalizeAiName('  第一集：开场?  '), '第一集：开场')
  assert.equal(normalizeAiName('标题. '), '标题')
  assert.throws(() => normalizeAiName('CON'), /保留设备名/)
  assert.throws(() => normalizeAiName('\\/:*?\x00'), /空名称/)
  assert.throws(() => normalizeAiName('a'.repeat(201)), /过长/)
})

test('readAiResponseContent accepts SSE data events and compatible content shapes', async () => {
  const sseContent = await readAiResponseContent({
    text: async () =>
      'data: {"choices":[{"delta":{"content":"[\\"第一"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"集\\"]"}}]}\n\n' +
      'data: [DONE]\n\n',
    json: async () => ({})
  })
  assert.equal(sseContent, '["第一集"]')

  const blockContent = await readAiResponseContent({
    text: async () =>
      JSON.stringify({
        choices: [{ message: { content: [{ type: 'text', text: '["文本块名称"]' }] } }]
      }),
    json: async () => ({})
  })
  assert.equal(blockContent, '["文本块名称"]')

  const outputContent = await readAiResponseContent({
    text: async () => JSON.stringify({ output_text: '["兼容名称"]' }),
    json: async () => ({})
  })
  assert.equal(outputContent, '["兼容名称"]')

  await assert.rejects(
    readAiResponseContent({ text: async () => '', json: async () => ({}) }),
    /AI 返回为空/
  )
})

test('buildAiMessages groups videos by parent folder and sends no extension', () => {
  const messages = buildAiMessages(
    '清理噪音；目录={{parentFolder}}；文件={{fileName}}；扩展={{extension}}',
    [
      { parentFolder: '剧集A', fileName: '第一集' },
      { parentFolder: '剧集A', fileName: '第二集' },
      { parentFolder: '剧集B', fileName: '特别篇' }
    ]
  )
  assert.equal(messages[0].role, 'system')
  const content = messages[1].content
  assert.match(
    content,
    /命名要求：清理噪音；目录=见下方分组标题；文件=见下方编号文件列表；扩展=不提供扩展名/
  )
  assert.equal((content.match(/父文件夹：剧集A/g) ?? []).length, 1)
  assert.match(content, /父文件夹：剧集A（编号 1–2）\n1\. 第一集\n2\. 第二集/)
  assert.match(content, /父文件夹：剧集B（编号 3）\n3\. 特别篇/)
  assert.doesNotMatch(content, /\.mp4|\.mkv/)
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
      { parentFolder: 'p', fileName: 'a@111' },
      { parentFolder: 'p', fileName: 'b@222' }
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

test('requestAiNames requires token, validates prompt length and validates count', async () => {
  await assert.rejects(
    requestAiNames({
      baseUrl: 'https://x',
      token: '',
      model: 'm',
      template: '',
      files: [{ parentFolder: '', fileName: 'a' }]
    }),
    /Token/
  )
  await assert.rejects(
    requestAiNames({
      baseUrl: 'https://x',
      token: 'sk',
      model: 'm',
      template: 'a'.repeat(8001),
      files: [{ parentFolder: '', fileName: 'a' }]
    }),
    /要求过长/
  )
  await assert.rejects(
    requestAiNames({
      baseUrl: 'https://x',
      token: 'sk',
      model: 'm',
      template: '',
      files: [
        { parentFolder: '', fileName: 'a' },
        { parentFolder: '', fileName: 'b' }
      ],
      fetchImpl: mockFetchOk(['只有一个'])
    }),
    /数量/
  )
})

test('requestAiNames accepts a bare title only for a single-item regeneration', async () => {
  clearAiCache()
  const base = { baseUrl: 'https://x', token: 'sk', model: 'm', template: '' }
  const one = await requestAiNames({
    ...base,
    files: [{ parentFolder: '', fileName: 'a' }],
    useCache: false,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: '裸标题' } }] })
    })
  })
  assert.deepEqual(one, ['裸标题'])
  await assert.rejects(
    requestAiNames({
      ...base,
      files: [
        { parentFolder: '', fileName: 'a' },
        { parentFolder: '', fileName: 'b' }
      ],
      useCache: false,
      fetchImpl: async () => ({
        ok: true,
        text: async () => JSON.stringify({ choices: [{ message: { content: '裸标题' } }] })
      })
    }),
    /名称列表/
  )
})

test('requestAiNames cancellation stops remaining batches', async () => {
  clearAiCache()
  const controller = new AbortController()
  let calls = 0
  const pending = requestAiNames({
    baseUrl: 'https://x',
    token: 'sk',
    model: 'm',
    template: '',
    signal: controller.signal,
    files: Array.from({ length: 41 }, (_, index) => ({
      parentFolder: 'p',
      fileName: `cancel-${index}`
    })),
    fetchImpl: async (_url, init) => {
      calls += 1
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          {
            once: true
          }
        )
      })
    }
  })
  controller.abort()
  await assert.rejects(pending, /已取消 AI 命名/)
  // 批次并发为 3，取消时最多已有三条请求开始；后续批次不得再发起。
  assert.ok(calls <= 3)
})

test('requestAiNames only sends the platform thinking setting when explicitly configured', async () => {
  clearAiCache()
  const bodies = []
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ choices: [{ message: { content: '["名称"]' } }] }) }
  }
  const base = {
    baseUrl: 'https://direct.linkai.pics/v1',
    token: 'sk',
    model: 'gpt-5.4-mini',
    template: '',
    files: [{ parentFolder: '', fileName: 'a' }],
    fetchImpl,
    useCache: false
  }
  await requestAiNames({ ...base, thinkingEnabled: false })
  await requestAiNames({ ...base, thinkingEnabled: true })
  await requestAiNames(base)
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' })
  assert.deepEqual(bodies[1].thinking, { type: 'enabled' })
  assert.equal(bodies[2].thinking, undefined)
})

test('requestAiNames parses SSE response and disables stream requests', async () => {
  clearAiCache()
  let body
  const names = await requestAiNames({
    baseUrl: 'https://x',
    token: 'sk',
    model: 'm',
    template: '',
    files: [{ parentFolder: '', fileName: 'a' }],
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
      files: [{ parentFolder: '', fileName: 'a' }],
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
    }),
    /401/
  )

  let calls = 0
  const files = Array.from({ length: 120 }, (_, i) => ({
    parentFolder: 'p',
    fileName: `f${i}`
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
      const prompt = JSON.parse(init.body).messages[1].content
      const count = Number(/必须恰好包含 (\d+) 项/.exec(prompt)?.[1])
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
  assert.equal(calls, 3) // 40 × 3，三并发降低大批量请求的网关往返次数
  assert.equal(names.length, 120)
  assert.equal(batchReports.at(-1), 120) // 并发完成顺序不固定，但最终进度必须完整
})

test('requestAiNames honors per-model batch size and concurrency', async () => {
  clearAiCache()
  let calls = 0
  let active = 0
  let peakActive = 0
  const files = Array.from({ length: 10 }, (_, index) => ({
    parentFolder: 'p',
    fileName: `f${index}`
  }))
  const names = await requestAiNames({
    baseUrl: 'https://x',
    token: 'sk',
    model: 'm',
    template: '',
    files,
    batchSize: 3,
    batchConcurrency: 2,
    fetchImpl: async (_url, init) => {
      calls += 1
      active += 1
      peakActive = Math.max(peakActive, active)
      const count = Number(
        /必须恰好包含 (\d+) 项/.exec(JSON.parse(init.body).messages[1].content)?.[1]
      )
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: JSON.stringify(Array.from({ length: count }, () => '名称')) } }
          ]
        })
      }
    }
  })
  assert.equal(calls, 4)
  assert.equal(peakActive, 2)
  assert.equal(names.length, 10)
})
