import { useCallback, useEffect, useRef, useState } from 'react'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type {
  AppSettings,
  PipelineModuleId,
  PipelinePreset,
  PipelineReport,
  PipelineStep
} from '../../../shared/types'
import ConfirmDialog from '../components/ConfirmDialog'
import ErrorBanner from '../components/ErrorBanner'

/** 生成步骤 ID（使用 React ref 存储计数器，避免渲染期不纯函数） */
const createStepId = (counter: React.MutableRefObject<number>): string => {
  counter.current += 1
  return `s-${counter.current}`
}

/** 可用模块列表（流水线可编排的模块） */
const MODULE_OPTIONS: { id: PipelineModuleId; icon: string; label: string; desc: string }[] = [
  {
    id: 'clean',
    icon: '🧹',
    label: '目录清理',
    desc: '自动清理无用文件、上移保留文件、标准化 poster（跳过需人工选择的项）'
  },
  {
    id: 'nfo',
    icon: '📦',
    label: 'NFO 归档',
    desc: '为每个视频建立同名目录，移入视频与 poster，生成 NFO 元数据'
  },
  {
    id: 'dedupe',
    icon: '🧬',
    label: '视频去重',
    desc: '扫描完全重复项并自动删除（保留质量最高的一份）'
  },
  {
    id: 'health',
    icon: '🩺',
    label: '健康体检',
    desc: '全量解码校验损坏文件，汇总缺封面 / 缺 NFO（只读，不改动文件）'
  }
]

const moduleLabel = (id: PipelineModuleId): string =>
  MODULE_OPTIONS.find((m) => m.id === id)?.label ?? id
const moduleIcon = (id: PipelineModuleId): string =>
  MODULE_OPTIONS.find((m) => m.id === id)?.icon ?? '❓'

/**
 * 自动化流水线：可视化拖拽编排模块执行顺序，保存多个预设，一键执行。
 * 适合自动化的模块：clean（自动模式）、nfo、dedupe（自动删除）、health（只读）。
 */
