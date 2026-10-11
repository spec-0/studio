//! Hosting a coding agent for the chat panel.
//!
//! The panel talks to an agent the user already has (Claude, Codex or
//! Gemini CLI) over the Agent Client Protocol: newline-delimited JSON-RPC on the
//! agent's standard input and output. The protocol itself is spoken in the web
//! view (`src/lib/acpClient.ts`); this module only starts the process, passes
//! lines in both directions, and stops it.
//!
//! What the web view can and can't do here:
//!
//!  - It names an agent (`claude`, `codex`, `gemini` or `custom`), never a
//!    program. The program and its arguments are decided here.
//!  - A program the user chose by hand (a custom agent, or the path to one of
//!    the known ones) is saved only after a native confirmation that shows the
//!    exact command, and in a file `store_write` can't reach.
//!  - The working folder must be an existing absolute directory. By default it's
//!    an empty folder of Studio's own, away from Studio's settings and tokens.
//!
//! Nothing starts until the user sends a first message, and every process is
//! stopped, with its children, when the session ends or Studio quits.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// A line from an agent's standard output.
pub const DATA_EVENT: &str = "studio://acp-data";
/// An agent process ended.
pub const EXIT_EVENT: &str = "studio://acp-exit";

/// Longest line accepted from an agent. A longer one is dropped, not buffered.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
/// How much of the agent's standard error is kept, for when it fails to start.
const STDERR_TAIL_BYTES: usize = 16 * 1024;
/// How long a login shell gets to report its `PATH`.
#[cfg(not(windows))]
const SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(3);
/// How long an agent gets to exit after its input is closed, before it's killed.
const STOP_GRACE: Duration = Duration::from_millis(1500);

/// Adapter versions run through `npx` when the adapter isn't installed. Pinned,
/// so an update to an adapter can't change Studio's behaviour unannounced.
pub const CLAUDE_ADAPTER: &str = "@agentclientprotocol/claude-agent-acp@0.89.1";
pub const CODEX_ADAPTER: &str = "@agentclientprotocol/codex-acp@2.2.2";

// The agents Studio knows

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Known {
    Claude,
    Codex,
    Gemini,
}

impl Known {
    pub const ALL: [Known; 3] = [Known::Claude, Known::Codex, Known::Gemini];

    pub fn id(self) -> &'static str {
        match self {
            Known::Claude => "claude",
            Known::Codex => "codex",
            Known::Gemini => "gemini",
        }
    }

    pub fn from_id(id: &str) -> Option<Known> {
        Known::ALL.into_iter().find(|known| known.id() == id)
    }

    pub fn name(self) -> &'static str {
        match self {
            Known::Claude => "Claude Agent",
            Known::Codex => "Codex",
            Known::Gemini => "Gemini CLI",
        }
    }

    /// The program that speaks ACP, and its arguments.
    fn program(self) -> (&'static str, &'static [&'static str]) {
        match self {
            Known::Claude => ("claude-agent-acp", &[]),
            Known::Codex => ("codex-acp", &[]),
            Known::Gemini => ("gemini", &["--acp"]),
        }
    }

    /// The adapter package to run with `npx` when the program isn't installed.
    fn npx_package(self) -> Option<&'static str> {
        match self {
            Known::Claude => Some(CLAUDE_ADAPTER),
            Known::Codex => Some(CODEX_ADAPTER),
            Known::Gemini => None,
        }
    }

    /// The agent's own command line, used to sign in before the first session.
    fn cli(self) -> &'static str {
        match self {
            Known::Claude => "claude",
            Known::Codex => "codex",
            Known::Gemini => "gemini",
        }
    }
}

/// A program and its arguments, as it will be started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandLine {
    pub program: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
}

