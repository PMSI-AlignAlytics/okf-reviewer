//! App-local permission for fixed, read-only inspection of enclosing Git repositories.
//!
//! This deliberately does not modify Git configuration. A trusted repository is
//! supplied to Git as an exact per-command `safe.directory` value after the
//! frontend has shown the canonical path and the user has confirmed it.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const TRUST_FILE: &str = "repository-trust.json";
const MAX_TRUSTED_REPOSITORIES: usize = 128;
const MAX_TRUST_FILE_BYTES: u64 = 512 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryTrust {
    root: String,
}

pub struct RepositoryTrustState {
    file: PathBuf,
    trusted: Mutex<Vec<RepositoryTrust>>,
}

impl RepositoryTrustState {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let file = app
            .path()
            .app_data_dir()
            .map_err(|error| {
                format!("OKF Reviewer could not locate repository trust data: {error}")
            })?
            .join(TRUST_FILE);
        Ok(Self::load_from(file))
    }

    pub(crate) fn load_from(file: PathBuf) -> Self {
        let trusted = read_trust(&file).unwrap_or_else(|error| {
            eprintln!("[repository-trust] {error}; starting with no trusted repositories");
            Vec::new()
        });
        Self {
            file,
            trusted: Mutex::new(trusted),
        }
    }

    pub fn is_trusted(&self, repository: &Path) -> bool {
        let Ok(repository) = dunce::canonicalize(repository) else {
            return false;
        };
        self.trusted
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .any(|entry| Path::new(&entry.root) == repository)
    }

    pub fn trust(&self, repository: &Path) -> Result<PathBuf, String> {
        let repository = canonical_repository(repository)?;
        let root = repository
            .to_str()
            .ok_or_else(|| "The Git repository path is not valid UTF-8.".to_string())?
            .to_string();
        let mut trusted = self
            .trusted
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !trusted.iter().any(|entry| entry.root == root) {
            if trusted.len() >= MAX_TRUSTED_REPOSITORIES {
                return Err(format!(
                    "OKF Reviewer supports at most {MAX_TRUSTED_REPOSITORIES} trusted Git repositories."
                ));
            }
            trusted.push(RepositoryTrust { root });
            trusted.sort_by(|left, right| left.root.cmp(&right.root));
        }
        write_trust(&self.file, &trusted)?;
        Ok(repository)
    }
}

fn canonical_repository(root: &Path) -> Result<PathBuf, String> {
    let canonical = dunce::canonicalize(root)
        .map_err(|_| "The Git repository is no longer available.".to_string())?;
    if !canonical.is_dir() {
        return Err("The Git repository location is not a folder.".to_string());
    }
    Ok(canonical)
}

fn read_trust(file: &Path) -> Result<Vec<RepositoryTrust>, String> {
    if !file.exists() {
        return Ok(Vec::new());
    }
    if fs::metadata(file)
        .map_err(|error| format!("could not inspect repository trust data: {error}"))?
        .len()
        > MAX_TRUST_FILE_BYTES
    {
        return Err("repository trust data exceeds the 512 KB limit".to_string());
    }
    let bytes =
        fs::read(file).map_err(|error| format!("could not read repository trust data: {error}"))?;
    let entries: Vec<RepositoryTrust> = serde_json::from_slice(&bytes)
        .map_err(|error| format!("could not parse repository trust data: {error}"))?;
    if entries.len() > MAX_TRUSTED_REPOSITORIES {
        return Err("repository trust data contains too many entries".to_string());
    }
    let mut accepted = Vec::with_capacity(entries.len());
    for entry in entries {
        let root = dunce::simplified(Path::new(&entry.root));
        let normalized = root
            .to_str()
            .ok_or_else(|| "repository trust data contains an invalid path".to_string())?
            .to_string();
        if !root.is_absolute()
            || entry.root.len() > 32 * 1024
            || accepted
                .iter()
                .any(|existing: &RepositoryTrust| existing.root == normalized)
        {
            return Err("repository trust data contains an invalid entry".to_string());
        }
        accepted.push(RepositoryTrust { root: normalized });
    }
    Ok(accepted)
}

fn write_trust(file: &Path, trusted: &[RepositoryTrust]) -> Result<(), String> {
    let parent = file
        .parent()
        .ok_or_else(|| "Repository trust data has no parent directory.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| {
        format!("OKF Reviewer could not create repository trust storage: {error}")
    })?;
    let bytes = serde_json::to_vec_pretty(trusted)
        .map_err(|error| format!("OKF Reviewer could not encode repository trust data: {error}"))?;
    fs::write(file, bytes)
        .map_err(|error| format!("OKF Reviewer could not save repository trust data: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture(name: &str) -> (PathBuf, PathBuf, RepositoryTrustState) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "okf-review-repository-trust-{name}-{}-{nonce}",
            std::process::id()
        ));
        let repository = base.join("repository");
        let file = base.join("state").join("trust.json");
        fs::create_dir_all(&repository).expect("create repository fixture");
        let state = RepositoryTrustState::load_from(file.clone());
        (repository, file, state)
    }

    #[test]
    fn persists_only_exact_canonical_repository_paths() {
        let (repository, file, state) = fixture("persist");
        assert!(!state.is_trusted(&repository));
        state.trust(&repository).expect("trust repository");
        state.trust(&repository).expect("deduplicate repository");
        assert!(state.is_trusted(&repository));

        let reloaded = RepositoryTrustState::load_from(file);
        assert!(reloaded.is_trusted(&repository));
        assert!(!reloaded.is_trusted(repository.parent().expect("parent")));
        let _ = fs::remove_dir_all(repository.parent().expect("fixture root"));
    }

    #[test]
    fn malformed_or_forged_trust_data_grants_nothing() {
        let (repository, file, _) = fixture("malformed");
        fs::create_dir_all(file.parent().expect("state directory")).expect("state directory");
        fs::write(&file, r#"[{"root":"relative/repository"}]"#).expect("write bad state");
        let state = RepositoryTrustState::load_from(file);
        assert!(!state.is_trusted(&repository));
        let _ = fs::remove_dir_all(repository.parent().expect("fixture root"));
    }
}
