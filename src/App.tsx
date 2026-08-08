import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listen } from '@tauri-apps/api/event'
import './App.css'
import {
  containerStats,
  containerTop,
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
  ContainerStats,
  ContainerSummary,
  ContainerTop,
  ImageSummary,
  InspectPayload,
  NetworkSummary,
  VolumeSummary,
} from './types/docker'

type ResourceKey = 'containers' | 'images' | 'volumes' | 'networks'

type DetailTab = 'info' | 'logs' | 'stats' | 'top' | 'inspect'
type AnsiStyle = {
  color?: string
  backgroundColor?: string
  fontWeight?: '700'
  fontStyle?: 'italic'
  textDecoration?: 'underline'
  opacity?: number
}

type ContainerQuickAction = 'start' | 'stop' | 'restart' | 'delete'
type ContainerGroupAction = 'start' | 'stop' | 'restart'
type StatsHistoryPoint = {
  at: number
  cpu: number | null
  memory: number | null
  networkRate: number | null
}

const STATS_HISTORY_WINDOW_MS = 60_000

const resources: Array<{
  key: ResourceKey
  label: string
}> = [
  { key: 'containers', label: 'Containers' },
  { key: 'images', label: 'Images' },
  { key: 'volumes', label: 'Volumes' },
  { key: 'networks', label: 'Networks' },
]

const CUSTOM_SCROLLBAR_SIZE = 8
const CUSTOM_SCROLLBAR_INSET = 3
const CUSTOM_SCROLLBAR_GAP = 8
const RESOURCE_PANE_WIDTH_KEY = 'dockit.resourcePaneWidth'
const RESOURCE_PANE_MIN = 240
const RESOURCE_PANE_MAX = 480
const RESOURCE_PANE_DEFAULT = 300

const RESOURCE_ICON_COLORS = [
  '#5b9cf5',
  '#34c759',
  '#bf5af2',
  '#ff9f0a',
  '#ff453a',
  '#64d2ff',
  '#ff6b8a',
  '#30d158',
  '#ac8e68',
  '#0a84ff',
]

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

function resourceIconColor(seed: string) {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return RESOURCE_ICON_COLORS[hash % RESOURCE_ICON_COLORS.length]
}

