import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertToJpg, isJpegName } from '../src/main/core/image.mjs'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('isJpegName detects jpg/jpeg case-insensitively', () => {
  assert.equal(isJpegName('a.jpg'), true)
  assert.equal(isJpegName('a.JPEG'), true)
  assert.equal(isJpegName('a.png'), false)
  assert.equal(isJpegName('a.webp'), false)
})

test('convertToJpg converts png to a valid jpeg file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-image-'))
  try {
    const source = join(dir, 'poster.png')
    const target = join(dir, 'poster.jpg')
    await writeFile(source, Buffer.from(PNG_BASE64, 'base64'))

    await convertToJpg(source, target)

    const output = await readFile(target)
    // JPEG 魔数 FFD8FF
    assert.equal(output[0], 0xff)
    assert.equal(output[1], 0xd8)
    assert.equal(output[2], 0xff)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('convertToJpg rejects invalid image input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-image-'))
  try {
    const source = join(dir, 'fake.png')
    await writeFile(source, 'not an image')
    await assert.rejects(convertToJpg(source, join(dir, 'out.jpg')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
