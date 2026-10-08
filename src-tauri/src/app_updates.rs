//! Signed application updates. The webview supplies no URLs, keys, or installer bytes.

use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_store::StoreExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

#[derive(Default)]
struct PendingUpdate {
    update: Option<Update>,
    verified_bytes: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct AppUpdateState(Mutex<PendingUpdate>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    version: String,
    notes: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheck {
    supported: bool,
    installation: Option<&'static str>,
    update: Option<AppUpdateInfo>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

fn require_main_window(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("Application updates are available only from the main window.".into())
    }
}

fn installation() -> Option<&'static str> {
    use tauri::utils::{config::BundleType, platform::bundle_type};
    if cfg!(debug_assertions) {
        return None;
    }
    match bundle_type() {
        Some(BundleType::AppImage) => Some("appimage"),
        Some(BundleType::Deb) => Some("deb"),
        Some(BundleType::Msi) => Some("msi"),
        Some(BundleType::Nsis) => Some("nsis"),
        _ => None,
    }
}

fn require_installed_app() -> Result<(), String> {
    installation()
        .map(|_| ())
        .ok_or_else(|| "Install an official release to use application updates.".into())
}

fn require_version(actual: Option<&str>, requested: &str) -> Result<(), String> {
    if actual == Some(requested) {
        Ok(())
    } else {
        Err("The available update changed. Check for updates again.".into())
    }
}

#[tauri::command]
pub async fn check_app_update(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<AppUpdateCheck, String> {
    require_main_window(window.label())?;
    let installation = installation();
    let mut pending = state
        .0
        .try_lock()
        .map_err(|_| "An update is already in progress.")?;
    if installation.is_none() {
        return Ok(AppUpdateCheck {
            supported: false,
            installation,
            update: None,
        });
    }
    let mut update = app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))?;
    if let Some(update) = update.as_mut() {
        update.timeout = Some(Duration::from_secs(15 * 60));
    }
    let info = update.as_ref().map(|update| AppUpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
    });
    pending.update = update;
    pending.verified_bytes = None;
    Ok(AppUpdateCheck {
        supported: true,
        installation,
        update: info,
    })
}

#[tauri::command]
pub async fn download_app_update(
    window: WebviewWindow,
    state: State<'_, AppUpdateState>,
    version: String,
    on_progress: Channel<AppUpdateProgress>,
) -> Result<(), String> {
    require_main_window(window.label())?;
    require_installed_app()?;
    let mut pending = state
        .0
        .try_lock()
        .map_err(|_| "An update is already in progress.")?;
    require_version(
        pending
            .update
            .as_ref()
            .map(|update| update.version.as_str()),
        &version,
    )?;
    pending.verified_bytes = None;
    let update = pending.update.as_ref().unwrap();
    let mut downloaded = 0u64;
    let mut last_progress = Instant::now() - Duration::from_secs(1);
    let bytes = update
        .download(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                if last_progress.elapsed() >= Duration::from_millis(100)
                    || total == Some(downloaded)
                {
                    let _ = on_progress.send(AppUpdateProgress { downloaded, total });
                    last_progress = Instant::now();
                }
            },
            || {},
        )
        .await
        .map_err(|error| format!("Could not download or verify the update: {error}"))?;
    // Tauri verifies both the artifact signature and its signed release version.
    pending.verified_bytes = Some(bytes);
    Ok(())
}

