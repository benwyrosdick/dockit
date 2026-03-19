export function shortenId(value: string) {
  return value.length > 12 ? value.slice(0, 12) : value
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const amount = value / 1024 ** power
  return `${amount.toFixed(amount >= 10 || power === 0 ? 0 : 1)} ${units[power]}`
}

export function formatDateTime(value?: number | string | null) {
  if (value === undefined || value === null || value === '') return 'Unknown'
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function formatRelativeTime(value?: number | null) {
  if (!value) return 'Unknown'
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - value)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
