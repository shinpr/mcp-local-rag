import clsx from 'clsx'

type Status = 'pending' | 'indexing' | 'indexed' | 'failed' | 'running' | 'completed'

interface StatusBadgeProps {
  status: string
  className?: string
}

const statusConfig: Record<string, { label: string; className: string }> = {
  pending: {
    label: 'Uploaded',
    className: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
  },
  indexing: {
    label: 'Indexing...',
    className: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  },
  indexed: {
    label: 'Ready',
    className: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  },
  failed: {
    label: 'Failed',
    className: 'bg-red-500/20 text-red-400 border-red-500/30',
  },
  running: {
    label: 'Running...',
    className: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  },
  completed: {
    label: 'Done',
    className: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  },
}

export default function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = statusConfig[status] || {
    label: status,
    className: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  }

  return (
    <span
      className={clsx(
        'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border',
        config.className,
        className,
      )}
    >
      {status === 'indexing' && (
        <span className="w-1.5 h-1.5 mr-1.5 bg-blue-400 rounded-full animate-pulse" />
      )}
      {config.label}
    </span>
  )
}
