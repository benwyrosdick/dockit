import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  restartContainer,
  startContainer,
  startContainerLogStream,
  stopContainer,
  stopContainerLogStream,
  containerLogs,
} from './lib/api'
import { formatBytes, formatDateTime, shortenId } from './lib/format'
import type {
  ContainerSummary,
  DockerStatus,
  ImageSummary,
  InspectPayload,
  NetworkSummary,
  VolumeSummary,
} from './types/docker'

type ResourceKey = 'containers' | 'images' | 'volumes' | 'networks'

type DetailTab = 'info' | 'logs' | 'inspect'
type AnsiStyle = {
  color?: string
  backgroundColor?: string
  fontWeight?: '700'
  fontStyle?: 'italic'
  textDecoration?: 'underline'
  opacity?: number
}

type ContainerQuickAction = 'start' | 'stop' | 'restart' | 'delete'

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

const CUSTOM_SCROLLBAR_SIZE = 10
const CUSTOM_SCROLLBAR_INSET = 4
const CUSTOM_SCROLLBAR_GAP = 12

function ScrollArea({
  className,
  viewportClassName,
  viewportRef,
  onScroll,
  children,
}: {
  className?: string
  viewportClassName?: string
  viewportRef?: React.RefObject<HTMLDivElement | null> | ((node: HTMLDivElement | null) => void)
  onScroll?: () => void
  children: ReactNode
}) {
  const internalRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<
    | {
        axis: 'x' | 'y'
        pointerStart: number
        scrollStart: number
        trackSize: number
        thumbSize: number
        maxScroll: number
      }
    | null
  >(null)
  const [metrics, setMetrics] = useState({
    verticalVisible: false,
    verticalThumbSize: 0,
    verticalThumbOffset: 0,
    horizontalVisible: false,
    horizontalThumbSize: 0,
    horizontalThumbOffset: 0,
  })

  const setViewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      internalRef.current = node
      if (!viewportRef) return
      if (typeof viewportRef === 'function') {
        viewportRef(node)
        return
      }
      viewportRef.current = node
    },
    [viewportRef],
  )

  const updateMetrics = useCallback(() => {
    const viewport = internalRef.current
    if (!viewport) return

    const verticalVisible = viewport.scrollHeight > viewport.clientHeight + 1
    const horizontalVisible = viewport.scrollWidth > viewport.clientWidth + 1
    const verticalTrackSize = Math.max(
      viewport.clientHeight - CUSTOM_SCROLLBAR_INSET * 2 - (horizontalVisible ? CUSTOM_SCROLLBAR_SIZE + CUSTOM_SCROLLBAR_GAP : 0),
      0,
    )
    const horizontalTrackSize = Math.max(
      viewport.clientWidth - CUSTOM_SCROLLBAR_INSET * 2 - (verticalVisible ? CUSTOM_SCROLLBAR_SIZE + CUSTOM_SCROLLBAR_GAP : 0),
      0,
    )
    const verticalMaxScroll = Math.max(viewport.scrollHeight - viewport.clientHeight, 0)
    const horizontalMaxScroll = Math.max(viewport.scrollWidth - viewport.clientWidth, 0)
    const verticalThumbSize =
      verticalVisible && verticalTrackSize > 0
        ? Math.max((viewport.clientHeight / viewport.scrollHeight) * verticalTrackSize, 28)
        : 0
    const horizontalThumbSize =
      horizontalVisible && horizontalTrackSize > 0
        ? Math.max((viewport.clientWidth / viewport.scrollWidth) * horizontalTrackSize, 28)
        : 0
    const verticalThumbOffset =
      verticalVisible && verticalMaxScroll > 0 && verticalTrackSize > verticalThumbSize
        ? (viewport.scrollTop / verticalMaxScroll) * (verticalTrackSize - verticalThumbSize)
        : 0
    const horizontalThumbOffset =
      horizontalVisible && horizontalMaxScroll > 0 && horizontalTrackSize > horizontalThumbSize
        ? (viewport.scrollLeft / horizontalMaxScroll) * (horizontalTrackSize - horizontalThumbSize)
        : 0

    setMetrics({
      verticalVisible,
      verticalThumbSize,
      verticalThumbOffset,
      horizontalVisible,
      horizontalThumbSize,
      horizontalThumbOffset,
    })
  }, [])

  useEffect(() => {
    updateMetrics()
  }, [children, updateMetrics])

  useEffect(() => {
    const viewport = internalRef.current
    if (!viewport) return

    const resizeObserver = new ResizeObserver(() => updateMetrics())
    resizeObserver.observe(viewport)
    Array.from(viewport.children).forEach((child) => resizeObserver.observe(child))

    const rafId = window.requestAnimationFrame(updateMetrics)
    window.addEventListener('resize', updateMetrics)

    return () => {
      window.cancelAnimationFrame(rafId)
      window.removeEventListener('resize', updateMetrics)
      resizeObserver.disconnect()
    }
  }, [children, updateMetrics])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragRef.current
      const viewport = internalRef.current
      if (!dragState || !viewport) return

      const pointerNow = dragState.axis === 'y' ? event.clientY : event.clientX
      const pointerDelta = pointerNow - dragState.pointerStart
      const trackTravel = Math.max(dragState.trackSize - dragState.thumbSize, 1)
      const nextScroll = dragState.scrollStart + (pointerDelta / trackTravel) * dragState.maxScroll

      if (dragState.axis === 'y') {
        viewport.scrollTop = nextScroll
      } else {
        viewport.scrollLeft = nextScroll
      }
      updateMetrics()
    }

    const handlePointerUp = () => {
      dragRef.current = null
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [updateMetrics])

  const handleScroll = () => {
    updateMetrics()
    onScroll?.()
  }

  const startThumbDrag = (axis: 'x' | 'y', event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()

    const viewport = internalRef.current
    if (!viewport) return

    dragRef.current = {
      axis,
      pointerStart: axis === 'y' ? event.clientY : event.clientX,
      scrollStart: axis === 'y' ? viewport.scrollTop : viewport.scrollLeft,
      trackSize:
        axis === 'y'
          ? Math.max(viewport.clientHeight - CUSTOM_SCROLLBAR_INSET * 2 - (metrics.horizontalVisible ? CUSTOM_SCROLLBAR_SIZE + CUSTOM_SCROLLBAR_GAP : 0), 0)
          : Math.max(viewport.clientWidth - CUSTOM_SCROLLBAR_INSET * 2 - (metrics.verticalVisible ? CUSTOM_SCROLLBAR_SIZE + CUSTOM_SCROLLBAR_GAP : 0), 0),
      thumbSize: axis === 'y' ? metrics.verticalThumbSize : metrics.horizontalThumbSize,
      maxScroll: axis === 'y' ? Math.max(viewport.scrollHeight - viewport.clientHeight, 0) : Math.max(viewport.scrollWidth - viewport.clientWidth, 0),
    }
  }

  const handleTrackPress = (axis: 'x' | 'y', event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return

    const viewport = internalRef.current
    if (!viewport) return

    const rect = event.currentTarget.getBoundingClientRect()

    if (axis === 'y') {
      const clickOffset = event.clientY - rect.top - metrics.verticalThumbSize / 2
      const travel = Math.max(rect.height - metrics.verticalThumbSize, 1)
      const nextRatio = Math.min(Math.max(clickOffset / travel, 0), 1)
      viewport.scrollTop = nextRatio * Math.max(viewport.scrollHeight - viewport.clientHeight, 0)
    } else {
      const clickOffset = event.clientX - rect.left - metrics.horizontalThumbSize / 2
      const travel = Math.max(rect.width - metrics.horizontalThumbSize, 1)
      const nextRatio = Math.min(Math.max(clickOffset / travel, 0), 1)
      viewport.scrollLeft = nextRatio * Math.max(viewport.scrollWidth - viewport.clientWidth, 0)
    }

    updateMetrics()
  }

  const classes = ['scroll-area', className].filter(Boolean).join(' ')
  const viewportClasses = [
    'scroll-area-viewport',
    metrics.verticalVisible ? 'has-vertical-scrollbar' : '',
    metrics.horizontalVisible ? 'has-horizontal-scrollbar' : '',
    viewportClassName,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes}>
      <div ref={setViewportRef} className={viewportClasses} onScroll={handleScroll}>
        {children}
      </div>
      {metrics.verticalVisible ? (
        <div
          className="scroll-area-track vertical"
          onPointerDown={(event) => handleTrackPress('y', event)}
          style={{ bottom: metrics.horizontalVisible ? CUSTOM_SCROLLBAR_SIZE + CUSTOM_SCROLLBAR_GAP : CUSTOM_SCROLLBAR_INSET }}
        >
          <div
            className="scroll-area-thumb"
            onPointerDown={(event) => startThumbDrag('y', event)}
            style={{ height: metrics.verticalThumbSize, transform: `translateY(${metrics.verticalThumbOffset}px)` }}
          />
        </div>
      ) : null}
      {metrics.horizontalVisible ? (
        <div
          className="scroll-area-track horizontal"
          onPointerDown={(event) => handleTrackPress('x', event)}
          style={{ right: metrics.verticalVisible ? CUSTOM_SCROLLBAR_SIZE + CUSTOM_SCROLLBAR_GAP : CUSTOM_SCROLLBAR_INSET }}
        >
          <div
            className="scroll-area-thumb"
            onPointerDown={(event) => startThumbDrag('x', event)}
            style={{ width: metrics.horizontalThumbSize, transform: `translateX(${metrics.horizontalThumbOffset}px)` }}
          />
        </div>
      ) : null}
    </div>
  )
}

