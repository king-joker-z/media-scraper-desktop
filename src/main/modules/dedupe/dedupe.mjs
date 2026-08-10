import { createScanPlan } from '../../core/scanner.mjs'
import { hashFileSampleCached } from '../../core/file-hash.mjs'
import { probeMediaCached } from '../../core/probe.mjs'

/** 相似重复判定：时长容差 ±0.5s（同片不同压制的时长几乎一致，容差收紧防误判） */
export const SIMILAR_DURATION_TOLERANCE_MS = 500

/** 相似重复判定：组内最大体积差比例下限（同片不同压制通常码率差异大，体积差 >= 10%） */
export const SIMILAR_SIZE_RATIO_MIN = 0.1

/**
 * 质量分：分辨率面积优先，其次平均码率（大小/时长）。
 * 用于重复组内「建议保留」排序——同内容保留画质最好的一份。
 */
function qualityScore(media, size) {
  if (!media) return 0
  const area = (media.width ?? 0) * (media.height ?? 0)
  const bitrate = media.durationMs > 0 ? size / (media.durationMs / 1000) : 0
  return area * 1e9 + bitrate
}

const mediaOf = (mediaMap, relativePath) => mediaMap.get(relativePath) ?? null

/**
 * 视频去重扫描（只读）：
 * 1. 按文件大小分组 —— 大小不同必然不重复，秒级过滤；
 * 2. 对大小相同的候选计算头/中/尾采样哈希；
 * 3. 哈希相同 → 完全重复组（exact），组内按质量排序并给出建议保留项；
 * 4. 全部视频探测媒体信息（带缓存），按时长±2s + 同分辨率聚类 →
 *    相似重复组（similar，同片不同压制版本，内容指纹不同）。
 *
 * @param {string} root 工作区
 * @param {object} [options]
 * @param {object} [options.taskCenter] 任务中心（进度与并发）
 * @param {string} [options.taskId]
 * @param {number} [options.concurrency]
 * @param {string} [options.ffprobePath]
 * @param {(path: string) => Promise<object>} [options.probeFn] 测试注入用
 * @param {boolean} [options.includeSimilar] 是否检测相似重复（默认 true）；
 *   false 时跳过全量 ffprobe 与相似聚类——完全重复只需大小+采样哈希，大工作区首扫从分钟级降到秒级
 * @returns {Promise<{exact: Array, similar: Array}>}
 */
