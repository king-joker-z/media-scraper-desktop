import { basename, extname, join } from 'node:path'
import {
  listDirNames,
  moveFile,
  moveWithCollision,
  pathExists,
  permanentDelete,
  removeEmptyDirs,
  writeTextFile
} from '../../core/fs-ops.mjs'
import { collectFailures, finishReport } from '../../core/task-report.mjs'
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
  const stemCounts = new Map()
  for (const video of videos) {
    const stem = basename(video.name, extname(video.name))
    stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1)
  }
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
      // 同 stem 的不同扩展名会共享目录和 NFO，必须像已有目录一样作为冲突项拒绝默认执行。
      conflict: existing.length > 0 || (stemCounts.get(stem) ?? 0) > 1
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
  { taskCenter, taskId, concurrency = 5, signal }
) {
  const startedAt = Date.now()
  // archived 记录每个视频的落位明细（视频/poster/NFO 文件名），供「一键撤销」反向移动
  const report = {
    taskId,
    cancelled: false,
    archivedCount: 0,
    archived: [],
    failed: [],
    durationMs: 0
  }

  const result = await taskCenter.run({
    taskId,
    label: 'NFO 归档',
    items,
    concurrency,
    signal,
    worker: async (item, itemSignal) => {
      if (itemSignal?.aborted) throw new Error('已取消')
      if (item.conflict) throw new Error('目标目录存在冲突，请重新扫描并跳过该项')
      const targetDir = join(root, item.targetDir)
      if ((await listDirNames(targetDir)).length > 0)
        throw new Error('目标目录已发生变化，请重新扫描后再执行')
      const originalVideo = join(root, item.videoRel)
      const originalPoster = item.posterRel ? join(root, item.posterRel) : null
      let videoFinal = null
      let posterFinal = null
      let nfoPath = null
      try {
        videoFinal = await moveWithCollision(originalVideo, targetDir, { signal: itemSignal })
        if (originalPoster)
          posterFinal = await moveWithCollision(originalPoster, targetDir, { signal: itemSignal })
        const videoName = basename(videoFinal, extname(videoFinal))
        const nfoName = `${videoName}.nfo`
        nfoPath = join(targetDir, nfoName)
        await writeTextFile(
          nfoPath,
          renderNfoXml({
            title: videoName,
            posterName: posterFinal ? basename(posterFinal) : null,
            actorName
          })
        )
        if (!(await pathExists(nfoPath)) || !(await pathExists(videoFinal)))
          throw new Error('归档结果校验失败')
        report.archivedCount += 1
        report.archived.push({
          videoRel: item.videoRel,
          posterRel: item.posterRel,
          targetDir: item.targetDir,
          videoName: basename(videoFinal),
          posterName: posterFinal ? basename(posterFinal) : null,
          nfoName
        })
      } catch (error) {
        await permanentDelete(nfoPath).catch(() => {})
        if (posterFinal && originalPoster && (await pathExists(posterFinal)))
          await moveFile(posterFinal, originalPoster).catch(() => {})
        if (videoFinal && (await pathExists(videoFinal)))
          await moveFile(videoFinal, originalVideo).catch(() => {})
        await removeEmptyDirs(root).catch(() => [])
        throw error
      }
    }
  })

  collectFailures(report, result, items, 'videoRel')
  return finishReport(report, startedAt, result.cancelled)
}
