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
  startContainerLogStream,
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
                  setSelectedResourceId('')
                  setDetailTab('info')
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
            items={filteredData.containers}
            loading={containersQuery.isLoading}
            selectedId={effectiveSelectedId}
            selectedTab={detailTab}
            inspectData={detailQuery.data}
            inspectLoading={detailQuery.isLoading}
            inspectError={detailQuery.error}
            onSelect={setSelectedResourceId}
            onSelectTab={setDetailTab}
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
  selectedId,
  selectedTab,
  inspectData,
  inspectLoading,
  inspectError,
  onSelect,
  onSelectTab,
}: {
  items: ContainerSummary[]
  loading: boolean
  selectedId: string
  selectedTab: DetailTab
  inspectData?: InspectPayload
  inspectLoading: boolean
  inspectError: unknown
  onSelect: (id: string) => void
  onSelectTab: (tab: DetailTab) => void
}) {
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
          <div className="resource-list">
            {items.map((item) => {
              const running = item.state === 'running'
              return (
                <article
                  key={item.id}
                  className={item.id === selected.id ? 'resource-list-item selected' : 'resource-list-item'}
                  onClick={() => {
                    onSelect(item.id)
                    onSelectTab('info')
                  }}
                >
                  <div className="resource-item-copy">
                    <div className="resource-item-head">
                      <strong>{item.name}</strong>
                      <span className={running ? 'pill success' : 'pill muted'}>{item.state}</span>
                    </div>
                    <small>{item.image}</small>
                    <span className="resource-meta-line">{item.status}</span>
                    <span className="resource-meta-line">{item.ports.length ? item.ports.join(', ') : 'No published ports'}</span>
                  </div>
                </article>
              )
            })}
          </div>
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
              <div className="resource-list">
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
              </div>
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
          <div className="resource-list">
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
          </div>
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
          <div className="resource-list">
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
          </div>
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
            <LiveLogViewer containerId={item.id} initialBody={logsQuery.data || 'No log output returned for this container.'} />
          </section>
        )
      ) : selectedTab === 'inspect' ? (
        <InspectPanel data={inspectData} loading={inspectLoading} error={inspectError} />
      ) : (
        <div className="detail-stack">
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
          {state.Health ? (
            <KeyValueSection
              title="Health"
              rows={[
                ['Status', readString(asRecord(state.Health).Status)],
                ['Failing streak', String(asRecord(state.Health).FailingStreak ?? '--')],
              ]}
            />
          ) : null}
        </div>
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
  const repoDigests = readStringArray(inspect.RepoDigests)

  return (
    <>
      <DetailHeader title={item.primaryTag || '<untagged>'} subtitle={shortenId(item.id)} />
      <DetailTabs tabs={[{ key: 'info', label: 'Info' }, { key: 'inspect', label: 'Inspect' }]} selectedTab={selectedTab === 'logs' ? 'info' : selectedTab} onSelect={onSelectTab} />
      {selectedTab === 'inspect' ? (
        <InspectPanel data={inspectData} loading={inspectLoading} error={inspectError} />
      ) : (
        <div className="detail-stack">
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
          <SimpleTableSection title="Labels" columns={['Key', 'Value']} rows={labels.length ? labels : [['No labels', '']]} />
        </div>
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
        <div className="detail-stack">
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
        </div>
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
        <div className="detail-stack">
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
        </div>
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
      <div className="detail-table-wrap">
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
      </div>
    </section>
  )
}

function InspectPanel({ data, loading, error }: { data?: InspectPayload; loading: boolean; error: unknown }) {
  if (loading) return <StatePanel title="Loading inspect data" copy="Reading the full resource payload." />
  if (error) return <StatePanel title="Inspect failed" copy={String(error)} />

  return (
    <section className="detail-surface inspect-surface">
      <pre>{JSON.stringify(data ?? {}, null, 2)}</pre>
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
    <section className="live-log-viewer">
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
    </section>
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
