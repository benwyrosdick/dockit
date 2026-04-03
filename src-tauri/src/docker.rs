use bollard::errors::Error as BollardError;
use bollard::models::{
    ContainerStatsResponse, ContainerSummary as DockerContainerSummary,
    ImageSummary as DockerImageSummary, SystemVersion,
};
use bollard::query_parameters::{
    CreateImageOptionsBuilder, InspectContainerOptionsBuilder, InspectNetworkOptionsBuilder,
    ListContainersOptionsBuilder, ListImagesOptionsBuilder, ListNetworksOptionsBuilder,
    ListVolumesOptionsBuilder, LogsOptionsBuilder, RemoveContainerOptionsBuilder, RemoveImageOptionsBuilder,
    RemoveVolumeOptionsBuilder, RestartContainerOptionsBuilder, StartContainerOptions,
    StatsOptionsBuilder, StopContainerOptionsBuilder, TopOptionsBuilder,
};
use bollard::Docker;
use futures_util::{StreamExt, TryStreamExt};
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DockitError {
    #[error("Docker daemon is unavailable: {0}")]
    Docker(#[from] BollardError),
    #[error("Serialization failed: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("{0}")]
    Message(String),
}

pub type DockitResult<T> = Result<T, DockitError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStatus {
    pub connected: bool,
    pub server_version: Option<String>,
    pub api_version: Option<String>,
    pub os_type: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSummary {
    pub id: String,
    pub name: String,
    pub image: String,
    pub compose_project: Option<String>,
    pub compose_service: Option<String>,
    pub state: String,
    pub status: String,
    pub created: i64,
    pub ports: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSummary {
    pub id: String,
    pub tags: Vec<String>,
    pub primary_tag: String,
    pub size: i64,
    pub created: i64,
    pub containers: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeSummary {
    pub name: String,
    pub driver: String,
    pub mountpoint: Option<String>,
    pub scope: String,
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSummary {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
    pub internal: bool,
    pub attachable: bool,
    pub created: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStatsSummary {
    pub read_at: Option<String>,
    pub cpu_percent: Option<f64>,
    pub memory_usage: Option<u64>,
    pub memory_limit: Option<u64>,
    pub memory_percent: Option<f64>,
    pub network_rx: u64,
    pub network_tx: u64,
    pub block_read: u64,
    pub block_write: u64,
    pub pids: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerTopSummary {
    pub titles: Vec<String>,
    pub processes: Vec<Vec<String>>,
}

fn docker() -> DockitResult<Docker> {
    Ok(Docker::connect_with_socket_defaults()?)
}

pub async fn docker_status() -> DockerStatus {
    match docker().and_then(|client| Ok(client)) {
        Ok(client) => match client.version().await {
            Ok(version) => status_from_version(version),
            Err(error) => DockerStatus {
                connected: false,
                server_version: None,
                api_version: None,
                os_type: None,
                error: Some(error.to_string()),
            },
        },
        Err(error) => DockerStatus {
            connected: false,
            server_version: None,
            api_version: None,
            os_type: None,
            error: Some(error.to_string()),
        },
    }
}

pub async fn list_containers() -> DockitResult<Vec<ContainerSummary>> {
    let client = docker()?;
    let containers = client
        .list_containers(Some(ListContainersOptionsBuilder::new().all(true).build()))
        .await?;

    Ok(containers.into_iter().map(map_container).collect())
}

pub async fn start_container(id: &str) -> DockitResult<()> {
    docker()?
        .start_container(id, None::<StartContainerOptions>)
        .await?;
    Ok(())
}

pub async fn stop_container(id: &str) -> DockitResult<()> {
    docker()?
        .stop_container(id, Some(StopContainerOptionsBuilder::new().t(10).build()))
        .await?;
    Ok(())
}

pub async fn restart_container(id: &str) -> DockitResult<()> {
    docker()?
        .restart_container(id, Some(RestartContainerOptionsBuilder::new().t(10).build()))
        .await?;
    Ok(())
}

pub async fn remove_container(id: &str) -> DockitResult<()> {
    docker()?
        .remove_container(
            id,
            Some(
                RemoveContainerOptionsBuilder::new()
                    .v(true)
                    .force(true)
                    .link(false)
                    .build(),
            ),
        )
        .await?;
    Ok(())
}

pub async fn container_logs(id: &str, tail: usize) -> DockitResult<String> {
    let mut stream = docker()?.logs(
        id,
        Some(
            LogsOptionsBuilder::new()
                .follow(false)
                .stdout(true)
                .stderr(true)
                .timestamps(true)
                .tail(&tail.to_string())
                .build(),
        ),
    );

    let mut output = String::new();
    while let Some(chunk) = stream.try_next().await? {
        output.push_str(&String::from_utf8_lossy(&chunk.into_bytes()));
    }

    Ok(output)
}

pub fn container_log_stream(
    id: String,
    tail: usize,
) -> DockitResult<impl futures_util::Stream<Item = Result<String, DockitError>>> {
    let stream = docker()?.logs(
        &id,
        Some(
            LogsOptionsBuilder::new()
                .follow(true)
                .stdout(true)
                .stderr(true)
                .timestamps(true)
                .tail(&tail.to_string())
                .build(),
        ),
    );

    Ok(stream
        .map_err(DockitError::from)
        .map_ok(|chunk| String::from_utf8_lossy(&chunk.into_bytes()).into_owned()))
}

pub async fn inspect_container(id: &str) -> DockitResult<Value> {
    Ok(serde_json::to_value(
        docker()?
            .inspect_container(id, Some(InspectContainerOptionsBuilder::new().build()))
            .await?,
    )?)
}

pub async fn container_stats(id: &str) -> DockitResult<ContainerStatsSummary> {
    let mut stream = docker()?.stats(
        id,
        Some(
            StatsOptionsBuilder::new()
                .stream(false)
                .one_shot(true)
                .build(),
        ),
    );

    match stream.next().await.transpose()? {
        Some(stats) => Ok(map_container_stats(stats)),
        None => Err(DockitError::Message(
            "Docker returned no stats for this container".into(),
        )),
    }
}

pub async fn container_top(id: &str) -> DockitResult<ContainerTopSummary> {
    let top = docker()?
        .top_processes(
            id,
            Some(TopOptionsBuilder::new().ps_args("aux").build()),
        )
        .await?;

    Ok(ContainerTopSummary {
        titles: top.titles.unwrap_or_default(),
        processes: top.processes.unwrap_or_default(),
    })
}

pub async fn list_images() -> DockitResult<Vec<ImageSummary>> {
    let images = docker()?
        .list_images(Some(ListImagesOptionsBuilder::new().all(true).build()))
        .await?;

    Ok(images.into_iter().map(map_image).collect())
}

pub async fn remove_image(id: &str) -> DockitResult<()> {
    docker()?
        .remove_image(
            id,
            Some(RemoveImageOptionsBuilder::new().force(true).noprune(false).build()),
            None,
        )
        .await?;
    Ok(())
}

pub async fn inspect_image(id: &str) -> DockitResult<Value> {
    Ok(serde_json::to_value(docker()?.inspect_image(id).await?)?)
}

pub async fn pull_image(image: &str) -> DockitResult<()> {
    let mut stream = docker()?.create_image(
        Some(CreateImageOptionsBuilder::new().from_image(image).build()),
        None,
        None,
    );

    while stream.try_next().await?.is_some() {}

    Ok(())
}

pub async fn list_volumes() -> DockitResult<Vec<VolumeSummary>> {
    let response = docker()?
        .list_volumes(Some(ListVolumesOptionsBuilder::default().build()))
        .await?;

    let volumes = response.volumes.unwrap_or_default();
    Ok(volumes
        .into_iter()
        .map(|volume| VolumeSummary {
            name: volume.name,
            driver: volume.driver,
            mountpoint: Some(volume.mountpoint),
            scope: volume
                .scope
                .map(|scope| scope.to_string())
                .unwrap_or_else(|| "local".into()),
            created_at: volume.created_at.map(|created| created.to_string()),
        })
        .collect())
}

pub async fn remove_volume(name: &str) -> DockitResult<()> {
    docker()?
        .remove_volume(
            name,
            Some(RemoveVolumeOptionsBuilder::default().force(true).build()),
        )
        .await?;
    Ok(())
}

pub async fn inspect_volume(name: &str) -> DockitResult<Value> {
    Ok(serde_json::to_value(docker()?.inspect_volume(name).await?)?)
}

pub async fn list_networks() -> DockitResult<Vec<NetworkSummary>> {
    let networks = docker()?
        .list_networks(Some(ListNetworksOptionsBuilder::new().build()))
        .await?;
    Ok(networks
        .into_iter()
        .map(|network| NetworkSummary {
            id: network.id.unwrap_or_default(),
            name: network.name.unwrap_or_default(),
            driver: network.driver.unwrap_or_else(|| "bridge".into()),
            scope: network.scope.unwrap_or_else(|| "local".into()),
            internal: network.internal.unwrap_or(false),
            attachable: network.attachable.unwrap_or(false),
            created: network.created.map(|created| created.to_string()),
        })
        .collect())
}

pub async fn remove_network(id: &str) -> DockitResult<()> {
    docker()?.remove_network(id).await?;
    Ok(())
}

pub async fn inspect_network(id: &str) -> DockitResult<Value> {
    Ok(serde_json::to_value(
        docker()?
            .inspect_network(
                id,
                Some(
                    InspectNetworkOptionsBuilder::new()
                        .verbose(true)
                        .scope("local")
                        .build(),
                ),
            )
            .await?,
    )?)
}

fn status_from_version(version: SystemVersion) -> DockerStatus {
    DockerStatus {
        connected: true,
        server_version: version.version,
        api_version: version.api_version,
        os_type: version.os,
        error: None,
    }
}

fn map_container(container: DockerContainerSummary) -> ContainerSummary {
    let labels = container.labels.unwrap_or_default();

    ContainerSummary {
        id: container.id.unwrap_or_default(),
        name: container
            .names
            .unwrap_or_default()
            .first()
            .cloned()
            .unwrap_or_default()
            .trim_start_matches('/')
            .to_string(),
        image: container.image.unwrap_or_default(),
        compose_project: labels.get("com.docker.compose.project").cloned(),
        compose_service: labels.get("com.docker.compose.service").cloned(),
        state: container
            .state
            .map(|state| state.to_string())
            .unwrap_or_else(|| "unknown".into()),
        status: container.status.unwrap_or_default(),
        created: container.created.unwrap_or_default(),
        ports: container
            .ports
            .unwrap_or_default()
            .into_iter()
            .map(|port| match (port.public_port, port.private_port, port.typ) {
                (Some(public_port), private_port, Some(kind)) => {
                    format!("{}:{} / {}", public_port, private_port, kind)
                }
                (None, private_port, Some(kind)) => format!("{} / {}", private_port, kind),
                _ => "port mapping".into(),
            })
            .collect(),
    }
}

fn map_image(image: DockerImageSummary) -> ImageSummary {
    let tags = image.repo_tags;
    let primary_tag = tags.first().cloned().unwrap_or_default();

    ImageSummary {
        id: image.id,
        tags,
        primary_tag,
        size: image.size,
        created: image.created,
        containers: image.containers,
    }
}

fn map_container_stats(stats: ContainerStatsResponse) -> ContainerStatsSummary {
    let cpu_delta = stats
        .cpu_stats
        .as_ref()
        .and_then(|cpu| cpu.cpu_usage.as_ref())
        .and_then(|usage| usage.total_usage)
        .unwrap_or(0)
        .saturating_sub(
            stats
                .precpu_stats
                .as_ref()
                .and_then(|cpu| cpu.cpu_usage.as_ref())
                .and_then(|usage| usage.total_usage)
                .unwrap_or(0),
        );

    let system_delta = stats
        .cpu_stats
        .as_ref()
        .and_then(|cpu| cpu.system_cpu_usage)
        .unwrap_or(0)
        .saturating_sub(
            stats
                .precpu_stats
                .as_ref()
                .and_then(|cpu| cpu.system_cpu_usage)
                .unwrap_or(0),
        );

    let cpu_count = stats
        .cpu_stats
        .as_ref()
        .and_then(|cpu| cpu.online_cpus)
        .map(u64::from)
        .or_else(|| {
            stats
                .cpu_stats
                .as_ref()
                .and_then(|cpu| cpu.cpu_usage.as_ref())
                .and_then(|usage| usage.percpu_usage.as_ref())
                .map(|cores| cores.len() as u64)
        })
        .unwrap_or(1);

    let cpu_percent = if cpu_delta > 0 && system_delta > 0 {
        Some((cpu_delta as f64 / system_delta as f64) * cpu_count as f64 * 100.0)
    } else {
        None
    };

    let memory_usage = stats.memory_stats.as_ref().and_then(|memory| memory.usage);
    let memory_limit = stats.memory_stats.as_ref().and_then(|memory| memory.limit);
    let memory_percent = match (memory_usage, memory_limit) {
        (Some(usage), Some(limit)) if limit > 0 => Some((usage as f64 / limit as f64) * 100.0),
        _ => None,
    };

    let (network_rx, network_tx) = stats
        .networks
        .as_ref()
        .map(|networks| {
            networks.values().fold((0_u64, 0_u64), |(rx, tx), network| {
                (
                    rx + network.rx_bytes.unwrap_or(0),
                    tx + network.tx_bytes.unwrap_or(0),
                )
            })
        })
        .unwrap_or((0, 0));

    let block_entries = stats
        .blkio_stats
        .as_ref()
        .and_then(|blkio| blkio.io_service_bytes_recursive.as_ref());

    ContainerStatsSummary {
        read_at: stats.read.map(|read| read.to_string()),
        cpu_percent,
        memory_usage,
        memory_limit,
        memory_percent,
        network_rx,
        network_tx,
        block_read: sum_blkio_bytes(block_entries, "read"),
        block_write: sum_blkio_bytes(block_entries, "write"),
        pids: stats.pids_stats.and_then(|pids| pids.current),
    }
}

fn sum_blkio_bytes(
    entries: Option<&Vec<bollard::models::ContainerBlkioStatEntry>>,
    op: &str,
) -> u64 {
    entries
        .map(|entries| {
            entries
                .iter()
                .filter(|entry| {
                    entry
                        .op
                        .as_deref()
                        .map(|candidate| candidate.eq_ignore_ascii_case(op))
                        .unwrap_or(false)
                })
                .map(|entry| entry.value.unwrap_or(0))
                .sum()
        })
        .unwrap_or(0)
}