function resourceInitials(label: string) {
  const cleaned = label.replace(/^\/+/, '').trim()
  if (!cleaned) return '?'
  const parts = cleaned.split(/[-_\s./]+/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase()
  return cleaned.slice(0, 2).toUpperCase()
}

function containerStateClass(state: string) {
  const normalized = state.toLowerCase()
  if (normalized === 'running') return 'running'
  if (normalized === 'exited' || normalized === 'dead' || normalized === 'removing') return 'exited'
  if (normalized === 'paused' || normalized === 'created' || normalized === 'restarting') return normalized === 'restarting' ? 'paused' : normalized
  return 'stopped'
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
  const runContainerAction = (item: ContainerSummary, action: ContainerQuickAction) => {
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
  }

  const runningCount = filteredData.containers.filter((item) => item.state === 'running').length

  return (
    <div className="shell">
      <aside className="icon-rail" aria-label="Navigation">
        <div className="rail-brand" title="Dockit">
          Dk
        </div>
        <nav className="rail-nav">
          {resources.map((item) => (
            <button
              key={item.key}
              type="button"
              className={resource === item.key ? 'rail-item active' : 'rail-item'}
              aria-current={resource === item.key ? 'page' : undefined}
              onClick={() => {
                setResource(item.key)
                setSearch('')
                setSelectedResourceId('')
                setDetailTab('info')
              }}
            >
              <span className="rail-item-icon" aria-hidden="true">
                <ResourceNavIcon resource={item.key} />
              </span>
              <span className="rail-item-label">{item.label}</span>
              {counts[item.key] > 0 ? <span className="rail-item-count">{counts[item.key]}</span> : null}
            </button>
          ))}
        </nav>
        <div className="rail-footer">
          <div
            className="rail-status"
            title={
              statusQuery.isLoading
                ? 'Checking Docker…'
                : currentStatus?.connected
                  ? `Engine online${currentStatus.serverVersion ? ` · ${currentStatus.serverVersion}` : ''}`
                  : currentStatus?.error || 'Engine unavailable'
            }
          >
            <span className={currentStatus?.connected ? 'status-dot online' : 'status-dot offline'} />
          </div>
        </div>
      </aside>

      <main className="main-panel app-content">
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
            search={search}
            onSearchChange={setSearch}
            onRefresh={() => void refreshAll()}
            runningCount={runningCount}
            onSelect={setSelectedResourceId}
            onSelectTab={setDetailTab}
            onQuickAction={(item, action = item.state === 'running' ? 'stop' : 'start') =>
              actionMutation.mutate(() => runContainerAction(item, action))}
            onGroupAction={(items, action) =>
              actionMutation.mutate(async () => {
                for (const item of items) {
                  if (action === 'start' && item.state === 'running') continue
                  if (action === 'stop' && item.state !== 'running') continue
                  await runContainerAction(item, action)
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
            search={search}
            onSearchChange={setSearch}
            onRefresh={() => void refreshAll()}
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
            search={search}
            onSearchChange={setSearch}
            onRefresh={() => void refreshAll()}
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
            search={search}
            onSearchChange={setSearch}
            onRefresh={() => void refreshAll()}
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

function ResourceNavIcon({ resource }: { resource: ResourceKey }) {
  switch (resource) {
    case 'containers':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1.2" />
          <rect x="14" y="3" width="7" height="7" rx="1.2" />
          <rect x="3" y="14" width="7" height="7" rx="1.2" />
          <rect x="14" y="14" width="7" height="7" rx="1.2" />
        </svg>
      )
    case 'images':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="9" cy="11" r="1.6" />
          <path d="m21 16-4.5-4.5L9 19" />
        </svg>
      )
    case 'volumes':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <ellipse cx="12" cy="6" rx="7" ry="3" />
          <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
          <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
        </svg>
      )
    case 'networks':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="5" r="2.2" />
          <circle cx="5" cy="19" r="2.2" />
          <circle cx="19" cy="19" r="2.2" />
          <path d="M12 7.2v4.3M12 11.5 6.2 17.2M12 11.5l5.8 5.7" />
        </svg>
      )
  }
}

function ListPaneHeader({
  title,
  subtitle,
  search,
  searchPlaceholder,
  onSearchChange,
  onRefresh,
}: {
  title: string
  subtitle: string
  search: string
  searchPlaceholder: string
  onSearchChange: (value: string) => void
  onRefresh: () => void
}) {
  return (
    <div className="list-pane-header">
      <div className="list-pane-title-block">
        <h3>{title}</h3>
        <span className="list-count">{subtitle}</span>
      </div>
      <div className="list-pane-actions">
        <label className="list-search">
          <SearchIcon />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
          />
        </label>
        <ActionIconButton label="Refresh" tone="ghost" onClick={onRefresh}>
          <RefreshIcon />
        </ActionIconButton>
      </div>
    </div>
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
  search,
  onSearchChange,
  onRefresh,
  runningCount,
  onSelect,
  onSelectTab,
  onQuickAction,
  onGroupAction,
}: {
  items: ContainerSummary[]
  loading: boolean
  busy: boolean
  selectedId: string
  selectedTab: DetailTab
  inspectData?: InspectPayload
  inspectLoading: boolean
  inspectError: unknown
  search: string
  onSearchChange: (value: string) => void
  onRefresh: () => void
  runningCount: number
  onSelect: (id: string) => void
  onSelectTab: (tab: DetailTab) => void
  onQuickAction: (item: ContainerSummary, action?: ContainerQuickAction) => void
  onGroupAction: (items: ContainerSummary[], action: ContainerGroupAction) => void
}) {
  const [menuState, setMenuState] = useState<{ item: ContainerSummary; x: number; y: number } | null>(null)
  const [groupMenuState, setGroupMenuState] = useState<{ key: string; label: string; items: ContainerSummary[]; x: number; y: number } | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!menuState && !groupMenuState) return

    const closeMenu = () => {
      setMenuState(null)
      setGroupMenuState(null)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }

    window.addEventListener('pointerdown', closeMenu)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('pointerdown', closeMenu)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuState, groupMenuState])

  useEffect(() => {
    if (busy) {
      setMenuState(null)
      setGroupMenuState(null)
    }
  }, [busy])

  const selected = items.find((item) => item.id === selectedId) ?? items[0]
  const groupedItems = groupContainersByProject(items)
  const subtitle = loading
    ? 'Loading…'
    : `${runningCount} running · ${items.length} shown`

  return (
    <ResourceWorkspace
      list={
        <section className="resource-list-pane">
          <ListPaneHeader
            title="Containers"
            subtitle={subtitle}
            search={search}
            searchPlaceholder="Filter"
            onSearchChange={onSearchChange}
            onRefresh={onRefresh}
          />
          {loading ? (
            <StatePanel title="Loading containers" copy="Collecting runtime inventory." />
          ) : !items.length ? (
            <StatePanel title="No containers" copy="Start a workload and it will show up here." />
          ) : (
            <ScrollArea className="resource-list-scroll-area" viewportClassName="resource-list">
              {groupedItems.map((group) => (
                <section key={group.key} className="container-group">
                  <header className="container-group-header">
                    <button
                      type="button"
                      className="container-group-toggle"
                      onClick={() => setCollapsedGroups((current) => ({ ...current, [group.key]: !current[group.key] }))}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        setMenuState(null)
                        setGroupMenuState({ ...group, x: event.clientX, y: event.clientY })
                      }}
                    >
                      <span className={collapsedGroups[group.key] ? 'group-chevron collapsed' : 'group-chevron'}>
                        <ChevronIcon />
                      </span>
                      <span className="group-project-icon" aria-hidden="true">
                        <ProjectIcon />
                      </span>
                      <span className="container-group-title">{group.label}</span>
                    </button>
                    <span className="container-group-count">{group.items.length}</span>
                  </header>
                  {collapsedGroups[group.key]
                    ? null
                    : group.items.map((item) => {
                        const running = item.state === 'running'
                        const actionLabel = running ? 'Stop container' : 'Start container'
                        const statusTone = containerStatusTone(item)
                        const nameClassName = ['container-name', statusTone].filter(Boolean).join(' ')
                        return (
                          <article
                            key={item.id}
                            className={item.id === selected?.id ? 'resource-list-item selected' : 'resource-list-item'}
                            onClick={() => {
                              onSelect(item.id)
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault()
                              onSelect(item.id)
                              setMenuState({ item, x: event.clientX, y: event.clientY })
                            }}
                          >
                            <div className="resource-item-main">
                              <div
                                className="resource-item-icon"
                                style={{ background: resourceIconColor(item.image || item.name) }}
                                aria-hidden="true"
                              >
                                {resourceInitials(item.name)}
                                <span className={`resource-status-dot ${containerStateClass(item.state)}`} />
                              </div>
                              <div className="resource-item-copy">
                                <div className="resource-item-head">
                                  <strong className={nameClassName}>{item.name}</strong>
                                </div>
                                <small title={item.image}>{middleEllipsis(item.image, 36)}</small>
                              </div>
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
                              <ActionIconButton
                                label="Delete container"
                                tone="ghost"
                                disabled={busy}
                                onClick={() => {
                                  onSelect(item.id)
                                  onQuickAction(item, 'delete')
                                }}
                              >
                                <TrashIcon />
                              </ActionIconButton>
                            </div>
                          </article>
                        )
                      })}
                </section>
              ))}
            </ScrollArea>
          )}
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
          {groupMenuState ? (
            <ContainerGroupContextMenu
              label={groupMenuState.label}
              x={groupMenuState.x}
              y={groupMenuState.y}
              busy={busy}
              onClose={() => setGroupMenuState(null)}
              onAction={(action) => {
                setGroupMenuState(null)
                onGroupAction(groupMenuState.items, action)
              }}
            />
          ) : null}
        </section>
      }
      detail={
        selected ? (
          <ContainerDetailPane
            item={selected}
            selectedTab={selectedTab}
            inspectData={inspectData}
            inspectLoading={inspectLoading}
            inspectError={inspectError}
            onSelectTab={onSelectTab}
          />
        ) : (
          <StatePanel title="No selection" copy="Select a container to inspect it." />
        )
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

function ContainerGroupContextMenu({
  label,
  x,
  y,
  busy,
  onClose,
  onAction,
}: {
  label: string
  x: number
  y: number
  busy: boolean
  onClose: () => void
  onAction: (action: ContainerGroupAction) => void
}) {
  const actions: Array<{ key: ContainerGroupAction; label: string; icon: ReactNode }> = [
    { key: 'start', label: 'Start all', icon: <PlayIcon /> },
    { key: 'stop', label: 'Stop all', icon: <StopIcon /> },
    { key: 'restart', label: 'Restart all', icon: <RestartIcon /> },
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
        <div className="context-menu-group-label">{label}</div>
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            className="context-menu-item"
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
  search,
  onSearchChange,
  onRefresh,
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
  search: string
  onSearchChange: (value: string) => void
  onRefresh: () => void
  onSelect: (id: string) => void
  onSelectTab: (tab: DetailTab) => void
  pullTarget: string
  onPullTargetChange: (value: string) => void
  onPull: () => void
}) {
  const selected = items.find((item) => item.id === selectedId) ?? items[0]

  return (
    <div className="resource-view">
      <section className="hero-strip">
        <div>
          <h3>Pull an image</h3>
        </div>
        <div className="pull-form">
          <input value={pullTarget} onChange={(event) => onPullTargetChange(event.target.value)} placeholder="redis:7" />
          <button type="button" className="primary" disabled={busy || !pullTarget.trim()} onClick={onPull}>
            Pull
          </button>
        </div>
      </section>

      <ResourceWorkspace
        list={
          <section className="resource-list-pane">
            <ListPaneHeader
              title="Images"
              subtitle={loading ? 'Loading…' : `${items.length} shown`}
              search={search}
              searchPlaceholder="Filter"
              onSearchChange={onSearchChange}
              onRefresh={onRefresh}
            />
            {loading ? (
              <StatePanel title="Loading images" copy="Reading the local cache and tags." />
            ) : !items.length ? (
              <StatePanel title="No images" copy="Pull or build something and it will appear here." />
            ) : (
              <ScrollArea className="resource-list-scroll-area" viewportClassName="resource-list">
                {items.map((item) => {
                  const label = item.primaryTag || '<untagged>'
                  return (
                    <article
                      key={item.id}
                      className={item.id === (selectedId || items[0]?.id) ? 'resource-list-item selected' : 'resource-list-item'}
                      onClick={() => {
                        onSelect(item.id)
                        onSelectTab('info')
                      }}
                    >
                      <div className="resource-item-main">
                        <div
                          className="resource-item-icon"
                          style={{ background: resourceIconColor(label) }}
                          aria-hidden="true"
                        >
                          {resourceInitials(label)}
                        </div>
                        <div className="resource-item-copy">
                          <div className="resource-item-head">
                            <strong>{renderImageListTag(label)}</strong>
                          </div>
                          <small>
                            {formatBytes(item.size)} · {shortenId(item.id)}
                          </small>
                        </div>
                      </div>
                    </article>
                  )
                })}
              </ScrollArea>
            )}
          </section>
        }
        detail={
          selected ? (
            <ImageDetailPane
              item={selected}
              selectedTab={selectedTab}
              inspectData={inspectData}
              inspectLoading={inspectLoading}
              inspectError={inspectError}
              onSelectTab={onSelectTab}
            />
          ) : (
            <StatePanel title="No selection" copy="Select an image to inspect it." />
          )
        }
      />
    </div>
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
  search,
  onSearchChange,
  onRefresh,
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
  search: string
  onSearchChange: (value: string) => void
  onRefresh: () => void
  onSelect: (id: string) => void
  onSelectTab: (tab: DetailTab) => void
}) {
  const selected = items.find((item) => item.name === selectedId) ?? items[0]

  return (
    <ResourceWorkspace
      list={
        <section className="resource-list-pane">
          <ListPaneHeader
            title="Volumes"
            subtitle={loading ? 'Loading…' : `${items.length} shown`}
            search={search}
            searchPlaceholder="Filter"
            onSearchChange={onSearchChange}
            onRefresh={onRefresh}
          />
          {loading ? (
            <StatePanel title="Loading volumes" copy="Checking persistent storage." />
          ) : !items.length ? (
            <StatePanel title="No volumes" copy="Create a named volume and it will show here." />
          ) : (
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
                  <div className="resource-item-main">
                    <div
                      className="resource-item-icon"
                      style={{ background: resourceIconColor(item.name) }}
                      aria-hidden="true"
                    >
                      {resourceInitials(item.name)}
                    </div>
                    <div className="resource-item-copy">
                      <div className="resource-item-head">
                        <strong>{item.name}</strong>
                      </div>
                      <small>
                        {item.driver} · {item.scope}
                      </small>
                    </div>
                  </div>
                </article>
              ))}
            </ScrollArea>
          )}
        </section>
      }
      detail={
        selected ? (
          <VolumeDetailPane
            item={selected}
            selectedTab={selectedTab}
            inspectData={inspectData}
            inspectLoading={inspectLoading}
            inspectError={inspectError}
            onSelectTab={onSelectTab}
          />
        ) : (
          <StatePanel title="No selection" copy="Select a volume to inspect it." />
        )
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
  search,
  onSearchChange,
  onRefresh,
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
  search: string
  onSearchChange: (value: string) => void
  onRefresh: () => void
  onSelect: (id: string) => void
  onSelectTab: (tab: DetailTab) => void
}) {
  const selected = items.find((item) => item.id === selectedId) ?? items[0]

  return (
    <ResourceWorkspace
      list={
        <section className="resource-list-pane">
          <ListPaneHeader
            title="Networks"
            subtitle={loading ? 'Loading…' : `${items.length} shown`}
            search={search}
            searchPlaceholder="Filter"
            onSearchChange={onSearchChange}
            onRefresh={onRefresh}
          />
          {loading ? (
            <StatePanel title="Loading networks" copy="Mapping local network bridges." />
          ) : !items.length ? (
            <StatePanel title="No networks" copy="Docker will list networks here once available." />
          ) : (
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
                  <div className="resource-item-main">
                    <div
                      className="resource-item-icon"
                      style={{ background: resourceIconColor(item.name) }}
                      aria-hidden="true"
                    >
                      {resourceInitials(item.name)}
                    </div>
                    <div className="resource-item-copy">
                      <div className="resource-item-head">
                        <strong>{item.name}</strong>
                      </div>
                      <small>
                        {item.driver} · {item.scope}
                      </small>
                    </div>
                  </div>
                </article>
              ))}
            </ScrollArea>
          )}
        </section>
      }
      detail={
        selected ? (
          <NetworkDetailPane
            item={selected}
            selectedTab={selectedTab}
            inspectData={inspectData}
            inspectLoading={inspectLoading}
            inspectError={inspectError}
            onSelectTab={onSelectTab}
          />
        ) : (
          <StatePanel title="No selection" copy="Select a network to inspect it." />
        )
      }
    />
  )
}

