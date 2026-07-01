import { useState, useEffect } from 'react'
import { getProjects } from '../api/projects'
import { generateSkill } from '../api/skill'
import type { ProjectResponse } from '../types/api'
import toast from 'react-hot-toast'

export default function SkillSetupPage() {
  const [projects, setProjects] = useState<ProjectResponse[]>([])
  const [selectedProject, setSelectedProject] = useState('')
  const [task, setTask] = useState('')
  const [skillContent, setSkillContent] = useState('')
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
      const result = await generateSkill(selectedProject, task || undefined)
      setSkillContent(result.skillMarkdown)
      toast.success('Skill generated')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to generate skill')
    } finally {
      setIsGenerating(false)
    }
  }

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(skillContent)
      setCopied(true)
      toast.success('Skill copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Skill Setup</h1>
        <p className="text-gray-400 mt-1">
          Generate a RAG skill for Cursor
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
              Task (optional)
            </label>
            <input
              type="text"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
              placeholder="e.g. implement user authentication"
            />
          </div>
        </div>
        <div className="mt-4">
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !selectedProject}
            className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isGenerating ? 'Generating...' : 'Generate RAG Skill'}
          </button>
        </div>
      </div>

      {/* Generated Skill */}
      {skillContent && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Generated Skill</h2>
            <button
              onClick={copyToClipboard}
              className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors"
            >
              {copied ? 'Copied!' : 'Copy Skill'}
            </button>
          </div>
          <div className="bg-gray-800 rounded-lg p-4 overflow-auto max-h-96">
            <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap">
              {skillContent}
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
            <span>Click "Generate RAG Skill" above</span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-emerald-600 rounded-full flex items-center justify-center text-xs font-bold">
              2
            </span>
            <span>Copy the generated skill</span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-emerald-600 rounded-full flex items-center justify-center text-xs font-bold">
              3
            </span>
            <span>
              Create a file at{' '}
              <code className="text-emerald-400">
                .cursor/skills/project-rag.md
              </code>
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-emerald-600 rounded-full flex items-center justify-center text-xs font-bold">
              4
            </span>
            <span>Paste the skill content and save the file</span>
          </li>
        </ol>
      </div>
    </div>
  )
}
