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
 * 按相似度建立稳定的连通组。阈值越小越严格；返回仅包含至少两项的组，
 * 组内索引保持输入顺序，以便调用方决定代表帧。
 */
export function groupSimilarHashes(hashes, threshold = 10) {
  const parent = hashes.map((_, index) => index)
  const find = (index) => {
    let current = index
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]]
      current = parent[current]
    }
    return current
  }
  const union = (left, right) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
  }

  for (let left = 0; left < hashes.length; left += 1) {
    if (!hashes[left]) continue
    for (let right = left + 1; right < hashes.length; right += 1) {
      if (hashes[right] && hammingDistance(hashes[left], hashes[right]) <= threshold)
        union(left, right)
    }
  }

  const groups = new Map()
  hashes.forEach((hash, index) => {
    if (!hash) return
    const root = find(index)
    const members = groups.get(root) ?? []
    members.push(index)
    groups.set(root, members)
  })
  return [...groups.values()].filter((members) => members.length > 1)
}