function ResourceWorkspace({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  const workspaceRef = useRef<HTMLElement | null>(null)
  const [listWidth, setListWidth] = useState(() => {
    if (typeof window === 'undefined') return RESOURCE_PANE_DEFAULT
    const saved = Number(window.localStorage.getItem(RESOURCE_PANE_WIDTH_KEY))
    return Number.isFinite(saved) ? clamp(saved, RESOURCE_PANE_MIN, RESOURCE_PANE_MAX) : RESOURCE_PANE_DEFAULT
  })

  useEffect(() => {
    window.localStorage.setItem(RESOURCE_PANE_WIDTH_KEY, String(listWidth))
  }, [listWidth])

  useEffect(() => {
    const handleResize = () => {
      const workspace = workspaceRef.current
      if (!workspace || window.innerWidth <= 1080) return
      const maxWidth = Math.min(RESOURCE_PANE_MAX, workspace.clientWidth - 280)
      setListWidth((current: number) => clamp(current, RESOURCE_PANE_MIN, maxWidth))
    }

    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const workspace = workspaceRef.current
    if (!workspace || window.innerWidth <= 1080) return

    event.preventDefault()
    const pointerId = event.pointerId
    const workspaceRect = workspace.getBoundingClientRect()

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const maxWidth = Math.min(RESOURCE_PANE_MAX, workspace.clientWidth - 280)
      const nextWidth = clamp(moveEvent.clientX - workspaceRect.left, RESOURCE_PANE_MIN, maxWidth)
      setListWidth(nextWidth)
    }

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }

    event.currentTarget.setPointerCapture(pointerId)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }

  return (
    <section
      ref={workspaceRef}
      className="resource-workspace"
      style={{ gridTemplateColumns: `${listWidth}px 1px minmax(0, 1fr)` }}
    >
      {list}
      <div
        className="pane-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize list pane"
        onPointerDown={startResize}
      >
        <span className="pane-resize-grip" />
      </div>
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
  const statsQuery = useQuery({
    queryKey: ['container-stats', item.id],
    queryFn: () => containerStats(item.id),
    enabled: selectedTab === 'stats',
    refetchInterval: 2_000,
  })
  const topQuery = useQuery({
    queryKey: ['container-top', item.id],
    queryFn: () => containerTop(item.id),
    enabled: selectedTab === 'top',
    refetchInterval: 4_000,
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
      <DetailTabs
        title={item.name}
        tabs={[
          { key: 'info', label: 'Info' },
          { key: 'logs', label: 'Logs' },
          { key: 'stats', label: 'Stats' },
          { key: 'top', label: 'Top' },
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
      ) : selectedTab === 'stats' ? (
        <ContainerStatsPanel key={item.id} stats={statsQuery.data} loading={statsQuery.isLoading} error={statsQuery.error} />
      ) : selectedTab === 'top' ? (
        <ContainerTopPanel top={topQuery.data} loading={topQuery.isLoading} error={topQuery.error} />
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
      <DetailTabs
        title={item.primaryTag || '<untagged>'}
        tabs={[{ key: 'info', label: 'Info' }, { key: 'inspect', label: 'Inspect' }]}
        selectedTab={normalizeBasicDetailTab(selectedTab)}
        onSelect={onSelectTab}
      />
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
      <DetailTabs
        title={item.name}
        tabs={[{ key: 'info', label: 'Info' }, { key: 'inspect', label: 'Inspect' }]}
        selectedTab={normalizeBasicDetailTab(selectedTab)}
        onSelect={onSelectTab}
      />
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
      <DetailTabs
        title={item.name}
        tabs={[{ key: 'info', label: 'Info' }, { key: 'inspect', label: 'Inspect' }]}
        selectedTab={normalizeBasicDetailTab(selectedTab)}
        onSelect={onSelectTab}
      />
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

function DetailTabs({
  tabs,
  selectedTab,
  onSelect,
  title,
}: {
  tabs: Array<{ key: DetailTab; label: string }>
  selectedTab: DetailTab
  onSelect: (tab: DetailTab) => void
  title?: string
}) {
  return (
    <div className="detail-tabs-bar">
      {title ? <span className="detail-title-chip" title={title}>{title}</span> : null}
      <div className="detail-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={tab.key === selectedTab ? 'detail-tab active' : 'detail-tab'}
            onClick={() => onSelect(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
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

function ContainerStatsPanel({ stats, loading, error }: { stats?: ContainerStats; loading: boolean; error: unknown }) {
  const [history, setHistory] = useState<StatsHistoryPoint[]>([])
  const previousNetworkRef = useRef<{ at: number; total: number } | null>(null)

  useEffect(() => {
    if (!stats?.readAt) return

    const nextAt = Date.parse(stats.readAt)
    if (Number.isNaN(nextAt)) return

    const nextNetworkTotal = stats.networkRx + stats.networkTx
    const previousNetwork = previousNetworkRef.current
    const elapsedMs = previousNetwork ? nextAt - previousNetwork.at : 0
    const networkRate = previousNetwork && elapsedMs > 0
      ? Math.max((nextNetworkTotal - previousNetwork.total) / (elapsedMs / 1000), 0)
      : null

    const nextPoint: StatsHistoryPoint = {
      at: nextAt,
      cpu: stats.cpuPercent ?? null,
      memory: stats.memoryPercent ?? null,
      networkRate,
    }

    previousNetworkRef.current = { at: nextAt, total: nextNetworkTotal }

    setHistory((current) => {
      if (current.at(-1)?.at === nextPoint.at) return current
      const cutoff = nextPoint.at - STATS_HISTORY_WINDOW_MS
      return [...current, nextPoint].filter((point) => point.at >= cutoff)
    })
  }, [stats])

  if (loading) return <StatePanel title="Loading stats" copy="Sampling current container resource usage." />
  if (error) return <StatePanel title="Stats unavailable" copy={String(error)} />
  if (!stats) return <StatePanel title="No stats returned" copy="Docker did not provide a resource snapshot for this container." />

  return (
    <ScrollArea className="detail-stack-scroll-area" viewportClassName="detail-stack">
      <StatsHistorySection history={history} />
      <KeyValueSection
        title="Resource snapshot"
        rows={[
          ['Captured', stats.readAt ? formatDateTime(stats.readAt) : '--'],
          ['CPU', formatPercent(stats.cpuPercent)],
          ['Memory', formatUsagePair(stats.memoryUsage, stats.memoryLimit)],
          ['Memory %', formatPercent(stats.memoryPercent)],
          ['PIDs', stats.pids != null ? String(stats.pids) : '--'],
        ]}
      />
      <KeyValueSection
        title="Traffic"
        rows={[
          ['Network in', formatBytes(stats.networkRx)],
          ['Network out', formatBytes(stats.networkTx)],
          ['Block read', formatBytes(stats.blockRead)],
          ['Block write', formatBytes(stats.blockWrite)],
        ]}
      />
    </ScrollArea>
  )
}

function StatsHistorySection({ history }: { history: StatsHistoryPoint[] }) {
  const latest = history.at(-1)

  return (
    <section className="detail-surface stats-history-surface">
      <div className="stats-history-head">
        <h4>Recent activity</h4>
        <span>{history.length ? 'Last 60 seconds' : 'Waiting for samples'}</span>
      </div>
      <div className="stats-sparkline-grid">
        <SparklineCard
          label="CPU"
          value={formatPercent(latest?.cpu)}
          accent="var(--spark-cpu)"
          series={history}
          getValue={(point) => point.cpu}
          formatAxisLabel={formatPercent}
          domain={[0, 100]}
        />
        <SparklineCard
          label="Memory"
          value={formatPercent(latest?.memory)}
          accent="var(--spark-memory)"
          series={history}
          getValue={(point) => point.memory}
          formatAxisLabel={formatPercent}
          domain={[0, 100]}
        />
        <SparklineCard
          label="Network"
          value={formatRate(latest?.networkRate)}
          accent="var(--spark-network)"
          series={history}
          getValue={(point) => point.networkRate}
          formatAxisLabel={formatRate}
        />
      </div>
    </section>
  )
}

function SparklineCard({
  label,
  value,
  accent,
  series,
  getValue,
  formatAxisLabel,
  domain,
}: {
  label: string
  value: string
  accent: string
  series: StatsHistoryPoint[]
  getValue: (point: StatsHistoryPoint) => number | null
  formatAxisLabel: (value?: number | null) => string
  domain?: [number, number]
}) {
  const values = series.map(getValue)
  const numericSeries = values.filter((point): point is number => point != null)
  const max = domain?.[1] ?? (numericSeries.length ? Math.max(...numericSeries) : 0)
  const min = domain?.[0] ?? 0
  const anchorAt = series.at(-1)?.at ?? Date.now()
  const { linePath, areaPath } = buildSparklinePaths(series, getValue, anchorAt, min, max)

  return (
    <article className="sparkline-card">
      <div className="sparkline-copy">
        <span className="sparkline-label">{label}</span>
        <strong>{value}</strong>
      </div>
      <div className="sparkline-chart">
        {linePath ? (
          <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
            <path className="sparkline-area" d={areaPath} style={{ color: accent }} />
            <path className="sparkline-line" d={linePath} style={{ color: accent }} />
          </svg>
        ) : (
          <div className="sparkline-empty">Waiting for data</div>
        )}
      </div>
      <div className="sparkline-axis">
        <span>{formatAxisLabel(max)}</span>
        <span>{formatAxisLabel(min)}</span>
      </div>
    </article>
  )
}

function ContainerTopPanel({ top, loading, error }: { top?: ContainerTop; loading: boolean; error: unknown }) {
  if (loading) return <StatePanel title="Loading processes" copy="Inspecting what is running inside this container." />
  if (error) return <StatePanel title="Process list unavailable" copy={String(error)} />
  if (!top) return <StatePanel title="No process data" copy="Docker did not return any process information for this container." />

  if (!top.processes.length) {
    return <StatePanel title="No running processes" copy="Docker did not report any active processes in this container." />
  }

  return (
    <SimpleTableSection
      title="Processes"
      columns={top.titles.length ? top.titles : ['Process']}
      rows={top.processes}
    />
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

function normalizeBasicDetailTab(tab: DetailTab): DetailTab {
  return tab === 'inspect' ? 'inspect' : 'info'
}

function formatPercent(value?: number | null) {
  return value == null ? '--' : `${value.toFixed(1)}%`
}

function formatUsagePair(usage?: number | null, limit?: number | null) {
  if (usage == null && limit == null) return '--'
  if (usage != null && limit != null) return `${formatBytes(usage)} / ${formatBytes(limit)}`
  if (usage != null) return formatBytes(usage)
  return formatBytes(limit ?? 0)
}

function formatRate(value?: number | null) {
  return value == null ? '--' : `${formatBytes(value)}/s`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function buildSparklinePaths(
  series: StatsHistoryPoint[],
  getValue: (point: StatsHistoryPoint) => number | null,
  anchorAt: number,
  min: number,
  max: number,
) {
  const points = series
    .map((point) => {
      const value = getValue(point)
      if (value == null) return null
      const age = anchorAt - point.at
      if (age > STATS_HISTORY_WINDOW_MS) return null
      const x = 100 - (age / STATS_HISTORY_WINDOW_MS) * 100
      const range = max - min
      const y = range === 0 ? 16 : 32 - ((value - min) / range) * 28 - 2
      return { x, y }
    })
    .filter((point): point is { x: number; y: number } => point !== null)

  if (!points.length) return { linePath: '', areaPath: '' }

  const linePath = `M ${points.map((point) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' L ')}`
  const firstPoint = points[0]
  const lastPoint = points[points.length - 1]
  const areaPath = `${linePath} L ${lastPoint.x.toFixed(2)} 32 L ${firstPoint.x.toFixed(2)} 32 Z`

  return { linePath, areaPath }
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
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon" fill="currentColor">
      <path d="M9 7.2v9.6l7.5-4.8L9 7.2Z" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon" fill="currentColor">
      <rect x="7.5" y="7.5" width="9" height="9" rx="1.2" />
    </svg>
  )
}

function RestartIcon() {
  return <IconFrame path="M18 10a6 6 0 1 0 1.2 3.6M18 10V6m0 4h-4" />
}

function TrashIcon() {
  return <IconFrame path="M6 7h12M9 7V5h6v2m-7 3v7m4-7v7m4-7v7M8 7l1 12h6l1-12" />
}

function ChevronIcon() {
  return <IconFrame path="m8 10 4 4 4-4" />
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

function RefreshIcon() {
  return <IconFrame path="M4 12a8 8 0 0 1 13.7-5.6M20 12a8 8 0 0 1-13.7 5.6M17 4v4h-4M7 20v-4h4" />
}

function SearchIcon() {
  return (
    <svg className="list-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  )
}

function ProjectIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Z" />
      <path d="M12 12 4 8.5M12 12l8-3.5M12 12v8" />
    </svg>
  )
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

function groupContainersByProject(items: ContainerSummary[]) {
  const groups = new Map<string, { key: string; label: string; items: ContainerSummary[] }>()

  for (const item of items) {
    const project = item.composeProject?.trim()
    const key = project ? `compose:${project}` : 'standalone'
    const label = project || 'Standalone'
    const existing = groups.get(key)

    if (existing) {
      existing.items.push(item)
      continue
    }

    groups.set(key, { key, label, items: [item] })
  }

  return [...groups.values()].sort((left, right) => {
    if (left.key === 'standalone') return 1
    if (right.key === 'standalone') return -1
    return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
  })
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

function middleEllipsis(value: string, maxLength: number) {
  if (value.length <= maxLength) return value
  const visible = maxLength - 3
  const start = Math.ceil(visible / 2)
  const end = Math.floor(visible / 2)
  return `${value.slice(0, start)}...${value.slice(value.length - end)}`
}

function renderImageListTag(tag: string) {
  const separatorIndex = tag.lastIndexOf(':')
  const slashIndex = tag.lastIndexOf('/')

  if (separatorIndex <= slashIndex || separatorIndex === -1) {
    return tag
  }

  return (
    <>
      <span className="image-tag-name">{tag.slice(0, separatorIndex)}</span>
      <span className="image-tag-separator">:</span>
      <span className="image-tag-version">{tag.slice(separatorIndex + 1)}</span>
    </>
  )
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
