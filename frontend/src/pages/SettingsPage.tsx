import { useCallback, useEffect, useState } from 'react'
import { getSettings, updateSettings } from '../api/settings'
import type { EmbeddingProvider, SettingsResponse } from '../types/api'
import toast from 'react-hot-toast'

const PROVIDER_OPTIONS: Array<{ value: EmbeddingProvider; label: string }> = [
  { value: 'local', label: 'Local (Transformers.js)' },
  { value: 'lm_studio', label: 'LM Studio' },
  { value: 'nvidia_nim', label: 'NVIDIA NIM' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai_compatible', label: 'OpenAI-compatible' },
]

const inputClassName =
  'w-full px-4 py-3 bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent'

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  const [embeddingProvider, setEmbeddingProvider] = useState<EmbeddingProvider>('local')
  const [apiBaseUrl, setApiBaseUrl] = useState('')
  const [modelName, setModelName] = useState('')
  const [apiKey, setApiKey] = useState('')

  const loadSettings = useCallback(async () => {
    try {
      const data = await getSettings()
      setSettings(data)
      setEmbeddingProvider(data.embeddingProvider)
      setApiBaseUrl(data.apiBaseUrl ?? '')
      setModelName(data.modelName)
      setApiKey('')
    } catch {
      toast.error('Failed to load settings')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSaving(true)

    try {
      const payload: Parameters<typeof updateSettings>[0] = {
        embeddingProvider,
        modelName: modelName.trim() || null,
      }

      if (embeddingProvider !== 'local') {
        payload.apiBaseUrl = apiBaseUrl.trim() || null
        if (apiKey.trim()) {
          payload.apiKey = apiKey.trim()
        }
      } else {
        payload.apiBaseUrl = null
        payload.apiKey = null
      }

      const updated = await updateSettings(payload)
      setSettings(updated)
      setApiKey('')
      toast.success('Settings saved')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save settings')
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-emerald-500" />
      </div>
    )
  }

  const defaultInfo = settings?.defaultEmbedding
  const isRemote = embeddingProvider !== 'local'

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-gray-400 mt-1">
          Configure which embedding provider powers search and indexing.
        </p>
      </div>

      {defaultInfo && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-5 space-y-3">
          <h2 className="text-lg font-semibold text-white">Built-in default embedding</h2>
          <p className="text-sm text-gray-300">{defaultInfo.description}</p>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-gray-500">Provider</dt>
              <dd className="text-white font-medium">Local (Transformers.js)</dd>
            </div>
            <div>
              <dt className="text-gray-500">Model</dt>
              <dd className="text-white font-mono text-xs sm:text-sm">{defaultInfo.modelName}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Dimensions</dt>
              <dd className="text-white">{defaultInfo.dimensions}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Your config matches default</dt>
              <dd className={settings?.matchesDefaultEmbedding ? 'text-emerald-400' : 'text-amber-400'}>
                {settings?.matchesDefaultEmbedding ? 'Yes' : 'No — re-index after switching models'}
              </dd>
            </div>
          </dl>
          <div className="pt-2 border-t border-gray-800">
            <h3 className="text-sm font-medium text-gray-300 mb-2">Equivalent remote options</h3>
            <ul className="space-y-2 text-sm text-gray-400">
              {defaultInfo.equivalentProviderOptions.map((opt) => (
                <li key={`${opt.provider}-${opt.modelName}`}>
                  <span className="text-gray-200 font-medium">{opt.provider}</span>
                  {' — '}
                  <span className="font-mono text-xs">{opt.modelName}</span>
                  <span className="block text-gray-500 mt-0.5">{opt.note}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="rounded-xl border border-gray-800 bg-gray-900/40 p-6 space-y-5">
        <h2 className="text-lg font-semibold text-white">Embedding provider</h2>

        <div>
          <label htmlFor="provider" className="block text-sm font-medium text-gray-300 mb-1">
            Provider
          </label>
          <select
            id="provider"
            value={embeddingProvider}
            onChange={(e) => setEmbeddingProvider(e.target.value as EmbeddingProvider)}
            className={inputClassName}
          >
            {PROVIDER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="modelName" className="block text-sm font-medium text-gray-300 mb-1">
            Model name
          </label>
          <input
            id="modelName"
            type="text"
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            className={inputClassName}
            placeholder={defaultInfo?.modelName ?? 'Xenova/all-MiniLM-L6-v2'}
          />
        </div>

        {isRemote && (
          <>
            <div>
              <label htmlFor="apiBaseUrl" className="block text-sm font-medium text-gray-300 mb-1">
                API base URL
              </label>
              <input
                id="apiBaseUrl"
                type="url"
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
                required
                className={inputClassName}
                placeholder="http://localhost:1234/v1"
              />
            </div>

            <div>
              <label htmlFor="apiKey" className="block text-sm font-medium text-gray-300 mb-1">
                API key
                {settings?.apiKeySet && (
                  <span className="ml-2 text-xs text-gray-500">
                    (saved: {settings.apiKeyMasked})
                  </span>
                )}
              </label>
              <input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className={inputClassName}
                placeholder={settings?.apiKeySet ? 'Leave blank to keep current key' : 'Optional for LM Studio'}
                autoComplete="off"
              />
            </div>
          </>
        )}

        <button
          type="submit"
          disabled={isSaving}
          className="px-5 py-2.5 bg-emerald-600 text-white font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
        >
          {isSaving ? 'Saving...' : 'Save settings'}
        </button>
      </form>
    </div>
  )
}
