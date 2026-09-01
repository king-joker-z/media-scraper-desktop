import CursorTrail from './CursorTrail'
import Magnetic from './Magnetic'
import HudCorners from './hud/HudCorners'
import TerminalAtmosphere from './hud/TerminalAtmosphere'
import { usePalette } from '../hooks/usePalette'
import type { AppModule } from '../../../shared/types'

type ModuleEntry = {
  key: AppModule
  name: string
  kicker: string
  desc: string
  cap: string
}

const ENTRIES: ModuleEntry[] = [
  {
    key: 'video',
    name: '视频工坊',
    kicker: 'VIDEO DESK',
    desc: '为本地视频完成清理、合并、命名与归档。',
    cap: '清理 · 合并 · 重命名 · 归档'
  },
  {
    key: 'comic',
    name: '漫画书房',
    kicker: 'COMIC DESK',
    desc: '将章节整理为 EPUB / PDF，并持续增量追更。',
    cap: '章节合并 · EPUB / PDF · 漫画库'
  }
]

type ModulePickerProps = {
  onSwitch: (key: AppModule) => void
  /** App.tsx 持有本地化 Icon 实现，以 render prop 注入避免搬运图标注册表 */
  renderIcon: (name: string, size: number) => React.ReactNode
}

/**
 * 模块选择页：启动（未记忆模块）或主动切换时展示。
 * 按皮肤渲染完全不同的 DOM 结构（见各分支），默认皮肤保持原结构不变。
 * - terminal：启动终端 —— 横幅标语 + 全宽作战通道行入口
 * - comic（漫画风）：网点封面页 —— 倾斜墨框面板 + 音效泡提示
 * - comic-ukiyo（浮世绘卷）：挂轴卷 —— 和纸双框卡片 + 单字朱印 + 波文
 */
