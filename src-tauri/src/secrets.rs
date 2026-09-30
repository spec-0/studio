//! Secret environment values, kept in the operating system's credential store.
//!
//! macOS Keychain, Windows Credential Manager, or the Secret Service on Linux (a
//! desktop keyring such as GNOME Keyring or KWallet), through the `keyring` crate.
//!
//! These are narrow commands on purpose. The webview names an environment id and
//! a variable name; Rust builds the account from them under one fixed service
//! name. There is no way to ask for an arbitrary keychain item, so a compromised
//! page can reach Studio's own secrets and nothing else in your keychain.
//!
//! Credential stores can't be listed portably, so Rust also keeps a small index
//! of which accounts it has written (`secret-index.json`, names only, never
//! values). That is what lets the frontend remove entries for a renamed or
//! deleted variable instead of leaving them behind. The index is written
//! *before* a value is stored and trimmed *after* one is deleted, so it is
//! always a superset of what is really in the store: an interruption can leave
//! an index line with no value, never a value nobody knows about.
//!
//! Error messages never include a value. They say what failed and why.

use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

/// Every entry lives under this service name, which is also the app identifier.
pub const SERVICE: &str = "io.spec0.studio";
const INDEX_FILE: &str = "secret-index.json";
/// Used only to ask "is the store reachable?". Nothing is ever written to it.
const PROBE_ACCOUNT: &str = "__studio_probe__";

/// Serialises read-modify-write of the index across concurrent commands.
static INDEX_LOCK: Mutex<()> = Mutex::new(());

/// What went wrong, in a shape the frontend can act on.
///
/// `unavailable` means the store itself can't be reached (no keyring running,
/// locked, access denied), and the frontend falls back to the local file for the
/// session. Anything else is a problem with one value, such as one too long for
/// Windows Credential Manager, and only that value falls back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SecretError {
    pub unavailable: bool,
    pub message: String,
}

impl SecretError {
    fn unavailable(message: impl Into<String>) -> Self {
        Self { unavailable: true, message: message.into() }
    }
    fn failed(message: impl Into<String>) -> Self {
        Self { unavailable: false, message: message.into() }
    }
}

/// Map a `keyring` error to ours without ever formatting a stored value.
///
/// `BadEncoding` carries the raw bytes of the credential, so it is described,
/// not printed.
fn map_error(error: keyring::Error) -> SecretError {
    use keyring::Error;
    match error {
        Error::NoStorageAccess(inner) => {
            SecretError::unavailable(format!("the credential store refused access: {inner}"))
        }
        Error::PlatformFailure(inner) => {
            SecretError::unavailable(format!("the credential store isn't working: {inner}"))
        }
        Error::BadEncoding(_) => SecretError::failed("a stored value isn't valid text"),
        Error::TooLong(field, limit) => SecretError::failed(format!(
            "the {field} is longer than this credential store allows ({limit})"
        )),
        Error::Invalid(field, reason) => SecretError::failed(format!("invalid {field}: {reason}")),
        Error::Ambiguous(_) => SecretError::failed("more than one matching entry was found"),
        Error::NoEntry => SecretError::failed("no such entry"),
        other => SecretError::failed(format!("credential store error: {other}")),
    }
}

/// The one place a (environment, variable) pair becomes a store account.
///
/// Both halves come from the webview, so they're checked: an environment id is
/// Studio's own `env_…` token and never contains `/`, which keeps the account
/// unambiguous however the variable is named.
pub fn account(env_id: &str, name: &str) -> Result<String, SecretError> {
    let bad = |what: &str| SecretError::failed(format!("invalid {what}"));
    if env_id.is_empty()
        || env_id.len() > 128
        || env_id.contains('/')
        || env_id.chars().any(char::is_control)
    {
        return Err(bad("environment id"));
    }
    if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
        return Err(bad("variable name"));
    }
    Ok(format!("{env_id}/{name}"))
}

/// Split an account back into (environment id, variable name).
fn split_account(account: &str) -> Option<(&str, &str)> {
    account.split_once('/')
}

/// The credential store, behind a trait so the logic is testable without one.
pub trait Vault {
    fn get(&self, account: &str) -> Result<Option<String>, SecretError>;
    fn set(&self, account: &str, value: &str) -> Result<(), SecretError>;
    fn delete(&self, account: &str) -> Result<(), SecretError>;
}

/// The real thing: whichever native store `keyring` was built with.
pub struct OsVault;

impl OsVault {
    fn entry(account: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(SERVICE, account).map_err(map_error)
    }
}

