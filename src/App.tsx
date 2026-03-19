import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listen } from '@tauri-apps/api/event'
import './App.css'
import {
  dockerStatus,
  inspectContainer,
  inspectImage,
  inspectNetwork,
  inspectVolume,
  listContainers,
  listImages,
  listNetworks,
  listVolumes,
  pullImage,
  removeContainer,
  removeImage,
  removeNetwork,
  removeVolume,
  restartContainer,
  startContainerLogStream,
  stopContainerLogStream,
  startContainer,
  stopContainer,
  containerLogs,
} from './lib/api'
import { formatBytes, formatDateTime, formatRelativeTime, shortenId } from './lib/format'
import type {
  ContainerSummary,
  DockerStatus,
  ImageSummary,
  InspectPayload,
  NetworkSummary,
  VolumeSummary,
} from './types/docker'

type ResourceKey = 'containers' | 'images' | 'volumes' | 'networks'

type ActionState = {
  title: string
  body: string
  mode: 'inspect' | 'logs'
  containerId?: string
} | null

const resources: Array<{
  key: ResourceKey
  label: string
  caption: string
}> = [
  { key: 'containers', label: 'Containers', caption: 'Runtime health and logs' },
  { key: 'images', label: 'Images', caption: 'Builds, pulls, and cleanup' },
  { key: 'volumes', label: 'Volumes', caption: 'Persistent data' },
  { key: 'networks', label: 'Networks', caption: 'Connectivity fabric' },
]