function App() {
  const [resource, setResource] = useState<ResourceKey>('containers')
  const [search, setSearch] = useState('')
  const [selectedResourceId, setSelectedResourceId] = useState('')
  const [detailTab, setDetailTab] = useState<DetailTab>('info')
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

  const filteredData = {
    containers: filterContainers(currentData.containers, search),
    images: filterImages(currentData.images, search),
    volumes: filterVolumes(currentData.volumes, search),
    networks: filterNetworks(currentData.networks, search),
  }

  const currentItems = filteredData[resource]
  const selectedItem =
    currentItems.find((item) => getResourceItemKey(resource, item) === selectedResourceId) ??
    currentItems[0] ??
    null
  const effectiveSelectedId = selectedItem ? getResourceItemKey(resource, selectedItem) : ''

  const detailQuery = useQuery({
    queryKey: ['resource-inspect', resource, effectiveSelectedId],
    enabled: Boolean(selectedItem),
    queryFn: async () => {
      switch (resource) {
        case 'containers':
          return inspectContainer((selectedItem as ContainerSummary).id)
        case 'images':
          return inspectImage((selectedItem as ImageSummary).id)
        case 'volumes':
          return inspectVolume((selectedItem as VolumeSummary).name)
        case 'networks':
          return inspectNetwork((selectedItem as NetworkSummary).id)
      }
    },
  })

  const busy = actionMutation.isPending || pullMutation.isPending
  const currentStatus = statusQuery.data

  return (
    <div className="shell">
      <aside className="sidebar">
        <ScrollArea className="sidebar-scroll-area" viewportClassName="sidebar-scroll-viewport">
          <div className="brand-block">
            <p className="eyebrow">Local Docker</p>
            <h1>Dockit</h1>
            <p className="brand-copy">Compact runtime control</p>
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
                    setSelectedResourceId('')
                    setDetailTab('info')
                  }}
              >
                <span>
                  <strong>{item.label}</strong>
                </span>
                <span className="nav-count">{counts[item.key]}</span>
              </button>
            ))}
          </nav>

          <StatusPanel status={currentStatus} loading={statusQuery.isLoading} />
        </ScrollArea>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-copy">
            <p className="eyebrow">{resources.find((item) => item.key === resource)?.label}</p>
            <h2>{resources.find((item) => item.key === resource)?.label}</h2>
            <p className="topbar-meta">{currentItems.length} visible</p>
          </div>

          <div className="toolbar">
            <label className="search">
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
            items={filteredData.containers}
            loading={containersQuery.isLoading}
            busy={busy}
            selectedId={effectiveSelectedId}
            selectedTab={detailTab}
            inspectData={detailQuery.data}
            inspectLoading={detailQuery.isLoading}
            inspectError={detailQuery.error}
            onSelect={setSelectedResourceId}
            onSelectTab={setDetailTab}
            onQuickAction={(item, action = item.state === 'running' ? 'stop' : 'start') =>
              actionMutation.mutate(() => {
                switch (action) {
                  case 'start':
                    return startContainer(item.id)
                  case 'stop':
                    return stopContainer(item.id)
                  case 'restart':
                    return restartContainer(item.id)
                  case 'delete':
                    return removeContainer(item.id)
                  default:
                    return Promise.resolve()
                }
              })}
          />
        )}

        {resource === 'images' && (
          <ImagesSection
            items={filteredData.images}
            loading={imagesQuery.isLoading}
            busy={busy}
            selectedId={effectiveSelectedId}
            selectedTab={detailTab}
            inspectData={detailQuery.data}
            inspectLoading={detailQuery.isLoading}
            inspectError={detailQuery.error}
            onSelect={setSelectedResourceId}
            onSelectTab={setDetailTab}
            pullTarget={pullTarget}
            onPullTargetChange={setPullTarget}
            onPull={() => pullMutation.mutate(pullTarget)}
          />
        )}

        {resource === 'volumes' && (
          <VolumesSection
            items={filteredData.volumes}
            loading={volumesQuery.isLoading}
            selectedId={effectiveSelectedId}
            selectedTab={detailTab}
            inspectData={detailQuery.data}
            inspectLoading={detailQuery.isLoading}
            inspectError={detailQuery.error}
            onSelect={setSelectedResourceId}
            onSelectTab={setDetailTab}
          />
        )}

        {resource === 'networks' && (
          <NetworksSection
            items={filteredData.networks}
            loading={networksQuery.isLoading}
            selectedId={effectiveSelectedId}
            selectedTab={detailTab}
            inspectData={detailQuery.data}
            inspectLoading={detailQuery.isLoading}
            inspectError={detailQuery.error}
            onSelect={setSelectedResourceId}
            onSelectTab={setDetailTab}
          />
        )}

        {(statusQuery.error || actionMutation.error || pullMutation.error) && (
          <div className="error-banner">
            {String(statusQuery.error || actionMutation.error || pullMutation.error)}
          </div>
        )}
      </main>

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
  selectedId,
  selectedTab,
  inspectData,
  inspectLoading,
  inspectError,
  onSelect,
  onSelectTab,
  onQuickAction,
}: {
  items: ContainerSummary[]
  loading: boolean
  busy: boolean
  selectedId: string
  selectedTab: DetailTab
  inspectData?: InspectPayload
  inspectLoading: boolean
  inspectError: unknown
  onSelect: (id: string) => void
  onSelectTab: (tab: DetailTab) => void
  onQuickAction: (item: ContainerSummary, action?: ContainerQuickAction) => void
}) {
  const [menuState, setMenuState] = useState<{ item: ContainerSummary; x: number; y: number } | null>(null)

  useEffect(() => {
    if (!menuState) return

    const closeMenu = () => setMenuState(null)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuState(null)
    }

    window.addEventListener('pointerdown', closeMenu)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('pointerdown', closeMenu)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuState])

  useEffect(() => {
    if (busy) setMenuState(null)
  }, [busy])

  if (loading) return <StatePanel title="Loading containers" copy="Collecting runtime inventory." />
  if (!items.length) return <StatePanel title="No containers" copy="Start a workload and it will show up here." />

  const selected = items.find((item) => item.id === selectedId) ?? items[0]

  return (
    <ResourceWorkspace
      list={
        <section className="resource-list-pane">
          <div className="list-pane-header">
            <div>
              <p className="eyebrow">Runtime inventory</p>
              <h3>Containers</h3>
            </div>
            <span className="list-count">{items.length}</span>
          </div>
          <ScrollArea className="resource-list-scroll-area" viewportClassName="resource-list">
            {items.map((item) => {
              const running = item.state === 'running'
              const actionLabel = running ? 'Stop container' : 'Start container'
              const statusTone = containerStatusTone(item)
              const nameClassName = ['container-name', statusTone].filter(Boolean).join(' ')
              const statusClassName = ['resource-meta-line', 'uptime-line', statusTone].filter(Boolean).join(' ')
              return (
                <article
                  key={item.id}
                  className={item.id === selected.id ? 'resource-list-item selected' : 'resource-list-item'}
                  onClick={() => {
                    onSelect(item.id)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    onSelect(item.id)
                    setMenuState({ item, x: event.clientX, y: event.clientY })
                  }}
                >
                  <div className="resource-item-copy">
                    <div className="resource-item-head">
                      <strong className={nameClassName}>{item.name}</strong>
                    </div>
                    <small>{item.image}</small>
                    <span className={statusClassName}>{item.status}</span>
                  </div>
                  <div className="resource-item-actions">
                    <ActionIconButton
                      label={actionLabel}
                      tone="ghost"
                      disabled={busy}
                      onClick={() => {
                        onSelect(item.id)
                        onQuickAction(item)
                      }}
                    >
                      {running ? <StopIcon /> : <PlayIcon />}
                    </ActionIconButton>
                  </div>
                </article>
              )
            })}
          </ScrollArea>
          {menuState ? (
            <ContainerContextMenu
              item={menuState.item}
              x={menuState.x}
              y={menuState.y}
              busy={busy}
              onClose={() => setMenuState(null)}
              onAction={(action) => {
                setMenuState(null)
                onQuickAction(menuState.item, action)
              }}
            />
          ) : null}
        </section>
      }
      detail={
        <ContainerDetailPane
          item={selected}
          selectedTab={selectedTab}
          inspectData={inspectData}
          inspectLoading={inspectLoading}
          inspectError={inspectError}
          onSelectTab={onSelectTab}
        />
      }
    />
  )
}

