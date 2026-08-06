import sharp from 'sharp'

const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg'])

export const isJpegName = (name) =>
  JPEG_EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase())

/**
 * 将图片转换为 JPG（quality 90，mozjpeg）。
 * 返回写入的目标路径。调用方负责保证 target 不重名。
 */
export async function convertToJpg(source, target) {
  await sharp(source)
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(target)
  return target
}