function App() {
  const [resource, setResource] = useState<ResourceKey>('containers')
  const [search, setSearch] = useState('')
  const [viewer, setViewer] = useState<ActionState>(null)
  const [pullTarget, setPullTarget] = useState('redis:7')
  const queryClient = useQueryClient()

  const statusQuery = useQuery({
    queryKey: ['docker-status'],
    queryFn: dockerStatus,
    refetchInterval: 12_000,
  })

  const containersQuery = useQuery({
    queryKey: ['containers'],
    queryFn: listContainers,
    refetchInterval: 10_000,
  })

  const imagesQuery = useQuery({
    queryKey: ['images'],
    queryFn: listImages,
    refetchInterval: 18_000,
  })

  const volumesQuery = useQuery({
    queryKey: ['volumes'],
    queryFn: listVolumes,
    refetchInterval: 18_000,
  })

  const networksQuery = useQuery({
    queryKey: ['networks'],
    queryFn: listNetworks,
    refetchInterval: 18_000,
  })

  const refreshAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['docker-status'] }),
      queryClient.invalidateQueries({ queryKey: ['containers'] }),
      queryClient.invalidateQueries({ queryKey: ['images'] }),
      queryClient.invalidateQueries({ queryKey: ['volumes'] }),
      queryClient.invalidateQueries({ queryKey: ['networks'] }),
    ])
  }

  const actionMutation = useMutation({
    mutationFn: async (action: () => Promise<void>) => action(),
    onSuccess: refreshAll,
  })

  const pullMutation = useMutation({
    mutationFn: pullImage,
    onSuccess: refreshAll,
  })

  const openInspect = async (title: string, request: () => Promise<InspectPayload>) => {
    try {
      const payload = await request()
      setViewer({
        title,
        mode: 'inspect',
        body: JSON.stringify(payload, null, 2),
      })
    } catch (error) {
      setViewer({
        title: 'Inspect failed',
        mode: 'inspect',
        body: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const openLogs = async (container: ContainerSummary) => {
    try {
      const body = await containerLogs(container.id)
      setViewer({
        title: `${container.name} logs`,
        mode: 'logs',
        containerId: container.id,
        body: body || 'No log output returned for this container.',
      })
    } catch (error) {
      setViewer({
        title: `${container.name} logs`,
        mode: 'logs',
        containerId: container.id,
        body: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const counts = {
    containers: containersQuery.data?.length ?? 0,
    images: imagesQuery.data?.length ?? 0,
    volumes: volumesQuery.data?.length ?? 0,
    networks: networksQuery.data?.length ?? 0,
  }

  const currentData = {
    containers: containersQuery.data ?? [],
    images: imagesQuery.data ?? [],
    volumes: volumesQuery.data ?? [],
    networks: networksQuery.data ?? [],
  }

  const busy = actionMutation.isPending || pullMutation.isPending
  const currentStatus = statusQuery.data

  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Wayland Docker Desktop</p>
          <h1>Dockit</h1>
          <p className="lede">
            A local-first control room for your engine, resources, and logs.
          </p>
        </div>

        <nav className="nav">
          {resources.map((item) => (
            <button
              key={item.key}
              type="button"
              className={resource === item.key ? 'nav-item active' : 'nav-item'}
              onClick={() => {
                setResource(item.key)
                setSearch('')
              }}
            >
              <span>
                <strong>{item.label}</strong>
                <small>{item.caption}</small>
              </span>
              <span className="nav-count">{counts[item.key]}</span>
            </button>
          ))}
        </nav>

        <StatusPanel status={currentStatus} loading={statusQuery.isLoading} />
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Control Surface</p>
            <h2>{resources.find((item) => item.key === resource)?.label}</h2>
          </div>

          <div className="toolbar">
            <label className="search">
              <span>Search</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={`Filter ${resource}`}
              />
            </label>
            <button type="button" className="ghost" onClick={() => void refreshAll()}>
              Refresh
            </button>
          </div>
        </header>

        {resource === 'containers' && (
          <ContainersSection
            items={filterContainers(currentData.containers, search)}
            loading={containersQuery.isLoading}
            busy={busy}
            onAction={(job) => actionMutation.mutate(job)}
            onInspect={(container) =>
              void openInspect(`${container.name} inspect`, () => inspectContainer(container.id))
            }
            onLogs={(container) => void openLogs(container)}
          />
        )}

        {resource === 'images' && (
          <ImagesSection
            items={filterImages(currentData.images, search)}
            loading={imagesQuery.isLoading}
            busy={busy}
            pullTarget={pullTarget}
            onPullTargetChange={setPullTarget}
            onPull={() => pullMutation.mutate(pullTarget)}
            onAction={(job) => actionMutation.mutate(job)}
            onInspect={(image) =>
              void openInspect(image.primaryTag || shortenId(image.id), () => inspectImage(image.id))
            }
          />
        )}

        {resource === 'volumes' && (
          <VolumesSection
            items={filterVolumes(currentData.volumes, search)}
            loading={volumesQuery.isLoading}
            busy={busy}
            onAction={(job) => actionMutation.mutate(job)}
            onInspect={(volume) =>
              void openInspect(volume.name, () => inspectVolume(volume.name))
            }
          />
        )}

        {resource === 'networks' && (
          <NetworksSection
            items={filterNetworks(currentData.networks, search)}
            loading={networksQuery.isLoading}
            busy={busy}
            onAction={(job) => actionMutation.mutate(job)}
            onInspect={(network) =>
              void openInspect(network.name, () => inspectNetwork(network.id))
            }
          />
        )}

        {(statusQuery.error || actionMutation.error || pullMutation.error) && (
          <div className="error-banner">
            {String(statusQuery.error || actionMutation.error || pullMutation.error)}
          </div>
        )}
      </main>

      {viewer && (
        <div className="viewer-backdrop" onClick={() => setViewer(null)}>
          <section className="viewer" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">{viewer.mode === 'logs' ? 'Live Snapshot' : 'Inspect'}</p>
                <h3>{viewer.title}</h3>
              </div>
              <button type="button" className="ghost" onClick={() => setViewer(null)}>
                Close
              </button>
            </header>
            {viewer.mode === 'logs' ? (
              <LiveLogViewer
                key={viewer.containerId ?? viewer.title}
                initialBody={viewer.body}
                containerId={viewer.containerId ?? ''}
              />
            ) : (
              <pre>{viewer.body}</pre>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function StatusPanel({ status, loading }: { status?: DockerStatus; loading: boolean }) {
  return (
    <section className="status-card">
      <div className="status-row">
        <span className={status?.connected ? 'status-dot online' : 'status-dot offline'} />
        <strong>{loading ? 'Checking daemon' : status?.connected ? 'Engine online' : 'Engine unavailable'}</strong>
      </div>
      <dl>
        <div>
          <dt>Docker</dt>
          <dd>{status?.serverVersion ?? 'Not connected'}</dd>
        </div>
        <div>
          <dt>API</dt>
          <dd>{status?.apiVersion ?? '--'}</dd>
        </div>
        <div>
          <dt>OS</dt>
          <dd>{status?.osType ?? 'linux'}</dd>
        </div>
      </dl>
      {status?.error && <p className="status-error">{status.error}</p>}
    </section>
  )
}

function ContainersSection({
  items,
  loading,
  busy,
  onAction,
  onInspect,
  onLogs,
}: {
  items: ContainerSummary[]
  loading: boolean
  busy: boolean
  onAction: (job: () => Promise<void>) => void
  onInspect: (item: ContainerSummary) => void
  onLogs: (item: ContainerSummary) => void
}) {
  if (loading) return <StatePanel title="Loading containers" copy="Collecting runtime inventory." />
  if (!items.length) return <StatePanel title="No containers" copy="Start a workload and it will show up here." />

  return (
    <TableShell>
      <table className="resource-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Image</th>
            <th>State</th>
            <th>Status</th>
            <th>Ports</th>
            <th>Created</th>
            <th>ID</th>
            <th className="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const running = item.state === 'running'
            return (
              <tr key={item.id}>
                <td>
                  <div className="primary-cell">
                    <strong>{item.name}</strong>
                  </div>
                </td>
                <td className="wrap-cell">{item.image}</td>
                <td>
                  <span className={running ? 'pill success' : 'pill muted'}>{item.state}</span>
                </td>
                <td>{item.status}</td>
                <td className="wrap-cell">{item.ports.length ? item.ports.join(', ') : 'None'}</td>
                <td>{formatRelativeTime(item.created)}</td>
                <td>
                  <code>{shortenId(item.id)}</code>
                </td>
                <td>
                  <div className="action-row compact">
                    <ActionIconButton label="Start" disabled={busy || running} onClick={() => onAction(() => startContainer(item.id))}>
                      <PlayIcon />
                    </ActionIconButton>
                    <ActionIconButton label="Stop" disabled={busy || !running} onClick={() => onAction(() => stopContainer(item.id))}>
                      <StopIcon />
                    </ActionIconButton>
                    <ActionIconButton label="Restart" disabled={busy} onClick={() => onAction(() => restartContainer(item.id))}>
                      <RestartIcon />
                    </ActionIconButton>
                    <ActionIconButton label="Logs" tone="ghost" disabled={busy} onClick={() => onLogs(item)}>
                      <LogsIcon />
                    </ActionIconButton>
                    <ActionIconButton label="Inspect" tone="ghost" disabled={busy} onClick={() => onInspect(item)}>
                      <InspectIcon />
                    </ActionIconButton>
                    <ActionIconButton label="Remove" tone="danger" disabled={busy} onClick={() => onAction(() => removeContainer(item.id))}>
                      <TrashIcon />
                    </ActionIconButton>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </TableShell>
  )
}

function ImagesSection({
  items,
  loading,
  busy,
  pullTarget,
  onPullTargetChange,
  onPull,
  onAction,
  onInspect,
}: {
  items: ImageSummary[]
  loading: boolean
  busy: boolean
  pullTarget: string
  onPullTargetChange: (value: string) => void
  onPull: () => void
  onAction: (job: () => Promise<void>) => void
  onInspect: (item: ImageSummary) => void
}) {
  return (
    <>
      <section className="hero-strip">
        <div>
          <p className="eyebrow">Registry Pull</p>
          <h3>Fetch a new image into the local engine</h3>
        </div>
        <div className="pull-form">
          <input value={pullTarget} onChange={(event) => onPullTargetChange(event.target.value)} />
          <button type="button" disabled={busy || !pullTarget.trim()} onClick={onPull}>
            Pull image
          </button>
        </div>
      </section>

      {loading ? (
        <StatePanel title="Loading images" copy="Reading the local cache and tags." />
      ) : !items.length ? (
        <StatePanel title="No images" copy="Pull or build something and it will appear here." />
      ) : (
        <TableShell>
          <table className="resource-table">
            <thead>
              <tr>
                <th>Primary tag</th>
                <th>Tags</th>
                <th>Size</th>
                <th>Created</th>
                <th>Refs</th>
                <th>ID</th>
                <th className="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="primary-cell">
                      <strong>{item.primaryTag || '<untagged>'}</strong>
                    </div>
                  </td>
                  <td className="wrap-cell">{item.tags.join(', ') || 'None'}</td>
                  <td>{formatBytes(item.size)}</td>
                  <td>{formatDateTime(item.created)}</td>
                  <td>
                    <span className="pill info">{item.containers} refs</span>
                  </td>
                  <td>
                    <code>{shortenId(item.id)}</code>
                  </td>
                  <td>
                    <div className="action-row compact">
                      <ActionIconButton label="Inspect" tone="ghost" onClick={() => onInspect(item)}>
                        <InspectIcon />
                      </ActionIconButton>
                      <ActionIconButton label="Remove" tone="danger" disabled={busy} onClick={() => onAction(() => removeImage(item.id))}>
                        <TrashIcon />
                      </ActionIconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      )}
    </>
  )
}

function VolumesSection({
  items,
  loading,
  busy,
  onAction,
  onInspect,
}: {
  items: VolumeSummary[]
  loading: boolean
  busy: boolean
  onAction: (job: () => Promise<void>) => void
  onInspect: (item: VolumeSummary) => void
}) {
  if (loading) return <StatePanel title="Loading volumes" copy="Checking persistent storage." />
  if (!items.length) return <StatePanel title="No volumes" copy="Create a named volume and it will show here." />

  return (
    <TableShell>
      <table className="resource-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Driver</th>
            <th>Scope</th>
            <th>Mountpoint</th>
            <th>Created</th>
            <th className="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.name}>
              <td>
                <div className="primary-cell">
                  <strong>{item.name}</strong>
                </div>
              </td>
              <td>{item.driver}</td>
              <td>
                <span className="pill info">{item.scope}</span>
              </td>
              <td className="wrap-cell">{item.mountpoint || 'Unknown'}</td>
              <td>{item.createdAt || 'Unknown'}</td>
              <td>
                <div className="action-row compact">
                  <ActionIconButton label="Inspect" tone="ghost" onClick={() => onInspect(item)}>
                    <InspectIcon />
                  </ActionIconButton>
                  <ActionIconButton label="Remove" tone="danger" disabled={busy} onClick={() => onAction(() => removeVolume(item.name))}>
                    <TrashIcon />
                  </ActionIconButton>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableShell>
  )
}

function NetworksSection({
  items,
  loading,
  busy,
  onAction,
  onInspect,
}: {
  items: NetworkSummary[]
  loading: boolean
  busy: boolean
  onAction: (job: () => Promise<void>) => void
  onInspect: (item: NetworkSummary) => void
}) {
  if (loading) return <StatePanel title="Loading networks" copy="Mapping local network bridges." />
  if (!items.length) return <StatePanel title="No networks" copy="Docker will list networks here once available." />

  return (
    <TableShell>
      <table className="resource-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Driver</th>
            <th>Scope</th>
            <th>Flags</th>
            <th>Created</th>
            <th>ID</th>
            <th className="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <div className="primary-cell">
                  <strong>{item.name}</strong>
                </div>
              </td>
              <td>
                <span className="pill info">{item.driver}</span>
              </td>
              <td>{item.scope}</td>
              <td>{networkFlags(item)}</td>
              <td>{item.created || 'Unknown'}</td>
              <td>
                <code>{shortenId(item.id)}</code>
              </td>
              <td>
                <div className="action-row compact">
                  <ActionIconButton label="Inspect" tone="ghost" onClick={() => onInspect(item)}>
                    <InspectIcon />
                  </ActionIconButton>
                  <ActionIconButton label="Remove" tone="danger" disabled={busy} onClick={() => onAction(() => removeNetwork(item.id))}>
                    <TrashIcon />
                  </ActionIconButton>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableShell>
  )
}

function TableShell({ children }: { children: ReactNode }) {
  return <section className="table-shell">{children}</section>
}

function LiveLogViewer({
  containerId,
  initialBody,
}: {
  containerId: string
  initialBody: string
}) {
  const [body, setBody] = useState(initialBody)
  const [isFollowing, setIsFollowing] = useState(true)
  const [copyLabel, setCopyLabel] = useState<'copy' | 'copied'>('copy')
  const [streamError, setStreamError] = useState<string | null>(null)
  const [transportLabel, setTransportLabel] = useState<'stream' | 'fallback'>('stream')
  const logRef = useRef<HTMLPreElement | null>(null)
  const lastStreamAtRef = useRef(0)

  useEffect(() => {
    if (!containerId) return

    let mounted = true
    const streamId = window.crypto?.randomUUID?.() ?? `${containerId}-${Date.now()}`
    let unlistenChunk: (() => void) | null = null
    let unlistenError: (() => void) | null = null
    let fallbackTimer: number | null = null

    lastStreamAtRef.current = Date.now()

    const runFallbackRefresh = async () => {
      try {
        const nextBody = await containerLogs(containerId)
        if (!mounted) return
        setBody(nextBody || 'No log output returned for this container.')
        setTransportLabel('fallback')
      } catch (error) {
        if (!mounted) return
        setStreamError(error instanceof Error ? error.message : String(error))
      }
    }

    const setupStream = async () => {
      unlistenChunk = await listen<{ streamId: string; chunk: string }>('container-log-chunk', (event) => {
        if (!mounted || event.payload.streamId !== streamId) return

        lastStreamAtRef.current = Date.now()
        setTransportLabel('stream')
        setBody((current) => {
          const next = current === 'No log output returned for this container.' ? '' : current
          return `${next}${event.payload.chunk}`
        })
      })

      unlistenError = await listen<{ streamId: string; message: string }>('container-log-error', (event) => {
        if (!mounted || event.payload.streamId !== streamId) return
        setStreamError(event.payload.message)
        void runFallbackRefresh()
      })

      await startContainerLogStream(containerId, streamId)

      fallbackTimer = window.setInterval(() => {
        if (Date.now() - lastStreamAtRef.current > 4000) {
          void runFallbackRefresh()
        }
      }, 3000)
    }

    void setupStream().catch((error) => {
      if (!mounted) return
      setStreamError(error instanceof Error ? error.message : String(error))
      void runFallbackRefresh()
    })

    return () => {
      mounted = false
      unlistenChunk?.()
      unlistenError?.()
      if (fallbackTimer !== null) {
        window.clearInterval(fallbackTimer)
      }
      void stopContainerLogStream(streamId)
    }
  }, [containerId])

  useEffect(() => {
    const element = logRef.current
    if (!element || !isFollowing) return
    element.scrollTop = element.scrollHeight
  }, [body, isFollowing])

  const handleScroll = () => {
    const element = logRef.current
    if (!element) return
    setIsFollowing(isNearBottom(element))
  }

  const toggleFollow = () => {
    const next = !isFollowing
    setIsFollowing(next)

    if (next) {
      const element = logRef.current
      if (element) {
        element.scrollTop = element.scrollHeight
      }
    }
  }

  const copyLogs = async () => {
    await navigator.clipboard.writeText(body)
    setCopyLabel('copied')
    window.setTimeout(() => setCopyLabel('copy'), 1200)
  }

  return (
    <>
      <div className="viewer-toolbar">
        <div className="viewer-status">
          <span className={isFollowing ? 'status-dot online' : 'status-dot paused'} />
          <strong>{isFollowing ? 'Following live output' : 'Paused while browsing history'}</strong>
          <span className="viewer-mode">{transportLabel === 'stream' ? 'stream' : 'fallback sync'}</span>
          {streamError && <span className="viewer-error">{streamError}</span>}
        </div>
        <div className="action-row compact">
          <ActionIconButton label={isFollowing ? 'Pause follow' : 'Resume follow'} tone="ghost" onClick={toggleFollow}>
            {isFollowing ? <PauseIcon /> : <FollowIcon />}
          </ActionIconButton>
          <ActionIconButton label="Jump to latest" tone="ghost" onClick={() => {
            const element = logRef.current
            if (element) {
              element.scrollTop = element.scrollHeight
              setIsFollowing(true)
            }
          }}>
            <LatestIcon />
          </ActionIconButton>
          <ActionIconButton label={copyLabel === 'copied' ? 'Copied' : 'Copy logs'} tone="ghost" onClick={() => void copyLogs()}>
            <CopyIcon />
          </ActionIconButton>
        </div>
      </div>
      <pre ref={logRef} onScroll={handleScroll}>{body}</pre>
    </>
  )
}

function ActionIconButton({
  label,
  tone,
  disabled,
  onClick,
  children,
}: {
  label: string
  tone?: 'default' | 'ghost' | 'danger'
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  const className = ['icon-button', tone && tone !== 'default' ? tone : ''].filter(Boolean).join(' ')

  return (
    <button type="button" className={className} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}

function PlayIcon() {
  return <IconFrame path="M8 6.5v11l9-5.5-9-5.5Z" />
}

function StopIcon() {
  return <IconFrame path="M7 7h10v10H7z" />
}

function RestartIcon() {
  return <IconFrame path="M16.5 8.5A5.5 5.5 0 1 0 17 15M16.5 8.5V5M16.5 8.5H13" />
}

function LogsIcon() {
  return <IconFrame path="M6 8h12M6 12h12M6 16h8" />
}

function InspectIcon() {
  return <IconFrame path="M11 7a6 6 0 1 0 0 12a6 6 0 0 0 0-12Zm0 0v-2M16 16l3 3" />
}

function TrashIcon() {
  return <IconFrame path="M8 8h8M9 8V6h6v2M9 10v7M12 10v7M15 10v7M7 8l1 10h8l1-10" />
}

function PauseIcon() {
  return <IconFrame path="M9 7v10M15 7v10" />
}

function FollowIcon() {
  return <IconFrame path="M8 6.5v11l9-5.5-9-5.5ZM5 6v12" />
}

function LatestIcon() {
  return <IconFrame path="M6 8l6 6l6-6M6 14l6 6l6-6" />
}

function CopyIcon() {
  return <IconFrame path="M9 9V5h10v12h-4M5 9h10v10H5z" />
}

function IconFrame({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  )
}

function isNearBottom(element: HTMLPreElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 32
}

function StatePanel({ title, copy }: { title: string; copy: string }) {
  return (
    <section className="state-panel">
      <h3>{title}</h3>
      <p>{copy}</p>
    </section>
  )
}

function filterContainers(items: ContainerSummary[], search: string) {
  const needle = search.trim().toLowerCase()
  if (!needle) return items
  return items.filter((item) =>
    [item.name, item.image, item.state, item.status, item.id].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  )
}

function filterImages(items: ImageSummary[], search: string) {
  const needle = search.trim().toLowerCase()
  if (!needle) return items
  return items.filter((item) =>
    [item.id, item.primaryTag, ...item.tags].join(' ').toLowerCase().includes(needle),
  )
}

function filterVolumes(items: VolumeSummary[], search: string) {
  const needle = search.trim().toLowerCase()
  if (!needle) return items
  return items.filter((item) => [item.name, item.driver, item.scope].join(' ').toLowerCase().includes(needle))
}

function filterNetworks(items: NetworkSummary[], search: string) {
  const needle = search.trim().toLowerCase()
  if (!needle) return items
  return items.filter((item) => [item.id, item.name, item.driver, item.scope].join(' ').toLowerCase().includes(needle))
}

function networkFlags(item: NetworkSummary) {
  const flags = []
  if (item.internal) flags.push('internal')
  if (item.attachable) flags.push('attachable')
  return flags.length ? flags.join(', ') : 'default'
}

export default App
