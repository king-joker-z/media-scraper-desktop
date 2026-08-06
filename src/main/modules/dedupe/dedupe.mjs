import { createScanPlan } from '../../core/scanner.mjs'
import { hashFileSample } from '../../core/file-hash.mjs'

/**
 * 视频去重扫描（只读）：
 * 1. 按文件大小分组 —— 大小不同必然不重复，秒级过滤；
 * 2. 对大小相同的候选计算首尾样本哈希；
 * 3. 哈希相同的归为重复组。
 *
 * @param {string} root 工作区
 * @param {object} [options] { taskCenter, taskId, concurrency } 可选任务中心（进度与并发）
 * @returns {Promise<Array<{hash: string, sizeBytes: number, items: Array}>>} 重复组（组内 ≥2 个）
 */
export async function findDuplicates(root, { taskCenter, taskId, concurrency = 5 } = {}) {
  const plan = await createScanPlan(root)
  const videos = plan.keep.filter((item) => item.kind === 'video')

  const bySize = new Map()
  for (const video of videos) {
    if (!bySize.has(video.size)) bySize.set(video.size, [])
    bySize.get(video.size).push(video)
  }
  const candidates = [...bySize.values()].filter((group) => group.length > 1).flat()

  const hashOne = async (video) => ({
    video,
    hash: await hashFileSample(video.path)
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

  const byHash = new Map()
  for (const { video, hash } of hashed) {
    if (!byHash.has(hash)) byHash.set(hash, [])
    byHash.get(hash).push(video)
  }
  return [...byHash.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([hash, group]) => ({
      hash,
      sizeBytes: group[0].size,
      items: group.map((video) => ({
        relativePath: video.relativePath,
        name: video.name,
        dir: video.dir,
        size: video.size
      }))
    }))
}