function ContainerContextMenu({
  item,
  x,
  y,
  busy,
  onClose,
  onAction,
}: {
  item: ContainerSummary
  x: number
  y: number
  busy: boolean
  onClose: () => void
  onAction: (action: ContainerQuickAction) => void
}) {
  const running = item.state === 'running'
  const primaryAction: ContainerQuickAction = running ? 'stop' : 'start'
  const actions: Array<{ key: ContainerQuickAction; label: string; icon: ReactNode; danger?: boolean }> = [
    {
      key: primaryAction,
      label: running ? 'Stop' : 'Start',
      icon: running ? <StopIcon /> : <PlayIcon />,
    },
    { key: 'restart', label: 'Restart', icon: <RestartIcon /> },
    { key: 'delete', label: 'Delete', icon: <TrashIcon />, danger: true },
  ]

  return (
    <div
      className="context-menu-layer"
      onContextMenu={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div
        className="context-menu"
        style={{ left: Math.min(x, window.innerWidth - 232), top: Math.min(y, window.innerHeight - 180) }}
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            className={action.danger ? 'context-menu-item danger' : 'context-menu-item'}
            disabled={busy}
            onClick={() => onAction(action.key)}
          >
            <span className="context-menu-icon">{action.icon}</span>
            <span>{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ImagesSection({
  items,
  loading,
  busy,
  selectedId,
  selectedTab,
  inspectData,
  inspectLoading,
  inspectError,
  onSelect,
  onSelectTab,
  pullTarget,
  onPullTargetChange,
  onPull,
}: {
  items: ImageSummary[]
  loading: boolean
  busy: boolean
  selectedId: string
  selectedTab: DetailTab
  inspectData?: InspectPayload
  inspectLoading: boolean
  inspectError: unknown
  onSelect: (id: string) => void
  onSelectTab: (tab: DetailTab) => void
  pullTarget: string
  onPullTargetChange: (value: string) => void
  onPull: () => void
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
        <ResourceWorkspace
          list={
            <section className="resource-list-pane">
              <div className="list-pane-header">
                <div>
                  <p className="eyebrow">Image cache</p>
                  <h3>Images</h3>
                </div>
                <span className="list-count">{items.length}</span>
              </div>
              <ScrollArea className="resource-list-scroll-area" viewportClassName="resource-list">
                {items.map((item) => (
                  <article
                    key={item.id}
                    className={item.id === (selectedId || items[0]?.id) ? 'resource-list-item selected' : 'resource-list-item'}
                    onClick={() => {
                      onSelect(item.id)
                      onSelectTab('info')
                    }}
                  >
                    <div className="resource-item-copy">
                      <div className="resource-item-head">
                        <strong>{item.primaryTag || '<untagged>'}</strong>
                        <span className="pill info">{item.containers} refs</span>
                      </div>
                      <small>{shortenId(item.id)}</small>
                      <span className="resource-meta-line">{item.tags[1] ?? item.tags[0] ?? 'No tags'}</span>
                      <span className="resource-meta-line">{formatBytes(item.size)} • {formatDateTime(item.created)}</span>
                    </div>
                  </article>
                ))}
              </ScrollArea>
            </section>
          }
          detail={
            <ImageDetailPane
              item={items.find((item) => item.id === selectedId) ?? items[0]}
              selectedTab={selectedTab}
              inspectData={inspectData}
              inspectLoading={inspectLoading}
              inspectError={inspectError}
              onSelectTab={onSelectTab}
            />
          }
        />
      )}
    </>
  )
}

function VolumesSection({
  items,
  loading,
  selectedId,
  selectedTab,
  inspectData,
  inspectLoading,
  inspectError,
  onSelect,
  onSelectTab,
}: {
  items: VolumeSummary[]
  loading: boolean
  selectedId: string
  selectedTab: DetailTab
  inspectData?: InspectPayload
  inspectLoading: boolean
  inspectError: unknown
  onSelect: (id: string) => void
  onSelectTab: (tab: DetailTab) => void
}) {
  if (loading) return <StatePanel title="Loading volumes" copy="Checking persistent storage." />
  if (!items.length) return <StatePanel title="No volumes" copy="Create a named volume and it will show here." />

  return (
    <ResourceWorkspace
      list={
        <section className="resource-list-pane">
          <div className="list-pane-header">
            <div>
              <p className="eyebrow">Persistent storage</p>
              <h3>Volumes</h3>
            </div>
            <span className="list-count">{items.length}</span>
          </div>
          <ScrollArea className="resource-list-scroll-area" viewportClassName="resource-list">
            {items.map((item) => (
              <article
                key={item.name}
                className={item.name === (selectedId || items[0]?.name) ? 'resource-list-item selected' : 'resource-list-item'}
                onClick={() => {
                  onSelect(item.name)
                  onSelectTab('info')
                }}
              >
                <div className="resource-item-copy">
                  <div className="resource-item-head">
                    <strong>{item.name}</strong>
                    <span className="pill info">{item.scope}</span>
                  </div>
                  <small>{item.driver}</small>
                  <span className="resource-meta-line">{item.mountpoint || 'Unknown mountpoint'}</span>
                  <span className="resource-meta-line">{item.createdAt || 'Unknown creation time'}</span>
                </div>
              </article>
            ))}
          </ScrollArea>
        </section>
      }
      detail={
        <VolumeDetailPane
          item={items.find((item) => item.name === selectedId) ?? items[0]}
          selectedTab={selectedTab}
          inspectData={inspectData}
          inspectLoading={inspectLoading}
          inspectError={inspectError}
          onSelectTab={onSelectTab}
        />
      }
    />
  )
}

function NetworksSection({
  items,
  loading,
  selectedId,
  selectedTab,
  inspectData,
  inspectLoading,
  inspectError,
  onSelect,
  onSelectTab,
}: {
  items: NetworkSummary[]
  loading: boolean
  selectedId: string
  selectedTab: DetailTab
  inspectData?: InspectPayload
  inspectLoading: boolean
  inspectError: unknown
  onSelect: (id: string) => void
  onSelectTab: (tab: DetailTab) => void
}) {
  if (loading) return <StatePanel title="Loading networks" copy="Mapping local network bridges." />
  if (!items.length) return <StatePanel title="No networks" copy="Docker will list networks here once available." />

  return (
    <ResourceWorkspace
      list={
        <section className="resource-list-pane">
          <div className="list-pane-header">
            <div>
              <p className="eyebrow">Connectivity fabric</p>
              <h3>Networks</h3>
            </div>
            <span className="list-count">{items.length}</span>
          </div>
          <ScrollArea className="resource-list-scroll-area" viewportClassName="resource-list">
            {items.map((item) => (
              <article
                key={item.id}
                className={item.id === (selectedId || items[0]?.id) ? 'resource-list-item selected' : 'resource-list-item'}
                onClick={() => {
                  onSelect(item.id)
                  onSelectTab('info')
                }}
              >
                <div className="resource-item-copy">
                  <div className="resource-item-head">
                    <strong>{item.name}</strong>
                    <span className="pill info">{item.driver}</span>
                  </div>
                  <small>{shortenId(item.id)}</small>
                  <span className="resource-meta-line">{item.scope} • {networkFlags(item)}</span>
                  <span className="resource-meta-line">{item.created || 'Unknown creation time'}</span>
                </div>
              </article>
            ))}
          </ScrollArea>
        </section>
      }
      detail={
        <NetworkDetailPane
          item={items.find((item) => item.id === selectedId) ?? items[0]}
          selectedTab={selectedTab}
          inspectData={inspectData}
          inspectLoading={inspectLoading}
          inspectError={inspectError}
          onSelectTab={onSelectTab}
        />
      }
    />
  )
}

function ResourceWorkspace({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  return (
    <section className="resource-workspace">
      {list}
      <section className="detail-pane">{detail}</section>
    </section>
  )
}

function ContainerDetailPane({
  item,
  selectedTab,
  inspectData,
  inspectLoading,
  inspectError,
  onSelectTab,
}: {
  item: ContainerSummary
  selectedTab: DetailTab
  inspectData?: InspectPayload
  inspectLoading: boolean
  inspectError: unknown
  onSelectTab: (tab: DetailTab) => void
}) {
  const logsQuery = useQuery({
    queryKey: ['container-logs', item.id],
    queryFn: () => containerLogs(item.id),
    enabled: selectedTab === 'logs',
  })
  const inspect = asRecord(inspectData)
  const config = asRecord(inspect.Config)
  const state = asRecord(inspect.State)
  const networkSettings = asRecord(inspect.NetworkSettings)
  const mounts = asArray(inspect.Mounts)
  const labels = entriesOf(asRecord(config.Labels))
  const envRows = envRowsFromList(readStringArray(config.Env))

  return (
    <>
      <DetailHeader title={item.name} subtitle={item.image} />
      <DetailTabs
        tabs={[
          { key: 'info', label: 'Info' },
          { key: 'logs', label: 'Logs' },
          { key: 'inspect', label: 'Inspect' },
        ]}
        selectedTab={selectedTab}
        onSelect={onSelectTab}
      />
      {selectedTab === 'logs' ? (
        logsQuery.isLoading ? (
          <StatePanel title="Loading logs" copy="Collecting the latest container output." />
        ) : (
          <section className="detail-surface log-surface">
            <LiveLogViewer key={item.id} containerId={item.id} initialBody={logsQuery.data || 'No log output returned for this container.'} />
          </section>
        )
      ) : selectedTab === 'inspect' ? (
        <InspectPanel data={inspectData} loading={inspectLoading} error={inspectError} />
      ) : (
        <ScrollArea className="detail-stack-scroll-area" viewportClassName="detail-stack">
          <KeyValueSection
            title="Overview"
            rows={[
              ['Name', item.name],
              ['ID', shortenId(item.id)],
              ['Image', item.image],
              ['State', item.state],
              ['Status', item.status],
              ['Created', formatDateTime(item.created)],
              ['Platform', readString(inspect.Platform)],
              ['IP address', readPrimaryIp(networkSettings)],
            ]}
          />
          <SimpleTableSection
            title="Port forwards"
            columns={['Published']}
            rows={(item.ports.length ? item.ports : ['No published ports']).map((port) => [port])}
          />
          <SimpleTableSection
            title="Mounts"
            columns={['Source', 'Destination', 'Mode']}
            rows={
              mounts.length
                ? mounts.map((mount) => {
                    const record = asRecord(mount)
                    return [readString(record.Source), readString(record.Destination), readString(record.Mode)]
                  })
                : [['No mounts', '', '']]
            }
          />
          <SimpleTableSection
            title="Labels"
            columns={['Key', 'Value']}
            rows={labels.length ? labels : [['No labels', '']]}
          />
          <SimpleTableSection
            title="Environment"
            columns={['Key', 'Value']}
            rows={envRows.length ? envRows : [['No environment variables', '']]}
          />
          {state.Health ? (
            <KeyValueSection
              title="Health"
              rows={[
                ['Status', readString(asRecord(state.Health).Status)],
                ['Failing streak', String(asRecord(state.Health).FailingStreak ?? '--')],
              ]}
            />
          ) : null}
        </ScrollArea>
      )}
    </>
  )
}

function ImageDetailPane({ item, selectedTab, inspectData, inspectLoading, inspectError, onSelectTab }: {
  item: ImageSummary
  selectedTab: DetailTab
  inspectData?: InspectPayload
  inspectLoading: boolean
  inspectError: unknown
  onSelectTab: (tab: DetailTab) => void
}) {
  const inspect = asRecord(inspectData)
  const config = asRecord(inspect.Config)
  const labels = entriesOf(asRecord(config.Labels))
  const envRows = envRowsFromList(readStringArray(config.Env))
  const repoDigests = readStringArray(inspect.RepoDigests)

  return (
    <>
      <DetailHeader title={item.primaryTag || '<untagged>'} subtitle={shortenId(item.id)} />
      <DetailTabs tabs={[{ key: 'info', label: 'Info' }, { key: 'inspect', label: 'Inspect' }]} selectedTab={selectedTab === 'logs' ? 'info' : selectedTab} onSelect={onSelectTab} />
      {selectedTab === 'inspect' ? (
        <InspectPanel data={inspectData} loading={inspectLoading} error={inspectError} />
      ) : (
        <ScrollArea className="detail-stack-scroll-area" viewportClassName="detail-stack">
          <KeyValueSection
            title="Overview"
            rows={[
              ['Primary tag', item.primaryTag || '<untagged>'],
              ['ID', shortenId(item.id)],
              ['Size', formatBytes(item.size)],
              ['Created', formatDateTime(item.created)],
              ['Containers', String(item.containers)],
              ['Architecture', readString(inspect.Architecture)],
              ['OS', readString(inspect.Os)],
            ]}
          />
          <SimpleTableSection title="Tags" columns={['Tag']} rows={(item.tags.length ? item.tags : ['No tags']).map((tag) => [tag])} />
          <SimpleTableSection title="Repo digests" columns={['Digest']} rows={(repoDigests.length ? repoDigests : ['No repo digests']).map((digest) => [digest])} />
          <SimpleTableSection title="Environment" columns={['Key', 'Value']} rows={envRows.length ? envRows : [['No environment variables', '']]} />
          <SimpleTableSection title="Labels" columns={['Key', 'Value']} rows={labels.length ? labels : [['No labels', '']]} />
        </ScrollArea>
      )}
    </>
  )
}

function VolumeDetailPane({ item, selectedTab, inspectData, inspectLoading, inspectError, onSelectTab }: {
  item: VolumeSummary
  selectedTab: DetailTab
  inspectData?: InspectPayload
  inspectLoading: boolean
  inspectError: unknown
  onSelectTab: (tab: DetailTab) => void
}) {
  const inspect = asRecord(inspectData)
  const labels = entriesOf(asRecord(inspect.Labels))
  const options = entriesOf(asRecord(inspect.Options))

  return (
    <>
      <DetailHeader title={item.name} subtitle={item.driver} />
      <DetailTabs tabs={[{ key: 'info', label: 'Info' }, { key: 'inspect', label: 'Inspect' }]} selectedTab={selectedTab === 'logs' ? 'info' : selectedTab} onSelect={onSelectTab} />
      {selectedTab === 'inspect' ? (
        <InspectPanel data={inspectData} loading={inspectLoading} error={inspectError} />
      ) : (
        <ScrollArea className="detail-stack-scroll-area" viewportClassName="detail-stack">
          <KeyValueSection
            title="Overview"
            rows={[
              ['Name', item.name],
              ['Driver', item.driver],
              ['Scope', item.scope],
              ['Mountpoint', item.mountpoint || readString(inspect.Mountpoint)],
              ['Created', item.createdAt || readString(inspect.CreatedAt)],
            ]}
          />
          <SimpleTableSection title="Options" columns={['Key', 'Value']} rows={options.length ? options : [['No options', '']]} />
          <SimpleTableSection title="Labels" columns={['Key', 'Value']} rows={labels.length ? labels : [['No labels', '']]} />
        </ScrollArea>
      )}
    </>
  )
}

function NetworkDetailPane({ item, selectedTab, inspectData, inspectLoading, inspectError, onSelectTab }: {
  item: NetworkSummary
  selectedTab: DetailTab
  inspectData?: InspectPayload
  inspectLoading: boolean
  inspectError: unknown
  onSelectTab: (tab: DetailTab) => void
}) {
  const inspect = asRecord(inspectData)
  const ipam = asRecord(inspect.IPAM)
  const ipamConfig = asArray(ipam.Config)
  const labels = entriesOf(asRecord(inspect.Labels))

  return (
    <>
      <DetailHeader title={item.name} subtitle={shortenId(item.id)} />
      <DetailTabs tabs={[{ key: 'info', label: 'Info' }, { key: 'inspect', label: 'Inspect' }]} selectedTab={selectedTab === 'logs' ? 'info' : selectedTab} onSelect={onSelectTab} />
      {selectedTab === 'inspect' ? (
        <InspectPanel data={inspectData} loading={inspectLoading} error={inspectError} />
      ) : (
        <ScrollArea className="detail-stack-scroll-area" viewportClassName="detail-stack">
          <KeyValueSection
            title="Overview"
            rows={[
              ['Name', item.name],
              ['ID', shortenId(item.id)],
              ['Driver', item.driver],
              ['Scope', item.scope],
              ['Flags', networkFlags(item)],
              ['Created', item.created || readString(inspect.Created)],
            ]}
          />
          <SimpleTableSection
            title="IPAM"
            columns={['Subnet', 'Gateway', 'Range']}
            rows={
              ipamConfig.length
                ? ipamConfig.map((entry) => {
                    const record = asRecord(entry)
                    return [readString(record.Subnet), readString(record.Gateway), readString(record.IPRange)]
                  })
                : [['No IPAM config', '', '']]
            }
          />
          <SimpleTableSection title="Labels" columns={['Key', 'Value']} rows={labels.length ? labels : [['No labels', '']]} />
        </ScrollArea>
      )}
    </>
  )
}

function DetailHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="detail-header">
      <div>
        <p className="eyebrow">Selected resource</p>
        <h3>{title}</h3>
      </div>
      <span className="detail-subtitle">{subtitle}</span>
    </header>
  )
}

function DetailTabs({ tabs, selectedTab, onSelect }: { tabs: Array<{ key: DetailTab; label: string }>; selectedTab: DetailTab; onSelect: (tab: DetailTab) => void }) {
  return (
    <div className="detail-tabs">
      {tabs.map((tab) => (
        <button key={tab.key} type="button" className={tab.key === selectedTab ? 'detail-tab active' : 'detail-tab'} onClick={() => onSelect(tab.key)}>
          {tab.label}
        </button>
      ))}
    </div>
  )
}

function KeyValueSection({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <section className="detail-surface">
      <h4>{title}</h4>
      <dl className="detail-grid">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value || '--'}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function SimpleTableSection({ title, columns, rows }: { title: string; columns: string[]; rows: string[][] }) {
  return (
    <section className="detail-surface">
      <h4>{title}</h4>
      <ScrollArea className="detail-table-scroll-area" viewportClassName="detail-table-wrap">
        <table className="resource-table detail-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${title}-${index}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`${title}-${index}-${cellIndex}`}>{cell || '--'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </section>
  )
}

function InspectPanel({ data, loading, error }: { data?: InspectPayload; loading: boolean; error: unknown }) {
  if (loading) return <StatePanel title="Loading inspect data" copy="Reading the full resource payload." />
  if (error) return <StatePanel title="Inspect failed" copy={String(error)} />

  return (
    <section className="detail-surface inspect-surface">
      <ScrollArea className="code-scroll-area" viewportClassName="code-scroll-viewport">
        <pre>{JSON.stringify(data ?? {}, null, 2)}</pre>
      </ScrollArea>
    </section>
  )
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
  const [filter, setFilter] = useState('')
  const [hideTimestamps, setHideTimestamps] = useState(true)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [transportLabel, setTransportLabel] = useState<'stream' | 'fallback'>('stream')
  const logRef = useRef<HTMLDivElement | null>(null)
  const lastStreamAtRef = useRef(0)
  const filteredBody = useMemo(() => filterLogBody(body, filter), [body, filter])
  const renderedBody = useMemo(
    () => (hideTimestamps ? stripLogTimestamps(filteredBody) : filteredBody),
    [filteredBody, hideTimestamps],
  )

  useEffect(() => {
    setBody(initialBody)
    setStreamError(null)
    setTransportLabel('stream')
    setIsFollowing(true)
  }, [containerId, initialBody])

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
  }, [isFollowing, renderedBody])

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
    await navigator.clipboard.writeText(renderedBody)
    setCopyLabel('copied')
    window.setTimeout(() => setCopyLabel('copy'), 1200)
  }

  return (
    <section className="live-log-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-status">
          <span className={isFollowing ? 'status-dot online' : 'status-dot paused'} />
          <strong>{isFollowing ? 'Following live output' : 'Paused while browsing history'}</strong>
          <span className="viewer-mode">{transportLabel === 'stream' ? 'stream' : 'fallback sync'}</span>
          {streamError && <span className="viewer-error">{streamError}</span>}
        </div>
        <div className="viewer-controls">
          <label className="log-filter">
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="grep lines"
            />
          </label>
          <label className="log-toggle">
            <input
              type="checkbox"
              checked={!hideTimestamps}
              onChange={(event) => setHideTimestamps(!event.target.checked)}
            />
            <span>Show timestamps</span>
          </label>
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
      </div>
      <ScrollArea className="code-scroll-area" viewportClassName="code-scroll-viewport" viewportRef={logRef} onScroll={handleScroll}>
        <pre><AnsiText text={renderedBody} /></pre>
      </ScrollArea>
    </section>
  )
}

