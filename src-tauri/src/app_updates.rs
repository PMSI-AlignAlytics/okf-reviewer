//! Signed application updates. The webview supplies no URLs, keys, or installer bytes.

use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_store::StoreExt;
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
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
    downloaded: bool,
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

fn cache_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("app-updates"))
        .map_err(|error| format!("Could not locate the update cache: {error}"))
}

fn clear_cached_update(directory: &Path) {
    // Only these application-owned files are removed, never a supplied path.
    let _ = std::fs::remove_file(directory.join("release.json"));
    let _ = std::fs::remove_file(directory.join("package.bin"));
}

fn load_cached_update(updater: &Updater, directory: &Path) -> Option<(Update, Vec<u8>)> {
    let cached = (|| {
        let metadata = std::fs::read(directory.join("release.json")).ok()?;
        let release = serde_json::from_slice(&metadata).ok()?;
        // Restoration uses the installed app's key, target, and version policy.
        // Cached metadata cannot override them or announce an unsigned version.
        let update = updater.restore_update(release).ok()??;
        let bytes = std::fs::read(directory.join("package.bin")).ok()?;
        update.verify(&bytes).ok()?;
        Some((update, bytes))
    })();
    if cached.is_none() {
        // A partial, obsolete, or damaged app cache is disposable. A fresh
        // signed download will be needed; it can never become installable.
        clear_cached_update(directory);
    }
    cached
}

fn write_cache_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        // Windows cannot rename over an existing file. A crash in this gap
        // merely invalidates the cache; load always verifies the complete pair.
        match std::fs::remove_file(path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

fn save_cached_update(directory: &Path, update: &Update, bytes: &[u8]) -> Result<(), String> {
    update
        .verify(bytes)
        .map_err(|error| format!("Could not verify the update cache: {error}"))?;
    let metadata = serde_json::to_vec(&update.raw_json).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(directory)
        .and_then(|()| write_cache_file(&directory.join("package.bin"), bytes))
        .and_then(|()| write_cache_file(&directory.join("release.json"), &metadata))
        .map_err(|error| format!("Could not save the downloaded update: {error}"))
}

impl PendingUpdate {
    fn check_result(&self, installation: Option<&'static str>) -> AppUpdateCheck {
        AppUpdateCheck {
            supported: installation.is_some(),
            installation,
            update: self.update.as_ref().map(|update| AppUpdateInfo {
                version: update.version.clone(),
                notes: update.body.clone(),
            }),
            downloaded: self.verified_bytes.is_some(),
        }
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
        return Ok(pending.check_result(installation));
    }
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let cache = cache_directory(&app)?;
    if pending.update.is_none() {
        if let Some((update, bytes)) = load_cached_update(&updater, &cache) {
            pending.update = Some(update);
            pending.verified_bytes = Some(bytes);
            return Ok(pending.check_result(installation));
        }
    }
    let mut update = updater
        .check()
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))?;
    if let Some(update) = update.as_mut() {
        update.timeout = Some(Duration::from_secs(15 * 60));
    }
    // Rechecking the same release must not throw away its verified download.
    let same_package =
        pending
            .update
            .as_ref()
            .zip(update.as_ref())
            .is_some_and(|(previous, next)| {
                previous.version == next.version && previous.signature == next.signature
            });
    if !same_package {
        pending.verified_bytes = None;
        clear_cached_update(&cache);
    }
    pending.update = update;
    Ok(pending.check_result(installation))
}