impl Vault for OsVault {
    fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(map_error(error)),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        Self::entry(account)?.set_password(value).map_err(map_error)
    }

    fn delete(&self, account: &str) -> Result<(), SecretError> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_error(error)),
        }
    }
}

// Index

fn read_index(path: &Path) -> BTreeSet<String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<BTreeSet<String>>(&raw).ok())
        .unwrap_or_default()
}

fn write_index(path: &Path, index: &BTreeSet<String>) -> Result<(), SecretError> {
    let contents = serde_json::to_string_pretty(index)
        .map_err(|error| SecretError::failed(format!("index: {error}")))?;
    fs::write(path, contents)
        .map_err(|error| SecretError::failed(format!("{}: {error}", path.display())))
}

fn update_index(path: &Path, change: impl FnOnce(&mut BTreeSet<String>) -> bool) -> Result<(), SecretError> {
    let _guard = INDEX_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut index = read_index(path);
    if change(&mut index) {
        write_index(path, &index)?;
    }
    Ok(())
}

// The operations, independent of Tauri

pub fn get(vault: &dyn Vault, env_id: &str, name: &str) -> Result<Option<String>, SecretError> {
    vault.get(&account(env_id, name)?)
}

/// Index first, then the value. See the module docs for why that order.
pub fn set(vault: &dyn Vault, index: &Path, env_id: &str, name: &str, value: &str) -> Result<(), SecretError> {
    let account = account(env_id, name)?;
    update_index(index, |set| set.insert(account.clone()))?;
    vault.set(&account, value)
}

/// The value first, then the index line.
pub fn delete(vault: &dyn Vault, index: &Path, env_id: &str, name: &str) -> Result<(), SecretError> {
    let account = account(env_id, name)?;
    vault.delete(&account)?;
    update_index(index, |set| set.remove(&account))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretKey {
    pub env_id: String,
    pub name: String,
}

pub fn list(index: &Path) -> Vec<SecretKey> {
    read_index(index)
        .iter()
        .filter_map(|account| split_account(account))
        .map(|(env_id, name)| SecretKey { env_id: env_id.into(), name: name.into() })
        .collect()
}

/// Where secrets are kept on this OS, in words for the UI.
pub fn store_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS Keychain"
    } else if cfg!(target_os = "windows") {
        "Windows Credential Manager"
    } else {
        "system keyring (Secret Service)"
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Backend {
    pub available: bool,
    pub store: &'static str,
    /// Why it isn't available, when it isn't.
    pub reason: Option<String>,
}

/// Is the store reachable? Reads an account that is never written.
pub fn probe(vault: &dyn Vault) -> Backend {
    match vault.get(PROBE_ACCOUNT) {
        Ok(_) => Backend { available: true, store: store_name(), reason: None },
        Err(error) => Backend { available: false, store: store_name(), reason: Some(error.message) },
    }
}

// Tauri commands
//
// All async and run off the main thread: a credential store may block on a
// prompt (an unlock dialog on Linux, an access prompt on macOS), and that must
// not freeze the window.

fn index_path(app: &tauri::AppHandle) -> Result<PathBuf, SecretError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| SecretError::failed(format!("no app config dir: {error}")))?;
    fs::create_dir_all(&dir)
        .map_err(|error| SecretError::failed(format!("{}: {error}", dir.display())))?;
    Ok(dir.join(INDEX_FILE))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, SecretError> + Send + 'static,
) -> Result<T, SecretError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| SecretError::failed(format!("task failed: {error}")))?
}

#[tauri::command]
pub async fn secret_backend() -> Result<Backend, SecretError> {
    blocking(|| Ok(probe(&OsVault))).await
}

#[tauri::command]
pub async fn secret_get(env_id: String, name: String) -> Result<Option<String>, SecretError> {
    blocking(move || get(&OsVault, &env_id, &name)).await
}

#[tauri::command]
pub async fn secret_set(
    app: tauri::AppHandle,
    env_id: String,
    name: String,
    value: String,
) -> Result<(), SecretError> {
    let index = index_path(&app)?;
    blocking(move || set(&OsVault, &index, &env_id, &name, &value)).await
}

#[tauri::command]
pub async fn secret_delete(app: tauri::AppHandle, env_id: String, name: String) -> Result<(), SecretError> {
    let index = index_path(&app)?;
    blocking(move || delete(&OsVault, &index, &env_id, &name)).await
}