function PipelinePage({
  workspace,
  onChooseWorkspace
}: {
  active: boolean
  workspace: string
  onChooseWorkspace: () => Promise<void>
}): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [steps, setSteps] = useState<PipelineStep[]>([])
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<PipelineReport | null>(null)
  const [error, setError] = useState('')
  const [presetName, setPresetName] = useState('')
  const [confirming, setConfirming] = useState(false)

  // 加载设置 & 初始化预设
  useEffect(() => {
    window.api
      .getSettings()
      .then((s) => {
        setSettings(s)
        const first = s.pipelinePresets[0]
        if (first) {
          setSelectedPresetId(first.id)
          setSteps(first.steps)
        }
      })
      .catch(() => {})
  }, [])

  const selectedPreset = settings?.pipelinePresets.find((p) => p.id === selectedPresetId)

  const selectPreset = useCallback(
    (id: string): void => {
      const preset = settings?.pipelinePresets.find((p) => p.id === id)
      if (preset) {
        setSelectedPresetId(id)
        setSteps(preset.steps.map((s) => ({ ...s })))
        setReport(null)
        setError('')
      }
    },
    [settings]
  )

  const persistPreset = useCallback(
    async (presetId: string, newSteps: PipelineStep[]): Promise<void> => {
      if (!settings) return
      const updated = settings.pipelinePresets.map((p) =>
        p.id === presetId ? { ...p, steps: newSteps } : p
      )
      const next = await window.api.updateSettings({ pipelinePresets: updated })
      setSettings(next)
    },
    [settings]
  )

  // 拖拽排序
  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = steps.findIndex((s) => s.id === active.id)
    const to = steps.findIndex((s) => s.id === over.id)
    const newSteps = arrayMove(steps, from, to)
    setSteps(newSteps)
    void persistPreset(selectedPresetId, newSteps)
  }

  // 添加模块到步骤末尾
  const stepCounterRef = useRef(0)
  const addModule = (moduleId: PipelineModuleId): void => {
    const newStep: PipelineStep = {
      id: createStepId(stepCounterRef),
      module: moduleId,
      enabled: true
    }
    const newSteps = [...steps, newStep]
    setSteps(newSteps)
    void persistPreset(selectedPresetId, newSteps)
  }

  // 切换步骤启用/禁用
  const toggleStep = (stepId: string): void => {
    const newSteps = steps.map((s) => (s.id === stepId ? { ...s, enabled: !s.enabled } : s))
    setSteps(newSteps)
    void persistPreset(selectedPresetId, newSteps)
  }

  // 删除步骤
  const removeStep = (stepId: string): void => {
    const newSteps = steps.filter((s) => s.id !== stepId)
    setSteps(newSteps)
    void persistPreset(selectedPresetId, newSteps)
  }

  // 新建预设
  const createPreset = async (): Promise<void> => {
    if (!settings || !presetName.trim()) return
    const newPreset: PipelinePreset = {
      id: `preset-${settings.pipelinePresets.length + 1}`,
      name: presetName.trim(),
      steps: []
    }
    const updated = [...settings.pipelinePresets, newPreset]
    const next = await window.api.updateSettings({ pipelinePresets: updated })
    setSettings(next)
    setSelectedPresetId(newPreset.id)
    setSteps([])
    setPresetName('')
  }

  // 删除预设
  const deletePreset = async (): Promise<void> => {
    if (!settings || !selectedPreset || settings.pipelinePresets.length <= 1) return
    const updated = settings.pipelinePresets.filter((p) => p.id !== selectedPresetId)
    const next = await window.api.updateSettings({ pipelinePresets: updated })
    setSettings(next)
    setSelectedPresetId(updated[0].id)
    setSteps(updated[0].steps.map((s) => ({ ...s })))
  }

  // 重命名预设
  const renamePreset = async (): Promise<void> => {
    if (!settings || !selectedPreset || !presetName.trim()) return
    const updated = settings.pipelinePresets.map((p) =>
      p.id === selectedPresetId ? { ...p, name: presetName.trim() } : p
    )
    const next = await window.api.updateSettings({ pipelinePresets: updated })
    setSettings(next)
    setPresetName('')
  }

  // 执行流水线
  const execute = async (): Promise<void> => {
    if (!workspace || steps.filter((s) => s.enabled).length === 0) return
    setConfirming(false)
    setRunning(true)
    setError('')
    setReport(null)
    try {
      const result = await window.api.executePipeline(workspace, steps)
      setReport(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const cancel = (): void => {
    window.api.cancelPipeline()
  }

  const destructiveSteps = steps.filter(
    (step) => step.enabled && (step.module === 'clean' || step.module === 'dedupe')
  )

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">自动化</p>
          <h1>流水线编排</h1>
          <p className="muted">
            可视化拖拽编排模块执行顺序，保存多个预设，一键自动执行。适合批量整理： 清理 → 归档 →
            去重 → 体检。
          </p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={onChooseWorkspace} disabled={running}>
            选择工作区
          </button>
          <button
            className="primary"
            onClick={() => (destructiveSteps.length > 0 ? setConfirming(true) : void execute())}
            disabled={!workspace || running || steps.filter((s) => s.enabled).length === 0}
          >
            {running ? '执行中…' : '▶ 执行流水线'}
          </button>
          {running && (
            <button className="secondary" onClick={cancel}>
              取消
            </button>
          )}
        </div>
      </header>

      {error && <ErrorBanner message={error} />}

      {confirming && (
        <ConfirmDialog
          title="执行包含删除操作的流水线？"
          deleteCount={0}
          deleteBytes={0}
          danger
          confirmWord="执行流水线"
          recoverable
          extra={`本次将自动执行：${destructiveSteps.map((step) => moduleLabel(step.module)).join('、')}。实际删除清单会在运行时扫描生成；请确认预设与工作区无误。`}
          onConfirm={execute}
          onCancel={() => setConfirming(false)}
        />
      )}

      {!workspace && (
        <div className="empty-state">
          <p className="muted">请先选择工作区</p>
        </div>
      )}

      {workspace && (
        <div className="pipeline-layout">
          {/* 左侧：预设管理 + 模块库 */}
          <aside className="pipeline-sidebar">
            <section className="pipeline-section">
              <h3>预设</h3>
              <div className="preset-list">
                {settings?.pipelinePresets.map((preset) => (
                  <button
                    key={preset.id}
                    className={`preset-item ${preset.id === selectedPresetId ? 'active' : ''}`}
                    onClick={() => selectPreset(preset.id)}
                  >
                    <span className="preset-name">{preset.name}</span>
                    <span className="preset-count muted">{preset.steps.length} 步</span>
                  </button>
                ))}
              </div>
              <div className="preset-edit">
                <input
                  type="text"
                  placeholder="预设名称"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                />
                <button className="secondary" onClick={createPreset} disabled={!presetName.trim()}>
                  新建
                </button>
                {selectedPreset && (
                  <>
                    <button
                      className="secondary"
                      onClick={renamePreset}
                      disabled={!presetName.trim()}
                    >
                      重命名
                    </button>
                    <button
                      className="secondary danger"
                      onClick={deletePreset}
                      disabled={(settings?.pipelinePresets.length ?? 0) <= 1}
                    >
                      删除
                    </button>
                  </>
                )}
              </div>
            </section>

            <section className="pipeline-section">
              <h3>可用模块</h3>
              <div className="module-library">
                {MODULE_OPTIONS.map((mod) => (
                  <button
                    key={mod.id}
                    className="module-card"
                    onClick={() => addModule(mod.id)}
                    title={mod.desc}
                  >
                    <span className="module-icon">{mod.icon}</span>
                    <div className="module-info">
                      <span className="module-label">{mod.label}</span>
                      <span className="module-desc muted">{mod.desc}</span>
                    </div>
                    <span className="module-add">+</span>
                  </button>
                ))}
              </div>
            </section>
          </aside>

          {/* 右侧：步骤编排区 + 执行报告 */}
          <div className="pipeline-main">
            <section className="pipeline-section">
              <h3>
                执行顺序
                {selectedPreset && <span className="muted"> · {selectedPreset.name}</span>}
              </h3>
              {steps.length === 0 ? (
                <div className="empty-state">
                  <p className="muted">从左侧模块库点击添加步骤，拖拽 ⠿ 调整执行顺序</p>
                </div>
              ) : (
                <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext
                    items={steps.map((s) => s.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="pipeline-steps">
                      {steps.map((step, index) => (
                        <SortableStep
                          key={step.id}
                          step={step}
                          index={index}
                          onToggle={() => toggleStep(step.id)}
                          onRemove={() => removeStep(step.id)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </section>

            {report && (
              <section className="pipeline-section">
                <h3>执行报告</h3>
                <div className="pipeline-report">
                  <div className="report-summary">
                    <span className={report.cancelled ? 'warn' : 'ok'}>
                      {report.cancelled ? '已取消' : '已完成'}
                    </span>
                    <span className="muted">
                      耗时 {(report.totalDurationMs / 1000).toFixed(1)}s
                    </span>
                  </div>
                  <div className="report-steps">
                    {report.results.map((result, i) => (
                      <div
                        key={i}
                        className={`report-step ${result.success ? 'success' : 'failed'}`}
                      >
                        <span className="report-icon">{result.success ? '✓' : '✗'}</span>
                        <span className="report-module">
                          {moduleIcon(result.module)} {moduleLabel(result.module)}
                        </span>
                        <span className="report-summary-text">{result.summary}</span>
                        <span className="muted">{(result.durationMs / 1000).toFixed(1)}s</span>
                        {result.error && <span className="report-error">{result.error}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** 可拖拽排序的步骤行 */
function SortableStep({
  step,
  index,
  onToggle,
  onRemove
}: {
  step: PipelineStep
  index: number
  onToggle: () => void
  onRemove: () => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.id
  })
  return (
    <div
      ref={setNodeRef}
      className={`pipeline-step ${isDragging ? 'dragging' : ''} ${step.enabled ? '' : 'disabled'}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <span className="step-drag" {...attributes} {...listeners}>
        ⠿
      </span>
      <span className="step-index">{index + 1}</span>
      <span className="step-icon">{moduleIcon(step.module)}</span>
      <span className="step-label">{moduleLabel(step.module)}</span>
      <span className="step-desc muted">
        {MODULE_OPTIONS.find((m) => m.id === step.module)?.desc}
      </span>
      <button
        className={`step-toggle ${step.enabled ? '' : 'off'}`}
        onClick={onToggle}
        title={step.enabled ? '点击禁用此步骤' : '点击启用此步骤'}
      >
        {step.enabled ? '启用' : '已禁用'}
      </button>
      <button className="step-remove" onClick={onRemove} title="移除此步骤">
        ✕
      </button>
    </div>
  )
}

export default PipelinePage
