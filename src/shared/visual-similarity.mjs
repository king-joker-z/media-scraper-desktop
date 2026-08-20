/**
 * 从灰度像素计算 8×8 差值感知哈希。该哈希只用于同一视频候选帧的辅助分组，
 * 不用于删除、保存顺序或任何自动选择决策。
 */
export function computeDifferenceHash(data, width, height) {
  if (!data?.length || width < 2 || height < 1) return '0000000000000000'
  let hash = 0n
  let bit = 0n
  for (let y = 0; y < 8; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor(((y + 0.5) * height) / 8))
    for (let x = 0; x < 8; x += 1) {
      const leftX = Math.min(width - 1, Math.floor(((x + 0.5) * width) / 9))
      const rightX = Math.min(width - 1, Math.floor(((x + 1.5) * width) / 9))
      if (data[sourceY * width + leftX] > data[sourceY * width + rightX]) hash |= 1n << bit
      bit += 1n
    }
  }
  return hash.toString(16).padStart(16, '0')
}

/** 计算两个十六进制感知哈希的汉明距离（0–64）。 */
export function hammingDistance(left, right) {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`)
  let count = 0
  while (value) {
    count += Number(value & 1n)
    value >>= 1n
  }
  return count
}

/**
 * 以输入顺序中的首项为代表帧建立非传递相似组。
 *
 * 调用方应先按候选质量降序排列，因此每组首项即质量最高的代表帧。成员只会在
 * 与代表帧的距离不大于阈值时加入；不会因 A≈B、B≈C 而把 A 与 C 错误折叠。
 */
export function groupSimilarHashes(hashes, threshold = 10) {
  const groups = []
  for (let index = 0; index < hashes.length; index += 1) {
    const hash = hashes[index]
    if (!hash) continue
    const group = groups.find(
      (candidate) => hammingDistance(hashes[candidate[0]], hash) <= threshold
    )
    if (group) group.push(index)
    else groups.push([index])
  }
  return groups.filter((members) => members.length > 1)
}
