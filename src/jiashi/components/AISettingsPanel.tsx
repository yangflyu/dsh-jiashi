// ── AI Settings Panel ─────────────────────────

import { useState, useEffect, useCallback } from 'react'
import { loadAISettings, saveAISettings, type AISettings } from '../ai/settings'

const DEFAULT_SETTINGS: AISettings = {
  apiKey: '',
  endpoint: 'https://api.deepseek.com',
  model: 'deepseek-chat',
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function AISettingsPanel({ open, onClose }: Props) {
  const [settings, setSettings] = useState<AISettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(false)

  // Load settings asynchronously when panel opens
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    loadAISettings().then(s => {
      if (!cancelled) { setSettings(s); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  const handleSave = useCallback(async () => {
    await saveAISettings(settings)
    onClose()
  }, [settings, onClose])

  if (!open) return null

  return (
    <div className="ai-settings-overlay" onClick={onClose}>
      <div className="ai-settings-panel" onClick={e => e.stopPropagation()}>
        <h2 className="ai-settings-title">AI 设置</h2>

        <label className="ai-settings-label">
          API Key
          <input
            type="password"
            className="ai-settings-input"
            placeholder="sk-..."
            value={settings.apiKey}
            onChange={e => setSettings(s => ({ ...s, apiKey: e.target.value }))}
          />
        </label>

        <label className="ai-settings-label">
          API 端点
          <input
            type="text"
            className="ai-settings-input"
            placeholder="https://api.deepseek.com"
            value={settings.endpoint}
            onChange={e => setSettings(s => ({ ...s, endpoint: e.target.value }))}
          />
        </label>

        <label className="ai-settings-label">
          模型名称
          <input
            type="text"
            className="ai-settings-input"
            placeholder="deepseek-chat"
            value={settings.model}
            onChange={e => setSettings(s => ({ ...s, model: e.target.value }))}
          />
        </label>

        <div className="ai-settings-actions">
          <button className="ai-btn ai-btn-secondary" onClick={onClose}>取消</button>
          <button className="ai-btn ai-btn-primary" onClick={handleSave}>保存</button>
        </div>
      </div>
    </div>
  )
}
