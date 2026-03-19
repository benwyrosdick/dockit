mod docker;

use docker as docker_api;
use futures_util::TryStreamExt;
use serde::Serialize;
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct LogStreamState {
    streams: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogStreamChunkPayload {
    stream_id: String,
    chunk: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogStreamErrorPayload {
    stream_id: String,
    message: String,
}

#[cfg(target_os = "linux")]
fn configure_linux_graphics_workarounds() {
    let is_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || matches!(std::env::var("XDG_SESSION_TYPE").as_deref(), Ok("wayland"));
    let has_nvidia = std::path::Path::new("/sys/module/nvidia").exists()
        || std::path::Path::new("/proc/driver/nvidia/version").exists();

    if is_wayland && has_nvidia {
        unsafe {
            if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_graphics_workarounds() {}

#[tauri::command]
async fn docker_status() -> docker_api::DockerStatus {
    docker_api::docker_status().await
}

#[tauri::command]
async fn list_containers() -> Result<Vec<docker_api::ContainerSummary>, String> {
    docker_api::list_containers().await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn start_container(id: String) -> Result<(), String> {
    docker_api::start_container(&id).await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn stop_container(id: String) -> Result<(), String> {
    docker_api::stop_container(&id).await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn restart_container(id: String) -> Result<(), String> {
    docker_api::restart_container(&id).await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn remove_container(id: String) -> Result<(), String> {
    docker_api::remove_container(&id).await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn container_logs(id: String, tail: usize) -> Result<String, String> {
    docker_api::container_logs(&id, tail)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn start_container_log_stream(
    app: AppHandle,
    logs: State<'_, LogStreamState>,
    id: String,
    stream_id: String,
    tail: usize,
) -> Result<(), String> {
    stop_stream_handle(&logs, &stream_id)?;

    let mut stream = docker_api::container_log_stream(id, tail).map_err(|error| error.to_string())?;
    let app_handle = app.clone();
    let event_stream_id = stream_id.clone();

    let task = tokio::spawn(async move {
        loop {
            match stream.try_next().await {
                Ok(Some(chunk)) => {
                    let _ = app_handle.emit(
                        "container-log-chunk",
                        LogStreamChunkPayload {
                            stream_id: event_stream_id.clone(),
                            chunk,
                        },
                    );
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = app_handle.emit(
                        "container-log-error",
                        LogStreamErrorPayload {
                            stream_id: event_stream_id.clone(),
                            message: error.to_string(),
                        },
                    );
                    break;
                }
            }
        }
    });

    logs.streams
        .lock()
        .map_err(|_| "Failed to lock log stream state".to_string())?
        .insert(stream_id, task);

    Ok(())
}

#[tauri::command]
fn stop_container_log_stream(
    logs: State<'_, LogStreamState>,
    stream_id: String,
) -> Result<(), String> {
    stop_stream_handle(&logs, &stream_id)
}

#[tauri::command]
async fn inspect_container(id: String) -> Result<serde_json::Value, String> {
    docker_api::inspect_container(&id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_images() -> Result<Vec<docker_api::ImageSummary>, String> {
    docker_api::list_images().await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn remove_image(id: String) -> Result<(), String> {
    docker_api::remove_image(&id).await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn inspect_image(id: String) -> Result<serde_json::Value, String> {
    docker_api::inspect_image(&id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn pull_image(image: String) -> Result<(), String> {
    docker_api::pull_image(&image)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_volumes() -> Result<Vec<docker_api::VolumeSummary>, String> {
    docker_api::list_volumes().await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn remove_volume(name: String) -> Result<(), String> {
    docker_api::remove_volume(&name)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn inspect_volume(name: String) -> Result<serde_json::Value, String> {
    docker_api::inspect_volume(&name)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_networks() -> Result<Vec<docker_api::NetworkSummary>, String> {
    docker_api::list_networks().await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn remove_network(id: String) -> Result<(), String> {
    docker_api::remove_network(&id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn inspect_network(id: String) -> Result<serde_json::Value, String> {
    docker_api::inspect_network(&id)
        .await
        .map_err(|error| error.to_string())
}

fn main() {
    configure_linux_graphics_workarounds();

    tauri::Builder::default()
        .manage(LogStreamState::default())
        .invoke_handler(tauri::generate_handler![
            docker_status,
            list_containers,
            start_container,
            stop_container,
            restart_container,
            remove_container,
            container_logs,
            start_container_log_stream,
            stop_container_log_stream,
            inspect_container,
            list_images,
            remove_image,
            inspect_image,
            pull_image,
            list_volumes,
            remove_volume,
            inspect_volume,
            list_networks,
            remove_network,
            inspect_network,
        ])
        .run(tauri::generate_context!())
        .expect("error while running dockit")
}

fn stop_stream_handle(logs: &State<'_, LogStreamState>, stream_id: &str) -> Result<(), String> {
    let mut guard = logs
        .streams
        .lock()
        .map_err(|_| "Failed to lock log stream state".to_string())?;

    if let Some(handle) = guard.remove(stream_id) {
        handle.abort();
    }

    Ok(())
}