#[tauri::command]
pub async fn download_app_update(
    window: WebviewWindow,
    app: AppHandle,
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
    let cache = cache_directory(&app)?;
    if let Ok(bytes) = std::fs::read(cache.join("package.bin")) {
        if update.verify(&bytes).is_ok() {
            // A previous save may have completed the package but not its
            // metadata. Publish the matching metadata before reporting ready.
            let metadata =
                serde_json::to_vec(&update.raw_json).map_err(|error| error.to_string())?;
            write_cache_file(&cache.join("release.json"), &metadata)
                .map_err(|error| format!("Could not save the downloaded update: {error}"))?;
            pending.verified_bytes = Some(bytes);
            return Ok(());
        }
    }
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
    save_cached_update(&cache, update, &bytes)?;
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
    fn cached_updates_restore_offline_and_reject_damaged_stale_or_mislabeled_packages() {
        let payload = include_bytes!("../../scripts/fixtures/updater/payload.txt");
        let signature = include_str!("../../scripts/fixtures/updater/payload.txt.sig").trim();
        let public_key = include_str!("../../scripts/fixtures/updater/public.key.pub").trim();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": public_key, "requireSignedVersion": true,
                "endpoints": ["https://example.invalid/never-requested"],
            }),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let updater = app.updater_builder().build().unwrap();
        let metadata = serde_json::json!({
            "version": "1.2.3", "url": "https://example.invalid/never-requested",
            "signature": signature,
        });
        let update = updater.restore_update(metadata.clone()).unwrap().unwrap();
        let directory =
            std::env::temp_dir().join(format!("okf-update-cache-{}", uuid::Uuid::new_v4()));
        save_cached_update(&directory, &update, payload).unwrap();
        drop(update);

        // A new updater represents a new application process. Restoration
        // verifies the package without making a request or running an installer.
        let updater = app.updater_builder().build().unwrap();
        let (restored, bytes) = load_cached_update(&updater, &directory).unwrap();
        assert_eq!(restored.version, "1.2.3");
        assert_eq!(bytes, payload);
        let pending = PendingUpdate {
            update: Some(restored.clone()),
            verified_bytes: Some(bytes),
        };
        assert!(pending.check_result(Some("nsis")).downloaded);

        // Even valid old signatures cannot approve a falsely announced version.
        let mut mislabeled = metadata.clone();
        mislabeled["version"] = serde_json::json!("9.9.9");
        std::fs::write(directory.join("release.json"), mislabeled.to_string()).unwrap();
        assert!(load_cached_update(&updater, &directory).is_none());
        assert!(!directory.join("package.bin").exists());

        save_cached_update(&directory, &restored, payload).unwrap();
        std::fs::write(directory.join("package.bin"), b"tampered package").unwrap();
        assert!(load_cached_update(&updater, &directory).is_none());
        assert!(!directory.join("release.json").exists());
        assert!(save_cached_update(&directory, &restored, b"tampered package").is_err());

        save_cached_update(&directory, &restored, payload).unwrap();
        std::fs::write(directory.join("release.json"), b"partial JSON").unwrap();
        assert!(load_cached_update(&updater, &directory).is_none());

        save_cached_update(&directory, &restored, payload).unwrap();
        let current = app
            .updater_builder()
            .version_comparator(|_, _| false)
            .build()
            .unwrap();
        assert!(load_cached_update(&current, &directory).is_none());
        assert!(!directory.join("release.json").exists());
        assert!(!directory.join("package.bin").exists());

        // Replacing an older complete cache uses the same bounded files.
        save_cached_update(&directory, &restored, payload).unwrap();
        save_cached_update(&directory, &restored, payload).unwrap();
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 2);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn native_updater_downloads_a_signed_new_release_and_rejects_tampering() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        // An inert ELF header exercises the AppImage format check. This signed
        // fixture is only written to a disposable path and is never executed.
        // Tauri CLI 2.12.1 signed version 1.2.3 with a disposable test key;
        // only its public key and signature are retained.
        let payload = b"\x7fELFOKF Reviewer signed updater fixture; never execute.\n";
        let signature = include_str!("../../scripts/fixtures/updater/appimage.sig").trim();
        let public_key =
            include_str!("../../scripts/fixtures/updater/appimage-public.key.pub").trim();
        let text_payload = include_bytes!("../../scripts/fixtures/updater/payload.txt");
        let text_signature = include_str!("../../scripts/fixtures/updater/payload.txt.sig").trim();
        let text_public_key = include_str!("../../scripts/fixtures/updater/public.key.pub").trim();
        for (version, bytes, signature, public_key, valid, installable) in [
            (
                "1.2.3",
                payload.as_slice(),
                signature,
                public_key,
                true,
                true,
            ),
            (
                "9.9.9",
                payload.as_slice(),
                signature,
                public_key,
                false,
                false,
            ),
            (
                "1.2.3",
                b"tampered artifact".as_slice(),
                signature,
                public_key,
                false,
                false,
            ),
            (
                "1.2.3",
                text_payload.as_slice(),
                text_signature,
                text_public_key,
                true,
                false,
            ),
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
                    // Windows sockets inherit the listener's non-blocking
                    // mode, so a read could race the request. Block, bounded
                    // by the read timeout.
                    stream.set_nonblocking(false).unwrap();
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
                    let downloaded = result.unwrap();
                    assert_eq!(downloaded.as_slice(), bytes);
                    #[cfg(target_os = "linux")]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let installed = update.install(&downloaded);
                        if installable {
                            installed.unwrap();
                            assert_eq!(std::fs::read(&executable).unwrap().as_slice(), bytes);
                            assert_eq!(
                                std::fs::metadata(&executable).unwrap().permissions().mode()
                                    & 0o777,
                                0o755
                            );
                        } else {
                            assert!(matches!(
                                installed,
                                Err(tauri_plugin_updater::Error::InvalidUpdaterFormat)
                            ));
                            assert_eq!(std::fs::read(&executable).unwrap(), b"older app version");
                        }
                    }
                    #[cfg(not(target_os = "linux"))]
                    let _ = installable;
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
