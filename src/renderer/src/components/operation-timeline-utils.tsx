import type { OpLogSummary } from '../../../shared/types'

const moduleLabels: Record<string, string> = {
  clean: '目录清理',
  rename: '批量重命名',
  nfo: 'NFO 归档',
  'merge-delete-sources': '合并源删除',
  'dedupe-delete': '去重删除',
  'comic-delete-sources': '漫画源图删除',
  'comic-rename': '漫画重命名',
  'comic-merge': '漫画合并',
  undo: '一键撤销'
}

export const operationLabel = (module: string): string => moduleLabels[module] ?? module

export function renderOperationGlyph(category: OpLogSummary['category']): React.JSX.Element {
  const glyphs = {
    delete: (
      <path d="M3 4.5h10m-7.2 0 .5-1.5h3.4l.5 1.5m-5.8 0 .5 8.5h6.4l.5-8.5M7 7v3.5m2-3.5v3.5" />
    ),
    rename: <path d="M3 4h6.8L13 7.2 9.8 10.5H3V4Zm5.7 0v3h3M5.2 12.3h6.1" />,
    archive: <path d="M3 5h10v8H3V5Zm1-2h8v2H4V3Zm2.1 5h3.8" />,
    merge: <path d="M3 4.2h3.2l1.4 2.2L9 4.2H13M3 11.8h3.2L7.6 9.6 9 11.8H13" />,
    other: <path d="M3 3.2h7.1L13 6.1v6.7H3V3.2Zm7 0v3h3" />
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      {glyphs[category]}
    </svg>
  )
}
