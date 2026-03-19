use bollard::container::{
    ListContainersOptions, LogsOptions, RemoveContainerOptions, RestartContainerOptions,
    StartContainerOptions, StopContainerOptions,
};
use bollard::errors::Error as BollardError;
use bollard::image::{CreateImageOptions, ListImagesOptions, RemoveImageOptions};
use bollard::models::{
    ContainerSummary as DockerContainerSummary, ImageSummary as DockerImageSummary, SystemVersion,
};
use bollard::network::InspectNetworkOptions;
use bollard::query_parameters::{
    InspectContainerOptionsBuilder, ListNetworksOptionsBuilder, ListVolumesOptionsBuilder,
    RemoveVolumeOptionsBuilder,
};
use bollard::Docker;
use futures_util::TryStreamExt;
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DockitError {
    #[error("Docker daemon is unavailable: {0}")]
    Docker(#[from] BollardError),
    #[error("Serialization failed: {0}")]
    Serialize(#[from] serde_json::Error),
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
        .list_containers(Some(ListContainersOptions::<String> {
            all: true,
            ..Default::default()
        }))
        .await?;

    Ok(containers.into_iter().map(map_container).collect())
}

pub async fn start_container(id: &str) -> DockitResult<()> {
    docker()?
        .start_container(id, None::<StartContainerOptions<String>>)
        .await?;
    Ok(())
}

pub async fn stop_container(id: &str) -> DockitResult<()> {
    docker()?
        .stop_container(id, Some(StopContainerOptions { t: 10 }))
        .await?;
    Ok(())
}

pub async fn restart_container(id: &str) -> DockitResult<()> {
    docker()?
        .restart_container(id, Some(RestartContainerOptions { t: 10 }))
        .await?;
    Ok(())
}

pub async fn remove_container(id: &str) -> DockitResult<()> {
    docker()?
        .remove_container(
            id,
            Some(RemoveContainerOptions {
                v: true,
                force: true,
                link: false,
            }),
        )
        .await?;
    Ok(())
}

pub async fn container_logs(id: &str, tail: usize) -> DockitResult<String> {
    let mut stream = docker()?.logs(
        id,
        Some(LogsOptions::<String> {
            follow: false,
            stdout: true,
            stderr: true,
            timestamps: true,
            tail: tail.to_string(),
            ..Default::default()
        }),
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
        Some(LogsOptions::<String> {
            follow: true,
            stdout: true,
            stderr: true,
            timestamps: true,
            tail: tail.to_string(),
            ..Default::default()
        }),
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

pub async fn list_images() -> DockitResult<Vec<ImageSummary>> {
    let images = docker()?
        .list_images(Some(ListImagesOptions::<String> {
            all: true,
            ..Default::default()
        }))
        .await?;

    Ok(images.into_iter().map(map_image).collect())
}

pub async fn remove_image(id: &str) -> DockitResult<()> {
    docker()?
        .remove_image(
            id,
            Some(RemoveImageOptions {
                force: true,
                noprune: false,
            }),
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
        Some(CreateImageOptions {
            from_image: image,
            ..Default::default()
        }),
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
            .inspect_network(id, Some(InspectNetworkOptions { verbose: true, scope: "local" }))
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
