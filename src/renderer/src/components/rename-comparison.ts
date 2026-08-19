import { extOfName, stemOfName, validateRenameTargets } from '../../../shared/rename-rules.mjs'
import type { RenamePreflightItem } from '../../../shared/types'

export type RenameFilter =
  'all' | 'changed' | 'unchanged' | 'conflict' | 'windows' | 'manual' | 'ai'

export interface RenameRuleStep {
  label: string
  before: string
  after: string
}

export interface RenameComparisonSource {
  relativePath: string
  name: string
  posterRelativePath: string | null
  posterPath: string | null
  size: number
}

export interface RenameComparisonPair {
  videoRel: string
  posterRel: string | null
  newStem: string
  newExt?: string
}

export interface RenameComparisonRow {
  videoRel: string
  source: RenameComparisonSource
  originalStem: string
  originalExtension: string
  computedStem: string
  targetStem: string
  targetExtension: string
  targetName: string
  changed: boolean
  manual: boolean
  ai: boolean
  error?: string
  risk: 'none' | 'extension' | 'probe' | 'windows' | 'conflict' | 'external'
  probeError?: string
  externalCollisions: string[]
  ruleSteps: RenameRuleStep[]
}

export interface RenameRelationship {
  kind: 'swap' | 'chain' | 'duplicate'
  members: string[]
  label: string
}

const WINDOWS_ERROR = /(Windows|非法字符|末尾)/

const joinRelativeTarget = (relativePath: string, name: string): string => {
  const separator = Math.max(relativePath.lastIndexOf('/'), relativePath.lastIndexOf('\\'))
  return separator < 0 ? name : `${relativePath.slice(0, separator + 1)}${name}`
}

/**
 * 将执行用的重命名对转换为只供 renderer 展示的解释模型。
 * 真实合法性判断仍委托 shared/rename-rules 的 validateStems，避免预览与执行规则漂移。
 */
export function buildRenameComparisonRows({
  sources,
  computedPairs,
  pairs,
  edits,
  errors,
  mode,
  ruleStepsByVideo,
  extensionRisks,
  probeErrors,
  preflight
}: {
  sources: RenameComparisonSource[]
  computedPairs: RenameComparisonPair[]
  pairs: RenameComparisonPair[]
  edits: Record<string, string>
  errors?: Record<string, string>
  mode: 'seq' | 'regex' | 'ai' | 'ext'
  ruleStepsByVideo?: Record<string, RenameRuleStep[]>
  extensionRisks?: Set<string>
  probeErrors?: Record<string, string>
  preflight?: Record<string, RenamePreflightItem>
}): RenameComparisonRow[] {
  const sourceByRel = new Map(sources.map((source) => [source.relativePath, source]))
  const computedByRel = new Map(computedPairs.map((pair) => [pair.videoRel, pair]))
  const validation = validateRenameTargets(pairs, (pair) => {
    const source = sourceByRel.get(pair.videoRel)
    const extension = pair.newExt ?? extOfName(source?.name ?? '')
    return joinRelativeTarget(pair.videoRel, `${pair.newStem}${extension}`)
  })

  const rows: RenameComparisonRow[] = pairs.flatMap((pair): RenameComparisonRow[] => {
    const source = sourceByRel.get(pair.videoRel)
    if (!source) return []
    const computed = computedByRel.get(pair.videoRel) ?? pair
    const originalStem = stemOfName(source.name)
    const originalExtension = extOfName(source.name)
    const targetExtension = pair.newExt ?? originalExtension
    const targetName = `${pair.newStem}${targetExtension}`
    const error = errors?.[pair.videoRel] ?? validation[pair.videoRel]
    const extensionRisk = Boolean(pair.newExt && extensionRisks?.has(pair.videoRel))
    const probeError = probeErrors?.[pair.videoRel]
    const externalCollisions = preflight?.[pair.videoRel]?.externalCollisions ?? []
    const risk = error?.includes('同一目标')
      ? 'conflict'
      : error && WINDOWS_ERROR.test(error)
        ? 'windows'
        : probeError
          ? 'probe'
          : extensionRisk
            ? 'extension'
            : externalCollisions.length > 0
              ? 'external'
              : 'none'
    const steps = ruleStepsByVideo?.[pair.videoRel] ?? []
    const fallbackSteps: RenameRuleStep[] = [
      {
        label: mode === 'ai' ? 'AI 命名' : mode === 'ext' ? '扩展名调整' : '规则计算',
        before: originalStem,
        after: computed.newStem
      }
    ]

    return [
      {
        videoRel: pair.videoRel,
        source,
        originalStem,
        originalExtension,
        computedStem: computed.newStem,
        targetStem: pair.newStem,
        targetExtension,
        targetName,
        changed: source.name !== targetName,
        manual: Object.hasOwn(edits, pair.videoRel),
        ai: mode === 'ai',
        error,
        risk,
        probeError,
        externalCollisions,
        ruleSteps: steps.length > 0 ? steps : fallbackSteps
      }
    ]
  })
  return rows
}

/** 返回预览中需要解释的交换、链式占用与多目标重复关系，不介入主进程的两段式执行。 */
const targetRelativePath = (relativePath: string, name: string): string =>
  joinRelativeTarget(relativePath, name).normalize('NFC').toLocaleLowerCase('en-US')

export function analyzeRenameRelationships(rows: RenameComparisonRow[]): RenameRelationship[] {
  const changing = rows.filter((row) => row.changed)
  const originalOwner = new Map(
    changing.map((row) => [
      targetRelativePath(row.source.relativePath, row.source.name),
      row.videoRel
    ])
  )
  const targets = new Map<string, string[]>()
  const next = new Map<string, string>()

  for (const row of changing) {
    const targetKey = targetRelativePath(row.videoRel, row.targetName)
    const owners = targets.get(targetKey) ?? []
    owners.push(row.videoRel)
    targets.set(targetKey, owners)
    const owner = originalOwner.get(targetKey)
    if (owner && owner !== row.videoRel) next.set(row.videoRel, owner)
  }

  const relationships: RenameRelationship[] = []
  for (const members of targets.values()) {
    if (members.length > 1) {
      relationships.push({
        kind: 'duplicate',
        members,
        label: `${members.length} 项指向同一目标名称`
      })
    }
  }

  const visited = new Set<string>()
  for (const start of next.keys()) {
    if (visited.has(start)) continue
    const route: string[] = []
    const positions = new Map<string, number>()
    let current: string | undefined = start
    while (current && !positions.has(current)) {
      positions.set(current, route.length)
      route.push(current)
      current = next.get(current)
    }
    route.forEach((item) => visited.add(item))
    if (!current) continue
    const cycle = route.slice(positions.get(current) ?? 0)
    if (cycle.length > 1) {
      relationships.push({
        kind: cycle.length === 2 ? 'swap' : 'chain',
        members: cycle,
        label:
          cycle.length === 2
            ? '检测到名称交换，将经临时名安全落位'
            : `${cycle.length} 项循环占用，将经临时名安全落位`
      })
    }
  }
  return relationships
}

export function matchesRenameFilter(row: RenameComparisonRow, filter: RenameFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'changed') return row.changed
  if (filter === 'unchanged') return !row.changed
  if (filter === 'conflict') return row.risk === 'conflict'
  if (filter === 'windows') return row.risk === 'windows'
  if (filter === 'manual') return row.manual
  return row.ai
}