impl CommandLine {
    pub fn display(&self) -> String {
        std::iter::once(self.program.display().to_string())
            .chain(self.args.iter().map(|arg| quote(arg)))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn quote(arg: &str) -> String {
    if !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=@,".contains(c))
    {
        arg.to_string()
    } else {
        format!("\"{}\"", arg.replace('"', "\\\""))
    }
}

/// Commands the user chose by hand, keyed by agent id (`custom` included).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Overrides {
    #[serde(default)]
    pub commands: HashMap<String, CommandLine>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    /// `installed`, `npx` (the adapter is fetched on first start), `chosen`
    /// (a path the user picked) or `missing`.
    pub how: String,
    /// What will run, for showing. Empty when missing.
    pub command: String,
    /// The program the user chose by hand, with its arguments, for editing.
    pub chosen: Option<CommandLine>,
    /// The agent's own command line was found, for signing in.
    pub cli_found: bool,
    pub cli: String,
}

/// Where each agent would come from, given a search path and the user's choices.
pub fn describe(dirs: &[PathBuf], overrides: &Overrides) -> Vec<AgentInfo> {
    let mut out: Vec<AgentInfo> = Known::ALL
        .into_iter()
        .map(|known| {
            let resolved = resolve_known(known, dirs, overrides);
            AgentInfo {
                id: known.id().into(),
                name: known.name().into(),
                how: resolved.as_ref().map_or("missing", |(how, _)| how).into(),
                command: resolved.map(|(_, line)| line.display()).unwrap_or_default(),
                chosen: overrides.commands.get(known.id()).cloned(),
                cli_found: which(known.cli(), dirs).is_some(),
                cli: known.cli().into(),
            }
        })
        .collect();
    let custom = overrides.commands.get("custom");
    out.push(AgentInfo {
        id: "custom".into(),
        name: "Another agent".into(),
        how: if custom.is_some() {
            "chosen"
        } else {
            "missing"
        }
        .into(),
        command: custom.map(CommandLine::display).unwrap_or_default(),
        chosen: custom.cloned(),
        cli_found: false,
        cli: String::new(),
    });
    out
}

/// How a known agent would be started: a chosen path first, then an installed
/// program, then its adapter through `npx`.
fn resolve_known(
    known: Known,
    dirs: &[PathBuf],
    overrides: &Overrides,
) -> Option<(&'static str, CommandLine)> {
    if let Some(chosen) = overrides.commands.get(known.id()) {
        return Some(("chosen", chosen.clone()));
    }
    let (program, args) = known.program();
    if let Some(path) = which(program, dirs) {
        return Some((
            "installed",
            CommandLine {
                program: path,
                args: args.iter().map(|arg| arg.to_string()).collect(),
            },
        ));
    }
    let package = known.npx_package()?;
    let npx = which("npx", dirs)?;
    Some((
        "npx",
        CommandLine {
            program: npx,
            args: vec!["-y".into(), package.into()],
        },
    ))
}

/// The command for an agent id, or why there isn't one.
pub fn resolve(id: &str, dirs: &[PathBuf], overrides: &Overrides) -> Result<CommandLine, String> {
    if id == "custom" {
        return overrides
            .commands
            .get("custom")
            .cloned()
            .ok_or_else(|| "Choose the agent's command in Settings first.".to_string());
    }
    let known = Known::from_id(id).ok_or_else(|| format!("Unknown agent: {id}"))?;
    resolve_known(known, dirs, overrides).map(|(_, line)| line).ok_or_else(|| match known {
        Known::Gemini => "Gemini CLI wasn't found. Install it (npm install -g @google/gemini-cli), or choose \
                          its path in Settings."
            .to_string(),
        _ => format!(
            "{} needs Node.js to run its adapter, and neither the adapter nor npx was found. Install Node.js, \
             or choose the adapter's path in Settings.",
            known.name()
        ),
    })
}

// Finding programs

/// The directories to look in. Apps started from the Dock or a launcher don't
/// get the shell's `PATH`, so this adds what a login shell reports and the
/// places Node, Homebrew and the agents usually install to.
pub fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = login_shell_path() {
        dirs.extend(std::env::split_paths(&path));
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    let home = home_dir();
    dirs.extend(usual_dirs(home.as_deref()));
    dedupe_existing(dirs)
}

fn dedupe_existing(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    dirs.into_iter()
        .filter(|dir| dir.is_absolute() && dir.is_dir())
        .filter(|dir| seen.insert(dir.clone()))
        .collect()
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.map(PathBuf::from).filter(|path| path.is_absolute())
}

/// Install locations to try even when they aren't on any `PATH` we can see.
pub fn usual_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(not(windows))]
    {
        for fixed in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/snap/bin",
        ] {
            dirs.push(PathBuf::from(fixed));
        }
        if let Some(home) = home {
            for relative in [
                ".local/bin",
                ".npm-global/bin",
                ".volta/bin",
                ".bun/bin",
                ".asdf/shims",
                ".local/share/mise/shims",
                ".local/share/pnpm",
                "Library/pnpm",
                ".local/share/fnm/aliases/default/bin",
                ".fnm/aliases/default/bin",
                ".claude/local",
            ] {
                dirs.push(home.join(relative));
            }
            dirs.extend(newest_nvm_bin(home));
            if let Some(prefix) = npmrc_prefix(home) {
                dirs.push(prefix.join("bin"));
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            dirs.push(local.join("pnpm"));
            dirs.push(local.join("Volta").join("bin"));
            dirs.push(local.join("Programs").join("nodejs"));
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(program_files).join("nodejs"));
        }
        if let Some(home) = home {
            dirs.push(home.join("scoop").join("shims"));
            dirs.push(home.join(".volta").join("bin"));
            dirs.push(home.join(".bun").join("bin"));
            dirs.push(home.join(".local").join("bin"));
        }
        if let Some(prefix) = home.and_then(npmrc_prefix) {
            dirs.push(prefix);
        }
    }
    dirs
}

