import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { analyzeJpeg, needsJpegRepair } from '../src/shared/jpeg-guard.mjs'

/**
 * jpeg-guard 结构扫描器测试。
 * 用 sharp 生成真实 JPEG，再通过字节手术构造各类结构异常，验证识别结果；
 * 同时保证正常 JPEG（含渐进式）零误报。
 */

const makeJpeg = async (options = {}) =>
  sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 120, g: 30, b: 30 } }
  })
    .jpeg(options)
    .toBuffer()

/** 在 SOS 标记前插入 N 字节垃圾（复刻「16128 extraneous bytes before marker 0xda」） */
const withJunkBeforeSos = (jpeg, junkBytes = 16128) => {
  const sosIdx = jpeg.indexOf(Buffer.from([0xff, 0xda]))
  assert.ok(sosIdx > 0, 'clean jpeg 应包含 SOS 标记')
  return Buffer.concat([
    jpeg.subarray(0, sosIdx),
    Buffer.alloc(junkBytes, 0x5a),
    jpeg.subarray(sosIdx)
  ])
}

/** 在 EOI 之后追加垃圾字节 */
const withTrailingData = (jpeg, extra = Buffer.from('HELLO-JUNK-TAIL')) =>
  Buffer.concat([jpeg, extra])

const kinds = (analysis) => analysis.anomalies.map((item) => item.kind)

test('正常 JPEG：无异常、无需修复', async () => {
  const jpeg = await makeJpeg()
  const analysis = analyzeJpeg(jpeg)
  assert.equal(analysis.jpeg, true)
  assert.deepEqual(analysis.anomalies, [])
  assert.equal(needsJpegRepair(jpeg), false)
})

test('渐进式 JPEG：多 SOS 扫描段不误报为垃圾', async () => {
  const jpeg = await makeJpeg({ progressive: true })
  const analysis = analyzeJpeg(jpeg)
  assert.equal(analysis.jpeg, true)
  assert.deepEqual(analysis.anomalies, [])
  assert.equal(needsJpegRepair(jpeg), false)
})

test('SOS 前插入垃圾字节：识别 junk-before-sos 并判定需修复', async () => {
  const jpeg = await makeJpeg()
  const bad = withJunkBeforeSos(jpeg)
  const analysis = analyzeJpeg(bad)
  assert.equal(analysis.jpeg, true)
  assert.ok(kinds(analysis).includes('junk-before-sos'))
  const anomaly = analysis.anomalies.find((item) => item.kind === 'junk-before-sos')
  assert.equal(anomaly.bytes, 16128)
  assert.equal(needsJpegRepair(bad), true)
})

test('EOI 后多余字节：识别 trailing-data，但不触发修复（解码器普遍宽容）', async () => {
  const jpeg = await makeJpeg()
  const bad = withTrailingData(jpeg)
  const analysis = analyzeJpeg(bad)
  assert.deepEqual(kinds(analysis), ['trailing-data'])
  assert.equal(needsJpegRepair(bad), false)
})

test('截断文件：识别 truncated 并判定需修复', async () => {
  const jpeg = await makeJpeg()
  const bad = jpeg.subarray(0, Math.floor(jpeg.length / 2))
  const analysis = analyzeJpeg(bad)
  assert.ok(kinds(analysis).includes('truncated'))
  assert.equal(needsJpegRepair(bad), true)
})

test('空文件 / 非 JPEG 内容：jpeg=false 且判定需修复', async () => {
  assert.equal(analyzeJpeg(Buffer.alloc(0)).jpeg, false)
  assert.equal(needsJpegRepair(Buffer.alloc(0)), true)
  const png = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 128, b: 255 } }
  })
    .png()
    .toBuffer()
  assert.equal(analyzeJpeg(png).jpeg, false)
  assert.equal(needsJpegRepair(png), true)
})

test('熵编码段内 0xFF 后跟非法码：识别 junk-in-scan', async () => {
  const jpeg = await makeJpeg()
  const eoiIdx = jpeg.lastIndexOf(Buffer.from([0xff, 0xd9]))
  // 在熵数据内插入「0xFF + 非 0x00/RST/EOI 码」的垃圾序列
  const junk = Buffer.from([0xff, 0xee, 0xff, 0xbb, 0x12, 0x34])
  const bad = Buffer.concat([jpeg.subarray(0, eoiIdx), junk, jpeg.subarray(eoiIdx)])
  const analysis = analyzeJpeg(bad)
  assert.ok(kinds(analysis).includes('junk-in-scan'))
  assert.equal(needsJpegRepair(bad), true)
})

test('熵编码段内的字节填充与重启标记：不误报', async () => {
  const jpeg = await makeJpeg()
  const eoiIdx = jpeg.lastIndexOf(Buffer.from([0xff, 0xd9]))
  const legal = Buffer.from([0xff, 0x00, 0xff, 0xd0, 0xaa, 0xbb]) // 填充 + RST0 + 熵数据
  const bad = Buffer.concat([jpeg.subarray(0, eoiIdx), legal, jpeg.subarray(eoiIdx)])
  const analysis = analyzeJpeg(bad)
  assert.equal(kinds(analysis).includes('junk-in-scan'), false)
})