/// Which (environment, variable) pairs Studio has stored. Names only.
#[tauri::command]
pub async fn secret_list(app: tauri::AppHandle) -> Result<Vec<SecretKey>, SecretError> {
    let index = index_path(&app)?;
    blocking(move || Ok(list(&index))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// An in-memory store. `keyring`'s own mock gives every `Entry` a separate
    /// credential, so it can't show a value surviving from `set` to `get`.
    #[derive(Default)]
    struct MemoryVault {
        values: RefCell<HashMap<String, String>>,
        fail: Option<SecretError>,
    }

    impl Vault for MemoryVault {
        fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
            if let Some(error) = &self.fail {
                return Err(error.clone());
            }
            Ok(self.values.borrow().get(account).cloned())
        }
        fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
            if let Some(error) = &self.fail {
                return Err(error.clone());
            }
            self.values.borrow_mut().insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), SecretError> {
            if let Some(error) = &self.fail {
                return Err(error.clone());
            }
            self.values.borrow_mut().remove(account);
            Ok(())
        }
    }

    fn temp_index(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("studio-secrets-{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(INDEX_FILE);
        let _ = fs::remove_file(&path);
        path
    }

    #[test]
    fn accounts_are_scoped_and_checked() {
        assert_eq!(account("env_1", "token").unwrap(), "env_1/token");
        // A variable name may contain a slash; the environment id may not, so the
        // split back is still unambiguous.
        assert_eq!(account("env_1", "a/b").unwrap(), "env_1/a/b");
        assert_eq!(split_account("env_1/a/b"), Some(("env_1", "a/b")));
        assert!(account("", "token").is_err());
        assert!(account("env/1", "token").is_err());
        assert!(account("env_1", "").is_err());
        assert!(account("env_1", "bad\nname").is_err());
    }

    #[test]
    fn set_get_delete_round_trip_and_index() {
        let vault = MemoryVault::default();
        let index = temp_index("round-trip");

        set(&vault, &index, "env_1", "token", "sk_live_1").unwrap();
        set(&vault, &index, "env_2", "password", "hunter2").unwrap();
        assert_eq!(get(&vault, "env_1", "token").unwrap().as_deref(), Some("sk_live_1"));
        assert_eq!(
            list(&index),
            vec![
                SecretKey { env_id: "env_1".into(), name: "token".into() },
                SecretKey { env_id: "env_2".into(), name: "password".into() },
            ]
        );

        delete(&vault, &index, "env_1", "token").unwrap();
        assert_eq!(get(&vault, "env_1", "token").unwrap(), None);
        assert_eq!(list(&index).len(), 1);

        // The index holds names only, never a value.
        let raw = fs::read_to_string(&index).unwrap();
        assert!(!raw.contains("hunter2"));
        assert!(raw.contains("env_2/password"));
    }

    #[test]
    fn deleting_something_absent_is_fine() {
        let vault = MemoryVault::default();
        let index = temp_index("absent");
        delete(&vault, &index, "env_1", "never-set").unwrap();
        assert!(list(&index).is_empty());
    }

    #[test]
    fn a_failed_set_still_leaves_the_index_line() {
        // The index is a superset of the store, so a value is never orphaned:
        // at worst there's a line with nothing behind it, which delete clears.
        let vault = MemoryVault {
            fail: Some(SecretError::unavailable("no keyring")),
            ..Default::default()
        };
        let index = temp_index("failed-set");
        assert!(set(&vault, &index, "env_1", "token", "x").is_err());
        assert_eq!(list(&index).len(), 1);
    }

    #[test]
    fn probe_reports_an_unreachable_store() {
        assert!(probe(&MemoryVault::default()).available);
        let down = MemoryVault {
            fail: Some(SecretError::unavailable("no Secret Service on the session bus")),
            ..Default::default()
        };
        let backend = probe(&down);
        assert!(!backend.available);
        assert_eq!(backend.reason.as_deref(), Some("no Secret Service on the session bus"));
    }

    #[test]
    fn keyring_errors_map_without_leaking_values() {
        // BadEncoding carries the stored bytes; they must not reach the message.
        let error = map_error(keyring::Error::BadEncoding(b"sk_live_secret".to_vec()));
        assert!(!error.message.contains("sk_live_secret"));
        assert!(!error.unavailable);

        let error = map_error(keyring::Error::TooLong("password".into(), 2560));
        assert!(!error.unavailable);
        assert!(error.message.contains("2560"));

        let error = map_error(keyring::Error::NoStorageAccess("locked".into()));
        assert!(error.unavailable);
    }

    #[test]
    fn os_vault_maps_keyring_behaviour() {
        // Uses keyring's mock builder so this runs without a real keychain.
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        let vault = OsVault;
        // A missing entry is "nothing stored", not an error.
        assert_eq!(vault.get("env_1/token").unwrap(), None);
        // Deleting a missing entry is not an error either.
        vault.delete("env_1/token").unwrap();
        vault.set("env_1/token", "value").unwrap();
    }
}
