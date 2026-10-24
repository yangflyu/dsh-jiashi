// ── AI Settings persistence ──────────────────

import { loadJSONSetting, saveJSONSetting, initDatabase } from '../db'

export interface AISettings {
  apiKey: string
  endpoint: string
  model: string
}

const STORAGE_KEY = 'framework-ai-settings'

const DEFAULTS: AISettings = {
  apiKey: '',
  endpoint: 'https://api.deepseek.com',
  model: 'deepseek-chat',
}

export async function loadAISettings(): Promise<AISettings> {
  await initDatabase()
  return loadJSONSetting<AISettings>(STORAGE_KEY, DEFAULTS)
}

export async function saveAISettings(settings: AISettings): Promise<void> {
  await initDatabase()
  await saveJSONSetting(STORAGE_KEY, settings)
}