function AnsiText({ text }: { text: string }) {
  const segments = useMemo(() => parseAnsiSegments(text), [text])

  return (
    <>
      {segments.map((segment, index) => (
        <span key={`${index}-${segment.text.length}`} style={segment.style}>
          {segment.text}
        </span>
      ))}
    </>
  )
}

function parseAnsiSegments(text: string): Array<{ text: string; style: AnsiStyle }> {
  const pattern = /\u001b\[([0-9;]*)m/g
  const segments: Array<{ text: string; style: AnsiStyle }> = []
  let currentStyle: AnsiStyle = {}
  let lastIndex = 0

  for (const match of text.matchAll(pattern)) {
    const matchIndex = match.index ?? 0
    if (matchIndex > lastIndex) {
      segments.push({ text: text.slice(lastIndex, matchIndex), style: currentStyle })
    }

    const codes = (match[1] || '0')
      .split(';')
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => !Number.isNaN(value))

    currentStyle = applyAnsiCodes(currentStyle, codes.length ? codes : [0])
    lastIndex = matchIndex + match[0].length
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), style: currentStyle })
  }

  return segments.length ? segments : [{ text, style: {} }]
}

function applyAnsiCodes(style: AnsiStyle, codes: number[]): AnsiStyle {
  let nextStyle = { ...style }

  for (const code of codes) {
    if (code === 0) {
      nextStyle = {}
    } else if (code === 1) {
      nextStyle.fontWeight = '700'
    } else if (code === 2) {
      nextStyle.opacity = 0.72
    } else if (code === 3) {
      nextStyle.fontStyle = 'italic'
    } else if (code === 4) {
      nextStyle.textDecoration = 'underline'
    } else if (code === 22) {
      delete nextStyle.fontWeight
      delete nextStyle.opacity
    } else if (code === 23) {
      delete nextStyle.fontStyle
    } else if (code === 24) {
      delete nextStyle.textDecoration
    } else if (code === 39) {
      delete nextStyle.color
    } else if (code === 49) {
      delete nextStyle.backgroundColor
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      nextStyle.color = ansiColorValue(code)
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      nextStyle.backgroundColor = ansiColorValue(code)
    }
  }

  return nextStyle
}

