export function Header() {
  return (
    <header className="bg-white border-b border-gray-200 px-6 py-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">
          MCP Local RAG
        </h1>
        <span className="text-sm text-gray-500">
          Local Document Search
        </span>
      </div>
    </header>
  )
}
