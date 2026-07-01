import clsx from 'clsx'

interface StatCardProps {
  label: string
  value: string | number
  icon: string
  trend?: {
    value: number
    isPositive: boolean
  }
  className?: string
}

export default function StatCard({
  label,
  value,
  icon,
  trend,
  className,
}: StatCardProps) {
  return (
    <div
      className={clsx(
        'bg-gray-900 border border-gray-800 rounded-xl p-6',
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-400">{label}</p>
          <p className="mt-2 text-3xl font-bold text-white">{value}</p>
          {trend && (
            <p
              className={clsx(
                'mt-2 text-sm',
                trend.isPositive ? 'text-emerald-400' : 'text-red-400',
              )}
            >
              {trend.isPositive ? '↑' : '↓'} {Math.abs(trend.value)}%
            </p>
          )}
        </div>
        <div className="text-4xl">{icon}</div>
      </div>
    </div>
  )
}