function ansiColorValue(code: number): string {
  const palette: Record<number, string> = {
    30: '#1f2937',
    31: '#f87171',
    32: '#4ade80',
    33: '#fbbf24',
    34: '#60a5fa',
    35: '#f472b6',
    36: '#22d3ee',
    37: '#e5e7eb',
    40: '#1f2937',
    41: '#7f1d1d',
    42: '#14532d',
    43: '#78350f',
    44: '#1e3a8a',
    45: '#701a75',
    46: '#164e63',
    47: '#d1d5db',
    90: '#6b7280',
    91: '#fca5a5',
    92: '#86efac',
    93: '#fcd34d',
    94: '#93c5fd',
    95: '#f9a8d4',
    96: '#67e8f9',
    97: '#f9fafb',
    100: '#4b5563',
    101: '#b91c1c',
    102: '#166534',
    103: '#a16207',
    104: '#1d4ed8',
    105: '#a21caf',
    106: '#0f766e',
    107: '#f3f4f6',
  }

  return palette[code] || 'inherit'
}

function filterLogBody(body: string, filter: string) {
  const needle = filter.trim().toLowerCase()
  if (!needle) return body
  return body
    .split('\n')
    .filter((line) => line.toLowerCase().includes(needle))
    .join('\n')
}

function stripLogTimestamps(body: string) {
  return body.replace(/(^|\n)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '$1')
}