export async function findDuplicates(
  root,
  { taskCenter, taskId, concurrency = 5, ffprobePath, probeFn, includeSimilar = true } = {}
) {
  const plan = await createScanPlan(root)
  const videos = plan.keep.filter((item) => item.kind === 'video')

  // ---- 1+2. 大小分组 → 采样哈希 ----
  const bySize = new Map()
  for (const video of videos) {
    if (!bySize.has(video.size)) bySize.set(video.size, [])
    bySize.get(video.size).push(video)
  }
  const candidates = [...bySize.values()].filter((group) => group.length > 1).flat()

  const hashOne = async (video) => ({
    video,
    hash: await hashFileSampleCached(video.path)
  })

  let hashed
  if (taskCenter) {
    const result = await taskCenter.run({
      taskId,
      label: '计算文件指纹',
      items: candidates,
      concurrency,
      worker: hashOne
    })
    hashed = result.results
      .map((entry, index) => (entry.ok ? entry.value : { video: candidates[index], hash: null }))
      .filter((entry) => entry.hash)
  } else {
    hashed = []
    for (const candidate of candidates) hashed.push(await hashOne(candidate))
  }
  const hashByPath = new Map(hashed.map(({ video, hash }) => [video.relativePath, hash]))

  // ---- 3. 探测全部视频的媒体信息（带缓存，二次扫描秒回）----
  // 快速模式跳过：完全重复判定不依赖媒体参数（质量排序退化为路径序）
  const mediaMap = new Map()
  if (includeSimilar) {
    const probe = probeFn ?? ((path) => probeMediaCached(path, ffprobePath))
    const probeOne = async (video) => {
      let media = null
      try {
        media = await probe(video.path)
      } catch {
        media = null
      }
      return { video, media }
    }
    let probed
    if (taskCenter) {
      const result = await taskCenter.run({
        taskId: `${taskId}-probe`,
        label: '读取媒体信息',
        items: videos,
        concurrency,
        worker: probeOne
      })
      probed = result.results.map((entry, index) =>
        entry.ok ? entry.value : { video: videos[index], media: null }
      )
    } else {
      probed = []
      for (const video of videos) probed.push(await probeOne(video))
    }
    for (const { video, media } of probed) mediaMap.set(video.relativePath, media)
  }

  // ---- 4. 完全重复组（质量降序，首个为建议保留）----
  const byHash = new Map()
  for (const { video, hash } of hashed) {
    if (!byHash.has(hash)) byHash.set(hash, [])
    byHash.get(hash).push(video)
  }
  const exact = [...byHash.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([hash, group]) => {
      const items = group
        .map((video) => ({
          relativePath: video.relativePath,
          name: video.name,
          dir: video.dir,
          size: video.size,
          media: mediaOf(mediaMap, video.relativePath)
        }))
        .sort((a, b) => qualityScore(b.media, b.size) - qualityScore(a.media, a.size))
      return { hash, sizeBytes: group[0].size, keepRel: items[0].relativePath, items }
    })

  // ---- 5. 相似重复组：同分辨率 + 时长相近，但内容指纹不同 ----
  const similar = []
  const byResolution = new Map()
  if (includeSimilar) {
    for (const video of videos) {
      const media = mediaMap.get(video.relativePath)
      if (!media || !media.durationMs || !media.width || !media.height) continue
      const key = `${media.width}x${media.height}`
      if (!byResolution.has(key)) byResolution.set(key, [])
      byResolution.get(key).push({ video, media })
    }
  }
  for (const [resolution, bucket] of byResolution) {
    if (bucket.length < 2) continue
    bucket.sort((a, b) => a.media.durationMs - b.media.durationMs)
    // 相邻聚类：时长差在容差内归为同一片源
    let cluster = [bucket[0]]
    const flush = () => {
      const distinctHashes = new Set(
        cluster.map((entry) => hashByPath.get(entry.video.relativePath) ?? entry.video.relativePath)
      )
      // 全部同指纹 → 已在完全重复组体现；仅单个文件 → 非重复
      if (cluster.length >= 2 && distinctHashes.size >= 2) {
        // 体积差比例判定：同片不同压制的体积通常差异明显（码率不同）；
        // 不同内容的视频即使分辨率/时长一致，体积也几乎相同（如截图中的 3 个 6s 视频）
        const sizes = cluster.map((entry) => entry.video.size)
        const maxSize = Math.max(...sizes)
        const minSize = Math.min(...sizes)
        if (maxSize > 0 && (maxSize - minSize) / maxSize < SIMILAR_SIZE_RATIO_MIN) {
          cluster = []
          return
        }
        const items = cluster
          .map((entry) => ({
            relativePath: entry.video.relativePath,
            name: entry.video.name,
            dir: entry.video.dir,
            size: entry.video.size,
            media: entry.media,
            // 同指纹的完全重复副本数（>1 表示还有完全相同的副本）
            exactCopies: cluster.filter(
              (other) =>
                hashByPath.get(other.video.relativePath) !== undefined &&
                hashByPath.get(other.video.relativePath) ===
                  hashByPath.get(entry.video.relativePath)
            ).length
          }))
          .sort((a, b) => b.size - a.size)
        similar.push({ key: resolution, keepRel: items[0].relativePath, items })
      }
      cluster = []
    }
    for (let i = 1; i < bucket.length; i += 1) {
      const prev = cluster[cluster.length - 1]
      if (
        Math.abs(bucket[i].media.durationMs - prev.media.durationMs) <=
        SIMILAR_DURATION_TOLERANCE_MS
      ) {
        cluster.push(bucket[i])
      } else {
        flush()
        cluster = [bucket[i]]
      }
    }
    flush()
  }

  return { exact, similar }
}
