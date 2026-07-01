import { useState, useEffect } from 'react'
import { getProjects } from '../api/projects'
import { generateAgentsBlock } from '../api/skill'
import type { ProjectResponse } from '../types/api'
import toast from 'react-hot-toast'

export default function AgentsSetupPage() {
  const [projects, setProjects] = useState<ProjectResponse[]>([])
  const [selectedProject, setSelectedProject] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [agentsContent, setAgentsContent] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const data = await getProjects()
        setProjects(data)
        if (data.length > 0 && !selectedProject) {
          setSelectedProject(data[0].name)
        }
      } catch {
        toast.error('Failed to load projects')
      }
    }
    fetchProjects()
  }, [selectedProject])

  const handleGenerate = async () => {
    if (!selectedProject) return
    setIsGenerating(true)
    try {
      const result = await generateAgentsBlock(
        selectedProject,
        repoPath || undefined,
      )
      setAgentsContent(result.agentsBlock)
      toast.success('AGENTS.md block generated')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to generate')
    } finally {
      setIsGenerating(false)
    }
  }

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(agentsContent)
      setCopied(true)
      toast.success('AGENTS.md content copied')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">AGENTS.md Setup</h1>
        <p className="text-gray-400 mt-1">
          Generate AGENTS.md blocks for your project
        </p>
      </div>

      {/* Configuration */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Configuration</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Project
            </label>
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.name}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Repository Path (optional)
            </label>
            <input
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
              placeholder="/path/to/repo"
            />
          </div>
        </div>
        <div className="mt-4">
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !selectedProject}
            className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isGenerating ? 'Generating...' : 'Generate AGENTS.md Block'}
          </button>
        </div>
      </div>

      {/* Generated Content */}
      {agentsContent && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">
              Generated AGENTS.md
            </h2>
            <button
              onClick={copyToClipboard}
              className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors"
            >
              {copied ? 'Copied!' : 'Copy Content'}
            </button>
          </div>
          <div className="bg-gray-800 rounded-lg p-4 overflow-auto max-h-96">
            <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap">
              {agentsContent}
            </pre>
          </div>
        </div>
      )}

      {/* Instructions */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">
          Installation Instructions
        </h2>
        <ol className="space-y-3 text-sm text-gray-300">
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-emerald-600 rounded-full flex items-center justify-center text-xs font-bold">
              1
            </span>
            <span>Click "Generate AGENTS.md Block" above</span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-emerald-600 rounded-full flex items-center justify-center text-xs font-bold">
              2
            </span>
            <span>Copy the generated content</span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-emerald-600 rounded-full flex items-center justify-center text-xs font-bold">
              3
            </span>
            <span>
              Open your project's{' '}
              <code className="text-emerald-400">AGENTS.md</code> file (create
              one if it doesn't exist)
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-emerald-600 rounded-full flex items-center justify-center text-xs font-bold">
              4
            </span>
            <span>Paste the content at the end of the file and save</span>
          </li>
        </ol>
      </div>

      {/* What is AGENTS.md */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">
          What is AGENTS.md?
        </h2>
        <div className="prose prose-invert prose-sm max-w-none">
          <p className="text-gray-300">
            AGENTS.md is a special file that Cursor reads to understand your
            project's context and available tools. When you add RAG search
            capabilities to AGENTS.md, Cursor's AI agents can automatically
            search your indexed documents when answering questions about your
            project.
          </p>
          <p className="text-gray-300 mt-3">
            The managed block markers (<code className="text-emerald-400">LOCAL_RAG_MCP_START</code> /{' '}
            <code className="text-emerald-400">LOCAL_RAG_MCP_END</code>) allow
            the system to update the block without affecting other content in your AGENTS.md.
          </p>
        </div>
      </div>
    </div>
  )
}
