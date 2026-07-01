import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { getProjects } from '../api/projects'
import { getHealth } from '../api/health'
import type { ProjectResponse, HealthResponse } from '../types/api'
import { formatUptime } from '../utils/format'

export default function DashboardPage() {
  const [projects, setProjects] = useState<ProjectResponse[]>([])
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [projectsData, healthData] = await Promise.all([
          getProjects(),
          getHealth(),
        ])
        setProjects(projectsData)
        setHealth(healthData)
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error)
      } finally {
        setIsLoading(false)
      }
    }

    fetchData()
  }, [])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-emerald-500"></div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-gray-400 mt-1">
          Overview of your RAG system
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <p className="text-sm font-medium text-gray-400">Projects</p>
          <p className="mt-2 text-3xl font-bold text-white">
            {projects.length}
          </p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <p className="text-sm font-medium text-gray-400">Server Status</p>
          <div className="mt-2 flex items-center gap-2">
            <span className="w-3 h-3 bg-emerald-500 rounded-full"></span>
            <span className="text-lg font-semibold text-emerald-400">
              Online
            </span>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <p className="text-sm font-medium text-gray-400">Version</p>
          <p className="mt-2 text-3xl font-bold text-white">
            {health?.version || '—'}
          </p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <p className="text-sm font-medium text-gray-400">Uptime</p>
          <p className="mt-2 text-3xl font-bold text-white">
            {health ? formatUptime(health.uptime) : '—'}
          </p>
        </div>
      </div>

      {/* Recent Projects */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl">
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-white">Recent Projects</h2>
          <Link
            to="/projects"
            className="text-sm text-emerald-400 hover:text-emerald-300"
          >
            View all →
          </Link>
        </div>

        {projects.length === 0 ? (
          <div className="p-12 text-center">
            <div className="text-5xl mb-4">📁</div>
            <h3 className="text-lg font-semibold text-white mb-2">
              No projects yet
            </h3>
            <p className="text-sm text-gray-400 mb-4">
              Create your first project to get started
            </p>
            <Link
              to="/projects"
              className="inline-flex items-center px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors"
            >
              Create Project
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {projects.slice(0, 5).map((project) => (
              <Link
                key={project.id}
                to={`/projects/${project.id}`}
                className="flex items-center justify-between p-4 hover:bg-gray-800/50 transition-colors"
              >
                <div>
                  <p className="font-medium text-white">{project.name}</p>
                  {project.description && (
                    <p className="text-sm text-gray-400 mt-1">
                      {project.description}
                    </p>
                  )}
                </div>
                <svg
                  className="w-5 h-5 text-gray-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Link
          to="/projects"
          className="bg-gray-900 border border-gray-800 rounded-xl p-6 hover:border-emerald-500/50 transition-colors group"
        >
          <div className="text-3xl mb-3">📁</div>
          <h3 className="font-semibold text-white group-hover:text-emerald-400 transition-colors">
            Manage Projects
          </h3>
          <p className="text-sm text-gray-400 mt-1">
            Create and manage your RAG projects
          </p>
        </Link>

        <Link
          to="/search"
          className="bg-gray-900 border border-gray-800 rounded-xl p-6 hover:border-emerald-500/50 transition-colors group"
        >
          <div className="text-3xl mb-3">🔍</div>
          <h3 className="font-semibold text-white group-hover:text-emerald-400 transition-colors">
            Search Documents
          </h3>
          <p className="text-sm text-gray-400 mt-1">
            Search across your indexed documents
          </p>
        </Link>

        <Link
          to="/setup/mcp"
          className="bg-gray-900 border border-gray-800 rounded-xl p-6 hover:border-emerald-500/50 transition-colors group"
        >
          <div className="text-3xl mb-3">⚙️</div>
          <h3 className="font-semibold text-white group-hover:text-emerald-400 transition-colors">
            Setup MCP
          </h3>
          <p className="text-sm text-gray-400 mt-1">
            Configure MCP server for Cursor
          </p>
        </Link>
      </div>
    </div>
  )
}
