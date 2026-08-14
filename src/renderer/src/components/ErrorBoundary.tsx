import { Component, type ErrorInfo, type ReactNode } from 'react'
import ErrorBanner from './ErrorBanner'

/** 渲染进程兜底：任何页面组件抛错时展示恢复界面而不是白屏 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('渲染错误:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h1>界面出现异常</h1>
          <ErrorBanner message={`界面错误：${this.state.error.message}`} />
          <p className="muted">你可以复制错误详情用于反馈，或尝试恢复当前页面。</p>
          <button onClick={() => this.setState({ error: null })}>尝试恢复</button>
          <button className="secondary" onClick={() => window.location.reload()}>
            重新加载界面
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export default ErrorBoundary
