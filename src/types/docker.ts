export type DockerStatus = {
  connected: boolean
  serverVersion?: string | null
  apiVersion?: string | null
  osType?: string | null
  error?: string | null
}

export type ContainerSummary = {
  id: string
  name: string
  image: string
  state: string
  status: string
  created: number
  ports: string[]
}

export type ImageSummary = {
  id: string
  tags: string[]
  primaryTag: string
  size: number
  created: number
  containers: number
}

export type VolumeSummary = {
  name: string
  driver: string
  mountpoint?: string | null
  scope: string
  createdAt?: string | null
}

export type NetworkSummary = {
  id: string
  name: string
  driver: string
  scope: string
  internal: boolean
  attachable: boolean
  created?: string | null
}

export type InspectPayload = Record<string, unknown>
