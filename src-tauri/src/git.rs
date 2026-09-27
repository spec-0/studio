//! Where a spec file came from, when it came from a git working tree.
//!
//! This describes **the file on your disk** and nothing else. It is not a
//! deployment fact: Studio does not know which commit any environment is
//! running; deployments are facts a platform reports, never ones a client
//! inferred. The frontend words the chip accordingly; this module's job is to
//! report only what git actually says.
//!
//! Two design notes:
//!
//!  - **We look for `.git` ourselves before spawning anything.** Most opened
//!    specs are not in a repo, and walking a handful of parent directories is
//!    far cheaper than starting a process to be told "not a repository".
//!
//!  - **We never invoke `/usr/bin/git` blindly on macOS.** There that path is a
//!    shim: if the Command Line Tools are not installed, running it pops a
//!    system dialog asking the user to install them. A spec viewer must not
//!    conjure an Xcode installer because someone opened a file. So we resolve a
//!    real git binary and, finding none, simply report nothing. On Linux
//!    `/usr/bin/git` is the real thing. On Windows we look in the usual Git for
//!    Windows locations and then on `PATH`, and start git without a console
//!    window, which would otherwise flash up on every opened spec.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// How far up the tree to look for `.git` before giving up.
const MAX_DEPTH: usize = 64;

/// Real git binaries, in preference order. On macOS `/usr/bin/git` is
/// deliberately absent — see the module note about the CLT prompt.
#[cfg(target_os = "macos")]
const GIT_CANDIDATES: &[&str] = &[
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
    "/Library/Developer/CommandLineTools/usr/bin/git",
    "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
];

#[cfg(windows)]
const GIT_CANDIDATES: &[&str] = &[
    r"C:\Program Files\Git\cmd\git.exe",
    r"C:\Program Files (x86)\Git\cmd\git.exe",
];

#[cfg(not(any(target_os = "macos", windows)))]
const GIT_CANDIDATES: &[&str] = &["/usr/bin/git", "/usr/local/bin/git", "/bin/git"];

#[derive(Debug, Serialize)]
pub struct GitInfo {
    /// Branch name, or `None` when HEAD is detached.
    pub branch: Option<String>,
    /// Abbreviated commit id.
    pub sha: String,
    /// First line of the commit message.
    pub subject: String,
    /// Commit date, ISO-8601 — formatted for display on the frontend.
    pub committed_at: String,
    /// True when *this file* differs from HEAD, so the commit above does not
    /// describe what was loaded.
    pub dirty: bool,
    /// Repository root, for display.
    pub root: String,
    /// The spec's path relative to the repository root.
    pub path: String,
}

/// Describe the git state of the working tree containing `path`.
///
/// `Ok(None)` is the ordinary answer for "not in a repo" or "no git available".
/// Both are normal conditions, not failures — the caller shows nothing.
#[tauri::command]
pub fn git_info(path: String) -> Result<Option<GitInfo>, String> {
    Ok(describe(Path::new(&path)))
}

fn describe(file: &Path) -> Option<GitInfo> {
    let start = if file.is_dir() { file } else { file.parent()? };
    let root = find_repo_root(start)?;
    let git = find_git()?;

    // One call for the commit, so the three fields can never disagree with each
    // other by being read at different moments.
    let record = run(
        &git,
        &root,
        &["log", "-1", "--no-color", "--format=%h%x1f%s%x1f%cI"],
    )?;
    let mut fields = record.trim_end().split('\u{1f}');
    let sha = fields.next()?.to_string();
    let subject = fields.next().unwrap_or_default().to_string();
    let committed_at = fields.next().unwrap_or_default().to_string();
    if sha.is_empty() {
        return None; // A repository with no commits yet.
    }

    let branch = run(&git, &root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "HEAD");

    // Status of the spec file alone. A dirty README elsewhere in the repo says
    // nothing about the document that is actually on screen.
    let relative = file.strip_prefix(&root).unwrap_or(file);
    let relative_display = relative.to_string_lossy().to_string();
    let dirty = run(
        &git,
        &root,
        &["status", "--porcelain", "--", &relative_display],
    )
    .map(|value| !value.trim().is_empty())
    .unwrap_or(false);

    Some(GitInfo {
        branch,
        sha,
        subject,
        committed_at,
        dirty,
        root: root.to_string_lossy().to_string(),
        path: relative_display,
    })
}

/// Walk up looking for `.git`. It is a directory in a normal clone and a file in
/// a linked worktree, so both count.
fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut dir = start;
    for _ in 0..MAX_DEPTH {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
    None
}

fn find_git() -> Option<PathBuf> {
    GIT_CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.is_file())
        .or_else(git_on_path)
}

/// Git for Windows installed somewhere else, or through a package manager.
#[cfg(windows)]
fn git_on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("git.exe"))
        .find(|candidate| candidate.is_file())
}

/// Elsewhere the fixed list is the whole answer — on macOS, searching `PATH`
/// would find the `/usr/bin/git` shim.
#[cfg(not(windows))]
fn git_on_path() -> Option<PathBuf> {
    None
}

fn run(git: &Path, root: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new(git);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .arg("-C")
        .arg(root)
        // Keep a slow or interactive credential helper from ever blocking the
        // read — none of these commands should need one.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finds_the_root_from_a_nested_directory() {
        let base = std::env::temp_dir().join(format!("s0-git-{}", std::process::id()));
        let nested = base.join("a/b/c");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(base.join(".git")).unwrap();

        assert_eq!(find_repo_root(&nested), Some(base.clone()));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn treats_a_dot_git_file_as_a_root_too() {
        // Linked worktrees have a `.git` *file* pointing at the real gitdir.
        let base = std::env::temp_dir().join(format!("s0-gitfile-{}", std::process::id()));
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join(".git"), "gitdir: /elsewhere\n").unwrap();

        assert_eq!(find_repo_root(&base), Some(base.clone()));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn reports_nothing_outside_a_repository() {
        let base = std::env::temp_dir().join(format!("s0-norepo-{}", std::process::id()));
        fs::create_dir_all(&base).unwrap();
        // temp_dir itself is not under a repo on any machine we build on.
        assert!(find_repo_root(&base).is_none());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn describing_a_path_that_does_not_exist_is_not_an_error() {
        assert!(git_info("/nonexistent/whatever/openapi.yaml".into())
            .unwrap()
            .is_none());
    }

    #[test]
    fn every_candidate_git_is_an_absolute_path() {
        // No bare "git": that would search PATH, which on macOS finds the shim.
        for candidate in GIT_CANDIDATES {
            assert!(Path::new(candidate).is_absolute(), "{candidate} is not absolute");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_never_uses_the_usr_bin_git_shim() {
        // Guards the CLT-prompt rule.
        assert!(!GIT_CANDIDATES.contains(&"/usr/bin/git"));
        assert!(git_on_path().is_none());
    }
}
