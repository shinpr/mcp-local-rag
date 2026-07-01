import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { getCursorConfig, setupCursor } from '../api/cursor'
import type { CursorConfigResponse } from '../api/cursor'

export default function McpSetupPage() {
  const [cursorConfig, setCursorConfig] = useState<CursorConfigResponse | null>(null)
  const [isSettingUp, setIsSettingUp] = useState(false)
  const [setupResult, setSetupResult] = useState<{
    success: boolean
    message: string
    backupPath: string | null
  } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const data = await getCursorConfig()
        setCursorConfig(data)
      } catch {
        // Config fetch failed — not critical
      }
    }
    fetchConfig()
  }, [])

  const handleAutoSetup = async () => {
    setIsSettingUp(true)
    setSetupResult(null)
    try {
      const result = await setupCursor()
      setSetupResult(result)
      toast.success('MCP server added to Cursor config')
      // Refresh config status
      const data = await getCursorConfig()
      setCursorConfig(data)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Setup failed'
      setSetupResult({ success: false, message, backupPath: null })
      toast.error(message)
    } finally {
      setIsSettingUp(false)
    }
  }

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      toast.success('Copied to clipboard')
      setTimeout(() => setCopied(null), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }

  const mcpConfigJson = cursorConfig
    ? JSON.stringify(cursorConfig.mcpConfig, null, 2)
    : `{
  "mcpServers": {
    "local-project-rag": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "<project-root>",
      "env": {}
    }
  }
}`

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">MCP Setup</h1>
        <p className="text-gray-400 mt-1">
          Configure the MCP server for use with Cursor
        </p>
      </div>

      {/* Auto Setup */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">
          One-Click Setup
        </h2>
        <p className="text-sm text-gray-400 mb-4">
          Automatically add the MCP server to your Cursor configuration at{' '}
          <code className="text-emerald-400">~/.cursor/mcp.json</code>
        </p>

        {cursorConfig?.alreadyConfigured && (
          <div className="mb-4 p-3 bg-emerald-900/30 border border-emerald-700 rounded-lg">
            <p className="text-sm text-emerald-300">
              MCP server is already configured in your Cursor config.
            </p>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={handleAutoSetup}
            disabled={isSettingUp}
            className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSettingUp ? 'Setting up...' : 'Add to Cursor'}
          </button>
        </div>

        {setupResult && (
          <div
            className={`mt-4 p-3 rounded-lg border ${
              setupResult.success
                ? 'bg-emerald-900/30 border-emerald-700'
                : 'bg-red-900/30 border-red-700'
            }`}
          >
            <p
              className={`text-sm ${
                setupResult.success ? 'text-emerald-300' : 'text-red-300'
              }`}
            >
              {setupResult.message}
            </p>
            {setupResult.backupPath && (
              <p className="text-xs text-gray-400 mt-1">
                Backup saved to: {setupResult.backupPath}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Config Status */}
      {cursorConfig && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-white mb-4">
            Cursor Config Status
          </h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Config path:</span>
              <code className="text-gray-300 font-mono">{cursorConfig.mcpConfigPath}</code>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Config exists:</span>
              <span className={cursorConfig.configExists ? 'text-emerald-400' : 'text-yellow-400'}>
                {cursorConfig.configExists ? 'Yes' : 'No'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">MCP configured:</span>
              <span className={cursorConfig.alreadyConfigured ? 'text-emerald-400' : 'text-yellow-400'}>
                {cursorConfig.alreadyConfigured ? 'Yes' : 'No'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Project root:</span>
              <code className="text-gray-300 font-mono">{cursorConfig.projectRoot}</code>
            </div>
          </div>
        </div>
      )}

      {/* Manual Configuration */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">
          Manual Configuration
        </h2>
        <p className="text-sm text-gray-400 mb-4">
          Alternatively, add this to your <code className="text-emerald-400">~/.cursor/mcp.json</code> file:
        </p>
        <div className="bg-gray-800 rounded-lg p-4">
          <pre className="text-sm text-gray-300 font-mono overflow-x-auto">
            {mcpConfigJson}
          </pre>
        </div>
        <button
          onClick={() => copyToClipboard(mcpConfigJson, 'config')}
          className="mt-3 px-4 py-2 bg-gray-700 text-white text-sm font-medium rounded-lg hover:bg-gray-600 transition-colors"
        >
          {copied === 'config' ? 'Copied!' : 'Copy Configuration'}
        </button>
      </div>

      {/* Instructions */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">
          Setup Instructions
        </h2>
        <ol className="space-y-3 text-sm text-gray-300">
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-emerald-600 rounded-full flex items-center justify-center text-xs font-bold">
              1
            </span>
            <span>Click "Add to Cursor" for automatic setup, or copy the config manually</span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-emerald-600 rounded-full flex items-center justify-center text-xs font-bold">
              2
            </span>
            <span>Restart Cursor to load the MCP server</span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-emerald-600 rounded-full flex items-center justify-center text-xs font-bold">
              3
            </span>
            <span>The MCP server tools will be available in Cursor's AI chat</span>
          </li>
        </ol>
      </div>
    </div>
  )
}
