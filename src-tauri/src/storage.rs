//! File IO for Studio.
//!
//! Deliberately a handful of narrow commands rather than the blanket `fs` plugin.
//! Two of these paths are genuinely different in kind and shouldn't share a scope:
//!
//!  - `read_text` reads a path the **user just chose in a file dialog**. Scoping it
//!    would defeat the app's purpose; the file picker *is* the consent step.
//!  - `store_*` reads and writes only inside the app's own config directory.
//!  - `cli_config` reads exactly one well-known file and nothing else.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Read a file the user picked in a dialog.
#[tauri::command]
pub fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|error| format!("{path}: {error}"))
}

fn store_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("no app config dir: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    Ok(dir)
}

/// Reject anything that isn't a plain file name — `name` comes from the frontend.
fn store_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("invalid store name: {name}"));
    }
    Ok(store_dir(app)?.join(name))
}

#[tauri::command]
pub fn store_read(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    let path = store_path(&app, &name)?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

#[tauri::command]
pub fn store_write(app: tauri::AppHandle, name: String, contents: String) -> Result<(), String> {
    let path = store_path(&app, &name)?;
    fs::write(&path, contents).map_err(|error| format!("{}: {error}", path.display()))
}

/// Remove a store file. Removing one that isn't there is not an error.
#[tauri::command]
pub fn store_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let path = store_path(&app, &name)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

/// Where the store lives, so the UI can tell the user (environments are meant to be inspectable).
#[tauri::command]
pub fn store_location(app: tauri::AppHandle) -> Result<String, String> {
    Ok(store_dir(&app)?.display().to_string())
}

/// The spec0 CLI's session, if the user already has one. Read-only, never written.
#[tauri::command]
pub fn cli_config() -> Result<Option<String>, String> {
    // Windows has no HOME; USERPROFILE is the home folder there.
    let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
    else {
        return Ok(None);
    };
    let path: &Path = &home.join(".spec0").join("config.json");
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}
