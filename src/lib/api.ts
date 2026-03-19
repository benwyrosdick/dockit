import { invoke } from '@tauri-apps/api/core'
import type {
  ContainerSummary,
  DockerStatus,
  ImageSummary,
  InspectPayload,
  NetworkSummary,
  VolumeSummary,
} from '../types/docker'

export function dockerStatus() {
  return invoke<DockerStatus>('docker_status')
}

export function listContainers() {
  return invoke<ContainerSummary[]>('list_containers')
}

export function startContainer(id: string) {
  return invoke<void>('start_container', { id })
}

export function stopContainer(id: string) {
  return invoke<void>('stop_container', { id })
}

export function restartContainer(id: string) {
  return invoke<void>('restart_container', { id })
}

export function removeContainer(id: string) {
  return invoke<void>('remove_container', { id })
}

export function containerLogs(id: string) {
  return invoke<string>('container_logs', { id, tail: 400 })
}

export function startContainerLogStream(id: string, streamId: string) {
  return invoke<void>('start_container_log_stream', { id, streamId, tail: 0 })
}

export function stopContainerLogStream(streamId: string) {
  return invoke<void>('stop_container_log_stream', { streamId })
}

export function inspectContainer(id: string) {
  return invoke<InspectPayload>('inspect_container', { id })
}

export function listImages() {
  return invoke<ImageSummary[]>('list_images')
}

export function removeImage(id: string) {
  return invoke<void>('remove_image', { id })
}

export function inspectImage(id: string) {
  return invoke<InspectPayload>('inspect_image', { id })
}

export function pullImage(image: string) {
  return invoke<void>('pull_image', { image })
}

export function listVolumes() {
  return invoke<VolumeSummary[]>('list_volumes')
}

export function removeVolume(name: string) {
  return invoke<void>('remove_volume', { name })
}

export function inspectVolume(name: string) {
  return invoke<InspectPayload>('inspect_volume', { name })
}

export function listNetworks() {
  return invoke<NetworkSummary[]>('list_networks')
}

export function removeNetwork(id: string) {
  return invoke<void>('remove_network', { id })
}

export function inspectNetwork(id: string) {
  return invoke<InspectPayload>('inspect_network', { id })
}
