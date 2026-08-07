import { basename, extname, join } from 'node:path'
import { listDirNames, moveWithCollision, pathExists, writeTextFile } from '../../core/fs-ops.mjs'
import { listPosterVideos } from '../poster/poster.mjs'

/** XML 特殊字符转义 */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 渲染 NFO（冻结稿 §7，兼容 Kodi/Jellyfin/Emby）。
 * 无 poster 时省略 <poster> 行。
 */
export function renderNfoXml({ title, posterName, actorName }) {
  const lines = [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    '<movie>',
    `  <title>${escapeXml(title)}</title>`
  ]
  if (posterName) lines.push(`  <poster>${escapeXml(posterName)}</poster>`)
  lines.push(
    '  <actor>',
    `    <name>${escapeXml(actorName)}</name>`,
    `    <role>${escapeXml(actorName)}</role>`,
    '    <type>Actor</type>',
    '  </actor>',
    '</movie>'
  )
  return lines.join('\n') + '\n'
}

/**
 * 生成归档计划：每个视频一个同名目录（视频 + poster + NFO）。
 * 目标目录已存在且非空 → conflict 标记，由用户决定是否跳过。
 */
export async function createNfoPlan(root, { onProgress } = {}) {
  const videos = await listPosterVideos(root, { onProgress })
  const items = []
  for (const video of videos) {
    const stem = basename(video.name, extname(video.name))
    const targetDir = join(root, stem)
    const existing = await listDirNames(targetDir)
    items.push({
      videoRel: video.relativePath,
      stem,
      posterRel: video.posterRelativePath,
      targetDir: stem,
      conflict: existing.length > 0
    })
  }
  return { root, items, actorDefault: basename(root) }
}

/**
 * 执行归档：建目录 → 移入视频与 poster → 生成 NFO → 校验。
 * actorName 取工作区文件夹名或用户指定（冻结稿 §7）。
 */
export async function executeNfoPlan(
  root,
  items,
  actorName,
  { taskCenter, taskId, concurrency = 5 }
) {
  const startedAt = Date.now()
  const report = { taskId, cancelled: false, archivedCount: 0, failed: [], durationMs: 0 }

  const result = await taskCenter.run({
    taskId,
    label: 'NFO 归档',
    items,
    concurrency,
    worker: async (item) => {
      const targetDir = join(root, item.targetDir)
      // 移入视频与 poster（重名自动 (n)）
      const videoFinal = await moveWithCollision(join(root, item.videoRel), targetDir)
      let posterName = null
      if (item.posterRel) {
        const posterFinal = await moveWithCollision(join(root, item.posterRel), targetDir)
        posterName = basename(posterFinal)
      }
      // 生成 NFO
      const videoName = basename(videoFinal, extname(videoFinal))
      const nfoPath = join(targetDir, `${videoName}.nfo`)
      await writeTextFile(nfoPath, renderNfoXml({ title: videoName, posterName, actorName }))
      // 校验：三个文件关系
      if (!(await pathExists(nfoPath))) throw new Error('NFO 写入失败')
      if (!(await pathExists(videoFinal))) throw new Error('视频移动校验失败')
      report.archivedCount += 1
    }
  })

  result.results.forEach((entry, index) => {
    if (!entry.ok && !entry.cancelled) {
      report.failed.push({ target: items[index].videoRel, error: entry.error ?? '未知错误' })
    }
  })
  report.cancelled = result.cancelled
  report.durationMs = Date.now() - startedAt
  return report
}