function envRowsFromList(entries: string[]) {
  return entries.map((entry) => {
    const separatorIndex = entry.indexOf('=')
    if (separatorIndex === -1) return [entry, '--'] as [string, string]
    return [entry.slice(0, separatorIndex), entry.slice(separatorIndex + 1)] as [string, string]
  })
}

function containerStatusTone(item: ContainerSummary) {
  const status = item.status.toLowerCase()
  const exitCode = status.match(/exited\s*\((\d+)\)/)?.[1]

  if (status.includes('starting')) return 'is-starting'
  if (item.state === 'running') return status.includes('unhealthy') ? 'is-unhealthy' : 'is-healthy'
  if (exitCode && exitCode !== '0') return 'is-stopped-error'
  return ''
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
    <button
      type="button"
      className={className}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}

function PauseIcon() {
  return <IconFrame path="M9 7v10M15 7v10" />
}

function PlayIcon() {
  return <IconFrame path="M9 7.5v9l7-4.5-7-4.5Z" />
}

function StopIcon() {
  return <IconFrame path="M8 8h8v8H8z" />
}

function RestartIcon() {
  return <IconFrame path="M18 10a6 6 0 1 0 1.2 3.6M18 10V6m0 4h-4" />
}

function TrashIcon() {
  return <IconFrame path="M6 7h12M9 7V5h6v2m-7 3v7m4-7v7m4-7v7M8 7l1 12h6l1-12" />
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

function isNearBottom(element: HTMLElement) {
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
  const filtered = !needle
    ? items
    : items.filter((item) =>
        [item.name, item.image, item.state, item.status, item.id].some((value) =>
          value.toLowerCase().includes(needle),
        ),
      )

  return [...filtered].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
}

function filterImages(items: ImageSummary[], search: string) {
  const needle = search.trim().toLowerCase()
  const filtered = !needle
    ? items
    : items.filter((item) =>
        [item.id, item.primaryTag, ...item.tags].join(' ').toLowerCase().includes(needle),
      )

  return [...filtered].sort((left, right) => imageSortLabel(left).localeCompare(imageSortLabel(right), undefined, { sensitivity: 'base' }))
}

function filterVolumes(items: VolumeSummary[], search: string) {
  const needle = search.trim().toLowerCase()
  const filtered = !needle
    ? items
    : items.filter((item) => [item.name, item.driver, item.scope].join(' ').toLowerCase().includes(needle))

  return [...filtered].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
}

function filterNetworks(items: NetworkSummary[], search: string) {
  const needle = search.trim().toLowerCase()
  const filtered = !needle
    ? items
    : items.filter((item) => [item.id, item.name, item.driver, item.scope].join(' ').toLowerCase().includes(needle))

  return [...filtered].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
}

function imageSortLabel(item: ImageSummary) {
  return item.primaryTag || item.tags[0] || item.id
}

function networkFlags(item: NetworkSummary) {
  const flags = []
  if (item.internal) flags.push('internal')
  if (item.attachable) flags.push('attachable')
  return flags.length ? flags.join(', ') : 'default'
}

function getResourceItemKey(
  resource: ResourceKey,
  item: ContainerSummary | ImageSummary | VolumeSummary | NetworkSummary,
) {
  switch (resource) {
    case 'containers':
      return (item as ContainerSummary).id
    case 'images':
      return (item as ImageSummary).id
    case 'volumes':
      return (item as VolumeSummary).name
    case 'networks':
      return (item as NetworkSummary).id
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function readString(value: unknown) {
  if (value === null || value === undefined || value === '') return '--'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function readStringArray(value: unknown) {
  return asArray(value).map((entry) => readString(entry)).filter((entry) => entry !== '--')
}

function entriesOf(record: Record<string, unknown>) {
  return Object.entries(record).map(([key, value]) => [key, readString(value)] as [string, string])
}

function readPrimaryIp(networkSettings: Record<string, unknown>) {
  if (typeof networkSettings.IPAddress === 'string' && networkSettings.IPAddress) {
    return networkSettings.IPAddress
  }

  const networks = asRecord(networkSettings.Networks)
  for (const network of Object.values(networks)) {
    const ip = asRecord(network).IPAddress
    if (typeof ip === 'string' && ip) return ip
  }

  return '--'
}

export default App