function ModulePicker({ onSwitch, renderIcon }: ModulePickerProps): React.JSX.Element {
  const palette = usePalette()

  if (palette === 'terminal') {
    return (
      <div className="module-picker tp-picker workspace-with-background">
        <a className="skip-link" href="#module-choice">
          跳到模块选择
        </a>
        <div className="module-picker-drag" />
        <TerminalAtmosphere />
        <HudCorners size="l" />
        <div className="picker-status" aria-hidden="true">
          <span>MEDIA SCRAPER // LOCAL OPS TERMINAL</span>
          <span>LOCAL-ONLY // NO CLOUD SYNC</span>
        </div>
        <section className="tp-hero">
          <p className="tp-kicker">MEDIA SCRAPER · LOCAL STUDIO</p>
          <h1 className="tp-title">从素材开始，整理你的媒体工作台。</h1>
          <p className="muted tp-desc">
            选择一间工作室开始处理。视频与漫画各自保留工作区、页面状态与最近记录。
          </p>
        </section>
        <div id="module-choice" className="tp-rows">
          {ENTRIES.map((entry, index) => (
            <Magnetic key={entry.key}>
              <button
                data-spotlight=""
                className={`tp-row tp-row-${entry.key}`}
                onClick={() => onSwitch(entry.key)}
              >
                <span className="tp-row-index" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="tp-row-icon">
                  {renderIcon(entry.key === 'video' ? 'film' : 'book', 34)}
                </span>
                <span className="tp-row-copy">
                  <b>{entry.name}</b>
                  <span>
                    {entry.kicker} · {entry.desc}
                  </span>
                </span>
                <span className="tp-row-enter" aria-hidden="true">
                  ENTER ▸
                </span>
              </button>
            </Magnetic>
          ))}
        </div>
        <p className="picker-bootline" aria-hidden="true">
          VIDEO DESK · COMIC DESK — ALL PROCESSING LOCAL
        </p>
        <CursorTrail />
      </div>
    )
  }

  if (palette === 'comic') {
    return (
      <div className="module-picker cp-picker workspace-with-background">
        <a className="skip-link" href="#module-choice">
          跳到模块选择
        </a>
        <div className="module-picker-drag" />
        <section className="cp-intro">
          <span className="cp-burst" aria-hidden="true">
            开
          </span>
          <p className="cp-kicker">MEDIA SCRAPER · LOCAL STUDIO</p>
          <h1>从素材开始，整理你的媒体工作台。</h1>
          <p className="muted cp-desc">
            选择一间工作室开始处理。视频与漫画各自保留工作区、页面状态与最近记录。
          </p>
        </section>
        <div id="module-choice" className="cp-cards">
          {ENTRIES.map((entry) => (
            <Magnetic key={entry.key}>
              <button
                data-spotlight=""
                className={`cp-card cp-card-${entry.key}`}
                onClick={() => onSwitch(entry.key)}
              >
                <span className="cp-card-icon">
                  {renderIcon(entry.key === 'video' ? 'film' : 'book', 34)}
                </span>
                <span className="cp-card-name">{entry.name}</span>
                <span className="cp-card-cap">{entry.cap}</span>
                <span className="cp-card-desc">{entry.desc}</span>
                <span className="cp-card-enter" aria-hidden="true">
                  进入{entry.name}！
                </span>
              </button>
            </Magnetic>
          ))}
        </div>
        <CursorTrail />
      </div>
    )
  }

  if (palette === 'comic-ukiyo') {
    return (
      <div className="module-picker up-picker workspace-with-background">
        <a className="skip-link" href="#module-choice">
          跳到模块选择
        </a>
        <div className="module-picker-drag" />
        <section className="up-intro">
          <p className="up-kicker">MEDIA SCRAPER · LOCAL STUDIO</p>
          <h1>从素材开始，整理你的媒体工作台。</h1>
          <p className="muted up-desc">
            选择一间工作室开始处理。视频与漫画各自保留工作区、页面状态与最近记录。
          </p>
        </section>
        <div id="module-choice" className="up-cards">
          {ENTRIES.map((entry) => (
            <Magnetic key={entry.key}>
              <button
                data-spotlight=""
                className={`up-card up-card-${entry.key}`}
                onClick={() => onSwitch(entry.key)}
              >
                <span className="up-card-seal" aria-hidden="true">
                  {entry.key === 'video' ? '影' : '画'}
                </span>
                <span className="up-card-frame">
                  {renderIcon(entry.key === 'video' ? 'film' : 'book', 30)}
                </span>
                <span className="up-card-name">{entry.name}</span>
                <span className="up-card-desc">{entry.desc}</span>
                <span className="up-card-wave" aria-hidden="true" />
                <span className="up-card-enter">入室垂览</span>
              </button>
            </Magnetic>
          ))}
        </div>
        <CursorTrail />
      </div>
    )
  }

  return (
    <div className="module-picker workspace-with-background">
      <a className="skip-link" href="#module-choice">
        跳到模块选择
      </a>
      <div className="module-picker-drag" />
      {/* 终端皮肤装饰层：仅 terminal 色板可见，其余皮肤 display:none */}
      <TerminalAtmosphere />
      <HudCorners size="l" />
      <div className="picker-status" aria-hidden="true">
        <span>MEDIA SCRAPER // LOCAL OPS TERMINAL</span>
        <span>LOCAL-ONLY // NO CLOUD SYNC</span>
      </div>
      <div className="module-picker-intro">
        <div className="module-picker-mark" aria-hidden="true">
          {renderIcon('film', 26)}
        </div>
        <p className="eyebrow">Media Scraper · Local Studio</p>
        <h1>从素材开始，整理你的媒体工作台。</h1>
        <p className="muted">
          选择一间工作室开始处理。视频与漫画各自保留工作区、页面状态与最近记录。
        </p>
      </div>
      <div id="module-choice" className="module-cards">
        {ENTRIES.map((entry, index) => (
          <Magnetic key={entry.key}>
            <button
              data-spotlight=""
              className={`module-card module-card-${entry.key}`}
              onClick={() => onSwitch(entry.key)}
            >
              <span className="module-card-index" aria-hidden="true">
                {`${String(index + 1).padStart(2, '0')} //`}
              </span>
              <HudCorners size="s" />
              <span className="module-card-icon">
                {renderIcon(entry.key === 'video' ? 'film' : 'book', 38)}
              </span>
              <span className="module-card-kicker">{entry.kicker}</span>
              <span className="module-card-name">{entry.name}</span>
              <span className="module-card-desc">{entry.desc}</span>
              <span className="module-card-capabilities" aria-hidden="true">
                {entry.cap}
              </span>
              <span className="module-card-enter">
                进入{entry.name} <span aria-hidden="true">→</span>
              </span>
            </button>
          </Magnetic>
        ))}
      </div>
      <p className="picker-bootline" aria-hidden="true">
        VIDEO DESK · COMIC DESK — ALL PROCESSING LOCAL
      </p>
      <CursorTrail />
    </div>
  )
}

export default ModulePicker
