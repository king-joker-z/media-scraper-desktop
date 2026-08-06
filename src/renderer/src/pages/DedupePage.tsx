import { useMemo, useState } from 'react'
import ConfirmDialog from '../components/ConfirmDialog'
import { formatBytes } from '../utils/format'

interface DupItem {
  relativePath: string
  name: string
  dir: string
  size: number
}
interface DupGroup {
  hash: string
  sizeBytes: number
  items: DupItem[]
}

function DedupePage({
  workspace,
  onChooseWorkspace
}: {
  workspace: string
  onChooseWorkspace: () => Promise<void>
}): React.JSX.Element {
  const [groups, setGroups] = useState<DupGroup[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // 默认每组保留第一个，其余勾选删除
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const scan = async (): Promise<void> => {
    if (!workspace) return
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const result = (await window.api.scanDuplicates(workspace)) as DupGroup[]
      setGroups(result)
      setChecked(
        new Set(result.flatMap((group) => group.items.slice(1).map((item) => item.relativePath)))
      )
      setLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const checkedBytes = useMemo(
    () =>
      groups.reduce(
        (sum, group) =>
          sum +
          group.items
            .filter((item) => checked.has(item.relativePath))
            .reduce((s, item) => s + item.size, 0),
        0
      ),
    [groups, checked]
  )

  const toggle = (rel: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
  }

  const execute = async (): Promise<void> => {
    if (!workspace) return
    setConfirming(false)
    setDeleting(true)
    setError('')
    try {
      const report = await window.api.deleteDuplicates(workspace, [...checked])
      setNotice(
        `已删除 ${report.deletedCount} 个重复文件（释放 ${formatBytes(checkedBytes)}）` +
          (report.failed.length ? `，失败 ${report.failed.length} 个` : '')
      )
      await scan()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">视频去重</p>
          <h1>重复视频检测</h1>
          <p className="muted">按「大小 + 首尾内容指纹」判定完全相同的文件；默认每组保留首个。</p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={onChooseWorkspace} disabled={deleting}>
            选择工作区
          </button>
          <button className="secondary" onClick={scan} disabled={!workspace || loading || deleting}>
            {loading ? '检测中…' : '开始检测'}
          </button>
          {checked.size > 0 && (
            <button
              className="danger-button"
              disabled={deleting}
              onClick={() => setConfirming(true)}
            >
              {deleting ? '删除中…' : `删除选中（${checked.size}）`}
            </button>
          )}
        </div>
      </header>

      <section className="path-card">
        <span>当前工作区</span>
        <strong>{workspace || '尚未选择目录'}</strong>
      </section>

      {error && <section className="error-banner">{error}</section>}
      {notice && <section className="notice-banner">{notice}</section>}

      {loaded && groups.length === 0 && (
        <section className="empty">
          <h2>没有发现重复视频 🎉</h2>
          <p>当前工作区内没有内容完全相同的视频文件。</p>
        </section>
      )}
      {!loaded && (
        <section className="empty">
          <h2>准备检测</h2>
          <p>选择工作区并点击「开始检测」。只读扫描，不改动任何文件。</p>
        </section>
      )}

      {groups.map((group, index) => (
        <section key={group.hash} className="settings-card">
          <h2>
            重复组 {index + 1}
            <small className="muted">
              {' '}
              · {group.items.length} 个文件 · 每个 {formatBytes(group.sizeBytes)}
            </small>
          </h2>
          {group.items.map((item, itemIndex) => (
            <label key={item.relativePath} className="confirm-check dup-row">
              <input
                type="checkbox"
                checked={checked.has(item.relativePath)}
                onChange={() => toggle(item.relativePath)}
              />
              <span className="dup-path" title={item.relativePath}>
                {item.relativePath}
              </span>
              <span className={itemIndex === 0 ? 'ok-text' : 'muted'}>
                {itemIndex === 0 ? '默认保留' : '重复'}
              </span>
            </label>
          ))}
        </section>
      ))}

      {confirming && (
        <ConfirmDialog
          title="删除重复视频"
          deleteCount={checked.size}
          deleteBytes={checkedBytes}
          danger={checked.size > 50}
          extra="将永久删除选中的重复文件，每组未被勾选的文件保留。"
          onConfirm={execute}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

export default DedupePage