#[tauri::command]
pub async fn install_app_update(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppUpdateState>,
    version: String,
) -> Result<(), String> {
    require_main_window(window.label())?;
    require_installed_app()?;
    app.state::<crate::quiz_runtime::QuizRuntimeState>()
        .ensure_idle_for_update()?;
    let mut pending = state
        .0
        .try_lock()
        .map_err(|_| "An update is already in progress.")?;
    require_version(
        pending
            .update
            .as_ref()
            .map(|update| update.version.as_str()),
        &version,
    )?;
    let update = pending.update.as_ref().unwrap().clone();
    // Persist the settings store before Windows exits or Linux restarts the process.
    app.store("okf-review.json")
        .and_then(|store| store.save())
        .map_err(|error| format!("Could not save preferences before updating: {error}"))?;
    let bytes = pending
        .verified_bytes
        .take()
        .ok_or("Download and verify the update before installing it.")?;
    // Linux package installation may wait for a system authentication dialog.
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("Could not install the update: {error}"))?;
    #[cfg(not(windows))]
    app.restart();
    #[cfg(windows)]
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_main_window_can_update_the_app() {
        assert!(require_main_window("main").is_ok());
        assert!(require_main_window("pop-1").is_err());
        assert!(require_main_window("").is_err());
    }

    #[test]
    fn installation_requires_the_exact_checked_version() {
        assert!(require_version(Some("1.2.3"), "1.2.3").is_ok());
        assert!(require_version(Some("1.2.3"), "9.9.9").is_err());
        assert!(require_version(None, "1.2.3").is_err());
    }

    #[test]
    fn native_updater_downloads_a_signed_new_release_and_rejects_tampering() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let payload = include_bytes!("../../scripts/fixtures/updater/payload.txt");
        let signature = include_str!("../../scripts/fixtures/updater/payload.txt.sig").trim();
        let public_key = include_str!("../../scripts/fixtures/updater/public.key.pub").trim();
        for (version, bytes, valid) in [
            ("1.2.3", payload.as_slice(), true),
            ("9.9.9", payload.as_slice(), false),
            ("1.2.3", b"tampered artifact".as_slice(), false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let manifest = serde_json::json!({
                "version": version, "url": format!("{base}/package"), "signature": signature,
            })
            .to_string();
            let responses = [manifest.into_bytes(), bytes.to_vec()];
            let server = std::thread::spawn(move || {
                for body in responses {
                    let deadline = Instant::now() + Duration::from_secs(10);
                    let mut stream = loop {
                        match listener.accept() {
                            Ok((stream, _)) => break stream,
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                assert!(Instant::now() < deadline, "updater request timed out");
                                std::thread::sleep(Duration::from_millis(10));
                            }
                            Err(error) => panic!("{error}"),
                        }
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut request = [0u8; 8192];
                    let _ = stream.read(&mut request).unwrap();
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                    stream.write_all(&body).unwrap();
                }
            });
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.config_mut().plugins.0.insert(
                "updater".into(),
                serde_json::json!({
                    "dangerousInsecureTransportProtocol": true, // loopback test server only
                    "endpoints": [format!("{base}/latest.json")],
                    "pubkey": public_key,
                    "requireSignedVersion": true,
                }),
            );
            let app = tauri::test::mock_builder()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .build(context)
                .unwrap();
            let directory =
                std::env::temp_dir().join(format!("okf-native-update-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            let executable = directory.join("test.AppImage");
            let preferences = directory.join("settings.json");
            std::fs::write(&executable, b"older app version").unwrap();
            std::fs::write(&preferences, b"saved reviewer settings").unwrap();
            #[cfg(target_os = "linux")]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))
                    .unwrap();
            }
            let updater = app
                .updater_builder()
                .executable_path(&executable)
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap();
            tauri::async_runtime::block_on(async {
                let update = updater
                    .check()
                    .await
                    .unwrap()
                    .expect("new version available");
                assert_eq!(update.version, version);
                let result = update.download(|_, _| {}, || {}).await;
                assert_eq!(result.is_ok(), valid);
                if valid {
                    let bytes = result.unwrap();
                    assert_eq!(bytes, payload);
                    #[cfg(target_os = "linux")]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        update.install(&bytes).unwrap();
                        assert_eq!(std::fs::read(&executable).unwrap(), payload);
                        assert_eq!(
                            std::fs::metadata(&executable).unwrap().permissions().mode() & 0o777,
                            0o755
                        );
                    }
                } else {
                    assert_eq!(std::fs::read(&executable).unwrap(), b"older app version");
                }
                assert_eq!(
                    std::fs::read(&preferences).unwrap(),
                    b"saved reviewer settings"
                );
            });
            server.join().unwrap();
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
}
