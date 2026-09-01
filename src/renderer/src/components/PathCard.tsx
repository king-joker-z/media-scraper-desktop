import { usePalette } from '../hooks/usePalette'

type PathCardProps = {
  label: string
  value: string
  emptyHint?: string
}

/**
 * 「当前工作区」路径卡片：默认皮肤保持原有 <span + strong> 结构；
 * 其余皮肤渲染完全不同的 DOM ——
 * - terminal：切角读数条，mono 前缀标签 + 常亮状态点
 * - comic（漫画风）：墨框白卡 + 黑胶囊标签
 * - comic-ukiyo（浮世绘卷）：和纸框 + 红点衬线标注 + 底部波纹
 */
function PathCard({ label, value, emptyHint = '尚未选择目录' }: PathCardProps): React.JSX.Element {
  const palette = usePalette()
  const shown = value || emptyHint

  if (palette === 'terminal') {
    return (
      <section className="path-card tpc" aria-label={label}>
        <i className="tpc-tag" aria-hidden="true">
          WORKSPACE
        </i>
        <span className="tpc-dot" aria-hidden="true" />
        <b className="tpc-path">{shown}</b>
        <u className="tpc-rule" aria-hidden="true" />
      </section>
    )
  }

  if (palette === 'comic') {
    return (
      <section className="path-card cpc" aria-label={label}>
        <span className="cpc-label">{label}</span>
        <b className="cpc-path">{shown}</b>
      </section>
    )
  }

  if (palette === 'comic-ukiyo') {
    return (
      <section className="path-card upc" aria-label={label}>
        <span className="upc-label">{label}</span>
        <b className="upc-path">{shown}</b>
        <u className="upc-wave" aria-hidden="true" />
      </section>
    )
  }

  return (
    <section className="path-card" aria-label={label}>
      <span>{label}</span>
      <strong>{shown}</strong>
    </section>
  )
}

export default PathCard
