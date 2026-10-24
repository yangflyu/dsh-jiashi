import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './App.css'

// 崩溃兜底：React 渲染期抛错时显示可读的错误详情，避免用户只看到白屏。
// （保留而非仅调试用：出问题时这段信息是唯一的排查线索）
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { err: null }
  }
  static getDerivedStateFromError(err: Error) {
    return { err }
  }
  componentDidCatch(err: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', err, info)
  }
  render() {
    if (this.state.err) {
      return (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 999999, background: '#2c2c2a',
          color: '#f0f0f0', font: '12px/1.6 Consolas, monospace',
          padding: 24, overflow: 'auto', whiteSpace: 'pre-wrap',
        }}>
          <div style={{ color: '#f09595', fontSize: 14, marginBottom: 8 }}>⚠ 应用崩溃：{String(this.state.err.message)}</div>
          <div>{String(this.state.err.stack ?? '')}</div>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