/// nvm keeps one directory per Node version and no fixed `bin`. Take the newest.
#[cfg(not(windows))]
fn newest_nvm_bin(home: &Path) -> Option<PathBuf> {
    let versions = std::fs::read_dir(home.join(".nvm/versions/node")).ok()?;
    let mut found: Vec<(Vec<u64>, PathBuf)> = versions
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let parts: Option<Vec<u64>> = name
                .trim_start_matches('v')
                .split('.')
                .map(|part| part.parse().ok())
                .collect();
            Some((parts?, entry.path().join("bin")))
        })
        .collect();
    found.sort();
    found.pop().map(|(_, bin)| bin)
}

/// A `prefix=` line in `~/.npmrc`: where `npm install -g` puts programs.
fn npmrc_prefix(home: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(home.join(".npmrc")).ok()?;
    parse_npmrc_prefix(&text, home)
}

pub fn parse_npmrc_prefix(text: &str, home: &Path) -> Option<PathBuf> {
    text.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        if key.trim() != "prefix" {
            return None;
        }
        let value = value.trim().trim_matches('"');
        let path = match value.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None => PathBuf::from(value),
        };
        path.is_absolute().then_some(path)
    })
}

/// The `PATH` a login shell reports. Run once per search, with a time limit,
/// because a slow or interactive shell profile must not hold Studio up.
#[cfg(not(windows))]
fn login_shell_path() -> Option<std::ffi::OsString> {
    let shell = std::env::var_os("SHELL").filter(|shell| Path::new(shell).is_absolute())?;
    const MARK: &str = "__STUDIO_PATH__";
    let mut child = Command::new(shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < SHELL_PATH_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(25))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let start = out.find(MARK)? + MARK.len();
    let end = start + out[start..].find(MARK)?;
    Some(out[start..end].into())
}

#[cfg(windows)]
fn login_shell_path() -> Option<std::ffi::OsString> {
    None
}

/// The first `program` in `dirs` that can be run.
pub fn which(program: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in dirs {
        for name in candidate_names(program) {
            let path = dir.join(&name);
            if is_runnable(&path) {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(windows)]
fn candidate_names(program: &str) -> Vec<String> {
    ["exe", "cmd", "bat", "com"]
        .iter()
        .map(|ext| format!("{program}.{ext}"))
        .collect()
}

#[cfg(not(windows))]
fn candidate_names(program: &str) -> Vec<String> {
    vec![program.to_string()]
}

#[cfg(unix)]
fn is_runnable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_runnable(path: &Path) -> bool {
    path.is_file()
}

/// A command line the user typed: the program must be an absolute path to a
/// file that can be run.
pub fn parse_chosen(program: &str, args: &[String]) -> Result<CommandLine, String> {
    let program = PathBuf::from(program.trim());
    if !program.is_absolute() {
        return Err("Use the full path to the program.".into());
    }
    if !is_runnable(&program) {
        return Err(format!(
            "{} isn't a program that can be run.",
            program.display()
        ));
    }
    if args
        .iter()
        .any(|arg| arg.contains('\0') || arg.contains('\n'))
    {
        return Err("An argument contains a line break.".into());
    }
    Ok(CommandLine {
        program,
        args: args.to_vec(),
    })
}

// Running sessions

struct Session {
    pid: u32,
    stdin: Option<ChildStdin>,
    stderr: Arc<Mutex<VecDeque<u8>>>,
}

static SESSIONS: Mutex<Option<HashMap<u64, Session>>> = Mutex::new(None);
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

fn with_sessions<T>(work: impl FnOnce(&mut HashMap<u64, Session>) -> T) -> T {
    let mut guard = SESSIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    work(guard.get_or_insert_with(HashMap::new))
}

/// Keep the last `STDERR_TAIL_BYTES` of what the agent wrote to standard error.
fn push_tail(tail: &Mutex<VecDeque<u8>>, bytes: &[u8]) {
    let mut tail = tail.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    tail.extend(bytes);
    let over = tail.len().saturating_sub(STDERR_TAIL_BYTES);
    tail.drain(..over);
}

fn tail_text(tail: &Mutex<VecDeque<u8>>) -> String {
    let tail = tail.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let bytes: Vec<u8> = tail.iter().copied().collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Read newline-delimited lines, calling `line` for each. A line over
/// `max` bytes is skipped whole and reported through `too_long`.
pub fn read_lines(
    reader: impl Read,
    max: usize,
    mut line: impl FnMut(String),
    mut too_long: impl FnMut(),
) {
    let mut reader = BufReader::new(reader);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let mut skipping = false;
        let mut ended = false;
        loop {
            let available = match reader.fill_buf() {
                Ok([]) => {
                    ended = true;
                    break;
                }
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return,
            };
            let (chunk, done) = match available.iter().position(|&byte| byte == b'\n') {
                Some(at) => (&available[..at], at + 1),
                None => (available, available.len()),
            };
            let newline = done > chunk.len();
            if !skipping {
                if buffer.len() + chunk.len() > max {
                    skipping = true;
                    buffer.clear();
                } else {
                    buffer.extend_from_slice(chunk);
                }
            }
            reader.consume(done);
            if newline {
                break;
            }
        }
        if skipping {
            too_long();
        } else {
            let text = String::from_utf8_lossy(&buffer);
            let text = text.trim_end_matches('\r');
            if !text.trim().is_empty() {
                line(text.to_string());
            }
        }
        if ended {
            return;
        }
    }
}

fn spawn_command(line: &CommandLine, cwd: &Path, dirs: &[PathBuf]) -> std::io::Result<Child> {
    let mut command = Command::new(&line.program);
    command
        .args(&line.args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The agent and the adapters find `node`, `git` and the like on `PATH`, so
    // it gets the same search path the agent was found with.
    if let Ok(path) = std::env::join_paths(dirs) {
        command.env("PATH", path);
    }
    #[cfg(unix)]
    {
        // Its own process group, so stopping it stops what it started too.
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()
}

/// Stop a process and everything it started.
fn kill_tree(pid: u32, force: bool) {
    #[cfg(unix)]
    {
        let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
        let Ok(group) = i32::try_from(pid) else {
            return;
        };
        // SAFETY: `kill` has no memory effects; a negative pid names the
        // process group `spawn_command` created for this agent.
        unsafe {
            libc::kill(-group, signal);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = force;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Whether the process is still there.
fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Ok(group) = i32::try_from(pid) else {
            return false;
        };
        // SAFETY: signal 0 only checks that the process group exists.
        unsafe { libc::kill(-group, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// End a session: close its input, give it a moment, then stop it and its children.
fn stop_session(id: u64) -> bool {
    let Some(mut session) = with_sessions(|sessions| sessions.remove(&id)) else {
        return false;
    };
    // Closing standard input is how an ACP agent is asked to finish.
    drop(session.stdin.take());
    kill_tree(session.pid, false);
    let pid = session.pid;
    std::thread::spawn(move || {
        let started = Instant::now();
        while alive(pid) && started.elapsed() < STOP_GRACE {
            std::thread::sleep(Duration::from_millis(50));
        }
        if alive(pid) {
            kill_tree(pid, true);
        }
    });
    true
}

/// Stop every agent. Called when Studio quits.
pub fn stop_all() {
    let sessions: Vec<Session> =
        with_sessions(|sessions| sessions.drain().map(|(_, session)| session).collect());
    for mut session in sessions {
        drop(session.stdin.take());
        kill_tree(session.pid, true);
    }
}

// Files

fn agent_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // A subdirectory on purpose: `store_write` only takes plain file names, so the
    // web view can't change what this file says Studio may run.
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("no app config dir: {error}"))?
        .join("agent");
    std::fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    Ok(dir)
}

fn load_overrides(app: &tauri::AppHandle) -> Overrides {
    agent_dir(app)
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("commands.json")).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_overrides(app: &tauri::AppHandle, overrides: &Overrides) -> Result<(), String> {
    let path = agent_dir(app)?.join("commands.json");
    let text = serde_json::to_string_pretty(overrides).map_err(|error| error.to_string())?;
    std::fs::write(&path, text).map_err(|error| format!("{}: {error}", path.display()))
}

/// The folder an agent works in when the user hasn't chosen one: empty, and
/// outside Studio's own settings, so the agent finds nothing there it shouldn't.
fn default_workspace(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("no app cache dir: {error}"))?
        .join("agent-workspace");
    std::fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    Ok(dir)
}

pub fn check_workspace(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.is_dir() {
        return Err(format!("{} isn't a folder.", path.display()));
    }
    Ok(path)
}

// Commands

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agents {
    pub agents: Vec<AgentInfo>,
    pub default_workspace: String,
}

/// The agents Studio can start, and how. Searches again each time it's asked.
#[tauri::command]
pub async fn acp_agents(app: tauri::AppHandle) -> Result<Agents, String> {
    let overrides = load_overrides(&app);
    let workspace = default_workspace(&app)?;
    let agents = tauri::async_runtime::spawn_blocking(move || describe(&search_dirs(), &overrides))
        .await
        .map_err(|error| error.to_string())?;
    Ok(Agents {
        agents,
        default_workspace: workspace.display().to_string(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub session: u64,
    pub command: String,
    pub cwd: String,
}

/// Start an agent. Lines it writes arrive as `studio://acp-data`.
#[tauri::command]
pub async fn acp_start(
    app: tauri::AppHandle,
    agent: String,
    cwd: Option<String>,
) -> Result<Started, String> {
    let overrides = load_overrides(&app);
    let cwd = match cwd.filter(|cwd| !cwd.trim().is_empty()) {
        Some(cwd) => check_workspace(&cwd)?,
        None => default_workspace(&app)?,
    };
    let (line, dirs) = {
        let agent = agent.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let dirs = search_dirs();
            resolve(&agent, &dirs, &overrides).map(|line| (line, dirs))
        })
        .await
        .map_err(|error| error.to_string())??
    };
    let mut child = spawn_command(&line, &cwd, &dirs)
        .map_err(|error| format!("Couldn't start {}: {error}", line.program.display()))?;
    let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    let stdout = child
        .stdout
        .take()
        .ok_or("The agent has no output to read.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("The agent has no error output to read.")?;
    let tail = Arc::new(Mutex::new(VecDeque::new()));
    with_sessions(|sessions| {
        sessions.insert(
            id,
            Session {
                pid: child.id(),
                stdin: child.stdin.take(),
                stderr: Arc::clone(&tail),
            },
        );
    });

    {
        let app = app.clone();
        std::thread::spawn(move || {
            read_lines(
                stdout,
                MAX_LINE_BYTES,
                |line| {
                    let _ = app.emit(DATA_EVENT, json!({ "session": id, "line": line }));
                },
                || {
                    let _ = app.emit(DATA_EVENT, json!({ "session": id, "tooLong": true }));
                },
            );
        });
    }
    {
        let tail = Arc::clone(&tail);
        std::thread::spawn(move || {
            let mut stderr = stderr;
            let mut buffer = [0u8; 4096];
            while let Ok(read) = stderr.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                push_tail(&tail, &buffer[..read]);
            }
        });
    }
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().and_then(|status| status.code());
            // Whatever it started goes with it.
            let pid = child.id();
            let known = with_sessions(|sessions| sessions.remove(&id)).is_some();
            if known {
                kill_tree(pid, true);
            }
            let _ = app.emit(
                EXIT_EVENT,
                json!({ "session": id, "code": code, "stderr": tail_text(&tail) }),
            );
        });
    }
    Ok(Started {
        session: id,
        command: line.display(),
        cwd: cwd.display().to_string(),
    })
}

/// Write one JSON-RPC message to the agent.
#[tauri::command]
pub fn acp_send(session: u64, line: String) -> Result<(), String> {
    if line.contains('\n') {
        return Err("A message must be a single line.".into());
    }
    with_sessions(|sessions| {
        let stdin = sessions
            .get_mut(&session)
            .and_then(|session| session.stdin.as_mut())
            .ok_or("The agent isn't running.")?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush())
            .map_err(|error| format!("Couldn't write to the agent: {error}"))
    })
}

#[tauri::command]
pub fn acp_stop(session: u64) -> bool {
    stop_session(session)
}

/// What the agent wrote to standard error lately, for explaining a failure.
#[tauri::command]
pub fn acp_stderr(session: u64) -> Option<String> {
    with_sessions(|sessions| {
        sessions
            .get(&session)
            .map(|session| tail_text(&session.stderr))
    })
}

/// Choose the program for an agent by hand. Asks the user natively first,
/// showing the exact command, so nothing but the user can decide what runs.
#[tauri::command]
pub async fn acp_choose_command(
    app: tauri::AppHandle,
    agent: String,
    program: String,
    args: Vec<String>,
) -> Result<bool, String> {
    if agent != "custom" && Known::from_id(&agent).is_none() {
        return Err(format!("Unknown agent: {agent}"));
    }
    let line = parse_chosen(&program, &args)?;
    let name = Known::from_id(&agent).map_or("the chat panel", Known::name);
    let confirmed = confirm(
        &app,
        "Let Studio start this program?",
        &format!(
            "Studio will run this command for {name} when you start a chat:\n\n{}\n\nIt runs with your user's \
             permissions. Only continue if you trust it.",
            line.display()
        ),
    )
    .await?;
    if !confirmed {
        return Ok(false);
    }
    let mut overrides = load_overrides(&app);
    overrides.commands.insert(agent, line);
    save_overrides(&app, &overrides)?;
    Ok(true)
}

/// Forget a program chosen by hand.
#[tauri::command]
pub fn acp_clear_command(app: tauri::AppHandle, agent: String) -> Result<(), String> {
    let mut overrides = load_overrides(&app);
    overrides.commands.remove(&agent);
    save_overrides(&app, &overrides)
}

async fn confirm(app: &tauri::AppHandle, title: &str, message: &str) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let (sender, receiver) = std::sync::mpsc::channel();
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Allow".into(),
            "Cancel".into(),
        ))
        .show(move |ok| {
            let _ = sender.send(ok);
        });
    tauri::async_runtime::spawn_blocking(move || receiver.recv().unwrap_or(false))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("studio-acp-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn program(dir: &Path, name: &str) -> PathBuf {
        #[cfg(windows)]
        let path = dir.join(format!("{name}.cmd"));
        #[cfg(not(windows))]
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[test]
    fn finds_a_program_in_the_first_directory_that_has_it() {
        let first = temp_dir("which-a");
        let second = temp_dir("which-b");
        let wanted = program(&second, "claude-agent-acp");
        program(&second, "npx");
        assert_eq!(
            which("claude-agent-acp", &[first.clone(), second.clone()]),
            Some(wanted)
        );
        assert_eq!(which("codex-acp", &[first, second]), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_that_cant_be_run_is_not_a_program() {
        let dir = temp_dir("which-noexec");
        std::fs::write(dir.join("gemini"), "not a program").unwrap();
        assert_eq!(which("gemini", &[dir]), None);
    }

    #[test]
    fn an_installed_adapter_wins_over_npx() {
        let dir = temp_dir("resolve-installed");
        let adapter = program(&dir, "claude-agent-acp");
        program(&dir, "npx");
        let line = resolve("claude", &[dir], &Overrides::default()).unwrap();
        assert_eq!(line.program, adapter);
        assert!(line.args.is_empty());
    }

    #[test]
    fn without_the_adapter_npx_runs_the_pinned_version() {
        let dir = temp_dir("resolve-npx");
        let npx = program(&dir, "npx");
        let line = resolve("codex", &[dir], &Overrides::default()).unwrap();
        assert_eq!(line.program, npx);
        assert_eq!(line.args, vec!["-y".to_string(), CODEX_ADAPTER.to_string()]);
        assert!(
            CODEX_ADAPTER.contains('@') && CODEX_ADAPTER.rsplit('@').next().unwrap().contains('.')
        );
    }

    #[test]
    fn gemini_needs_its_own_program_and_is_started_in_acp_mode() {
        let dir = temp_dir("resolve-gemini");
        program(&dir, "npx");
        let error =
            resolve("gemini", std::slice::from_ref(&dir), &Overrides::default()).unwrap_err();
        assert!(error.contains("Gemini CLI wasn't found"));
        program(&dir, "gemini");
        let line = resolve("gemini", &[dir], &Overrides::default()).unwrap();
        assert_eq!(line.args, vec!["--acp".to_string()]);
    }

    #[test]
    fn a_chosen_command_wins_and_custom_needs_one() {
        let dir = temp_dir("resolve-chosen");
        program(&dir, "claude-agent-acp");
        let chosen = CommandLine {
            program: PathBuf::from("/opt/agents/claude-acp"),
            args: vec!["--x".into()],
        };
        let mut overrides = Overrides::default();
        overrides.commands.insert("claude".into(), chosen.clone());
        assert_eq!(
            resolve("claude", std::slice::from_ref(&dir), &overrides).unwrap(),
            chosen
        );

        assert!(
            resolve("custom", std::slice::from_ref(&dir), &overrides)
                .unwrap_err()
                .contains("Settings")
        );
        overrides.commands.insert("custom".into(), chosen.clone());
        assert_eq!(
            resolve("custom", std::slice::from_ref(&dir), &overrides).unwrap(),
            chosen
        );
        assert!(
            resolve("rm", &[dir], &overrides)
                .unwrap_err()
                .contains("Unknown agent")
        );
    }

    #[test]
    fn describes_every_agent_and_whether_its_cli_is_there() {
        let dir = temp_dir("describe");
        program(&dir, "npx");
        program(&dir, "claude");
        let agents = describe(&[dir], &Overrides::default());
        let ids: Vec<&str> = agents.iter().map(|agent| agent.id.as_str()).collect();
        assert_eq!(ids, ["claude", "codex", "gemini", "custom"]);
        assert_eq!(agents[0].how, "npx");
        assert!(agents[0].cli_found);
        assert!(!agents[1].cli_found);
        assert_eq!(agents[2].how, "missing");
        assert_eq!(agents[2].command, "");
        assert_eq!(agents[3].how, "missing");
    }

    #[test]
    fn a_chosen_program_must_be_an_absolute_runnable_path() {
        let dir = temp_dir("chosen");
        let path = program(&dir, "my-agent");
        assert!(
            parse_chosen("my-agent", &[])
                .unwrap_err()
                .contains("full path")
        );
        assert!(parse_chosen(&dir.join("nope").display().to_string(), &[]).is_err());
        assert!(parse_chosen(&path.display().to_string(), &["a\nb".into()]).is_err());
        let line = parse_chosen(&path.display().to_string(), &["--acp".into()]).unwrap();
        assert_eq!(line.args, vec!["--acp".to_string()]);
    }

    #[test]
    fn shows_a_command_with_quoted_arguments() {
        let line = CommandLine {
            program: PathBuf::from("/usr/bin/npx"),
            args: vec!["-y".into(), "a b".into()],
        };
        assert_eq!(line.display(), "/usr/bin/npx -y \"a b\"");
    }

    #[test]
    fn reads_the_npm_prefix() {
        // Absolute on every platform: "/home/me" isn't absolute on Windows.
        let home = std::env::temp_dir().join("studio-acp-home");
        let home = home.as_path();
        let elsewhere = std::env::temp_dir().join("npm");
        assert_eq!(
            parse_npmrc_prefix("color=true\nprefix=~/.npm-global\n", home),
            Some(home.join(".npm-global"))
        );
        assert_eq!(
            parse_npmrc_prefix(&format!("prefix = \"{}\"", elsewhere.display()), home),
            Some(elsewhere)
        );
        assert_eq!(parse_npmrc_prefix("prefix=relative", home), None);
        assert_eq!(parse_npmrc_prefix("", home), None);
    }

    #[cfg(not(windows))]
    #[test]
    fn looks_in_the_usual_install_places() {
        let home = Path::new("/home/me");
        let dirs = usual_dirs(Some(home));
        for expected in ["/opt/homebrew/bin", "/usr/local/bin"] {
            assert!(dirs.contains(&PathBuf::from(expected)), "{expected}");
        }
        assert!(dirs.contains(&home.join(".local/bin")));
        assert!(dirs.contains(&home.join(".volta/bin")));
    }

    #[test]
    fn keeps_only_existing_absolute_directories_once() {
        let dir = temp_dir("dedupe");
        let kept = dedupe_existing(vec![
            dir.clone(),
            PathBuf::from("relative"),
            dir.join("missing"),
            dir.clone(),
        ]);
        assert_eq!(kept, vec![dir]);
    }

    #[test]
    fn splits_lines_and_skips_one_that_is_too_long() {
        let input = format!("{{\"a\":1}}\r\n\n{}\n{{\"b\":2}}", "x".repeat(50));
        let mut lines = Vec::new();
        let mut dropped = 0;
        read_lines(
            Cursor::new(input),
            20,
            |line| lines.push(line),
            || dropped += 1,
        );
        assert_eq!(
            lines,
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );
        assert_eq!(dropped, 1);
    }

    #[test]
    fn keeps_only_the_end_of_standard_error() {
        let tail = Mutex::new(VecDeque::new());
        push_tail(&tail, &vec![b'a'; STDERR_TAIL_BYTES]);
        push_tail(&tail, b"the end");
        let text = tail_text(&tail);
        assert_eq!(text.len(), STDERR_TAIL_BYTES);
        assert!(text.ends_with("the end"));
    }

    #[test]
    fn a_workspace_must_be_an_existing_absolute_folder() {
        let dir = temp_dir("workspace");
        assert_eq!(check_workspace(&dir.display().to_string()).unwrap(), dir);
        assert!(check_workspace("relative/folder").is_err());
        assert!(check_workspace(&dir.join("missing").display().to_string()).is_err());
    }

    /// Start a real process the way an agent is started, then stop it and check
    /// that what it started went too.
    #[cfg(unix)]
    #[test]
    fn stopping_an_agent_stops_its_children() {
        let dir = temp_dir("tree");
        let script = dir.join("agent.sh");
        let marker = dir.join("child.pid");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nsleep 30 &\necho $! > {}\nwait\n",
                marker.display()
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let line = CommandLine {
            program: script,
            args: vec![],
        };
        let mut child = spawn_command(
            &line,
            &dir,
            &[PathBuf::from("/bin"), PathBuf::from("/usr/bin")],
        )
        .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let grandchild: i32 = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // SAFETY: signal 0 only checks that the process exists.
        assert_eq!(unsafe { libc::kill(grandchild, 0) }, 0);

        kill_tree(child.id(), false);
        let _ = child.wait();
        let started = Instant::now();
        // SAFETY: as above.
        while unsafe { libc::kill(grandchild, 0) } == 0
            && started.elapsed() < Duration::from_secs(5)
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        // SAFETY: as above.
        assert_ne!(
            unsafe { libc::kill(grandchild, 0) },
            0,
            "the agent's child is still running"
        );
    }

    /// The whole relay with a stand-in agent: lines in, lines out, in order.
    #[cfg(unix)]
    #[test]
    fn passes_lines_through_a_running_agent() {
        let dir = temp_dir("relay");
        let script = dir.join("echo.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n",
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let line = CommandLine {
            program: script,
            args: vec![],
        };
        let mut child = spawn_command(
            &line,
            &dir,
            &[PathBuf::from("/bin"), PathBuf::from("/usr/bin")],
        )
        .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1}\n{\"jsonrpc\":\"2.0\",\"id\":2}\n")
            .unwrap();
        drop(stdin);
        let mut lines = Vec::new();
        read_lines(stdout, MAX_LINE_BYTES, |line| lines.push(line), || {});
        let _ = child.wait();
        assert_eq!(
            lines,
            vec![
                "{\"jsonrpc\":\"2.0\",\"id\":1}",
                "{\"jsonrpc\":\"2.0\",\"id\":2}"
            ]
        );
    }
}
