use std::fs;
use std::io;
use std::io::BufRead;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Stdio;
use std::path::PathBuf;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::thread;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as TokioBufReader};
use tokio::time::{timeout, Duration};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use reqwest::Client;
use zip::ZipArchive;
use sha2::{Digest, Sha256};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::Rng;

mod ai_model_capabilities;
mod openai_response_parser;

// --- Helpers ---------------------------------------------------------------

/// Attempts to resolve the latest stable version of a NuGet package.
/// Uses the NuGet flat-container index (returns versions sorted ascending).
/// Filters out pre-release versions (containing '-').
/// Falls back to `fallback` on any error.
fn resolve_nuget_version(package: &str, fallback: &str) -> String {
    let url = format!(
        "https://api.nuget.org/v3-flatcontainer/{}/index.json",
        package.to_lowercase()
    );
    let result: Option<String> = (|| -> Option<String> {
        let resp = reqwest::blocking::get(&url).ok()?;
        if !resp.status().is_success() { return None; }
        let json: Value = resp.json().ok()?;
        let versions = json["versions"].as_array()?;
        // Versions are sorted ascending; walk from the end to find the latest stable
        versions.iter().rev()
            .filter_map(|v| v.as_str())
            .find(|v| !v.contains('-'))
            .map(|v| v.to_string())
    })();
    result.unwrap_or_else(|| fallback.to_string())
}

/// Returns the app data directory, creating it if it does not exist.
fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Reads a JSON file and returns its parsed value, or `Value::Null` if the
/// file does not exist yet.
fn read_json(path: &PathBuf) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Null);
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// Serialises a value as pretty-printed JSON and writes it to disk.
fn write_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

/// Prevents a console window from flashing when spawning console programs on Windows.
/// On Windows GUI apps, any child process that is a console application (git, cmd, â€¦)
/// will briefly show a console window unless CREATE_NO_WINDOW is set.
/// This is a no-op on other platforms.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
fn hide_console_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_console_window(_cmd: &mut std::process::Command) {}

// --- Tasks -----------------------------------------------------------------

#[tauri::command]
fn load_tasks(app: tauri::AppHandle) -> Result<Value, String> {
    let dir  = app_data_dir(&app)?;
    let path = dir.join("tasks.json");

    // Clean up any stale temp file left by an interrupted atomic write.
    let tmp_path = path.with_extension("tmp");
    if tmp_path.exists() {
        let _ = fs::remove_file(&tmp_path);
    }

    let value = read_json(&path)?;
    if value.is_null() {
        Ok(Value::Array(vec![]))
    } else {
        Ok(value)
    }
}

/// Normal save â€” refuses to overwrite a non-empty tasks.json with an empty array.
/// Use `clear_all_tasks` for an intentional reset.
#[tauri::command]
fn save_tasks(app: tauri::AppHandle, tasks: Value) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    save_tasks_impl(&dir, &tasks, false)
}

/// Explicitly clears all tasks.  Bypasses the empty-overwrite guard.
/// Only called from an intentional "reset all data" UI action.
#[tauri::command]
fn clear_all_tasks(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    save_tasks_impl(&dir, &Value::Array(vec![]), true)
}

/// Core task-save logic.  `allow_empty_overwrite` must be true to replace a
/// non-empty tasks.json with []; normal saves always pass false.
fn save_tasks_impl(dir: &PathBuf, tasks: &Value, allow_empty_overwrite: bool) -> Result<(), String> {
    let path = dir.join("tasks.json");

    let existing_count = count_tasks_on_disk(&path)?;
    let incoming_count = json_array_len(tasks);

    // Guard: refuse to silently replace a non-empty store with an empty array.
    // This is the second line of defence after the React-side load-failure guard.
    if existing_count > 0 && incoming_count == 0 && !allow_empty_overwrite {
        return Err(format!(
            "ERR_EMPTY_OVERWRITE: refused to replace {} existing tasks with an empty array. \
             Use the explicit clear_all_tasks action for an intentional reset.",
            existing_count,
        ));
    }

    // Backup the current file before overwriting.
    if path.exists() {
        let ts    = now_unix();
        let bname = format!("tasks.backup-{}.json", ts);
        fs::copy(&path, dir.join(&bname)).map_err(|e| format!("backup tasks.json: {}", e))?;
        prune_task_backups(dir, 5);
    }

    // Atomic write: write to a temp file then rename so a crash mid-write
    // leaves the previous tasks.json intact.
    atomic_write_json(&path, tasks)
}

/// Writes JSON atomically: writes to a .tmp sibling then renames over the target.
fn atomic_write_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let raw = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&tmp, &raw).map_err(|e| format!("write temp: {}", e))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("atomic rename: {}", e)
    })
}

/// Returns the number of items in a JSON array value; 0 for non-arrays.
fn json_array_len(v: &Value) -> usize {
    match v {
        Value::Array(arr) => arr.len(),
        _ => 0,
    }
}

/// Reads tasks.json and counts items.  Returns 0 if the file does not exist.
fn count_tasks_on_disk(path: &PathBuf) -> Result<usize, String> {
    if !path.exists() {
        return Ok(0);
    }
    Ok(json_array_len(&read_json(path)?))
}

/// Returns all tasks.backup-*.json paths in `dir`, sorted ascending by name.
fn list_task_backups(dir: &PathBuf) -> Vec<PathBuf> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let mut backups: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("tasks.backup-") && n.ends_with(".json"))
                .unwrap_or(false)
        })
        .collect();
    backups.sort();
    backups
}

/// Keeps only the most-recent `keep` backup files; silently removes older ones.
fn prune_task_backups(dir: &PathBuf, keep: usize) {
    let mut backups = list_task_backups(dir);
    while backups.len() > keep {
        let _ = fs::remove_file(&backups[0]);
        backups.remove(0);
    }
}

/// Diagnostic info returned by `check_task_storage`.
#[derive(Serialize)]
struct TaskStorageStatus {
    /// Tasks currently in tasks.json (0 if file is absent or empty).
    task_count: usize,
    /// Number of tasks.backup-*.json files present.
    backup_count: usize,
    /// True when tasks.json has 0 tasks but at least one backup has tasks.
    /// Likely indicates accidental data loss that can be auto-restored.
    empty_with_nonempty_backups: bool,
    /// Task count in the most-recent non-empty backup, if any.
    newest_backup_task_count: usize,
}

fn check_task_storage_impl(dir: &PathBuf) -> Result<TaskStorageStatus, String> {
    let path = dir.join("tasks.json");

    let task_count = if path.exists() { count_tasks_on_disk(&path)? } else { 0 };

    let backups = list_task_backups(dir);
    let backup_count = backups.len();

    let mut newest_backup_task_count = 0usize;
    let empty_with_nonempty_backups = if task_count == 0 && backup_count > 0 {
        backups.iter().rev().any(|bp| {
            if let Ok(v) = read_json(bp) {
                let n = json_array_len(&v);
                if n > 0 {
                    newest_backup_task_count = n;
                    return true;
                }
            }
            false
        })
    } else {
        false
    };

    Ok(TaskStorageStatus {
        task_count,
        backup_count,
        empty_with_nonempty_backups,
        newest_backup_task_count,
    })
}

/// Returns storage diagnostics so the UI can warn the user when tasks.json is
/// empty but non-empty backups exist (possible accidental data loss).
#[tauri::command]
fn check_task_storage(app: tauri::AppHandle) -> Result<TaskStorageStatus, String> {
    let dir = app_data_dir(&app)?;
    check_task_storage_impl(&dir)
}

/// Copies the most-recent non-empty tasks.backup-*.json back to tasks.json.
/// Returns the number of tasks restored.
#[tauri::command]
fn restore_tasks_from_latest_backup(app: tauri::AppHandle) -> Result<usize, String> {
    let dir  = app_data_dir(&app)?;
    let path = dir.join("tasks.json");

    let backups = list_task_backups(&dir);
    let source = backups.iter().rev()
        .find(|bp| read_json(bp).map(|v| json_array_len(&v) > 0).unwrap_or(false))
        .ok_or_else(|| "No non-empty backup found to restore from".to_string())?
        .clone();

    let restored = read_json(&source)?;
    let count    = json_array_len(&restored);
    atomic_write_json(&path, &restored)?;
    Ok(count)
}

// --- Customers -------------------------------------------------------------

#[tauri::command]
fn load_customers(app: tauri::AppHandle) -> Result<Value, String> {
    let path = app_data_dir(&app)?.join("customers.json");
    let value = read_json(&path)?;
    if value.is_null() {
        Ok(Value::Array(vec![]))
    } else {
        Ok(value)
    }
}

#[tauri::command]
fn save_customers(app: tauri::AppHandle, customers: Value) -> Result<(), String> {
    let path = app_data_dir(&app)?.join("customers.json");
    write_json(&path, &customers)
}

// --- CRM folder listing ---------------------------------------------------

/// Lists immediate subdirectory names under base_dir.
/// Returns an empty list (not an error) when base_dir is empty, does not exist,
/// or is not a directory. Hidden folders (starting with '.') are excluded.
/// Runs on a blocking thread so it never stalls the Tauri main thread.
#[tauri::command]
async fn list_crm_folders(base_dir: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        if base_dir.is_empty() {
            return vec![];
        }
        let path = std::path::Path::new(&base_dir);
        if !path.is_dir() {
            return vec![];
        }
        let mut folders: Vec<String> = std::fs::read_dir(path)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .filter_map(|e| e.file_name().to_str().map(|s| s.to_owned()))
                    .filter(|name| !name.starts_with('.'))
                    .collect()
            })
            .unwrap_or_default();
        folders.sort();
        folders
    })
    .await
    .unwrap_or_default()
}

// --- Settings --------------------------------------------------------------

fn default_settings() -> Value {
    serde_json::json!({
        "appName": "Task Workbench",
        "theme": "dark",
        "defaultTaskConfidence": 80,
        // Legacy fields â€” kept for backward compatibility
        "aiModel": "",
        "aiApiKey": "",
        // Multi-provider AI config
        "activeAiProvider": "openai",
        "openaiApiKey": "",
        "openaiModel": "gpt-4.1-mini",
        "anthropicApiKey": "",
        "anthropicModel": "claude-sonnet-4-5",
        // CRM Metadata / Primarch MCP
        "crmMetadataEnabled": false,
        "primarchMcpCommand": "",
        "primarchMcpArgs": "",
        "primarchMcpWorkingDirectory": "",
        "primarchMcpReadOnly": true,
        "primarchMcpLastStatus": "not_configured",
        "primarchMcpLastError": null,
        // Other existing fields
        "crmBaseDirectory": "",
        "repositoryTemplate": "",
        "repositoryTemplateType": "none",
        "repositoryTemplatePath": "",
        "initializeGitOnCreate": true,
        "defaultGitBranch": "main",
        "createInitialCommit": false,
        "microsoftTenant": "",
        "graphEnabled": false,
        "m365AccountEmail": "",
        "outlookStatus": "not_configured",
        "teamsStatus": "not_configured"
    })
}

fn merge_settings_defaults(defaults: &Value, current: &Value) -> Value {
    match (defaults, current) {
        (Value::Object(default_map), Value::Object(current_map)) => {
            let mut merged = serde_json::Map::new();
            for (key, default_value) in default_map {
                if let Some(current_value) = current_map.get(key) {
                    merged.insert(key.clone(), merge_settings_defaults(default_value, current_value));
                } else {
                    merged.insert(key.clone(), default_value.clone());
                }
            }
            for (key, current_value) in current_map {
                if !merged.contains_key(key) {
                    merged.insert(key.clone(), current_value.clone());
                }
            }
            Value::Object(merged)
        }
        _ => current.clone(),
    }
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<Value, String> {
    let path = app_data_dir(&app)?.join("settings.json");
    let value = read_json(&path)?;
    let defaults = default_settings();
    if value.is_null() {
        write_json(&path, &defaults)?;
        Ok(defaults)
    } else {
        let merged = merge_settings_defaults(&defaults, &value);
        if merged != value {
            write_json(&path, &merged)?;
        }
        Ok(merged)
    }
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: Value) -> Result<(), String> {
    let path = app_data_dir(&app)?.join("settings.json");
    write_json(&path, &settings)
}

// --- Filesystem actions ----------------------------------------------------

/// Opens a folder path in the operating-system file explorer.
/// Returns an error if the path does not exist.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path not found: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// Opens a folder path in VS Code by running `code <path>`.
///
/// On Windows, VS Code ships as `code.cmd` (a batch script), not a native
/// executable. `Command::new("code")` cannot find `.cmd` files without going
/// through a shell, so we always delegate to `cmd /c code <path>` on Windows.
/// On macOS/Linux, `code` is a normal shell wrapper â€” direct exec is fine.
#[tauri::command]
fn open_in_vscode(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path not found: {path}"));
    }

    #[cfg(target_os = "windows")]
    let result = {
        eprintln!("[open_in_vscode] cmd /c code \"{}\"", path);
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/c", "code", &path]);
        hide_console_window(&mut cmd);
        cmd.spawn()
    };

    #[cfg(not(target_os = "windows"))]
    let result = {
        eprintln!("[open_in_vscode] code \"{}\"", path);
        std::process::Command::new("code")
            .arg(&path)
            .spawn()
    };

    result.map(|_| ()).map_err(|e| {
        eprintln!("[open_in_vscode] failed: {e}");
        if e.kind() == std::io::ErrorKind::NotFound {
            "VS Code not found. Make sure 'code' is on PATH (run 'code .' in a terminal to verify).".to_string()
        } else {
            format!("Failed to launch VS Code: {e}")
        }
    })
}

/// Opens a workspace folder in VS Code, and optionally also opens a specific file.
/// Runs: code "<workspace_path>" ["<file_path>"]
/// This keeps the workspace context while jumping to the file.
#[tauri::command]
fn open_in_vscode_workspace(workspace_path: String, file_path: Option<String>) -> Result<(), String> {
    let wp = std::path::Path::new(&workspace_path);
    if !wp.exists() {
        return Err(format!("Workspace path not found: {workspace_path}"));
    }

    let mut args: Vec<String> = Vec::new();
    args.push(workspace_path.clone());
    if let Some(ref fp) = file_path {
        let fp_path = std::path::Path::new(fp);
        if fp_path.exists() {
            args.push(fp.clone());
        }
    }

    eprintln!("[open_in_vscode_workspace] code {:?}", args);

    #[cfg(target_os = "windows")]
    let result = {
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/c").arg("code");
        for a in &args { cmd.arg(a); }
        hide_console_window(&mut cmd);
        cmd.spawn()
    };
    #[cfg(not(target_os = "windows"))]
    let result = {
        let mut cmd = std::process::Command::new("code");
        for a in &args { cmd.arg(a); }
        cmd.spawn()
    };

    result.map(|_| ()).map_err(|e| {
        eprintln!("[open_in_vscode_workspace] failed: {e}");
        if e.kind() == std::io::ErrorKind::NotFound {
            "VS Code not found. Make sure 'code' is on PATH.".to_string()
        } else {
            format!("Failed to launch VS Code: {e}")
        }
    })
}

/// Open a file or folder using the OS default application (respects file
/// associations, so .sln opens Visual Studio, .pdf opens a viewer, etc.).
/// Uses `cmd /c start "" "path"` on Windows for correct association handling.
#[tauri::command]
fn open_with_shell(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/c", "start", "", &path]);
        hide_console_window(&mut cmd);
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open with shell: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open with shell: {e}"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open with shell: {e}"))
    }
}

/// Opens an external web URL in Microsoft Edge.
/// Only http/https URLs are accepted, and the URL is passed as a single process
/// argument so no shell command can be injected through it.
#[tauri::command]
fn open_url_in_edge(url: String) -> Result<(), String> {
    let trimmed = url.trim().to_string();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("Only http:// and https:// URLs can be opened.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let edge_paths = [
            "msedge",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ];

        for edge_path in edge_paths {
            match std::process::Command::new(edge_path).arg(&trimmed).spawn() {
                Ok(_) => return Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => continue,
            }
        }

        Err("Microsoft Edge could not be started.".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Microsoft Edge could not be started.".to_string())
    }
}

// --- Git helpers -----------------------------------------------------------

/// Helper: run a git command in repo_path; return trimmed stdout or an error string.
fn git_run(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let p = std::path::Path::new(repo_path);
    if !p.exists() {
        return Err(format!("Repository path not found: {repo_path}"));
    }
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(repo_path).args(args);
    hide_console_window(&mut cmd);
    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "git is not installed or not on PATH.".to_string()
        } else {
            format!("Failed to run git: {e}")
        }
    })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr)
            .trim()
            .to_string())
    }
}

/// Returns `true` when the repository has at least one commit (HEAD resolves to a commit).
/// Returns `false` for a valid but empty (no-commits / unborn-branch) repository.
/// Never throws â€” callers may safely treat any error as `false`.
#[tauri::command]
fn git_has_head(repo_path: String) -> bool {
    if !std::path::Path::new(&repo_path).exists() { return false; }
    run_git_ro(&repo_path, &["rev-parse", "--verify", "HEAD"]).is_some()
}

/// Returns the name of the currently checked-out branch.
/// Fails when the path is not a git repository or git is not available.
/// Runs on a blocking thread so it never stalls the Tauri main thread.
#[tauri::command]
async fn get_git_branch(repo_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let branch = git_run(&repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
        if branch.is_empty() {
            Err("Could not determine current branch.".to_string())
        } else {
            Ok(branch)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Returns the name of the currently checked-out branch by reading `.git/HEAD`
/// directly â€” no git process is spawned, so this is instantaneous even on
/// large repositories. Falls back to a short SHA prefix when HEAD is detached.
#[tauri::command]
fn get_git_branch_quick(repo_path: String) -> Result<String, String> {
    let head_path = std::path::Path::new(&repo_path).join(".git").join("HEAD");
    if !head_path.exists() {
        return Err(format!("Not a git repository (no .git/HEAD): {repo_path}"));
    }
    let content = fs::read_to_string(&head_path)
        .map_err(|e| format!("Cannot read .git/HEAD: {e}"))?;
    let content = content.trim();
    if let Some(branch) = content.strip_prefix("ref: refs/heads/") {
        Ok(branch.to_string())
    } else {
        // Detached HEAD â€” show abbreviated SHA so the UI shows something useful.
        let sha = content.get(..8).unwrap_or(content);
        Ok(format!("(detached {})", sha))
    }
}

/// Returns a sorted list of local branch names (the `*` marker is stripped).
/// Runs on a blocking thread so it never stalls the Tauri main thread.
#[tauri::command]
async fn list_git_branches(repo_path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw = git_run(&repo_path, &["branch", "--list"])?;
        let mut branches: Vec<String> = raw
            .lines()
            .map(|l| l.trim_start_matches('*').trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        branches.sort();
        Ok(branches)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Returns true when the working tree has uncommitted changes (staged or unstaged).
/// Untracked files are intentionally excluded (`-uno`) to avoid the expensive
/// untracked-file scan that makes `git status --short` slow on large repos.
/// Runs on a blocking thread so it never stalls the Tauri main thread.
#[tauri::command]
async fn git_has_uncommitted(repo_path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = git_run(&repo_path, &["status", "--porcelain=v1", "-uno"])?;
        Ok(!out.is_empty())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Checks out the given branch in the repository.
/// Returns an error when the branch does not exist or there are conflicts.
/// Runs on a blocking thread so it never stalls the Tauri main thread.
#[tauri::command]
async fn git_checkout_branch(repo_path: String, branch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_run(&repo_path, &["checkout", &branch]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Returns the Git diff for the repository (or a specific file within it).
///
/// Combines unstaged (`git diff`) and staged (`git diff --cached`) changes so
/// that the caller always gets all pending modifications regardless of staging
/// state. Empty string is returned when there are no pending changes.
///
/// # Errors
/// - `repo_path` does not exist.
/// - `repo_path` is not a Git repository.
/// - `git` is not installed / not on PATH.
#[tauri::command]
fn get_git_diff(repo_path: String, file_path: Option<String>) -> Result<String, String> {
    let p = std::path::Path::new(&repo_path);
    if !p.exists() {
        return Err(format!("Repository path does not exist: {repo_path}"));
    }
    if !p.join(".git").exists() {
        return Err(format!("'{repo_path}' is not a Git repository (no .git directory found)."));
    }

    // Normalize repo_path: canonicalize slashes for comparison.
    let repo_norm = repo_path.replace('\\', "/").trim_end_matches('/').to_string();
    eprintln!("[get_git_diff] repo={repo_norm}");

    // Detect whether HEAD exists (a brand-new repo with no commits has an unborn branch).
    // Some git versions fail `git diff --cached` with "fatal: ambiguous argument 'HEAD'"
    // on an unborn branch.  In that case we return empty diff rather than surfacing the error.
    let head_exists = run_git_ro(&repo_norm, &["rev-parse", "--verify", "HEAD"]).is_some();

    // Resolve file_path to a repo-relative pathspec.
    let relative_file: Option<String> = match file_path {
        None => None,
        Some(ref fp) => {
            let fp_norm = fp.replace('\\', "/");
            eprintln!("[get_git_diff] file={fp_norm}");

            // If the path looks absolute (starts with / or drive letter like C:/)
            let looks_absolute = fp_norm.starts_with('/') ||
                fp_norm.get(1..3).map_or(false, |s| s == ":/");

            if looks_absolute {
                // Strip the repo prefix to produce a relative path.
                let prefix = format!("{}/", repo_norm);
                if let Some(rel) = fp_norm.strip_prefix(&prefix) {
                    let rel = rel.to_string();
                    eprintln!("[get_git_diff] relative={rel}");
                    Some(rel)
                } else if fp_norm == repo_norm {
                    // Path IS the repo root â€” diff the whole repo.
                    eprintln!("[get_git_diff] relative=(whole repo)");
                    None
                } else {
                    return Err("Selected file is outside the Git repository.".to_string());
                }
            } else {
                // Already relative â€” normalize slashes only.
                eprintln!("[get_git_diff] relative={fp_norm} (already relative)");
                Some(fp_norm)
            }
        }
    };

    // Helper: run git diff with the given extra args and return raw stdout.
    let run_diff = |extra: &[&str]| -> Result<String, String> {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(&repo_path).arg("diff");
        for a in extra { cmd.arg(a); }
        if let Some(ref rel) = relative_file {
            cmd.arg("--").arg(rel);
        }
        let out = cmd.output().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "git is not installed or not on PATH.".to_string()
            } else {
                format!("Failed to run git: {e}")
            }
        })?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(stderr)
        }
    };

    // On unborn branches, swallow errors rather than propagating "fatal: HEAD" messages.
    let unstaged = match run_diff(&[]) {
        Ok(s)  => s,
        Err(e) => if head_exists { return Err(e); } else { String::new() },
    };
    let staged = match run_diff(&["--cached"]) {
        Ok(s)  => s,
        Err(e) => if head_exists { return Err(e); } else { String::new() },
    };
    eprintln!("[get_git_diff] head={head_exists} unstaged_len={} staged_len={}", unstaged.len(), staged.len());

    // Return combined diff when both halves have content, avoiding duplication.
    let diff = match (unstaged.is_empty(), staged.is_empty()) {
        (false, false) => format!("{unstaged}\n{staged}"),
        (false, true)  => unstaged,
        (true,  false) => staged,
        (true,  true)  => String::new(),
    };
    Ok(diff)
}

// --- Read-only Git review context collection --------------------------------

/// Runs a read-only git command in `working_dir`.  Returns trimmed stdout or `None` on failure.
fn run_git_ro(working_dir: &str, args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    #[cfg(target_os = "windows")]
    hide_console_window(&mut cmd);
    cmd.arg("-C").arg(working_dir);
    for a in args { cmd.arg(a); }
    let out = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        None
    }
}

/// Truncates `s` to at most `max_bytes`, respecting UTF-8 char boundaries.
fn cap_utf8(s: String, max_bytes: usize) -> String {
    if s.len() <= max_bytes { return s; }
    let boundary = (0..=max_bytes).rev().find(|&i| s.is_char_boundary(i)).unwrap_or(0);
    format!("{}\n\nâ€¦ [truncated at {} KB]", &s[..boundary], max_bytes / 1024)
}

/// Probes common base-branch names and returns the first that exists in the repo.
fn detect_base_branch(repo: &str) -> String {
    for c in &["origin/main", "main", "origin/master", "master"] {
        if run_git_ro(repo, &["rev-parse", "--verify", c]).is_some() {
            return c.to_string();
        }
    }
    "HEAD~1".to_string()
}

/// Returns `true` for paths that are typically generated/cache noise in .NET repositories.
fn is_repo_noise(path: &str) -> bool {
    let p = path.to_lowercase().replace('\\', "/");
    p.starts_with("bin/")       || p.contains("/bin/")      ||
    p.starts_with("obj/")       || p.contains("/obj/")      ||
    p.starts_with("packages/")  || p.contains("/packages/") ||
    p.starts_with(".vs/")       || p.contains("/.vs/")      ||
    p.ends_with(".user")        || p.ends_with(".suo")
}

/// Returns `true` for paths that should be flagged as suspicious additions.
fn is_flagged_repo_path(path: &str) -> bool {
    let p = path.to_lowercase().replace('\\', "/");
    p.contains("copilot-instructions") ||
    (p.contains(".github/") && p.contains("instructions"))
}

/// Returns `true` when an untracked file is a relevant source/config file worth
/// including in the AI review context.  Noise and flagged paths are always excluded.
fn is_untracked_relevant(path: &str) -> bool {
    if is_repo_noise(path) || is_flagged_repo_path(path) { return false; }
    let p = path.to_lowercase().replace('\\', "/");
    p.ends_with(".cs")
        || p.ends_with(".csproj")
        || p.ends_with(".sln")
        || p.ends_with("packages.config")
        || p.ends_with("app.config")
        || p.ends_with(".config")
        // Small JSON not inside noise folders â€” handled by the noise check above
        || p.ends_with(".json")
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct GitReviewContext {
    repo_root: String,
    current_branch: String,
    base_branch: String,
    changed_files: Vec<String>,
    diff: String,
    has_staged: bool,
    has_unstaged: bool,
    has_committed: bool,
    has_untracked: bool,
    untracked_included: Vec<String>,
    untracked_skipped: Vec<String>,
    noise_files: Vec<String>,
    flagged_paths: Vec<String>,
    summary: String,
}

/// Collects a read-only git diff review context from `repo_root`.
///
/// Runs only safe read-only commands:
///   `git rev-parse --show-toplevel`
///   `git branch --show-current`
///   `git rev-parse --verify <branch>`
///   `git diff --name-status <base>...HEAD`
///   `git diff <base>...HEAD`
///   `git diff --cached`
///   `git diff`
///   `git status --short`
///
/// Never runs: add, commit, push, checkout, merge, rebase, or any write command.
#[tauri::command]
fn collect_git_review_context(
    repo_root: String,
    base_branch: Option<String>,
) -> Result<GitReviewContext, String> {
    // Resolve actual git root (walks up to find .git).
    let actual_root = run_git_ro(&repo_root, &["rev-parse", "--show-toplevel"])
        .map(|s| s.trim().replace('\\', "/").trim_end_matches('/').to_string())
        .unwrap_or_else(|| repo_root.trim().replace('\\', "/").trim_end_matches('/').to_string());
    let repo = actual_root.as_str();

    // Current branch
    let current_branch = run_git_ro(repo, &["branch", "--show-current"])
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    // Base branch: prefer explicit argument, then auto-detect
    let base = {
        let candidate = base_branch.unwrap_or_default();
        if !candidate.is_empty() && run_git_ro(repo, &["rev-parse", "--verify", &candidate]).is_some() {
            candidate
        } else {
            detect_base_branch(repo)
        }
    };

    let base_range = format!("{}...HEAD", base);

    // Committed branch diff
    let branch_diff = run_git_ro(repo, &["diff", &base_range])
        .map(|s| cap_utf8(s, 60_000))
        .unwrap_or_default();
    let has_committed = !branch_diff.is_empty();

    // Staged and unstaged
    let staged = run_git_ro(repo, &["diff", "--cached"])
        .map(|s| cap_utf8(s, 15_000))
        .unwrap_or_default();
    let has_staged = !staged.is_empty();

    let unstaged = run_git_ro(repo, &["diff"])
        .map(|s| cap_utf8(s, 15_000))
        .unwrap_or_default();
    let has_unstaged = !unstaged.is_empty();

    // Changed files
    let name_status = run_git_ro(repo, &["diff", "--name-status", &base_range])
        .unwrap_or_default();
    let status_short = run_git_ro(repo, &["status", "--short"])
        .map(|s| cap_utf8(s, 4_000))
        .unwrap_or_default();

    let committed_files: Vec<String> = name_status.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, '\t');
            parts.next();
            parts.next().map(|p| p.trim().to_string())
        })
        .filter(|f| !f.is_empty())
        .collect();

    // All modified/added files listed by status (XY prefix stripped)
    let status_files: Vec<String> = status_short.lines()
        .filter(|l| l.len() > 3)
        .map(|l| l[3..].trim().trim_matches('"').to_string())
        .filter(|f| !f.is_empty())
        .collect();

    // Untracked file paths: lines with "?? " prefix
    let untracked_raw: Vec<String> = status_short.lines()
        .filter(|l| l.starts_with("?? "))
        .map(|l| l[3..].trim().trim_matches('"').to_string())
        .filter(|f| !f.is_empty())
        .collect();

    let mut all_files: Vec<String> = committed_files;
    for f in &status_files {
        if !all_files.contains(f) { all_files.push(f.clone()); }
    }

    let noise_files:   Vec<String> = all_files.iter().filter(|f| is_repo_noise(f)).cloned().collect();
    let flagged_paths: Vec<String> = all_files.iter().filter(|f| is_flagged_repo_path(f)).cloned().collect();

    // â”€â”€ Read relevant untracked file content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const MAX_PER_FILE:  usize = 20_000;
    const MAX_UNTRACKED: usize = 60_000;

    let mut untracked_included: Vec<String> = Vec::new();
    let mut untracked_skipped:  Vec<String> = Vec::new();
    let mut untracked_parts:    Vec<String> = Vec::new();
    let mut total_untracked:    usize        = 0;

    for rel_path in &untracked_raw {
        if total_untracked >= MAX_UNTRACKED {
            untracked_skipped.push(format!("{rel_path} (total size limit reached)"));
            continue;
        }
        if !is_untracked_relevant(rel_path) {
            if is_repo_noise(rel_path) || is_flagged_repo_path(rel_path) {
                untracked_skipped.push(format!("{rel_path} (noise/flagged)"));
            }
            // silently skip non-relevant types (binaries, unknown extensions, etc.)
            continue;
        }
        // Build absolute path: repo is already normalised to forward slashes
        let abs_path = format!("{repo}/{rel_path}");
        match fs::read_to_string(&abs_path) {
            Err(_) => {
                untracked_skipped.push(format!("{rel_path} (read error)"));
            }
            Ok(raw) => {
                // Detect binary by checking for NUL bytes
                if raw.contains('\0') {
                    untracked_skipped.push(format!("{rel_path} (binary)"));
                    continue;
                }
                let content = cap_utf8(raw, MAX_PER_FILE);
                total_untracked += content.len();
                // Format as pseudo-diff so the AI review command sees new-file additions
                let plus_lines: String = content.lines()
                    .map(|l| format!("+{l}"))
                    .collect::<Vec<_>>()
                    .join("\n");
                untracked_parts.push(format!(
                    "diff --git a/{rel_path} b/{rel_path}\n\
                     new file mode 100644\n\
                     --- /dev/null\n\
                     +++ b/{rel_path}\n\
                     @@ -0,0 +1 @@\n\
                     {plus_lines}"
                ));
                untracked_included.push(rel_path.clone());
            }
        }
    }
    let has_untracked = !untracked_included.is_empty();

    // Combined diff
    let mut diff_parts: Vec<String> = Vec::new();
    if has_committed  { diff_parts.push(format!("=== BRANCH DIFF ({base} â†’ HEAD) ===\n{branch_diff}")); }
    if has_staged     { diff_parts.push(format!("=== STAGED CHANGES ===\n{staged}")); }
    if has_unstaged   { diff_parts.push(format!("=== UNSTAGED CHANGES ===\n{unstaged}")); }
    if has_untracked  {
        diff_parts.push(format!(
            "=== UNTRACKED NEW FILES ({} file(s) â€” not yet staged) ===\n{}",
            untracked_parts.len(),
            untracked_parts.join("\n\n")
        ));
    }
    let diff = diff_parts.join("\n\n");

    let mut src: Vec<&str> = Vec::new();
    if has_committed  { src.push("committed branch changes"); }
    if has_staged     { src.push("staged changes"); }
    if has_unstaged   { src.push("unstaged changes"); }
    if has_untracked  { src.push("untracked new files"); }
    let sources = if src.is_empty() { "no local changes found".to_string() } else { src.join(", ") };

    let summary = format!(
        "Branch: {current_branch} â†’ base: {base}. \
         Changed files: {}. Sources: {sources}.",
        all_files.len()
    );

    Ok(GitReviewContext {
        repo_root: actual_root,
        current_branch,
        base_branch: base,
        changed_files: all_files,
        diff,
        has_staged,
        has_unstaged,
        has_committed,
        has_untracked,
        untracked_included,
        untracked_skipped,
        noise_files,
        flagged_paths,
        summary,
    })
}

// --- File-specific git review context ----------------------------------------

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct GitFileReviewContext {
    repo_root: String,
    current_branch: String,
    base_branch: String,
    file_rel_path: String,
    /// Combined diff: committed branch changes + staged + unstaged for this file only.
    diff: String,
    has_committed: bool,
    has_staged: bool,
    has_unstaged: bool,
    /// true when the file is not tracked by git at all (new, never staged/committed).
    is_untracked: bool,
}

/// Collects a read-only, file-specific git diff review context.
///
/// Unlike `collect_git_review_context` which gathers the full branch diff,
/// this command focuses on a single file to avoid pulling in unrelated changes.
///
/// Read-only commands used:
///   `git rev-parse --show-toplevel`
///   `git branch --show-current`
///   `git rev-parse --verify <branch>`
///   `git diff <base>...HEAD -- <file>`    (committed branch changes for this file)
///   `git diff --cached -- <file>`         (staged changes)
///   `git diff -- <file>`                  (unstaged changes)
///   `git ls-files --error-unmatch <file>` (check whether tracked)
///
/// Never runs: add, commit, push, checkout, merge, rebase, or any write command.
#[tauri::command]
fn collect_git_file_review_context(
    repo_root: String,
    file_path: String,
) -> Result<GitFileReviewContext, String> {
    // 1. Resolve actual git root.
    let actual_root = run_git_ro(&repo_root, &["rev-parse", "--show-toplevel"])
        .map(|s| s.trim().replace('\\', "/").trim_end_matches('/').to_string())
        .ok_or_else(|| format!("Not a git repository: {repo_root}"))?;
    let repo = actual_root.as_str();

    // 2. Current branch and base branch.
    let current_branch = run_git_ro(repo, &["branch", "--show-current"])
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let base = detect_base_branch(repo);

    // 3. Make file path repo-relative.
    let fp_norm = file_path.replace('\\', "/");
    let repo_prefix = format!("{}/", actual_root);
    let file_rel = if fp_norm.starts_with(&repo_prefix) {
        fp_norm[repo_prefix.len()..].to_string()
    } else if !fp_norm.contains('/') && !fp_norm.contains('\\') {
        // Bare filename â€” use as-is.
        fp_norm.clone()
    } else {
        return Err(format!(
            "File is outside the repository root.\nFile: {fp_norm}\nRepo: {actual_root}"
        ));
    };

    // 4. Check if HEAD exists (unborn branch has no commits yet).
    let head_exists = run_git_ro(repo, &["rev-parse", "--verify", "HEAD"]).is_some();

    // 5. Committed branch changes for this file vs base.
    let base_range = format!("{}...HEAD", base);
    let committed_diff = if head_exists {
        run_git_ro(repo, &["diff", &base_range, "--", &file_rel])
            .map(|s| cap_utf8(s, 30_000))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let has_committed = !committed_diff.is_empty();

    // 6. Staged changes for this file.
    let staged_diff = run_git_ro(repo, &["diff", "--cached", "--", &file_rel])
        .map(|s| cap_utf8(s, 15_000))
        .unwrap_or_default();
    let has_staged = !staged_diff.is_empty();

    // 7. Unstaged changes for this file.
    let unstaged_diff = run_git_ro(repo, &["diff", "--", &file_rel])
        .map(|s| cap_utf8(s, 15_000))
        .unwrap_or_default();
    let has_unstaged = !unstaged_diff.is_empty();

    // 8. Determine whether the file is tracked by git.
    //    `git ls-files --error-unmatch` exits 0 when tracked, non-0 when not in the index.
    let is_untracked = run_git_ro(repo, &["ls-files", "--error-unmatch", &file_rel]).is_none();

    // 9. Combine all diffs with section headers.
    let mut diff_parts: Vec<String> = Vec::new();
    if has_committed {
        diff_parts.push(format!("=== BRANCH DIFF ({base} â†’ HEAD) â€” {file_rel} ===\n{committed_diff}"));
    }
    if has_staged {
        diff_parts.push(format!("=== STAGED CHANGES â€” {file_rel} ===\n{staged_diff}"));
    }
    if has_unstaged {
        diff_parts.push(format!("=== UNSTAGED CHANGES â€” {file_rel} ===\n{unstaged_diff}"));
    }
    let diff = diff_parts.join("\n\n");

    Ok(GitFileReviewContext {
        repo_root: actual_root,
        current_branch,
        base_branch: base,
        file_rel_path: file_rel,
        diff,
        has_committed,
        has_staged,
        has_unstaged,
        is_untracked,
    })
}

// --- Commit & Push helpers and commands ------------------------------------

/// Parses `git status --short --porcelain` output into (safe, noise) file lists.
fn parse_git_status_output(output: &str) -> (Vec<Value>, Vec<Value>) {
    let mut changed: Vec<Value> = Vec::new();
    let mut noise:   Vec<Value> = Vec::new();
    for line in output.lines() {
        if line.len() < 3 { continue; }
        let x = line.chars().next().unwrap_or(' ');
        let y = line.chars().nth(1).unwrap_or(' ');
        let path_part = line[3..].trim();
        // Renamed files: "old -> new" â€” take new path
        let path = if let Some(arrow) = path_part.find(" -> ") {
            path_part[arrow + 4..].trim().trim_matches('"')
        } else {
            path_part.trim_matches('"')
        };
        let status = if x == '?' && y == '?' { "untracked" }
            else if x == 'A' || (x == ' ' && y == 'A') { "added" }
            else if x == 'D' || y == 'D' { "deleted" }
            else if x == 'R' || y == 'R' { "renamed" }
            else if x == 'M' { "staged" }
            else { "modified" };
        let entry = serde_json::json!({ "path": path, "status": status });
        if is_repo_noise(path) || is_flagged_repo_path(path) {
            noise.push(entry);
        } else {
            changed.push(entry);
        }
    }
    (changed, noise)
}

/// Parses the first fetch URL from `git remote -v` output.
fn parse_git_fetch_url(remote_output: &str) -> (Option<String>, Option<String>) {
    for line in remote_output.lines() {
        if !line.contains("(fetch)") { continue; }
        let mut parts = line.splitn(2, '\t');
        let name = parts.next().map(str::trim);
        let rest = parts.next().unwrap_or("").trim();
        let url  = rest.split_whitespace().next().unwrap_or("").trim();
        if !url.is_empty() {
            return (name.map(str::to_string), Some(url.to_string()));
        }
    }
    (None, None)
}

/// Derives a deterministic commit message from task JSON.
fn generate_commit_message(task_json: &Value) -> String {
    let title     = task_json["title"].as_str().unwrap_or("").trim();
    let devops_url = task_json["devopsTaskUrl"].as_str().unwrap_or("");
    // Extract numeric work-item ID from /_workitems/edit/<N>/
    let task_id: String = {
        const MARKER: &str = "/_workitems/edit/";
        if let Some(pos) = devops_url.find(MARKER) {
            let after = &devops_url[pos + MARKER.len()..];
            let end = after.find(|c: char| !c.is_ascii_digit()).unwrap_or(after.len());
            after[..end].to_string()
        } else { String::new() }
    };
    // Strip leading bracketed prefix like [TEST], [FEATURE] â€¦
    let clean = {
        let s = title;
        let s = if s.starts_with('[') {
            if let Some(end) = s.find(']') { s[end + 1..].trim() } else { s }
        } else { s };
        if s.chars().count() > 72 {
            format!("{}...", s.chars().take(69).collect::<String>())
        } else {
            s.to_string()
        }
    };
    let base = if clean.is_empty() { "Update task files".to_string() } else { clean };
    if task_id.is_empty() { base } else { format!("{task_id}: {base}") }
}

/// Core logic for getting commit preview â€” shared by Tauri command and MCP handler.
fn git_commit_preview_impl(repo_root: &str, task_json: Option<&Value>) -> Result<Value, String> {
    // Resolve canonical git root â€” explicit error when path is not a git repo.
    let canonical_root = run_git_ro(repo_root, &["rev-parse", "--show-toplevel"])
        .map(|s| s.trim().replace('\\', "/").trim_end_matches('/').to_string())
        .ok_or_else(|| format!("Configured repository root is not a Git repository: {repo_root}"))?;
    let repo = canonical_root.as_str();

    // Check whether HEAD exists (fails in a brand-new repo with no commits).
    let head_exists = run_git_ro(repo, &["rev-parse", "--verify", "HEAD"]).is_some();

    // `git branch --show-current` may return empty in a detached HEAD or no-commits state.
    let branch = run_git_ro(repo, &["branch", "--show-current"])
        .filter(|s| !s.is_empty())
        // Fallback: parse from .git/HEAD file directly
        .or_else(|| {
            let head_path = std::path::Path::new(repo).join(".git").join("HEAD");
            std::fs::read_to_string(&head_path).ok()
                .and_then(|c| c.trim().strip_prefix("ref: refs/heads/").map(str::to_string))
        })
        .unwrap_or_default();

    let remote_raw = run_git_ro(repo, &["remote", "-v"]).unwrap_or_default();
    let (remote_name, remote_url) = parse_git_fetch_url(&remote_raw);

    // Use `git status --short` â€” works correctly even when HEAD does not exist.
    let status_raw = run_git_ro(repo, &["status", "--short"]).unwrap_or_default();
    let (changed, noise) = parse_git_status_output(&status_raw);

    let mut warnings: Vec<String> = Vec::new();
    if !head_exists {
        warnings.push("Repository has no commits yet; preview is based on git status only.".into());
    }
    if branch == "main" || branch == "master" {
        warnings.push(format!("Branch '{}' is the default branch â€” push will be blocked.", branch));
    }
    if branch.is_empty() { warnings.push("Could not determine branch.".into()); }
    if changed.is_empty() && noise.is_empty() { warnings.push("No changes detected.".into()); }
    else if changed.is_empty() { warnings.push("All changed files are in the exclusion list.".into()); }
    if !noise.is_empty() { warnings.push(format!("{} file(s) excluded (bin/, obj/, .vs/, â€¦).", noise.len())); }
    if remote_url.is_none() { warnings.push("No remote configured â€” push will not be available.".into()); }

    let suggested_message = task_json
        .map(|t| generate_commit_message(t))
        .unwrap_or_else(|| "Update task files".into());

    // Detect remote base and check whether current HEAD has a usable merge base.
    let base_branch = detect_remote_base_branch(repo);
    let has_merge_base = base_branch.as_deref()
        .map(|b| has_merge_base_with_remote(repo, b))
        .unwrap_or(false);
    // A feature branch can produce a normal PR only when it is not a default branch,
    // has a remote configured, and shares a merge base with origin/main|master.
    let is_feature = branch != "main" && branch != "master" && !branch.is_empty();
    let can_create_pr = is_feature && has_merge_base && remote_url.is_some();

    if base_branch.is_some() && is_feature && !has_merge_base {
        warnings.push(format!(
            "Branch has no common history with {}. \
             A normal PR cannot be created â€” GitHub compare will show unrelated histories.",
            base_branch.as_deref().unwrap_or("remote base")
        ));
    }

    // Detect upstream tracking configuration.
    // `git rev-parse --abbrev-ref --symbolic-full-name @{u}` returns e.g. "origin/main"
    // or exits non-zero when no upstream is configured.
    let upstream_branch = run_git_ro(repo, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let has_upstream = upstream_branch.is_some();
    let expected_upstream = format!("origin/{branch}");
    let upstream_matches = upstream_branch.as_deref()
        .map(|u| u == expected_upstream)
        .unwrap_or(false);

    // Warn about upstream mismatch (does not block â€” push will auto-fix with --set-upstream).
    if is_feature && has_upstream && !upstream_matches {
        warnings.push(format!(
            "Current branch tracks {} as upstream, but it should publish to {}. \
             First push will automatically reset the upstream to {}.",
            upstream_branch.as_deref().unwrap_or("?"),
            expected_upstream,
            expected_upstream,
        ));
    }

    // Count commits ahead of the remote so the UI can show a push-only button
    // when the working tree is clean but there are unpushed commits.
    let ahead_count: u32 = if is_feature {
        if has_upstream {
            run_git_ro(repo, &["rev-list", "--count", "@{u}..HEAD"])
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0)
        } else if let Some(ref base) = base_branch {
            // No upstream yet â€” count commits ahead of the remote base branch.
            run_git_ro(repo, &["rev-list", "--count", &format!("{base}..HEAD")])
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0)
        } else {
            0
        }
    } else {
        0
    };

    // True when the working tree is clean but there are local commits ready to push.
    let pushable_without_commit = is_feature
        && changed.is_empty()
        && noise.is_empty()
        && ahead_count > 0
        && has_merge_base
        && remote_url.is_some();

    Ok(serde_json::json!({
        "ok": true,
        "repoRoot": canonical_root,
        "branch": branch,
        "remote": remote_name,
        "remoteUrl": remote_url,
        "changedFiles": changed,
        "ignoredFiles": noise,
        "warnings": warnings,
        "suggestedCommitMessage": suggested_message,
        "baseBranch": base_branch,
        "hasMergeBase": has_merge_base,
        "canCreatePullRequest": can_create_pr,
        "hasUpstream": has_upstream,
        "upstreamBranch": upstream_branch,
        "upstreamMatchesCurrentBranch": upstream_matches,
        "aheadCount": ahead_count,
        "pushableWithoutCommit": pushable_without_commit,
    }))
}

/// Core logic for committing selected files â€” shared by Tauri command and MCP handler.
fn git_commit_impl(repo_root: &str, files: &[String], message: &str) -> Result<Value, String> {
    if message.trim().is_empty() { return Err("Commit message cannot be empty.".into()); }
    if files.is_empty() { return Err("No files specified for commit.".into()); }
    // Validate each file
    for file in files {
        let norm = file.replace('\\', "/");
        if norm.contains("/../") || norm.starts_with("../") || norm == ".." {
            return Err(format!("Invalid path (directory traversal): {file}"));
        }
        if is_repo_noise(&norm) || is_flagged_repo_path(&norm) {
            return Err(format!("File is in the exclusion list: {file}"));
        }
    }
    // git add -- <files...>
    {
        let mut cmd = std::process::Command::new("git");
        hide_console_window(&mut cmd);
        cmd.arg("-C").arg(repo_root).arg("add").arg("--");
        for f in files { cmd.arg(f); }
        let out = cmd.output().map_err(|e| format!("Failed to run git add: {e}"))?;
        if !out.status.success() {
            return Err(format!("git add failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
    }
    // git commit
    git_run(repo_root, &["commit", "-m", message.trim()])
        .map_err(|e| format!("git commit failed: {e}"))?;
    let hash = git_run(repo_root, &["rev-parse", "--short", "HEAD"])
        .unwrap_or_default().trim().to_string();
    Ok(serde_json::json!({ "ok": true, "commitHash": hash, "summary": format!("Commit {hash} created.") }))
}

/// Core logic for pushing the current branch â€” shared by Tauri command and MCP handler.
///
/// Push strategy (never force-pushes, never pushes to main/master):
/// A. No upstream configured â†’ `git push --set-upstream origin <branch>` (first publish)
/// B. Upstream exists but is NOT `origin/<branch>` (e.g. tracks origin/main) â†’
///    `git push --set-upstream origin <branch>` (fixes the tracking and publishes)
/// C. Upstream already matches `origin/<branch>` â†’ `git push`
fn git_push_impl(repo_root: &str) -> Result<Value, String> {
    let branch = git_run(repo_root, &["branch", "--show-current"])
        .map_err(|e| format!("Cannot determine branch: {e}"))?
        .trim().to_string();
    if branch.is_empty() { return Err("Cannot push: detached HEAD or no branch.".into()); }
    if branch == "main" || branch == "master" {
        return Err(format!("Push to '{branch}' is blocked from Task Workbench. Use a feature branch."));
    }

    // Determine current upstream (if any). `@{u}` resolves to e.g. "origin/main" or
    // "origin/VSM/10277". Returns None when no upstream is set.
    let upstream = run_git_ro(repo_root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    let expected_upstream = format!("origin/{branch}");
    let needs_set_upstream = upstream.as_deref().map(str::trim)
        .map(|u| u != expected_upstream)
        .unwrap_or(true); // None â†’ no upstream â†’ also needs set-upstream

    if needs_set_upstream {
        // Publish the branch (creates remote branch and sets correct tracking).
        git_run(repo_root, &["push", "--set-upstream", "origin", &branch])
            .map_err(|e| format!("git push --set-upstream failed: {e}"))?;
    } else {
        git_run(repo_root, &["push"])
            .map_err(|e| format!("git push failed: {e}"))?;
    }

    Ok(serde_json::json!({ "ok": true, "branch": branch, "summary": format!("Branch '{branch}' pushed.") }))
}

/// Detects the remote default/base branch.
/// Priority: origin/main â†’ origin/master â†’ symbolic-ref refs/remotes/origin/HEAD.
/// Returns "origin/main", "origin/master", or None. Read-only.
fn detect_remote_base_branch(repo_root: &str) -> Option<String> {
    if run_git_ro(repo_root, &["rev-parse", "--verify", "origin/main"]).is_some() {
        return Some("origin/main".into());
    }
    if run_git_ro(repo_root, &["rev-parse", "--verify", "origin/master"]).is_some() {
        return Some("origin/master".into());
    }
    // Symbolic ref: refs/remotes/origin/HEAD â†’ refs/remotes/origin/main
    if let Some(sym) = run_git_ro(repo_root, &["symbolic-ref", "refs/remotes/origin/HEAD"]) {
        let sym = sym.trim();
        if let Some(suffix) = sym.strip_prefix("refs/remotes/") {
            if run_git_ro(repo_root, &["rev-parse", "--verify", suffix]).is_some() {
                return Some(suffix.to_string());
            }
        }
    }
    None
}

/// Returns true when HEAD and base_ref share a common ancestor (merge base exists).
/// Uses read-only `git merge-base`; returns false on any error.
fn has_merge_base_with_remote(repo_root: &str, base_ref: &str) -> bool {
    run_git_ro(repo_root, &["merge-base", base_ref, "HEAD"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Validates a Git branch name for safety. Returns Err with a human-readable reason.
fn validate_git_branch_name(name: &str) -> Result<(), String> {
    let t = name.trim();
    if t.is_empty()            { return Err("Branch name cannot be empty.".into()); }
    if t.contains("..")        { return Err("Branch name must not contain \"..\"".into()); }
    if t.starts_with('-')      { return Err("Branch name must not start with \"-\".".into()); }
    if t.ends_with('.')        { return Err("Branch name must not end with \".\".".into()); }
    if t.contains(' ')         { return Err("Branch name must not contain spaces.".into()); }
    if t.contains('\\')        { return Err("Branch name must not contain backslash.".into()); }
    for ch in ['~', '^', ':', '?', '*', '['] {
        if t.contains(ch) {
            return Err(format!("Branch name must not contain '{ch}'."));
        }
    }
    if t == "main" || t == "master" {
        return Err(format!("\"{}\" is a default branch â€” use a feature branch name.", t));
    }
    if t.starts_with("refs/") {
        return Err("Branch name must not start with \"refs/\".".into());
    }
    Ok(())
}

/// Creates a new local branch from the remote base branch and switches to it.
/// Runs `git fetch origin --prune` first to ensure remote refs are current.
/// Rejects if the branch already exists, if no remote base is found, or if the
/// working tree has uncommitted changes that cannot safely survive the base switch
/// (i.e. the local history has no merge base with origin/main|master).
/// Never pushes, commits, or merges.
fn create_git_branch_impl(repo_root: &str, branch_name: &str) -> Result<Value, String> {
    let name = branch_name.trim();
    validate_git_branch_name(name)?;

    // Confirm repo_root is a Git repository.
    run_git_ro(repo_root, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| format!("Not a Git repository: {repo_root}"))?;

    // Fetch remote refs so origin/main / origin/master are current.
    {
        let out = {
            let mut cmd = std::process::Command::new("git");
            hide_console_window(&mut cmd);
            cmd.arg("-C").arg(repo_root)
                .args(["fetch", "origin", "--prune"]);
            cmd.output().map_err(|e| format!("Failed to run git fetch: {e}"))?
        };
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(format!(
                "git fetch origin failed: {stderr}\n\
                 Cannot verify remote base branch without a successful fetch."
            ));
        }
    }

    // Detect remote base branch (after fetch so refs are fresh).
    let base_branch = detect_remote_base_branch(repo_root)
        .ok_or_else(|| {
            "No remote base branch found (tried origin/main and origin/master). \
             Cannot create a branch with a valid PR base. \
             Ensure a remote named 'origin' is configured and has a main or master branch.".to_string()
        })?;

    // Guard: if uncommitted changes exist and there's no merge base, switching the
    // working tree base would risk losing or mangling those changes.
    let has_uncommitted = run_git_ro(repo_root, &["status", "--porcelain=v1", "--short"])
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if has_uncommitted && !has_merge_base_with_remote(repo_root, &base_branch) {
        return Err(format!(
            "Cannot create branch from {base_branch}: the current working tree has uncommitted \
             changes and the local history has no common ancestor with {base_branch}. \
             This usually means the local repository was initialised independently of the remote. \
             Recommended: create a clean clone, create the feature branch there, and bring your \
             changes across manually."
        ));
    }

    // Reject if the target branch already exists.
    let already = run_git_ro(repo_root, &["rev-parse", "--verify", &format!("refs/heads/{name}")]);
    if already.is_some() {
        return Err(format!("Branch '{name}' already exists."));
    }

    // Create and switch to the new branch, rooted at the remote base.
    // --no-track prevents git from setting origin/main as the upstream of the new
    // branch, which would cause `git push` to refuse with "upstream does not match".
    let out = {
        let mut cmd = std::process::Command::new("git");
        hide_console_window(&mut cmd);
        cmd.arg("-C").arg(repo_root)
            .arg("checkout").arg("--no-track").arg("-b").arg(name).arg(&base_branch);
        cmd.output().map_err(|e| format!("Failed to run git checkout -b: {e}"))?
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("git checkout -b failed: {stderr}"));
    }

    Ok(serde_json::json!({ "ok": true, "branch": name, "baseBranch": base_branch }))
}

/// Creates a new local Git branch and switches to it.
/// Rejects push/merge/force operations â€” local branch creation only.
#[tauri::command]
fn create_git_branch(repo_root: String, branch_name: String) -> Result<Value, String> {
    create_git_branch_impl(&repo_root, &branch_name)
}

/// Resolves the repository root for a task in the MCP bridge context.
fn mcp_resolve_repo_root_for_task(app: &tauri::AppHandle, task: &Value) -> Result<String, String> {
    if let Some(r) = task["workflowSetup"]["repositoryRoot"].as_str().filter(|s| !s.is_empty()) {
        return Ok(r.to_string());
    }
    let customer_id = task["customerId"].as_str().unwrap_or("");
    if !customer_id.is_empty() {
        if let Ok(customers) = task_mcp_load_customers(app) {
            if let Some(c) = customers.iter().find(|c| c["id"].as_str() == Some(customer_id)) {
                let root = c["repositoryRootOverride"].as_str().filter(|s| !s.is_empty())
                    .or_else(|| c["repositoryRoot"].as_str().filter(|s| !s.is_empty()));
                if let Some(r) = root { return Ok(r.to_string()); }
            }
        }
    }
    Err("Repository root not configured. Set workflowSetup.repositoryRoot or customer.repositoryRoot.".into())
}

/// Returns a preview of pending git changes and a suggested commit message.
/// Read-only â€” never stages or commits anything.
#[tauri::command]
fn get_git_commit_preview(repo_root: String, task_json: Option<Value>) -> Result<Value, String> {
    git_commit_preview_impl(&repo_root, task_json.as_ref())
}

/// Stages the listed files and creates a git commit.
/// All file paths must be relative and inside the repository; noise files are rejected.
#[tauri::command]
fn commit_task_changes(repo_root: String, files: Vec<String>, message: String) -> Result<Value, String> {
    git_commit_impl(&repo_root, &files, &message)
}

/// Pushes the current branch to origin.
/// Blocks push to main/master and never force-pushes.
#[tauri::command]
fn push_task_branch(repo_root: String) -> Result<Value, String> {
    git_push_impl(&repo_root)
}

/// Stages files, commits, then pushes the current branch â€” a single-step wrapper.
#[tauri::command]
fn commit_and_push_task_changes(
    repo_root: String,
    files: Vec<String>,
    message: String,
) -> Result<Value, String> {
    let commit_result = git_commit_impl(&repo_root, &files, &message)?;
    let hash = commit_result["commitHash"].as_str().unwrap_or("?").to_string();
    let push_result = git_push_impl(&repo_root)?;
    let branch = push_result["branch"].as_str().unwrap_or("?").to_string();
    Ok(serde_json::json!({
        "ok": true,
        "commitHash": hash,
        "branch": branch,
        "summary": format!("Commit {hash} created and branch '{branch}' pushed."),
    }))
}

// --- AI helpers ------------------------------------------------------------

/// Resolved AI provider configuration loaded from settings.
struct AiConfig {
    /// "openai" | "anthropic"
    provider: String,
    /// API key for the active provider (never logged).
    api_key: String,
    /// Model name for the active provider.
    model: String,
}

/// Reads AI provider config from settings.json.
/// Supports both the new multi-provider fields and the legacy aiApiKey/aiModel fallback.
/// Returns an error (without the key) if the resolved API key is empty.
fn get_ai_config(app: &tauri::AppHandle) -> Result<AiConfig, String> {
    let path = app_data_dir(app)?.join("settings.json");
    let settings = read_json(&path)?;

    let provider = settings["activeAiProvider"].as_str().unwrap_or("openai").to_string();

    let (api_key, model) = if provider == "anthropic" {
        let key = settings["anthropicApiKey"].as_str().unwrap_or("").to_string();
        let mdl = {
            let m = settings["anthropicModel"].as_str().unwrap_or("");
            if m.is_empty() { "claude-sonnet-4-5".to_string() } else { m.to_string() }
        };
        (key, mdl)
    } else {
        // OpenAI â€” with legacy fallback
        let key = {
            let k = settings["openaiApiKey"].as_str().unwrap_or("");
            if k.is_empty() {
                settings["aiApiKey"].as_str().unwrap_or("").to_string()
            } else {
                k.to_string()
            }
        };
        let mdl = {
            let m = settings["openaiModel"].as_str().unwrap_or("");
            if m.is_empty() {
                let legacy = settings["aiModel"].as_str().unwrap_or("");
                if legacy.is_empty() { "gpt-4.1-mini".to_string() } else { legacy.to_string() }
            } else {
                m.to_string()
            }
        };
        (key, mdl)
    };

    if api_key.is_empty() {
        let label = if provider == "anthropic" { "Anthropic" } else { "OpenAI" };
        return Err(format!(
            "AI API key not configured. Add your {label} API key in Settings â†’ AI."
        ));
    }

    Ok(AiConfig { provider, api_key, model })
}

/// Legacy helper â€” kept to avoid touching unchanged call sites individually.
/// New code should use get_ai_config.
#[allow(dead_code)]
fn get_ai_settings(app: &tauri::AppHandle) -> Result<(String, String), String> {
    let c = get_ai_config(app)?;
    Ok((c.api_key, c.model))
}

/// OpenAI Responses API call with optional temperature.
/// Temperature is only included when the model's capability profile supports it.
/// Unknown models use a conservative profile (temperature omitted) to avoid HTTP 400 errors.
async fn call_openai_with_temperature(
    api_key: &str,
    model: &str,
    instructions: &str,
    prompt: &str,
    temperature: Option<f64>,
) -> Result<String, String> {
    let client = Client::new();

    let mut body = serde_json::json!({
        "model": model,
        "input": prompt,
    });
    if !instructions.is_empty() {
        body["instructions"] = serde_json::Value::String(instructions.to_string());
    }

    // Only include temperature when both the caller requested it and the model supports it.
    if let Some(t) = temperature {
        if t > 0.0 {
            if let Some(clamped) = ai_model_capabilities::clamp_temperature("openai", model, t) {
                body["temperature"] = serde_json::Value::from(clamped);
            }
            // If clamp_temperature returns None, the model does not support temperature â€”
            // the parameter is intentionally omitted from the request body.
        }
    }

    // Collect parameter names sent (excluding api_key which travels in the Authorization header).
    let sent_params: Vec<String> = body.as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();

    let resp = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error calling OpenAI (model: {model}): {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let api_error = resp.text().await.unwrap_or_default();
        let params_str = sent_params.join(", ");
        let mut msg = format!(
            "OpenAI API error {status} [model: {model}, params sent: {{{params_str}}}]: {api_error}"
        );
        if status == 400 && api_error.contains("Unsupported parameter") {
            msg.push_str(
                "\n\nNote: an unsupported parameter was rejected by the model. \
                 Task Workbench omits unsupported parameters automatically for recognized \
                 models. If this error persists, the model name may not be recognized â€” \
                 try using a known model such as gpt-4.1-mini."
            );
        }
        return Err(msg);
    }

    let json: Value = resp.json().await.map_err(|e| e.to_string())?;

    openai_response_parser::extract_openai_response_text(&json)
        .map_err(|_| openai_response_parser::sanitize_openai_response_error(&json, model))
}

/// Calls the Anthropic Messages API and returns the text of the first content block.
/// All current Claude models support temperature; it is clamped to [0.0, 1.0].
async fn call_anthropic_text(
    api_key: &str,
    model: &str,
    instructions: &str,
    prompt: &str,
    temperature: Option<f64>,
) -> Result<String, String> {
    let client = Client::new();
    let messages = serde_json::json!([{"role": "user", "content": prompt}]);
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 4096,
        "messages": messages,
    });
    if !instructions.is_empty() {
        body["system"] = serde_json::Value::String(instructions.to_string());
    }
    if let Some(t) = temperature {
        if t > 0.0 {
            if let Some(clamped) = ai_model_capabilities::clamp_temperature("anthropic", model, t) {
                body["temperature"] = serde_json::Value::from(clamped);
            }
        }
    }

    let sent_params: Vec<String> = body.as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error calling Anthropic (model: {model}): {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let api_error = resp.text().await.unwrap_or_default();
        let params_str = sent_params.join(", ");
        return Err(format!(
            "Anthropic API error {status} [model: {model}, params sent: {{{params_str}}}]: {api_error}"
        ));
    }

    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    // Anthropic Messages API: content[0].text
    json["content"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| {
            let snippet = json.to_string();
            format!("Unexpected Anthropic response format: {}", &snippet[..snippet.len().min(300)])
        })
}

/// Provider-aware AI text call. Routes to OpenAI or Anthropic based on config.
async fn call_ai_text(config: &AiConfig, instructions: &str, prompt: &str) -> Result<String, String> {
    call_ai_text_with_temperature(config, instructions, prompt, None).await
}

/// Provider-aware AI call with optional temperature override.
async fn call_ai_text_with_temperature(
    config: &AiConfig,
    instructions: &str,
    prompt: &str,
    temperature: Option<f64>,
) -> Result<String, String> {
    if config.provider == "anthropic" {
        call_anthropic_text(&config.api_key, &config.model, instructions, prompt, temperature).await
    } else {
        call_openai_with_temperature(&config.api_key, &config.model, instructions, prompt, temperature).await
    }
}

/// Strip markdown code fences (```json ... ```) that the model sometimes adds
/// even when instructed not to.
fn strip_fences(text: &str) -> &str {
    let text = text.trim();
    if text.starts_with("```") {
        if let Some(nl) = text.find('\n') {
            let inner = &text[nl + 1..];
            if let Some(end) = inner.rfind("```") {
                return inner[..end].trim();
            }
        }
    }
    text
}

// --- AI commands -----------------------------------------------------------

/// Ensures the JSON returned by the AI has the minimum required shape.
/// Fixes null / missing scalar fields; does NOT copy legacy English into bilingual fields.
fn normalize_task_analysis(mut v: Value) -> Value {
    // Legacy scalar fields that must always be present
    if !v["confidence"].is_number() {
        v["confidence"] = serde_json::json!(50);
    }
    if !v["summary"].is_string() {
        v["summary"] = serde_json::json!("");
    }
    // suggestedActions must be an array
    if !v["suggestedActions"].is_array() {
        v["suggestedActions"] = serde_json::json!([]);
    }
    // Fix null bilingual array fields â€” only touch keys that already exist in the response
    let array_fields = [
        "problemPoints",
        "problemPointsCz", "problemPointsEn",
        "actionPointsCz",  "actionPointsEn",
    ];
    for key in &array_fields {
        if v.get(*key).is_some() && !v[key].is_array() {
            v[key] = serde_json::json!([]);
        }
    }
    // Do NOT synthesise missing bilingual fields from legacy English values â€”
    // the frontend uses absence to detect "legacy-only" mode.
    v
}

/// Analyses a task using AI and returns a TaskAnalysis JSON object.
#[tauri::command]
async fn analyze_task(app: tauri::AppHandle, task: Value, customer: Value) -> Result<Value, String> {
    let config = get_ai_config(&app)?;

    let title         = task["title"].as_str().unwrap_or("");
    let task_type     = task["taskType"].as_str().unwrap_or("");
    let source        = task["source"].as_str().unwrap_or("");
    let message       = task["originalMessage"].as_str().unwrap_or("");
    let customer_name = customer["name"].as_str().unwrap_or("Unknown");
    let namespace     = customer["namespace"].as_str().unwrap_or("");
    let repo_name     = customer["repositoryName"].as_str().unwrap_or("");

    let instructions = "You are a Dynamics 365 / Dataverse developer assistant. \
Return ONLY valid JSON â€” no markdown, no prose, no code fences. \
All bilingual fields (summaryCz, summaryEn, problemPointsCz, problemPointsEn, \
actionPointsCz, actionPointsEn, nextStepCz, nextStepEn) are MANDATORY. \
Czech fields must be real Czech. English fields must be real English.";

    let prompt = format!(
        "Analyse this work request. Return ALL fields â€” bilingual fields are required.\n\n\
Task:\n- Title: {title}\n- Type: {task_type}\n- Source: {source}\n- Message: {message}\n\n\
Customer:\n- Name: {customer_name}\n- Namespace: {namespace}\n- Repository: {repo_name}\n\n\
Return ONLY this exact JSON shape (fill every field with real content):\n\
{{\
\"summary\":\"1-2 sentence English summary\",\
\"problemPoints\":[\"English problem bullet\"],\
\"suggestedActions\":[{{\"id\":\"ai1\",\"label\":\"Concrete English action step\"}}],\
\"confidence\":85,\
\"nextStep\":\"Most important next action in English\",\
\"summaryCz\":\"1-2 vÄ›ty ÄŤesky popisujĂ­cĂ­ problĂ©m\",\
\"summaryEn\":\"1-2 sentences in English describing the problem\",\
\"problemPointsCz\":[\"KrĂˇtkĂ˝ ÄŤeskĂ˝ bod o problĂ©mu.\",\"Kde se projevuje nebo kdo je ovlivnÄ›n.\"],\
\"problemPointsEn\":[\"Short English bullet about the problem.\",\"Where it occurs or who is affected.\"],\
\"actionPointsCz\":[\"KonkrĂ©tnĂ­ akÄŤnĂ­ krok ÄŤesky.\",\"DruhĂ˝ krok ÄŤesky.\"],\
\"actionPointsEn\":[\"Concrete action step in English.\",\"Second step in English.\"],\
\"nextStepCz\":\"Jeden jasnĂ˝ bezprostĹ™ednĂ­ krok ÄŤesky.\",\
\"nextStepEn\":\"One clear immediate next step in English.\"\
}}\n\n\
Rules â€” follow strictly:\n\
- ALL 13 fields above are mandatory. Do not omit any.\n\
- summaryCz and all *Cz fields: must be natural Czech â€” not translated literally, not English.\n\
- summaryEn and all *En fields: must be natural English â€” not Czech.\n\
- problemPointsCz / problemPointsEn: 2-4 bullets â€” what is wrong, where, who is affected.\n\
- actionPointsCz / actionPointsEn: 2-4 bullets â€” concrete steps to fix the issue.\n\
- nextStepCz / nextStepEn: the single most important immediate action.\n\
- suggestedActions: 3-5 English steps (legacy field, keep it).\n\
- confidence: integer 0-100 reflecting how clear and actionable the request is.\n\
- Preserve technical identifiers exactly as given: file names, entity names, field names, script names.\n\
- No long sentences. No corporate language. No markdown inside string values."
    );

    let text = call_ai_text(&config, instructions, &prompt).await?;

    let parsed: Value = serde_json::from_str(strip_fences(&text)).map_err(|e| {
        let snippet = &text[..text.len().min(300)];
        format!("Failed to parse AI response: {e}. Response: {snippet}")
    })?;

    Ok(normalize_task_analysis(parsed))
}

/// Generates a professional reply draft. Returns plain text.
#[tauri::command]
async fn generate_reply(app: tauri::AppHandle, task: Value, customer: Value) -> Result<String, String> {
    let config = get_ai_config(&app)?;

    let title         = task["title"].as_str().unwrap_or("");
    let task_type     = task["taskType"].as_str().unwrap_or("");
    let status        = task["status"].as_str().unwrap_or("");
    let message       = task["originalMessage"].as_str().unwrap_or("");
    let customer_name = customer["name"].as_str().unwrap_or("there");

    let instructions = "Write brief professional client replies. Plain text only â€” no markdown.";

    let prompt = format!(
        "Write a brief professional reply to a client request.\n\n\
Context:\n- Client: {customer_name}\n- Request title: {title}\n\
- Request type: {task_type}\n- Current status: {status}\n- Original message: {message}\n\n\
Write 2-4 short paragraphs. Acknowledge the request, state current status, \
set clear expectations. End with 'Best regards'."
    );

    call_ai_text(&config, instructions, &prompt).await
}

/// Generates a C# plugin skeleton and returns a SkeletonPreview JSON object.
#[tauri::command]
async fn generate_skeleton_preview(app: tauri::AppHandle, task: Value, customer: Value) -> Result<Value, String> {
    let config = get_ai_config(&app)?;

    let title     = task["title"].as_str().unwrap_or("");
    let task_type = task["taskType"].as_str().unwrap_or("");
    let message   = task["originalMessage"].as_str().unwrap_or("");
    // Namespace priority:
    //   1. customer.namespace (explicitly configured for the customer)
    //   2. workflowSetup.pluginProject (the confirmed project = its root namespace in the built-in template)
    //   3. task.selectedPluginProject
    //   4. hard-coded fallback
    let customer_ns  = customer["namespace"].as_str().unwrap_or("");
    let plugin_proj  = task["workflowSetup"]["pluginProject"].as_str()
        .or_else(|| task["selectedPluginProject"].as_str())
        .unwrap_or("");
    let namespace: &str = if !customer_ns.is_empty() {
        customer_ns
    } else if !plugin_proj.is_empty() {
        plugin_proj
    } else {
        "MyProject"
    };

    let instructions = "Generate C# plugin skeletons for Dynamics 365 / Dataverse. \
Respond with ONLY valid JSON â€” no markdown, no code fences.";

    let base_stub = "\
public void Execute(IServiceProvider serviceProvider)\n\
{\n\
    ITracingService tracer = (ITracingService)serviceProvider.GetService(typeof(ITracingService));\n\
    IPluginExecutionContext context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));\n\
    IOrganizationServiceFactory serviceFactory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));\n\
    IOrganizationService service = serviceFactory.CreateOrganizationService(context.UserId);\n\
\n\
    if (context.InputParameters.Contains(\"Target\") && context.InputParameters[\"Target\"] is Entity)\n\
    {\n\
        Entity contextEntity = (Entity)context.InputParameters[\"Target\"];\n\
        Guid initiatingUserId = context.InitiatingUserId;\n\
\n\
        // TODO: implement plugin logic\n\
    }\n\
}";

    let prompt = format!(
        "Generate a C# plugin class skeleton.\n\n\
Task:\n- Title: {title}\n- Type: {task_type}\n- Message: {message}\n\n\
Customer namespace: {namespace}\n\n\
Base Execute stub â€” you MUST preserve this structure and extend it with task-specific logic:\n\
```csharp\n{base_stub}\n```\n\n\
Respond with ONLY this JSON (no markdown, no fences):\n\
{{\"fileName\":\"PluginClassName.cs\",\"content\":\"// full C# file\",\"targetPath\":\"\"}}\n\n\
Rules:\n\
- fileName: PascalCase class name + .cs\n\
- content: complete C# file with using statements, namespace block, class implementing IPlugin, \
Execute method built on the base stub above with task-specific logic replacing the TODO comment\n\
- targetPath: relative subfolder within plugin folder (empty string for root)"
    );

    let text = call_ai_text(&config, instructions, &prompt).await?;

    serde_json::from_str(strip_fences(&text)).map_err(|e| {
        let snippet = &text[..text.len().min(300)];
        format!("Failed to parse AI response: {e}. Response: {snippet}")
    })
}

/// Reads a source file from disk and runs a configurable AI review against it.
/// The API key is read from settings.json â€” never exposed to the frontend.
/// `model_override` is used when non-empty; otherwise falls back to the global AI model.
/// `temperature` is clamped to [0.0, 2.0]; defaults to 0.2 when 0.0 is passed and
/// the caller did not explicitly intend zero temperature (we treat 0.0 as "use default").
/// Returns the AI response as a Markdown-formatted string.
#[tauri::command]
async fn run_ai_file_review(
    app: tauri::AppHandle,
    file_path: String,
    reviewer_name: String,
    instructions: String,
    model_override: String,
    temperature: f64,
) -> Result<Value, String> {
    // Read AI config from settings; allow model_override from reviewer profile
    let mut ai_config = get_ai_config(&app)?;
    if !model_override.trim().is_empty() {
        ai_config.model = model_override.trim().to_string();
    }

    // Read the file from disk (cap at 200 KB to stay within token budgets)
    const MAX_BYTES: usize = 200 * 1024;
    let path_ref = std::path::Path::new(&file_path);
    if path_ref.is_dir() {
        return Err(format!(
            "'{file_path}' is a directory. Enter the path of a specific source file (e.g. a .cs or .js file)."
        ));
    }
    let raw = fs::read_to_string(&file_path)
        .map_err(|e| format!("Cannot read file '{file_path}': {e}"))?;
    let content = if raw.len() > MAX_BYTES {
        let boundary = (0..=MAX_BYTES).rev().find(|&i| raw.is_char_boundary(i)).unwrap_or(0);
        format!("{}\n\nâ€¦ [file truncated at 200 KB]", &raw[..boundary])
    } else {
        raw
    };

    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.clone());

    let prompt = format!(
        "Review the following file: **{file_name}**\n\n```\n{content}\n```"
    );

    // Append structured-JSON format requirement to whatever reviewer instructions were provided.
    let json_format_requirement = r#"

VrĂˇĹĄ POUZE platnĂ© JSON bez prose, bez markdown kĂłdovĂ˝ch blĹ‘kĹŻ, bez jinĂ©ho textu.
VeĹˇkerĂ˝ textovĂ˝ obsah (summary, title, problem, recommendation, generalSuggestions) pĂ­Ĺˇi ÄŤeskĂ˝.
KĂłdovĂ© Ăşseky (codeSnippet, suggestedCode) ponechĂˇvej v originĂˇlnĂ­m programovacĂ­m jazyce, nepĹ™eklĂˇdej je.

PoĹľadovanĂ© schĂ©ma:
{
  "verdict": "pass" | "needs_changes" | "comment",
  "summary": "ÄŤeskĂ˝ souhrnny odstavec.",
  "comments": [
    {
      "severity": "critical" | "major" | "minor" | "suggestion",
      "lineStart": 42,
      "lineEnd": 58,
      "title": "KrĂˇtkĂ˝ ÄŤeskĂ˝ nĂˇzev problĂ©mu",
      "problem": "- PrvnĂ­ problĂ©m\n- DruhĂ˝ problĂ©m\n- TĹ™etĂ­ problĂ©m",
      "recommendation": "- PrvnĂ­ krok\n- DruhĂ˝ krok\n- TĹ™etĂ­ krok",
      "codeSnippet": "1â€“5 Ĺ™ĂˇdkĹŻ z pĹŻvodnĂ­ho souboru ilustrujĂ­cĂ­ problĂ©m",
      "suggestedCode": "VolitelnĂ˝ opravovĂ˝ kĂłd"
    }
  ],
  "generalSuggestions": ["ÄŤeskĂ© obecnĂ© doporuÄŤenĂ­ neodpovĂ­dajĂ­cĂ­ konkrĂ©tnĂ­mu Ĺ™Ăˇdku"]
}

Pravidla:
- OdpovĂ­dej ÄŤesky.
- NejvĂ˝Ĺˇe 8 komentĂˇĹ™ĹŻ.
- NĂˇpis title: krĂˇtkĂ˝, max 6 slov.
- problem a recommendation: krĂˇtkĂ© odrĹŻkovĂ© body, kaĹľdĂ˝ na novĂ©m Ĺ™Ăˇdku zaÄŤĂ­najĂ­cĂ­ "-".
- NepĂ­Ĺˇi dlouhĂ© odstavce â€” preferuj 2â€“4 krĂˇtkĂ© odrĹŻky.
- lineStart/lineEnd: uvedeĹ jen kdyĹľ si jsi jistĂ˝ pĹ™esnĂ˝m mĂ­stem; jinak vynechat.
- codeSnippet: 1â€“5 Ĺ™ĂˇdkĹŻ z pĹŻvodnĂ­ho souboru ilustrujĂ­cĂ­ problĂ©m.
- suggestedCode: volitelnĂ˝, pouze kdyĹľ mĂˇĹˇ konkrĂ©tnĂ­ oprĂˇvnÄ›nĂ˝ nĂˇvrh.
- verdict: "pass" = ĹľĂˇdnĂ© zĂˇsadnĂ­ problĂ©my; "comment" = jen mala doporuÄŤenĂ­; "needs_changes" = dĹŻleĹľitĂ© problĂ©my.
- ZamÄ›Ĺ™ se na konkrĂ©tnĂ­ problĂ©my udrĹľovatelnĂ©ho kĂłdu, sprĂˇvnosti, Dataverse/Power Apps specifika."#;

    let full_instructions = if instructions.is_empty() {
        json_format_requirement.trim_start().to_string()
    } else {
        format!("{instructions}{json_format_requirement}")
    };

    let temp_opt = if temperature > 0.0 { Some(temperature) } else { None };
    let text = call_ai_text_with_temperature(&ai_config, &full_instructions, &prompt, temp_opt).await?;
    let stripped = strip_json_fences(text.trim());

    // Try to parse the model response as structured JSON.
    match serde_json::from_str::<Value>(stripped) {
        Ok(mut parsed) => {
            // Inject the fields that the frontend expects (reviewerName, filePath, fileName)
            // directly into the structured object so callers don't need to graft them on.
            parsed["reviewerName"] = serde_json::Value::String(reviewer_name);
            parsed["filePath"]     = serde_json::Value::String(file_path);
            parsed["fileName"]     = serde_json::Value::String(file_name);
            Ok(serde_json::json!({ "structured": parsed, "markdown": null }))
        }
        Err(_) => {
            // JSON parsing failed â€” return as markdown so the frontend can still show the result.
            let header = format!("**Reviewer:** {reviewer_name}  \n**File:** {file_name}\n\n---\n\n");
            Ok(serde_json::json!({ "structured": null, "markdown": format!("{header}{text}") }))
        }
    }
}

/// Strips optional ```json ... ``` or ``` ... ``` fences the model may emit.
fn strip_json_fences(s: &str) -> &str {
    let s = if s.starts_with("```json") { &s[7..] }
            else if s.starts_with("```")  { &s[3..] }
            else                           { s };
    let s = s.trim_start();
    if s.ends_with("```") { s[..s.len() - 3].trim_end() } else { s }
}

/// AI code review that operates on a Git diff rather than a complete source file.
///
/// # Parameters
/// - `diff`          - Raw unified diff text (output of `git diff`).
/// - `task_context`  - Short task description used as context for the AI.
/// - `file_name`     - Display name of the file being reviewed (e.g. "CustomerPlugin.cs").
/// - `reviewer_name` - Name of the reviewer profile (injected into the result).
/// - `instructions`  - Reviewer-specific system instructions (from AI Reviewers settings).
/// - `model_override`- Overrides the default AI model when non-empty.
/// - `temperature`   - Sampling temperature (0.0 = deterministic).
#[tauri::command]
async fn run_ai_change_review(
    app: tauri::AppHandle,
    diff: String,
    task_context: String,
    file_name: String,
    reviewer_name: String,
    instructions: String,
    model_override: String,
    temperature: f64,
) -> Result<Value, String> {
    let mut ai_config = get_ai_config(&app)?;
    if !model_override.trim().is_empty() {
        ai_config.model = model_override.trim().to_string();
    }

    // Cap diff at 200 KB to stay within model context limits.
    const MAX_BYTES: usize = 200 * 1024;
    let diff_content = if diff.len() > MAX_BYTES {
        let boundary = (0..=MAX_BYTES).rev().find(|&i| diff.is_char_boundary(i)).unwrap_or(0);
        format!("{}\n\nâ€¦ [diff truncated at 200 KB]", &diff[..boundary])
    } else {
        diff.clone()
    };

    let context_line = if task_context.is_empty() {
        String::new()
    } else {
        format!("\n\nTask context: {task_context}")
    };

    let prompt = format!(
        "Review the following Git diff for file: **{file_name}**{context_line}\n\n```diff\n{diff_content}\n```"
    );

    let json_format_requirement = r#"

RecenzujeĹˇ POUZE zmÄ›ny zobrazenĂ© v diff â€” nekomentujeĹˇ kĂłd, kterĂ˝ diff nezahrnuje.
Pokud diff neobsahuje dostatek kontextu pro posouzenĂ­ urÄŤitĂ©ho aspektu, uveÄŹ to struÄŤnÄ›,
ale nevymĂ˝Ĺˇlej problĂ©my v kĂłdu, kterĂ˝ v diffu nenĂ­ vidÄ›t.

VrĂˇĹĄ POUZE platnĂ© JSON bez prose, bez markdown kĂłdovĂ˝ch blokĹŻ, bez jinĂ©ho textu.
VeĹˇkerĂ˝ textovĂ˝ obsah (summary, title, problem, recommendation, generalSuggestions) piĹˇ ÄŤesky.
KĂłdovĂ© Ăşseky (codeSnippet, suggestedCode) ponechĂˇvej v originĂˇlnĂ­m programovacĂ­m jazyce.

PoĹľadovanĂ© schĂ©ma:
{
  "verdict": "pass" | "needs_changes" | "comment",
  "summary": "ÄŤeskĂ˝ souhrnnĂ˝ odstavec o zmÄ›nĂˇch v diffu.",
  "comments": [
    {
      "severity": "critical" | "major" | "minor" | "suggestion",
      "lineStart": 42,
      "lineEnd": 58,
      "title": "KrĂˇtkĂ˝ ÄŤeskĂ˝ nĂˇzev problĂ©mu",
      "problem": "- PrvnĂ­ problĂ©m\n- DruhĂ˝ problĂ©m",
      "recommendation": "- PrvnĂ­ krok\n- DruhĂ˝ krok",
      "codeSnippet": "1â€“5 Ĺ™ĂˇdkĹŻ z diffu ilustrujĂ­cĂ­ problĂ©m",
      "suggestedCode": "VolitelnĂ˝ opravovĂ˝ kĂłd"
    }
  ],
  "generalSuggestions": ["ÄŤeskĂ© obecnĂ© doporuÄŤenĂ­ k diffu"]
}

Pravidla:
- OdpovĂ­dej ÄŤesky.
- Komentuj POUZE Ĺ™Ăˇdky oznaÄŤenĂ© '+' nebo '-' v diffu â€” ignoruj kontext ('  ').
- NejvĂ˝Ĺˇe 8 komentĂˇĹ™ĹŻ.
- title: krĂˇtkĂ˝, max 6 slov.
- problem a recommendation: krĂˇtkĂ© odrĂˇĹľkovĂ© body, kaĹľdĂ˝ zaÄŤĂ­najĂ­cĂ­ '-'.
- lineStart/lineEnd: ÄŤĂ­sla Ĺ™ĂˇdkĹŻ z diffu ('+' strany), pokud je lze spolehlivÄ› urÄŤit.
- verdict: "pass" = vĹˇe v poĹ™Ăˇdku; "comment" = drobnĂˇ doporuÄŤenĂ­; "needs_changes" = dĹŻleĹľitĂ© problĂ©my.
- ZamÄ›Ĺ™ se na konkrĂ©tnĂ­ problĂ©my v novĂ˝ch/zmÄ›nÄ›nĂ˝ch Ĺ™ĂˇdcĂ­ch â€” sprĂˇvnost, udrĹľovatelnost, Dataverse/Power Apps specifika."#;

    let full_instructions = if instructions.is_empty() {
        json_format_requirement.trim_start().to_string()
    } else {
        format!("{instructions}{json_format_requirement}")
    };

    let temp_opt = if temperature > 0.0 { Some(temperature) } else { None };
    let text = call_ai_text_with_temperature(&ai_config, &full_instructions, &prompt, temp_opt).await?;
    let stripped = strip_json_fences(text.trim());

    match serde_json::from_str::<Value>(stripped) {
        Ok(mut parsed) => {
            parsed["reviewerName"] = serde_json::Value::String(reviewer_name);
            // filePath is not a single file for a diff review â€” use file_name as a hint.
            parsed["filePath"]     = serde_json::Value::String(file_name.clone());
            parsed["fileName"]     = serde_json::Value::String(file_name);
            Ok(serde_json::json!({ "structured": parsed, "markdown": null }))
        }
        Err(_) => {
            let header = format!("**Reviewer:** {reviewer_name}  \n**File (diff):** {file_name}\n\n---\n\n");
            Ok(serde_json::json!({ "structured": null, "markdown": format!("{header}{text}") }))
        }
    }
}

/// AI Kit implementation command.
///
/// Takes the current artifact file content, task context, and pre-assembled AI Kit
/// instructions (already loaded and assembled by the frontend), calls the AI, and
/// returns the proposed new file content plus a structured summary.
///
/// The artifact file is NOT read or written by this command â€” the frontend is
/// responsible for reading it before the call and writing the result after user
/// confirmation.
///
/// # Parameters
/// - `artifact_content`  - Current content of the target file.
/// - `task_context`      - Structured task context string (title, description, setup, etc.).
/// - `instructions`      - Full system instructions string (assembled from AI Kit rules).
/// - `model_override`    - Optional model name override. Empty = use global model.
/// - `temperature`       - Sampling temperature (0.0 = use default 0.2).
#[tauri::command]
async fn run_ai_kit_implementation(
    app: tauri::AppHandle,
    artifact_content: String,
    task_context: String,
    instructions: String,
    model_override: String,
    temperature: f64,
) -> Result<Value, String> {
    let mut ai_config = get_ai_config(&app)?;
    if !model_override.trim().is_empty() {
        ai_config.model = model_override.trim().to_string();
    }

    const MAX_BYTES: usize = 150 * 1024;
    let content_trimmed = if artifact_content.len() > MAX_BYTES {
        let boundary = (0..=MAX_BYTES).rev().find(|&i| artifact_content.is_char_boundary(i)).unwrap_or(0);
        format!("{}\n\nâ€¦ [file truncated at 150 KB]", &artifact_content[..boundary])
    } else {
        artifact_content.clone()
    };

    let prompt = format!(
        "{task_context}\n\n## CURRENT FILE CONTENT\n\n```\n{content_trimmed}\n```\n\nImplement the required changes according to the task and rules above. Return ONLY the JSON response â€” no prose, no fences."
    );

    let temp_opt = if temperature > 0.0 { Some(temperature) } else { None };
    let text = call_ai_text_with_temperature(&ai_config, &instructions, &prompt, temp_opt).await?;
    let stripped = strip_json_fences(text.trim());

    match serde_json::from_str::<Value>(stripped) {
        Ok(parsed) => Ok(serde_json::json!({ "ok": true, "result": parsed, "rawText": null })),
        Err(_) => {
            // Return raw text so the frontend can show it to the user even when JSON parsing fails.
            Ok(serde_json::json!({ "ok": false, "result": null, "rawText": text }))
        }
    }
}

/// Creates a new plugin project directory from a local template folder.
/// Copies the template tree into target_dir/<project_name>, replacing
/// __PROJECT_NAME__ and __NAMESPACE__ placeholders in file contents and names.
/// Returns the absolute path of the created project folder.
#[tauri::command]
/// Generates a 1024-bit RSA strong-name key (`.snk`) at `path` using the
/// PowerShell RSACryptoServiceProvider API (available wherever .NET Framework is installed).
/// Returns true when the key was created successfully.
fn generate_snk_key(path: &std::path::Path) -> bool {
    let path_str = path.to_string_lossy();
    // Escape single quotes in the path for safety.
    let safe_path = path_str.replace('\'', "''");
    let ps_cmd = format!(
        "$k = New-Object System.Security.Cryptography.RSACryptoServiceProvider(1024); \
         [System.IO.File]::WriteAllBytes('{safe_path}', $k.ExportCspBlob($true))"
    );
    let result = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    if let Ok(status) = result {
        if status.success() && path.exists() {
            return true;
        }
    }
    false
}

/// Returns a minimal Dynamics 365 IPlugin class stub as a UTF-8 string.
fn build_plugin_class_stub(namespace: &str, class_name: &str) -> String {
    format!(
        "using Microsoft.Xrm.Sdk;\r\n\
using System;\r\n\
\r\n\
namespace {namespace}\r\n\
{{\r\n    \
/// <summary>\r\n    \
/// Plugin stub for {namespace}.\r\n    \
/// </summary>\r\n    \
public class {class_name} : IPlugin\r\n    \
{{\r\n        \
public void Execute(IServiceProvider serviceProvider)\r\n        \
{{\r\n            \
ITracingService tracer = (ITracingService)serviceProvider.GetService(typeof(ITracingService));\r\n            \
IPluginExecutionContext context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));\r\n            \
IOrganizationServiceFactory serviceFactory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));\r\n            \
IOrganizationService service = serviceFactory.CreateOrganizationService(context.UserId);\r\n\r\n            \
if (context.InputParameters.Contains(\"Target\") && context.InputParameters[\"Target\"] is Entity)\r\n            \
{{\r\n                \
Entity contextEntity = (Entity)context.InputParameters[\"Target\"];\r\n                \
Guid initiatingUserId = context.InitiatingUserId;\r\n\r\n                \
// TODO: implement plugin logic\r\n            \
}}\r\n        \
}}\r\n    \
}}\r\n\
}}\r\n"
    )
}

#[tauri::command]
fn create_plugin_project_from_template(
    template_dir: String,
    plugins_dir: String,
    project_name: String,
    namespace: String,
    create_initial_class: bool,
    legacy_style: bool,
) -> Result<String, String> {
    let dest = std::path::Path::new(&plugins_dir).join(&project_name);
    if dest.exists() {
        return Err(format!("Project folder already exists: {}", dest.display()));
    }

    if template_dir.is_empty() {
        // -----------------------------------------------------------------
        // Built-in default scaffold â€” no custom template configured.
        // Standard Visual Studio layout:
        //   <plugins_dir>/<project_name>/                â† solution root
        //     <project_name>.sln
        //     <project_name>/                            â† project folder
        //       <project_name>.csproj
        //       (legacy: packages.config, app.config, key.snk, Properties/AssemblyInfo.cs)
        //       <ClassName>.cs  (when create_initial_class is true)
        // -----------------------------------------------------------------
        fs::create_dir_all(&dest).map_err(|e| format!("Failed to create solution root: {e}"))?;

        let proj_dir = dest.join(&project_name);
        fs::create_dir_all(&proj_dir).map_err(|e| format!("Failed to create project folder: {e}"))?;

        // Stable project GUID for .sln / .csproj consistency
        let proj_guid = format!("{:08X}-{:04X}-{:04X}-{:04X}-{:012X}",
            0xAABBCCDDu32, 0x1234u16, 0x5678u16, 0x9ABCu16, 0x0123456789ABu64);
        // C# project type GUID (same for SDK-style and legacy)
        let cs_project_type_guid = "FAE04EC0-301F-11D3-BF4B-00C04F79EFBC";

        // Resolve the latest stable CrmSdk version from NuGet; fall back to a known-good version.
        let crmsdk_version = resolve_nuget_version("Microsoft.CrmSdk.CoreAssemblies", "9.0.2.49");

        // ----- .sln (identical for both styles) -----
        let sln = format!(
            "\u{feff}\r\nMicrosoft Visual Studio Solution File, Format Version 12.00\r\n\
# Visual Studio Version 17\r\n\
VisualStudioVersion = 17.0.31903.59\r\n\
MinimumVisualStudioVersion = 10.0.40219.1\r\n\
Project(\"{{{cs_project_type_guid}}}\") = \"{project_name}\", \"{project_name}\\{project_name}.csproj\", \"{{{proj_guid}}}\"\r\n\
EndProject\r\n\
Global\r\n\
\tGlobalSection(SolutionConfigurationPlatforms) = preSolution\r\n\
\t\tDebug|Any CPU = Debug|Any CPU\r\n\
\t\tRelease|Any CPU = Release|Any CPU\r\n\
\tEndGlobalSection\r\n\
\tGlobalSection(ProjectConfigurationPlatforms) = postSolution\r\n\
\t\t{{{proj_guid}}}.Debug|Any CPU.ActiveCfg = Debug|Any CPU\r\n\
\t\t{{{proj_guid}}}.Debug|Any CPU.Build.0 = Debug|Any CPU\r\n\
\t\t{{{proj_guid}}}.Release|Any CPU.ActiveCfg = Release|Any CPU\r\n\
\t\t{{{proj_guid}}}.Release|Any CPU.Build.0 = Release|Any CPU\r\n\
\tEndGlobalSection\r\n\
EndGlobal\r\n"
        );
        fs::write(dest.join(format!("{project_name}.sln")), sln.as_bytes())
            .map_err(|e| format!("Failed to write .sln: {e}"))?;

        // ----- Initial plugin class body (shared) -----
        let class_name = format!("{}Plugin", project_name.split('.').last().unwrap_or(&project_name));

        if legacy_style {
            // =============================================================
            // Legacy Visual Studio / packages.config scaffold
            // Compatible with Visual Studio 2017+ and Dynamics 365 plugin
            // development workflow (NuGet restore, assembly signing, etc.).
            // =============================================================

            // --- Properties/AssemblyInfo.cs ---
            let props_dir = proj_dir.join("Properties");
            fs::create_dir_all(&props_dir)
                .map_err(|e| format!("Failed to create Properties folder: {e}"))?;
            let assembly_guid = format!("{:08X}-{:04X}-{:04X}-{:04X}-{:012X}",
                0x11223344u32, 0xAABBu16, 0xCCDDu16, 0xEEFFu16, 0x001122334455u64);
            let assembly_info = format!(
                "using System.Reflection;\r\n\
using System.Runtime.InteropServices;\r\n\
\r\n\
[assembly: AssemblyTitle(\"{project_name}\")]\r\n\
[assembly: AssemblyDescription(\"\")]\r\n\
[assembly: AssemblyConfiguration(\"\")]\r\n\
[assembly: AssemblyCompany(\"\")]\r\n\
[assembly: AssemblyProduct(\"{project_name}\")]\r\n\
[assembly: AssemblyCopyright(\"Copyright \u{00A9} {year}\")]\r\n\
[assembly: AssemblyTrademark(\"\")]\r\n\
[assembly: AssemblyCulture(\"\")]\r\n\
[assembly: ComVisible(false)]\r\n\
[assembly: Guid(\"{assembly_guid}\")]\r\n\
[assembly: AssemblyVersion(\"1.0.0.0\")]\r\n\
[assembly: AssemblyFileVersion(\"1.0.0.0\")]\r\n",
                year = chrono_now_iso().get(..4).unwrap_or("2024"),
            );
            fs::write(props_dir.join("AssemblyInfo.cs"), assembly_info.as_bytes())
                .map_err(|e| format!("Failed to write AssemblyInfo.cs: {e}"))?;

            // --- packages.config ---
            let packages_config = format!(
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n\
<packages>\r\n  \
<package id=\"Microsoft.CrmSdk.CoreAssemblies\" version=\"{crmsdk_version}\" targetFramework=\"net462\" />\r\n\
</packages>\r\n"
            );
            fs::write(proj_dir.join("packages.config"), packages_config.as_bytes())
                .map_err(|e| format!("Failed to write packages.config: {e}"))?;

            // --- app.config ---
            let app_config =
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n\
<configuration>\r\n  \
<startup>\r\n    \
<supportedRuntime version=\"v4.0\" sku=\".NETFramework,Version=v4.6.2\" />\r\n  \
</startup>\r\n\
</configuration>\r\n";
            fs::write(proj_dir.join("app.config"), app_config.as_bytes())
                .map_err(|e| format!("Failed to write app.config: {e}"))?;

            // --- key.snk â€” generate using PowerShell RSA crypto API ---
            let snk_path = proj_dir.join("key.snk");
            let snk_generated = generate_snk_key(&snk_path);
            if !snk_generated {
                // PowerShell unavailable: write a placeholder readme instead; signing
                // is enabled in .csproj but the user must provide the key manually.
                let placeholder = "Generate key.snk with:\r\n  sn.exe -k key.snk\r\nor PowerShell:\r\n  $k = New-Object System.Security.Cryptography.RSACryptoServiceProvider(1024)\r\n  [System.IO.File]::WriteAllBytes('key.snk', $k.ExportCspBlob($true))\r\n";
                let _ = fs::write(proj_dir.join("key.snk.txt"), placeholder.as_bytes());
            }

            // --- .csproj (legacy packages.config style) ---
            // Compile items are listed explicitly; new plugin classes generated by
            // Generate Draft must be added or the project re-opened to pick them up.
            let signing_prop = if snk_generated {
                "    <SignAssembly>true</SignAssembly>\r\n    <AssemblyOriginatorKeyFile>key.snk</AssemblyOriginatorKeyFile>\r\n"
            } else {
                "    <!-- SignAssembly: add key.snk and enable here -->\r\n"
            };
            let initial_compile = if create_initial_class {
                format!("    <Compile Include=\"{class_name}.cs\" />\r\n")
            } else {
                String::new()
            };
            let csproj = format!(
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n\
<Project ToolsVersion=\"15.0\" xmlns=\"http://schemas.microsoft.com/developer/msbuild/2003\">\r\n  \
<Import Project=\"$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props\" Condition=\"Exists('$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props')\" />\r\n  \
<PropertyGroup>\r\n    \
<Configuration Condition=\" '$(Configuration)' == '' \">Debug</Configuration>\r\n    \
<Platform Condition=\" '$(Platform)' == '' \">AnyCPU</Platform>\r\n    \
<ProjectGuid>{{{proj_guid}}}</ProjectGuid>\r\n    \
<OutputType>Library</OutputType>\r\n    \
<AppDesignerFolder>Properties</AppDesignerFolder>\r\n    \
<RootNamespace>{namespace}</RootNamespace>\r\n    \
<AssemblyName>{project_name}</AssemblyName>\r\n    \
<TargetFrameworkVersion>v4.6.2</TargetFrameworkVersion>\r\n    \
<FileAlignment>512</FileAlignment>\r\n    \
<Deterministic>false</Deterministic>\r\n\
{signing_prop}  \
</PropertyGroup>\r\n  \
<PropertyGroup Condition=\" '$(Configuration)|$(Platform)' == 'Debug|AnyCPU' \">\r\n    \
<DebugSymbols>true</DebugSymbols>\r\n    \
<DebugType>full</DebugType>\r\n    \
<Optimize>false</Optimize>\r\n    \
<OutputPath>bin\\Debug\\</OutputPath>\r\n    \
<DefineConstants>DEBUG;TRACE</DefineConstants>\r\n    \
<ErrorReport>prompt</ErrorReport>\r\n    \
<WarningLevel>4</WarningLevel>\r\n  \
</PropertyGroup>\r\n  \
<PropertyGroup Condition=\" '$(Configuration)|$(Platform)' == 'Release|AnyCPU' \">\r\n    \
<DebugType>pdbonly</DebugType>\r\n    \
<Optimize>true</Optimize>\r\n    \
<OutputPath>bin\\Release\\</OutputPath>\r\n    \
<DefineConstants>TRACE</DefineConstants>\r\n    \
<ErrorReport>prompt</ErrorReport>\r\n    \
<WarningLevel>4</WarningLevel>\r\n  \
</PropertyGroup>\r\n  \
<ItemGroup>\r\n    \
<Reference Include=\"System\" />\r\n    \
<Reference Include=\"System.Runtime.Serialization\" />\r\n    \
<Reference Include=\"Microsoft.Crm.Sdk.Proxy\">\r\n      \
<HintPath>..\\packages\\Microsoft.CrmSdk.CoreAssemblies.{crmsdk_version}\\lib\\net462\\Microsoft.Crm.Sdk.Proxy.dll</HintPath>\r\n      \
<Private>False</Private>\r\n    \
</Reference>\r\n    \
<Reference Include=\"Microsoft.Xrm.Sdk\">\r\n      \
<HintPath>..\\packages\\Microsoft.CrmSdk.CoreAssemblies.{crmsdk_version}\\lib\\net462\\Microsoft.Xrm.Sdk.dll</HintPath>\r\n      \
<Private>False</Private>\r\n    \
</Reference>\r\n  \
</ItemGroup>\r\n  \
<ItemGroup>\r\n    \
<Compile Include=\"Properties\\AssemblyInfo.cs\" />\r\n\
{initial_compile}  \
</ItemGroup>\r\n  \
<ItemGroup>\r\n    \
<None Include=\"app.config\" />\r\n    \
<None Include=\"packages.config\" />\r\n    \
{key_none}\
</ItemGroup>\r\n  \
<Import Project=\"$(MSBuildToolsPath)\\Microsoft.CSharp.targets\" />\r\n\
</Project>\r\n",
                key_none = if snk_generated { "    <None Include=\"key.snk\" />\r\n  " } else { "  " },
            );
            fs::write(proj_dir.join(format!("{project_name}.csproj")), csproj.as_bytes())
                .map_err(|e| format!("Failed to write .csproj: {e}"))?;

            // --- Initial plugin class ---
            if create_initial_class {
                let class_file = proj_dir.join(format!("{class_name}.cs"));
                if !class_file.exists() {
                    let content = build_plugin_class_stub(&namespace, &class_name);
                    fs::write(&class_file, content.as_bytes())
                        .map_err(|e| format!("Failed to write initial class: {e}"))?;
                }
            }

        } else {
            // =============================================================
            // SDK-style scaffold (PackageReference, net462, MSBuild SDK)
            // =============================================================
            let csproj = format!(
                "<Project Sdk=\"Microsoft.NET.Sdk\">\r\n  \
<PropertyGroup>\r\n    \
<TargetFramework>net462</TargetFramework>\r\n    \
<LangVersion>latest</LangVersion>\r\n    \
<Nullable>disable</Nullable>\r\n    \
<AssemblyName>{project_name}</AssemblyName>\r\n    \
<RootNamespace>{namespace}</RootNamespace>\r\n    \
<GenerateAssemblyInfo>false</GenerateAssemblyInfo>\r\n  \
</PropertyGroup>\r\n  \
<ItemGroup>\r\n    \
<PackageReference Include=\"Microsoft.CrmSdk.CoreAssemblies\" Version=\"{crmsdk_version}\" />\r\n  \
</ItemGroup>\r\n\
</Project>\r\n"
            );
            fs::write(proj_dir.join(format!("{project_name}.csproj")), csproj.as_bytes())
                .map_err(|e| format!("Failed to write .csproj: {e}"))?;

            if create_initial_class {
                let class_file = proj_dir.join(format!("{class_name}.cs"));
                if !class_file.exists() {
                    let content = build_plugin_class_stub(&namespace, &class_name);
                    fs::write(&class_file, content.as_bytes())
                        .map_err(|e| format!("Failed to write initial class: {e}"))?;
                }
            }

            // Try to format with dotnet format (best-effort, failure ignored).
            let _ = std::process::Command::new("dotnet")
                .args(["format", &dest.join(format!("{project_name}.sln")).to_string_lossy()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }

        return Ok(dest.to_string_lossy().to_string());
    }

    // -----------------------------------------------------------------
    // Custom template path
    // -----------------------------------------------------------------
    let src = std::path::Path::new(&template_dir);
    if !src.is_dir() {
        return Err(format!("Template directory not found: {template_dir}"));
    }

    // Derive substitution values.
    let plugin_class       = format!("{}Plugin", project_name.split('.').last().unwrap_or(&project_name));
    let assembly_guid      = task_mcp_generate_id();
    // Literal template folder base name (e.g. "Template.Plugin") â€” replaced with project_name
    // in all names and content so a real VS project works as a template without manual renaming.
    let template_base_name = src.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    // Copy template tree (skips .vs, bin, obj, packages, key.snk, copilot-instructions.md)
    copy_template_tree(src, &dest, &project_name, &namespace, &plugin_class, &assembly_guid, &template_base_name)
        .map_err(|e| format!("Template copy failed: {e}"))?;

    // Generate a fresh key.snk after the copy.
    // Never reuse a key from the template â€” each project must have its own signing key.
    // The key is placed in the project subfolder if it exists (standard VS layout), or at
    // the solution root otherwise.
    {
        let proj_subdir = dest.join(&project_name);
        let snk_target = if proj_subdir.is_dir() {
            proj_subdir.join("key.snk")
        } else {
            dest.join("key.snk")
        };
        generate_snk_key(&snk_target);
        // Failure is intentionally non-fatal: key generation is best-effort
        // and the user can add a key manually after project creation.
    }

    // When create_initial_class=false, remove the generic starter plugin class that the
    // template may include (pattern: <ProjectLastSegment>Plugin.cs e.g. ProjectPlugin.cs).
    // The task-specific class will be created later by the Generate Draft step.
    // Both flat layouts (<dest>/FooPlugin.cs) and VS layouts (<dest>/<ProjectName>/FooPlugin.cs)
    // are handled. Only the predictable template starter name is removed; no glob removal.
    if !create_initial_class {
        let last_segment = project_name.split('.').last().unwrap_or(&project_name);
        let generic_name = format!("{last_segment}Plugin.cs");
        let candidates = [
            dest.join(&generic_name),
            dest.join(&project_name).join(&generic_name),
        ];
        for candidate in &candidates {
            if candidate.exists() {
                let _ = fs::remove_file(candidate);
            }
        }
    }

    Ok(dest.to_string_lossy().to_string())
}

/// Recursively copies `src` into `dest`, substituting placeholders in file names,
/// folder names, and text file contents.
///
/// **Always skipped directories** (never copied into the generated project):
///   .github  .vs  bin  obj  packages
///
/// **Always skipped files** (must be generated fresh per project, not copied):
///   key.snk  copilot-instructions.md
///
/// **Supported placeholders** (file names, folder names, and text content):
///   __PROJECT_NAME__  â€” project/assembly name  (e.g. "Navertica.Account")
///   __NAMESPACE__     â€” .NET root namespace      (may equal project name)
///   __PLUGIN_CLASS__  â€” plugin class stub name   (e.g. "AccountPlugin")
///   __ASSEMBLY_GUID__ â€” fresh GUID per project   (e.g. "12345678-...")
// template_base_name: literal folder name of the template (e.g. "Template.Plugin").
// Substituted with project_name in names and content alongside the __PLACEHOLDER__ tokens.
fn copy_template_tree(
    src: &std::path::Path,
    dest: &std::path::Path,
    project_name: &str,
    namespace: &str,
    plugin_class: &str,
    assembly_guid: &str,
    template_base_name: &str,
) -> Result<(), io::Error> {
    /// Apply all substitutions to a string: explicit placeholders first, then the
    /// literal template base name (only when non-empty and different from project_name).
    fn subst(s: &str, project_name: &str, namespace: &str,
             plugin_class: &str, assembly_guid: &str, base: &str) -> String {
        let mut out = s
            .replace("__PROJECT_NAME__", project_name)
            .replace("__NAMESPACE__", namespace)
            .replace("__PLUGIN_CLASS__", plugin_class)
            .replace("__ASSEMBLY_GUID__", assembly_guid);
        if !base.is_empty() && base != project_name {
            out = out.replace(base, project_name);
        }
        out
    }

    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();
        let src_path = entry.path();

        // --- Skip unwanted directories ---
        if src_path.is_dir() && matches!(
            name_str.as_ref(),
            ".github" | ".vs" | "bin" | "obj" | "packages"
        ) { continue; }

        // --- Skip files that must be generated fresh per project ---
        if src_path.is_file() && matches!(
            name_str.as_ref(),
            "key.snk" | "copilot-instructions.md"
        ) { continue; }

        // Substitute in the entry name (placeholders + literal base name)
        let new_name = subst(&name_str, project_name, namespace, plugin_class, assembly_guid, template_base_name);
        let dest_path = dest.join(&new_name);

        if src_path.is_dir() {
            copy_template_tree(&src_path, &dest_path, project_name, namespace,
                               plugin_class, assembly_guid, template_base_name)?;
        } else {
            let ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let is_text = matches!(ext, "cs" | "csproj" | "sln" | "json" | "xml"
                | "config" | "txt" | "md" | "targets" | "props" | "yml" | "yaml");
            if is_text {
                let content = fs::read_to_string(&src_path).unwrap_or_default();
                let new_content = subst(&content, project_name, namespace, plugin_class, assembly_guid, template_base_name);
                fs::write(&dest_path, new_content)?;
            } else {
                fs::copy(&src_path, &dest_path)?;
            }
        }
    }
    Ok(())
}

/// Classifies an imported inbox item (Outlook email or Teams message) using OpenAI.
/// Returns a ClassificationResult JSON object with isTask, confidence, title, etc.
/// Falls back to heuristic classification when no API key is configured.
#[tauri::command]
async fn classify_inbox_item(app: tauri::AppHandle, item: Value) -> Result<Value, String> {
    let title        = item["title"].as_str().unwrap_or("").to_string();
    let content      = item["originalMessage"].as_str().unwrap_or("").to_string();
    let sender_name  = item["senderName"].as_str().unwrap_or("").to_string();
    let sender_email = item["senderEmail"].as_str().unwrap_or("").to_string();
    let source       = item["source"].as_str().unwrap_or("email").to_string();

    // Truncate content to avoid unnecessarily large payloads.
    let content_trimmed = if content.len() > 3000 {
        format!("{}â€¦[truncated]", &content[..3000])
    } else {
        content.clone()
    };

    // Try AI. If not configured or call fails, use heuristic fallback.
    let ai_result = get_ai_config(&app);
    match ai_result {
        Ok(config) => {
            // --- AI path ---
            let source_context = match source.as_str() {
                "teams" => "Teams chat message (very noisy channel â€” be strict, require explicit request verbs or clear issues)",
                _       => "Outlook email (apply reasonable developer workflow classification)",
            };

            let instructions = "You are a classification assistant for a Dynamics 365 / Dataverse developer productivity app. \
Your job is to classify incoming messages and decide whether they represent real engineering work tasks. \
Be CONSERVATIVE: when in doubt, return isTask=false or low confidence. \
Respond with ONLY valid JSON â€” no markdown, no code fences, no explanation outside the JSON.";

            let prompt = format!(
"Classify this message for a CRM/Dynamics/Dataverse developer.\n\
Source type: {source_context}\n\
From: {sender_name} <{sender_email}>\n\
Subject/Title: {title}\n\
Content:\n{content_trimmed}\n\n\
DECISION RULES â€” apply strictly in this order:\n\n\
ALWAYS isTask=false (skip unconditionally):\n\
- Build/CI/pipeline result notifications (succeeded, failed, completed)\n\
- Change task or work item marked as FINISHED, COMPLETED, DONE, CLOSED\n\
- Out-of-office, vacation, leave approval notices\n\
- Meeting invitations, calendar responses (accepted/declined/tentative)\n\
- Newsletters, subscription emails, marketing\n\
- Casual acknowledgements: 'ok', 'thanks', 'approved', 'noted', 'prislo to', 'vyzkusam', 'premyslim'\n\
- Informational notifications with NO explicit required action: order confirmation/creation, portal registration, account status\n\
- Status updates confirming something already happened with no follow-up required\n\n\
isTask=true only when ALL of these apply:\n\
1. The message explicitly asks the developer to DO something (fix, review, deploy, investigate, respond)\n\
2. There is a specific subject: a file, system, customer, ticket, bug, or PR\n\
3. The developer is the expected actor (not just cc'd on an FYI)\n\n\
Confidence calibration:\n\
- 90-100: unambiguous direct request with customer + specific issue/file/ticket\n\
- 85-89: clear request, minor ambiguity about scope or urgency\n\
- 70-84: plausible work item but missing specifics or could be informational\n\
- 50-69: uncertain â€” might need action or might be informational\n\
- <50: almost certainly not a task\n\n\
Threshold note: items with confidence < 85 go to user review; >= 85 auto-create. \
Prefer lower confidence for borderline items rather than guessing high.\n\n\
Examples:\n\
- 'Bug na PtĂˇÄŤkovi v nvr_activity_events.js' â†’ isTask=true conf=90 (customer + file + bug)\n\
- 'Change task: ... (pending); Ticket: #76688; Neopharma' â†’ isTask=true conf=87 (pending helpdesk task)\n\
- 'Change task: ... (finished); Ticket: #76423' â†’ isTask=false (completed, no action)\n\
- 'Informace o vytvoĹ™enĂ­ objednĂˇvky z portĂˇlu' â†’ isTask=false (informational, no action required)\n\
- 'Build succeeded: main â†’ production' â†’ isTask=false (CI notification)\n\
- 'PR - VSM 113862 needs your review' â†’ isTask=true conf=88 (explicit review request)\n\n\
Respond with ONLY this JSON:\n\
{{\"isTask\":true,\"confidence\":85,\"title\":\"Short imperative action title (max 80 chars)\",\
\"summary\":\"1-2 sentences in English: what needs to be done and why\",\
\"summaryCz\":\"1-2 vÄ›ty ÄŤesky: co je tĹ™eba udÄ›lat a proÄŤ\",\
\"summaryEn\":\"1-2 sentences in English describing the problem\",\
\"problemPointsCz\":[\"KrĂˇtkĂ˝ ÄŤeskĂ˝ bod o problĂ©mu.\"],\
\"problemPointsEn\":[\"Short English bullet about the problem.\"],\
\"actionPointsCz\":[\"KonkrĂ©tnĂ­ akÄŤnĂ­ krok ÄŤesky.\"],\
\"actionPointsEn\":[\"Concrete action step in English.\"],\
\"nextStepCz\":\"Jeden jasnĂ˝ bezprostĹ™ednĂ­ krok ÄŤesky.\",\
\"nextStepEn\":\"One clear immediate next step in English.\",\
\"customerName\":null,\"taskType\":\"other\",\"estimatedEffort\":null,\"dueAt\":null,\
\"suggestedReply\":null,\"skipReason\":null}}\n\n\
Field rules:\n\
- taskType: bug-fix | feature | review | question | deployment | other\n\
- confidence: integer 0-100\n\
- estimatedEffort: hours as number or null\n\
- dueAt: ISO 8601 date or null\n\
- skipReason: brief reason if isTask=false, else null\n\
- suggestedReply: 1-2 sentence acknowledgement if a reply is appropriate, else null\n\
- ALL bilingual fields (summaryCz, summaryEn, *Cz, *En) are MANDATORY when isTask=true\n\
- *Cz fields: natural Czech. *En fields: natural English.\n\
- title: must be in Czech for Teams messages. Use an action-oriented noun phrase (e.g. 'Upravit moĹľnost zmÄ›ny data dokonÄŤenĂ­ Ăşkolu')."
            );

            let text_result = call_ai_text(&config, instructions, &prompt).await;
            match text_result {
                Ok(text) => {
                    match serde_json::from_str::<Value>(strip_fences(&text)) {
                        Ok(v) => {
                            eprintln!("[classify] AI result for \"{title}\": isTask={} conf={}",
                                v["isTask"], v["confidence"]);
                            Ok(v)
                        }
                        Err(e) => {
                            let snippet = &text[..text.len().min(300)];
                            eprintln!("[classify] JSON parse error: {e}. Falling back to heuristic. Response: {snippet}");
                            Ok(heuristic_classify_item(&title, &content, &sender_name, &source))
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[classify] OpenAI call failed: {e}. Falling back to heuristic.");
                    Ok(heuristic_classify_item(&title, &content, &sender_name, &source))
                }
            }
        }
        Err(_) => {
            // --- Heuristic path (no OpenAI API key configured) ---
            eprintln!("[classify] No AI key â€” using heuristic classification for: {title}");
            Ok(heuristic_classify_item(&title, &content, &sender_name, &source))
        }
    }
}

/// Heuristic classification used when no Claude API key is configured.
/// Detects actionable messages and issues from keyword patterns.
/// Works best for Czech/English developer chat messages.
fn heuristic_classify_item(
    title: &str,
    content: &str,
    sender_name: &str,
    source: &str,
) -> Value {
    let combined = format!("{} {}", title.to_lowercase(), content.to_lowercase());

    // --- Actionability check ---
    let action_words = [
        "please", "fix", "check", "review", "deploy", "verify", "look into",
        "could you", "can you", "would you", "we need", "i need",
        // Czech
        "potĹ™eboval", "kouknout", "podĂ­vat", "zkontrolovat", "opravit",
        "provÄ›Ĺ™it", "zobrazuje", "prosĂ­m",
    ];
    let issue_words = [
        "not working", "broken", "bug", "error", "fails", "crash", "wrong",
        "doesn't work", "cant work", "can't work",
        // Czech
        "nefunguje", "chyba", "problĂ©m", "nefunkcni", "nefunkÄŤnĂ­",
    ];
    // Environment words indicate developer-relevant context
    let env_words = ["prod", "production", "uat", "staging", "dev ", "development"];

    let action_score = action_words.iter().filter(|&&w| combined.contains(w)).count();
    let issue_score  = issue_words.iter().filter(|&&w| combined.contains(w)).count();
    let env_score    = env_words.iter().filter(|&&w| combined.contains(w)).count();

    // Teams base is 20 (matches frontend heuristicClassify.ts SOURCE_BASE).
    // Zero signals â†’ score stays below MIN_CONFIDENCE_ANALYZE (50) â†’ silently skipped.
    // Email base is 35 â€” emails generally have more context.
    let base = if source == "teams" { 20u32 } else { 35u32 };
    let score = (base + action_score as u32 * 8 + issue_score as u32 * 12 + env_score as u32 * 5).min(92);
    let is_task = score >= 50;

    let task_type = if issue_score > 0 { "bug-fix" } else { "other" };

    // Generate a title that's at least somewhat useful (the frontend will have set
    // a heuristic title already, but classify returns its own; use what we have)
    let generated_title = if title.len() > 10 && !title.to_lowercase().contains("teams message") {
        title.to_string()
    } else {
        heuristic_title_from_content(sender_name, content)
    };

    let summary = if is_task {
        format!(
            "Heuristic classification (no AI key): likely actionable ({score}% confidence). \
Review and adjust as needed."
        )
    } else {
        format!(
            "Heuristic classification (no AI key): may not require action ({score}% confidence). \
Review manually."
        )
    };

    serde_json::json!({
        "isTask": is_task,
        "title": generated_title,
        "summary": summary,
        "customerName": null,
        "taskType": task_type,
        "estimatedEffort": null,
        "dueAt": null,
        "confidence": score,
        "suggestedReply": null,
    })
}

/// Derives a usable title from message content when the provided title is poor.
fn heuristic_title_from_content(sender_name: &str, content: &str) -> String {
    // Skip the "From: / Chat:" header lines added by the import wrapper
    let body = content
        .lines()
        .filter(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with("From:") && !t.starts_with("Chat:")
        })
        .collect::<Vec<_>>()
        .join("\n");

    // Find the first meaningful sentence or line
    let first = body
        .split(|c| c == '\n' || c == '.' || c == '!' || c == '?')
        .map(|s| s.trim())
        .find(|s| s.len() > 8)
        .unwrap_or(&body[..body.len().min(80)]);

    let capped = if first.len() > 95 {
        format!("{}â€¦", &first[..92])
    } else {
        first.to_string()
    };

    if sender_name.is_empty() {
        capped
    } else {
        format!("{sender_name}: {capped}")
    }
}

/// Resets local task and customer data by writing empty arrays to disk.
/// Settings and Microsoft tokens are preserved.
#[tauri::command]
fn reset_local_data(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    write_json(&dir.join("tasks.json"), &serde_json::json!([]))?;
    write_json(&dir.join("customers.json"), &serde_json::json!([]))?;
    Ok(())
}

/// Opens a native folder-picker dialog.
/// Returns the selected folder path, or None if the user cancelled.
#[tauri::command]
fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();

    app.dialog()
        .file()
        .pick_folder(move |folder| {
            let path = folder.map(|f| f.to_string());
            let _ = tx.send(path);
        });

    rx.recv().map_err(|e| e.to_string())
}

/// Checks whether a filesystem path exists.
#[tauri::command]
fn check_path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// For each customer, resolves the repository path using:
///   1. repositoryRootOverride  (if set)
///   2. <base_dir>/<folderName> (if base_dir and folderName are set)
///   3. repositoryRoot          (fallback)
/// Sets `repositoryStatus` to "linked" / "missing" / "not_created" and
/// `resolvedRepositoryPath` to the resolved path (or null if none).
/// Returns the updated customers array.
#[tauri::command]
fn rescan_repositories(customers: Value, base_dir: String) -> Result<Value, String> {
    let arr = customers
        .as_array()
        .ok_or_else(|| "customers must be an array".to_string())?;

    let updated: Vec<Value> = arr
        .iter()
        .map(|c| {
            let mut customer = c.clone();

            // Resolve path using priority order
            let resolved: Option<String> = if let Some(ov) = c["repositoryRootOverride"].as_str().filter(|s| !s.is_empty()) {
                Some(ov.to_string())
            } else if !base_dir.is_empty() {
                c["folderName"].as_str().filter(|s| !s.is_empty()).map(|folder| {
                    let mut p = std::path::PathBuf::from(&base_dir);
                    p.push(folder);
                    p.to_string_lossy().to_string()
                })
            } else {
                c["repositoryRoot"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string())
            };

            let status = match &resolved {
                Some(path) if std::path::Path::new(path).exists() => "linked",
                Some(_) => "missing",
                None => "not_created",
            };

            customer["repositoryStatus"] = serde_json::json!(status);
            customer["resolvedRepositoryPath"] = match &resolved {
                Some(p) => serde_json::json!(p),
                None => Value::Null,
            };

            customer
        })
        .collect();

    Ok(Value::Array(updated))
}

// --- File picker ----------------------------------------------------------

/// Opens an OS file-picker dialog filtered to the given extensions.
/// Returns the chosen path, or null if the user cancelled.
#[tauri::command]
fn pick_file(app: tauri::AppHandle, filter_name: String, extensions: Vec<String>) -> Result<Option<String>, String> {
    let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    let result = app
        .dialog()
        .file()
        .add_filter(&filter_name, &exts)
        .blocking_pick_file();
    Ok(result.map(|p| p.to_string()))
}

// --- Template validation ---------------------------------------------------

/// Checks whether the given path is a usable repository template.
/// Returns one of: "not_selected", "valid", "invalid"
#[tauri::command]
fn validate_template(path: String, template_type: String) -> Result<String, String> {
    if path.is_empty() {
        return Ok("not_selected".to_string());
    }
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Ok("invalid".to_string());
    }
    match template_type.as_str() {
        "zip" => {
            // Try to open as a zip archive to confirm it is valid
            let file = fs::File::open(p).map_err(|e| e.to_string())?;
            match ZipArchive::new(file) {
                Ok(_) => Ok("valid".to_string()),
                Err(_) => Ok("invalid".to_string()),
            }
        }
        "folder" => {
            if p.is_dir() { Ok("valid".to_string()) } else { Ok("invalid".to_string()) }
        }
        _ => Ok("invalid".to_string()),
    }
}

// --- Repository creation from template -------------------------------------

/// Strips a common top-level directory prefix from archive entry paths.
/// E.g. if all entries start with "_GIT_REPO_TEMPLATE/" that prefix is removed.
fn strip_top_level_dir(entries: &[String]) -> Option<String> {
    if entries.is_empty() {
        return None;
    }
    // Find the top-level component of the first entry
    let first_top = entries[0].splitn(2, '/').next()?.to_string();
    if first_top.is_empty() {
        return None;
    }
    // Check that ALL entries share this top-level component
    let all_match = entries.iter().all(|e| {
        e == &first_top || e.starts_with(&format!("{}/", first_top))
    });
    if all_match { Some(format!("{}/", first_top)) } else { None }
}

/// Creates a customer repository at `target_path` by extracting a ZIP template.
/// If the ZIP has a single top-level folder, its contents are extracted directly
/// into `target_path` (the folder itself is not recreated).
#[tauri::command]
fn create_repository_from_template(
    template_path: String,
    target_path:   String,
) -> Result<(), String> {
    let zip_file = fs::File::open(&template_path)
        .map_err(|e| format!("Cannot open template: {e}"))?;
    let mut archive = ZipArchive::new(zip_file)
        .map_err(|e| format!("Invalid ZIP archive: {e}"))?;

    // Collect all entry names to detect the common top-level folder
    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let strip_prefix = strip_top_level_dir(&names);

    let target = std::path::Path::new(&target_path);
    fs::create_dir_all(target)
        .map_err(|e| format!("Cannot create target directory: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("ZIP read error: {e}"))?;

        let raw_name = entry.name().to_string();

        // Determine effective relative path after optional prefix strip
        let rel = match &strip_prefix {
            Some(pfx) => raw_name.strip_prefix(pfx.as_str()).unwrap_or(&raw_name),
            None => &raw_name,
        };

        if rel.is_empty() {
            continue; // top-level directory entry itself â€” skip it
        }

        let out_path = target.join(rel);

        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Cannot create directory {:?}: {e}", out_path))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Cannot create parent dir: {e}"))?;
            }
            let mut out_file = fs::File::create(&out_path)
                .map_err(|e| format!("Cannot create file {:?}: {e}", out_path))?;
            io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("Cannot write file {:?}: {e}", out_path))?;
        }
    }

    Ok(())
}

// --- Git initialization ---------------------------------------------------

/// Outcome of a git initialization attempt.
/// Serialised as camelCase JSON so it matches the TypeScript GitInitStatus type.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitInitResult {
    /// One of: "success" | "already_exists" | "git_not_found" | "failed"
    status:  String,
    message: String,
    /// True when an initial `git add . && git commit` was created.
    initial_commit_created: bool,
}

/// Runs `git init -b <branch>` in `path`.
///
/// Safety rules:
/// - Returns `already_exists` without touching anything if `.git/` is present.
/// - Returns `git_not_found` if the git binary is not in PATH.
/// - Returns `failed` with the stderr text on any non-zero exit code.
/// - Optionally stages all files and creates an initial commit when
///   `create_initial_commit` is true and the init succeeded.
#[tauri::command]
fn initialize_git_repository(
    path:                  String,
    branch:                String,
    create_initial_commit: bool,
) -> GitInitResult {
    let target = std::path::Path::new(&path);

    // Guard: skip if .git already exists
    if target.join(".git").exists() {
        return GitInitResult {
            status:  "already_exists".to_string(),
            message: ".git directory already present â€” skipped".to_string(),
            initial_commit_created: false,
        };
    }

    let branch = if branch.trim().is_empty() {
        "main".to_string()
    } else {
        branch.trim().to_string()
    };

    // Run: git init -b <branch> <path>
    let mut init_cmd = std::process::Command::new("git");
    init_cmd.args(["init", "-b", &branch, &path]);
    hide_console_window(&mut init_cmd);
    let init_out = init_cmd.output();

    let output = match init_out {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return GitInitResult {
                status:  "git_not_found".to_string(),
                message: "git binary not found in PATH. Install Git and ensure it is on the system PATH.".to_string(),
                initial_commit_created: false,
            };
        }
        Err(e) => {
            return GitInitResult {
                status:  "failed".to_string(),
                message: format!("Failed to launch git: {e}"),
                initial_commit_created: false,
            };
        }
        Ok(o) => o,
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return GitInitResult {
            status:  "failed".to_string(),
            message: if stderr.is_empty() { "git init exited with a non-zero status.".to_string() } else { stderr },
            initial_commit_created: false,
        };
    }

    // Optionally create an initial commit
    let mut committed = false;
    if create_initial_commit {
        // Stage all files
        let add_ok = {
            let mut cmd = std::process::Command::new("git");
            cmd.args(["-C", &path, "add", "."]);
            hide_console_window(&mut cmd);
            cmd.output().map(|o| o.status.success()).unwrap_or(false)
        };

        if add_ok {
            // Create commit â€” tolerate failure silently (e.g. nothing to commit)
            let commit_ok = {
                let mut cmd = std::process::Command::new("git");
                cmd.args(["-C", &path, "commit", "-m", "Initial commit"]);
                hide_console_window(&mut cmd);
                cmd.output().map(|o| o.status.success()).unwrap_or(false)
            };
            committed = commit_ok;
        }
    }

    GitInitResult {
        status:  "success".to_string(),
        message: String::new(),
        initial_commit_created: committed,
    }
}

/// Reads the content of a text file (JS/TS/etc.) for script inspection.
/// Caps at 500 KB to avoid loading huge build artefacts.
#[tauri::command]
fn read_file_content(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {path}"));
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Cannot read file: {e}"))?;
    if content.len() > 500_000 {
        Ok(content[..500_000].to_string())
    } else {
        Ok(content)
    }
}

/// Recursively walks `base_path` and returns the best candidate file for AI review.
/// For plugin mode: looks for .cs files, excluding bin/obj/.vs/packages directories,
/// preferring files that match the project name, class_hint words, or contain "IPlugin".
/// For script mode: looks for .js/.ts files, excluding node_modules/dist/build/.next/coverage,
/// preferring files containing formContext/executionContext/Xrm keywords.
/// Scoring also prefers files closer to the root (lower depth = higher score).
/// Returns the absolute path of the best candidate, or empty string if none found.
#[tauri::command]
fn infer_review_file_path(base_path: String, mode: String, project_name: String, class_hint: String) -> String {
    let base = std::path::Path::new(&base_path);
    if !base.exists() {
        return String::new();
    }
    // Safety: reject if base_path is not a directory (prevents treating a file as a search root).
    if base.is_file() {
        return base_path;
    }

    let is_plugin = mode == "plugin";
    let excluded_dirs_plugin: &[&str] = &["bin", "obj", ".vs", "packages", ".git"];
    let excluded_dirs_script: &[&str] = &["node_modules", "dist", "build", ".next", "coverage", ".git"];

    let mut candidates: Vec<(i32, std::path::PathBuf)> = Vec::new();
    let proj_lower = project_name.to_lowercase();

    // Extract meaningful words (3+ chars) from the class hint for name matching.
    let hint_words: Vec<String> = class_hint
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 3)
        .map(|w| w.to_lowercase())
        .collect();

    fn walk_dir(
        dir: &std::path::Path,
        is_plugin: bool,
        excluded: &[&str],
        proj_lower: &str,
        hint_words: &[String],
        depth: u32,
        candidates: &mut Vec<(i32, std::path::PathBuf)>,
    ) {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();

            if path.is_dir() {
                if excluded.iter().any(|ex| name == *ex) {
                    continue;
                }
                walk_dir(&path, is_plugin, excluded, proj_lower, hint_words, depth + 1, candidates);
            } else if path.is_file() {
                let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
                // Prefer files closer to the project root (max +3 bonus for depth 0).
                let depth_score = (3i32).saturating_sub(depth as i32).max(0);

                if is_plugin {
                    if ext != "cs" {
                        continue;
                    }
                    let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_lowercase();
                    let mut score: i32 = depth_score;
                    // Project folder name match.
                    if !proj_lower.is_empty() && stem.contains(&*proj_lower) {
                        score += 10;
                    }
                    // Class hint word match (e.g. words from task title).
                    for word in hint_words {
                        if stem.contains(word.as_str()) {
                            score += 4;
                        }
                    }
                    // Check for IPlugin implementation hint in file content (light scan).
                    if let Ok(content) = fs::read_to_string(&path) {
                        if content.contains(": IPlugin") || content.contains("IPlugin") {
                            score += 5;
                        }
                        if content.contains("class ") {
                            score += 1;
                        }
                    }
                    candidates.push((score, path));
                } else {
                    if ext != "js" && ext != "ts" {
                        continue;
                    }
                    // Skip declaration and test files.
                    let fname = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                    if fname.ends_with(".d.ts") || fname.contains(".test.") || fname.contains(".spec.") {
                        continue;
                    }
                    let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_lowercase();
                    let mut score: i32 = depth_score;
                    // Class hint word match on file name.
                    for word in hint_words {
                        if stem.contains(word.as_str()) {
                            score += 4;
                        }
                    }
                    if let Ok(content) = fs::read_to_string(&path) {
                        for kw in &["formContext", "executionContext", "Xrm.", "getFormContext"] {
                            if content.contains(kw) {
                                score += 5;
                            }
                        }
                        if content.contains("function ") || content.contains("=>") {
                            score += 1;
                        }
                    }
                    candidates.push((score, path));
                }
            }
        }
    }

    let excluded = if is_plugin { excluded_dirs_plugin } else { excluded_dirs_script };
    walk_dir(base, is_plugin, excluded, &proj_lower, &hint_words, 0, &mut candidates);

    // Sort descending by score, then ascending by path for stable tie-breaking.
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    candidates
        .into_iter()
        .next()
        .map(|(_, p)| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Lists files in `dir` that match `extension` (e.g. "js"), non-recursively.
/// Returns file names only (not full paths). Never fails â€” returns empty vec on any error.
#[tauri::command]
fn list_directory_files(dir: String, extension: String) -> Vec<String> {
    let path = std::path::Path::new(&dir);
    if !path.is_dir() {
        return vec![];
    }
    let ext_suffix = format!(".{}", extension.trim_start_matches('.'));
    let mut files: Vec<String> = fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_file())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.ends_with(&ext_suffix) { Some(name) } else { None }
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

/// Lists files in `dir` matching any of `extensions`, returning `{name, path}` objects.
/// When `recursive = false`, only the immediate directory is scanned (shallow).
/// When `recursive = true`, the tree is walked and any entry whose name (lowercase)
/// matches an entry in `excluded_dirs` is skipped entirely (e.g. "bin", "obj").
/// Never fails â€” returns an empty array on any filesystem error.
#[tauri::command]
fn list_files_with_paths(
    dir: String,
    extensions: Vec<String>,
    recursive: bool,
    excluded_dirs: Vec<String>,
) -> Vec<Value> {
    let root = std::path::Path::new(&dir);
    if !root.is_dir() { return vec![]; }

    // Normalise extensions: lowercase, strip leading dot.
    let exts: Vec<String> = extensions
        .iter()
        .map(|e| e.trim_start_matches('.').to_lowercase())
        .collect();

    let excluded: Vec<String> = excluded_dirs
        .iter()
        .map(|d| d.to_lowercase())
        .collect();

    let mut results: Vec<Value> = Vec::new();
    collect_files(root, &exts, recursive, &excluded, &mut results);
    results.sort_by(|a, b| {
        a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
    });
    results
}

/// Recursive helper for list_files_with_paths.
fn collect_files(
    dir: &std::path::Path,
    exts: &[String],
    recursive: bool,
    excluded: &[String],
    out: &mut Vec<Value>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let name_raw = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if recursive && !excluded.contains(&name_raw.to_lowercase()) {
                collect_files(&path, exts, recursive, excluded, out);
            }
        } else if path.is_file() {
            let lower = name_raw.to_lowercase();
            if exts.iter().any(|ext| lower.ends_with(&format!(".{ext}"))) {
                let abs = path.to_string_lossy().replace('\\', "/");
                out.push(serde_json::json!({ "name": name_raw, "path": abs }));
            }
        }
    }
}



/// Writes content to the given absolute path, creating directories as needed.
#[tauri::command]
fn save_generated_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create directory: {e}"))?;
    }
    fs::write(&path, content).map_err(|e| format!("Cannot write file: {e}"))
}

// --- NuGet restore for legacy packages.config plugin projects ----------------

#[derive(Serialize, Debug, Clone)]
struct NugetRestoreResult {
    /// true when Microsoft.Xrm.Sdk.dll exists on disk after restore.
    success: bool,
    /// "nuget_exe" | "direct_download" | "none"
    method: String,
    message: String,
    /// Whether Microsoft.Xrm.Sdk.dll physically exists after this operation.
    dll_exists: bool,
    /// Whether a missing Xrm.Sdk <Reference> was added to the .csproj.
    xrm_ref_added: bool,
}

/// Finds the first file with the given extension directly inside `dir` (non-recursive).
fn find_file_ext_in_dir(dir: &std::path::Path, ext: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().map_or(false, |e| e.eq_ignore_ascii_case(ext)) {
            return Some(p);
        }
    }
    None
}

/// Searches immediate subdirectories of `solution_dir` for a `packages.config`.
fn find_packages_config(solution_dir: &std::path::Path) -> Option<PathBuf> {
    let entries = fs::read_dir(solution_dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            let pc = p.join("packages.config");
            if pc.exists() { return Some(pc); }
        }
    }
    None
}

/// Searches immediate subdirectories of `solution_dir` for the first .csproj file.
fn find_csproj_in_solution(solution_dir: &std::path::Path) -> Option<PathBuf> {
    let entries = fs::read_dir(solution_dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(csproj) = find_file_ext_in_dir(&p, "csproj") {
                return Some(csproj);
            }
        }
    }
    None
}

/// Reads packages.config and returns the Microsoft.CrmSdk.CoreAssemblies id + version.
fn read_crmsdk_from_packages_config(path: &std::path::Path) -> Option<(String, String)> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines() {
        if line.to_lowercase().contains("microsoft.crmsdk.coreassemblies") {
            let id      = extract_xml_attr_value(line, "id")?;
            let version = extract_xml_attr_value(line, "version")?;
            return Some((id, version));
        }
    }
    None
}

fn extract_xml_attr_value(line: &str, attr: &str) -> Option<String> {
    let search = format!("{}=\"", attr.to_lowercase());
    let lower  = line.to_lowercase();
    let pos    = lower.find(&search)?;
    let after  = &line[pos + search.len()..];
    let end    = after.find('"')?;
    Some(after[..end].to_string())
}

/// Returns true if Microsoft.Xrm.Sdk.dll exists anywhere under `<solution_dir>/packages/`.
fn xrm_sdk_dll_exists(solution_dir: &std::path::Path) -> bool {
    let packages = solution_dir.join("packages");
    if !packages.exists() { return false; }
    let Ok(entries) = fs::read_dir(&packages) else { return false; };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if p.join("lib").join("net462").join("Microsoft.Xrm.Sdk.dll").exists() {
                return true;
            }
        }
    }
    false
}

/// Tries `nuget.exe restore <sln>` and returns true on success.
fn try_nuget_exe_restore(sln_path: &std::path::Path, solution_dir: &std::path::Path) -> bool {
    let mut cmd = std::process::Command::new("nuget");
    #[cfg(target_os = "windows")]
    hide_console_window(&mut cmd);
    cmd.arg("restore")
       .arg(sln_path.as_os_str())
       .current_dir(solution_dir)
       .stdout(Stdio::null())
       .stderr(Stdio::null())
       .status()
       .map(|s| s.success())
       .unwrap_or(false)
}

/// Downloads the named NuGet package and extracts `lib/net462/` DLLs to
/// `packages_dir/<PackageId>.<version>/lib/net462/`.
/// Returns `Ok(true)` when at least one DLL was written, `Ok(false)` for empty, `Err` on failure.
fn download_and_extract_nuget_package(
    package_id: &str,
    version: &str,
    packages_dir: &std::path::Path,
) -> Result<bool, String> {
    let id_low  = package_id.to_lowercase();
    let ver_low = version.to_lowercase();
    let url = format!(
        "https://api.nuget.org/v3-flatcontainer/{id_low}/{ver_low}/{id_low}.{ver_low}.nupkg"
    );

    let resp = reqwest::blocking::get(&url)
        .map_err(|e| format!("HTTP request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status(), url));
    }
    let bytes = resp.bytes().map_err(|e| format!("Failed to read response body: {e}"))?;

    let dest_root = packages_dir.join(format!("{package_id}.{version}"));
    let lib_dir   = dest_root.join("lib").join("net462");
    fs::create_dir_all(&lib_dir).map_err(|e| format!("Cannot create dir: {e}"))?;

    let cursor  = std::io::Cursor::new(bytes);
    let mut zip = ZipArchive::new(cursor).map_err(|e| format!("Invalid .nupkg: {e}"))?;
    let mut extracted = false;

    for i in 0..zip.len() {
        let mut file      = zip.by_index(i).map_err(|e| e.to_string())?;
        let name          = file.name().to_string();
        let name_lower    = name.to_lowercase();

        // Match any path containing /net462/ and ending in .dll or .xml
        if name_lower.contains("/net462/") && (name_lower.ends_with(".dll") || name_lower.ends_with(".xml")) {
            // File name = everything after the last '/'
            if let Some(slash) = name.rfind('/') {
                let file_name = &name[slash + 1..];
                if file_name.is_empty() { continue; }
                let out_path = lib_dir.join(file_name);
                let mut out  = fs::File::create(&out_path)
                    .map_err(|e| format!("Cannot create {}: {e}", out_path.display()))?;
                std::io::copy(&mut file, &mut out)
                    .map_err(|e| format!("Cannot write {}: {e}", out_path.display()))?;
                if file_name.ends_with(".dll") { extracted = true; }
            }
        }
    }

    Ok(extracted)
}

/// Checks whether a legacy .csproj is missing the `Microsoft.Xrm.Sdk` reference and adds it.
/// Returns `Ok(true)` when the reference was added, `Ok(false)` when already present or SDK-style.
fn ensure_xrm_sdk_reference(
    csproj_path: &std::path::Path,
    crmsdk_version: &str,
) -> Result<bool, String> {
    let raw   = fs::read_to_string(csproj_path)
        .map_err(|e| format!("Cannot read .csproj: {e}"))?;
    let lower = raw.to_lowercase();

    // SDK-style projects auto-include everything; no Reference elements needed.
    if lower.contains("<project sdk=") { return Ok(false); }
    // Already present.
    if lower.contains("microsoft.xrm.sdk") { return Ok(false); }

    let uses_crlf = raw.contains("\r\n");
    let eol = if uses_crlf { "\r\n" } else { "\n" };

    // Build the reference block(s) to insert.
    let xrm_ref = format!(
        "    <Reference Include=\"Microsoft.Xrm.Sdk\">{eol}\
         {s}      <HintPath>..\\packages\\Microsoft.CrmSdk.CoreAssemblies.{crmsdk_version}\\lib\\net462\\Microsoft.Xrm.Sdk.dll</HintPath>{eol}\
         {s}      <Private>False</Private>{eol}\
         {s}    </Reference>",
        s = ""
    );
    let proxy_ref = if !lower.contains("microsoft.crm.sdk.proxy") {
        format!(
            "    <Reference Include=\"Microsoft.Crm.Sdk.Proxy\">{eol}\
             {s}      <HintPath>..\\packages\\Microsoft.CrmSdk.CoreAssemblies.{crmsdk_version}\\lib\\net462\\Microsoft.Crm.Sdk.Proxy.dll</HintPath>{eol}\
             {s}      <Private>False</Private>{eol}\
             {s}    </Reference>",
            s = ""
        )
    } else {
        String::new()
    };

    let insert_block = if proxy_ref.is_empty() {
        format!("{xrm_ref}{eol}")
    } else {
        format!("{proxy_ref}{eol}{xrm_ref}{eol}")
    };

    // Insert after the last </Reference> line.
    let close_tag = "</reference>";
    if let Some(rel) = lower.rfind(close_tag) {
        let line_end = raw[rel..].find('\n').map(|p| rel + p + 1).unwrap_or(raw.len());
        let before   = &raw[..line_end];
        let after    = &raw[line_end..];
        let updated  = format!("{before}{insert_block}{after}");
        fs::write(csproj_path, updated.as_bytes())
            .map_err(|e| format!("Cannot write .csproj: {e}"))?;
        return Ok(true);
    }

    // Fallback: insert before the first </ItemGroup>.
    let close_group = "</itemgroup>";
    if let Some(rel) = lower.find(close_group) {
        let line_start = raw[..rel].rfind('\n').map(|p| p + 1).unwrap_or(0);
        let before     = &raw[..line_start];
        let after      = &raw[line_start..];
        let updated    = format!("{before}{insert_block}{after}");
        fs::write(csproj_path, updated.as_bytes())
            .map_err(|e| format!("Cannot write .csproj: {e}"))?;
        return Ok(true);
    }

    Err("Could not find a suitable insertion point for the Xrm.Sdk Reference in the .csproj.".to_string())
}

/// Restores NuGet packages for a legacy packages.config plugin project.
///
/// Strategy:
///   1. Try `nuget.exe restore <sln>` (fast path â€” uses user's NuGet cache).
///   2. If nuget.exe is not available, download Microsoft.CrmSdk.CoreAssemblies directly
///      from api.nuget.org and extract lib/net462/ DLLs into the packages folder.
///   3. Validate (and optionally auto-fix) the .csproj Xrm.Sdk reference for custom templates.
///
/// `solution_dir` is the folder containing the .sln and the `packages/` folder
/// (e.g. `pluginsDir/ProjectName/`).
#[tauri::command]
fn restore_nuget_packages(solution_dir: String) -> Result<NugetRestoreResult, String> {
    let sol_dir = std::path::Path::new(&solution_dir);

    let sln_path = find_file_ext_in_dir(sol_dir, "sln")
        .ok_or_else(|| format!("No .sln found in {solution_dir}"))?;

    // Validate / fix the .csproj reference (mainly for custom templates).
    let csproj_path  = find_csproj_in_solution(sol_dir);
    let packages_cfg = find_packages_config(sol_dir);
    let crmsdk_ver   = packages_cfg.as_deref()
        .and_then(read_crmsdk_from_packages_config)
        .map(|(_, v)| v)
        .unwrap_or_else(|| "9.0.2.49".to_string());

    let xrm_ref_added = csproj_path.as_deref()
        .map(|p| ensure_xrm_sdk_reference(p, &crmsdk_ver).unwrap_or(false))
        .unwrap_or(false);

    // Attempt 1: nuget.exe restore
    if try_nuget_exe_restore(&sln_path, sol_dir) {
        let dll_ok = xrm_sdk_dll_exists(sol_dir);
        return Ok(NugetRestoreResult {
            success: dll_ok,
            method:  "nuget_exe".to_string(),
            message: if dll_ok {
                "NuGet packages restored using nuget.exe.".to_string()
            } else {
                "nuget.exe ran but Microsoft.Xrm.Sdk.dll was not found after restore.".to_string()
            },
            dll_exists:    dll_ok,
            xrm_ref_added,
        });
    }

    // Attempt 2: direct download from NuGet.org
    if let Some(ref pc) = packages_cfg {
        if let Some((id, version)) = read_crmsdk_from_packages_config(pc) {
            let packages_dir = sol_dir.join("packages");
            match download_and_extract_nuget_package(&id, &version, &packages_dir) {
                Ok(extracted) => {
                    let dll_ok = xrm_sdk_dll_exists(sol_dir);
                    return Ok(NugetRestoreResult {
                        success: dll_ok,
                        method:  "direct_download".to_string(),
                        message: if dll_ok {
                            format!("Downloaded {id} {version} from NuGet.org.")
                        } else if extracted {
                            format!("Downloaded {id} {version} but Microsoft.Xrm.Sdk.dll not found.")
                        } else {
                            format!("Downloaded {id} {version} but no DLLs were extracted.")
                        },
                        dll_exists:    dll_ok,
                        xrm_ref_added,
                    });
                }
                Err(e) => {
                    return Ok(NugetRestoreResult {
                        success:       false,
                        method:        "direct_download_failed".to_string(),
                        message:       format!("Could not download NuGet packages: {e}. Use Restore NuGet Packages in Visual Studio."),
                        dll_exists:    xrm_sdk_dll_exists(sol_dir),
                        xrm_ref_added,
                    });
                }
            }
        }
    }

    // No restore possible
    Ok(NugetRestoreResult {
        success:       false,
        method:        "none".to_string(),
        message:       "nuget.exe is not available. Open the solution in Visual Studio and use Restore NuGet Packages.".to_string(),
        dll_exists:    xrm_sdk_dll_exists(sol_dir),
        xrm_ref_added,
    })
}

// --- Plugin project build readiness check ------------------------------------

#[derive(Serialize, Debug, Clone)]
struct BuildCheckItem {
    id: String,
    /// "pass" | "warning" | "fail" | "skip"
    result: String,
    label: String,
    detail: String,
}

#[derive(Serialize, Debug)]
struct BuildReadinessResult {
    /// "passed" | "warnings" | "failed"
    status: String,
    checks: Vec<BuildCheckItem>,
    summary: String,
    build_attempted: bool,
    build_succeeded: Option<bool>,
    build_output: Option<String>,
}

/// Returns the path to msbuild.exe, checking PATH directories first, then common
/// Visual Studio 2019/2022 installation paths.  Returns `None` when not found.
fn find_msbuild_cmd() -> Option<String> {
    // Check PATH by looking for msbuild.exe in each entry (no process spawn required).
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            if dir.join("msbuild.exe").exists() || dir.join("MSBuild.exe").exists() {
                return Some("msbuild".to_string());
            }
        }
    }
    // Common VS installation paths (Windows).
    let candidates = [
        r"C:\Program Files\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\MSBuild.exe",
        r"C:\Program Files\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\MSBuild.exe",
        r"C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe",
        r"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
        r"C:\Program Files\Microsoft Visual Studio\2019\Enterprise\MSBuild\Current\Bin\MSBuild.exe",
        r"C:\Program Files\Microsoft Visual Studio\2019\Professional\MSBuild\Current\Bin\MSBuild.exe",
        r"C:\Program Files\Microsoft Visual Studio\2019\Community\MSBuild\Current\Bin\MSBuild.exe",
    ];
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    None
}

fn bcheck(id: &str, label: &str, result: &str, detail: impl std::fmt::Display) -> BuildCheckItem {
    BuildCheckItem {
        id: id.to_string(),
        result: result.to_string(),
        label: label.to_string(),
        detail: detail.to_string(),
    }
}

/// Checks project readiness (filesystem + optional msbuild) for a legacy plugin project.
/// `solution_dir` is the folder containing the .sln (e.g. pluginsDir/ProjectName/).
/// `artifact_path` is the absolute path of the generated .cs file (optional).
#[tauri::command]
async fn check_plugin_build_readiness(
    solution_dir: String,
    artifact_path: Option<String>,
) -> Result<BuildReadinessResult, String> {
    let sol_dir = std::path::Path::new(&solution_dir);
    let mut checks: Vec<BuildCheckItem> = Vec::new();
    let mut any_fail = false;
    let mut any_warn = false;

    // 1. .sln
    let sln = find_file_ext_in_dir(sol_dir, "sln");
    match &sln {
        Some(p) => checks.push(bcheck("sln", ".sln file", "pass",
            p.file_name().unwrap_or_default().to_string_lossy())),
        None    => { checks.push(bcheck("sln", ".sln file", "fail", "No .sln in solution directory.")); any_fail = true; }
    }

    // 2. .csproj
    let csproj = find_csproj_in_solution(sol_dir);
    match &csproj {
        Some(p) => checks.push(bcheck("csproj", ".csproj file", "pass",
            p.file_name().unwrap_or_default().to_string_lossy())),
        None    => { checks.push(bcheck("csproj", ".csproj file", "fail", "No .csproj found in project subfolder.")); any_fail = true; }
    }

    // 3. packages.config
    let packages_cfg = find_packages_config(sol_dir);
    if packages_cfg.is_some() {
        checks.push(bcheck("packages_config", "packages.config", "pass", "Found."));
    } else {
        checks.push(bcheck("packages_config", "packages.config", "fail", "packages.config not found."));
        any_fail = true;
    }

    // 4. key.snk â€” warning only (assembly might still build without it if signing is disabled)
    let snk_ok = csproj.as_deref()
        .and_then(|p| p.parent())
        .map(|d| d.join("key.snk").exists())
        .unwrap_or(false);
    if snk_ok {
        checks.push(bcheck("key_snk", "key.snk (signing)", "pass", "Found."));
    } else {
        checks.push(bcheck("key_snk", "key.snk (signing)", "warning",
            "key.snk not found â€” assembly signing may fail if enabled in .csproj."));
        any_warn = true;
    }

    // 5. Microsoft.Xrm.Sdk reference in .csproj
    if let Some(ref csp) = csproj {
        let content = fs::read_to_string(csp).unwrap_or_default();
        if content.to_lowercase().contains("microsoft.xrm.sdk") {
            checks.push(bcheck("xrm_ref", "Microsoft.Xrm.Sdk reference", "pass", "Found in .csproj."));
        } else {
            checks.push(bcheck("xrm_ref", "Microsoft.Xrm.Sdk reference", "fail",
                "Microsoft.Xrm.Sdk reference missing from .csproj."));
            any_fail = true;
        }
    } else {
        checks.push(bcheck("xrm_ref", "Microsoft.Xrm.Sdk reference", "skip", "Skipped â€” no .csproj."));
    }

    // 6. Microsoft.Xrm.Sdk.dll in packages folder
    if xrm_sdk_dll_exists(sol_dir) {
        checks.push(bcheck("xrm_dll", "Microsoft.Xrm.Sdk.dll in packages", "pass", "Found."));
    } else {
        checks.push(bcheck("xrm_dll", "Microsoft.Xrm.Sdk.dll in packages", "fail",
            "Not found â€” run NuGet restore."));
        any_fail = true;
    }

    // 7. Generated .cs file exists
    if let Some(ref art) = artifact_path {
        let ap = std::path::Path::new(art);
        if ap.exists() {
            checks.push(bcheck("artifact", "Generated .cs file", "pass",
                ap.file_name().unwrap_or_default().to_string_lossy()));
        } else {
            checks.push(bcheck("artifact", "Generated .cs file", "fail",
                format!("Not found: {art}")));
            any_fail = true;
        }
    } else {
        checks.push(bcheck("artifact", "Generated .cs file", "skip", "No artifact path configured."));
    }

    // 8. Generated .cs listed as Compile Include in .csproj
    if let (Some(ref art), Some(ref csp)) = (&artifact_path, &csproj) {
        let ap  = std::path::Path::new(art);
        let dir = csp.parent().unwrap_or_else(|| std::path::Path::new("."));
        if let Ok(rel) = ap.strip_prefix(dir) {
            let rel_str = rel.to_string_lossy().replace('/', "\\");
            let content = fs::read_to_string(csp).unwrap_or_default();
            if compile_include_exists(&content, &rel_str) {
                checks.push(bcheck("compile_include", "Compile Include in .csproj", "pass",
                    format!("Found: {rel_str}")));
            } else {
                checks.push(bcheck("compile_include", "Compile Include in .csproj", "warning",
                    format!("{rel_str} not listed as Compile Include.")));
                any_warn = true;
            }
        } else {
            checks.push(bcheck("compile_include", "Compile Include in .csproj", "skip",
                "Cannot compute relative path."));
        }
    } else {
        checks.push(bcheck("compile_include", "Compile Include in .csproj", "skip",
            "No artifact path configured."));
    }

    // 9. Optional msbuild (only when mandatory checks pass)
    let mut build_attempted = false;
    let mut build_succeeded: Option<bool> = None;
    let mut build_output: Option<String> = None;

    if !any_fail {
        if let Some(ref sln_path) = sln {
            let sln_str = sln_path.to_string_lossy().to_string();
            let sol_str = solution_dir.clone();

            // Locate msbuild before spawning (pure filesystem check, no subprocess needed).
            let msbuild_exe = find_msbuild_cmd();

            match msbuild_exe {
                None => {
                    // msbuild not found: visible warning â€” build was not verified.
                    checks.push(bcheck("build", "MSBuild", "warning",
                        "MSBuild was not found in PATH or common Visual Studio installation paths. \
                         Project structure checks passed, but the solution was not compiled."));
                    any_warn = true;
                }
                Some(msbuild_cmd) => {
                    let build_result = tokio::time::timeout(
                        std::time::Duration::from_secs(120),
                        tokio::task::spawn_blocking(move || {
                            let mut cmd = std::process::Command::new(&msbuild_cmd);
                            #[cfg(target_os = "windows")]
                            hide_console_window(&mut cmd);
                            cmd.arg(&sln_str)
                               .args(["/t:Build", "/p:Configuration=Debug", "/v:minimal", "/nologo"])
                               .current_dir(&sol_str)
                               .stdout(Stdio::piped())
                               .stderr(Stdio::piped())
                               .output()
                        }),
                    ).await;

                    match build_result {
                        Ok(Ok(Ok(out))) => {
                            build_attempted = true;
                            let success = out.status.success();
                            build_succeeded = Some(success);
                            let combined = format!(
                                "{}{}",
                                String::from_utf8_lossy(&out.stdout),
                                String::from_utf8_lossy(&out.stderr),
                            ).trim().to_string();
                            build_output = if combined.is_empty() { None } else {
                                Some(combined.chars().take(2000).collect())
                            };
                            if success {
                                checks.push(bcheck("build", "MSBuild", "pass", "Build succeeded."));
                            } else {
                                checks.push(bcheck("build", "MSBuild", "fail", "Build failed â€” see output."));
                                any_fail = true;
                            }
                        }
                        Ok(Ok(Err(e))) => {
                            checks.push(bcheck("build", "MSBuild", "warning",
                                format!("MSBuild found but could not start: {e}")));
                            any_warn = true;
                        }
                        Ok(Err(_)) => {
                            checks.push(bcheck("build", "MSBuild", "warning",
                                "MSBuild task failed unexpectedly."));
                            any_warn = true;
                        }
                        Err(_) => {
                            build_attempted = true;
                            checks.push(bcheck("build", "MSBuild", "warning",
                                "Build check timed out after 120 s."));
                            any_warn = true;
                        }
                    }
                }
            }
        }
    } else {
        checks.push(bcheck("build", "MSBuild", "skip",
            "Skipped â€” resolve failing checks before building."));
    }

    let fail_count = checks.iter().filter(|c| c.result == "fail").count();
    let warn_count = checks.iter().filter(|c| c.result == "warning").count();
    let status = if any_fail { "failed" } else if any_warn { "warnings" } else { "passed" };
    let summary = match status {
        "failed"   => format!("{fail_count} check(s) failed â€” resolve before building."),
        "warnings" => format!("Passed with {warn_count} warning(s)."),
        _          => "All build readiness checks passed.".to_string(),
    };

    Ok(BuildReadinessResult {
        status: status.to_string(),
        checks,
        summary,
        build_attempted,
        build_succeeded,
        build_output,
    })
}

// --- Legacy .csproj Compile Include injection --------------------------------

#[derive(Serialize, Debug)]
struct CsprojUpdateResult {
    action: String,        // "added" | "already_present" | "sdk_style" | "no_csproj_found"
    csproj_path: Option<String>,
    message: String,
}

/// Finds the first .csproj file directly inside `dir` (no recursion).
fn find_csproj_in_dir(dir: &std::path::Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map_or(false, |ext| ext.eq_ignore_ascii_case("csproj")) {
            return Some(path);
        }
    }
    None
}

/// Returns true for SDK-style projects (`<Project Sdk="...">`).
/// SDK-style projects auto-include *.cs; no Compile element is needed.
fn is_sdk_style_csproj(content: &str) -> bool {
    content.to_lowercase().contains("<project sdk=")
}

/// Returns true when the given relative path is already listed as a Compile Include.
/// Comparison is case-insensitive and normalises path separators.
fn compile_include_exists(content: &str, rel_path: &str) -> bool {
    let needle = rel_path.to_lowercase().replace('\\', "/");
    for line in content.lines() {
        let lower = line.to_lowercase();
        if let Some(idx) = lower.find("compile include=") {
            let rest = &lower[idx + 16..]; // skip "compile include="
            if let Some(q1) = rest.find('"') {
                let inner = &rest[q1 + 1..];
                if let Some(q2) = inner.find('"') {
                    let val = inner[..q2].replace('\\', "/");
                    if val == needle {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Inserts `<Compile Include="rel_path" />` into the .csproj content string.
///
/// Strategy (in order):
///   1. After the last existing `<Compile Include=â€¦>` line (keeps items grouped).
///   2. Before the `Microsoft.CSharp.targets` Import line (in a new ItemGroup).
///   3. Before the closing `</Project>` tag.
fn insert_compile_include(content: &str, rel_path: &str) -> Result<String, String> {
    let uses_crlf = content.contains("\r\n");
    let eol = if uses_crlf { "\r\n" } else { "\n" };
    let new_item = format!("    <Compile Include=\"{rel_path}\" />");
    let lower = content.to_lowercase();

    // Strategy 1: find the last <Compile Include= line and insert after it.
    let marker = "<compile include=";
    let mut last_line_end: Option<usize> = None;
    let mut search_from = 0usize;
    while let Some(rel_pos) = lower[search_from..].find(marker) {
        let abs_pos = search_from + rel_pos;
        let line_end = content[abs_pos..]
            .find('\n')
            .map(|p| abs_pos + p + 1)
            .unwrap_or(content.len());
        last_line_end = Some(line_end);
        search_from = line_end;
    }
    if let Some(end) = last_line_end {
        let before = &content[..end];
        let after = &content[end..];
        return Ok(format!("{before}{new_item}{eol}{after}"));
    }

    // Strategy 2: insert a new ItemGroup before the CSharp.targets Import.
    let csharp_targets = "microsoft.csharp.targets";
    if let Some(rel_pos) = lower.find(csharp_targets) {
        let line_start = content[..rel_pos].rfind('\n').map(|p| p + 1).unwrap_or(0);
        let new_group = format!(
            "  <ItemGroup>{eol}    <Compile Include=\"{rel_path}\" />{eol}  </ItemGroup>{eol}"
        );
        let before = &content[..line_start];
        let after = &content[line_start..];
        return Ok(format!("{before}{new_group}{after}"));
    }

    // Strategy 3: insert a new ItemGroup before </Project>.
    let end_tag = "</project>";
    if let Some(rel_pos) = lower.rfind(end_tag) {
        let line_start = content[..rel_pos].rfind('\n').map(|p| p + 1).unwrap_or(0);
        let new_group = format!(
            "  <ItemGroup>{eol}    <Compile Include=\"{rel_path}\" />{eol}  </ItemGroup>{eol}"
        );
        let before = &content[..line_start];
        let after = &content[line_start..];
        return Ok(format!("{before}{new_group}{after}"));
    }

    Err("Could not find a suitable location to insert Compile Include in the .csproj.".to_string())
}

/// Adds `<Compile Include="â€¦" />` for a newly saved .cs file to the legacy .csproj
/// that lives in the same directory.
///
/// Returns a tagged result so the frontend can show appropriate feedback:
///   "added"          â€“ entry was inserted
///   "already_present"â€“ entry already existed; no change
///   "sdk_style"      â€“ SDK-style project (auto-includes); no change needed
///   "no_csproj_found"â€“ no .csproj in the directory; action not possible
#[tauri::command]
fn add_compile_include_to_csproj(cs_file_path: String) -> Result<CsprojUpdateResult, String> {
    let cs_path = std::path::Path::new(&cs_file_path);
    let proj_dir = cs_path
        .parent()
        .ok_or_else(|| "Cannot determine parent directory of the .cs file.".to_string())?;

    let Some(csproj_path) = find_csproj_in_dir(proj_dir) else {
        return Ok(CsprojUpdateResult {
            action: "no_csproj_found".to_string(),
            csproj_path: None,
            message: "No .csproj file found in the project directory.".to_string(),
        });
    };

    let raw = fs::read_to_string(&csproj_path)
        .map_err(|e| format!("Cannot read .csproj: {e}"))?;
    // Strip UTF-8 BOM (U+FEFF = 3 bytes in UTF-8) so XML detection works reliably.
    let has_bom = raw.starts_with('\u{FEFF}');
    let content: String = if has_bom {
        raw['\u{FEFF}'.len_utf8()..].to_string()
    } else {
        raw
    };

    if is_sdk_style_csproj(&content) {
        return Ok(CsprojUpdateResult {
            action: "sdk_style".to_string(),
            csproj_path: Some(csproj_path.to_string_lossy().to_string()),
            message: "SDK-style project auto-includes .cs files; no Compile entry needed.".to_string(),
        });
    }

    // Compute relative path from the project folder to the .cs file.
    // Use Windows backslashes â€” that is the MSBuild convention in .csproj files.
    let rel_path = cs_path
        .strip_prefix(proj_dir)
        .map_err(|_| {
            "Cannot compute relative path: the .cs file is not inside the project directory.".to_string()
        })?;
    let rel_str = rel_path.to_string_lossy().replace('/', "\\");

    if compile_include_exists(&content, &rel_str) {
        return Ok(CsprojUpdateResult {
            action: "already_present".to_string(),
            csproj_path: Some(csproj_path.to_string_lossy().to_string()),
            message: format!("Compile Include for \"{rel_str}\" is already present in the .csproj."),
        });
    }

    let updated = insert_compile_include(&content, &rel_str)?;
    // Re-attach BOM if the original file had one.
    let write_bytes: Vec<u8> = if has_bom {
        let mut v = b"\xEF\xBB\xBF".to_vec();
        v.extend_from_slice(updated.as_bytes());
        v
    } else {
        updated.into_bytes()
    };
    fs::write(&csproj_path, &write_bytes)
        .map_err(|e| format!("Cannot write updated .csproj: {e}"))?;

    Ok(CsprojUpdateResult {
        action: "added".to_string(),
        csproj_path: Some(csproj_path.to_string_lossy().to_string()),
        message: format!("Added <Compile Include=\"{rel_str}\" /> to the .csproj."),
    })
}

// --- Microsoft OAuth2 / Graph API ------------------------------------------

const MS_GRAPH_BASE: &str = "https://graph.microsoft.com/v1.0";
const REDIRECT_PORT: u16 = 3049;
const SCOPES: &str =
    "openid profile email offline_access User.Read Mail.Read Chat.Read";

/// Builds the tenant-specific Microsoft identity authority URL.
/// Single-tenant apps must use the tenant's own endpoint, not /common.
fn ms_authority(tenant_id: &str) -> String {
    format!("https://login.microsoftonline.com/{tenant_id}")
}

// â”€â”€ PKCE helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn generate_code_verifier() -> String {
    let bytes: Vec<u8> = (0..32).map(|_| rand::thread_rng().gen::<u8>()).collect();
    URL_SAFE_NO_PAD.encode(&bytes)
}

fn generate_code_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hash)
}

fn generate_state() -> String {
    let bytes: Vec<u8> = (0..16).map(|_| rand::thread_rng().gen::<u8>()).collect();
    URL_SAFE_NO_PAD.encode(&bytes)
}

// â”€â”€ Token cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct TokenCache {
    access_token: String,
    refresh_token: String,
    /// Unix timestamp (seconds) when the access token expires.
    expires_at: u64,
    id_token: Option<String>,
    /// Tenant ID used during sign-in â€” required to build the correct authority URL on refresh.
    /// Old caches without this field deserialise to an empty string; the refresh will fail
    /// gracefully and prompt the user to reconnect.
    #[serde(default)]
    tenant_id: String,
}

fn token_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("ms_tokens.json"))
}

fn load_token_cache(app: &tauri::AppHandle) -> Option<TokenCache> {
    let path = token_cache_path(app).ok()?;
    if !path.exists() { return None; }
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_token_cache(app: &tauri::AppHandle, cache: &TokenCache) -> Result<(), String> {
    let path = token_cache_path(app)?;
    let raw = serde_json::to_string_pretty(cache).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn clear_token_cache(app: &tauri::AppHandle) -> Result<(), String> {
    let path = token_cache_path(app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// â”€â”€ Redirect server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Opens a local TCP listener and waits for the browser redirect.
/// Returns the query-string parameters as a map.
fn wait_for_redirect(port: u16) -> Result<HashMap<String, String>, String> {
    let listener = TcpListener::bind(format!("127.0.0.1:{port}"))
        .map_err(|e| format!("Cannot bind redirect port: {e}"))?;

    // Accept one connection
    let (stream, _) = listener.accept().map_err(|e| e.to_string())?;
    let mut reader = io::BufReader::new(&stream);

    // Read first line: "GET /?code=...&state=... HTTP/1.1"
    let mut request_line = String::new();
    reader.read_line(&mut request_line).map_err(|e| e.to_string())?;

    // Send a simple success page
    let body = b"<html><body><h2>Authentication successful. You may close this window.</h2></body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    use std::io::Write;
    let mut writer = io::BufWriter::new(&stream);
    writer.write_all(response.as_bytes()).ok();
    writer.write_all(body).ok();
    writer.flush().ok();
    drop(writer);

    // Parse the query string
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .to_owned();
    let qs = path.splitn(2, '?').nth(1).unwrap_or("");
    let params: HashMap<String, String> = qs
        .split('&')
        .filter_map(|pair| {
            let mut kv = pair.splitn(2, '=');
            let k = kv.next()?.to_owned();
            let v = kv.next().unwrap_or("").to_owned();
            Some((k, percent_decode(&v)))
        })
        .collect();
    Ok(params)
}

/// Minimal percent-decode (handles the %XX sequences MSAL sends back).
fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte as char);
                    i += 3;
                    continue;
                }
            }
        } else if bytes[i] == b'+' {
            out.push(' ');
            i += 1;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

// â”€â”€ Token exchange â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[derive(Deserialize, Debug)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    id_token: Option<String>,
}

/// Parse a raw MSAL token-endpoint error body into a user-friendly message.
/// MSAL returns JSON like `{"error":"invalid_grant","error_description":"..."}` on failure.
/// Never logs or returns token values.
fn msal_error_from_body(body: &str, status: u16, operation: &str) -> String {
    if let Ok(json) = serde_json::from_str::<Value>(body) {
        let code = json["error"].as_str().unwrap_or("unknown");
        let desc = json["error_description"].as_str().unwrap_or("no detail");
        // Truncate the description â€” MSAL descriptions can be very long.
        let preview: String = desc.chars().take(200).collect();
        let friendly = match code {
            "invalid_grant" | "interaction_required" =>
                format!(
                    "InvalidAuthenticationToken â€” Microsoft connection expired ({code}). \
                     Please reconnect in Settings. Detail: {preview}"
                ),
            "invalid_client" | "unauthorized_client" =>
                format!(
                    "Outlook authorization failed (HTTP {status}, {code}): invalid client ID or \
                     the app is not authorised for this tenant. Detail: {preview}"
                ),
            _ =>
                format!(
                    "MSAL {operation} failed (HTTP {status}, {code}): {preview}"
                ),
        };
        eprintln!("[token] MSAL error during {operation}: code={code} HTTP={status}");
        return friendly;
    }
    // Body is not JSON (e.g. HTML error page from a proxy/firewall).
    let preview: String = body.chars().take(200).collect();
    eprintln!("[token] MSAL {operation} non-JSON error HTTP={status}: {preview}");
    format!(
        "Outlook authorization failed (HTTP {status}) during {operation}. \
         Please reconnect Microsoft in Settings."
    )
}

async fn exchange_code_for_tokens(
    client: &Client,
    client_id: &str,
    tenant_id: &str,
    code: &str,
    verifier: &str,
) -> Result<TokenCache, String> {
    let redirect_uri = format!("http://localhost:{REDIRECT_PORT}");
    let authority = ms_authority(tenant_id);
    let params = [
        ("client_id", client_id),
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri.as_str()),
        ("code_verifier", verifier),
        ("scope", SCOPES),
    ];
    let raw_resp = client
        .post(format!("{authority}/oauth2/v2.0/token"))
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange network error: {e}"))?;

    let status = raw_resp.status();
    let body_text = raw_resp.text().await.unwrap_or_default();
    eprintln!("[token] exchange_code HTTP {status}");
    if !status.is_success() {
        return Err(msal_error_from_body(&body_text, status.as_u16(), "code exchange"));
    }
    let resp: TokenResponse = serde_json::from_str(&body_text)
        .map_err(|e| format!("Failed to parse token exchange response: {e}"))?;

    Ok(TokenCache {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token.unwrap_or_default(),
        expires_at: now_unix() + resp.expires_in.unwrap_or(3600) - 60,
        id_token: resp.id_token,
        tenant_id: tenant_id.to_owned(),
    })
}

async fn refresh_access_token(
    client: &Client,
    client_id: &str,
    tenant_id: &str,
    refresh_token: &str,
) -> Result<TokenCache, String> {
    let authority = ms_authority(tenant_id);
    let params = [
        ("client_id", client_id),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("scope", SCOPES),
    ];
    let raw_resp = client
        .post(format!("{authority}/oauth2/v2.0/token"))
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token refresh network error: {e}"))?;

    let status = raw_resp.status();
    let body_text = raw_resp.text().await.unwrap_or_default();
    eprintln!("[token] refresh_access_token HTTP {status}");
    if !status.is_success() {
        return Err(msal_error_from_body(&body_text, status.as_u16(), "token refresh"));
    }
    let resp: TokenResponse = serde_json::from_str(&body_text)
        .map_err(|e| format!("Failed to parse token refresh response: {e}"))?;

    Ok(TokenCache {
        access_token: resp.access_token,
        refresh_token: if resp.refresh_token.as_deref().unwrap_or("").is_empty() {
            refresh_token.to_owned()
        } else {
            resp.refresh_token.unwrap_or_default()
        },
        expires_at: now_unix() + resp.expires_in.unwrap_or(3600) - 60,
        id_token: resp.id_token,
        tenant_id: tenant_id.to_owned(),
    })
}

// â”€â”€ Graph helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async fn graph_get(url: &str, access_token: &str) -> Result<Value, String> {
    // Strip query string from the logged URL so the log line is concise and
    // does not contain any sensitive filter values.
    let url_base = url.split('?').next().unwrap_or(url);
    eprintln!("[Graph] GET {url_base}");

    // 20-second timeout so the UI never hangs indefinitely if Graph is slow.
    let client = reqwest::ClientBuilder::new()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
    let resp = client
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Network request failed: {e}"))?;

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();

    // â”€â”€ Non-2xx: read the body as TEXT first â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // IMPORTANT: calling `.json()` before checking the status is the root cause
    // of "error decoding response body" â€” Graph sometimes returns HTML or an
    // empty body on 401/403/503, which cannot be decoded as JSON.
    // Reading as text lets us surface the real HTTP status and a body preview.
    if !status.is_success() {
        let raw = resp.text().await.unwrap_or_default();
        let preview: String = raw.chars().take(300).collect();

        eprintln!(
            "[Graph] HTTP {status} from {url_base} | content-type: {content_type} | body: {preview}"
        );

        // Try to extract a structured Graph error from the text body.
        if let Ok(json) = serde_json::from_str::<Value>(&raw) {
            if let Some(err_obj) = json.get("error") {
                let code = err_obj["code"].as_str().unwrap_or("unknown");
                let msg  = err_obj["message"].as_str().unwrap_or("no detail");
                let friendly = match code {
                    "Authorization_RequestDenied" | "Unauthorized" | "AccessDenied" =>
                        format!("Missing Microsoft permissions ({code}): {msg}. Make sure Mail.Read is granted in Azure."),
                    "InvalidAuthenticationToken" | "AuthenticationError" =>
                        format!("InvalidAuthenticationToken â€” Microsoft connection expired. Please reconnect in Settings."),
                    _ =>
                        format!("Microsoft Graph API error [{status}] {code}: {msg}"),
                };
                eprintln!("[Graph] Structured error: {friendly}");
                return Err(friendly);
            }
        }

        // No structured JSON error â€” produce a clear plain-text error.
        let friendly = match status.as_u16() {
            401 => format!(
                "Outlook authorization failed (HTTP 401). Please reconnect Microsoft in Settings. \
                 Endpoint: {url_base}"
            ),
            403 => format!(
                "Access denied (HTTP 403) â€” Mail.Read permission may be missing from your Azure app registration. \
                 Endpoint: {url_base}"
            ),
            _ => format!(
                "Microsoft Graph request failed with HTTP {status} from {url_base}. \
                 Content-Type: {content_type}. Body preview: {preview}"
            ),
        };
        return Err(friendly);
    }

    // â”€â”€ 2xx: parse JSON â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Graph JSON response from {url_base}: {e}"))?;

    // Graph occasionally returns 200 with an error object in the body.
    if let Some(err_obj) = body.get("error") {
        let code = err_obj["code"].as_str().unwrap_or("unknown");
        let msg  = err_obj["message"].as_str().unwrap_or("no detail");
        let friendly = match code {
            "Authorization_RequestDenied" | "Unauthorized" | "AccessDenied" =>
                format!("Missing Microsoft permissions ({code}): {msg}"),
            "InvalidAuthenticationToken" | "AuthenticationError" =>
                format!("InvalidAuthenticationToken â€” Microsoft connection expired. Please reconnect in Settings."),
            _ =>
                format!("Microsoft Graph API error [{status}] {code}: {msg}"),
        };
        eprintln!("[Graph] In-body error: {friendly}");
        return Err(friendly);
    }

    Ok(body)
}

/// Resolve a potentially-expired token cache: refresh if needed, return access token.
/// On refresh failure (invalid_grant, etc.) the cached tokens are cleared so subsequent
/// calls don't spin-retry with a dead token. Returns a prefixed error so callers can
/// surface a targeted "please reconnect" message instead of a generic decode error.
async fn ensure_valid_token(app: &tauri::AppHandle, client_id: &str) -> Result<String, String> {
    let cache = load_token_cache(app).ok_or(
        "MICROSOFT_NOT_CONNECTED: Not authenticated. Please sign in via Settings."
    )?;
    if now_unix() < cache.expires_at {
        return Ok(cache.access_token);
    }
    eprintln!("[token] ensure_valid_token: token expired, attempting refresh");
    let client = Client::new();
    match refresh_access_token(&client, client_id, &cache.tenant_id, &cache.refresh_token).await {
        Ok(new_cache) => {
            save_token_cache(app, &new_cache)?;
            Ok(new_cache.access_token)
        }
        Err(refresh_err) => {
            // Refresh failed â€” the refresh token is invalid/expired.
            // Clear the cache so we don't attempt to use a dead token on the next call.
            eprintln!("[token] ensure_valid_token: refresh failed â€” clearing token cache");
            let _ = clear_token_cache(app);
            // Prefix with a recognizable code so the frontend can route to a reconnect flow.
            Err(format!("MICROSOFT_RECONNECT_REQUIRED: {refresh_err}"))
        }
    }
}

// â”€â”€ Microsoft account info types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct MicrosoftAccountInfo {
    email: String,
    display_name: String,
    tenant_id: String,
    last_sync_at: String,
}

// â”€â”€ Tauri commands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Begin OAuth2 PKCE sign-in: open browser at the tenant-specific authority,
/// wait for redirect, exchange code, fetch /me from Graph, return account info.
#[tauri::command]
async fn connect_microsoft_account(
    app: tauri::AppHandle,
    client_id: String,
    tenant_id: String,
) -> Result<MicrosoftAccountInfo, String> {
    let client_id = client_id.trim().to_owned();
    let tenant_id = tenant_id.trim().to_owned();

    if client_id.is_empty() {
        return Err("Application (client) ID is required. Enter it in Settings â†’ Microsoft 365 Integration.".into());
    }
    if tenant_id.is_empty() {
        return Err("Directory (tenant) ID is required. Enter it in Settings â†’ Microsoft 365 Integration.".into());
    }

    let authority = ms_authority(&tenant_id);
    let verifier  = generate_code_verifier();
    let challenge = generate_code_challenge(&verifier);
    let state     = generate_state();
    let redirect_uri = format!("http://localhost:{REDIRECT_PORT}");
    let auth_url = format!(
        "{authority}/oauth2/v2.0/authorize\
         ?client_id={client_id}\
         &response_type=code\
         &redirect_uri={redirect_uri_enc}\
         &scope={scopes}\
         &state={state}\
         &code_challenge={challenge}\
         &code_challenge_method=S256\
         &prompt=select_account",
        redirect_uri_enc = urlencoding::encode(&redirect_uri),
        scopes           = urlencoding::encode(SCOPES),
    );

    webbrowser::open(&auth_url).map_err(|e| format!("Cannot open browser: {e}"))?;

    // Wait for redirect on a blocking thread so we don't block the async runtime.
    let params = tauri::async_runtime::spawn_blocking(move || wait_for_redirect(REDIRECT_PORT))
        .await
        .map_err(|e| e.to_string())??;

    if params.get("state").map(|s| s.as_str()) != Some(&state) {
        return Err("OAuth state mismatch. Possible CSRF attack.".into());
    }
    if let Some(err) = params.get("error_description") {
        return Err(err.clone());
    }
    let code = params.get("code").ok_or("No code in redirect response")?.clone();

    let client = Client::new();
    let cache = exchange_code_for_tokens(&client, &client_id, &tenant_id, &code, &verifier).await?;
    save_token_cache(&app, &cache)?;

    let me: Value = graph_get(&format!("{MS_GRAPH_BASE}/me"), &cache.access_token).await?;
    let info = MicrosoftAccountInfo {
        email: me["mail"]
            .as_str()
            .or_else(|| me["userPrincipalName"].as_str())
            .unwrap_or("")
            .to_owned(),
        display_name: me["displayName"].as_str().unwrap_or("").to_owned(),
        tenant_id,  // use the configured value, not me["id"] which is the user's object ID
        last_sync_at: chrono_now_iso(),
    };
    Ok(info)
}

/// Refresh the Microsoft connection using the stored refresh token.
/// The tenant ID is read from the token cache â€” no need to re-enter it.
#[tauri::command]
async fn refresh_microsoft_connection(
    app: tauri::AppHandle,
    client_id: String,
) -> Result<MicrosoftAccountInfo, String> {
    let cache = load_token_cache(&app)
        .ok_or("Not authenticated. Please sign in first.")?;
    if cache.tenant_id.is_empty() {
        return Err("Tenant ID missing from token cache. Please disconnect and sign in again.".into());
    }
    let tenant_id = cache.tenant_id.clone();
    let client    = Client::new();
    let new_cache = refresh_access_token(&client, &client_id, &tenant_id, &cache.refresh_token).await?;
    save_token_cache(&app, &new_cache)?;

    let me: Value = graph_get(&format!("{MS_GRAPH_BASE}/me"), &new_cache.access_token).await?;
    let info = MicrosoftAccountInfo {
        email: me["mail"]
            .as_str()
            .or_else(|| me["userPrincipalName"].as_str())
            .unwrap_or("")
            .to_owned(),
        display_name: me["displayName"].as_str().unwrap_or("").to_owned(),
        tenant_id,
        last_sync_at: chrono_now_iso(),
    };
    Ok(info)
}

/// Remove stored tokens and clear all Microsoft connection state.
#[tauri::command]
fn disconnect_microsoft_account(app: tauri::AppHandle) -> Result<(), String> {
    clear_token_cache(&app)
}

/// Return the current connection state (is token cached and non-expired?).
#[tauri::command]
fn get_microsoft_connection_state(app: tauri::AppHandle) -> String {
    match load_token_cache(&app) {
        None => "disconnected".to_owned(),
        Some(c) if now_unix() >= c.expires_at && c.refresh_token.is_empty() => {
            "disconnected".to_owned()
        }
        Some(c) if now_unix() >= c.expires_at => "needs_refresh".to_owned(),
        Some(_) => "connected".to_owned(),
    }
}

/// Fetch recent Outlook messages (top 25, sorted by received date desc).
#[tauri::command]
async fn get_outlook_messages(
    app: tauri::AppHandle,
    client_id: String,
) -> Result<Value, String> {
    let token = ensure_valid_token(&app, &client_id).await?;
    // Server-side filter: only flagged emails.
    // NOTE: $orderby is intentionally omitted â€” Graph rejects the combination of
    // $filter on flag/flagStatus with $orderby on a different field (InefficientFilter).
    // Messages are sorted locally after fetch.
    let url = format!(
        "{MS_GRAPH_BASE}/me/messages\
         ?$top=50\
         &$filter=flag%2FflagStatus%20eq%20'flagged'\
         &$select=id,subject,from,receivedDateTime,bodyPreview,webLink,body,flag"
    );
    let data = graph_get(&url, &token).await?;
    let messages: Vec<Value> = data["value"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            // Strip HTML from the full body for deterministic parsing in the frontend.
            // IMPORTANT: extract Azure DevOps href URLs *before* stripping tags â€”
            // ADO "View comment" / "View pull request" links only exist in <a href>
            // attributes and are completely lost by strip_html otherwise.
            //
            // The extraction is gated behind a cheap pre-check so we don't scan
            // every email body for ADO links.
            let from_email   = m["from"]["emailAddress"]["address"].as_str().unwrap_or("");
            let subject_str  = m["subject"].as_str().unwrap_or("");
            let preview_str  = m["bodyPreview"].as_str().unwrap_or("");
            let body_html    = m["body"]["content"].as_str().unwrap_or("");
            // strip_html_email preserves block-level line breaks so the frontend
            // thread splitter can detect quoted-reply boundaries.
            let mut body_full = strip_html_email(body_html);
            if is_potential_ado_email(from_email, subject_str, preview_str) {
                let ado_pairs = extract_ado_link_pairs(body_html);
                if !ado_pairs.is_empty() {
                    // Append structured ADO link markers so TypeScript can rank them.
                    // Format per line: ##ADO## <href> ||| <label>
                    // This carries both the URL and the button text ("View comment", etc.)
                    // so the TypeScript parser can make an informed ranking decision.
                    for (href, label) in &ado_pairs {
                        body_full.push_str(&format!("\n##ADO## {} ||| {}", href, label));
                    }
                    eprintln!("[ado-link] appended {} structured ADO link(s) to body_full for subject=\"{}\"", ado_pairs.len(), &subject_str[..subject_str.len().min(60)]);
                }
            } else {
                eprintln!("[ado-link] skip ADO extraction for non-ADO email subject=\"{}\"", &subject_str[..subject_str.len().min(60)]);
            }
            // isFlagged: we filtered server-side so this will always be true,
            // but we confirm from the field so the contract is explicit.
            let is_flagged = m["flag"]["flagStatus"].as_str() == Some("flagged");
            serde_json::json!({
                "id": m["id"],
                "subject": m["subject"].as_str().unwrap_or("(no subject)"),
                "fromName": m["from"]["emailAddress"]["name"].as_str().unwrap_or(""),
                "fromEmail": m["from"]["emailAddress"]["address"].as_str().unwrap_or(""),
                "receivedAt": m["receivedDateTime"],
                "bodyPreview": m["bodyPreview"],
                "bodyFull": body_full,
                "webLink": m["webLink"],
                "isFlagged": is_flagged,
            })
        })
        .collect();
    // Sort by receivedAt descending ($orderby omitted from request â€” see above).
    let mut messages = messages;
    messages.sort_by(|a, b| {
        let ta = a["receivedAt"].as_str().unwrap_or("");
        let tb = b["receivedAt"].as_str().unwrap_or("");
        tb.cmp(ta)
    });
    Ok(serde_json::json!(messages))
}

/// Lightweight flagged-email list for the Outlook import panel.
/// Paginates through flagged messages via @odata.nextLink up to MAX_FETCH total,
/// then sorts locally by receivedDateTime desc and returns the newest SHOW_LIMIT.
///
/// `days_back` restricts results to emails received within the last N days (server-side).
/// Pass 0 to fetch all flagged emails regardless of age.
#[tauri::command]
async fn get_outlook_flagged_list(
    app: tauri::AppHandle,
    client_id: String,
    days_back: u32,
) -> Result<Value, String> {
    const MAX_FETCH: usize = 300;
    const SHOW_LIMIT: usize = 50;

    eprintln!("[outlook-import] get_outlook_flagged_list v2 â€” days_back={days_back}");
    let token = ensure_valid_token(&app, &client_id).await?;

    // Build the OData $filter expression.
    // Combining flag/flagStatus with receivedDateTime ge <date> is safe â€” InefficientFilter
    // only fires when $orderby is mixed with the flag filter, not for AND-filter clauses.
    let filter = if days_back > 0 {
        use std::time::{SystemTime, UNIX_EPOCH};
        let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let cutoff_secs = now_secs.saturating_sub((days_back as u64) * 86400);
        let cutoff_date = unix_secs_to_date_str(cutoff_secs);
        // Percent-encode spaces and '/' in the filter string.
        format!(
            "flag%2FflagStatus%20eq%20'flagged'%20and%20receivedDateTime%20ge%20{}T00%3A00%3A00Z",
            cutoff_date
        )
    } else {
        "flag%2FflagStatus%20eq%20'flagged'".to_string()
    };

    let initial_url = format!(
        "{MS_GRAPH_BASE}/me/messages\
         ?$top=50\
         &$filter={filter}\
         &$select=id,subject,from,receivedDateTime,bodyPreview,webLink,flag"
    );

    let mut next_url: Option<String> = Some(initial_url);
    let mut raw_items: Vec<Value> = Vec::new();

    while let Some(url) = next_url.take() {
        let data = graph_get(&url, &token).await?;
        let page = data["value"].as_array().cloned().unwrap_or_default();
        raw_items.extend(page);
        if raw_items.len() >= MAX_FETCH {
            break;
        }
        next_url = data["@odata.nextLink"].as_str().map(|s| s.to_string());
    }

    let fetched_count = raw_items.len();
    let mut messages: Vec<Value> = raw_items
        .into_iter()
        .map(|m| {
            let is_flagged = m["flag"]["flagStatus"].as_str() == Some("flagged");
            serde_json::json!({
                "id":          m["id"],
                "subject":     m["subject"].as_str().unwrap_or("(no subject)"),
                "fromName":    m["from"]["emailAddress"]["name"].as_str().unwrap_or(""),
                "fromEmail":   m["from"]["emailAddress"]["address"].as_str().unwrap_or(""),
                "receivedAt":  m["receivedDateTime"],
                "bodyPreview": m["bodyPreview"],
                "webLink":     m["webLink"],
                "isFlagged":   is_flagged,
            })
        })
        .collect();

    messages.sort_by(|a, b| {
        let ta = a["receivedAt"].as_str().unwrap_or("");
        let tb = b["receivedAt"].as_str().unwrap_or("");
        tb.cmp(ta)
    });
    messages.truncate(SHOW_LIMIT);

    eprintln!(
        "[Outlook] get_outlook_flagged_list: days_back={} fetched={} shown={}",
        days_back, fetched_count, messages.len()
    );
    Ok(serde_json::json!({ "messages": messages, "fetchedCount": fetched_count }))
}

/// Replace `cid:<contentId>` references in an HTML body with `data:` URIs.
///
/// Fetches the message's file attachments from Graph and substitutes any inline
/// attachment whose `contentId` matches a `cid:` reference found in the HTML.
/// Fails safely: returns the original HTML unchanged if the fetch errors or if
/// no inline attachments are present.
async fn resolve_cid_attachments(html: &str, message_id: &str, token: &str) -> String {
    if !html.contains("cid:") {
        return html.to_string();
    }
    let att_url = format!("{MS_GRAPH_BASE}/me/messages/{message_id}/attachments");
    let att_data = match graph_get(&att_url, token).await {
        Ok(d)  => d,
        Err(e) => {
            eprintln!("[cid] attachment fetch failed for {}: {}", &message_id[..message_id.len().min(12)], e);
            return html.to_string();
        }
    };
    let attachments = match att_data["value"].as_array() {
        Some(a) => a.clone(),
        None    => return html.to_string(),
    };

    let mut resolved = html.to_string();
    for att in &attachments {
        // Only handle inline file attachments that carry base64 content.
        let is_inline      = att["isInline"].as_bool().unwrap_or(false);
        let content_id     = att["contentId"].as_str().unwrap_or("");
        let content_type   = att["contentType"].as_str().unwrap_or("image/png");
        let content_bytes  = att["contentBytes"].as_str().unwrap_or("");
        if !is_inline || content_id.is_empty() || content_bytes.is_empty() {
            continue;
        }
        let data_uri = format!("data:{};base64,{}", content_type, content_bytes);

        // Outlook uses both bare and angle-bracket CID formats.
        // Replace all variants that can appear as an HTML attribute value.
        let bare = format!("cid:{}", content_id);
        let angled = format!("cid:<{}>", content_id);
        resolved = resolved.replace(&bare, &data_uri);
        resolved = resolved.replace(&angled, &data_uri);
    }
    eprintln!(
        "[cid] resolved {} inline attachment(s) for messageId={}",
        attachments.len(),
        &message_id[..message_id.len().min(12)]
    );
    resolved
}

/// Fetch one Outlook message by id with full body, HTML stripping, and ADO link extraction.
/// Called lazily when the user clicks Import for a specific email â€” not during panel load.
#[tauri::command]
async fn get_outlook_message_full(
    app: tauri::AppHandle,
    client_id: String,
    message_id: String,
) -> Result<Value, String> {
    let token = ensure_valid_token(&app, &client_id).await?;
    let url = format!(
        "{MS_GRAPH_BASE}/me/messages/{message_id}\
         ?$select=id,subject,from,receivedDateTime,bodyPreview,webLink,body,flag"
    );
    let m = graph_get(&url, &token).await?;
    let from_email  = m["from"]["emailAddress"]["address"].as_str().unwrap_or("").to_string();
    let subject_str = m["subject"].as_str().unwrap_or("");
    let preview_str = m["bodyPreview"].as_str().unwrap_or("");
    let body_html   = m["body"]["content"].as_str().unwrap_or("").to_string();
    // strip_html_email preserves block-level line breaks for quoted-reply detection.
    // body_full is the plain-text path â€” AI, prefilter, ADO parsing all use this.
    let mut body_full = strip_html_email(&body_html);
    if is_potential_ado_email(&from_email, subject_str, preview_str) {
        let ado_pairs = extract_ado_link_pairs(&body_html);
        if !ado_pairs.is_empty() {
            for (href, label) in &ado_pairs {
                body_full.push_str(&format!("\n##ADO## {} ||| {}", href, label));
            }
            eprintln!("[ado-link] {} ADO link(s) for messageId={}", ado_pairs.len(), &message_id[..message_id.len().min(12)]);
        }
    }
    // Resolve CID inline images â†’ data: URIs for the HTML display path.
    // This is separate from body_full and does not affect any text analysis.
    let had_cid = body_html.contains("cid:");
    let body_html_resolved = resolve_cid_attachments(&body_html, &message_id, &token).await;
    let still_has_cid = body_html_resolved.contains("cid:");
    eprintln!(
        "[email-html] cid resolve: msgId={} hadCid={} stillHasCid={}",
        &message_id[..message_id.len().min(12)],
        had_cid,
        still_has_cid
    );

    let is_flagged = m["flag"]["flagStatus"].as_str() == Some("flagged");
    eprintln!("[Outlook] get_outlook_message_full: messageId={}", &message_id[..message_id.len().min(12)]);
    Ok(serde_json::json!({
        "id":         m["id"],
        "subject":    m["subject"].as_str().unwrap_or("(no subject)"),
        "fromName":   m["from"]["emailAddress"]["name"].as_str().unwrap_or(""),
        "fromEmail":  from_email,
        "receivedAt": m["receivedDateTime"],
        "bodyPreview": m["bodyPreview"],
        "bodyFull":   body_full,
        "bodyHtml":   body_html_resolved,
        "webLink":    m["webLink"],
        "isFlagged":  is_flagged,
    }))
}

/// Fetch recent Teams chats (top 20, personal/group chats only).
/// Note: $orderby is NOT supported on /me/chats â€” it causes a 400 when combined
/// with $expand. Results are sorted in Rust after fetching.
#[tauri::command]
async fn get_teams_chats(
    app: tauri::AppHandle,
    client_id: String,
) -> Result<Value, String> {
    let token = ensure_valid_token(&app, &client_id).await?;
    // $orderby intentionally omitted: the Graph /me/chats endpoint does not
    // support it (returns 400), especially when combined with $expand.
    let url = format!(
        "{MS_GRAPH_BASE}/me/chats\
         ?$top=20\
         &$expand=members\
         &$select=id,topic,chatType,lastUpdatedDateTime,lastMessagePreview,members"
    );
    let data = graph_get(&url, &token).await?;
    let raw_chats = data["value"].as_array().cloned().unwrap_or_default();
    eprintln!("[Teams] get_teams_chats: {} chats returned from Graph", raw_chats.len());

    let mut chats: Vec<Value> = raw_chats
        .into_iter()
        .map(|c| {
            let members: Vec<&str> = c["members"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m["displayName"].as_str())
                        .collect()
                })
                .unwrap_or_default();
            let members_summary = members.join(", ");

            // lastMessagePreview can be null or structured differently per chat type.
            let preview = c["lastMessagePreview"]["body"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let preview = strip_html(&preview);

            serde_json::json!({
                "id": c["id"],
                "topic": c["topic"].as_str().unwrap_or(""),
                "chatType": c["chatType"].as_str().unwrap_or(""),
                "membersSummary": members_summary,
                "lastMessagePreview": preview,
                "lastUpdatedAt": c["lastUpdatedDateTime"],
            })
        })
        .collect();

    // Sort by lastUpdatedAt descending (Graph doesn't do it for us).
    chats.sort_by(|a, b| {
        let ta = a["lastUpdatedAt"].as_str().unwrap_or("");
        let tb = b["lastUpdatedAt"].as_str().unwrap_or("");
        tb.cmp(ta)
    });

    eprintln!("[Teams] get_teams_chats: returning {} chats to frontend", chats.len());
    Ok(serde_json::json!(chats))
}

/// Fetch recent messages in a specific Teams chat (top 30).
#[tauri::command]
async fn get_teams_chat_messages(
    app: tauri::AppHandle,
    client_id: String,
    chat_id: String,
) -> Result<Value, String> {
    let token = ensure_valid_token(&app, &client_id).await?;
    let url = format!(
        "{MS_GRAPH_BASE}/me/chats/{chat_id}/messages\
         ?$top=30\
         &$orderby=createdDateTime%20desc"
    );
    let data = graph_get(&url, &token).await?;
    let raw = data["value"].as_array().cloned().unwrap_or_default();
    eprintln!("[Teams] get_teams_chat_messages: {} raw messages for chat {chat_id}", raw.len());

    let mut filtered_out = 0usize;
    let messages: Vec<Value> = raw
        .into_iter()
        .filter(|m| {
            let keep = m["messageType"].as_str() == Some("message");
            if !keep { filtered_out += 1; }
            keep
        })
        .map(|m| {
            let raw_content = m["body"]["content"].as_str().unwrap_or("");
            serde_json::json!({
                "id": m["id"],
                "senderName": m["from"]["user"]["displayName"].as_str().unwrap_or(""),
                "senderEmail": m["from"]["user"]["userPrincipalName"].as_str().unwrap_or(""),
                "sentAt": m["createdDateTime"],
                "content": strip_html(raw_content),
            })
        })
        .collect();

    eprintln!(
        "[Teams] get_teams_chat_messages: {} messages returned ({} non-message events filtered out)",
        messages.len(),
        filtered_out
    );
    Ok(serde_json::json!(messages))
}

/// Fetch today's messages from a configured Teams intake chat.
///
/// Takes the chatId directly (configured in Settings) rather than auto-detecting
/// the self-chat.  Returns TeamsFlatMessage items so TeamsImport can display and
/// import them without any additional wiring.
/// Today-only filter keeps the intake clean: only messages whose createdDateTime
/// starts with the current UTC date ("YYYY-MM-DD") are returned.
#[tauri::command]
async fn get_teams_intake_messages(
    app: tauri::AppHandle,
    client_id: String,
    chat_id: String,
) -> Result<Value, String> {
    if chat_id.trim().is_empty() {
        return Err("Teams intake chat ID is not configured. Set it in Settings â†’ Teams Intake.".to_string());
    }
    let token = ensure_valid_token(&app, &client_id).await?;

    // Fetch latest 50 messages from the configured chat (newest first).
    let url = format!(
        "{MS_GRAPH_BASE}/me/chats/{chat_id}/messages\
         ?$top=50\
         &$orderby=createdDateTime%20desc"
    );
    let data = graph_get(&url, &token).await?;
    let raw = data["value"].as_array().cloned().unwrap_or_default();

    // Today-only filter: keep messages whose createdDateTime starts with today's UTC date.
    use std::time::{SystemTime, UNIX_EPOCH};
    let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let today_str = unix_secs_to_date_str(now_secs);
    eprintln!("[Teams-intake] chatId prefix={} today_utc={} raw_count={}",
        &chat_id[..chat_id.len().min(12)], today_str, raw.len());

    let mut messages: Vec<Value> = Vec::new();
    let mut filtered_out = 0usize;
    for m in raw {
        if m["messageType"].as_str() != Some("message") {
            filtered_out += 1;
            continue;
        }
        let sent_at = m["createdDateTime"].as_str().unwrap_or("");
        if !sent_at.starts_with(today_str.as_str()) {
            filtered_out += 1;
            continue;
        }
        let raw_content = m["body"]["content"].as_str().unwrap_or("");
        let body_content_type = m["body"]["contentType"].as_str().unwrap_or("unknown");
        let content = strip_html(raw_content);
        if content.trim().len() < 3 {
            filtered_out += 1;
            continue;
        }

        // â”€â”€ Targeted diagnostic logging for forwarded-message diagnosis â”€â”€â”€â”€â”€â”€â”€â”€
        // Log attachment metadata and a body snippet for messages that look like
        // forwards (contains "from" keyword or has attachments). Safe and bounded.
        let atts = m["attachments"].as_array();
        let att_count = atts.map(|a| a.len()).unwrap_or(0);
        let plain_lower = content.to_ascii_lowercase();
        let looks_forwarded = att_count > 0
            || plain_lower.contains("forwarded")
            || plain_lower.contains("from:")
            || plain_lower.contains("original message");
        if looks_forwarded {
            let msg_id  = m["id"].as_str().unwrap_or("?");
            let snippet = &raw_content[..raw_content.len().min(300)];
            eprintln!("[Teams-fwd-diag] id={msg_id} bodyType={body_content_type} atts={att_count}");
            eprintln!("[Teams-fwd-diag] html_snippet={snippet:?}");
            if let Some(atts_arr) = atts {
                for (ai, att) in atts_arr.iter().enumerate() {
                    let ct      = att["contentType"].as_str().unwrap_or("?");
                    let att_id  = att["id"].as_str().unwrap_or("?");
                    let c_snip  = att["content"].as_str().unwrap_or("");
                    let c_snip  = &c_snip[..c_snip.len().min(200)];
                    eprintln!("[Teams-fwd-diag]   att[{ai}] contentType={ct:?} id={att_id} content={c_snip:?}");
                }
            }
        }

        // Parse forwarded-message metadata from the raw HTML *before* it is lost.
        let fwd = parse_teams_forwarded_card(&m, raw_content);
        if fwd.is_some() {
            eprintln!("[Teams-intake] forwarded card detected in message {}",
                m["id"].as_str().unwrap_or("?"));
        }

        // â”€â”€ Teams message link resolution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // If the intake message body contains a "Copy link to message" URL,
        // resolve and prefer the original linked message over forwarded heuristics.
        let link = parse_teams_message_link(&content);
        let mut linked_type   = "";         // "chat" | "channel" | ""
        let mut linked_url    = String::new();
        let mut link_resolved = false;
        let mut linked_meta: Option<ForwardedMeta> = None;

        if let Some(ref lnk) = link {
            linked_url = lnk.raw_url.clone();
            if lnk.is_channel {
                linked_type = "channel";       // not supported â€” surface in UI
                eprintln!("[Teams-link] channel link detected (unsupported): {}", &lnk.raw_url[..lnk.raw_url.len().min(80)]);
                // Still try to parse the preview card text for the original sender/body.
                if let Some(pc) = parse_teams_preview_card(&content) {
                    eprintln!("[Teams-link] preview card parsed from channel link: sender=\"{}\"", pc.sender_name);
                    linked_meta = Some(pc);
                }
            } else {
                linked_type = "chat";
                eprintln!("[Teams-link] chat link detected, resolving: chat={} msg={}",
                    &lnk.chat_id[..lnk.chat_id.len().min(20)],
                    &lnk.message_id[..lnk.message_id.len().min(20)]);
                match try_fetch_linked_chat_message(&token, &lnk.chat_id, &lnk.message_id).await {
                    Ok(Some(meta)) => {
                        eprintln!("[Teams-link] resolved: sender=\"{}\"", meta.sender_name);
                        link_resolved = true;
                        linked_meta   = Some(meta);
                    }
                    Ok(None) => {
                        eprintln!("[Teams-link] could not resolve (no data / permission); trying preview-card fallback");
                        if let Some(pc) = parse_teams_preview_card(&content) {
                            eprintln!("[Teams-link] preview card fallback: sender=\"{}\"", pc.sender_name);
                            linked_meta = Some(pc);
                        }
                    }
                    Err(e) => {
                        eprintln!("[Teams-link] resolution error: {e}; trying preview-card fallback");
                        if let Some(pc) = parse_teams_preview_card(&content) {
                            eprintln!("[Teams-link] preview card fallback: sender=\"{}\"", pc.sender_name);
                            linked_meta = Some(pc);
                        }
                    }
                }
            }
        }

        // Priority: linked message > forwarded card > normal intake message.
        let effective = linked_meta.as_ref().or(fwd.as_ref());
        messages.push(serde_json::json!({
            "id":                 m["id"],
            "senderName":         m["from"]["user"]["displayName"].as_str().unwrap_or(""),
            "senderEmail":        m["from"]["user"]["userPrincipalName"].as_str().unwrap_or(""),
            "sentAt":             sent_at,
            "content":            content,
            "chatId":             &chat_id,
            "chatTopic":          "Teams intake",
            "chatType":           "oneOnOne",
            "chatMembersSummary": "Intake chat",
            // Forwarded-message metadata â€” empty when not a forward.
            "isForwarded":         effective.is_some(),
            "originalSenderName":  effective.as_ref().map(|f| f.sender_name.as_str()).unwrap_or(""),
            "originalSenderEmail": effective.as_ref().and_then(|f| f.sender_email.as_deref()).unwrap_or(""),
            "originalSentAt":      effective.as_ref().and_then(|f| f.sent_at.as_deref()).unwrap_or(""),
            "originalContent":     effective.as_ref().map(|f| f.content.as_str()).unwrap_or(""),
            // Teams link metadata â€” non-empty when a "Copy link to message" URL was found.
            "hasLinkedTeamsMessage": link.is_some(),
            "linkedMessageUrl":      linked_url,
            "linkedMessageType":     linked_type,
            "linkedMessageResolved": link_resolved,
        }));
    }
    eprintln!("[Teams-intake] {} messages kept today, {} filtered out", messages.len(), filtered_out);
    Ok(serde_json::json!(messages))
}

/// Fetch the latest 20 Teams chat messages across the user's recent chats.
///
/// Strategy (delegated auth, no admin permissions required):
///   1. Load up to 25 recent chats via /me/chats.
///   2. For each chat, fetch the 3 most recent messages via /me/chats/{id}/messages.
///   3. Merge into one flat list, filter noise, sort by sentAt desc, take top 20.
///
/// Per-chat message failures are logged and skipped so one inaccessible chat
/// does not fail the whole request.
#[tauri::command]
async fn get_teams_recent_messages(
    app: tauri::AppHandle,
    client_id: String,
) -> Result<Value, String> {
    let token = ensure_valid_token(&app, &client_id).await?;

    // Step 1: recent chats (no $orderby â€” not supported with $expand)
    let chats_url = format!(
        "{MS_GRAPH_BASE}/me/chats\
         ?$top=25\
         &$expand=members\
         &$select=id,topic,chatType,lastUpdatedDateTime,members"
    );
    let chats_data = graph_get(&chats_url, &token).await?;
    let raw_chats = chats_data["value"].as_array().cloned().unwrap_or_default();
    eprintln!("[Teams] get_teams_recent_messages: {} chats loaded (target: 25)", raw_chats.len());

    // Step 2: for each chat, fetch the 2 most recent messages
    let mut all_messages: Vec<Value> = Vec::new();
    let mut chats_with_errors = 0usize;
    let mut total_raw = 0usize;
    let mut filtered_out = 0usize;

    for chat in &raw_chats {
        let chat_id = match chat["id"].as_str() {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => continue,
        };
        let members: Vec<&str> = chat["members"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|m| m["displayName"].as_str()).collect())
            .unwrap_or_default();
        let members_summary = members.join(", ");
        let chat_topic = chat["topic"].as_str().unwrap_or("").to_string();
        let chat_type  = chat["chatType"].as_str().unwrap_or("").to_string();

        let msgs_url = format!(
            "{MS_GRAPH_BASE}/me/chats/{chat_id}/messages\
             ?$top=3\
             &$orderby=createdDateTime%20desc"
        );
        let msgs_data = match graph_get(&msgs_url, &token).await {
            Ok(d)  => d,
            Err(e) => {
                eprintln!("[Teams] get_teams_recent_messages: skipped chat {chat_id}: {e}");
                chats_with_errors += 1;
                continue;
            }
        };

        let raw_msgs = msgs_data["value"].as_array().cloned().unwrap_or_default();
        total_raw += raw_msgs.len();

        for m in raw_msgs {
            // Filter: only user-authored messages (not system events / call records)
            if m["messageType"].as_str() != Some("message") {
                filtered_out += 1;
                continue;
            }
            let raw_content = m["body"]["content"].as_str().unwrap_or("");
            let content = strip_html(raw_content);
            // Filter: skip trivially empty bodies
            if content.trim().len() < 3 {
                filtered_out += 1;
                continue;
            }

            all_messages.push(serde_json::json!({
                "id":                 m["id"],
                "senderName":         m["from"]["user"]["displayName"].as_str().unwrap_or(""),
                "senderEmail":        m["from"]["user"]["userPrincipalName"].as_str().unwrap_or(""),
                "sentAt":             m["createdDateTime"],
                "content":            content,
                "chatId":             chat_id,
                "chatTopic":          chat_topic,
                "chatType":           chat_type,
                "chatMembersSummary": members_summary,
            }));
        }
    }

    // Sort by sentAt descending and keep top 20
    all_messages.sort_by(|a, b| {
        let ta = a["sentAt"].as_str().unwrap_or("");
        let tb = b["sentAt"].as_str().unwrap_or("");
        tb.cmp(ta)
    });
    all_messages.truncate(20);

    eprintln!(
        "[Teams] get_teams_recent_messages: {} raw messages from {} chats, {} filtered, {} shown ({} chat errors)",
        total_raw,
        raw_chats.len(),
        filtered_out,
        all_messages.len(),
        chats_with_errors,
    );
    Ok(serde_json::json!(all_messages))
}

/// Convert a Unix timestamp (seconds since epoch) to a UTC date string "YYYY-MM-DD".
/// Uses Howard Hinnant's civil-from-days algorithm â€” no external crate required.
fn unix_secs_to_date_str(secs: u64) -> String {
    let z   = (secs / 86400) as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp  = (5 * doy + 2) / 153;
    let d   = doy - (153 * mp + 2) / 5 + 1;
    let m   = if mp < 10 { mp + 3 } else { mp - 9 };
    let y   = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Fetch today's messages from the signed-in user's self-chat (Teams intake inbox).
///
/// Self-chat identification: look for a `oneOnOne` chat where every member's
/// `userId` equals the signed-in user's own ID.  This is the Graph-standard marker
/// for the "Chat with yourself" entry that Teams creates automatically.
///
/// Today-only filter is applied locally: Graph `createdDateTime` strings start with
/// "YYYY-MM-DD", so prefix-matching against the current UTC date is sufficient.
#[tauri::command]
async fn get_teams_self_chat_messages(
    app: tauri::AppHandle,
    client_id: String,
) -> Result<Value, String> {
    let token = ensure_valid_token(&app, &client_id).await?;

    // Step 1: resolve the signed-in user's Graph userId.
    let me_data = graph_get(&format!("{MS_GRAPH_BASE}/me?$select=id"), &token).await?;
    let my_id = me_data["id"].as_str().unwrap_or("").to_string();
    if my_id.is_empty() {
        return Err("Could not determine signed-in user ID from Microsoft Graph.".to_string());
    }
    eprintln!("[Teams-selfchat] signed-in userId prefix={}", &my_id[..my_id.len().min(8)]);

    // Step 2: fetch chats with members expanded so we can identify the self-chat.
    let chats_url = format!(
        "{MS_GRAPH_BASE}/me/chats\
         ?$top=50\
         &$expand=members\
         &$select=id,topic,chatType,members"
    );
    let chats_data = graph_get(&chats_url, &token).await?;
    let raw_chats = chats_data["value"].as_array().cloned().unwrap_or_default();
    eprintln!("[Teams-selfchat] {} chats fetched", raw_chats.len());

    // Step 3: find the self-chat â€” a oneOnOne chat where ALL members share my userId.
    let self_chat_id = raw_chats.iter().find_map(|c| {
        if c["chatType"].as_str() != Some("oneOnOne") {
            return None;
        }
        let members = c["members"].as_array()?;
        if members.is_empty() {
            return None;
        }
        let all_self = members.iter().all(|m| {
            m["userId"].as_str().map(|id| id == my_id.as_str()).unwrap_or(false)
        });
        if all_self { Some(c["id"].as_str()?.to_string()) } else { None }
    });
    let chat_id = match self_chat_id {
        Some(id) => id,
        None => return Err(
            "Self-chat not found. Open Teams, go to Chat, and send a message to yourself to create the intake chat.".to_string()
        ),
    };
    eprintln!("[Teams-selfchat] self-chat found chatId prefix={}", &chat_id[..chat_id.len().min(12)]);

    // Step 4: fetch latest 50 messages from the self-chat (newest first).
    let msgs_url = format!(
        "{MS_GRAPH_BASE}/me/chats/{chat_id}/messages\
         ?$top=50\
         &$orderby=createdDateTime%20desc"
    );
    let msgs_data = graph_get(&msgs_url, &token).await?;
    let raw_msgs = msgs_data["value"].as_array().cloned().unwrap_or_default();

    // Step 5: compute today's UTC date string for the today-only filter.
    use std::time::{SystemTime, UNIX_EPOCH};
    let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let today_str = unix_secs_to_date_str(now_secs);
    eprintln!("[Teams-selfchat] today_utc={}", today_str);

    let mut messages: Vec<Value> = Vec::new();
    let mut filtered_out = 0usize;
    for m in raw_msgs {
        if m["messageType"].as_str() != Some("message") {
            filtered_out += 1;
            continue;
        }
        let sent_at = m["createdDateTime"].as_str().unwrap_or("");
        // Keep only messages sent today (UTC).
        if !sent_at.starts_with(today_str.as_str()) {
            filtered_out += 1;
            continue;
        }
        let raw_content = m["body"]["content"].as_str().unwrap_or("");
        let content = strip_html(raw_content);
        if content.trim().len() < 3 {
            filtered_out += 1;
            continue;
        }
        messages.push(serde_json::json!({
            "id":                 m["id"],
            "senderName":         m["from"]["user"]["displayName"].as_str().unwrap_or(""),
            "senderEmail":        m["from"]["user"]["userPrincipalName"].as_str().unwrap_or(""),
            "sentAt":             sent_at,
            "content":            content,
            "chatId":             &chat_id,
            "chatTopic":          "Self-chat",
            "chatType":           "oneOnOne",
            "chatMembersSummary": "Self-chat intake",
        }));
    }
    eprintln!(
        "[Teams-selfchat] {} messages kept today, {} filtered out",
        messages.len(), filtered_out
    );
    Ok(serde_json::json!(messages))
}

/// Cheap pre-check: returns true if the email is likely from Azure DevOps.
///
/// Examines the sender address, subject line, and body preview using simple
/// string matching â€” no HTML parsing involved. This gates the more expensive
/// `extract_ado_link_pairs` so we don't scan every Outlook email for ADO links.
///
/// Broad-enough to catch all real ADO notification types:
///   - PR review requests / comments / approvals / completions
///   - Work item creation / updates
///   - Build notifications
fn is_potential_ado_email(from_email: &str, subject: &str, body_preview: &str) -> bool {
    let email_lower   = from_email.to_ascii_lowercase();
    let subject_lower = subject.to_ascii_lowercase();
    let preview_lower = body_preview.to_ascii_lowercase();

    // Sender-based: most ADO notifications come from a canonical MS address.
    if email_lower == "azuredevops@microsoft.com"
        || email_lower.ends_with("@ado.microsoft.com")
        || email_lower.contains("vstfs")
        || (email_lower.contains("azuredevops") && email_lower.ends_with("@microsoft.com"))
    {
        return true;
    }

    // Subject-based: low false-positive patterns that are strongly ADO-specific.
    let subject_signals: &[&str] = &[
        "pr - ",           // PR review request: "PR - Fix login - Proj 42 (Reviewer)"
        "pull request",
        "has commented on",
        "commented on",
        "work item",
        "build succeeded",
        "build failed",
        "build partially succeeded",
        "pipeline",
        "release ",
    ];
    for signal in subject_signals {
        if subject_lower.contains(signal) {
            return true;
        }
    }

    // Body-preview-based: used when subject alone is generic.
    let preview_signals: &[&str] = &[
        "pull request",
        "dev.azure.com",
        "visualstudio.com",
        "azure devops",
        "work item",
        "approved the changes",
        "completed the pull request",
        "has commented on",
    ];
    for signal in preview_signals {
        if preview_lower.contains(signal) {
            return true;
        }
    }

    false
}

/// Extracts (href, anchor_text) pairs for all Azure DevOps links in HTML.
///
/// Strategy:
///   1. Find each <a href="https://dev.azure.com/..."> tag.
///   2. Capture the full href attribute value (with &amp; still encoded).
///   3. Capture the visible anchor text inside the tag (stripped of any nested HTML).
///
/// The caller is responsible for decoding HTML entities in the href before use.
fn extract_ado_link_pairs(html: &str) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    let lower = html.to_ascii_lowercase();
    let mut search_pos = 0usize;

    loop {
        // Find the next opening <a ...> tag
        let Some(rel_a) = lower[search_pos..].find("<a ").or_else(|| lower[search_pos..].find("<a\t"))
            else { break };
        let a_start = search_pos + rel_a;

        // Find the closing > of this opening tag
        let Some(rel_gt) = lower[a_start..].find('>')
            else { break };
        let tag_end = a_start + rel_gt + 1; // byte after '>'

        let tag_slice = &html[a_start..tag_end - 1]; // content inside <a ... >

        // Extract href value â€” look for href="..."
        let href_opt = 'href: {
            let tag_lower = tag_slice.to_ascii_lowercase();
            let Some(href_pos) = tag_lower.find("href=\"") else { break 'href None };
            let value_start = href_pos + 6; // after href="
            let Some(value_end) = tag_lower[value_start..].find('"') else { break 'href None };
            let raw_href = &tag_slice[value_start..value_start + value_end];
            // Keep Azure DevOps URLs: both the modern dev.azure.com domain
            // and the legacy <org>.visualstudio.com domain still used by many orgs.
            let href_lower = raw_href.to_ascii_lowercase();
            let is_ado_url = href_lower.starts_with("https://dev.azure.com/")
                || href_lower.contains(".visualstudio.com/");
            if !is_ado_url {
                break 'href None;
            }
            // Decode &amp; â†’ & so the URL is valid when opened
            Some(raw_href.replace("&amp;", "&").replace("&#38;", "&"))
        };

        if let Some(href) = href_opt {
            // Find </a> to capture anchor text
            let anchor_text = if let Some(rel_close) = lower[tag_end..].find("</a>") {
                let inner_html = &html[tag_end..tag_end + rel_close];
                // Strip any nested tags from the anchor text
                strip_html(inner_html)
            } else {
                String::new()
            };
            let label = anchor_text.split_whitespace().collect::<Vec<_>>().join(" ");
            eprintln!("[ado-link] candidate href={} label=\"{}\"", &href[..href.len().min(120)], label);
            pairs.push((href, label));
        }

        search_pos = tag_end;
    }
    pairs
}

/// Returns true for HTML tags that represent block-level breaks.
/// `tag` must be the raw tag name+attributes, lowercased (without < >).
fn is_block_tag(tag: &str) -> bool {
    // Extract just the tag name (first word, strip leading slash for closing tags)
    let name = tag.trim_start_matches('/').split_ascii_whitespace().next().unwrap_or("");
    matches!(
        name,
        "p" | "div" | "br" | "hr" | "tr" | "td" | "th" | "li" | "dt" | "dd"
            | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
            | "blockquote" | "pre" | "article" | "section"
            | "table" | "thead" | "tbody" | "tfoot"
    )
}

/// Email-aware HTML stripper: preserves paragraph / line-break structure.
/// Block-level tags (p, div, br, tr, â€¦) become newlines so that email thread
/// boundaries remain detectable for the frontend thread splitter.
/// Use this for Outlook full-body content; use `strip_html` for short previews.
fn strip_html_email(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag_buf = String::new();

    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag_buf.clear();
            }
            '>' => {
                if in_tag {
                    let tag_lower = tag_buf.to_ascii_lowercase();
                    if is_block_tag(tag_lower.trim()) {
                        out.push('\n');
                    } else {
                        out.push(' ');
                    }
                    tag_buf.clear();
                } else {
                    // Stray > in content â€” pass through
                    out.push(ch);
                }
                in_tag = false;
            }
            c if in_tag => tag_buf.push(c),
            c => out.push(c),
        }
    }

    // Decode common HTML entities
    let decoded = out
        .replace("&nbsp;",  " ")
        .replace("&amp;",   "&")
        .replace("&lt;",    "<")
        .replace("&gt;",    ">")
        .replace("&quot;",  "\"")
        .replace("&apos;",  "'")
        .replace("&#39;",   "'")
        .replace("&mdash;", "\u{2014}")
        .replace("&ndash;", "\u{2013}")
        .replace("&ldquo;", "\u{201c}")
        .replace("&rdquo;", "\u{201d}")
        .replace("&lsquo;", "\u{2018}")
        .replace("&rsquo;", "\u{2019}")
        .replace("&hellip;","\u{2026}")
        .replace("&bull;",  "\u{2022}")
        .replace("&#8211;", "\u{2013}")
        .replace("&#8212;", "\u{2014}")
        .replace("&#8216;", "\u{2018}")
        .replace("&#8217;", "\u{2019}")
        .replace("&#8220;", "\u{201c}")
        .replace("&#8221;", "\u{201d}")
        .replace("&#8230;", "\u{2026}");

    // Normalise: trim each line, collapse runs of 3+ blank lines to 2
    let mut result = String::new();
    let mut blank_run = 0usize;
    for line in decoded.lines() {
        let t = line.trim_end();
        if t.is_empty() {
            blank_run += 1;
            if blank_run <= 2 {
                result.push('\n');
            }
        } else {
            blank_run = 0;
            result.push_str(t);
            result.push('\n');
        }
    }

    result.trim().to_string()
}

/// HTML tag stripper with basic entity decoding for Teams / Outlook message bodies.
fn strip_html(html: &str) -> String {
    // Step 1: strip tags
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => { in_tag = false; out.push(' '); }  // replace tag with space
            c if !in_tag => out.push(c),
            _ => {}
        }
    }

    // Step 2: decode common HTML entities
    let decoded = out
        .replace("&nbsp;",  " ")
        .replace("&amp;",   "&")
        .replace("&lt;",    "<")
        .replace("&gt;",    ">")
        .replace("&quot;",  "\"")
        .replace("&apos;",  "'")
        .replace("&#39;",   "'")
        .replace("&mdash;", "\u{2014}")
        .replace("&ndash;", "\u{2013}")
        .replace("&ldquo;", "\u{201c}")
        .replace("&rdquo;", "\u{201d}")
        .replace("&lsquo;", "\u{2018}")
        .replace("&rsquo;", "\u{2019}")
        .replace("&hellip;","\u{2026}")
        .replace("&bull;",  "\u{2022}")
        .replace("&#8211;", "\u{2013}")
        .replace("&#8212;", "\u{2014}")
        .replace("&#8216;", "\u{2018}")
        .replace("&#8217;", "\u{2019}")
        .replace("&#8220;", "\u{201c}")
        .replace("&#8221;", "\u{201d}")
        .replace("&#8230;", "\u{2026}");

    // Collapse whitespace
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

/// Returns an accurate ISO 8601 UTC timestamp for "now" without pulling in chrono.
fn chrono_now_iso() -> String {
    let secs = now_unix() as i64;
    let time_of_day = secs % 86400;
    let h = time_of_day / 3600;
    let m = (time_of_day % 3600) / 60;
    let s = time_of_day % 60;

    let mut remaining_days = secs / 86400;
    let mut year = 1970i64;
    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        year += 1;
    }

    let leap = is_leap_year(year);
    let days_per_month: [i64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1i64;
    for &dim in &days_per_month {
        if remaining_days < dim {
            break;
        }
        remaining_days -= dim;
        month += 1;
    }
    let day = remaining_days + 1;

    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}

// --- Teams message link detection and resolution --------------------------

/// Structured data extracted from a Teams message URL.
struct ParsedTeamsLink {
    raw_url:    String,
    chat_id:    String,
    message_id: String,
    /// True when the URL contains a non-empty `groupId` query parameter,
    /// which signals a channel (team) message rather than a plain chat message.
    is_channel: bool,
}

/// Scan plain text for the first `teams.microsoft.com/l/message/` URL and
/// decode the chat-id and message-id embedded in its path.
///
/// Teams deep-link format:
///   `https://teams.microsoft.com/l/message/<encoded-chat-id>/<message-id>?<query>`
///
/// Returns `None` when no recognised Teams message URL is found.
fn parse_teams_message_link(plain_text: &str) -> Option<ParsedTeamsLink> {
    const PREFIX: &str = "https://teams.microsoft.com/l/message/";
    let start = plain_text.find(PREFIX)?;
    let after_prefix = &plain_text[start + PREFIX.len()..];

    // Grab the URL up to the first whitespace/newline
    let url_len = after_prefix
        .find(|c: char| c.is_whitespace())
        .unwrap_or(after_prefix.len());
    let url_part = &after_prefix[..url_len];
    let raw_url  = format!("{PREFIX}{url_part}");

    // Split path: <encoded-chat-id>/<message-id>[?query]
    let slash = url_part.find('/')?;
    let encoded_chat_id = &url_part[..slash];
    let after_slash = &url_part[slash + 1..];

    let q_pos = after_slash.find('?').unwrap_or(after_slash.len());
    let encoded_message_id = &after_slash[..q_pos];
    let query = if q_pos < after_slash.len() { &after_slash[q_pos + 1..] } else { "" };

    let chat_id    = percent_decode(encoded_chat_id);
    let message_id = percent_decode(encoded_message_id);
    if chat_id.is_empty() || message_id.is_empty() {
        return None;
    }

    // A non-empty groupId signals a channel (team) message.
    let is_channel = query.split('&').any(|kv| {
        let mut parts = kv.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let val = parts.next().unwrap_or("");
        key == "groupId" && !val.is_empty()
    });

    Some(ParsedTeamsLink { raw_url, chat_id, message_id, is_channel })
}

/// Attempt to fetch the linked Teams chat message directly from Graph.
/// Returns `Ok(Some(meta))` on success, `Ok(None)` on not-found / permission
/// error (caller should surface "unresolved"), `Err(())` on unexpected failure.
async fn try_fetch_linked_chat_message(
    token:      &str,
    chat_id:    &str,
    message_id: &str,
) -> Result<Option<ForwardedMeta>, String> {
    let url = format!("{MS_GRAPH_BASE}/me/chats/{chat_id}/messages/{message_id}");
    match graph_get(&url, token).await {
        Ok(data) => {
            let sender_name = data["from"]["user"]["displayName"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let sender_email = data["from"]["user"]["userPrincipalName"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let sent_at  = data["createdDateTime"].as_str().map(|s| s.to_string());
            let body_html = data["body"]["content"].as_str().unwrap_or("");
            let content   = strip_html(body_html).trim().to_string();

            if sender_name.is_empty() && content.is_empty() {
                return Ok(None);
            }
            Ok(Some(ForwardedMeta {
                sender_name: if sender_name.is_empty() { "[unknown]".to_string() } else { sender_name },
                sender_email,
                sent_at,
                content,
            }))
        }
        Err(e) => {
            eprintln!("[Teams-link] fetch failed for chat={chat_id} msg={message_id}: {e}");
            Ok(None)
        }
    }
}

// --- Forwarded Teams message detection ------------------------------------

/// Strip trailing Teams UI chrome from a plain-text string.
/// Removes `| Chat | Microsoft Teams`, `| Microsoft Teams`, and bare `| Chat`
/// suffixes that Teams injects into link-preview card text.
fn strip_teams_chrome(s: &str) -> &str {
    let mut result = s.trim();
    let patterns = [
        "| Chat | Microsoft Teams",
        "| Microsoft Teams",
        "| General | Microsoft Teams",
        "| Channel | Microsoft Teams",
        "| Chat",
    ];
    for pat in &patterns {
        if let Some(idx) = result.rfind(pat) {
            result = result[..idx].trim();
        }
    }
    result
}

/// Parse a Teams link-preview card from plain intake text.
///
/// When a user pastes a Teams message link into a chat, Teams renders it as a
/// "rich preview" card.  After HTML stripping the body looks like:
///
///   `Jan Kvicala: V tÄ›ch 16:00 spustĂ­me ten release na PROD | Chat | Microsoft Teams`
///   `https://teams.microsoft.com/l/message/...`
///
/// This function detects that pattern and extracts the original sender name
/// and message body, stripping all Teams UI chrome.
///
/// Returns `None` when the text does not match the preview-card pattern.
fn parse_teams_preview_card(content: &str) -> Option<ForwardedMeta> {
    // Remove the URL itself so we're left with just the preview text.
    let without_url = if let Some(idx) = content.find("https://teams.microsoft.com") {
        content[..idx].trim()
    } else {
        content.trim()
    };

    // Strip trailing Teams chrome ("| Chat | Microsoft Teams" etc.)
    let clean = strip_teams_chrome(without_url);
    if clean.is_empty() { return None; }

    // Expect first non-empty line to be "<SenderName>: <body text>"
    let first_line = clean.lines().next()?.trim();
    let colon_idx = first_line.find(':')?;
    let name = first_line[..colon_idx].trim();

    // Validate sender name: non-empty, not a URL fragment, reasonable length.
    if name.is_empty() || name.len() > 80 || name.contains('/') || name.contains('@') {
        return None;
    }

    let body_first = first_line[colon_idx + 1..].trim();
    let rest_lines: Vec<&str> = clean.lines().skip(1)
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    let body = if rest_lines.is_empty() {
        body_first.to_string()
    } else {
        format!("{body_first}\n{}", rest_lines.join("\n"))
    };
    let body = body.trim().to_string();
    if body.is_empty() { return None; }

    Some(ForwardedMeta {
        sender_name:  name.to_string(),
        sender_email: None,
        sent_at:      None,
        content:      body,
    })
}

/// Metadata extracted from a forwarded Teams intake message.
struct ForwardedMeta {
    sender_name:  String,
    sender_email: Option<String>,
    sent_at:      Option<String>,
    content:      String,
}

/// Attempt to extract original-message metadata from a forwarded Teams intake message.
///
/// Two strategies (tried in order):
///
/// 1. **messageReference attachment** â€” when a user explicitly shares/references
///    another message via the Teams UI, the Graph API populates
///    `attachments[].contentType == "messageReference"` with a JSON `content`
///    string that contains `messageSender.user.{displayName,userPrincipalName}`
///    and `messagePreview`. This is the most reliable signal.
///
/// 2. **HTML `<b>From:</b>` pattern** â€” when a message is forwarded by copying
///    and pasting, the body HTML often contains an email-style header block
///    (`<b>From:</b> Name ...`) that is destroyed when `strip_html` is called.
///    We parse this *before* stripping.
///
/// Returns `None` for normal (non-forwarded) messages so the caller falls back
/// cleanly to the existing behaviour.
fn parse_teams_forwarded_card(msg: &Value, body_html: &str) -> Option<ForwardedMeta> {
    // â”€â”€ Strategy 1 & 3: attachment-based detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Strategy 1: contentType == "messageReference"  (explicit Teams forward button)
    // Strategy 3: contentType == "reference"         (some group-chat / channel variants)
    if let Some(atts) = msg["attachments"].as_array() {
        for att in atts {
            let ct = att["contentType"].as_str().unwrap_or("");
            if ct != "messageReference" && ct != "reference" {
                continue;
            }
            let content_str = att["content"].as_str().unwrap_or("{}");
            if let Ok(c) = serde_json::from_str::<Value>(content_str) {
                let sender_name = c["messageSender"]["user"]["displayName"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let sender_email = c["messageSender"]["user"]["userPrincipalName"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let preview = c["messagePreview"].as_str().unwrap_or("").trim().to_string();
                if !sender_name.is_empty() {
                    // Prefer the structured preview; fall back to the full stripped body.
                    let full_stripped = strip_html(body_html);
                    let content = if !preview.is_empty() {
                        preview
                    } else {
                        full_stripped.trim().to_string()
                    };
                    return Some(ForwardedMeta {
                        sender_name,
                        sender_email,
                        sent_at: None,
                        content,
                    });
                }
            }
        }
    }

    // â”€â”€ Strategy 4: blockquote / Teams indent-forward â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // When a user pastes a forwarded block, Teams sometimes wraps it in a
    // <blockquote> or a <div> with the forwarded content inside.  We look for
    // a <blockquote> that contains recognisable attribution text.
    let lower_html = body_html.to_ascii_lowercase();
    if lower_html.contains("<blockquote") {
        // Extract everything between the first <blockquote ...> and </blockquote>.
        if let (Some(open_end), Some(close_start)) =
            (lower_html.find('>'), lower_html.find("</blockquote"))
        {
            // Find the > that closes the opening <blockquote tag.
            let tag_close = body_html[..close_start]
                .find('>')
                .map(|p| p + 1)
                .unwrap_or(open_end + 1);
            let inner_html = &body_html[tag_close..close_start];
            let inner_text = strip_html(inner_html).trim().to_string();
            // Treat the outer message sender as the forwarder; the blockquote
            // body is the original message content.
            if !inner_text.is_empty() {
                // Try to pull a "From:" or "Name wrote:" attribution from the
                // first line of the blockquote; fall back to the full block.
                let lines: Vec<&str> = inner_text.lines().collect();
                let first = lines.first().copied().unwrap_or("");
                let (sender_name, content) = if let Some(rest) = first.strip_prefix("From:") {
                    let raw = rest.trim();
                    let name = if let Some(a) = raw.find('<') { raw[..a].trim().to_string() }
                               else { raw.to_string() };
                    (name, lines[1..].join("\n").trim().to_string())
                } else if first.contains(" wrote:") || first.contains(" says:") {
                    let name = first.split_once(" wrote:").or_else(|| first.split_once(" says:"))
                        .map(|(n, _)| n.trim().to_string())
                        .unwrap_or_default();
                    (name, lines[1..].join("\n").trim().to_string())
                } else {
                    (String::new(), inner_text.clone())
                };
                if !content.is_empty() {
                    return Some(ForwardedMeta {
                        sender_name: if sender_name.is_empty() {
                            // Fall back: mark as forwarded but attribute sender unknown
                            "[forwarded]".to_string()
                        } else {
                            sender_name
                        },
                        sender_email: None,
                        sent_at: None,
                        content,
                    });
                }
            }
        }
    }

    // â”€â”€ Strategy 2: HTML <b>From:</b> / <strong>From:</strong> pattern â”€â”€â”€â”€â”€â”€â”€â”€
    // Parse this in the raw HTML *before* strip_html destroys the structure.
    if lower_html.contains("<b>from:</b>") || lower_html.contains("<strong>from:</strong>") {
        let plain = strip_html(body_html);
        let lines: Vec<&str> = plain.lines().collect();
        let mut sender_name:  String          = String::new();
        let mut sender_email: Option<String>  = None;
        let mut sent_at:      Option<String>  = None;
        let mut body_start:   usize           = lines.len(); // default: no body found

        for (i, line) in lines.iter().enumerate() {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix("From:") {
                let raw = rest.trim();
                if let (Some(a), Some(b)) = (raw.find('<'), raw.find('>')) {
                    // "Display Name <user@domain>"
                    sender_name  = raw[..a].trim().to_string();
                    sender_email = Some(raw[a + 1..b].trim().to_string());
                } else if raw.contains('@') {
                    sender_email = Some(raw.to_string());
                    sender_name  = raw.split('@').next().unwrap_or(raw).to_string();
                } else {
                    sender_name = raw.to_string();
                }
            } else if let Some(rest) = t.strip_prefix("Sent:") {
                sent_at = Some(rest.trim().to_string());
            } else if !sender_name.is_empty()
                && !t.is_empty()
                && !t.starts_with("To:")
                && !t.starts_with("Cc:")
                && !t.starts_with("Subject:")
            {
                body_start = i;
                break;
            }
        }

        if !sender_name.is_empty() && body_start < lines.len() {
            let content = lines[body_start..].join("\n").trim().to_string();
            if !content.is_empty() {
                return Some(ForwardedMeta { sender_name, sender_email, sent_at, content });
            }
        }
    }

    None
}


// --- Task Workbench MCP bridge --------------------------------------------

const TASK_MCP_BRIDGE_HOST: &str = "127.0.0.1";
const TASK_MCP_BRIDGE_PORT: u16 = 38473;
const TASK_MCP_MAX_SUMMARY_LENGTH: usize = 700;
const TASK_MCP_MAX_NOTE_LENGTH: usize = 1500;
const TASK_MCP_MAX_BODY_BYTES: usize = 256 * 1024;

static TASK_MCP_BRIDGE_STATE: OnceLock<Mutex<Value>> = OnceLock::new();
static TASK_MCP_BRIDGE_TOKEN: OnceLock<String> = OnceLock::new();

fn task_mcp_bridge_token() -> &'static str {
    TASK_MCP_BRIDGE_TOKEN.get_or_init(|| {
        use rand::Rng;
        rand::thread_rng()
            .sample_iter(&rand::distributions::Alphanumeric)
            .take(32)
            .map(char::from)
            .collect()
    })
}

fn task_mcp_bridge_state() -> &'static Mutex<Value> {
    TASK_MCP_BRIDGE_STATE.get_or_init(|| {
        Mutex::new(serde_json::json!({
            "active": false,
            "host": TASK_MCP_BRIDGE_HOST,
            "port": TASK_MCP_BRIDGE_PORT,
            "readOnlyTools": task_mcp_read_only_tool_definitions(),
            "localWriteTools": task_mcp_local_write_tool_definitions(),
            "readOnlyMode": false,
            "localWriteMode": true,
            "lastError": Value::Null,
            "serverPath": task_mcp_server_script_path(),
            "bridgeToken": task_mcp_bridge_token(),
        }))
    })
}

fn task_mcp_update_bridge_state(mutator: impl FnOnce(&mut Value)) {
    if let Ok(mut state) = task_mcp_bridge_state().lock() {
        mutator(&mut state);
    }
}

fn task_mcp_current_bridge_state() -> Value {
    task_mcp_bridge_state()
        .lock()
        .map(|v| v.clone())
        .unwrap_or_else(|_| serde_json::json!({
            "active": false,
            "host": TASK_MCP_BRIDGE_HOST,
            "port": TASK_MCP_BRIDGE_PORT,
            "readOnlyTools": task_mcp_read_only_tool_definitions(),
            "localWriteTools": task_mcp_local_write_tool_definitions(),
            "readOnlyMode": false,
            "localWriteMode": true,
            "lastError": "Bridge state lock poisoned.",
            "serverPath": task_mcp_server_script_path(),
            "bridgeToken": task_mcp_bridge_token(),
        }))
}

fn task_mcp_current_bridge_state_for_ui() -> Value {
    let mut state = task_mcp_current_bridge_state();
    if let Some(map) = state.as_object_mut() {
        map.remove("bridgeToken");
    }
    state
}

fn task_mcp_server_script_path() -> String {
    // Normalise to forward slashes so snippets work on all platforms.
    let to_fwd = |p: std::path::PathBuf| p.to_string_lossy().replace('\\', "/");

    if let Ok(cwd) = std::env::current_dir() {
        // Happy path: project root is the working directory (production or `cargo run` from root).
        let candidate = cwd.join("mcp").join("task-workbench-mcp.mjs");
        if candidate.exists() {
            return to_fwd(candidate);
        }
        // Dev mode: Tauri sets cwd to <project>/src-tauri; script lives one level up.
        if let Some(parent) = cwd.parent() {
            let parent_candidate = parent.join("mcp").join("task-workbench-mcp.mjs");
            if parent_candidate.exists() {
                return to_fwd(parent_candidate);
            }
        }
        // Fallback: construct the path even if it doesn't exist yet.
        let fallback = cwd.join("mcp").join("task-workbench-mcp.mjs");
        return to_fwd(fallback);
    }
    "mcp/task-workbench-mcp.mjs".to_string()
}

fn task_mcp_read_only_tool_definitions() -> Vec<Value> {
    vec![
        serde_json::json!({"name":"list_tasks",                "description":"List sanitized task-workbench tasks.","readOnly":true}),
        serde_json::json!({"name":"get_task",                  "description":"Get one sanitized task by id.","readOnly":true}),
        serde_json::json!({"name":"get_task_summary",          "description":"Get one sanitized task summary by id.","readOnly":true}),
        serde_json::json!({"name":"get_task_full_context",     "description":"Get comprehensive task context: phase, mode, setup, estimate, checklist, notes, PR state, and next step.","readOnly":true}),
        serde_json::json!({"name":"get_task_workflow_overview","description":"Get simplified workflow state: display phase, waiting state, checklist, and next recommended step.","readOnly":true}),
        serde_json::json!({"name":"get_task_original_message", "description":"Get sanitized original email/Teams/DevOps message for a task.","readOnly":true}),
        serde_json::json!({"name":"get_task_developer_setup",  "description":"Get developer mode setup: mode, work kind, work action, repository root, plugin/script target.","readOnly":true}),
        serde_json::json!({"name":"get_crm_workflow_state",    "description":"Get sanitized CRM Developer Workflow state for a task.","readOnly":true}),
        serde_json::json!({"name":"get_current_crm_workflow_step","description":"Get the current CRM workflow step and gate summary.","readOnly":true}),
        serde_json::json!({"name":"get_technical_plan",        "description":"Get the persisted local technical implementation plan for a task.","readOnly":true}),
        serde_json::json!({"name":"get_pr_review_state",       "description":"Get sanitized local pull-request review state.","readOnly":true}),
        serde_json::json!({"name":"get_next_recommended_step",              "description":"Get conservative next local workflow step for a task.","readOnly":true}),
        serde_json::json!({"name":"prepare_commit_for_task",               "description":"Read-only Git preview. Does not stage, commit, push, create branch, or create PR.","readOnly":true}),
        serde_json::json!({"name":"run_dataverse_check_for_task",          "description":"Read-only Dataverse metadata check for a task via Primarch. Persists report locally. No Dataverse writes.","readOnly":true}),
        serde_json::json!({"name":"get_dataverse_verification_report",     "description":"Return the stored Dataverse verification report for a task. Does not run a new check.","readOnly":true}),
        serde_json::json!({"name":"get_external_action_proposal",          "description":"Return the current external action proposal state for a task (externalActionPreview, approval gate, execution tracking).","readOnly":true}),
        serde_json::json!({"name":"get_implementation_verification_state", "description":"Return the implementation verification state for a task: build check, Dataverse check override, AI code review, local test, consultant testing.","readOnly":true}),
        serde_json::json!({"name":"get_implementation_readiness",          "description":"Return implementation readiness for a developer plugin/script task: isImplementationReady, blockers, warnings, recommendedNextStep.","readOnly":true}),
        serde_json::json!({"name":"get_task_templates",                    "description":"Return built-in task setup templates and the matched template for a task title, when any.","readOnly":true}),
    ]
}

fn task_mcp_local_write_tool_definitions() -> Vec<Value> {
    vec![
        serde_json::json!({"name":"create_task",                          "description":"Create a new local task-workbench task. Validates all fields strictly. Does not write external systems.","readOnly":false}),
        serde_json::json!({"name":"create_test_task",                     "description":"Create a clearly marked temporary local task for MCP smoke testing. Returns the new task id.","readOnly":false}),
        serde_json::json!({"name":"delete_test_task",                     "description":"Delete a task previously created by create_test_task. Only works on tasks with mcpTestTask=true. Cannot delete real tasks.","readOnly":false}),
        serde_json::json!({"name":"append_task_note",                    "description":"Append a sanitized local note to task.notes.","readOnly":false}),
        serde_json::json!({"name":"set_task_status",                     "description":"Set task status to a validated local enum value.","readOnly":false}),
        serde_json::json!({"name":"set_task_attention_state",            "description":"Set task attentionState to a validated local enum value or null.","readOnly":false}),
        serde_json::json!({"name":"set_task_waiting_state",              "description":"Set task waitingState to a validated local enum value or null.","readOnly":false}),
        serde_json::json!({"name":"save_task_analysis",                  "description":"Save local AI analysis: summary, requirements, assumptions, questions, risks, next step. Does not modify external systems.","readOnly":false}),
        serde_json::json!({"name":"update_task_summary",                 "description":"Update only the task summary and optional next-step text. Does not overwrite other analysis fields.","readOnly":false}),
        serde_json::json!({"name":"set_task_mode",                       "description":"Set task mode: developer or general.","readOnly":false}),
        serde_json::json!({"name":"set_task_work_classification",        "description":"Set work kind (plugin/script/ribbon/repo-only/bugfix/review/general/unknown) and work action. Strict enum validation.","readOnly":false}),
        serde_json::json!({"name":"set_task_developer_target",           "description":"Set developer target: repository root, plugin project, script path, or customer. Does not scan or write any repository files.","readOnly":false}),
        serde_json::json!({"name":"prepare_developer_task",              "description":"Safe high-level orchestration: apply templates/defaults, derive developer target, draft a technical plan, and stop at the first approval gate or hard blocker. No code, repo, or external writes.","readOnly":false}),
        serde_json::json!({"name":"confirm_task_setup",                  "description":"Record local setup confirmation timestamp. Advances status from new to analyzed.","readOnly":false}),
        serde_json::json!({"name":"set_task_phase",                      "description":"Set task phase: new/analyzed/development/testing/review/done. Maps to internal status+waitingState model.","readOnly":false}),
        serde_json::json!({"name":"record_local_test",                   "description":"Record local test result: not-started/passed/failed/not-needed. Updates checklist only.","readOnly":false}),
        serde_json::json!({"name":"record_consultant_testing",           "description":"Record consultant testing status: requested/confirmed/failed/not-needed. Updates local workflow state only.","readOnly":false}),
        serde_json::json!({"name":"set_task_estimate",                   "description":"Set task effort estimate in hours with optional budget note. Validates positive numeric input.","readOnly":false}),
        serde_json::json!({"name":"save_technical_plan",                 "description":"Save local technical plan draft: summary, steps, entities, test plan, risks. Does not write code or register anything.","readOnly":false}),
        serde_json::json!({"name":"mark_technical_plan_ready_for_approval","description":"Mark saved technical plan as ready for user review. Requires save_technical_plan to have been called first.","readOnly":false}),
        serde_json::json!({"name":"record_manual_pr",                    "description":"Record a pull request created manually outside task-workbench. Local tracking only â€” does not call GitHub or Azure DevOps.","readOnly":false}),
        serde_json::json!({"name":"save_pr_review_analysis",             "description":"Save local PR review analysis: summary, action items, warnings. Does not reply to or resolve PR comments.","readOnly":false}),
        serde_json::json!({"name":"save_pr_fix_proposal",                "description":"Save local PR fix proposal: summary and proposed changes. Does not edit files, commit, or push.","readOnly":false}),
        serde_json::json!({"name":"update_task_checklist_item",          "description":"Set status of a local workflow checklist item. Strict key and status enum validation.","readOnly":false}),
        serde_json::json!({"name":"set_task_next_step",                  "description":"Set the AI-recommended next action and reason. Does not overwrite analysis or plan.","readOnly":false}),
        serde_json::json!({"name":"create_branch_for_task",              "description":"This modifies the local Git repository by creating and switching to a new branch. Creates a local branch only â€” no commit, no push, no PR, no GitHub/Azure DevOps API calls.","readOnly":false}),
        serde_json::json!({"name":"commit_task_changes",                 "description":"WRITE â€” stages the specified files and creates a Git commit in the task repository. Does NOT push. Use push_task_branch or commit_and_push_task_changes to push afterwards.","readOnly":false}),
        serde_json::json!({"name":"push_task_branch",                    "description":"WRITE â€” pushes the current branch of the task repository to origin. Push to main/master is blocked. No force push.","readOnly":false}),
        serde_json::json!({"name":"commit_and_push_task_changes",        "description":"WRITE â€” stages files, creates a Git commit, and pushes the current branch in one step. No PR creation. Set moveToReviewAfterPush=true to also move the task to Code Review / Waiting for code review.","readOnly":false}),
        serde_json::json!({"name":"mark_testing_confirmed_prepare_commit","description":"WRITE (local task state only) â€” marks consultant testing as confirmed and sets the next step to Prepare commit and push. Does NOT commit, push, or move the task to Code Review.","readOnly":false}),
        serde_json::json!({"name":"record_external_action_completed",     "description":"WRITE (local task state only) â€” records that the developer manually completed an external action (plugin registration, web resource upload, etc.). Does not call any external system.","readOnly":false}),
    ]
}

fn task_mcp_tool_definitions() -> Vec<Value> {
    let mut tools = task_mcp_read_only_tool_definitions();
    tools.extend(task_mcp_local_write_tool_definitions());
    tools
}

fn task_mcp_strip_html(value: &str) -> String {
    let mut text = value
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("\r\n", "\n");

    while let Some(start) = text.find('<') {
        if let Some(end_rel) = text[start..].find('>') {
            let end = start + end_rel;
            text.replace_range(start..=end, " ");
        } else {
            break;
        }
    }

    text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn task_mcp_summarize(value: Option<&str>, max_len: usize) -> String {
    let clean = task_mcp_strip_html(value.unwrap_or(""));
    if clean.len() <= max_len {
        return clean;
    }
    format!("{}...", clean.chars().take(max_len.saturating_sub(3)).collect::<String>())
}

fn task_mcp_is_developer_task(task: &Value) -> bool {
    task["taskMode"].as_str() == Some("developer")
        || task.get("crmDeveloperWorkflow").is_some()
        || task.get("workflowSetup").is_some()
        || task
            .get("crmVerificationReports")
            .and_then(|v| v.as_array())
            .is_some_and(|arr| !arr.is_empty())
}

fn task_mcp_latest_verification(task: &Value) -> Value {
    let reports = task["crmVerificationReports"].as_array().cloned().unwrap_or_default();
    if reports.is_empty() {
        return serde_json::json!({
            "exists": false,
            "verdict": "missing",
            "summary": "No CRM metadata verification report is stored for this task.",
        });
    }

    let report = &reports[0];
    serde_json::json!({
        "exists": true,
        "verdict": report["verdict"].as_str().or(report["status"].as_str()).unwrap_or("unknown"),
        "createdAt": report["createdAt"].as_str().or(report["generatedAt"].as_str()),
        "summary": task_mcp_summarize(report["summary"].as_str().or(report["message"].as_str()), TASK_MCP_MAX_SUMMARY_LENGTH),
        "issueCount": report["issues"].as_array().map(|a| a.len()).or(report["issueCount"].as_u64().map(|n| n as usize)),
        "inspectedEntityCount": report["inspectedEntities"].as_array().map(|a| a.len()).or(report["inspectedEntityCount"].as_u64().map(|n| n as usize)),
    })
}

fn task_mcp_approval_summary(gate: Option<&Value>) -> Value {
    let gate = gate.unwrap_or(&Value::Null);
    serde_json::json!({
        "approved": gate["approved"].as_bool().unwrap_or(false) && gate["invalidatedAt"].is_null(),
        "approvedAt": gate["approvedAt"].as_str(),
        "invalidatedAt": gate["invalidatedAt"].as_str(),
        "invalidationReason": gate["invalidationReason"].as_str(),
    })
}

fn task_mcp_safe_task_summary(task: &Value) -> Value {
    let analysis = task.get("analysisResult").unwrap_or(&Value::Null);
    let workflow = task.get("crmDeveloperWorkflow").unwrap_or(&Value::Null);
    let summary_source = analysis["summaryEn"]
        .as_str()
        .or(analysis["summary"].as_str())
        .or(task["title"].as_str());

    let mut result = serde_json::json!({
        "id": task["id"].as_str().unwrap_or(""),
        "title": task["title"].as_str().unwrap_or(""),
        "source": task["source"].as_str(),
        "taskType": task["taskType"].as_str(),
        "status": task["status"].as_str(),
        "customerId": task["customerId"].as_str(),
        "receivedAt": task["receivedAt"].as_str(),
        "dueAt": task["dueAt"].as_str(),
        "classificationState": task["classificationState"].as_str(),
        "taskMode": task["taskMode"].as_str(),
        "developerWorkflowTask": task_mcp_is_developer_task(task),
        "summary": task_mcp_summarize(summary_source, TASK_MCP_MAX_SUMMARY_LENGTH),
        "attentionState": task["attentionState"].as_str(),
        "waitingState": task["waitingState"].as_str(),
    });

    if workflow["currentStep"].is_string() || workflow["detectedWorkKind"].is_string() {
        result["crmWorkflow"] = serde_json::json!({
            "detectedWorkKind": workflow["detectedWorkKind"].as_str(),
            "currentStep": workflow["currentStep"].as_str(),
            "updatedAt": workflow["updatedAt"].as_str(),
        });
    }

    result
}

fn task_mcp_sanitize_comments(comments: Option<&Value>) -> Vec<Value> {
    comments
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .take(50)
        .map(|comment| {
            serde_json::json!({
                "id": comment["id"].as_str(),
                "author": comment["author"].as_str(),
                "body": task_mcp_summarize(comment["body"].as_str(), 900),
                "filePath": comment["filePath"].as_str(),
                "line": comment["line"].as_i64(),
                "isResolved": comment["isResolved"].as_bool(),
                "createdAt": comment["createdAt"].as_str(),
            })
        })
        .collect()
}

fn task_mcp_pull_request_state(workflow: &Value) -> Value {
    let proposal = workflow["pullRequestProposal"].clone();
    let tracking = workflow["pullRequestTracking"].clone();
    let review = workflow["pullRequestReview"].clone();
    let analysis = workflow["pullRequestReviewAnalysis"].clone();
    let fix_proposal = workflow["pullRequestFixProposal"].clone();
    let fix_update_tracking = workflow["pullRequestFixUpdateTracking"].clone();

    serde_json::json!({
        "proposal": if proposal.is_object() {
            serde_json::json!({
                "generatedAt": proposal["generatedAt"].as_str(),
                "title": proposal["title"].as_str(),
                "bodySummary": task_mcp_summarize(proposal["body"].as_str(), TASK_MCP_MAX_SUMMARY_LENGTH),
                "checklist": proposal["checklist"].as_array().cloned().unwrap_or_default(),
                "warnings": proposal["warnings"].as_array().cloned().unwrap_or_default(),
                "relatedArtifactPath": proposal["relatedArtifactPath"].as_str(),
                "sourceSummary": task_mcp_summarize(proposal["sourceSummary"].as_str(), 400),
                "invalidatedAt": proposal["invalidatedAt"].as_str(),
                "invalidationReason": proposal["invalidationReason"].as_str(),
            })
        } else { Value::Null },
        "tracking": if tracking.is_object() {
            serde_json::json!({
                "createdManually": tracking["createdManually"].as_bool().unwrap_or(false) && tracking["invalidatedAt"].is_null(),
                "createdAt": tracking["createdAt"].as_str(),
                "prUrl": tracking["prUrl"].as_str(),
                "notes": task_mcp_summarize(tracking["notes"].as_str(), 400),
                "invalidatedAt": tracking["invalidatedAt"].as_str(),
                "invalidationReason": tracking["invalidationReason"].as_str(),
            })
        } else { Value::Null },
        "review": if review.is_object() {
            serde_json::json!({
                "fetchedAt": review["fetchedAt"].as_str(),
                "provider": review["provider"].as_str(),
                "prUrl": review["prUrl"].as_str(),
                "title": review["title"].as_str(),
                "state": review["state"].as_str(),
                "author": review["author"].as_str(),
                "baseBranch": review["baseBranch"].as_str(),
                "headBranch": review["headBranch"].as_str(),
                "comments": task_mcp_sanitize_comments(Some(&review["comments"])),
                "unresolvedCount": review["unresolvedCount"].as_i64(),
                "attentionRequired": review["attentionRequired"].as_bool(),
                "summary": task_mcp_summarize(review["summary"].as_str(), TASK_MCP_MAX_SUMMARY_LENGTH),
                "warnings": review["warnings"].as_array().cloned().unwrap_or_default(),
                "error": task_mcp_summarize(review["error"].as_str(), 400),
                "invalidatedAt": review["invalidatedAt"].as_str(),
                "invalidationReason": review["invalidationReason"].as_str(),
            })
        } else { Value::Null },
        "analysis": if analysis.is_object() {
            serde_json::json!({
                "generatedAt": analysis["generatedAt"].as_str(),
                "sourceReviewFetchedAt": analysis["sourceReviewFetchedAt"].as_str(),
                "attentionRequired": analysis["attentionRequired"].as_bool(),
                "summary": task_mcp_summarize(analysis["summary"].as_str(), TASK_MCP_MAX_SUMMARY_LENGTH),
                "groupedFindings": analysis["groupedFindings"].as_array().cloned().unwrap_or_default(),
                "actionItems": analysis["actionItems"].as_array().cloned().unwrap_or_default(),
                "testChecklist": analysis["testChecklist"].as_array().cloned().unwrap_or_default(),
                "warnings": analysis["warnings"].as_array().cloned().unwrap_or_default(),
                "limitations": analysis["limitations"].as_array().cloned().unwrap_or_default(),
                "invalidatedAt": analysis["invalidatedAt"].as_str(),
                "invalidationReason": analysis["invalidationReason"].as_str(),
            })
        } else { Value::Null },
        "fixProposal": fix_proposal,
        "fixUpdateTracking": fix_update_tracking,
    })
}

fn task_mcp_safe_crm_workflow_state(task: &Value) -> Value {
    let workflow = task.get("crmDeveloperWorkflow").unwrap_or(&Value::Null);
    if !workflow.is_object() {
        return Value::Null;
    }

    serde_json::json!({
        "detectedWorkKind": workflow["detectedWorkKind"].as_str(),
        "currentStep": workflow["currentStep"].as_str(),
        "createdAt": workflow["createdAt"].as_str(),
        "updatedAt": workflow["updatedAt"].as_str(),
        "approvals": {
            "plan": task_mcp_approval_summary(workflow.get("planApproval")),
            "diff": task_mcp_approval_summary(workflow.get("diffApproval")),
            "externalAction": task_mcp_approval_summary(workflow.get("externalActionApproval")),
            "pullRequest": task_mcp_approval_summary(workflow.get("pullRequestApproval")),
        },
        "technicalPlan": workflow["technicalPlan"].clone(),
        "externalExecution": workflow["externalExecution"].clone(),
        "pullRequest": task_mcp_pull_request_state(workflow),
    })
}

fn task_mcp_safe_task_detail(task: &Value) -> Value {
    let mut detail = task_mcp_safe_task_summary(task);
    detail["analysis"] = serde_json::json!({
        "summary": task_mcp_summarize(task["analysisResult"]["summaryEn"].as_str().or(task["analysisResult"]["summary"].as_str()), TASK_MCP_MAX_SUMMARY_LENGTH),
        "nextStep": task_mcp_summarize(task["analysisResult"]["nextStepEn"].as_str().or(task["analysisResult"]["nextStep"].as_str()), 300),
        "confidence": task["analysisResult"]["confidence"].as_f64(),
        "problemPoints": task["analysisResult"]["problemPointsEn"].as_array().cloned().or(task["analysisResult"]["problemPoints"].as_array().cloned()),
        "suggestedActions": task["analysisResult"]["suggestedActions"].as_array().cloned().unwrap_or_default(),
    });
    detail["workflowSetup"] = task["workflowSetup"].clone();
    detail["latestCrmVerification"] = task_mcp_latest_verification(task);
    detail["crmWorkflowState"] = task_mcp_safe_crm_workflow_state(task);
    detail["adoContext"] = serde_json::json!({
        "type": task["adoContext"]["type"].as_str(),
        "project": task["adoContext"]["project"].as_str(),
        "workItemId": task["adoContext"]["workItemId"].as_str(),
        "pullRequestId": task["adoContext"]["pullRequestId"].as_str(),
        "repository": task["adoContext"]["repository"].as_str(),
        "branch": task["adoContext"]["branch"].as_str(),
        "url": task["adoContext"]["url"].as_str(),
    });
    detail
}

fn task_mcp_allowed_statuses() -> &'static [&'static str] {
    &["new", "analyzed", "in-progress", "ready-for-review", "done", "blocked"]
}

fn task_mcp_allowed_waiting_states() -> &'static [&'static str] {
    &["pricing-approval", "code-review", "consultant-testing"]
}

fn task_mcp_allowed_attention_states() -> &'static [&'static str] {
    &["pr-comments"]
}

fn task_mcp_allowed_phases() -> &'static [&'static str] {
    &["new", "analyzed", "development", "testing", "review", "done"]
}

fn task_mcp_allowed_modes() -> &'static [&'static str] {
    &["developer", "general"]
}

fn task_mcp_allowed_work_kinds() -> &'static [&'static str] {
    &["plugin", "script", "ribbon", "repo-only", "bugfix", "review", "general", "unknown"]
}

fn task_mcp_allowed_external_action_types() -> &'static [&'static str] {
    &["plugin-registration", "web-resource-upload", "publish-customizations", "pull-request", "manual-check"]
}

fn task_mcp_allowed_work_actions() -> &'static [&'static str] {
    &["create", "update", "unknown"]
}

fn task_mcp_allowed_local_test_statuses() -> &'static [&'static str] {
    &["not-started", "passed", "failed", "not-needed"]
}

fn task_mcp_allowed_consultant_test_statuses() -> &'static [&'static str] {
    &["requested", "confirmed", "failed", "not-needed"]
}

fn task_mcp_allowed_checklist_keys() -> &'static [&'static str] {
    &[
        "task-analyzed", "setup-confirmed", "crm-metadata-verified",
        "technical-plan-ready", "implementation-done", "local-test-done",
        "consultant-testing", "pull-request", "code-review", "done",
    ]
}

fn task_mcp_allowed_checklist_statuses() -> &'static [&'static str] {
    &["done", "not-done", "warning", "blocked", "optional"]
}

fn task_mcp_allowed_create_sources() -> &'static [&'static str] {
    &["manual", "email", "teams", "mcp", "devops"]
}

fn task_mcp_allowed_create_task_types() -> &'static [&'static str] {
    &["bug-fix", "bug", "feature", "review", "question", "deployment", "other"]
}

/// Generates a UUID v4 string using the existing `rand` crate (no extra dependencies).
fn task_mcp_generate_id() -> String {
    use rand::Rng;
    let bytes: [u8; 16] = rand::thread_rng().gen();
    let b6 = (bytes[6] & 0x0f) | 0x40; // version 4
    let b8 = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        b6, bytes[7],
        b8, bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

/// Maps task status + waitingState to the human-readable display phase.
fn task_mcp_display_phase(task: &Value) -> &'static str {
    if task["waitingState"].as_str() == Some("consultant-testing") {
        return "testing";
    }
    match task["status"].as_str().unwrap_or("new") {
        "in-progress"      => "development",
        "ready-for-review" => "review",
        "new"              => "new",
        "analyzed"         => "analyzed",
        "done"             => "done",
        "blocked"          => "blocked",
        _                  => "new",
    }
}

/// Sanitizes a JSON array of strings into a Vec<Value>, applying length/count limits.
fn task_mcp_collect_string_array(value: &Value, max_count: usize, max_len: usize) -> Vec<Value> {
    let Some(arr) = value.as_array() else { return vec![]; };
    arr.iter()
        .take(max_count)
        .filter_map(|v| v.as_str())
        .map(|s| task_mcp_normalize_small_text(s, max_len))
        .filter(|s| !s.is_empty())
        .map(Value::String)
        .collect()
}

/// Returns the MCP override status for a checklist key, or None if not overridden.
fn task_mcp_checklist_override(task: &Value, key: &str) -> Option<String> {
    task.get("mcpChecklistOverrides")
        .and_then(|v| v.get(key))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Builds a checklist JSON array mirroring TypeScript buildWorkflowChecklist.
fn task_mcp_workflow_checklist(task: &Value) -> Vec<Value> {
    let wf = task.get("crmDeveloperWorkflow").unwrap_or(&Value::Null);
    let ver = task.get("crmVerificationReports")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first());
    let ver_verdict  = ver.and_then(|v| v["verdict"].as_str()).unwrap_or("none");
    let ver_ok       = matches!(ver_verdict, "pass" | "warnings");
    let ver_fail     = ver_verdict == "fail";

    let plan_approved = wf["planApproval"]["approved"].as_bool().unwrap_or(false)
        && wf["planApproval"]["invalidatedAt"].is_null();
    let diff_approved = wf["diffApproval"]["approved"].as_bool().unwrap_or(false)
        && wf["diffApproval"]["invalidatedAt"].is_null();
    let consultant_done = (wf["externalExecution"]["completed"].as_bool().unwrap_or(false)
        && wf["externalExecution"]["invalidatedAt"].is_null())
        || task.get("consultantTestRecord")
            .and_then(|v| v["status"].as_str()) == Some("confirmed");
    let pr_tracked   = wf["pullRequestTracking"]["createdManually"].as_bool().unwrap_or(false)
        && wf["pullRequestTracking"]["invalidatedAt"].is_null();
    let review_done  = !wf["pullRequestReview"].is_null()
        && wf["pullRequestReview"]["invalidatedAt"].is_null();
    let review_needs_attention = wf["pullRequestReview"]["attentionRequired"].as_bool().unwrap_or(false);

    let status  = task["status"].as_str().unwrap_or("new");
    let waiting = task["waitingState"].as_str().unwrap_or("");
    let is_in_progress = status == "in-progress";
    let is_testing     = waiting == "consultant-testing";
    let is_review      = status == "ready-for-review";
    let is_done        = status == "done";
    let has_analysis   = !task["analysisResult"].is_null() || status != "new";
    let setup_confirmed = task.get("workflowSetup")
        .map_or(false, |ws| !ws["confirmedAt"].is_null());

    let local_test_status = task.get("localTestRecord")
        .and_then(|v| v["status"].as_str()).unwrap_or("");
    let consultant_not_needed = task.get("consultantTestRecord")
        .and_then(|v| v["status"].as_str()) == Some("not-needed");

    // Helper: override if set, else return default
    macro_rules! ov {
        ($key:expr, $default:expr) => {
            task_mcp_checklist_override(task, $key).unwrap_or_else(|| $default.to_string())
        };
    }

    let analyzed   = ov!("task-analyzed",         if has_analysis   { "done" } else { "pending" });
    let setup      = ov!("setup-confirmed",        if setup_confirmed{ "done" } else { "pending" });
    let crm_ver    = ov!("crm-metadata-verified",  if ver_fail { "warning" } else if ver_ok { "done" } else { "pending" });
    let tech_plan  = ov!("technical-plan-ready",   if plan_approved { "done" } else if !wf["technicalPlan"].is_null() { "partial" } else { "pending" });
    let impl_done  = ov!("implementation-done",    if diff_approved { "done" } else if is_in_progress && !is_testing { "active" } else { "pending" });
    let local_test = ov!("local-test-done",        match local_test_status { "passed" => "done", "failed" => "warning", "not-needed" => "optional", _ => "pending" });
    let consultant = ov!("consultant-testing",     if consultant_done { "done" } else if is_testing { "active" } else if consultant_not_needed { "optional" } else { "skip" });
    let pr         = ov!("pull-request",           if pr_tracked { "done" } else if is_review { "active" } else { "pending" });
    let review     = ov!("code-review",            if review_done { if review_needs_attention { "warning" } else { "done" } } else { "pending" });
    let done       = ov!("done",                   if is_done { "done" } else { "pending" });

    vec![
        serde_json::json!({"key":"task-analyzed",        "label":"Task analyzed",       "status": analyzed}),
        serde_json::json!({"key":"setup-confirmed",      "label":"Setup confirmed",     "status": setup}),
        serde_json::json!({"key":"crm-metadata-verified","label":"CRM metadata verified","status": crm_ver}),
        serde_json::json!({"key":"technical-plan-ready", "label":"Technical plan ready","status": tech_plan}),
        serde_json::json!({"key":"implementation-done",  "label":"Implementation done", "status": impl_done}),
        serde_json::json!({"key":"local-test-done",      "label":"Local test",          "status": local_test}),
        serde_json::json!({"key":"consultant-testing",   "label":"Consultant testing",  "status": consultant}),
        serde_json::json!({"key":"pull-request",         "label":"Pull request",        "status": pr}),
        serde_json::json!({"key":"code-review",          "label":"Code review",         "status": review}),
        serde_json::json!({"key":"done",                 "label":"Done",                "status": done}),
    ]
}

fn task_mcp_normalize_small_text(input: &str, max_len: usize) -> String {
    task_mcp_strip_html(input)
        .chars()
        .take(max_len)
        .collect::<String>()
        .trim()
        .to_string()
}

fn task_mcp_append_audit_note(task: &mut Value, action: &str) {
    let when = chrono_now_iso();
    let line = format!("[{when}] MCP local write: {action}");
    let existing = task["notes"].as_str().unwrap_or("").trim();
    let next = if existing.is_empty() {
        line
    } else {
        format!("{existing}\n{line}")
    };
    task["notes"] = Value::String(next);
}

fn task_mcp_find_task_index(tasks: &[Value], task_id: &str) -> Option<usize> {
    tasks.iter().position(|task| task["id"].as_str().unwrap_or("") == task_id)
}

fn task_mcp_load_tasks(app: &tauri::AppHandle) -> Result<Vec<Value>, String> {
    let path = app_data_dir(app)?.join("tasks.json");
    let value = read_json(&path)?;
    if value.is_null() {
        return Ok(vec![]);
    }
    value
        .as_array()
        .cloned()
        .ok_or_else(|| "tasks.json must contain a JSON array.".to_string())
}

fn task_mcp_save_tasks(app: &tauri::AppHandle, tasks: &[Value]) -> Result<(), String> {
    let path = app_data_dir(app)?.join("tasks.json");
    write_json(&path, &Value::Array(tasks.to_vec()))
}

fn task_mcp_get_task<'a>(tasks: &'a [Value], task_id: &str) -> Option<&'a Value> {
    tasks.iter().find(|task| task["id"].as_str().unwrap_or("") == task_id)
}

fn task_mcp_next_recommended_step(task: &Value) -> Value {
    if !task_mcp_is_developer_task(task) {
        return serde_json::json!({
            "step": "none",
            "attentionRequired": false,
            "reason": "This does not appear to be a CRM developer workflow task.",
        });
    }

    let workflow = task.get("crmDeveloperWorkflow").unwrap_or(&Value::Null);
    if !workflow.is_object() {
        return serde_json::json!({
            "step": "diagnosis",
            "attentionRequired": true,
            "reason": "Open the task in task-workbench and save the local CRM workflow diagnosis state.",
        });
    }

    if workflow["technicalPlan"].is_null() {
        return serde_json::json!({
            "step": "technical-plan",
            "attentionRequired": true,
            "reason": "Generate a deterministic local technical implementation plan.",
        });
    }

    let current = workflow["currentStep"].as_str().unwrap_or("diagnosis");
    serde_json::json!({
        "step": current,
        "attentionRequired": true,
        "reason": "Continue the current local CRM workflow step.",
    })
}

fn task_mcp_implementation_readiness(task: &Value) -> Value {
    let mode = task["taskMode"].as_str().unwrap_or("");
    if mode != "developer" {
        return serde_json::json!({
            "isImplementationReady": false,
            "blockers": ["Task mode is not set to Developer."],
            "warnings": [],
            "recommendedNextStep": "Set task mode to Developer.",
        });
    }

    let setup    = task.get("workflowSetup").unwrap_or(&Value::Null);
    let workflow = task.get("crmDeveloperWorkflow").unwrap_or(&Value::Null);
    let detected = workflow["detectedWorkKind"].as_str().unwrap_or("");
    let dev_kind = setup["devTargetKind"].as_str().unwrap_or("");

    let is_plugin = dev_kind == "plugin" || detected == "plugin";
    let is_script = dev_kind == "script" || detected == "script" || detected == "ribbon";

    if !is_plugin && !is_script {
        let title    = task["title"].as_str().unwrap_or("").to_lowercase();
        let original = task["originalMessage"].as_str().unwrap_or("").to_lowercase();
        let label    = task["classificationLabel"].as_str().unwrap_or("").to_lowercase();
        let corpus   = format!("{} {} {}", title, original, label);
        let looks_script = corpus.contains("javascript") || corpus.contains("form script")
            || corpus.contains("web resource") || corpus.contains("jscript")
            || corpus.contains("on load") || corpus.contains("onload")
            || corpus.contains("on save") || corpus.contains("onsave")
            || corpus.contains("field change") || corpus.contains("column change")
            || corpus.contains("onchange");
        let warnings_val: Vec<&str> = if looks_script {
            vec!["Task text mentions JavaScript/form scripts. Consider classifying this task as script work kind."]
        } else {
            vec![]
        };
        let next_step = if looks_script {
            "Set work classification to script (JavaScript form script indicators found in task text)."
        } else {
            "Set work classification to plugin or script via Set Work Classification."
        };
        return serde_json::json!({
            "isImplementationReady": false,
            "blockers": ["Work kind must be plugin or script."],
            "warnings": warnings_val,
            "recommendedNextStep": next_step,
        });
    }

    let mut blockers: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    let customer = setup["customerId"].as_str().or(task["customerId"].as_str()).unwrap_or("");
    if customer.is_empty() { blockers.push("Customer/environment is not set.".into()); }

    if setup["repositoryRoot"].as_str().unwrap_or("").is_empty() {
        blockers.push("Repository root is not set.".into());
    }
    if setup["confirmedAt"].as_str().unwrap_or("").is_empty() {
        blockers.push("Developer setup has not been confirmed.".into());
    }

    let has_plan = workflow.get("technicalPlan").map(|p| p.is_object()).unwrap_or(false);
    if !has_plan { blockers.push("Technical implementation plan is missing.".into()); }

    let latest_verdict = task.get("crmVerificationReports")
        .and_then(|r| r.as_array())
        .and_then(|arr| arr.first())
        .and_then(|r| r["verdict"].as_str())
        .unwrap_or("");
    let dv_check = task.get("implementationVerification")
        .and_then(|v| v.get("dataverseCheck"))
        .unwrap_or(&Value::Null);
    let dv_satisfied = matches!(latest_verdict, "pass" | "warnings" | "fail")
        || !dv_check["skippedAt"].is_null()
        || !dv_check["manuallyVerifiedAt"].is_null()
        || dv_check["status"].as_str().map(|s| s == "skipped" || s == "manually-verified").unwrap_or(false);

    if !dv_satisfied {
        if is_script {
            warnings.push("Dataverse metadata verification for JS/TS is not available through MCP. Use the in-app Verify Implementation modal after implementation/upload.".into());
        } else {
            blockers.push("Dataverse metadata verification has not been completed or explicitly skipped.".into());
        }
    } else {
        if latest_verdict == "warnings" { warnings.push("Dataverse verification completed with warnings. Review before implementing.".into()); }
        if latest_verdict == "fail"     { warnings.push("Dataverse verification found issues. Ensure they are accounted for in the technical plan.".into()); }
    }

    let plan_target = if has_plan {
        workflow.get("technicalPlan").and_then(|p| p.get("target")).unwrap_or(&Value::Null)
    } else {
        &Value::Null
    };

    if is_plugin {
        let plugin_project = setup["pluginProject"].as_str()
            .or(task["selectedPluginProject"].as_str())
            .or(plan_target["pluginProject"].as_str())
            .unwrap_or("");
        if plugin_project.is_empty() { blockers.push("Plugin project is not selected.".into()); }

        let entity = setup["primaryEntityLogicalName"].as_str()
            .or(plan_target["entityLogicalName"].as_str())
            .unwrap_or("");
        if entity.is_empty() { blockers.push("Target entity logical name is not set.".into()); }

        if has_plan {
            let mut missing: Vec<&str> = Vec::new();
            if plan_target["message"].as_str().unwrap_or("").is_empty() { missing.push("message"); }
            if plan_target["stage"].as_str().unwrap_or("").is_empty()   { missing.push("stage"); }
            if plan_target["mode"].as_str().unwrap_or("").is_empty()    { missing.push("mode"); }
            if !missing.is_empty() {
                blockers.push(format!("Plugin registration details are incomplete: {} not specified in technical plan.", missing.join(", ")));
            }
        }
    }

    if is_script {
        let artifact   = setup["artifactPath"].as_str().unwrap_or("");
        let setup_path = setup["scriptPath"].as_str().unwrap_or("");
        let plan_path  = plan_target["scriptPath"].as_str().unwrap_or("");
        let target_path = if !artifact.is_empty() { artifact }
                          else if !setup_path.is_empty() { setup_path }
                          else { plan_path };

        if target_path.is_empty() {
            blockers.push("Target script/artifact path is not set.".into());
        } else {
            let action_type = setup["actionType"].as_str().unwrap_or("");
            let is_specific = |p: &str| -> bool {
                p.ends_with(".js") || p.ends_with(".ts") || p.ends_with(".jsx") || p.ends_with(".tsx")
            };

            if action_type == "create-new-script" {
                let has_dir      = !setup_path.is_empty() || !plan_path.is_empty();
                let desired_file = setup["desiredScriptFile"].as_str().unwrap_or("");
                let has_filename = !artifact.is_empty() || is_specific(setup_path) || is_specific(plan_path) || !desired_file.is_empty();
                if !has_dir || !has_filename {
                    blockers.push("Script creation requires a known target directory and file name. Set script path and desired file name.".into());
                }
            } else if action_type == "update-existing-script" {
                let has_specific = !artifact.is_empty() || is_specific(setup_path) || is_specific(plan_path);
                if !has_specific {
                    blockers.push("Script update requires a specific existing file path. Set script path to an existing .js file.".into());
                }
            }
        }

        let entity = setup["primaryEntityLogicalName"].as_str()
            .or(plan_target["entityLogicalName"].as_str())
            .unwrap_or("");
        if entity.is_empty() { blockers.push("Target entity logical name (table) is not set.".into()); }

        if has_plan {
            let has_form_event = !plan_target["formName"].as_str().unwrap_or("").is_empty()
                || !plan_target["eventName"].as_str().unwrap_or("").is_empty()
                || !plan_target["eventFieldName"].as_str().unwrap_or("").is_empty()
                || !plan_target["functionName"].as_str().unwrap_or("").is_empty();
            let manual_later = setup["scriptFormRegistration"].as_str()
                .map(|s| s == "manual-later").unwrap_or(false);
            if !has_form_event && !manual_later {
                blockers.push("Form/event registration details are not set. Add form name, event name, or mark as manual registration later.".into());
            }
        }
    }

    let is_ready = blockers.is_empty();
    let recommended: String = if is_ready {
        if !warnings.is_empty() { "Review warnings, then proceed with code generation.".into() }
        else                    { "Ready for code generation.".into() }
    } else {
        let first = blockers.first().map(|s| s.as_str()).unwrap_or("");
        if      first.contains("Customer")                    { "Set customer/environment for this task.".into() }
        else if first.contains("Repository root")             { "Set repository root via Developer Target Setup.".into() }
        else if first.contains("setup has not been confirmed"){ "Complete and confirm the developer setup.".into() }
        else if first.contains("Technical implementation")    { "Generate a technical implementation plan.".into() }
        else if first.contains("Dataverse metadata")          { "Run Dataverse metadata verification or mark it as not required.".into() }
        else if first.contains("Plugin project")              { "Select the plugin project.".into() }
        else if first.contains("Target entity")               { "Specify the target entity logical name in the technical plan.".into() }
        else if first.contains("Plugin registration")         { "Specify message, stage, and execution mode in the technical plan.".into() }
        else if first.contains("Script creation requires")    { "Set target directory and file name for script creation in Developer Target Setup.".into() }
        else if first.contains("Script update requires")      { "Set the existing script file path in Developer Target Setup.".into() }
        else if first.contains("Target script")               { "Set the target script path via Developer Target Setup.".into() }
        else if first.contains("Form/event")                  { "Add form/event details to the technical plan, or mark form registration as manual-later.".into() }
        else                                                  { "Resolve all blockers before proceeding with implementation.".into() }
    };

    serde_json::json!({
        "isImplementationReady": is_ready,
        "blockers": blockers,
        "warnings": warnings,
        "recommendedNextStep": recommended,
    })
}

fn task_mcp_builtin_templates() -> Vec<Value> {
    vec![
        serde_json::json!({
            "id": "nvr-training-sh-script-prefill",
            "name": "NVR Training Service Hub â€” Script: PĹ™edvyplnÄ›nĂ­ servisnĂ­ho poĹľadavku",
            "titlePattern": "Script: PĹ™edvyplnÄ›nĂ­ servisnĂ­ho poĹľadavku",
            "mode": "developer",
            "workKind": "script",
            "actionType": "create-new-script",
            "targetEntity": "nvr_servicecase",
            "scriptTarget": {
                "entityLogicalName": "nvr_servicecase",
                "eventName": "onChange",
                "eventFieldName": "nvr_assetid"
            },
            "scriptNaming": {
                "namingSource": "Scripts_Naming",
                "scriptsFolderRelative": "Scripts",
                "desiredScriptFile": "nvr_servicecase_events.js",
                "onLoadFunctionName": "nvr_servicecase_OnLoad",
                "onChangeFunctionName": "nvr_assetid_OnChange",
                "mainHelperSuggestion": "prefillServiceCaseFromAsset"
            },
            "sourceEntity": "nvr_customerasset",
            "sourceFields": ["nvr_customerid", "nvr_contactid", "nvr_isunderwarranty"],
            "targetFields": ["nvr_customerid", "nvr_contactid", "nvr_iswarrantycase"],
            "additionalSourceFields": ["nvr_statuscustom"],
            "notes": "onChange on nvr_assetid. Source entity: nvr_customerasset. Copy nvr_customerid, nvr_contactid, nvr_isunderwarranty to nvr_servicecase fields nvr_customerid, nvr_contactid, nvr_iswarrantycase. Additional source field available: nvr_statuscustom. Solution: NVRTrainingServiceHubCore. App: nvr_trainingservicehub."
        }),
        serde_json::json!({
            "id": "nvr-training-sh-plugin-workorderline",
            "name": "NVR Training Service Hub â€” Plugin: VĂ˝poÄŤet ÄŤĂˇstek na poloĹľce servisnĂ­ zakĂˇzky",
            "titlePattern": "Plugin: VĂ˝poÄŤet ÄŤĂˇstek na poloĹľce servisnĂ­ zakĂˇzky",
            "mode": "developer",
            "workKind": "plugin",
            "actionType": "create-new-plugin",
            "targetEntity": "nvr_workorderline",
            "pluginTarget": {
                "entityLogicalName": "nvr_workorderline",
                "messages": ["Create", "Update"],
                "stage": "PreOperation",
                "mode": "Sync",
                "filteringAttributes": ["nvr_quantity", "nvr_unitprice", "nvr_discountpercent", "nvr_vatpercent"]
            },
            "notes": "Compute nvr_netamount, nvr_vatamount, nvr_totalamount from input fields nvr_quantity, nvr_unitprice, nvr_discountpercent, nvr_vatpercent."
        }),
    ]
}

fn task_mcp_match_template(title: &str) -> Option<Value> {
    let lower = title.to_lowercase();
    task_mcp_builtin_templates()
        .into_iter()
        .find(|tpl| tpl["titlePattern"].as_str().map(|p| lower.contains(&p.to_lowercase())).unwrap_or(false))
}

fn task_mcp_script_naming_from_template(task: &Value, template: Option<&Value>, defaults: Option<&Value>) -> Option<Value> {
    let setup = &task["workflowSetup"];
    let entity = setup["primaryEntityLogicalName"].as_str()
        .or_else(|| template.and_then(|t| t["scriptTarget"]["entityLogicalName"].as_str()))
        .or_else(|| template.and_then(|t| t["targetEntity"].as_str()))
        .filter(|s| !s.is_empty())?;
    let event_field = setup["eventFieldName"].as_str()
        .or_else(|| template.and_then(|t| t["scriptTarget"]["eventFieldName"].as_str()))
        .unwrap_or("");
    let repo_root = defaults.and_then(|d| d["repositoryRoot"].as_str()).unwrap_or("");
    let script_abs = defaults.and_then(|d| d["scriptDirectory"].as_str()).unwrap_or("");
    let desired = setup["desiredScriptFile"].as_str()
        .or_else(|| template.and_then(|t| t["scriptNaming"]["desiredScriptFile"].as_str()))
        .unwrap_or("");
    let desired = if desired.is_empty() { format!("{entity}_events.js") } else { desired.to_string() };
    let mut rel = template
        .and_then(|t| t["scriptNaming"]["scriptsFolderRelative"].as_str())
        .unwrap_or("")
        .to_string();
    if rel.is_empty() && !script_abs.is_empty() {
        if !repo_root.is_empty() && script_abs.to_lowercase().starts_with(&repo_root.to_lowercase()) {
            rel = script_abs[repo_root.len()..].trim_start_matches(|c| c == '/' || c == '\\').to_string();
        }
        if rel.is_empty() {
            rel = script_abs.replace('\\', "/").split('/').filter(|s| !s.is_empty()).last().unwrap_or("Scripts").to_string();
        }
    }
    if rel.is_empty() {
        rel = "Scripts".to_string();
    }
    let sep = if script_abs.contains('\\') || repo_root.contains('\\') { "\\" } else { "/" };
    let absolute_dir = if !script_abs.is_empty() {
        script_abs.to_string()
    } else if !repo_root.is_empty() {
        format!("{repo_root}{sep}{rel}")
    } else {
        String::new()
    };
    let on_load = setup["onLoadFunctionName"].as_str()
        .or_else(|| template.and_then(|t| t["scriptNaming"]["onLoadFunctionName"].as_str()))
        .map(str::to_string)
        .unwrap_or_else(|| format!("{entity}_OnLoad"));
    let on_change = setup["onChangeFunctionName"].as_str()
        .or_else(|| template.and_then(|t| t["scriptNaming"]["onChangeFunctionName"].as_str()))
        .map(str::to_string)
        .or_else(|| if event_field.is_empty() { None } else { Some(format!("{event_field}_OnChange")) });
    let mut value = serde_json::json!({
        "namingSource": setup["namingSource"].as_str()
            .or_else(|| template.and_then(|t| t["scriptNaming"]["namingSource"].as_str()))
            .unwrap_or("Scripts_Naming"),
        "entityLogicalName": entity,
        "desiredScriptFile": desired,
        "scriptsFolderRelative": rel,
        "scriptPath": format!("{}{}{}", rel, sep, desired),
        "absoluteScriptPath": if absolute_dir.is_empty() { Value::Null } else { serde_json::json!(format!("{}{}{}", absolute_dir, sep, desired)) },
        "onLoadFunctionName": on_load,
        "helperNamingRule": "descriptive camelCase, no nvr_ prefix by default",
    });
    if let Some(v) = on_change { value["onChangeFunctionName"] = serde_json::json!(v); }
    if let Some(v) = setup["mainHelperSuggestion"].as_str()
        .or_else(|| template.and_then(|t| t["scriptNaming"]["mainHelperSuggestion"].as_str())) {
        value["mainHelperSuggestion"] = serde_json::json!(v);
    }
    Some(value)
}

fn task_mcp_prepare_plan_draft(task: &Value, template: Option<&Value>) -> Option<Value> {
    let setup = &task["workflowSetup"];
    let workflow = &task["crmDeveloperWorkflow"];
    let work_kind = workflow["detectedWorkKind"].as_str()
        .or_else(|| setup["devTargetKind"].as_str())
        .or_else(|| template.and_then(|t| t["workKind"].as_str()))
        .unwrap_or("unknown");
    if !matches!(work_kind, "script" | "plugin" | "ribbon") { return None; }
    let entity = setup["primaryEntityLogicalName"].as_str()
        .or_else(|| template.and_then(|t| t["targetEntity"].as_str()))
        .or_else(|| template.and_then(|t| t["scriptTarget"]["entityLogicalName"].as_str()))
        .or_else(|| template.and_then(|t| t["pluginTarget"]["entityLogicalName"].as_str()))
        .filter(|s| !s.is_empty())?;
    let source_entity = template.and_then(|t| t["sourceEntity"].as_str()).unwrap_or("source");
    let source_fields: Vec<String> = template
        .and_then(|t| t["sourceFields"].as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).map(str::to_string).collect())
        .unwrap_or_default();
    let target_fields: Vec<String> = template
        .and_then(|t| t["targetFields"].as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).map(str::to_string).collect())
        .unwrap_or_default();
    let pair_count = source_fields.len().min(target_fields.len());
    let field_mappings: Vec<Value> = (0..pair_count)
        .map(|i| serde_json::json!({
            "source": format!("{}.{}", source_entity, source_fields[i]),
            "target": format!("{}.{}", entity, target_fields[i]),
        }))
        .collect();
    let mut unmapped_source_fields: Vec<String> = source_fields.iter().skip(pair_count).cloned().collect();
    if let Some(additional) = template.and_then(|t| t["additionalSourceFields"].as_array()) {
        unmapped_source_fields.extend(additional.iter().filter_map(|v| v.as_str()).map(str::to_string));
    }
    let mapping = if field_mappings.is_empty() {
        None
    } else {
        Some(format!(
            "Map template fields: {}.",
            field_mappings.iter().filter_map(|pair| {
                Some(format!("{} -> {}", pair["source"].as_str()?, pair["target"].as_str()?))
            }).collect::<Vec<_>>().join("; ")
        ))
    };
    let additional_mapping = if unmapped_source_fields.is_empty() {
        None
    } else {
        Some(format!(
            "Additional source field{} available from template: {}. No target mapping is defined.",
            if unmapped_source_fields.len() == 1 { "" } else { "s" },
            unmapped_source_fields.join(", ")
        ))
    };
    let is_script = work_kind == "script" || work_kind == "ribbon";
    let mut steps = vec![
        if is_script { format!("Use the selected script target {}.", setup["artifactPath"].as_str().or(setup["scriptPath"].as_str()).unwrap_or("the configured script path")) } else { format!("Use the selected plugin project {}.", setup["pluginProject"].as_str().unwrap_or("the configured plugin project")) },
        format!("Implement {} for {}.", setup["actionType"].as_str().or_else(|| template.and_then(|t| t["actionType"].as_str())).unwrap_or("the requested change"), entity),
        "Keep external Dataverse registration/upload as a manual approved action outside this setup step.".to_string(),
    ];
    if let Some(m) = additional_mapping.clone() { steps.insert(2, m); }
    if let Some(m) = mapping.clone() { steps.insert(2, m); }
    let target = if is_script {
        serde_json::json!({
            "entityLogicalName": entity,
            "scriptPath": setup["artifactPath"].as_str().or(setup["scriptPath"].as_str()).unwrap_or(""),
            "eventName": setup["eventName"].as_str().or_else(|| template.and_then(|t| t["scriptTarget"]["eventName"].as_str())).unwrap_or(""),
            "eventFieldName": setup["eventFieldName"].as_str().or_else(|| template.and_then(|t| t["scriptTarget"]["eventFieldName"].as_str())).unwrap_or(""),
            "functionName": setup["onChangeFunctionName"].as_str().or(setup["onLoadFunctionName"].as_str()).unwrap_or(""),
        })
    } else {
        serde_json::json!({
            "entityLogicalName": entity,
            "pluginProject": setup["pluginProject"].as_str().unwrap_or(""),
            "message": template.and_then(|t| t["pluginTarget"]["messages"].as_array()).and_then(|a| a.first()).and_then(|v| v.as_str()).unwrap_or(""),
            "stage": template.and_then(|t| t["pluginTarget"]["stage"].as_str()).unwrap_or(""),
            "mode": template.and_then(|t| t["pluginTarget"]["mode"].as_str()).unwrap_or(""),
            "filteringAttributes": template.and_then(|t| t["pluginTarget"]["filteringAttributes"].as_array()).cloned().unwrap_or_default(),
        })
    };
    let mut findings = vec![serde_json::json!(entity)];
    if let Some(m) = mapping {
        findings.push(Value::String(m));
    }
    if let Some(m) = additional_mapping {
        findings.push(Value::String(m));
    }
    Some(serde_json::json!({
        "workKind": work_kind,
        "summary": if is_script { format!("Create/update a Dataverse form script for {}.", entity) } else { format!("Create/update a Dataverse plugin for {}.", entity) },
        "implementationSteps": steps,
        "dataverseFindings": findings,
        "fieldMappings": field_mappings,
        "unmappedSourceFields": unmapped_source_fields,
        "risks": ["Dataverse metadata and runtime registration still require separate verification before implementation."],
        "testChecklist": if is_script { serde_json::json!(["Validate the form event wiring manually in the model-driven app.", "Test the happy path and empty/null source values."]) } else { serde_json::json!(["Run/build the plugin project locally.", "Verify message/stage/filtering attributes before manual registration."]) },
        "target": target,
    }))
}

fn task_mcp_plan_has_template_mapping(plan: &Value, template: Option<&Value>) -> bool {
    let Some(tpl) = template else { return true; };
    let source_entity = tpl["sourceEntity"].as_str().unwrap_or("source");
    let target_entity = plan["target"]["entityLogicalName"].as_str()
        .or_else(|| tpl["targetEntity"].as_str())
        .or_else(|| tpl["scriptTarget"]["entityLogicalName"].as_str())
        .unwrap_or("");
    let source_fields: Vec<String> = tpl["sourceFields"].as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str()).map(str::to_string).collect())
        .unwrap_or_default();
    let target_fields: Vec<String> = tpl["targetFields"].as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str()).map(str::to_string).collect())
        .unwrap_or_default();
    let pair_count = source_fields.len().min(target_fields.len());
    if pair_count == 0 { return true; }
    let actual = plan["fieldMappings"].as_array().cloned().unwrap_or_default();
    (0..pair_count).all(|i| {
        let source = format!("{}.{}", source_entity, source_fields[i]);
        let target = format!("{}.{}", target_entity, target_fields[i]);
        actual.iter().any(|item| item["source"].as_str() == Some(source.as_str()) && item["target"].as_str() == Some(target.as_str()))
    })
}

fn task_mcp_execute_tool(app: &tauri::AppHandle, tool_name: &str, args: &Value) -> Result<Value, String> {
    let mut tasks = task_mcp_load_tasks(app)?;
    let customers = task_mcp_load_customers(app).unwrap_or_default();
    let settings = load_settings(app.clone()).unwrap_or_else(|_| serde_json::json!({}));
    let crm_base_dir = settings["crmBaseDirectory"].as_str().unwrap_or("").trim_end_matches('/').to_string();
    let mut updated = false;

    let result = match tool_name {
        "list_tasks" => {
            let limit = args["limit"].as_u64().unwrap_or(25).clamp(1, 100) as usize;
            let status_filter = args["status"].as_str();
            let developer_only = args["developerOnly"].as_bool().unwrap_or(false);

            let mut filtered: Vec<&Value> = tasks.iter().collect();
            if let Some(status) = status_filter {
                filtered.retain(|task| task["status"].as_str().unwrap_or("") == status);
            }
            if developer_only {
                filtered.retain(|task| task_mcp_is_developer_task(task));
            }

            serde_json::json!({
                "count": filtered.len(),
                "tasks": filtered.into_iter().take(limit).map(task_mcp_safe_task_summary).collect::<Vec<Value>>(),
            })
        }
        "get_task" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() {
                return Err("Missing required argument: id".to_string());
            }
            let task = task_mcp_get_task(&tasks, task_id).ok_or_else(|| format!("Task not found: {task_id}"))?;
            serde_json::json!({"task": task_mcp_safe_task_detail(task)})
        }
        "get_task_summary" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() {
                return Err("Missing required argument: id".to_string());
            }
            let task = task_mcp_get_task(&tasks, task_id).ok_or_else(|| format!("Task not found: {task_id}"))?;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }
        "get_crm_workflow_state" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() {
                return Err("Missing required argument: id".to_string());
            }
            let task = task_mcp_get_task(&tasks, task_id).ok_or_else(|| format!("Task not found: {task_id}"))?;
            serde_json::json!({"taskId": task_id, "crmWorkflowState": task_mcp_safe_crm_workflow_state(task)})
        }
        "get_current_crm_workflow_step" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() {
                return Err("Missing required argument: id".to_string());
            }
            let task = task_mcp_get_task(&tasks, task_id).ok_or_else(|| format!("Task not found: {task_id}"))?;
            let workflow = task.get("crmDeveloperWorkflow").unwrap_or(&Value::Null);
            serde_json::json!({
                "taskId": task_id,
                "currentStep": workflow["currentStep"].as_str().unwrap_or("diagnosis"),
                "detectedWorkKind": workflow["detectedWorkKind"].as_str().unwrap_or("unknown"),
                "latestCrmVerification": task_mcp_latest_verification(task),
                "approvals": {
                    "plan": task_mcp_approval_summary(workflow.get("planApproval")),
                    "diff": task_mcp_approval_summary(workflow.get("diffApproval")),
                    "externalAction": task_mcp_approval_summary(workflow.get("externalActionApproval")),
                    "pullRequest": task_mcp_approval_summary(workflow.get("pullRequestApproval")),
                },
            })
        }
        "get_technical_plan" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() {
                return Err("Missing required argument: id".to_string());
            }
            let task = task_mcp_get_task(&tasks, task_id).ok_or_else(|| format!("Task not found: {task_id}"))?;
            serde_json::json!({
                "taskId": task_id,
                "technicalPlan": task["crmDeveloperWorkflow"]["technicalPlan"].clone(),
            })
        }
        "get_pr_review_state" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() {
                return Err("Missing required argument: id".to_string());
            }
            let task = task_mcp_get_task(&tasks, task_id).ok_or_else(|| format!("Task not found: {task_id}"))?;
            let workflow = task.get("crmDeveloperWorkflow").unwrap_or(&Value::Null);
            serde_json::json!({"taskId": task_id, "pullRequest": task_mcp_pull_request_state(workflow)})
        }
        "get_next_recommended_step" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() {
                return Err("Missing required argument: id".to_string());
            }
            let task = task_mcp_get_task(&tasks, task_id).ok_or_else(|| format!("Task not found: {task_id}"))?;
            serde_json::json!({"taskId": task_id, "recommendation": task_mcp_next_recommended_step(task)})
        }
        "append_task_note" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            let note = task_mcp_normalize_small_text(args["note"].as_str().unwrap_or(""), TASK_MCP_MAX_NOTE_LENGTH);
            if task_id.is_empty() {
                return Err("Missing required argument: taskId".to_string());
            }
            if note.is_empty() {
                return Err("Note cannot be empty after sanitization.".to_string());
            }

            let index = task_mcp_find_task_index(&tasks, task_id).ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            let existing = task["notes"].as_str().unwrap_or("").trim();
            // The timestamped note itself is the audit record â€” no separate audit line needed.
            let line = format!("[{}] {}", chrono_now_iso(), note);
            let combined = if existing.is_empty() {
                line
            } else {
                format!("{existing}\n{line}")
            };
            task["notes"] = Value::String(combined);
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }
        "set_task_status" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            let status = args["status"].as_str().unwrap_or("").trim();
            if task_id.is_empty() {
                return Err("Missing required argument: taskId".to_string());
            }
            if !task_mcp_allowed_statuses().contains(&status) {
                return Err(format!("Invalid status '{status}'. Allowed: {}", task_mcp_allowed_statuses().join(", ")));
            }

            let index = task_mcp_find_task_index(&tasks, task_id).ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            task["status"] = Value::String(status.to_string());
            if status == "done" {
                task["completedAt"] = Value::String(chrono_now_iso());
            } else {
                task["completedAt"] = Value::Null;
            }
            task_mcp_append_audit_note(task, &format!("set_task_status -> {status}"));
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }
        "set_task_attention_state" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() {
                return Err("Missing required argument: taskId".to_string());
            }

            let state_raw = args.get("attentionState").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let clear = args.get("attentionState").is_some_and(|v| v.is_null()) || state_raw.is_empty() || state_raw == "none";
            if !clear && !task_mcp_allowed_attention_states().contains(&state_raw.as_str()) {
                return Err(format!("Invalid attentionState '{state_raw}'. Allowed: {}, or null.", task_mcp_allowed_attention_states().join(", ")));
            }

            let index = task_mcp_find_task_index(&tasks, task_id).ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            if clear {
                task["attentionState"] = Value::Null;
                task_mcp_append_audit_note(task, "set_task_attention_state -> null");
            } else {
                task["attentionState"] = Value::String(state_raw.clone());
                task_mcp_append_audit_note(task, &format!("set_task_attention_state -> {state_raw}"));
            }
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }
        "set_task_waiting_state" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() {
                return Err("Missing required argument: taskId".to_string());
            }

            let state_raw = args.get("waitingState").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let clear = args.get("waitingState").is_some_and(|v| v.is_null()) || state_raw.is_empty() || state_raw == "none";
            if !clear && !task_mcp_allowed_waiting_states().contains(&state_raw.as_str()) {
                return Err(format!("Invalid waitingState '{state_raw}'. Allowed: {}, or null.", task_mcp_allowed_waiting_states().join(", ")));
            }

            let index = task_mcp_find_task_index(&tasks, task_id).ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            if clear {
                task["waitingState"] = Value::Null;
                task_mcp_append_audit_note(task, "set_task_waiting_state -> null");
            } else {
                task["waitingState"] = Value::String(state_raw.clone());
                task_mcp_append_audit_note(task, &format!("set_task_waiting_state -> {state_raw}"));
            }
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }
        // â”€â”€ Task creation tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

        "create_task" => {
            // Required: title â€” sanitize HTML, then reject if too long (never truncate silently)
            let title = task_mcp_strip_html(args["title"].as_str().unwrap_or(""))
                .trim()
                .to_string();
            if title.is_empty() {
                return Err("title is required and cannot be empty.".to_string());
            }
            if title.chars().count() > 300 {
                return Err("title must be 300 characters or fewer.".to_string());
            }

            // source â€” map mcp/devops to stored values
            let source_input = args["source"].as_str().unwrap_or("manual").trim();
            if !source_input.is_empty() && !task_mcp_allowed_create_sources().contains(&source_input) {
                return Err(format!("Invalid source '{source_input}'. Allowed: {}", task_mcp_allowed_create_sources().join(", ")));
            }
            let source = match source_input {
                "mcp"    => "manual",
                "devops" => "email",
                other    => if other.is_empty() { "manual" } else { other },
            };

            // taskType â€” allow 'bug' as alias for 'bug-fix'
            let type_input = args["taskType"].as_str().unwrap_or("other").trim();
            if !type_input.is_empty() && !task_mcp_allowed_create_task_types().contains(&type_input) {
                return Err(format!("Invalid taskType '{type_input}'. Allowed: {}", task_mcp_allowed_create_task_types().join(", ")));
            }
            let task_type = match type_input {
                "bug" => "bug-fix",
                other => if other.is_empty() { "other" } else { other },
            };

            // status
            let status_input = args["status"].as_str().unwrap_or("new").trim();
            let status = if status_input.is_empty() { "new" } else { status_input };
            if !task_mcp_allowed_statuses().contains(&status) {
                return Err(format!("Invalid status '{status}'. Allowed: {}", task_mcp_allowed_statuses().join(", ")));
            }

            // waitingState
            let waiting_input = args["waitingState"].as_str().unwrap_or("").trim();
            let waiting_opt = if waiting_input.is_empty() || waiting_input == "none" {
                None
            } else if task_mcp_allowed_waiting_states().contains(&waiting_input) {
                Some(waiting_input)
            } else {
                return Err(format!("Invalid waitingState '{waiting_input}'. Allowed: {}, or none.", task_mcp_allowed_waiting_states().join(", ")));
            };

            // mode
            let mode_input = args["mode"].as_str().unwrap_or("").trim();
            let mode_opt = if mode_input.is_empty() {
                None
            } else if task_mcp_allowed_modes().contains(&mode_input) {
                Some(mode_input)
            } else {
                return Err(format!("Invalid mode '{mode_input}'. Allowed: developer, general"));
            };

            // text fields
            let notes       = args["notes"].as_str().map(|n| task_mcp_normalize_small_text(n, 2000)).filter(|s| !s.is_empty());
            let summary     = args["summary"].as_str().map(|s| task_mcp_normalize_small_text(s, 1000)).filter(|s| !s.is_empty());
            let customer_id = args["customerId"].as_str().map(|c| task_mcp_normalize_small_text(c, 100)).filter(|s| !s.is_empty()).unwrap_or_default();

            // estimateHours
            let estimate = if args["estimateHours"].is_null() || args["estimateHours"].is_string() && args["estimateHours"].as_str().unwrap_or("").is_empty() {
                None
            } else {
                let h = args["estimateHours"].as_f64().ok_or_else(|| "estimateHours must be a number".to_string())?;
                if h <= 0.0 || h > 1000.0 { return Err("estimateHours must be positive and at most 1000".to_string()); }
                Some(h)
            };

            let id  = task_mcp_generate_id();
            let now = chrono_now_iso();

            let mut new_task = serde_json::json!({
                "id":               id,
                "title":            title,
                "source":           source,
                "taskType":         task_type,
                "status":           status,
                "confidence":       0,
                "originalMessage":  summary.as_deref().unwrap_or(""),
                "receivedAt":       now,
                "suggestedActions": [],
                "customerId":       customer_id,
                "classificationState": "created",
            });

            if let Some(m)  = mode_opt    { new_task["taskMode"]        = serde_json::json!(m); }
            if let Some(ws) = waiting_opt { new_task["waitingState"]    = serde_json::json!(ws); }
            if let Some(n)  = notes       { new_task["notes"]           = serde_json::json!(n); }
            if let Some(h)  = estimate    { new_task["estimatedEffort"] = serde_json::json!(h); }
            if let Some(ref s) = summary  {
                new_task["analysisResult"] = serde_json::json!({
                    "summary": s, "summaryEn": s, "confidence": 0, "suggestedActions": [],
                });
                if status == "analyzed" { /* analysisResult already set */ }
            }
            if status == "done" { new_task["completedAt"] = serde_json::json!(now); }

            task_mcp_append_audit_note(&mut new_task, "create_task");
            let task_id = id.clone();
            tasks.push(new_task);
            updated = true;

            let created = tasks.last().unwrap();
            serde_json::json!({"taskId": task_id, "task": task_mcp_safe_task_summary(created)})
        }

        "create_test_task" => {
            // Optional title: strip HTML, reject if explicitly too long (never truncate silently)
            let title = if let Some(raw) = args["title"].as_str() {
                let cleaned = task_mcp_strip_html(raw).trim().to_string();
                if cleaned.chars().count() > 300 {
                    return Err("title must be 300 characters or fewer.".to_string());
                }
                if cleaned.is_empty() { "MCP workflow smoke test".to_string() } else { cleaned }
            } else {
                "MCP workflow smoke test".to_string()
            };
            let extra_notes = args["notes"].as_str()
                .map(|n| task_mcp_normalize_small_text(n, 500))
                .filter(|s| !s.is_empty());

            let base = "Temporary task for MCP workflow smoke testing. Can be deleted after test.";
            let full_notes = match extra_notes {
                Some(n) => format!("{base}\n{n}"),
                None    => base.to_string(),
            };

            let id  = task_mcp_generate_id();
            let now = chrono_now_iso();
            let task_id = id.clone();

            let mut new_task = serde_json::json!({
                "id":               id,
                "title":            title,
                "source":           "manual",
                "taskType":         "other",
                "status":           "new",
                "confidence":       0,
                "originalMessage":  "",
                "receivedAt":       now,
                "suggestedActions": [],
                "customerId":       "",
                "classificationState": "created",
                "mcpTestTask":      true,
                "notes":            full_notes,
            });

            task_mcp_append_audit_note(&mut new_task, "create_test_task");
            tasks.push(new_task);
            updated = true;

            let created = tasks.last().unwrap();
            serde_json::json!({"taskId": task_id, "task": task_mcp_safe_task_summary(created)})
        }

        "delete_test_task" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;

            let is_test = tasks[index].get("mcpTestTask")
                .and_then(|v| v.as_bool()).unwrap_or(false);
            if !is_test {
                return Err(format!(
                    "Task {task_id} is not an MCP test task. \
                     delete_test_task only deletes tasks created by create_test_task (mcpTestTask=true)."
                ));
            }

            tasks.remove(index);
            updated = true;
            serde_json::json!({"deleted": true, "taskId": task_id})
        }

        // â”€â”€ New read tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

        "get_task_full_context" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: id".to_string()); }
            let task = task_mcp_get_task(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let mut detail = task_mcp_safe_task_detail(task);
            detail["displayPhase"]       = serde_json::json!(task_mcp_display_phase(task));
            detail["estimatedEffort"]    = task["estimatedEffort"].clone();
            detail["budgetHours"]        = task["budgetHours"].clone();
            detail["budgetNote"]         = serde_json::json!(task_mcp_normalize_small_text(task["budgetNote"].as_str().unwrap_or(""), 300));
            detail["notes"]              = serde_json::json!(task_mcp_normalize_small_text(task["notes"].as_str().unwrap_or(""), 1500));
            detail["localTestRecord"]    = task.get("localTestRecord").cloned().unwrap_or(Value::Null);
            detail["consultantTestRecord"] = task.get("consultantTestRecord").cloned().unwrap_or(Value::Null);
            detail["mcpNextStep"]        = task.get("mcpNextStep").cloned().unwrap_or(Value::Null);
            detail["checklist"]                = serde_json::json!(task_mcp_workflow_checklist(task));
            detail["pullRequestState"]         = task_mcp_pull_request_state(task.get("crmDeveloperWorkflow").unwrap_or(&Value::Null));
            detail["nextRecommendedStep"]      = task_mcp_next_recommended_step(task);
            detail["implementationReadiness"]  = task_mcp_implementation_readiness(task);

            // Embed customer developer defaults so the AI can apply them without a separate tool call
            let customer_id = task["customerId"].as_str()
                .or_else(|| task["workflowSetup"]["customerId"].as_str())
                .unwrap_or("");
            let dev_defaults = task_mcp_find_customer(&customers, customer_id)
                .and_then(|c| task_mcp_customer_dev_defaults(c, &crm_base_dir));
            if let Some(ref dd) = dev_defaults {
                detail["customerDevDefaults"] = dd.clone();
            }

            // Compute developerWorkPacket.scriptNaming for script/ribbon tasks
            let work_kind_val = task["crmDeveloperWorkflow"]["detectedWorkKind"].as_str()
                .or_else(|| task["workflowSetup"]["devTargetKind"].as_str())
                .unwrap_or("");
            if work_kind_val == "script" || work_kind_val == "ribbon" {
                if let Some(naming) = task_mcp_compute_script_naming(task, dev_defaults.as_ref()) {
                    detail["developerWorkPacket"] = serde_json::json!({ "scriptNaming": naming });
                }
            }

            serde_json::json!({"task": detail})
        }

        "get_task_templates" => {
            let matched = args["taskId"].as_str()
                .and_then(|task_id| task_mcp_get_task(&tasks, task_id))
                .and_then(|task| task_mcp_match_template(task["title"].as_str().unwrap_or("")));
            serde_json::json!({
                "templates": task_mcp_builtin_templates(),
                "matchedTemplate": matched,
            })
        }

        "prepare_developer_task" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let mode = args["mode"].as_str().unwrap_or("setup-until-approval-gate");
            if mode != "setup-until-approval-gate" {
                return Err(format!("Unsupported prepare_developer_task mode: {mode}"));
            }
            let confirm_setup = args["confirmSetup"].as_bool().unwrap_or(true);
            let create_plan = args["createTechnicalPlan"].as_bool().unwrap_or(true);
            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let customer_id = tasks[index]["customerId"].as_str()
                .or_else(|| tasks[index]["workflowSetup"]["customerId"].as_str())
                .unwrap_or("")
                .to_string();
            let dev_defaults = task_mcp_find_customer(&customers, &customer_id)
                .and_then(|c| task_mcp_customer_dev_defaults(c, &crm_base_dir));
            let template = task_mcp_match_template(tasks[index]["title"].as_str().unwrap_or(""));
            let now = chrono_now_iso();

            let mut applied: Vec<&str> = Vec::new();
            let skipped = vec![serde_json::json!({
                "action": "run_dataverse_check_for_task",
                "reason": "Dataverse metadata verification for JS/TS is not available through MCP. Use the in-app Verify Implementation modal after implementation/upload."
            })];
            let mut hard_blockers: Vec<String> = Vec::new();
            let mut warnings: Vec<String> = Vec::new();
            let mut missing: Vec<String> = Vec::new();
            let mut gates: Vec<Value> = Vec::new();

            {
                let task = &mut tasks[index];
                if let Some(ref tpl) = template {
                    task["taskMode"] = serde_json::json!(tpl["mode"].as_str().unwrap_or("developer"));
                    if task["workflowSetup"].is_null() { task["workflowSetup"] = serde_json::json!({}); }
                    if task["crmDeveloperWorkflow"].is_null() { task["crmDeveloperWorkflow"] = serde_json::json!({"createdAt": now}); }
                    let work_kind = tpl["workKind"].as_str().unwrap_or("unknown");
                    task["workflowSetup"]["devTargetKind"] = serde_json::json!(if work_kind == "plugin" { "plugin" } else if work_kind == "script" || work_kind == "ribbon" { "script" } else { "repo" });
                    task["workflowSetup"]["workIntent"] = serde_json::json!(if tpl["actionType"].as_str().unwrap_or("").starts_with("create-") { "create" } else { "update" });
                    task["workflowSetup"]["actionType"] = tpl["actionType"].clone();
                    task["workflowSetup"]["primaryEntityLogicalName"] = tpl["targetEntity"].clone();
                    if !tpl["scriptTarget"].is_null() {
                        task["workflowSetup"]["eventName"] = tpl["scriptTarget"]["eventName"].clone();
                        task["workflowSetup"]["eventFieldName"] = tpl["scriptTarget"]["eventFieldName"].clone();
                    }
                    if !tpl["scriptNaming"].is_null() {
                        task["workflowSetup"]["namingSource"] = tpl["scriptNaming"]["namingSource"].clone();
                        task["workflowSetup"]["desiredScriptFile"] = tpl["scriptNaming"]["desiredScriptFile"].clone();
                        task["workflowSetup"]["onLoadFunctionName"] = tpl["scriptNaming"]["onLoadFunctionName"].clone();
                        task["workflowSetup"]["onChangeFunctionName"] = tpl["scriptNaming"]["onChangeFunctionName"].clone();
                        task["workflowSetup"]["mainHelperSuggestion"] = tpl["scriptNaming"]["mainHelperSuggestion"].clone();
                    }
                    if let Some(entity) = tpl["pluginTarget"]["entityLogicalName"].as_str() {
                        task["workflowSetup"]["primaryEntityLogicalName"] = serde_json::json!(entity);
                    }
                    task["crmDeveloperWorkflow"]["detectedWorkKind"] = serde_json::json!(work_kind);
                    task["crmDeveloperWorkflow"]["updatedAt"] = serde_json::json!(now);
                    applied.extend(["applied_template", "set_task_mode", "set_task_work_classification"]);
                }

                if let Some(ref defaults) = dev_defaults {
                    if task["workflowSetup"].is_null() { task["workflowSetup"] = serde_json::json!({}); }
                    if task["workflowSetup"]["repositoryRoot"].as_str().unwrap_or("").is_empty() {
                        if let Some(v) = defaults["repositoryRoot"].as_str() { task["workflowSetup"]["repositoryRoot"] = serde_json::json!(v); }
                    }
                    if task["workflowSetup"]["devTargetKind"].as_str() == Some("script") && task["workflowSetup"]["scriptPath"].as_str().unwrap_or("").is_empty() {
                        if let Some(dir) = defaults["scriptDirectory"].as_str() {
                            let repo = defaults["repositoryRoot"].as_str().unwrap_or("").trim_end_matches(|c| c == '/' || c == '\\');
                            let rel = if !repo.is_empty() && dir.to_lowercase().starts_with(&repo.to_lowercase()) {
                                dir[repo.len()..].trim_start_matches(|c| c == '/' || c == '\\').to_string()
                            } else {
                                dir.replace('\\', "/").split('/').filter(|s| !s.is_empty()).last().unwrap_or(dir).to_string()
                            };
                            task["workflowSetup"]["scriptPath"] = serde_json::json!(rel);
                        }
                    }
                    if task["workflowSetup"]["devTargetKind"].as_str() == Some("plugin") && task["workflowSetup"]["pluginProject"].as_str().unwrap_or("").is_empty() {
                        if let Some(v) = defaults["pluginProjectPath"].as_str() { task["workflowSetup"]["pluginProject"] = serde_json::json!(v); }
                    }
                    applied.push("applied_customer_defaults");
                }

                if task["workflowSetup"]["actionType"].as_str() == Some("create-new-script")
                    && !task["workflowSetup"]["repositoryRoot"].as_str().unwrap_or("").is_empty() {
                    if let Some(naming) = task_mcp_script_naming_from_template(task, template.as_ref(), dev_defaults.as_ref()) {
                        task["workflowSetup"]["desiredScriptFile"] = naming["desiredScriptFile"].clone();
                        task["workflowSetup"]["artifactPath"] = naming["scriptPath"].clone();
                        task["workflowSetup"]["absoluteScriptPath"] = naming["absoluteScriptPath"].clone();
                        task["workflowSetup"]["namingSource"] = naming["namingSource"].clone();
                        task["workflowSetup"]["onLoadFunctionName"] = naming["onLoadFunctionName"].clone();
                        if !naming["onChangeFunctionName"].is_null() { task["workflowSetup"]["onChangeFunctionName"] = naming["onChangeFunctionName"].clone(); }
                        if !naming["mainHelperSuggestion"].is_null() { task["workflowSetup"]["mainHelperSuggestion"] = naming["mainHelperSuggestion"].clone(); }
                        applied.push("saved_developer_target");
                    }
                }

                let analysis_text = format!(
                    "{} {}",
                    task["analysisResult"]["summary"].as_str().unwrap_or(""),
                    task["analysisResult"]["summaryEn"].as_str().unwrap_or("")
                ).to_lowercase();
                let has_stale_template_questions = analysis_text.contains("open questions")
                    || analysis_text.contains("which specific fields")
                    || analysis_text.contains("fields from the asset")
                    || analysis_text.contains("should be prefilled");
                if (template.is_some() && has_stale_template_questions)
                    || task["analysisResult"]["summary"].as_str().unwrap_or("").is_empty() {
                    let summary = template.as_ref()
                        .and_then(|t| t["notes"].as_str())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("Developer task setup prepared for: {}.", task["title"].as_str().unwrap_or(task_id)));
                    task["analysisResult"] = serde_json::json!({
                        "summary": summary,
                        "summaryEn": summary,
                        "confidence": if template.is_some() { 90 } else { 60 },
                        "suggestedActions": []
                    });
                    applied.push("saved_task_analysis");
                }

                let dev_target_kind = task["workflowSetup"]["devTargetKind"].as_str().unwrap_or("").to_string();
                let action_type = task["workflowSetup"]["actionType"].as_str().unwrap_or("").to_string();
                let work_kind = task["crmDeveloperWorkflow"]["detectedWorkKind"].as_str()
                    .unwrap_or(dev_target_kind.as_str())
                    .to_string();
                let confirmed_missing = task["workflowSetup"]["confirmedAt"].as_str().unwrap_or("").is_empty();
                if dev_target_kind == "script" || work_kind == "script" || work_kind == "ribbon" {
                    warnings.push("Dataverse metadata verification for JS/TS is not available through MCP. Use the in-app Verify Implementation modal after implementation/upload.".into());
                }
                if task["workflowSetup"]["repositoryRoot"].as_str().unwrap_or("").is_empty() { missing.push("repositoryRoot".into()); }
                if work_kind.is_empty() || work_kind == "unknown" { missing.push("workKind".into()); }
                if action_type.is_empty() { missing.push("actionType".into()); }
                if task["workflowSetup"]["primaryEntityLogicalName"].as_str().unwrap_or("").is_empty() { missing.push("targetEntity".into()); }
                if dev_target_kind == "script"
                    && action_type == "create-new-script"
                    && (task["workflowSetup"]["scriptPath"].as_str().unwrap_or("").is_empty()
                        || task["workflowSetup"]["desiredScriptFile"].as_str().unwrap_or("").is_empty()
                        || task["workflowSetup"]["artifactPath"].as_str().unwrap_or("").is_empty()) {
                    missing.push("script target path".into());
                }
                if dev_target_kind == "plugin" && task["workflowSetup"]["pluginProject"].as_str().unwrap_or("").is_empty() {
                    missing.push("plugin project".into());
                }
                if !missing.is_empty() {
                    hard_blockers.push(format!("Missing required setup input(s): {}.", missing.join(", ")));
                }

                let has_plan = task["crmDeveloperWorkflow"]["technicalPlan"].is_object();
                let plan_needs_template_mapping = has_plan
                    && !task_mcp_plan_has_template_mapping(&task["crmDeveloperWorkflow"]["technicalPlan"], template.as_ref());
                if create_plan && (!has_plan || plan_needs_template_mapping) && hard_blockers.is_empty() {
                    if let Some(plan_base) = task_mcp_prepare_plan_draft(task, template.as_ref()) {
                        task["crmDeveloperWorkflow"]["technicalPlan"] = serde_json::json!({
                            "generatedAt": now,
                            "workKind": plan_base["workKind"].clone(),
                            "summary": plan_base["summary"].clone(),
                            "implementationSteps": plan_base["implementationSteps"].clone(),
                            "dataverseFindings": plan_base["dataverseFindings"].clone(),
                            "fieldMappings": plan_base["fieldMappings"].clone(),
                            "unmappedSourceFields": plan_base["unmappedSourceFields"].clone(),
                            "risks": plan_base["risks"].clone(),
                            "testChecklist": plan_base["testChecklist"].clone(),
                            "externalActionPreview": [],
                            "target": plan_base["target"].clone(),
                        });
                        task["crmDeveloperWorkflow"]["planApproval"] = Value::Null;
                        task["crmDeveloperWorkflow"]["currentStep"] = serde_json::json!("technical-plan");
                        task["crmDeveloperWorkflow"]["updatedAt"] = serde_json::json!(now);
                        applied.extend(["saved_technical_plan", "marked_technical_plan_ready"]);
                        gates.push(serde_json::json!({"type": "technical-plan-approval", "message": "Review and approve the technical implementation plan."}));
                    } else {
                        warnings.push("Technical plan was not created because the task context is not specific enough.".into());
                    }
                } else if has_plan && !task_mcp_approval_summary(task["crmDeveloperWorkflow"].get("planApproval"))["approved"].as_bool().unwrap_or(false) {
                    gates.push(serde_json::json!({"type": "technical-plan-approval", "message": "Review and approve the technical implementation plan."}));
                }

                if confirm_setup && hard_blockers.is_empty() && confirmed_missing {
                    task["workflowSetup"]["confirmedAt"] = serde_json::json!(now);
                    if task["status"].as_str() == Some("new") {
                        task["status"] = serde_json::json!("analyzed");
                    }
                    applied.push("confirmed_setup");
                }
                task_mcp_append_audit_note(task, "prepare_developer_task");
            }

            let task = &tasks[index];
            let readiness = task_mcp_implementation_readiness(task);
            let status = if !hard_blockers.is_empty() {
                "blocked"
            } else if !gates.is_empty() {
                "stopped_at_approval_gate"
            } else if readiness["isImplementationReady"].as_bool().unwrap_or(false) {
                "ready_for_implementation"
            } else {
                "blocked"
            };
            let mut detail = task_mcp_safe_task_detail(task);
            detail["implementationReadiness"] = readiness.clone();
            if let Some(ref dd) = dev_defaults { detail["customerDevDefaults"] = dd.clone(); }
            updated = true;
            serde_json::json!({
                "taskId": task_id,
                "status": status,
                "appliedActions": applied.into_iter().collect::<HashSet<_>>().into_iter().collect::<Vec<_>>(),
                "skippedActions": skipped,
                "hardBlockers": hard_blockers,
                "approvalGates": gates,
                "warnings": warnings,
                "missingInputs": missing,
                "implementationReadiness": readiness,
                "task": detail,
            })
        }

        "get_task_workflow_overview" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: id".to_string()); }
            let task = task_mcp_get_task(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            serde_json::json!({
                "taskId":                task_id,
                "displayPhase":          task_mcp_display_phase(task),
                "status":                task["status"].as_str(),
                "waitingState":          task["waitingState"].as_str(),
                "attentionState":        task["attentionState"].as_str(),
                "checklist":             task_mcp_workflow_checklist(task),
                "localTestRecord":       task.get("localTestRecord").cloned().unwrap_or(Value::Null),
                "consultantTestRecord":  task.get("consultantTestRecord").cloned().unwrap_or(Value::Null),
                "mcpNextStep":           task.get("mcpNextStep").cloned().unwrap_or(Value::Null),
                "nextRecommendedStep":   task_mcp_next_recommended_step(task),
            })
        }

        "get_task_original_message" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: id".to_string()); }
            let task = task_mcp_get_task(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            serde_json::json!({
                "taskId":              task_id,
                "title":               task["title"].as_str().unwrap_or(""),
                "senderName":          task["senderName"].as_str(),
                "senderEmail":         task["senderEmail"].as_str(),
                "receivedAt":          task["receivedAt"].as_str(),
                "source":              task["source"].as_str(),
                "classificationLabel": task["classificationLabel"].as_str(),
                "originalMessage":     task_mcp_normalize_small_text(task["originalMessage"].as_str().unwrap_or(""), 8000),
            })
        }

        "get_task_developer_setup" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: id".to_string()); }
            let task = task_mcp_get_task(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let setup = task.get("workflowSetup").unwrap_or(&Value::Null);
            serde_json::json!({
                "taskId":               task_id,
                "mode":                 task["taskMode"].as_str().unwrap_or("auto"),
                "devTargetKind":        setup["devTargetKind"].as_str(),
                "workIntent":           setup["workIntent"].as_str(),
                "repositoryRoot":       setup["repositoryRoot"].as_str(),
                "pluginProject":        setup["pluginProject"].as_str(),
                "scriptPath":           setup["scriptPath"].as_str(),
                "customerId":           setup["customerId"].as_str().or(task["customerId"].as_str()),
                "confirmedAt":          setup["confirmedAt"].as_str(),
                "selectedPluginProject":task["selectedPluginProject"].as_str(),
            })
        }

        // â”€â”€ New write tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

        "save_task_analysis" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let summary = task_mcp_normalize_small_text(args["summary"].as_str().unwrap_or(""), 3000);
            if summary.is_empty() { return Err("summary cannot be empty after sanitization.".to_string()); }
            let requirements = task_mcp_collect_string_array(&args["requirements"], 20, 500);
            let risks        = task_mcp_collect_string_array(&args["risks"], 10, 300);
            let questions    = task_mcp_collect_string_array(&args["questions"], 10, 300);
            let next_step    = task_mcp_normalize_small_text(args["suggestedNextStep"].as_str().unwrap_or(""), 300);

            // Append open questions to summary if present
            let full_summary = if questions.is_empty() {
                summary.clone()
            } else {
                let q_lines: Vec<String> = questions.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| format!("- {s}"))
                    .collect();
                format!("{summary}\n\nOpen questions:\n{}", q_lines.join("\n"))
            };

            let suggested_actions: Vec<Value> = requirements.iter().enumerate().take(3)
                .map(|(i, v)| serde_json::json!({"id": format!("req-{i}"), "label": v.as_str().unwrap_or("")}))
                .collect();

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            task["analysisResult"] = serde_json::json!({
                "summary":        full_summary,
                "summaryEn":      full_summary,
                "actionPointsEn": requirements,
                "problemPointsEn":risks,
                "nextStep":       next_step,
                "nextStepEn":     next_step,
                "confidence":     80,
                "suggestedActions": suggested_actions,
            });
            if task["status"].as_str() == Some("new") {
                task["status"] = serde_json::json!("analyzed");
            }
            task_mcp_append_audit_note(task, "save_task_analysis");
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "update_task_summary" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let summary = task_mcp_normalize_small_text(args["summary"].as_str().unwrap_or(""), 2000);
            if summary.is_empty() { return Err("summary cannot be empty after sanitization.".to_string()); }
            let next_step_raw = args["nextStep"].as_str()
                .map(|s| task_mcp_normalize_small_text(s, 300));

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            if task["analysisResult"].is_null() {
                task["analysisResult"] = serde_json::json!({"confidence": 0, "suggestedActions": []});
            }
            task["analysisResult"]["summaryEn"] = serde_json::json!(summary.clone());
            task["analysisResult"]["summary"]   = serde_json::json!(summary);
            if let Some(ns) = next_step_raw.filter(|s| !s.is_empty()) {
                task["analysisResult"]["nextStepEn"] = serde_json::json!(ns.clone());
                task["analysisResult"]["nextStep"]   = serde_json::json!(ns);
            }
            task_mcp_append_audit_note(task, "update_task_summary");
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "set_task_mode" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let mode = args["mode"].as_str().unwrap_or("").trim();
            if !task_mcp_allowed_modes().contains(&mode) {
                return Err(format!("Invalid mode '{mode}'. Allowed: {}", task_mcp_allowed_modes().join(", ")));
            }
            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            task["taskMode"] = serde_json::json!(mode);
            task_mcp_append_audit_note(task, &format!("set_task_mode -> {mode}"));
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "set_task_work_classification" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let work_kind   = args["workKind"].as_str().unwrap_or("").trim();
            let work_action = args["workAction"].as_str().unwrap_or("").trim();
            if !task_mcp_allowed_work_kinds().contains(&work_kind) {
                return Err(format!("Invalid workKind '{work_kind}'. Allowed: {}", task_mcp_allowed_work_kinds().join(", ")));
            }
            if !task_mcp_allowed_work_actions().contains(&work_action) {
                return Err(format!("Invalid workAction '{work_action}'. Allowed: {}", task_mcp_allowed_work_actions().join(", ")));
            }
            // plugin â†’ plugin target, ribbon/script â†’ script target, all others â†’ repo
            let dev_target_kind = match work_kind {
                "plugin"   => "plugin",
                "script"   => "script",
                "ribbon"   => "script",
                _          => "repo",
            };
            let work_intent = match work_action { "create" => "create", _ => "update" };

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            if task["workflowSetup"].is_null() { task["workflowSetup"] = serde_json::json!({}); }
            task["workflowSetup"]["devTargetKind"] = serde_json::json!(dev_target_kind);
            task["workflowSetup"]["workIntent"]    = serde_json::json!(work_intent);
            // Store the fine-grained work kind in CRM workflow state
            if task["crmDeveloperWorkflow"].is_null() {
                task["crmDeveloperWorkflow"] = serde_json::json!({"createdAt": chrono_now_iso()});
            }
            task["crmDeveloperWorkflow"]["detectedWorkKind"] = serde_json::json!(work_kind);
            task["crmDeveloperWorkflow"]["updatedAt"] = serde_json::json!(chrono_now_iso());
            task_mcp_append_audit_note(task, &format!("set_task_work_classification -> {work_kind}/{work_action}"));
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "set_task_developer_target" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }

            // Collect optional string fields
            let repo_root           = args["repositoryRoot"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let plugin_proj         = args["selectedPluginProject"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let script_tgt          = args["selectedScriptTarget"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let customer_id         = args["customerId"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let primary_entity      = args["primaryEntityLogicalName"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let action_type         = args["actionType"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let event_name          = args["eventName"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let event_field_name    = args["eventFieldName"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let desired_script_file = args["desiredScriptFile"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let naming_source     = args["namingSource"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let on_load_fn        = args["onLoadFunctionName"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let on_change_fn      = args["onChangeFunctionName"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let main_helper          = args["mainHelperSuggestion"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let absolute_script_path = args["absoluteScriptPath"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let artifact_path        = args["artifactPath"].as_str().map(str::trim).filter(|s| !s.is_empty());

            const VALID_ACTION_TYPES: &[&str] = &[
                "create-new-script", "update-existing-script",
                "create-new-plugin", "update-existing-plugin",
            ];
            if let Some(at) = action_type {
                if !VALID_ACTION_TYPES.contains(&at) {
                    return Err(format!("actionType must be one of: {}", VALID_ACTION_TYPES.join(", ")));
                }
            }

            for (name, opt_val) in &[
                ("repositoryRoot", repo_root),
                ("selectedPluginProject", plugin_proj),
                ("selectedScriptTarget", script_tgt),
                ("primaryEntityLogicalName", primary_entity),
                ("eventName", event_name),
                ("eventFieldName", event_field_name),
                ("desiredScriptFile", desired_script_file),
                ("namingSource", naming_source),
                ("onLoadFunctionName", on_load_fn),
                ("onChangeFunctionName", on_change_fn),
                ("mainHelperSuggestion", main_helper),
                ("absoluteScriptPath", absolute_script_path),
                ("artifactPath", artifact_path),
            ] {
                if let Some(v) = opt_val {
                    if v.len() > 500 { return Err(format!("{name} exceeds 500 characters")); }
                    if v.contains(|c: char| matches!(c, '|' | '&' | ';' | '`' | '$' | '>' | '<' | '\n' | '\r')) {
                        return Err(format!("{name} contains unsafe characters"));
                    }
                }
            }

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            if task["workflowSetup"].is_null() { task["workflowSetup"] = serde_json::json!({}); }
            if let Some(v) = repo_root           { task["workflowSetup"]["repositoryRoot"]           = serde_json::json!(v); }
            if let Some(v) = plugin_proj         { task["workflowSetup"]["pluginProject"]            = serde_json::json!(v); }
            if let Some(v) = script_tgt          { task["workflowSetup"]["scriptPath"]               = serde_json::json!(v); }
            if let Some(v) = customer_id         { task["workflowSetup"]["customerId"]               = serde_json::json!(v); }
            if let Some(v) = primary_entity      { task["workflowSetup"]["primaryEntityLogicalName"] = serde_json::json!(v); }
            if let Some(v) = action_type         { task["workflowSetup"]["actionType"]               = serde_json::json!(v); }
            if let Some(v) = event_name          { task["workflowSetup"]["eventName"]                = serde_json::json!(v); }
            if let Some(v) = event_field_name    { task["workflowSetup"]["eventFieldName"]           = serde_json::json!(v); }
            if let Some(v) = desired_script_file { task["workflowSetup"]["desiredScriptFile"]        = serde_json::json!(v); }
            if let Some(v) = naming_source       { task["workflowSetup"]["namingSource"]             = serde_json::json!(v); }
            if let Some(v) = on_load_fn          { task["workflowSetup"]["onLoadFunctionName"]       = serde_json::json!(v); }
            if let Some(v) = on_change_fn        { task["workflowSetup"]["onChangeFunctionName"]     = serde_json::json!(v); }
            if let Some(v) = main_helper          { task["workflowSetup"]["mainHelperSuggestion"]     = serde_json::json!(v); }
            if let Some(v) = absolute_script_path { task["workflowSetup"]["absoluteScriptPath"]      = serde_json::json!(v); }
            if let Some(v) = artifact_path        { task["workflowSetup"]["artifactPath"]             = serde_json::json!(v); }
            task_mcp_append_audit_note(task, "set_task_developer_target");
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "confirm_task_setup" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            if task["workflowSetup"].is_null() { task["workflowSetup"] = serde_json::json!({}); }
            task["workflowSetup"]["confirmedAt"] = serde_json::json!(chrono_now_iso());
            if task["status"].as_str() == Some("new") {
                task["status"] = serde_json::json!("analyzed");
            }
            task_mcp_append_audit_note(task, "confirm_task_setup");
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "set_task_phase" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let phase = args["phase"].as_str().unwrap_or("").trim();
            if !task_mcp_allowed_phases().contains(&phase) {
                return Err(format!("Invalid phase '{phase}'. Allowed: {}", task_mcp_allowed_phases().join(", ")));
            }
            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            match phase {
                "new" => {
                    task["status"]       = serde_json::json!("new");
                    task["waitingState"] = Value::Null;
                    task["attentionState"] = Value::Null;
                }
                "analyzed" => {
                    task["status"]       = serde_json::json!("analyzed");
                    task["waitingState"] = Value::Null;
                    task["attentionState"] = Value::Null;
                }
                "development" => {
                    task["status"]       = serde_json::json!("in-progress");
                    task["waitingState"] = Value::Null;
                    task["attentionState"] = Value::Null;
                }
                "testing" => {
                    task["status"]       = serde_json::json!("in-progress");
                    task["waitingState"] = serde_json::json!("consultant-testing");
                    task["attentionState"] = Value::Null;
                }
                "review" => {
                    task["status"]       = serde_json::json!("ready-for-review");
                    task["waitingState"] = serde_json::json!("code-review");
                    task["attentionState"] = Value::Null;
                }
                "done" => {
                    task["status"]       = serde_json::json!("done");
                    task["waitingState"] = Value::Null;
                    task["attentionState"] = Value::Null;
                    task["completedAt"]  = serde_json::json!(chrono_now_iso());
                }
                _ => {}
            }
            task_mcp_append_audit_note(task, &format!("set_task_phase -> {phase}"));
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "record_local_test" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let status = args["status"].as_str().unwrap_or("").trim();
            if !task_mcp_allowed_local_test_statuses().contains(&status) {
                return Err(format!("Invalid status '{status}'. Allowed: {}", task_mcp_allowed_local_test_statuses().join(", ")));
            }
            let note = args["note"].as_str()
                .map(|n| task_mcp_normalize_small_text(n, 500))
                .filter(|s| !s.is_empty());

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            task["localTestRecord"] = serde_json::json!({
                "status":    status,
                "updatedAt": chrono_now_iso(),
                "note":      note,
            });
            // Reflect in checklist overrides
            let checklist_status = match status {
                "passed"      => "done",
                "failed"      => "warning",
                "not-needed"  => "optional",
                _             => "not-done",
            };
            if task["mcpChecklistOverrides"].is_null() { task["mcpChecklistOverrides"] = serde_json::json!({}); }
            task["mcpChecklistOverrides"]["local-test-done"] = serde_json::json!(checklist_status);
            task_mcp_append_audit_note(task, &format!("record_local_test -> {status}"));
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "record_consultant_testing" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let status = args["status"].as_str().unwrap_or("").trim();
            if !task_mcp_allowed_consultant_test_statuses().contains(&status) {
                return Err(format!("Invalid status '{status}'. Allowed: {}", task_mcp_allowed_consultant_test_statuses().join(", ")));
            }
            let note = args["note"].as_str()
                .map(|n| task_mcp_normalize_small_text(n, 500))
                .filter(|s| !s.is_empty());

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            task["consultantTestRecord"] = serde_json::json!({
                "status":    status,
                "updatedAt": chrono_now_iso(),
                "note":      note,
            });
            match status {
                "requested" => {
                    task["waitingState"] = serde_json::json!("consultant-testing");
                    if task["status"].as_str() != Some("ready-for-review") {
                        task["status"] = serde_json::json!("in-progress");
                    }
                }
                "confirmed" => {
                    // Clear consultant-testing waiting state but do NOT auto-advance to Review.
                    // The user or AI must explicitly call set_task_phase(review) to move forward.
                    if task["waitingState"].as_str() == Some("consultant-testing") {
                        task["waitingState"] = Value::Null;
                    }
                    // Leave a suggested next step so the AI knows what to do next.
                    task["mcpNextStep"] = serde_json::json!({
                        "action":    "Move to Review",
                        "reason":    "Consultant testing confirmed. Call set_task_phase(phase=review) to start code review.",
                        "updatedAt": chrono_now_iso(),
                    });
                }
                "failed" => {
                    if task["waitingState"].as_str() == Some("consultant-testing") {
                        task["waitingState"] = Value::Null;
                    }
                    task["status"] = serde_json::json!("in-progress");
                }
                _ => {}
            }
            task_mcp_append_audit_note(task, &format!("record_consultant_testing -> {status}"));
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "set_task_estimate" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let hours = args["hours"].as_f64()
                .ok_or_else(|| "hours must be a number".to_string())?;
            if hours <= 0.0 || hours > 1000.0 {
                return Err("hours must be a positive number not greater than 1000".to_string());
            }
            let budget_note = args["note"].as_str()
                .map(|n| task_mcp_normalize_small_text(n, 300))
                .filter(|s| !s.is_empty());

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            task["estimatedEffort"] = serde_json::json!(hours);
            if let Some(n) = budget_note { task["budgetNote"] = serde_json::json!(n); }
            task_mcp_append_audit_note(task, &format!("set_task_estimate -> {hours}h"));
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "save_technical_plan" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let plan_summary = task_mcp_normalize_small_text(args["planSummary"].as_str().unwrap_or(""), 3000);
            if plan_summary.is_empty() { return Err("planSummary cannot be empty after sanitization.".to_string()); }

            let impl_steps     = task_mcp_collect_string_array(&args["implementationSteps"], 20, 500);
            let test_plan      = task_mcp_collect_string_array(&args["testPlan"], 20, 300);
            let risks          = task_mcp_collect_string_array(&args["risks"], 10, 300);
            let crm_entities   = task_mcp_collect_string_array(&args["crmEntities"], 20, 200);
            let affected_files = task_mcp_collect_string_array(&args["affectedFiles"], 20, 300);

            // Merge entities and files into dataverseFindings
            let mut findings: Vec<Value> = crm_entities;
            for f in affected_files {
                if let Some(s) = f.as_str() {
                    findings.push(serde_json::json!(format!("File: {s}")));
                }
            }

            // Build optional target sub-object from pluginTarget / scriptTarget
            let target: Value = {
                let pt = &args["pluginTarget"];
                let st = &args["scriptTarget"];
                let has_pt = pt.is_object() && !pt.is_null();
                let has_st = st.is_object() && !st.is_null();
                if has_pt {
                    let sane_str = |v: &Value, max: usize| -> Value {
                        v.as_str().map(|s| task_mcp_normalize_small_text(s, max)).filter(|s| !s.is_empty())
                            .map(Value::String).unwrap_or(Value::Null)
                    };
                    serde_json::json!({
                        "entityLogicalName":  sane_str(&pt["entityLogicalName"], 100),
                        "message":            sane_str(&pt["message"], 60),
                        "stage":              sane_str(&pt["stage"], 30),
                        "mode":               sane_str(&pt["mode"], 20),
                        "pluginProject":      sane_str(&pt["pluginProject"], 200),
                        "filteringAttributes": task_mcp_collect_string_array(&pt["filteringAttributes"], 20, 100),
                        "preImageName":        sane_str(&pt["preImageName"], 100),
                        "preImageAttributes":  task_mcp_collect_string_array(&pt["preImageAttributes"], 20, 100),
                        "postImageName":       sane_str(&pt["postImageName"], 100),
                        "postImageAttributes": task_mcp_collect_string_array(&pt["postImageAttributes"], 20, 100),
                    })
                } else if has_st {
                    let sane_str = |v: &Value, max: usize| -> Value {
                        v.as_str().map(|s| task_mcp_normalize_small_text(s, max)).filter(|s| !s.is_empty())
                            .map(Value::String).unwrap_or(Value::Null)
                    };
                    serde_json::json!({
                        "entityLogicalName": sane_str(&st["entityLogicalName"], 100),
                        "scriptPath":        sane_str(&st["scriptPath"], 500),
                        "webResourceName":   sane_str(&st["webResourceName"], 200),
                        "formName":          sane_str(&st["formName"], 200),
                        "eventName":         sane_str(&st["eventName"], 100),
                        "functionName":      sane_str(&st["functionName"], 200),
                    })
                } else {
                    Value::Null
                }
            };

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];

            let work_kind = task["crmDeveloperWorkflow"]["detectedWorkKind"]
                .as_str()
                .or_else(|| task["workflowSetup"]["devTargetKind"].as_str())
                .unwrap_or("unknown")
                .to_string();
            let now = chrono_now_iso();

            if task["crmDeveloperWorkflow"].is_null() {
                task["crmDeveloperWorkflow"] = serde_json::json!({"createdAt": now});
            }
            let mut plan = serde_json::json!({
                "generatedAt":       now,
                "workKind":          work_kind,
                "summary":           plan_summary,
                "implementationSteps": impl_steps,
                "dataverseFindings": findings,
                "risks":             risks,
                "testChecklist":     test_plan,
                "externalActionPreview": [],
            });
            if !target.is_null() {
                plan["target"] = target;
            }
            task["crmDeveloperWorkflow"]["technicalPlan"] = plan;
            // Clear plan approval since plan changed
            task["crmDeveloperWorkflow"]["planApproval"] = Value::Null;
            task["crmDeveloperWorkflow"]["updatedAt"]    = serde_json::json!(now);
            task_mcp_append_audit_note(task, "save_technical_plan");
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "mark_technical_plan_ready_for_approval" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            if task["crmDeveloperWorkflow"]["technicalPlan"].is_null() {
                return Err("No technical plan saved yet. Use save_technical_plan first.".to_string());
            }
            task["crmDeveloperWorkflow"]["currentStep"] = serde_json::json!("technical-plan");
            task["crmDeveloperWorkflow"]["updatedAt"]   = serde_json::json!(chrono_now_iso());
            task_mcp_append_audit_note(task, "mark_technical_plan_ready_for_approval");
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "record_manual_pr" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let provider = args["provider"].as_str().unwrap_or("unknown").trim();
            if !matches!(provider, "github" | "azure-devops" | "unknown") {
                return Err(format!("Invalid provider '{provider}'. Allowed: github, azure-devops, unknown"));
            }
            let url = task_mcp_normalize_small_text(args["url"].as_str().unwrap_or(""), 500);
            if url.is_empty() { return Err("url cannot be empty.".to_string()); }
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err("url must start with http:// or https://".to_string());
            }
            let title = args["title"].as_str()
                .map(|t| task_mcp_normalize_small_text(t, 300))
                .filter(|s| !s.is_empty());

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            let now = chrono_now_iso();
            if task["crmDeveloperWorkflow"].is_null() {
                task["crmDeveloperWorkflow"] = serde_json::json!({"createdAt": now});
            }
            task["crmDeveloperWorkflow"]["pullRequestTracking"] = serde_json::json!({
                "createdManually": true,
                "createdAt":       now,
                "prUrl":           url,
                "notes":           title.as_deref().unwrap_or(""),
            });
            task["crmDeveloperWorkflow"]["updatedAt"] = serde_json::json!(now);
            // Advance task to review if currently in development
            if task["status"].as_str() == Some("in-progress") {
                task["status"]       = serde_json::json!("ready-for-review");
                task["waitingState"] = serde_json::json!("code-review");
            }
            task_mcp_append_audit_note(task, &format!("record_manual_pr -> {url}"));
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "save_pr_review_analysis" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let summary      = task_mcp_normalize_small_text(args["summary"].as_str().unwrap_or(""), 2000);
            if summary.is_empty() { return Err("summary cannot be empty after sanitization.".to_string()); }
            let action_items = task_mcp_collect_string_array(&args["actionItems"], 20, 300);
            let warnings     = task_mcp_collect_string_array(&args["warnings"], 10, 300);

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            let now = chrono_now_iso();
            if task["crmDeveloperWorkflow"].is_null() {
                task["crmDeveloperWorkflow"] = serde_json::json!({"createdAt": now});
            }
            task["crmDeveloperWorkflow"]["pullRequestReviewAnalysis"] = serde_json::json!({
                "generatedAt":      now,
                "attentionRequired":!action_items.is_empty(),
                "summary":          summary,
                "groupedFindings":  [],
                "actionItems":      action_items,
                "testChecklist":    [],
                "warnings":         warnings,
                "limitations":      [],
            });
            task["crmDeveloperWorkflow"]["updatedAt"] = serde_json::json!(now);
            task_mcp_append_audit_note(task, "save_pr_review_analysis");
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "save_pr_fix_proposal" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let summary     = task_mcp_normalize_small_text(args["summary"].as_str().unwrap_or(""), 2000);
            if summary.is_empty() { return Err("summary cannot be empty after sanitization.".to_string()); }
            let impl_notes  = task_mcp_collect_string_array(&args["implementationNotes"], 10, 300);
            let proposed: Vec<Value> = args["proposedChanges"].as_array()
                .map(|arr| arr.iter().take(10).map(|item| serde_json::json!({
                    "title":       task_mcp_normalize_small_text(item["title"].as_str().unwrap_or(""), 200),
                    "description": task_mcp_normalize_small_text(item["description"].as_str().unwrap_or(""), 500),
                    "confidence":  "medium",
                    "riskLevel":   "medium",
                })).collect())
                .unwrap_or_default();

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            let now = chrono_now_iso();
            if task["crmDeveloperWorkflow"].is_null() {
                task["crmDeveloperWorkflow"] = serde_json::json!({"createdAt": now});
            }
            task["crmDeveloperWorkflow"]["pullRequestFixProposal"] = serde_json::json!({
                "generatedAt":       now,
                "summary":           summary,
                "proposedChanges":   proposed,
                "implementationOrder": impl_notes,
                "testChecklist":     [],
                "warnings":          [],
                "limitations":       [],
                "canGenerateCodeLater": true,
            });
            task["crmDeveloperWorkflow"]["updatedAt"] = serde_json::json!(now);
            task_mcp_append_audit_note(task, "save_pr_fix_proposal");
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "update_task_checklist_item" => {
            let task_id  = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let item_key = args["itemKey"].as_str().unwrap_or("").trim();
            let status   = args["status"].as_str().unwrap_or("").trim();
            if !task_mcp_allowed_checklist_keys().contains(&item_key) {
                return Err(format!("Invalid itemKey '{item_key}'. Allowed: {}", task_mcp_allowed_checklist_keys().join(", ")));
            }
            if !task_mcp_allowed_checklist_statuses().contains(&status) {
                return Err(format!("Invalid status '{status}'. Allowed: {}", task_mcp_allowed_checklist_statuses().join(", ")));
            }
            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            if task["mcpChecklistOverrides"].is_null() { task["mcpChecklistOverrides"] = serde_json::json!({}); }
            task["mcpChecklistOverrides"][item_key] = serde_json::json!(status);
            task_mcp_append_audit_note(task, &format!("update_task_checklist_item -> {item_key}={status}"));
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        "set_task_next_step" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let action = task_mcp_normalize_small_text(args["action"].as_str().unwrap_or(""), 300);
            if action.is_empty() { return Err("action cannot be empty after sanitization.".to_string()); }
            let reason = task_mcp_normalize_small_text(args["reason"].as_str().unwrap_or(""), 500);

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            task["mcpNextStep"] = serde_json::json!({
                "action":    action,
                "reason":    reason,
                "updatedAt": chrono_now_iso(),
            });
            task_mcp_append_audit_note(task, &format!("set_task_next_step -> {action}"));
            updated = true;
            serde_json::json!({"task": task_mcp_safe_task_summary(task)})
        }

        // â”€â”€ run_dataverse_check_for_task â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        "run_dataverse_check_for_task" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".into()); }
            let persist_inferred = args["persistInferredArtifactPath"].as_bool().unwrap_or(true);
            let primary_override = args["primaryEntityOverride"].as_str()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string);

            let task_index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;

            // Clone task for read-only use before mutably borrowing `tasks` later.
            let task_snapshot = tasks[task_index].clone();

            // Resolve artifact path (explicit or inferred).
            let (artifact_path, artifact_inferred) = mcp_resolve_artifact_path(
                app, &task_snapshot, persist_inferred, &mut tasks, task_index
            )?;

            // Detect script tasks â€” JS/TS files are not handled by the C# scanner.
            let lower_path = artifact_path.to_lowercase();
            if lower_path.ends_with(".js") || lower_path.ends_with(".ts") {
                let now = chrono_now_iso();
                let file_name: String = artifact_path.replace('\\', "/")
                    .split('/').last().unwrap_or(artifact_path.as_str()).to_string();
                let msg = format!(
                    "Dataverse check is not supported for script files ({file_name}). \
                     Use the in-app Verify Implementation modal, which handles JavaScript/TypeScript directly."
                );
                let report_id = format!("mcp-{}", now.replace(':', "-"));
                {
                    let task = &mut tasks[task_index];
                    let existing: Vec<Value> = task["crmVerificationReports"]
                        .as_array().cloned().unwrap_or_default();
                    let report_entry = serde_json::json!({
                        "id": report_id,
                        "createdAt": now,
                        "verdict": "unknown",
                        "summary": msg,
                        "answer": msg,
                        "filePath": artifact_path,
                    });
                    let mut reports = vec![report_entry];
                    reports.extend(existing.into_iter().take(4));
                    task["crmVerificationReports"] = Value::Array(reports);
                    task["mcpNextStep"] = serde_json::json!({
                        "action": "Use the in-app Verify Implementation modal for JavaScript/TypeScript Dataverse checks",
                        "reason": "MCP Dataverse check does not support JS/TS files.",
                        "updatedAt": now,
                    });
                    task_mcp_append_audit_note(task, "run_dataverse_check_for_task -> unknown (script file, not supported by MCP scanner)");
                }
                task_mcp_save_tasks(app, &tasks)?;
                return Ok(serde_json::json!({
                    "ok": true,
                    "verdict": "unknown",
                    "status": "not-supported",
                    "message": msg,
                    "taskId": task_id,
                    "artifactPath": artifact_path,
                    "artifactInferred": artifact_inferred,
                }));
            }

            // Read the source file.
            let content = fs::read_to_string(&artifact_path)
                .map_err(|e| format!("Cannot read artifact '{artifact_path}': {e}"))?;

            // Scan C# logical names.
            let primary_entity_for_scan = primary_override.clone()
                .or_else(|| task_snapshot["workflowSetup"]["primaryEntityLogicalName"].as_str().map(str::to_string))
                .or_else(|| {
                    // From technical plan
                    task_snapshot["crmDeveloperWorkflow"]["technicalPlan"]["target"]["entityLogicalName"]
                        .as_str().map(str::to_string)
                });
            let raw_scan = scan_cs_logical_names_for_mcp(&content, primary_entity_for_scan.as_deref());
            let scan: CrmScanResult = serde_json::from_value(raw_scan.clone()).unwrap_or_default();

            // Run Primarch verification.  This is async; create a one-shot Tokio runtime.
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| format!("Failed to create Tokio runtime: {e}"))?;
            let report = rt.block_on(run_crm_verification_for_scan(
                app,
                scan,
                raw_scan.clone(),
                Some(artifact_path.clone()),
                primary_override,
            ))?;

            let verdict      = report["verdict"].as_str().unwrap_or("unknown").to_string();
            let report_id    = format!("mcp-{}", chrono_now_iso().replace(':', "-"));
            let now          = chrono_now_iso();

            // Persist report to task.crmVerificationReports (newest first, cap 5).
            {
                let task = &mut tasks[task_index];
                let existing: Vec<Value> = task["crmVerificationReports"]
                    .as_array().cloned().unwrap_or_default();
                let mut enriched = report.clone();
                enriched["id"]        = Value::String(report_id);
                enriched["createdAt"] = Value::String(now.clone());
                let mut reports = vec![enriched];
                reports.extend(existing.into_iter().take(4));
                task["crmVerificationReports"] = Value::Array(reports);

                // Set next-step hint.
                let next_action = match verdict.as_str() {
                    "pass"     => "Run AI code review or local test",
                    "warnings" => "Review Dataverse warnings before proceeding",
                    "fail"     => "Fix Dataverse metadata issues before development continues",
                    _          => "Confirm setup or entity binding and rerun Dataverse check",
                };
                task["mcpNextStep"] = serde_json::json!({
                    "action":    next_action,
                    "reason":    format!("Dataverse check verdict: {}.", verdict),
                    "updatedAt": now,
                });
                task_mcp_append_audit_note(task, &format!("run_dataverse_check_for_task -> {verdict}"));
            }
            updated = true;

            // Build compact result for MCP caller.
            let confirmed = report["confirmedReferences"].as_array().map(|a| a.len()).unwrap_or(0);
            let missing   = report["missingReferences"].as_array().map(|a| a.len()).unwrap_or(0);
            let ambiguous = report["ambiguousReferences"].as_array().map(|a| a.len()).unwrap_or(0);

            let dv_status = match verdict.as_str() {
                "pass"     => "passed",
                "warnings" => "warnings",
                "fail"     => "failed",
                _          => "unknown",
            };

            let mut verified: Vec<Value> = Vec::new();
            for r in report["confirmedReferences"].as_array().unwrap_or(&vec![]) {
                verified.push(serde_json::json!({
                    "kind": r["kind"],
                    "logicalName": r["displayName"],
                    "entityLogicalName": r["entityLogicalName"],
                    "attributeLogicalName": r["attributeLogicalName"],
                    "status": "found",
                }));
            }
            for r in report["missingReferences"].as_array().unwrap_or(&vec![]) {
                verified.push(serde_json::json!({
                    "kind": r["kind"],
                    "logicalName": r["displayName"],
                    "entityLogicalName": r["entityLogicalName"],
                    "attributeLogicalName": r["attributeLogicalName"],
                    "status": "missing",
                }));
            }
            for r in report["ambiguousReferences"].as_array().unwrap_or(&vec![]) {
                verified.push(serde_json::json!({
                    "kind": r["kind"],
                    "logicalName": r["displayName"],
                    "entityLogicalName": r["entityLogicalName"],
                    "status": "unverified",
                }));
            }

            serde_json::json!({
                "ok": true,
                "taskId": task_id,
                "status": dv_status,
                "artifactPath": artifact_path,
                "artifactInferred": artifact_inferred,
                "confirmed": confirmed,
                "missing": missing,
                "ambiguous": ambiguous,
                "verified": verified,
                "summary": report["summary"],
                "nextStep": match verdict.as_str() {
                    "pass"     => "Run AI code review or local test",
                    "warnings" => "Review Dataverse warnings before proceeding",
                    "fail"     => "Fix Dataverse metadata issues before development continues",
                    _          => "Confirm setup or entity binding and rerun Dataverse check",
                },
                "_diagnostics": {
                    "entitiesExtracted": raw_scan["entities"],
                    "attributesByEntity": raw_scan["attributes"],
                    "primaryEntityInferred": raw_scan["pluginContext"]["primaryEntityName"],
                    "attributeReferenceCount": raw_scan["attributeReferences"].as_array().map(|a| a.len()).unwrap_or(0),
                    "entityReferenceCount": raw_scan["entityReferences"].as_array().map(|a| a.len()).unwrap_or(0),
                },
            })
        }

        // â”€â”€ Git commit/push MCP tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        "prepare_commit_for_task" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".into()); }
            let task_idx = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task_snap = tasks[task_idx].clone();
            let repo_root = mcp_resolve_repo_root_for_task(app, &task_snap)?;
            git_commit_preview_impl(&repo_root, Some(&task_snap))?
        }

        "commit_task_changes" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            let message  = args["message"].as_str().unwrap_or("").trim();
            let files: Vec<String> = args["files"].as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            if task_id.is_empty() { return Err("Missing required argument: taskId".into()); }
            let task_idx = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task_snap = tasks[task_idx].clone();
            let repo_root = mcp_resolve_repo_root_for_task(app, &task_snap)?;
            let result = git_commit_impl(&repo_root, &files, message)?;
            let hash = result["commitHash"].as_str().unwrap_or("?").to_string();
            { let t = &mut tasks[task_idx]; task_mcp_append_audit_note(t, &format!("commit_task_changes -> {hash}")); }
            updated = true;
            result
        }

        "push_task_branch" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".into()); }
            let task_idx = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task_snap = tasks[task_idx].clone();
            let repo_root = mcp_resolve_repo_root_for_task(app, &task_snap)?;
            let result = git_push_impl(&repo_root)?;
            let branch = result["branch"].as_str().unwrap_or("?").to_string();
            { let t = &mut tasks[task_idx]; task_mcp_append_audit_note(t, &format!("push_task_branch -> {branch}")); }
            updated = true;
            result
        }

        "commit_and_push_task_changes" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            let message  = args["message"].as_str().unwrap_or("").trim();
            let files: Vec<String> = args["files"].as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let move_to_review = args["moveToReviewAfterPush"].as_bool().unwrap_or(false);
            if task_id.is_empty() { return Err("Missing required argument: taskId".into()); }
            let task_idx = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task_snap = tasks[task_idx].clone();
            let repo_root = mcp_resolve_repo_root_for_task(app, &task_snap)?;

            // When moving to Review, require a valid merge base so a normal PR can be created.
            if move_to_review {
                if let Some(base) = detect_remote_base_branch(&repo_root) {
                    if !has_merge_base_with_remote(&repo_root, &base) {
                        return Err(format!(
                            "Current branch has no common history with {base}. \
                             A normal PR cannot be created. \
                             Create a branch from {base} first using create_branch_for_task, \
                             then reapply your changes."
                        ));
                    }
                }
            }

            let commit = git_commit_impl(&repo_root, &files, message)?;
            let hash   = commit["commitHash"].as_str().unwrap_or("?").to_string();
            let push   = git_push_impl(&repo_root)?;
            let branch = push["branch"].as_str().unwrap_or("?").to_string();
            { let t = &mut tasks[task_idx]; task_mcp_append_audit_note(t, &format!("commit_and_push_task_changes -> {hash} {branch}")); }
            if move_to_review {
                let now = chrono_now_iso();
                let t = &mut tasks[task_idx];
                t["status"]         = serde_json::json!("ready-for-review");
                t["waitingState"]   = serde_json::json!("code-review");
                t["attentionState"] = Value::Null;
                t["mcpNextStep"]    = serde_json::json!({
                    "action":    "Wait for code review",
                    "reason":    "Changes committed and pushed. Task moved to code review.",
                    "updatedAt": now,
                });
                task_mcp_append_audit_note(t, "set_task_phase -> review (after commit+push)");
            }
            updated = true;
            let summary = if move_to_review {
                format!("Commit {hash} created and branch '{branch}' pushed. Task moved to code review.")
            } else {
                format!("Commit {hash} created and branch '{branch}' pushed.")
            };
            serde_json::json!({ "ok": true, "commitHash": hash, "branch": branch, "movedToReview": move_to_review, "summary": summary })
        }

        "create_branch_for_task" => {
            let task_id     = args["taskId"].as_str().unwrap_or("").trim();
            let branch_name = args["branchName"].as_str().unwrap_or("").trim();
            if task_id.is_empty()     { return Err("Missing required argument: taskId".into()); }
            if branch_name.is_empty() { return Err("Missing required argument: branchName".into()); }
            let task_idx = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task_snap = tasks[task_idx].clone();
            let repo_root = mcp_resolve_repo_root_for_task(app, &task_snap)?;
            let result = create_git_branch_impl(&repo_root, branch_name)?;
            let branch = result["branch"].as_str().unwrap_or("?").to_string();
            { let t = &mut tasks[task_idx]; task_mcp_append_audit_note(t, &format!("create_branch_for_task -> {branch}")); }
            updated = true;
            result
        }

        "mark_testing_confirmed_prepare_commit" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let note = args["note"].as_str()
                .map(|n| task_mcp_normalize_small_text(n, 500))
                .filter(|s| !s.is_empty());

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            let now = chrono_now_iso();
            task["consultantTestRecord"] = serde_json::json!({
                "status":    "confirmed",
                "updatedAt": now,
                "note":      note,
            });
            // Clear consultant-testing waiting state
            if task["waitingState"].as_str() == Some("consultant-testing") {
                task["waitingState"] = Value::Null;
            }
            // Set next step: prepare commit â€” NOT move to review directly
            task["mcpNextStep"] = serde_json::json!({
                "action":    "Prepare commit and push",
                "reason":    "Consultant testing was confirmed. Commit and push are required before code review.",
                "updatedAt": now,
            });
            task_mcp_append_audit_note(task, "record_consultant_testing -> confirmed");
            updated = true;
            serde_json::json!({
                "task": task_mcp_safe_task_summary(task),
                "message": "Consultant testing confirmed. Next step: prepare commit and push using commit_and_push_task_changes."
            })
        }

        // â”€â”€ get_dataverse_verification_report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        "get_dataverse_verification_report" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: id".to_string()); }
            let task = task_mcp_get_task(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let reports: Vec<&Value> = task.get("crmVerificationReports")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().collect())
                .unwrap_or_default();
            let Some(report) = reports.first() else {
                return Ok(serde_json::json!({
                    "taskId": task_id,
                    "hasReport": false,
                    "report": Value::Null,
                    "message": "No Dataverse verification report is stored for this task. Run run_dataverse_check_for_task first.",
                }));
            };
            serde_json::json!({
                "taskId": task_id,
                "hasReport": true,
                "report": {
                    "id":               report["id"],
                    "createdAt":        report["createdAt"],
                    "filePath":         report["filePath"],
                    "verdict":          report["verdict"].as_str().unwrap_or("unknown"),
                    "metadataVerdict":  report["metadataVerdict"],
                    "runtimeReadiness": report["runtimeReadiness"],
                    "summary":          task_mcp_summarize(report["summary"].as_str(), 700),
                    "issueCount":       report["issues"].as_array().map(|a| a.len()).unwrap_or(0),
                    "inspectedEntities": report["inspectedEntities"].as_array().cloned().unwrap_or_default(),
                    "confirmedCount":   report["confirmedReferences"].as_array().map(|a| a.len()).unwrap_or(0),
                    "missingCount":     report["missingReferences"].as_array().map(|a| a.len()).unwrap_or(0),
                    "ambiguousCount":   report["ambiguousReferences"].as_array().map(|a| a.len()).unwrap_or(0),
                    "compileReadiness": report.get("compileReadiness").cloned().unwrap_or(Value::Null),
                },
            })
        }

        // â”€â”€ get_external_action_proposal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        "get_external_action_proposal" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: id".to_string()); }
            let task = task_mcp_get_task(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let wf = task.get("crmDeveloperWorkflow").unwrap_or(&Value::Null);
            let preview: Vec<Value> = wf["technicalPlan"]["externalActionPreview"]
                .as_array().cloned().unwrap_or_default();
            let approval_gate = &wf["externalActionApproval"];
            let execution     = &wf["externalExecution"];
            let has_proposal  = !preview.is_empty() || !approval_gate.is_null();
            if !has_proposal && execution.is_null() {
                return Ok(serde_json::json!({
                    "taskId": task_id,
                    "hasProposal": false,
                    "message": "No external action proposal is present for this task. A technical plan with externalActionPreview is needed first.",
                }));
            }
            let approved = approval_gate["approved"].as_bool().unwrap_or(false)
                && approval_gate["invalidatedAt"].is_null();
            serde_json::json!({
                "taskId": task_id,
                "hasProposal": true,
                "externalActionPreview": preview,
                "approval": {
                    "approved":           approved,
                    "approvedAt":         approval_gate["approvedAt"].as_str(),
                    "invalidatedAt":      approval_gate["invalidatedAt"].as_str(),
                    "invalidationReason": approval_gate["invalidationReason"].as_str(),
                },
                "execution": if execution.is_null() { Value::Null } else { serde_json::json!({
                    "completed":           execution["completed"].as_bool().unwrap_or(false)
                                           && execution["invalidatedAt"].is_null(),
                    "completedAt":         execution["completedAt"].as_str(),
                    "notes":               task_mcp_summarize(execution["notes"].as_str(), 400),
                    "completedActionIds":  execution["completedActionIds"].as_array().cloned().unwrap_or_default(),
                    "invalidatedAt":       execution["invalidatedAt"].as_str(),
                })},
            })
        }

        // â”€â”€ record_external_action_completed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        "record_external_action_completed" => {
            let task_id = args["taskId"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: taskId".to_string()); }
            let action_type = args["actionType"].as_str().unwrap_or("").trim();
            if !task_mcp_allowed_external_action_types().contains(&action_type) {
                return Err(format!("Invalid actionType '{action_type}'. Allowed: {}", task_mcp_allowed_external_action_types().join(", ")));
            }
            let note = args["note"].as_str()
                .map(|n| task_mcp_normalize_small_text(n, 500))
                .filter(|s| !s.is_empty());
            let completed_at = args["completedAt"].as_str()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(chrono_now_iso);

            let index = task_mcp_find_task_index(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let task = &mut tasks[index];
            let now = chrono_now_iso();
            if task["crmDeveloperWorkflow"].is_null() {
                task["crmDeveloperWorkflow"] = serde_json::json!({"createdAt": now});
            }
            // Append actionType to completedActionIds (deduplicated)
            let existing_ids: Vec<String> = task["crmDeveloperWorkflow"]["externalExecution"]["completedActionIds"]
                .as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let mut new_ids = existing_ids;
            if !new_ids.contains(&action_type.to_string()) {
                new_ids.push(action_type.to_string());
            }
            let audit_note_text = note.clone().unwrap_or_else(|| format!("Completed: {action_type}"));
            task["crmDeveloperWorkflow"]["externalExecution"] = serde_json::json!({
                "completed":          true,
                "completedAt":        completed_at,
                "notes":              audit_note_text,
                "completedActionIds": new_ids,
            });
            task["crmDeveloperWorkflow"]["updatedAt"] = serde_json::json!(now);
            task_mcp_append_audit_note(task, &format!("record_external_action_completed -> {action_type}"));
            updated = true;
            serde_json::json!({
                "task": task_mcp_safe_task_summary(task),
                "message": format!("External action '{action_type}' recorded as completed."),
            })
        }

        // â”€â”€ get_implementation_verification_state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        "get_implementation_verification_state" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: id".to_string()); }
            let task = task_mcp_get_task(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let impl_v = task.get("implementationVerification").unwrap_or(&Value::Null);
            serde_json::json!({
                "taskId":              task_id,
                "buildCheck":          impl_v.get("buildCheck").cloned().unwrap_or(Value::Null),
                "dataverseCheck":      impl_v.get("dataverseCheck").cloned().unwrap_or(Value::Null),
                "aiCodeReview":        impl_v.get("aiCodeReview").cloned().unwrap_or(Value::Null),
                "localTest":           impl_v.get("localTest").cloned().unwrap_or(Value::Null),
                "localTestRecord":     task.get("localTestRecord").cloned().unwrap_or(Value::Null),
                "consultantTestRecord":task.get("consultantTestRecord").cloned().unwrap_or(Value::Null),
                "updatedAt":           impl_v.get("updatedAt").cloned().unwrap_or(Value::Null),
            })
        }

        // â”€â”€ get_implementation_readiness â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        "get_implementation_readiness" => {
            let task_id = args["id"].as_str().unwrap_or("").trim();
            if task_id.is_empty() { return Err("Missing required argument: id".to_string()); }
            let task = task_mcp_get_task(&tasks, task_id)
                .ok_or_else(|| format!("Task not found: {task_id}"))?;
            let readiness = task_mcp_implementation_readiness(task);
            serde_json::json!({
                "taskId":                   task_id,
                "isImplementationReady":    readiness["isImplementationReady"],
                "blockers":                 readiness["blockers"],
                "warnings":                 readiness["warnings"],
                "recommendedNextStep":      readiness["recommendedNextStep"],
            })
        }

        _ => return Err(format!("Unknown MCP tool: {tool_name}")),
    };

    if updated {
        eprintln!("[task-mcp-bridge] write tool executed: {tool_name}");
        task_mcp_save_tasks(app, &tasks)?;
        use tauri::Emitter;
        app.emit("tasks-changed-externally", ()).ok();
    }

    Ok(result)
}

fn task_mcp_http_response(status_code: u16, payload: &Value) -> String {
    let body = serde_json::to_string(payload).unwrap_or_else(|_| "{\"error\":\"serialization failed\"}".to_string());
    let status_text = match status_code {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Internal Server Error",
    };

    format!(
        "HTTP/1.1 {status_code} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

fn task_mcp_handle_http_connection(app: &tauri::AppHandle, mut stream: TcpStream) -> Result<(), String> {
    let stream_reader = stream.try_clone().map_err(|e| e.to_string())?;
    let mut reader = io::BufReader::new(stream_reader);

    let mut request_line = String::new();
    reader.read_line(&mut request_line).map_err(|e| e.to_string())?;
    if request_line.trim().is_empty() {
        return Ok(());
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_uppercase();
    let path = parts.next().unwrap_or("");

    let mut content_length: usize = 0;
    let mut request_token = String::new();
    loop {
        let mut header_line = String::new();
        reader.read_line(&mut header_line).map_err(|e| e.to_string())?;
        let trimmed = header_line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().unwrap_or(0);
            } else if name.eq_ignore_ascii_case("x-task-workbench-bridge-token") {
                request_token = value.trim().to_string();
            }
        }
    }

    if content_length > TASK_MCP_MAX_BODY_BYTES {
        let response = task_mcp_http_response(400, &serde_json::json!({"ok": false, "error": "Request body too large."}));
        stream.write_all(response.as_bytes()).map_err(|e| e.to_string())?;
        stream.flush().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let mut body_buf = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body_buf).map_err(|e| e.to_string())?;
    }
    let body_text = String::from_utf8(body_buf).unwrap_or_default();

    let (status, payload) = match (method.as_str(), path) {
        ("GET", "/mcp/status") => {
            (200, serde_json::json!({
                "ok": true,
                "result": task_mcp_current_bridge_state(),
            }))
        }
        ("GET", "/mcp/tools") => {
            (200, serde_json::json!({
                "ok": true,
                "result": {
                    "tools": task_mcp_tool_definitions(),
                    "readOnlyMode": false,
                    "localWriteMode": true,
                },
            }))
        }
        ("POST", "/mcp/tools/call") => {
            if request_token != task_mcp_bridge_token() {
                (401, serde_json::json!({"ok": false, "error": "Missing or invalid bridge token. Fetch GET /mcp/status to obtain the session token."}))
            } else {
                let parsed: Value = serde_json::from_str(&body_text).unwrap_or(Value::Null);
                let name = parsed["name"].as_str().unwrap_or("").to_string();
                let args = parsed.get("args").cloned().unwrap_or_else(|| serde_json::json!({}));
                if name.trim().is_empty() {
                    (400, serde_json::json!({"ok": false, "error": "Missing required property: name"}))
                } else {
                    match task_mcp_execute_tool(app, &name, &args) {
                        Ok(result) => (200, serde_json::json!({"ok": true, "result": result})),
                        Err(err) => (400, serde_json::json!({"ok": false, "error": err})),
                    }
                }
            }
        }
        _ => {
            (404, serde_json::json!({"ok": false, "error": "Endpoint not found."}))
        }
    };

    let response = task_mcp_http_response(status, &payload);
    stream.write_all(response.as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn start_task_mcp_bridge(app: tauri::AppHandle) {
    let app_for_thread = app.clone();
    thread::spawn(move || {
        let listener = match TcpListener::bind((TASK_MCP_BRIDGE_HOST, TASK_MCP_BRIDGE_PORT)) {
            Ok(listener) => listener,
            Err(err) => {
                let msg = format!("Failed to start local MCP bridge on {}:{}: {err}", TASK_MCP_BRIDGE_HOST, TASK_MCP_BRIDGE_PORT);
                eprintln!("[task-mcp-bridge] {msg}");
                task_mcp_update_bridge_state(|state| {
                    state["active"] = Value::Bool(false);
                    state["lastError"] = Value::String(msg.clone());
                });
                return;
            }
        };

        eprintln!("[task-mcp-bridge] active on {}:{}", TASK_MCP_BRIDGE_HOST, TASK_MCP_BRIDGE_PORT);
        task_mcp_update_bridge_state(|state| {
            state["active"] = Value::Bool(true);
            state["lastError"] = Value::Null;
            state["startedAt"] = Value::String(chrono_now_iso());
        });

        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    if let Err(err) = task_mcp_handle_http_connection(&app_for_thread, stream) {
                        eprintln!("[task-mcp-bridge] request error: {err}");
                    }
                }
                Err(err) => {
                    eprintln!("[task-mcp-bridge] incoming connection error: {err}");
                }
            }
        }

        task_mcp_update_bridge_state(|state| {
            state["active"] = Value::Bool(false);
            state["lastError"] = Value::String("Bridge listener stopped.".to_string());
        });
    });
}

#[tauri::command]
fn get_task_mcp_bridge_status() -> Result<Value, String> {
    Ok(task_mcp_current_bridge_state_for_ui())
}

// --- CRM Metadata / Primarch MCP ------------------------------------------

static PRIMARCH_SAFE_TOOL_CACHE: OnceLock<Mutex<HashMap<String, Vec<Value>>>> = OnceLock::new();

fn primarch_tool_cache() -> &'static Mutex<HashMap<String, Vec<Value>>> {
    PRIMARCH_SAFE_TOOL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn primarch_cache_key(cmd_str: &str, args: &[String], working_dir: Option<&str>) -> String {
    format!("{}|{}|{}", cmd_str, args.join("\u{1f}"), working_dir.unwrap_or(""))
}

fn get_cached_safe_tools(cache_key: &str) -> Option<Vec<Value>> {
    primarch_tool_cache().lock().ok().and_then(|cache| cache.get(cache_key).cloned())
}

fn set_cached_safe_tools(cache_key: String, tools: Vec<Value>) {
    if let Ok(mut cache) = primarch_tool_cache().lock() {
        cache.insert(cache_key, tools);
    }
}

fn annotate_safe_tools(tools: Vec<Value>) -> Vec<Value> {
    tools
        .into_iter()
        .filter_map(|t| {
            let name = t["name"].as_str().unwrap_or("").to_string();
            let desc = t["description"].as_str().unwrap_or("");
            if is_read_only_tool(&name, desc) {
                let mut entry = serde_json::json!({
                    "name": name,
                    "description": desc.chars().take(200).collect::<String>(),
                    "readOnly": true,
                });
                // Preserve inputSchema so schema_property_exists() can detect
                // available parameters (limit, top, pageSize, all, etc.).
                if let Some(schema) = t.get("inputSchema") {
                    entry["inputSchema"] = schema.clone();
                }
                Some(entry)
            } else {
                None
            }
        })
        .collect()
}

async fn discover_safe_tools(
    cmd_str: &str,
    args: &[String],
    working_dir: Option<&str>,
) -> Result<Vec<Value>, String> {
    let cache_key = primarch_cache_key(cmd_str, args, working_dir);
    if let Some(cached) = get_cached_safe_tools(&cache_key) {
        return Ok(cached);
    }

    let raw = match timeout(Duration::from_secs(10), mcp_list_tools_raw(cmd_str, args, working_dir)).await {
        Ok(result) => result?,
        Err(_) => return Err("MCP tool discovery timed out after 10 seconds".to_string()),
    };

    let safe_tools = annotate_safe_tools(raw);
    // Only cache when the result contains at least one usable metadata tool.
    // A tools list that contains only primarch_status (Primarch not yet connected)
    // must not be cached â€” it would block all future attempts even after Primarch connects.
    let metadata_names = [
        "list_columns", "list_attributes", "search_columns",
        "get_entity_schema", "entity_schema", "get_table_schema",
        "metadata_query", "describe_table", "describe_entity",
    ];
    let has_metadata_tool = safe_tools.iter().any(|t| {
        let n = t["name"].as_str().unwrap_or("");
        metadata_names.contains(&n)
    });
    if has_metadata_tool {
        set_cached_safe_tools(cache_key, safe_tools.clone());
    }
    Ok(safe_tools)
}

/// Returns true when a tool is safe to call (no write-action signals in name/description).
fn is_read_only_tool(name: &str, description: &str) -> bool {
    let name_lc = name.to_lowercase();
    let desc_lc = description.to_lowercase();
    let write_signals = [
        "create", "update", "delete", "publish", "import", "deploy",
        "assign", "modify", "upsert", "remove", "add", "set", "write", "install",
    ];
    !write_signals.iter().any(|s| name_lc.contains(s) || desc_lc.contains(s))
}

/// Parses a shell-style argument string into tokens (respects double-quoted strings).
fn parse_mcp_args(args_raw: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in args_raw.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ' ' | '\t' if !in_quotes => {
                if !current.is_empty() { result.push(std::mem::take(&mut current)); }
            }
            other => current.push(other),
        }
    }
    if !current.is_empty() { result.push(current); }
    result
}

/// Validates the MCP working directory before passing it to Command::current_dir.
/// Returns Ok(None) when empty (cwd not set), Ok(Some(path)) when path is a valid directory,
/// or Err with a clear message when the path does not exist or points to a file.
fn validate_working_directory(wd: &str) -> Result<Option<String>, String> {
    let trimmed = wd.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    match std::fs::metadata(trimmed) {
        Ok(meta) if meta.is_dir() => Ok(Some(trimmed.to_string())),
        Ok(_) => Err(format!(
            "Working directory points to a file, not a folder. \
             Use its parent folder instead.\nPath: {trimmed}"
        )),
        Err(e) => {
            if e.raw_os_error() == Some(267) {
                return Err(format!(
                    "Working directory is invalid (Windows error 267 â€” path is not a directory). \
                     Check that the working directory field contains a folder path, not the MCP script file.\n\
                     Path: {trimmed}"
                ));
            }
            Err(format!("Working directory does not exist.\nPath: {trimmed}\nError: {e}"))
        }
    }
}

/// Extracts plausible Dataverse logical names from text.
/// Accepts lowercase identifiers such as account, ownerid, fullname, nvr_company.
fn extract_logical_names_from_text(text: &str) -> Vec<String> {
    let mut results = HashSet::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' {
            current.push(ch);
        } else {
            let len = current.len();
            let ok = len >= 3 && len <= 80
                && current.chars().next().map(|c| c.is_ascii_lowercase()).unwrap_or(false);
            if ok { results.insert(current.clone()); }
            current.clear();
        }
    }
    if !current.is_empty() {
        let len = current.len();
        let ok = len >= 3 && len <= 80
            && current.chars().next().map(|c| c.is_ascii_lowercase()).unwrap_or(false);
        if ok { results.insert(current); }
    }
    results.into_iter().collect()
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CrmScanEntityReference {
    logical_name: String,
    source_reason: String,
    context_type: String,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CrmScanAttributeReference {
    logical_name: String,
    entity_logical_name: Option<String>,
    source_reason: String,
    context_type: String,
    related_entity_logical_name: Option<String>,
    option_values: Option<Vec<i64>>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CrmScanRelationshipReference {
    source_entity_logical_name: Option<String>,
    source_attribute_logical_name: String,
    target_entity_logical_name: Option<String>,
    target_attribute_logical_name: String,
    source_reason: String,
    context_type: String,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CrmScanAmbiguousReference {
    kind: String,
    logical_name: String,
    source_reason: String,
    detail: String,
    entity_logical_name: Option<String>,
    related_entity_logical_name: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CrmScanPluginContext {
    primary_entity_name: Option<String>,
    #[serde(default)]
    primary_entity_source: Option<String>,
    messages: Vec<String>,
    #[serde(default)]
    stage: Option<i32>,
    #[serde(default)]
    stage_name: Option<String>,
    #[serde(default)]
    mode: Option<i32>,
    #[serde(default)]
    mode_name: Option<String>,
    filtering_attributes: Vec<String>,
    uses_pre_entity_images: bool,
    uses_post_entity_images: bool,
    image_attributes: HashMap<String, Vec<String>>,
    target_attributes: Vec<String>,
    notes: Vec<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CrmScanLookupAssignment {
    entity_logical_name: Option<String>,
    attribute_logical_name: String,
    target_entity_logical_name: Option<String>,
    source_reason: String,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CrmScanOptionSetAssignment {
    entity_logical_name: Option<String>,
    attribute_logical_name: String,
    value: i64,
    source_reason: String,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CrmScanFieldAccess {
    entity_logical_name: Option<String>,
    attribute_logical_name: String,
    access: String, // "read" | "write"
    source_reason: String,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CrmScanResult {
    entities: Vec<String>,
    ambiguous_attributes: Vec<String>,
    notes: Vec<String>,
    #[serde(default)]
    entity_references: Vec<CrmScanEntityReference>,
    #[serde(default)]
    attribute_references: Vec<CrmScanAttributeReference>,
    #[serde(default)]
    relationship_references: Vec<CrmScanRelationshipReference>,
    #[serde(default)]
    ambiguous_references: Vec<CrmScanAmbiguousReference>,
    plugin_context: Option<CrmScanPluginContext>,
    #[serde(default)]
    lookup_assignments: Vec<CrmScanLookupAssignment>,
    #[serde(default)]
    option_set_assignments: Vec<CrmScanOptionSetAssignment>,
    #[serde(default)]
    field_accesses: Vec<CrmScanFieldAccess>,
}

#[derive(Debug, Clone, Default)]
struct EntityMetadataCacheEntry {
    attributes: HashSet<String>,
    /// Full attribute JSON objects keyed by logical name, for rich metadata validation.
    raw_attrs: HashMap<String, Value>,
    column_count: usize,
    schema_completeness: String,
    tool_used: String,
    paging: Option<String>,
    note: Option<String>,
}

fn collect_logical_names_from_json(value: &Value, names: &mut HashSet<String>) {
    match value {
        Value::String(s) => {
            for token in extract_logical_names_from_text(s) {
                names.insert(token);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_logical_names_from_json(item, names);
            }
        }
        Value::Object(map) => {
            for value in map.values() {
                collect_logical_names_from_json(value, names);
            }
        }
        _ => {}
    }
}

fn collect_column_names(value: &Value, names: &mut HashSet<String>) {
    match value {
        Value::Object(map) => {
            for key in ["logicalName", "logical_name", "schemaName", "schema_name", "attributeName", "attribute_name", "columnName", "column_name", "name"] {
                if let Some(v) = map.get(key).and_then(|x| x.as_str()) {
                    if let Some(logical) = normalize_logical_name(v) {
                        names.insert(logical);
                    }
                }
            }
            for (key, inner) in map {
                if ["result", "payload", "output", "data", "columns", "attributes", "items", "value", "results", "records", "content"].contains(&key.as_str()) {
                    collect_column_names(inner, names);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_column_names(item, names);
            }
        }
        _ => {}
    }
}

fn normalize_logical_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() > 80 {
        return None;
    }
    if trimmed.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && trimmed.chars().next().is_some_and(|c| c.is_ascii_lowercase())
    {
        return Some(trimmed.to_string());
    }
    None
}

fn find_bool_key(value: &Value, keys: &[&str]) -> Option<bool> {
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(v) = map.get(*key).and_then(|x| x.as_bool()) {
                    return Some(v);
                }
            }
            for inner in map.values() {
                if let Some(v) = find_bool_key(inner, keys) {
                    return Some(v);
                }
            }
            None
        }
        Value::Array(items) => {
            for item in items {
                if let Some(v) = find_bool_key(item, keys) {
                    return Some(v);
                }
            }
            None
        }
        _ => None,
    }
}

fn find_count_key(value: &Value, keys: &[&str]) -> Option<u64> {
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(v) = map.get(*key).and_then(|x| x.as_u64()) {
                    return Some(v);
                }
            }
            for inner in map.values() {
                if let Some(v) = find_count_key(inner, keys) {
                    return Some(v);
                }
            }
            None
        }
        Value::Array(items) => {
            for item in items {
                if let Some(v) = find_count_key(item, keys) {
                    return Some(v);
                }
            }
            None
        }
        _ => None,
    }
}

fn has_next_page_token(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            for key in ["nextPage", "next_page", "nextToken", "next_token", "nextPageToken", "continuationToken", "continuation_token", "@odata.nextLink", "nextLink"] {
                if let Some(v) = map.get(key) {
                    if (v.is_string() && !v.as_str().unwrap_or("").trim().is_empty()) || (v.is_number()) {
                        return true;
                    }
                }
            }
            map.values().any(has_next_page_token)
        }
        Value::Array(items) => items.iter().any(has_next_page_token),
        _ => false,
    }
}

/// Recursively collect `logicalName â†’ full attribute JSON object` from a Primarch response.
/// Populates the `attrs` map with whatever attribute objects are found, keyed by their logical name.
fn collect_raw_attribute_metadata(value: &Value, attrs: &mut HashMap<String, Value>) {
    match value {
        Value::Array(items) => {
            for item in items {
                if let Value::Object(_) = item {
                    let ln = ["logicalName", "logical_name", "attributeName", "attribute_name",
                              "schemaName", "schema_name", "columnName", "column_name", "name"]
                        .iter()
                        .find_map(|k| item.get(k).and_then(|v| v.as_str()))
                        .and_then(normalize_logical_name);
                    if let Some(logical) = ln {
                        attrs.entry(logical).or_insert_with(|| item.clone());
                    }
                }
                collect_raw_attribute_metadata(item, attrs);
            }
        }
        Value::Object(map) => {
            for (key, inner) in map {
                if ["columns", "attributes", "items", "data", "results", "value", "records",
                    "content", "payload", "output", "result"].contains(&key.as_str())
                {
                    collect_raw_attribute_metadata(inner, attrs);
                }
            }
        }
        _ => {}
    }
}

/// Returns allowed target entity logical names for a Lookup/Customer/Owner attribute.
fn attr_lookup_targets(attr: &Value) -> Vec<String> {
    let mut targets = Vec::new();
    for key in &["targets", "target", "referencedEntity", "referenced_entity",
                 "targetEntities", "target_entities", "lookupEntity", "referencedEntities"] {
        match attr.get(key) {
            Some(Value::Array(arr)) => {
                for item in arr {
                    let s = item.as_str()
                        .or_else(|| item.get("logicalName").and_then(|v| v.as_str()))
                        .or_else(|| item.get("entityLogicalName").and_then(|v| v.as_str()))
                        .or_else(|| item.get("name").and_then(|v| v.as_str()));
                    if let Some(ln) = s.and_then(normalize_logical_name) {
                        if !targets.contains(&ln) { targets.push(ln); }
                    }
                }
            }
            Some(Value::String(s)) => {
                for part in s.split(',') {
                    if let Some(ln) = normalize_logical_name(part.trim()) {
                        if !targets.contains(&ln) { targets.push(ln); }
                    }
                }
            }
            _ => {}
        }
    }
    targets
}

/// Returns allowed integer option values for a Picklist/State/Status attribute.
fn attr_option_values(attr: &Value) -> Vec<i64> {
    let mut values = Vec::new();
    for key in &["options", "optionSet", "option_set", "choices", "picklist",
                 "picklistValues", "optionValues", "option_values", "optionSetValues"] {
        if let Some(arr) = attr.get(key).and_then(|v| v.as_array()) {
            for item in arr {
                let v = item.get("value").or_else(|| item.get("Value"))
                    .or_else(|| item.get("intValue")).or_else(|| item.get("optionValue"))
                    .and_then(|v| v.as_i64())
                    .or_else(|| item.as_i64());
                if let Some(val) = v {
                    if !values.contains(&val) { values.push(val); }
                }
            }
        }
    }
    values
}

/// Returns `Some(bool)` for a `validFor*` property if the attribute metadata exposes it.
fn attr_valid_for(attr: &Value, direction: &str) -> Option<bool> {
    let keys: &[&str] = match direction {
        "create" => &["validForCreate", "valid_for_create", "isValidForCreate", "createable", "isCreateable", "canCreate"],
        "update" => &["validForUpdate", "valid_for_update", "isValidForUpdate", "updateable", "isUpdateable", "canUpdate"],
        "read"   => &["validForRead", "valid_for_read", "isValidForRead", "readable", "isReadable", "isRetrievable", "retrievable"],
        _ => return None,
    };
    keys.iter().find_map(|k| attr.get(k).and_then(|v| v.as_bool()))
}

fn build_entity_metadata_cache_entry(
    value: &Value,
    tool_name: &str,
    paging: Option<String>,
    supports_paging: bool,
    requested_full: bool,
) -> EntityMetadataCacheEntry {
    let mut attributes = HashSet::new();
    collect_column_names(value, &mut attributes);

    if attributes.is_empty() {
        collect_logical_names_from_json(value, &mut attributes);
    }

    let column_count = attributes.len();
    let has_more = find_bool_key(value, &["hasMore", "has_more", "more"]).unwrap_or(false);
    let total_count = find_count_key(value, &["totalCount", "total_count", "count", "total", "totalColumns", "total_columns"]);
    let has_next_token = has_next_page_token(value);

    let mut schema_completeness = "unknown".to_string();
    let mut note: Option<String> = None;

    if has_more || has_next_token {
        schema_completeness = "incomplete".to_string();
        note = Some("Metadata response indicates more pages or continuation tokens.".to_string());
    } else if let Some(total) = total_count {
        if total as usize > column_count {
            schema_completeness = "incomplete".to_string();
            note = Some(format!("Metadata reported total columns {total}, but only {column_count} were returned."));
        } else {
            schema_completeness = "complete".to_string();
        }
    } else if column_count <= 5 {
        schema_completeness = "incomplete".to_string();
        note = Some(format!("Only {column_count} columns were returned for this entity. The metadata tool response appears truncated."));
    } else if supports_paging && requested_full {
        schema_completeness = "complete".to_string();
    }

    let mut raw_attrs: HashMap<String, Value> = HashMap::new();
    collect_raw_attribute_metadata(value, &mut raw_attrs);

    EntityMetadataCacheEntry {
        attributes,
        raw_attrs,
        column_count,
        schema_completeness,
        tool_used: tool_name.to_string(),
        paging,
        note,
    }
}

fn schema_property_exists(tool: &Value, keys: &[&str]) -> bool {
    let properties = tool["inputSchema"]["properties"].as_object();
    if let Some(props) = properties {
        let key_set: HashSet<String> = props.keys().map(|k| k.to_lowercase()).collect();
        return keys.iter().any(|k| key_set.contains(&k.to_lowercase()));
    }
    false
}

/// Returns MCP config from settings or a clear error if not configured.
fn get_mcp_config(settings: &Value) -> Result<(String, Vec<String>, Option<String>), String> {
    let enabled = settings["crmMetadataEnabled"].as_bool().unwrap_or(false);
    if !enabled {
        return Err("CRM metadata assistant is not enabled. Go to Settings \u{2192} CRM Metadata and enable it.".to_string());
    }
    let cmd_str = settings["primarchMcpCommand"].as_str().unwrap_or("").to_string();
    if cmd_str.is_empty() {
        return Err("MCP command is not configured. Go to Settings \u{2192} CRM Metadata and set the server command.".to_string());
    }
    let args = parse_mcp_args(settings["primarchMcpArgs"].as_str().unwrap_or(""));
    let wd_raw = settings["primarchMcpWorkingDirectory"].as_str().unwrap_or("");
    let working_dir = validate_working_directory(wd_raw)
        .map_err(|e| format!("MCP working directory error: {e}"))?;
    Ok((cmd_str, args, working_dir))
}

/// Find a read-only tool by preferred name substrings (in priority order).
fn find_safe_tool<'a>(tools: &'a [Value], preferred: &[&str]) -> Option<&'a Value> {
    // Exact name match first
    for p in preferred {
        if let Some(t) = tools.iter().find(|t| t["name"].as_str().unwrap_or("") == *p) {
            if is_read_only_tool(t["name"].as_str().unwrap_or(""), t["description"].as_str().unwrap_or("")) {
                return Some(t);
            }
        }
    }
    // Substring match fallback
    for p in preferred {
        if let Some(t) = tools.iter().find(|t| {
            let n = t["name"].as_str().unwrap_or("");
            let d = t["description"].as_str().unwrap_or("");
            n.contains(p) && is_read_only_tool(n, d)
        }) {
            return Some(t);
        }
    }
    None
}

/// Runs the MCP server, sends initialize + tools/list, then kills the process.
async fn mcp_list_tools_raw(cmd_str: &str, args: &[String], working_dir: Option<&str>) -> Result<Vec<Value>, String> {
    let mut cmd = tokio::process::Command::new(cmd_str);
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(dir) = working_dir { if !dir.is_empty() { cmd.current_dir(dir); } }
    #[cfg(target_os = "windows")]
    { cmd.creation_flags(CREATE_NO_WINDOW); }

    let mut child = cmd.spawn().map_err(|e| {
        let wd_info = working_dir.map(|d| format!("\n  Working directory: {d}")).unwrap_or_default();
        let hint = if e.raw_os_error() == Some(267) {
            "\n  Hint: error 267 means the working directory is not a valid folder. \
             Check that the 'Working directory' setting contains a folder path, not the MCP script file."
        } else { "" };
        format!("Failed to start MCP server\n  Command: {cmd_str}\n  Args: {args:?}{wd_info}\n  Error: {e}{hint}")
    })?;
    let mut stdin  = child.stdin.take().ok_or_else(|| "MCP: no stdin".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "MCP: no stdout".to_string())?;

    let result = timeout(Duration::from_secs(10), async {
        let mut reader = TokioBufReader::new(stdout).lines();
        let init_body = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"task-workbench","version":"1.0.0"}}});
        let init = init_body.to_string() + "\n";
        stdin.write_all(init.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        loop {
            let line = reader.next_line().await.map_err(|e| e.to_string())?
                .ok_or_else(|| "MCP closed stdout during initialize".to_string())?;
            if line.is_empty() { continue; }
            let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            if v.get("id") == Some(&serde_json::json!(1)) { break; }
        }
        let notif_body = serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}});
        let notif = notif_body.to_string() + "\n";
        stdin.write_all(notif.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        let list_body = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}});
        let list_msg = list_body.to_string() + "\n";
        stdin.write_all(list_msg.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        loop {
            let line = reader.next_line().await.map_err(|e| e.to_string())?
                .ok_or_else(|| "MCP closed stdout during tools/list".to_string())?;
            if line.is_empty() { continue; }
            let v: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if v.get("id") == Some(&serde_json::json!(2)) {
                if let Some(err) = v.get("error") { return Err(format!("MCP tools/list error: {err}")); }
                return v["result"]["tools"].as_array()
                    .cloned()
                    .ok_or_else(|| "Unexpected tools/list format".to_string());
            }
        }
    }).await;
    let _ = child.kill().await;
    match result {
        Ok(inner) => inner,
        Err(_) => Err("MCP server did not respond within 10 seconds (tools/list)".to_string()),
    }
}

/// Calls a single MCP tool; starts and kills a process per call (stateless MVP).
async fn mcp_call_tool_raw(
    cmd_str: &str, args: &[String], working_dir: Option<&str>,
    tool_name: &str, arguments: Value,
) -> Result<Value, String> {
    let mut cmd = tokio::process::Command::new(cmd_str);
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(dir) = working_dir { if !dir.is_empty() { cmd.current_dir(dir); } }
    #[cfg(target_os = "windows")]
    { cmd.creation_flags(CREATE_NO_WINDOW); }

    let mut child = cmd.spawn().map_err(|e| {
        let wd_info = working_dir.map(|d| format!("\n  Working directory: {d}")).unwrap_or_default();
        let hint = if e.raw_os_error() == Some(267) {
            "\n  Hint: error 267 means the working directory is not a valid folder. \
             Check that the 'Working directory' setting contains a folder path, not the MCP script file."
        } else { "" };
        format!("Failed to start MCP server\n  Command: {cmd_str}\n  Args: {args:?}{wd_info}\n  Error: {e}{hint}")
    })?;
    let mut stdin  = child.stdin.take().ok_or_else(|| "MCP: no stdin".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "MCP: no stdout".to_string())?;

    let result = timeout(Duration::from_secs(20), async {
        let mut reader = TokioBufReader::new(stdout).lines();
        let init_body = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"task-workbench","version":"1.0.0"}}});
        let init = init_body.to_string() + "\n";
        stdin.write_all(init.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        loop {
            let line = reader.next_line().await.map_err(|e| e.to_string())?
                .ok_or_else(|| "MCP closed before initialize response".to_string())?;
            if line.is_empty() { continue; }
            let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            if v.get("id") == Some(&serde_json::json!(1)) { break; }
        }
        let notif_body = serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}});
        let notif = notif_body.to_string() + "\n";
        stdin.write_all(notif.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        let call_body = serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":tool_name,"arguments":arguments}});
        let call_msg = call_body.to_string() + "\n";
        stdin.write_all(call_msg.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        loop {
            let line = reader.next_line().await.map_err(|e| e.to_string())?
                .ok_or_else(|| "MCP closed before tool response".to_string())?;
            if line.is_empty() { continue; }
            let v: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if v.get("id") == Some(&serde_json::json!(3)) {
                if let Some(err) = v.get("error") { return Err(format!("MCP tool '{tool_name}' error: {err}")); }
                return Ok(v["result"].clone());
            }
        }
    }).await;
    let _ = child.kill().await;
    match result {
        Ok(inner) => inner,
        Err(_) => Err(format!("MCP tool '{tool_name}' timed out after 20 seconds")),
    }
}

async fn fetch_entity_schema_metadata(
    cmd_str: &str,
    args: &[String],
    working_dir: Option<&str>,
    tool: &Value,
    tool_name: &str,
    entity_name: &str,
) -> Result<EntityMetadataCacheEntry, String> {
    let mut base_args = serde_json::Map::new();
    if schema_property_exists(tool, &["entityName"]) {
        base_args.insert("entityName".to_string(), Value::String(entity_name.to_string()));
    } else if schema_property_exists(tool, &["logicalName"]) {
        base_args.insert("logicalName".to_string(), Value::String(entity_name.to_string()));
    } else if schema_property_exists(tool, &["tableName"]) {
        base_args.insert("tableName".to_string(), Value::String(entity_name.to_string()));
    } else if schema_property_exists(tool, &["entity"]) {
        base_args.insert("entity".to_string(), Value::String(entity_name.to_string()));
    } else if schema_property_exists(tool, &["table"]) {
        base_args.insert("table".to_string(), Value::String(entity_name.to_string()));
    } else {
        base_args.insert("entityName".to_string(), Value::String(entity_name.to_string()));
    }

    let mut paging_parts: Vec<String> = Vec::new();
    if schema_property_exists(tool, &["all"]) {
        base_args.insert("all".to_string(), Value::Bool(true));
        paging_parts.push("all=true".to_string());
    }
    if schema_property_exists(tool, &["includeAll", "include_all"]) {
        if schema_property_exists(tool, &["includeAll"]) {
            base_args.insert("includeAll".to_string(), Value::Bool(true));
            paging_parts.push("includeAll=true".to_string());
        }
        if schema_property_exists(tool, &["include_all"]) {
            base_args.insert("include_all".to_string(), Value::Bool(true));
            paging_parts.push("include_all=true".to_string());
        }
    }

    let supports_page = schema_property_exists(tool, &["page", "pageNumber", "page_number"]);
    let supports_page_size = schema_property_exists(tool, &["pageSize", "page_size", "limit", "top"]);
    if supports_page_size {
        if schema_property_exists(tool, &["pageSize"]) {
            base_args.insert("pageSize".to_string(), Value::Number(serde_json::Number::from(5000)));
            paging_parts.push("pageSize=5000".to_string());
        }
        if schema_property_exists(tool, &["page_size"]) {
            base_args.insert("page_size".to_string(), Value::Number(serde_json::Number::from(5000)));
            paging_parts.push("page_size=5000".to_string());
        }
        if schema_property_exists(tool, &["limit"]) {
            base_args.insert("limit".to_string(), Value::Number(serde_json::Number::from(5000)));
            paging_parts.push("limit=5000".to_string());
        }
        if schema_property_exists(tool, &["top"]) {
            base_args.insert("top".to_string(), Value::Number(serde_json::Number::from(5000)));
            paging_parts.push("top=5000".to_string());
        }
    }

    let supports_paging = supports_page || supports_page_size;
    let mut merged_attributes: HashSet<String> = HashSet::new();
    let mut merged_raw_attrs: HashMap<String, Value> = HashMap::new();
    let mut note: Option<String> = None;
    let mut page = 1u64;

    let mut schema_completeness = loop {
        let mut call_args = base_args.clone();
        if supports_page {
            if schema_property_exists(tool, &["page"]) {
                call_args.insert("page".to_string(), Value::Number(serde_json::Number::from(page)));
            }
            if schema_property_exists(tool, &["pageNumber"]) {
                call_args.insert("pageNumber".to_string(), Value::Number(serde_json::Number::from(page)));
            }
            if schema_property_exists(tool, &["page_number"]) {
                call_args.insert("page_number".to_string(), Value::Number(serde_json::Number::from(page)));
            }
        }

        let schema_val = mcp_call_tool_raw(cmd_str, args, working_dir, tool_name, Value::Object(call_args)).await?;
        let entry = build_entity_metadata_cache_entry(
            &schema_val,
            tool_name,
            if paging_parts.is_empty() { None } else { Some(paging_parts.join(", ")) },
            supports_paging,
            true,
        );

        merged_attributes.extend(entry.attributes.iter().cloned());
        // Accumulate rich attribute metadata across pages (first occurrence wins)
        for (k, v) in entry.raw_attrs {
            merged_raw_attrs.entry(k).or_insert(v);
        }
        let has_more = find_bool_key(&schema_val, &["hasMore", "has_more", "more"]).unwrap_or(false);
        let has_next = has_next_page_token(&schema_val);
        let should_continue = supports_page && (has_more || has_next);

        if should_continue {
            page += 1;
            if page > 25 {
                note = Some("Paging exceeded 25 pages; metadata collection stopped early.".to_string());
                break "incomplete".to_string();
            }
            continue;
        }

        if supports_page && page > 1 {
            break "complete".to_string();
        } else {
            let completeness = entry.schema_completeness;
            note = entry.note;
            break completeness;
        }
    };

    let column_count = merged_attributes.len();

    // A tool without paging support returns all data in a single response by definition.
    // If no "has_more" / continuation signals were present and a meaningful number of columns
    // came back, treat the response as the complete schema.
    // (If schema_completeness is already "incomplete" from has_more/has_next_token, this is skipped.)
    if schema_completeness == "unknown" && !supports_paging && column_count > 5 {
        schema_completeness = "complete".to_string();
        note = Some(format!(
            "Non-paginated metadata tool ({tool_name}); {column_count} columns received in a single response â€” treated as complete schema.",
        ));
    }

    if schema_completeness == "unknown" && column_count <= 5 {
        schema_completeness = "incomplete".to_string();
        note = Some(format!("Only {column_count} columns were returned for this entity. The metadata tool response appears truncated."));
    }

    if schema_completeness == "unknown" {
        note = note.or(Some("Column metadata completeness could not be proven from tool response metadata.".to_string()));
    }

    Ok(EntityMetadataCacheEntry {
        attributes: merged_attributes,
        raw_attrs: merged_raw_attrs,
        column_count,
        schema_completeness,
        tool_used: tool_name.to_string(),
        paging: if paging_parts.is_empty() { None } else { Some(paging_parts.join(", ")) },
        note,
    })
}

/// Tests connectivity to the Primarch MCP server (tools/list only â€” no Dataverse read).
#[tauri::command]
async fn test_primarch_mcp_connection(app: tauri::AppHandle, settings_override: Option<Value>) -> Result<Value, String> {
    let settings = settings_override.unwrap_or(read_json(&app_data_dir(&app)?.join("settings.json"))?);
    let (cmd_str, args, working_dir) = match get_mcp_config(&settings) {
        Ok(v) => v,
        Err(msg) => return Ok(serde_json::json!({ "status": "not_configured", "message": msg })),
    };
    match discover_safe_tools(&cmd_str, &args, working_dir.as_deref()).await {
        Ok(tools) => Ok(serde_json::json!({
            "status": "connected",
            "toolCount": tools.len(),
            "safeToolCount": tools.len(),
            "message": format!("Connected. Cached {} read-only safe tools.", tools.len())
        })),
        Err(e) => Ok(serde_json::json!({ "status": "error", "message": e })),
    }
}

/// Lists all tools from the Primarch MCP server, annotated with a readOnly safety flag.
#[tauri::command]
async fn list_primarch_mcp_tools(app: tauri::AppHandle) -> Result<Value, String> {
    let settings = read_json(&app_data_dir(&app)?.join("settings.json"))?;
    let (cmd_str, args, working_dir) = match get_mcp_config(&settings) {
        Ok(v) => v,
        Err(msg) => return Ok(serde_json::json!({ "tools": [], "message": msg })),
    };
    match discover_safe_tools(&cmd_str, &args, working_dir.as_deref()).await {
        Ok(tools) => Ok(serde_json::json!({ "tools": tools })),
        Err(e) => Ok(serde_json::json!({ "tools": [], "message": e })),
    }
}

/// Generates a CRM skeleton (pseudo-code proposal) using Primarch MCP metadata + AI.
/// Read-only: only calls metadata query tools on the MCP server, never writes to Dataverse.
#[tauri::command]
async fn generate_crm_skeleton(app: tauri::AppHandle, task: Value, customer: Value, workflow_setup: Value) -> Result<Value, String> {
    let settings = read_json(&app_data_dir(&app)?.join("settings.json"))?;
    let (cmd_str, args, working_dir) = match get_mcp_config(&settings) {
        Ok(v) => v,
        Err(msg) => return Ok(serde_json::json!({
            "mode": "script",
            "summary": msg,
            "pseudoCode": "",
            "logicalNamesUsed": [],
            "metadataInspected": {"entityLogicalNames":[],"attributeLogicalNames":{},"toolsUsed":[]}
        })),
    };

    let title    = task["title"].as_str().unwrap_or("").to_string();
    let message  = task["originalMessage"].as_str().unwrap_or("").to_string();
    let ns       = customer["namespace"].as_str().unwrap_or("").to_string();
    let dev_kind = workflow_setup["devTargetKind"].as_str().unwrap_or("script").to_string();
    let mode     = if dev_kind == "plugin" { "plugin" } else { "script" };

    let candidate_entities: Vec<String> = extract_logical_names_from_text(&format!("{title} {message}"))
        .into_iter().take(5).collect();

    let tools = match discover_safe_tools(&cmd_str, &args, working_dir.as_deref()).await {
        Ok(tools) => tools,
        Err(msg) => return Ok(serde_json::json!({
            "mode": mode,
            "summary": msg,
            "pseudoCode": "",
            "logicalNamesUsed": [],
            "metadataInspected": {"entityLogicalNames":[],"attributeLogicalNames":{},"toolsUsed":[]}
        })),
    };
    let schema_tool = find_safe_tool(&tools, &[
        "get_entity_schema", "entity_schema", "get_table_schema", "metadata_query", "list_columns",
    ]);

    let mut metadata_sections: Vec<String> = Vec::new();
    let mut tools_used: Vec<String> = Vec::new();
    let mut inspected_entities: Vec<String> = Vec::new();
    let mut inspected_attrs: HashMap<String, Vec<String>> = HashMap::new();

    if let Some(tool) = schema_tool {
        let tn = tool["name"].as_str().unwrap_or("").to_string();
        tools_used.push(tn.clone());
        for entity in &candidate_entities {
            let arg = serde_json::json!({"entityName": entity});
            if let Ok(schema_val) = mcp_call_tool_raw(&cmd_str, &args, working_dir.as_deref(), &tn, arg).await {
                inspected_entities.push(entity.clone());
                let s = serde_json::to_string(&schema_val).unwrap_or_default();
                let attrs: Vec<String> = extract_logical_names_from_text(&s).into_iter().take(20).collect();
                inspected_attrs.insert(entity.clone(), attrs);
                let short = &s[..s.len().min(1500)];
                metadata_sections.push(format!("Entity '{entity}' schema:\n{short}"));
            }
        }
    }

    let metadata_ctx = if metadata_sections.is_empty() {
        if schema_tool.is_none() {
            "No safe metadata-read tool found on MCP server. Skeleton uses placeholder logical names.".to_string()
        } else {
            "No entity schemas retrieved from task context. Skeleton uses placeholder logical names.".to_string()
        }
    } else {
        format!("CRM metadata from Primarch MCP:\n\n{}", metadata_sections.join("\n\n"))
    };

    let mode_hint = if mode == "plugin" {
        "C# Dataverse plugin pseudo-code (IPlugin, Execute method, Entity/IOrganizationService patterns)"
    } else {
        "JavaScript NVR-style script pseudo-code (namespaced handlers, formContext.getAttribute, Xrm.WebApi)"
    };
    let instructions = format!(
        "You are a Dynamics 365 developer assistant. Generate a {mode_hint} skeleton using real logical names from the metadata. \
Include confirmed names. Show which metadata was inspected. Return ONLY valid JSON without markdown fences."
    );
    let prompt = format!(
        "Task: {title}\nCustomer namespace: {ns}\nDev mode: {mode}\n\n{metadata_ctx}\n\n\
Return ONLY this JSON:\n{{\"summary\":\"one-sentence what this skeleton does\",\"pseudoCode\":\"// skeleton here\",\"logicalNamesUsed\":[\"entity_name\"]}}"
    );

    let ai_config = get_ai_config(&app).map_err(|e| format!("AI not configured: {e}"))?;
    let text = call_ai_text(&ai_config, &instructions, &prompt).await?;
    let parsed: Value = serde_json::from_str(strip_fences(&text)).unwrap_or_else(|_| serde_json::json!({
        "summary": "Skeleton generation failed â€” could not parse AI response.",
        "pseudoCode": &text[..text.len().min(2000)],
        "logicalNamesUsed": []
    }));

    Ok(serde_json::json!({
        "mode": mode,
        "summary": parsed["summary"],
        "pseudoCode": parsed["pseudoCode"],
        "logicalNamesUsed": parsed["logicalNamesUsed"],
        "metadataInspected": {
            "entityLogicalNames": inspected_entities,
            "attributeLogicalNames": inspected_attrs,
            "toolsUsed": tools_used
        }
    }))
}

/// Computes the staticInferenceConfidence value from a scan result.
/// For C# plugins: driven by plugin_context.primary_entity_source.
/// For JS/TS files: "inferred" when a primary_form_entity reference is present; "low" when
/// attribute references exist but no entity was inferred; otherwise "unknown".
fn compute_static_inference_confidence(scan: &CrmScanResult) -> &'static str {
    if let Some(plugin_context) = &scan.plugin_context {
        match (plugin_context.primary_entity_name.is_some(), plugin_context.primary_entity_source.as_deref()) {
            (true, Some("manual_override")) => "high",
            (true, _) if scan.ambiguous_attributes.is_empty() => "high",
            (true, _) => "medium",
            (false, _) if !scan.attribute_references.is_empty() => "low",
            _ => "unknown",
        }
    } else {
        let has_primary_form_entity = scan.entity_references.iter()
            .any(|r| r.context_type == "primary_form_entity");
        if has_primary_form_entity {
            "inferred"
        } else if !scan.attribute_references.is_empty() {
            "low"
        } else {
            "unknown"
        }
    }
}

/// Returns true if a raw MCP response text suggests "not found" for an exact attribute lookup.
fn response_text_says_not_found(response: &Value) -> bool {
    if let Some(content) = response.get("content") {
        if let Some(arr) = content.as_array() {
            if arr.is_empty() { return true; }
            return arr.iter().all(|item| {
                let text = item["text"].as_str().unwrap_or("").to_lowercase();
                text.is_empty() || text.contains("not found") || text.contains("does not exist")
                    || text.contains("no attribute") || text.contains("no column")
            });
        }
        return content.is_null();
    }
    false
}

/// Attempts an exact attribute existence check via Primarch MCP tools.
///
/// Tries, in order:
///   1. A dedicated get/describe tool for single-attribute lookup (get_column, get_attribute, â€¦)
///   2. list_columns / search_columns with a search/filter parameter
///
/// Returns `(Some(true), tool, reason)` = attribute found,
///         `(Some(false), tool, reason)` = attribute definitively absent,
///         `(None, "none", reason)` = could not determine (reason explains why).
async fn try_exact_column_lookup(
    cmd_str: &str,
    args: &[String],
    working_dir: Option<&str>,
    tools: &[Value],
    entity_name: &str,
    attribute_name: &str,
) -> (Option<bool>, String, String) {
    // â”€â”€ 1. Dedicated get/describe-attribute tool â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if let Some(tool) = find_safe_tool(tools, &[
        "get_column", "get_attribute", "describe_column", "describe_attribute",
        "column_metadata", "attribute_metadata", "get_table_column",
    ]) {
        let tname = tool["name"].as_str().unwrap_or("").to_string();
        let mut call_args = serde_json::Map::new();
        for key in &["entityName", "entity", "tableName", "table", "logicalName"] {
            if schema_property_exists(tool, &[key]) {
                call_args.insert(key.to_string(), Value::String(entity_name.to_string()));
                break;
            }
        }
        let attr_keys: &[&str] = &["attributeName", "attribute_name", "columnName", "column_name", "name"];
        let mut attr_param_set = false;
        for key in attr_keys {
            if schema_property_exists(tool, &[key]) {
                call_args.insert(key.to_string(), Value::String(attribute_name.to_string()));
                attr_param_set = true;
                break;
            }
        }
        if attr_param_set {
            let args_json = serde_json::to_string(&call_args).unwrap_or_default();
            match timeout(
                Duration::from_secs(15),
                mcp_call_tool_raw(cmd_str, args, working_dir, &tname, Value::Object(call_args)),
            ).await {
                Ok(Ok(response)) => {
                    let mut found_names: HashSet<String> = HashSet::new();
                    collect_column_names(&response, &mut found_names);
                    if found_names.contains(attribute_name) {
                        return (Some(true), tname.clone(), format!("tool={tname} args={args_json} â†’ found in response"));
                    }
                    if response_text_says_not_found(&response) || found_names.is_empty() {
                        return (Some(false), tname.clone(), format!("tool={tname} args={args_json} â†’ empty/not-found response"));
                    }
                    return (None, tname.clone(), format!("tool={tname} args={args_json} â†’ response contained other columns but not '{attribute_name}' (possible partial result)"));
                }
                Ok(Err(e)) => {
                    return (None, tname.clone(), format!("tool={tname} args={args_json} â†’ call error: {e}"));
                }
                Err(_) => {
                    return (None, tname.clone(), format!("tool={tname} args={args_json} â†’ timed out"));
                }
            }
        }
    }

    // â”€â”€ 2. list_columns / search_columns with filter/search param â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if let Some(tool) = find_safe_tool(tools, &[
        "search_columns", "list_columns", "list_attributes", "search_attributes",
    ]) {
        let tname = tool["name"].as_str().unwrap_or("").to_string();
        let params: Vec<String> = tool["inputSchema"]["properties"]
            .as_object()
            .map(|p| p.keys().cloned().collect())
            .unwrap_or_default();
        let search_param = if schema_property_exists(tool, &["searchTerm"]) { Some("searchTerm") }
            else if schema_property_exists(tool, &["search_term"]) { Some("search_term") }
            else if schema_property_exists(tool, &["search"]) { Some("search") }
            else if schema_property_exists(tool, &["filter"]) { Some("filter") }
            else { None };
        if let Some(sparam) = search_param {
            let mut call_args = serde_json::Map::new();
            for key in &["entityName", "entity", "logicalName", "tableName", "table"] {
                if schema_property_exists(tool, &[key]) {
                    call_args.insert(key.to_string(), Value::String(entity_name.to_string()));
                    break;
                }
            }
            call_args.insert(sparam.to_string(), Value::String(attribute_name.to_string()));
            let args_json = serde_json::to_string(&call_args).unwrap_or_default();
            match timeout(
                Duration::from_secs(15),
                mcp_call_tool_raw(cmd_str, args, working_dir, &tname, Value::Object(call_args)),
            ).await {
                Ok(Ok(response)) => {
                    let mut found_names: HashSet<String> = HashSet::new();
                    collect_column_names(&response, &mut found_names);
                    if found_names.contains(attribute_name) {
                        return (Some(true), tname.clone(), format!("tool={tname} {sparam}={attribute_name} args={args_json} â†’ found in response"));
                    }
                    if found_names.is_empty() {
                        return (Some(false), tname.clone(), format!("tool={tname} {sparam}={attribute_name} args={args_json} â†’ zero results, attribute absent"));
                    }
                    return (None, tname.clone(), format!("tool={tname} {sparam}={attribute_name} args={args_json} â†’ {n} results but no exact match (possibly substring search)", n = found_names.len()));
                }
                Ok(Err(e)) => {
                    return (None, tname.clone(), format!("tool={tname} {sparam}={attribute_name} args={args_json} â†’ call error: {e}"));
                }
                Err(_) => {
                    return (None, tname.clone(), format!("tool={tname} {sparam}={attribute_name} args={args_json} â†’ timed out"));
                }
            }
        } else {
            // Tool found but has no filter/search param â€” cannot do exact lookup via this tool
            return (None, tname.clone(), format!(
                "tool={tname} has no searchTerm/search/filter parameter (available params: {}); exact lookup not possible via this tool",
                params.join(", "),
            ));
        }
    }

    (None, "none".to_string(), "No dedicated exact-attribute tool or filterable search tool found in Primarch tool list".to_string())
}

/// Verifies CRM references extracted from a source file against Primarch MCP metadata.
/// Core Dataverse metadata verification logic, shared by the Tauri command and the MCP tool.
/// Takes a pre-parsed CrmScanResult and its original JSON representation (for embedding in output).
/// Never writes to Dataverse.
async fn run_crm_verification_for_scan(
    app: &tauri::AppHandle,
    scan: CrmScanResult,
    raw_scan_result: Value,
    file_path: Option<String>,
    primary_entity_override: Option<String>,
) -> Result<Value, String> {
    let settings = load_settings(app.clone())?;

    let local_scan_only_ambiguous: Vec<Value> = {
        let mut refs: Vec<Value> = Vec::new();
        for ambiguous in &scan.ambiguous_references {
            refs.push(serde_json::json!({
                "kind": ambiguous.kind,
                "displayName": ambiguous.logical_name,
                "entityLogicalName": ambiguous.entity_logical_name,
                "relatedEntityLogicalName": ambiguous.related_entity_logical_name,
                "sourceReason": ambiguous.source_reason,
                "detail": format!("Local scan only â€” not checked against Dataverse. {}", ambiguous.detail),
            }));
        }
        for attr_ref in &scan.attribute_references {
            if attr_ref.entity_logical_name.is_none() {
                refs.push(serde_json::json!({
                    "kind": "attribute",
                    "displayName": attr_ref.logical_name,
                    "attributeLogicalName": attr_ref.logical_name,
                    "sourceReason": attr_ref.source_reason,
                    "detail": "Local scan only â€” not checked against Dataverse.",
                }));
            }
        }
        refs
    };

    let default_report = |verdict: &str, metadata_verdict: &str, summary: String| {
        serde_json::json!({
            "filePath": file_path,
            "verdict": verdict,
            "metadataVerdict": metadata_verdict,
            "staticInferenceConfidence": "unknown",
            "runtimeReadiness": "unknown",
            "summary": summary,
            "answer": summary,
            "issues": [],
            "confirmedReferences": [],
            "missingReferences": [],
            "ambiguousReferences": local_scan_only_ambiguous,
            "runtimeRisks": [],
            "pluginChecks": [],
            "inspectedEntities": [],
            "inspectedAttributesByEntity": {},
            "unableToVerifyReasons": ["Dataverse metadata was not inspected. This is not a CRM verification result."],
            "compileReadiness": { "status": "not_checked", "detail": "Compile readiness was not checked during metadata verification." },
            "metadataInspected": {"entityLogicalNames":[],"attributeLogicalNames":{},"entityDetails":[],"toolsUsed":[]},
            "rawExtractedReferences": raw_scan_result,
        })
    };

    let (cmd_str, args, working_dir) = match get_mcp_config(&settings) {
        Ok(v) => v,
        Err(_) => return Ok(default_report(
            "not_configured",
            "unknown",
            "Local reference scan completed, but Dataverse verification was skipped because Primarch MCP is not configured.".to_string(),
        )),
    };

    let verification: Result<Result<Value, String>, tokio::time::error::Elapsed> = timeout(Duration::from_secs(60), async {
        let tools = match discover_safe_tools(&cmd_str, &args, working_dir.as_deref()).await {
            Ok(tools) => tools,
            Err(msg) => return Ok::<Value, String>(default_report("error", "unknown", format!("Verification could not be completed. {msg}"))),
        };

        let metadata_tool = find_safe_tool(&tools, &[
            "list_columns",
            "list_attributes",
            "search_columns",
            "get_entity_schema",
            "entity_schema",
            "get_table_schema",
            "metadata_query",
            "describe_table",
            "describe_entity",
        ]);

        if metadata_tool.is_none() {
            return Ok::<Value, String>(default_report(
                "not_configured",
                "unknown",
                "Dataverse metadata was not inspected. This is not a CRM verification result.".to_string(),
            ));
        }

        let mut issues: Vec<Value> = Vec::new();
        let mut confirmed_references: Vec<Value> = Vec::new();
        let mut missing_references: Vec<Value> = Vec::new();
        let mut ambiguous_references: Vec<Value> = Vec::new();
        let mut runtime_risks: Vec<Value> = Vec::new();
        let mut plugin_checks: Vec<Value> = Vec::new();
        let mut unable_to_verify_reasons: Vec<String> = Vec::new();
        let mut inspected_entities: Vec<String> = Vec::new();
        let mut inspected_attrs: HashMap<String, Vec<String>> = HashMap::new();
        let mut inspected_entity_details: Vec<Value> = Vec::new();
        let mut entity_cache: HashMap<String, EntityMetadataCacheEntry> = HashMap::new();
        // Separate tracking for exact-lookup-confirmed missing (bypasses defensive guard).
        let mut exact_missing_refs: Vec<Value> = Vec::new();
        let mut exact_issues: Vec<Value> = Vec::new();
        // (entity, attr, completeness, col_count, source_reason, context_type, related_entity)
        let mut attrs_needing_exact_lookup: Vec<(String, String, String, usize, String, String, Option<String>)> = Vec::new();

        let tool = metadata_tool.expect("checked above");
        let metadata_tool_name = tool["name"].as_str().unwrap_or("").to_string();
        let tool_name = metadata_tool_name.clone();

        // Capture discovered tool names and primary tool parameter list for diagnostics.
        let discovered_tool_names: Vec<String> = tools.iter()
            .filter_map(|t| t["name"].as_str().map(str::to_string))
            .collect();
        let metadata_tool_params: Vec<String> = tool["inputSchema"]["properties"]
            .as_object()
            .map(|props| props.keys().cloned().collect())
            .unwrap_or_default();

        let mut entity_names: Vec<String> = scan.entities.clone();
        for entity_ref in &scan.entity_references {
            if !entity_ref.logical_name.is_empty() {
                entity_names.push(entity_ref.logical_name.clone());
            }
        }
        for attr_ref in &scan.attribute_references {
            if let Some(entity_name) = &attr_ref.entity_logical_name {
                entity_names.push(entity_name.clone());
            }
        }
        for relation in &scan.relationship_references {
            if let Some(entity_name) = &relation.source_entity_logical_name {
                entity_names.push(entity_name.clone());
            }
            if let Some(entity_name) = &relation.target_entity_logical_name {
                entity_names.push(entity_name.clone());
            }
        }
        if let Some(plugin_context) = &scan.plugin_context {
            if let Some(entity_name) = &plugin_context.primary_entity_name {
                entity_names.push(entity_name.clone());
            }
        }
        entity_names.sort();
        entity_names.dedup();

        for entity_name in &entity_names {
            if entity_name.is_empty() {
                continue;
            }
            match timeout(
                Duration::from_secs(30),
                fetch_entity_schema_metadata(&cmd_str, &args, working_dir.as_deref(), tool, &tool_name, entity_name),
            ).await {
                Ok(Ok(cache_entry)) => {
                    inspected_entities.push(entity_name.clone());
                    let mut sorted_attrs: Vec<String> = cache_entry.attributes.iter().cloned().collect();
                    sorted_attrs.sort();
                    inspected_attrs.insert(entity_name.clone(), sorted_attrs.clone());
                    inspected_entity_details.push(serde_json::json!({
                        "entityLogicalName": entity_name,
                        "columnCount": cache_entry.column_count,
                        "schemaCompleteness": cache_entry.schema_completeness,
                        "toolUsed": cache_entry.tool_used,
                        "paging": cache_entry.paging,
                        "note": cache_entry.note,
                    }));

                    if cache_entry.schema_completeness == "incomplete" {
                        unable_to_verify_reasons.push(format!(
                            "Column metadata for entity '{}' was incomplete; only {} columns were returned.",
                            entity_name,
                            cache_entry.column_count,
                        ));
                    } else if cache_entry.schema_completeness == "unknown" {
                        unable_to_verify_reasons.push(format!(
                            "Column metadata completeness for entity '{}' could not be proven from the MCP response.",
                            entity_name,
                        ));
                    }

                    entity_cache.insert(entity_name.clone(), cache_entry);
                }
                Ok(Err(err)) => {
                    unable_to_verify_reasons.push(format!("Entity '{}' could not be inspected: {}", entity_name, err));
                    inspected_entity_details.push(serde_json::json!({
                        "entityLogicalName": entity_name,
                        "columnCount": 0,
                        "schemaCompleteness": "unknown",
                        "toolUsed": tool_name,
                        "note": err,
                    }));
                }
                Err(_) => {
                    let detail = format!("Inspecting entity '{}' timed out after 30 seconds.", entity_name);
                    unable_to_verify_reasons.push(detail.clone());
                    inspected_entity_details.push(serde_json::json!({
                        "entityLogicalName": entity_name,
                        "columnCount": 0,
                        "schemaCompleteness": "unknown",
                        "toolUsed": tool_name,
                        "note": detail,
                    }));
                }
            }
        }

        for entity_ref in &scan.entity_references {
            if entity_cache.contains_key(&entity_ref.logical_name) {
                confirmed_references.push(serde_json::json!({
                    "kind": "entity",
                    "displayName": entity_ref.logical_name,
                    "entityLogicalName": entity_ref.logical_name,
                    "sourceReason": entity_ref.source_reason,
                    "detail": format!("Detected via {}", entity_ref.context_type),
                }));
            }
        }

        for attr_ref in &scan.attribute_references {
            let Some(entity_name) = &attr_ref.entity_logical_name else {
                ambiguous_references.push(serde_json::json!({
                    "kind": "attribute",
                    "displayName": attr_ref.logical_name,
                    "attributeLogicalName": attr_ref.logical_name,
                    "sourceReason": attr_ref.source_reason,
                    "detail": "Could not infer the entity for this attribute statically.",
                }));
                continue;
            };

            match entity_cache.get(entity_name) {
                Some(cache_entry) if cache_entry.attributes.contains(&attr_ref.logical_name) => {
                    if cache_entry.schema_completeness == "complete" {
                        confirmed_references.push(serde_json::json!({
                            "kind": "attribute",
                            "displayName": format!("{}.{}", entity_name, attr_ref.logical_name),
                            "entityLogicalName": entity_name,
                            "attributeLogicalName": attr_ref.logical_name,
                            "relatedEntityLogicalName": attr_ref.related_entity_logical_name,
                            "sourceReason": attr_ref.source_reason,
                            "detail": format!("Detected via {}", attr_ref.context_type),
                        }));
                    } else {
                        // Attribute appears in the partial response but schema is incomplete â€”
                        // treat as ambiguous so as not to overstate verification quality.
                        ambiguous_references.push(serde_json::json!({
                            "kind": "attribute",
                            "displayName": format!("{}.{}", entity_name, attr_ref.logical_name),
                            "entityLogicalName": entity_name,
                            "attributeLogicalName": attr_ref.logical_name,
                            "relatedEntityLogicalName": attr_ref.related_entity_logical_name,
                            "sourceReason": attr_ref.source_reason,
                            "detail": format!(
                                "Attribute present in {} schema ({} columns returned), but schema completeness is unverified â€” cannot fully confirm.",
                                cache_entry.schema_completeness,
                                cache_entry.column_count,
                            ),
                        }));
                    }
                }
                Some(cache_entry) if cache_entry.schema_completeness == "complete" => {
                    missing_references.push(serde_json::json!({
                        "kind": "attribute",
                        "displayName": format!("{}.{}", entity_name, attr_ref.logical_name),
                        "entityLogicalName": entity_name,
                        "attributeLogicalName": attr_ref.logical_name,
                        "relatedEntityLogicalName": attr_ref.related_entity_logical_name,
                        "sourceReason": attr_ref.source_reason,
                        "detail": format!("Detected via {} (complete schema)", attr_ref.context_type),
                    }));
                    issues.push(serde_json::json!({
                        "severity": "error",
                        "category": "missing",
                        "code": "ATTRIBUTE_NOT_FOUND",
                        "title": format!("Attribute '{}.{}' was not found", entity_name, attr_ref.logical_name),
                        "detail": format!("The attribute was detected {} but is missing from a complete inspected schema.", attr_ref.source_reason),
                        "entityLogicalName": entity_name,
                        "attributeLogicalName": attr_ref.logical_name,
                        "relatedEntityLogicalName": attr_ref.related_entity_logical_name,
                        "sourceReason": attr_ref.source_reason,
                    }));
                }
                Some(cache_entry) => {
                    // Attribute absent from list_columns result; schema completeness is unknown/incomplete.
                    // Queue for exact attribute lookup which can give a definitive found/missing answer.
                    attrs_needing_exact_lookup.push((
                        entity_name.clone(),
                        attr_ref.logical_name.clone(),
                        cache_entry.schema_completeness.clone(),
                        cache_entry.column_count,
                        attr_ref.source_reason.clone(),
                        attr_ref.context_type.clone(),
                        attr_ref.related_entity_logical_name.clone(),
                    ));
                }
                None => {
                    ambiguous_references.push(serde_json::json!({
                        "kind": "attribute",
                        "displayName": format!("{}.{}", entity_name, attr_ref.logical_name),
                        "entityLogicalName": entity_name,
                        "attributeLogicalName": attr_ref.logical_name,
                        "relatedEntityLogicalName": attr_ref.related_entity_logical_name,
                        "sourceReason": attr_ref.source_reason,
                        "detail": "The owning entity could not be inspected successfully.",
                    }));
                }
            }

            if attr_ref.option_values.as_ref().is_some_and(|values| !values.is_empty()) {
                unable_to_verify_reasons.push(format!(
                    "Option set values for '{}.{}' were detected in code, but the current metadata tool did not expose enough option metadata to verify them.",
                    entity_name,
                    attr_ref.logical_name,
                ));
            }
        }

        // â”€â”€ Exact attribute lookup for inconclusive schema results â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // For each attribute that was absent from list_columns with unknown/incomplete completeness,
        // try an exact per-attribute MCP lookup to get a definitive found/missing verdict.
        for (entity, attr, completeness, col_count, source_reason, context_type, related_entity) in &attrs_needing_exact_lookup {
            let (exact_result, _lookup_tool, lookup_reason) = try_exact_column_lookup(
                &cmd_str, &args, working_dir.as_deref(), &tools, entity, attr,
            ).await;
            match exact_result {
                Some(true) => {
                    confirmed_references.push(serde_json::json!({
                        "kind": "attribute",
                        "displayName": format!("{}.{}", entity, attr),
                        "entityLogicalName": entity,
                        "attributeLogicalName": attr,
                        "relatedEntityLogicalName": related_entity,
                        "sourceReason": source_reason,
                        "detail": format!("Confirmed via exact attribute lookup ({lookup_reason}; detected via {context_type})."),
                    }));
                }
                Some(false) => {
                    exact_missing_refs.push(serde_json::json!({
                        "kind": "attribute",
                        "displayName": format!("{}.{}", entity, attr),
                        "entityLogicalName": entity,
                        "attributeLogicalName": attr,
                        "relatedEntityLogicalName": related_entity,
                        "sourceReason": source_reason,
                        "detail": format!(
                            "Attribute not found in Dataverse (confirmed by exact lookup: {lookup_reason}; \
                             initial list returned {col_count} columns with {completeness} completeness).",
                        ),
                    }));
                    exact_issues.push(serde_json::json!({
                        "severity": "error",
                        "category": "missing",
                        "code": "ATTRIBUTE_NOT_FOUND",
                        "title": format!("Attribute '{}.{}' was not found in Dataverse", entity, attr),
                        "detail": format!(
                            "Exact lookup returned no match for attribute '{attr}' on entity '{entity}': {lookup_reason}.",
                        ),
                        "entityLogicalName": entity,
                        "attributeLogicalName": attr,
                        "sourceReason": source_reason,
                    }));
                }
                None => {
                    // Exact lookup unavailable or inconclusive â€” report as ambiguous with full diagnostic
                    ambiguous_references.push(serde_json::json!({
                        "kind": "attribute",
                        "displayName": format!("{}.{}", entity, attr),
                        "entityLogicalName": entity,
                        "attributeLogicalName": attr,
                        "relatedEntityLogicalName": related_entity,
                        "sourceReason": source_reason,
                        "detail": format!(
                            "Could not verify against {completeness} schema ({col_count} columns). \
                             Exact attribute lookup: {lookup_reason}.",
                        ),
                    }));
                }
            }
        }

        for relation in &scan.relationship_references {
            match (&relation.source_entity_logical_name, &relation.target_entity_logical_name) {
                (Some(source_entity), Some(target_entity)) => {
                    let source_entry = entity_cache.get(source_entity);
                    let target_entry = entity_cache.get(target_entity);
                    let source_ok = source_entry
                        .map(|entry| entry.attributes.contains(&relation.source_attribute_logical_name))
                        .unwrap_or(false);
                    let target_ok = target_entry
                        .map(|entry| entry.attributes.contains(&relation.target_attribute_logical_name))
                        .unwrap_or(false);
                    let source_complete = source_entry
                        .map(|entry| entry.schema_completeness == "complete")
                        .unwrap_or(false);
                    let target_complete = target_entry
                        .map(|entry| entry.schema_completeness == "complete")
                        .unwrap_or(false);

                    if source_ok && target_ok {
                        confirmed_references.push(serde_json::json!({
                            "kind": "relationship",
                            "displayName": format!("{}:{} -> {}:{}", source_entity, relation.source_attribute_logical_name, target_entity, relation.target_attribute_logical_name),
                            "entityLogicalName": source_entity,
                            "attributeLogicalName": relation.source_attribute_logical_name,
                            "relatedEntityLogicalName": target_entity,
                            "sourceReason": relation.source_reason,
                            "detail": format!("Detected via {}", relation.context_type),
                        }));
                    } else if source_complete && target_complete {
                        let detail = format!("Detected via {}", relation.context_type);
                        if !source_ok {
                            missing_references.push(serde_json::json!({
                                "kind": "relationship",
                                "displayName": format!("{}:{}", source_entity, relation.source_attribute_logical_name),
                                "entityLogicalName": source_entity,
                                "attributeLogicalName": relation.source_attribute_logical_name,
                                "relatedEntityLogicalName": target_entity,
                                "sourceReason": relation.source_reason,
                                "detail": detail,
                            }));
                        }
                        if !target_ok {
                            missing_references.push(serde_json::json!({
                                "kind": "relationship",
                                "displayName": format!("{}:{}", target_entity, relation.target_attribute_logical_name),
                                "entityLogicalName": target_entity,
                                "attributeLogicalName": relation.target_attribute_logical_name,
                                "relatedEntityLogicalName": source_entity,
                                "sourceReason": relation.source_reason,
                                "detail": detail,
                            }));
                        }
                    } else {
                        ambiguous_references.push(serde_json::json!({
                            "kind": "relationship",
                            "displayName": format!("{}:{} -> {}:{}", source_entity, relation.source_attribute_logical_name, target_entity, relation.target_attribute_logical_name),
                            "entityLogicalName": source_entity,
                            "attributeLogicalName": relation.source_attribute_logical_name,
                            "relatedEntityLogicalName": target_entity,
                            "sourceReason": relation.source_reason,
                            "detail": "Relationship could not be fully verified because one or both entity schemas were incomplete.",
                        }));
                    }
                }
                _ => {
                    ambiguous_references.push(serde_json::json!({
                        "kind": "relationship",
                        "displayName": format!("{} -> {}", relation.source_attribute_logical_name, relation.target_attribute_logical_name),
                        "attributeLogicalName": relation.source_attribute_logical_name,
                        "sourceReason": relation.source_reason,
                        "detail": "Could not infer both entities for this LinkEntity relationship.",
                    }));
                }
            }
        }

        for ambiguous in &scan.ambiguous_references {
            ambiguous_references.push(serde_json::json!({
                "kind": ambiguous.kind,
                "displayName": ambiguous.logical_name,
                "entityLogicalName": ambiguous.entity_logical_name,
                "relatedEntityLogicalName": ambiguous.related_entity_logical_name,
                "sourceReason": ambiguous.source_reason,
                "detail": ambiguous.detail,
            }));
        }

        if let Some(plugin_context) = &scan.plugin_context {
            if let Some(primary_entity) = &plugin_context.primary_entity_name {
                let status = if entity_cache.contains_key(primary_entity) { "confirmed" } else { "warning" };
                let source_label = plugin_context.primary_entity_source.clone().unwrap_or_else(|| "inferred".to_string());
                plugin_checks.push(serde_json::json!({
                    "status": status,
                    "title": "Primary entity",
                    "detail": format!("Primary entity resolved as '{}' (source: {}).", primary_entity, source_label.replace('_', " ")),
                    "entityLogicalName": primary_entity,
                    "sourceReason": "from plugin code",
                }));
            } else {
                plugin_checks.push(serde_json::json!({
                    "status": "not_verified",
                    "title": "Primary entity",
                    "detail": "Primary plugin entity could not be inferred. Configure primary entity in task setup or plugin registration metadata.",
                    "sourceReason": "from plugin code",
                }));
            }

            if !plugin_context.messages.is_empty() {
                plugin_checks.push(serde_json::json!({
                    "status": "confirmed",
                    "title": "Plugin message",
                    "detail": format!("Detected message checks: {}.", plugin_context.messages.join(", ")),
                    "sourceReason": "from context.MessageName checks",
                }));
            } else {
                plugin_checks.push(serde_json::json!({
                    "status": "not_verified",
                    "title": "Plugin message",
                    "detail": "No explicit message check was detected in the plugin code.",
                    "sourceReason": "from plugin code",
                }));
            }

            match plugin_context.stage {
                Some(stage) => {
                    let stage_label = plugin_context.stage_name.as_deref().unwrap_or("unknown");
                    plugin_checks.push(serde_json::json!({
                        "status": "confirmed",
                        "title": "Plugin stage",
                        "detail": format!("Stage {} ({}) detected from code.", stage, stage_label),
                        "sourceReason": "from context.Stage check in code",
                    }));
                }
                None => {
                    plugin_checks.push(serde_json::json!({
                        "status": "not_verified",
                        "title": "Plugin stage",
                        "detail": "No explicit stage check detected in plugin code.",
                        "sourceReason": "from plugin code",
                    }));
                }
            }

            if let Some(mode) = plugin_context.mode {
                let mode_label = plugin_context.mode_name.as_deref().unwrap_or("unknown");
                plugin_checks.push(serde_json::json!({
                    "status": "confirmed",
                    "title": "Plugin mode",
                    "detail": format!("Mode {} ({}) detected from code.", mode, mode_label),
                    "sourceReason": "from context.Mode check in code",
                }));
            }

            if let Some(primary_entity) = &plugin_context.primary_entity_name {
                for (image_kind, attrs) in &plugin_context.image_attributes {
                    for attr in attrs {
                        let verified = entity_cache
                            .get(primary_entity)
                            .map(|entry| entry.attributes.contains(attr))
                            .unwrap_or(false);
                        plugin_checks.push(serde_json::json!({
                            "status": if verified { "confirmed" } else { "warning" },
                            "title": format!("{} image attribute", image_kind),
                            "detail": if verified {
                                format!("Image attribute '{}.{}' was confirmed in metadata.", primary_entity, attr)
                            } else {
                                format!("Image attribute '{}.{}' could not be confirmed in metadata.", primary_entity, attr)
                            },
                            "entityLogicalName": primary_entity,
                            "attributeLogicalName": attr,
                            "sourceReason": format!("from {} entity image usage", image_kind),
                        }));
                    }
                }
            }

            if plugin_context.uses_pre_entity_images || plugin_context.uses_post_entity_images {
                plugin_checks.push(serde_json::json!({
                    "status": "not_verified",
                    "title": "Entity images",
                    "detail": "Entity images are used in code, but plugin registration metadata was not available to confirm the image configuration.",
                    "sourceReason": "from PreEntityImages/PostEntityImages usage",
                }));
            }

            if plugin_context.messages.iter().any(|message| message.eq_ignore_ascii_case("Update")) && !plugin_context.target_attributes.is_empty() {
                runtime_risks.push(serde_json::json!({
                    "kind": "runtime",
                    "displayName": "Update target attribute assumptions",
                    "entityLogicalName": plugin_context.primary_entity_name,
                    "sourceReason": "from target.GetAttributeValue usage on Update",
                    "detail": "On Update, Target may not contain every referenced attribute. Verify filtering attributes and entity images before runtime testing.",
                }));
            }

            if !plugin_context.filtering_attributes.is_empty() {
                plugin_checks.push(serde_json::json!({
                    "status": if plugin_context.primary_entity_name.is_some() { "confirmed" } else { "not_verified" },
                    "title": if plugin_context.primary_entity_name.is_some() { "Suggested filtering attributes" } else { "Candidate filtering attributes" },
                    "detail": if plugin_context.primary_entity_name.is_some() {
                        format!("Suggested filtering attributes from Target usage: {}.", plugin_context.filtering_attributes.join(", "))
                    } else {
                        format!("Candidate filtering attributes were detected, but primary entity is unknown: {}.", plugin_context.filtering_attributes.join(", "))
                    },
                    "entityLogicalName": plugin_context.primary_entity_name,
                    "sourceReason": "from target.GetAttributeValue usage",
                }));
            }

            for note in &plugin_context.notes {
                unable_to_verify_reasons.push(note.clone());
            }
        }

        // â”€â”€ Lookup target validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        for lookup_assign in &scan.lookup_assignments {
            let entity_name = lookup_assign.entity_logical_name.as_deref().unwrap_or("");
            let attr_name = &lookup_assign.attribute_logical_name;
            let target = lookup_assign.target_entity_logical_name.as_deref().unwrap_or("");
            if entity_name.is_empty() || attr_name.is_empty() { continue; }
            let raw_attr_opt = entity_cache.get(entity_name).and_then(|e| e.raw_attrs.get(attr_name));
            match raw_attr_opt {
                None => {
                    plugin_checks.push(serde_json::json!({
                        "status": "not_verified",
                        "title": format!("Lookup target: {}.{}", entity_name, attr_name),
                        "detail": format!("Lookup target for {}.{}: attribute metadata not available from Primarch.", entity_name, attr_name),
                        "entityLogicalName": entity_name, "attributeLogicalName": attr_name,
                        "sourceReason": &lookup_assign.source_reason,
                    }));
                }
                Some(raw_attr) => {
                    let targets = attr_lookup_targets(raw_attr);
                    if targets.is_empty() {
                        plugin_checks.push(serde_json::json!({
                            "status": "not_verified",
                            "title": format!("Lookup target: {}.{}", entity_name, attr_name),
                            "detail": format!("Lookup targets not exposed in metadata for {}.{}; cannot verify assignment to '{}'.", entity_name, attr_name, target),
                            "entityLogicalName": entity_name, "attributeLogicalName": attr_name,
                            "sourceReason": &lookup_assign.source_reason,
                        }));
                    } else if !target.is_empty() && targets.contains(&target.to_string()) {
                        confirmed_references.push(serde_json::json!({
                            "kind": "lookup-target",
                            "displayName": format!("{}.{} â†’ {}", entity_name, attr_name, target),
                            "entityLogicalName": entity_name, "attributeLogicalName": attr_name,
                            "sourceReason": &lookup_assign.source_reason,
                            "detail": format!("Lookup {}.{} â†’ '{}' is valid (allowed: {}).", entity_name, attr_name, target, targets.join(", ")),
                        }));
                    } else if !target.is_empty() {
                        missing_references.push(serde_json::json!({
                            "kind": "lookup-target",
                            "displayName": format!("{}.{} â†’ {} (invalid target)", entity_name, attr_name, target),
                            "entityLogicalName": entity_name, "attributeLogicalName": attr_name,
                            "sourceReason": &lookup_assign.source_reason,
                            "detail": format!("Lookup {}.{} does not allow '{}'. Allowed: {}.", entity_name, attr_name, target, targets.join(", ")),
                        }));
                        issues.push(serde_json::json!({
                            "severity": "error", "category": "lookup-target", "code": "INVALID_LOOKUP_TARGET",
                            "title": format!("Invalid lookup target for {}.{}", entity_name, attr_name),
                            "detail": format!("'{}' is not in allowed targets for {}.{}. Allowed: {}.", target, entity_name, attr_name, targets.join(", ")),
                            "entityLogicalName": entity_name, "attributeLogicalName": attr_name,
                        }));
                    }
                }
            }
        }

        // â”€â”€ Choice / OptionSet value validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        for osa in &scan.option_set_assignments {
            let entity_name = osa.entity_logical_name.as_deref().unwrap_or("");
            let attr_name = &osa.attribute_logical_name;
            let value = osa.value;
            if entity_name.is_empty() || attr_name.is_empty() { continue; }
            let raw_attr_opt = entity_cache.get(entity_name).and_then(|e| e.raw_attrs.get(attr_name));
            match raw_attr_opt {
                None => {
                    plugin_checks.push(serde_json::json!({
                        "status": "not_verified",
                        "title": format!("Choice value: {}.{} = {}", entity_name, attr_name, value),
                        "detail": format!("Cannot verify choice value {} for {}.{}: attribute metadata not available.", value, entity_name, attr_name),
                        "entityLogicalName": entity_name, "attributeLogicalName": attr_name,
                        "sourceReason": &osa.source_reason,
                    }));
                }
                Some(raw_attr) => {
                    let allowed = attr_option_values(raw_attr);
                    if allowed.is_empty() {
                        plugin_checks.push(serde_json::json!({
                            "status": "not_verified",
                            "title": format!("Choice value: {}.{} = {}", entity_name, attr_name, value),
                            "detail": format!("Choice values for {}.{} not available from metadata; cannot verify value {}.", entity_name, attr_name, value),
                            "entityLogicalName": entity_name, "attributeLogicalName": attr_name,
                            "sourceReason": &osa.source_reason,
                        }));
                    } else if allowed.contains(&value) {
                        confirmed_references.push(serde_json::json!({
                            "kind": "choice-value",
                            "displayName": format!("{}.{} = {}", entity_name, attr_name, value),
                            "entityLogicalName": entity_name, "attributeLogicalName": attr_name,
                            "sourceReason": &osa.source_reason,
                            "detail": format!("Choice value {} is valid for {}.{}.", value, entity_name, attr_name),
                        }));
                    } else {
                        missing_references.push(serde_json::json!({
                            "kind": "choice-value",
                            "displayName": format!("{}.{} = {} (not found)", entity_name, attr_name, value),
                            "entityLogicalName": entity_name, "attributeLogicalName": attr_name,
                            "sourceReason": &osa.source_reason,
                            "detail": format!("Choice value {} not found in {}.{} option set (found: {:?}).", value, entity_name, attr_name, allowed),
                        }));
                        issues.push(serde_json::json!({
                            "severity": "error", "category": "choice-value", "code": "INVALID_CHOICE_VALUE",
                            "title": format!("Invalid choice value for {}.{}", entity_name, attr_name),
                            "detail": format!("Value {} is not in the allowed options for {}.{}.", value, entity_name, attr_name),
                            "entityLogicalName": entity_name, "attributeLogicalName": attr_name,
                        }));
                    }
                }
            }
        }

        // â”€â”€ ValidForCreate / ValidForUpdate / ValidForRead validation â”€â”€â”€â”€â”€â”€â”€â”€â”€
        {
            let effective_messages: Vec<String> = scan.plugin_context.as_ref()
                .map(|pc| pc.messages.iter().map(|m| m.to_lowercase()).collect())
                .unwrap_or_default();
            for fa in &scan.field_accesses {
                let entity_name = fa.entity_logical_name.as_deref().unwrap_or("");
                let attr_name = &fa.attribute_logical_name;
                if entity_name.is_empty() || attr_name.is_empty() { continue; }
                let raw_attr_opt = entity_cache.get(entity_name).and_then(|e| e.raw_attrs.get(attr_name));
                let Some(raw_attr) = raw_attr_opt else { continue; };
                if fa.access == "write" {
                    let write_dir = if effective_messages.iter().any(|m| m == "create") { "create" }
                        else if effective_messages.iter().any(|m| m == "update") { "update" }
                        else { "create or update" };
                    let write_flag = if write_dir == "create" { attr_valid_for(raw_attr, "create") }
                        else if write_dir == "update" { attr_valid_for(raw_attr, "update") }
                        else { attr_valid_for(raw_attr, "create").or_else(|| attr_valid_for(raw_attr, "update")) };
                    if write_flag == Some(false) {
                        plugin_checks.push(serde_json::json!({
                            "status": "warning",
                            "title": format!("Field write: {}.{} ({})", entity_name, attr_name, write_dir),
                            "detail": format!("{}.{} is not valid for {}.", entity_name, attr_name, write_dir),
                            "entityLogicalName": entity_name, "attributeLogicalName": attr_name,
                            "sourceReason": &fa.source_reason,
                        }));
                        issues.push(serde_json::json!({
                            "severity": "warning", "category": "valid-for", "code": "NOT_VALID_FOR_OPERATION",
                            "title": format!("{}.{} not valid for {}", entity_name, attr_name, write_dir),
                            "detail": format!("Metadata indicates {}.{} is not valid for {}.", entity_name, attr_name, write_dir),
                            "entityLogicalName": entity_name, "attributeLogicalName": attr_name,
                        }));
                    }
                } else if fa.access == "read" && attr_valid_for(raw_attr, "read") == Some(false) {
                    plugin_checks.push(serde_json::json!({
                        "status": "warning",
                        "title": format!("Field read: {}.{}", entity_name, attr_name),
                        "detail": format!("{}.{} is not valid for read.", entity_name, attr_name),
                        "entityLogicalName": entity_name, "attributeLogicalName": attr_name,
                        "sourceReason": &fa.source_reason,
                    }));
                }
            }
        }

        if !scan.notes.is_empty() {
            unable_to_verify_reasons.extend(scan.notes.iter().cloned());
        }
        if let Some(override_entity) = primary_entity_override.as_ref().and_then(|v| normalize_logical_name(v)) {
            unable_to_verify_reasons.push(format!("Primary entity override used for verification: {}.", override_entity));
        }
        if !scan.ambiguous_attributes.is_empty() {
            unable_to_verify_reasons.push(format!(
                "Some attributes could not be bound to a specific entity statically: {}.",
                scan.ambiguous_attributes.join(", "),
            ));
        }

        unable_to_verify_reasons.sort();
        unable_to_verify_reasons.dedup();

        let mut metadata_verdict = if !missing_references.is_empty() {
            "fail"
        } else if !ambiguous_references.is_empty() || !unable_to_verify_reasons.is_empty() {
            "warnings"
        } else if confirmed_references.is_empty() {
            "unknown"
        } else {
            "pass"
        };

        if inspected_entity_details.iter().all(|item| item["schemaCompleteness"].as_str() != Some("complete")) {
            if metadata_verdict == "fail" {
                // Defensive guard: fail is not allowed for schema-completeness-based missing refs
                // unless a complete schema was returned. (Exact-lookup refs are handled separately.)
                missing_references.clear();
                issues.retain(|issue| issue["code"].as_str() != Some("ATTRIBUTE_NOT_FOUND"));
                metadata_verdict = if !ambiguous_references.is_empty() || !unable_to_verify_reasons.is_empty() {
                    "warnings"
                } else {
                    "unknown"
                };
            }
        }

        // Merge exact-lookup-confirmed missing references AFTER the defensive guard.
        // These were confirmed by a direct per-attribute MCP call, not inferred from bulk schema
        // completeness, so they are valid regardless of whether list_columns was complete.
        let had_exact_missing = !exact_missing_refs.is_empty();
        missing_references.extend(exact_missing_refs.drain(..));
        issues.extend(exact_issues.drain(..));
        if had_exact_missing && !missing_references.is_empty() {
            metadata_verdict = "fail";
        }

        let static_inference_confidence = compute_static_inference_confidence(&scan);

        let runtime_readiness = if runtime_risks.is_empty() {
            if scan.plugin_context.is_some() { "low_risk" } else { "not_checked" }
        } else {
            "risks_found"
        };

        let (verdict, summary) = match metadata_verdict {
            "pass" => (
                "pass",
                "Metadata-compatible with inspected Dataverse schema.".to_string(),
            ),
            "warnings" => (
                "warnings",
                "No confirmed metadata mismatch, but some references could not be verified.".to_string(),
            ),
            "fail" => (
                "fail",
                if had_exact_missing {
                    "Confirmed attribute mismatch: one or more attributes do not exist in Dataverse.".to_string()
                } else {
                    "Confirmed metadata mismatch found in complete schema.".to_string()
                },
            ),
            _ => (
                "unknown",
                "Not enough complete metadata or entity binding to decide.".to_string(),
            ),
        };

        Ok::<Value, String>(serde_json::json!({
            "filePath": file_path,
            "verdict": verdict,
            "metadataVerdict": metadata_verdict,
            "staticInferenceConfidence": static_inference_confidence,
            "runtimeReadiness": runtime_readiness,
            "summary": summary,
            "answer": summary,
            "issues": issues,
            "confirmedReferences": confirmed_references,
            "missingReferences": missing_references,
            "ambiguousReferences": ambiguous_references,
            "runtimeRisks": runtime_risks,
            "pluginChecks": plugin_checks,
            "inspectedEntities": inspected_entities,
            "inspectedAttributesByEntity": inspected_attrs,
            "unableToVerifyReasons": unable_to_verify_reasons,
            "compileReadiness": { "status": "not_checked", "detail": "Compile readiness was not checked during metadata verification." },
            "metadataInspected": {
                "entityLogicalNames": inspected_entities,
                "attributeLogicalNames": inspected_attrs,
                "entityDetails": inspected_entity_details,
                "toolsUsed": [metadata_tool_name],
                "discoveredTools": discovered_tool_names,
                "metadataToolParams": metadata_tool_params,
            },
            "rawExtractedReferences": raw_scan_result,
        }))
    }).await;

    match verification {
        Ok(Ok(report)) => Ok(report),
        Ok(Err(err)) => Ok(default_report("error", "unknown", format!("Verification could not be completed. {err}"))),
        Err(_) => Ok(default_report(
            "error",
            "unknown",
            "Verification could not confirm enough metadata to make a reliable decision.".to_string(),
        )),
    }
}

/// Thin Tauri command wrapper â€” delegates to run_crm_verification_for_scan.
/// The verdict is deterministic (based on local scan + metadata lookup results).
/// Never writes to Dataverse.
#[tauri::command]
async fn verify_against_crm(
    app: tauri::AppHandle,
    _task: Value,
    _customer: Value,
    scan_result: Value,
    file_path: Option<String>,
    primary_entity_override: Option<String>,
) -> Result<Value, String> {
    let raw_scan_result = scan_result.clone();
    let scan: CrmScanResult = serde_json::from_value(scan_result).unwrap_or_default();
    run_crm_verification_for_scan(&app, scan, raw_scan_result, file_path, primary_entity_override).await
}

// ---------------------------------------------------------------------------
// MCP tool: run_dataverse_check_for_task
// ---------------------------------------------------------------------------

/// Tauri command: scan a C# file for Dataverse logical-name references using the same
/// Rust scanner as the MCP path, so the UI and MCP paths share one implementation.
#[tauri::command]
fn scan_cs_file_for_crm(
    path: String,
    primary_entity_override: Option<String>,
) -> Result<Value, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read file '{path}': {e}"))?;
    Ok(scan_cs_logical_names_for_mcp(&content, primary_entity_override.as_deref()))
}

/// Returns true when `s` looks like a Dataverse logical name:
/// all-lowercase ASCII, 2â€“64 chars, starts with a letter, only letters/digits/underscores.
/// Excludes common C# keywords and plugin context parameter names.
fn is_cs_logical_name(s: &str) -> bool {
    if s.len() < 2 || s.len() > 64 { return false; }
    let mut chars = s.chars();
    if !chars.next().map_or(false, |c| c.is_ascii_lowercase()) { return false; }
    if !s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') { return false; }
    !matches!(s,
        "target" | "input" | "output" | "shared" | "none" | "null" | "true" | "false" |
        "string" | "object" | "type" | "var" | "int" | "bool" | "value" | "entity" |
        "attribute" | "condition" | "query" | "column" | "result" | "new" | "class" |
        "if" | "else" | "for" | "while" | "return" | "void" | "public" | "private" |
        "static" | "readonly" | "const" | "using" | "namespace" | "base" | "this" |
        "override" | "virtual" | "abstract" | "internal" | "protected" | "sealed"
    )
}

/// Extracts the first quoted string that starts right after `keyword` (case-insensitive).
fn extract_after_cs_keyword(line: &str, keyword: &str) -> Option<String> {
    let lower = line.to_lowercase();
    let kw = keyword.to_lowercase();
    let pos = lower.find(&kw)?;
    let after = &line[pos + keyword.len()..];
    let end = after.find('"')?;
    Some(after[..end].to_string())
}

/// Extracts all double-quoted strings found after `keyword` (up to end of line).
fn extract_all_cs_string_args(line: &str, keyword: &str) -> Vec<String> {
    let mut results = Vec::new();
    let lower  = line.to_lowercase();
    let kw     = keyword.to_lowercase();
    let Some(pos) = lower.find(&kw) else { return results; };
    let mut rest = &line[pos + keyword.len()..];
    while let Some(q1) = rest.find('"') {
        let inner = &rest[q1 + 1..];
        let Some(q2) = inner.find('"') else { break; };
        results.push(inner[..q2].to_string());
        rest = &inner[q2 + 1..];
    }
    results
}

/// Tries to extract a simple `(const )? string Var = "value"` assignment.
fn extract_cs_const_assignment(line: &str) -> Option<(String, String)> {
    let eq_pos = line.find(" = \"")?;
    let lhs = line[..eq_pos].trim();
    let var = lhs.split_whitespace().last()?.trim_end_matches(';').trim();
    if var.is_empty() || !var.chars().next().map_or(false, |c| c.is_alphabetic()) { return None; }
    if !var.chars().all(|c| c.is_alphanumeric() || c == '_') { return None; }
    let after = &line[eq_pos + 4..];
    let end   = after.find('"')?;
    Some((var.to_string(), after[..end].to_string()))
}

/// Extracts the variable name on the left-hand side of an assignment.
fn extract_cs_lhs_var(line: &str) -> Option<String> {
    let eq_pos = line.find(" = ")?;
    let lhs = line[..eq_pos].trim();
    let var = lhs.split_whitespace().last()?.trim_end_matches(';').trim();
    if var.chars().all(|c| c.is_alphanumeric() || c == '_')
        && var.chars().next().map_or(false, |c| c.is_alphabetic())
    {
        Some(var.to_string())
    } else {
        None
    }
}

/// Resolves a string via the constant map, returning it unchanged if not found.
fn cs_resolve_const<'a>(map: &'a std::collections::HashMap<String, String>, s: &'a str) -> &'a str {
    map.get(s).map(|v| v.as_str()).unwrap_or(s)
}

/// Returns the variable name immediately preceding a method call.
fn infer_entity_for_cs_method(
    line: &str,
    method_lower: &str,
    entity_var_map: &std::collections::HashMap<String, String>,
    primary: &Option<String>,
) -> Option<String> {
    let lower = line.to_lowercase();
    if let Some(pos) = lower.find(&format!(".{method_lower}")) {
        let before = &line[..pos];
        let var: &str = before.split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|s| !s.is_empty())
            .last()
            .unwrap_or("");
        if let Some(entity) = entity_var_map.get(var) {
            return Some(entity.clone());
        }
    }
    primary.clone()
}

/// Deduplicates and adds an entity reference.
fn cs_add_entity_ref(entity: &str, source: &str, refs: &mut Vec<Value>) {
    if !refs.iter().any(|r| r["logicalName"].as_str() == Some(entity)) {
        refs.push(serde_json::json!({
            "logicalName": entity,
            "sourceReason": source,
            "contextType": "C# scanner",
        }));
    }
}

/// Deduplicates and adds an attribute reference.
fn cs_add_attr_ref(
    entity: &Option<String>,
    attr: &str,
    source: &str,
    attr_refs: &mut Vec<Value>,
    ambiguous: &mut Vec<String>,
) {
    if attr_refs.iter().any(|r| {
        r["logicalName"].as_str() == Some(attr)
            && r["entityLogicalName"].as_str() == entity.as_deref()
    }) {
        return;
    }
    if let Some(e) = entity {
        attr_refs.push(serde_json::json!({
            "logicalName": attr,
            "entityLogicalName": e,
            "sourceReason": source,
            "contextType": "C# scanner",
        }));
    } else {
        if !ambiguous.contains(&attr.to_string()) { ambiguous.push(attr.to_string()); }
        attr_refs.push(serde_json::json!({
            "logicalName": attr,
            "sourceReason": source,
            "contextType": "C# scanner",
        }));
    }
}

/// Builds an `{entity: [attr]}` convenience map from the attribute references array.
fn cs_build_attrs_map(attr_refs: &[Value]) -> Value {
    let mut map: std::collections::HashMap<String, Vec<String>> = Default::default();
    for r in attr_refs {
        if let (Some(e), Some(a)) = (r["entityLogicalName"].as_str(), r["logicalName"].as_str()) {
            let entry = map.entry(e.to_string()).or_default();
            if !entry.contains(&a.to_string()) { entry.push(a.to_string()); }
        }
    }
    serde_json::to_value(map).unwrap_or(serde_json::json!({}))
}

/// Extracts the first non-quoted identifier argument from after `keyword` (e.g. `"QueryExpression("`),
/// resolves it through `const_map`, and returns the resolved value (if any).
/// Returns `None` if the argument is a string literal or empty.
fn cs_resolve_identifier_arg(
    line: &str,
    lower: &str,
    keyword: &str,
    const_map: &std::collections::HashMap<String, String>,
) -> Option<String> {
    let kw_lower = keyword.to_lowercase();
    let pos = lower.find(&kw_lower)?;
    let raw_after = &line[pos + keyword.len()..];
    let after = raw_after.trim_start();
    if after.starts_with('"') { return None; }
    let end = after.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(after.len());
    let ident = &after[..end];
    if ident.is_empty() { return None; }
    const_map.get(ident).cloned()
}

/// Extracts all non-quoted identifier arguments from a `ColumnSet(â€¦)` call and resolves
/// each through `const_map`. Used to handle `new ColumnSet(Const1, Const2)` patterns.
fn cs_col_var_args(
    line: &str,
    const_map: &std::collections::HashMap<String, String>,
) -> Vec<String> {
    let lower = line.to_lowercase();
    let Some(kw_pos) = lower.find("columnset(") else { return Vec::new(); };
    let content_start = kw_pos + "columnset(".len();
    let rest = &line[content_start..];
    // Find the matching closing paren (simple: first `)`)
    let Some(close) = rest.find(')') else { return Vec::new(); };
    let content = &rest[..close];
    let mut results = Vec::new();
    for part in content.split(',') {
        let part = part.trim();
        if part.is_empty() || part.starts_with('"') { continue; }
        let ident: String = part.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        if !ident.is_empty() {
            if let Some(val) = const_map.get(&ident) {
                results.push(val.clone());
            }
        }
    }
    results
}

/// Returns the entity bound to the variable immediately before `method_lower` on the line,
/// without falling back to primary_entity (unlike `infer_entity_for_cs_method`).
/// Returns `None` if the method is not found on the line or the variable is not in entity_var_map.
fn cs_infer_entity_before_method(
    line: &str,
    lower: &str,
    method_lower: &str,
    entity_var_map: &std::collections::HashMap<String, String>,
) -> Option<String> {
    let pos = lower.find(&format!(".{method_lower}"))?;
    let before = &line[..pos];
    let var: &str = before.split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|s| !s.is_empty()).last()?;
    entity_var_map.get(var).cloned()
}

/// Scans a C# plugin source file for Dataverse entity/attribute logical-name references.
/// Returns a JSON Value shaped as CrmScanResult (camelCase keys) for use with
/// run_crm_verification_for_scan.  Pure Rust implementation, no TypeScript required.
fn scan_cs_logical_names_for_mcp(content: &str, primary_entity_hint: Option<&str>) -> Value {
    let mut const_map:      std::collections::HashMap<String, String> = Default::default();
    let mut int_const_map:  std::collections::HashMap<String, i64>    = Default::default();
    let mut entity_var_map: std::collections::HashMap<String, String> = Default::default();
    // Tracks EntityReference variable â†’ target entity (e.g. ownerRef â†’ systemuser)
    let mut entity_ref_targets: std::collections::HashMap<String, String> = Default::default();
    let mut entity_refs:    Vec<Value>  = Vec::new();
    let mut attr_refs:      Vec<Value>  = Vec::new();
    let mut ambiguous_attrs: Vec<String> = Vec::new();
    let mut lookup_assignments:    Vec<Value> = Vec::new();
    let mut option_set_assignments: Vec<Value> = Vec::new();
    let mut field_accesses:        Vec<Value> = Vec::new();
    let mut primary_entity: Option<String> = primary_entity_hint.map(|s| s.to_lowercase());
    let mut message_checks: Vec<String>  = Vec::new();
    let mut scanner_stage: Option<i32>   = None;
    let mut scanner_mode:  Option<i32>   = None;
    // Tracks the entity most recently set via QueryExpression / new Entity, for use in
    // multi-line object initializers (ColumnSet, ConditionExpression).
    let mut last_entity_context: Option<String> = None;

    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("//") || t.starts_with('*') || t.starts_with("/*") {
            continue;
        }
        let lower = t.to_lowercase();

        // â”€â”€ 1. String constants: (const )? string Var = "value"; â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (lower.contains("string ") || lower.contains("const ")) && lower.contains(" = \"") {
            if let Some((var, val)) = extract_cs_const_assignment(t) {
                if is_cs_logical_name(&val) { const_map.insert(var, val); }
            }
        }

        // â”€â”€ 1b. Integer constants: (const )? int Var = N; â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if lower.contains(" = ") && !lower.contains("\"") {
            if lower.contains("int ") || lower.contains("const ") {
                if let Some(eq_pos) = t.find(" = ") {
                    let lhs = t[..eq_pos].trim();
                    let var = lhs.split_whitespace().last().unwrap_or("").trim_end_matches(';');
                    let rhs = t[eq_pos + 3..].trim().trim_end_matches(';').trim();
                    if !var.is_empty() && var.chars().all(|c| c.is_alphanumeric() || c == '_')
                        && var.chars().next().map_or(false, |c| c.is_alphabetic())
                    {
                        if let Ok(n) = rhs.parse::<i64>() {
                            int_const_map.insert(var.to_string(), n);
                        }
                    }
                }
            }
        }

        // â”€â”€ 2. Entity guards: .LogicalName == "entity" / != "entity" â”€â”€â”€â”€â”€â”€â”€â”€
        if lower.contains("logicalname") && (lower.contains("== \"") || lower.contains("!= \"")) {
            let entity = extract_after_cs_keyword(t, "LogicalName == \"")
                .or_else(|| extract_after_cs_keyword(t, "LogicalName != \""));
            if let Some(e) = entity {
                if is_cs_logical_name(&e) {
                    if primary_entity.is_none() { primary_entity = Some(e.clone()); }
                    cs_add_entity_ref(&e, "entity-guard", &mut entity_refs);
                    entity_var_map.entry("contextentity".to_string()).or_insert_with(|| e.clone());
                    // Capture the actual variable name before .LogicalName (e.g. "contextEntity", "target")
                    if let Some(dot_pos) = lower.find(".logicalname") {
                        let before_dot = t[..dot_pos].trim();
                        let actual_var: &str = before_dot
                            .split(|c: char| !c.is_alphanumeric() && c != '_')
                            .filter(|s| !s.is_empty()).last().unwrap_or("");
                        if !actual_var.is_empty() {
                            entity_var_map.entry(actual_var.to_string()).or_insert_with(|| e.clone());
                        }
                    }
                }
            }
        }

        // â”€â”€ 3. MessageName checks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if lower.contains("messagename") && (lower.contains("== \"") || lower.contains("!= \"")) {
            let msg = extract_after_cs_keyword(t, "MessageName == \"")
                .or_else(|| extract_after_cs_keyword(t, "MessageName != \""))
                // Const variable form: messageName == MessageCreate
                .or_else(|| {
                    lower.find("messagename").and_then(|pos| {
                        let rest_lower = &lower[pos + "messagename".len()..];
                        let eq_pos = rest_lower.find("== ")?;
                        let after_eq = rest_lower[eq_pos + 3..].trim_start();
                        if after_eq.starts_with('"') { return None; }
                        let end = after_eq.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(after_eq.len());
                        let var_name_lower = &after_eq[..end];
                        // Find original-case var name by same offset in t
                        let t_offset = pos + "messagename".len() + eq_pos + 3;
                        if t_offset < t.len() {
                            let t_rest = t[t_offset..].trim_start();
                            let t_end = t_rest.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(t_rest.len());
                            let var_name = &t_rest[..t_end];
                            if !var_name.is_empty() && var_name.to_lowercase() == *var_name_lower {
                                const_map.get(var_name).cloned()
                            } else { None }
                        } else { None }
                    })
                });
            if let Some(m) = msg {
                if !m.is_empty() && m.len() <= 50 && m.chars().all(|c| c.is_alphanumeric()) {
                    if !message_checks.contains(&m) { message_checks.push(m); }
                }
            }
        }

        // â”€â”€ 3b. Stage checks: context.Stage == N â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if lower.contains(".stage") && lower.contains("== ") {
            if let Some(eq_pos) = lower.find("== ") {
                let val_str = t[eq_pos + 3..].trim_start();
                let end = val_str.find(|c: char| !c.is_ascii_digit()).unwrap_or(val_str.len());
                if !end == 0 {
                    if let Ok(s) = val_str[..end].parse::<i32>() {
                        if scanner_stage.is_none() { scanner_stage = Some(s); }
                    }
                }
            }
        }

        // â”€â”€ 3c. Mode checks: context.Mode == N â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if lower.contains(".mode") && lower.contains("== ") {
            if let Some(eq_pos) = lower.find("== ") {
                let val_str = t[eq_pos + 3..].trim_start();
                let end = val_str.find(|c: char| !c.is_ascii_digit()).unwrap_or(val_str.len());
                if !end == 0 {
                    if let Ok(m) = val_str[..end].parse::<i32>() {
                        if scanner_mode.is_none() { scanner_mode = Some(m); }
                    }
                }
            }
        }

        // â”€â”€ 4. new Entity("entity") / new Entity(ConstVar) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if lower.contains("new entity(") {
            let entity = extract_after_cs_keyword(t, "Entity(\"")
                .or_else(|| extract_after_cs_keyword(t, "Entity (\""))
                .filter(|s| is_cs_logical_name(s))
                .or_else(|| cs_resolve_identifier_arg(t, &lower, "Entity(", &const_map)
                    .filter(|s| is_cs_logical_name(s)));
            if let Some(entity) = entity {
                let var = extract_cs_lhs_var(t);
                cs_add_entity_ref(&entity, "new-entity", &mut entity_refs);
                if let Some(v) = var { entity_var_map.insert(v, entity.clone()); }
                last_entity_context = Some(entity);
            }
        }

        // â”€â”€ 5. new EntityReference("entity", ...) / EntityReference(ConstVar) â”€
        if lower.contains("entityreference(") {
            let entity = extract_after_cs_keyword(t, "EntityReference(\"")
                .filter(|s| is_cs_logical_name(s))
                .or_else(|| cs_resolve_identifier_arg(t, &lower, "EntityReference(", &const_map)
                    .filter(|s| is_cs_logical_name(s)));
            if let Some(ref entity) = entity {
                let var = extract_cs_lhs_var(t);
                cs_add_entity_ref(entity, "entity-reference", &mut entity_refs);
                if let Some(ref v) = var {
                    entity_var_map.insert(v.clone(), entity.clone());
                    // Track which entity this ref variable points to (for lookup assignment validation)
                    entity_ref_targets.insert(v.clone(), entity.clone());
                }
                // EntityReference is a lookup target â€” do not update last_entity_context
            }
        }

        // â”€â”€ 6. new QueryExpression / QueryByAttribute (literal or ConstVar) â”€
        if lower.contains("queryexpression(") || lower.contains("querybyattribute(") {
            let e = if lower.contains("queryexpression(\"") {
                extract_after_cs_keyword(t, "QueryExpression(\"")
            } else if lower.contains("querybyattribute(\"") {
                extract_after_cs_keyword(t, "QueryByAttribute(\"")
            } else {
                None
            }
            .filter(|s| is_cs_logical_name(s))
            .or_else(|| {
                let kw = if lower.contains("queryexpression(") { "QueryExpression(" } else { "QueryByAttribute(" };
                cs_resolve_identifier_arg(t, &lower, kw, &const_map).filter(|s| is_cs_logical_name(s))
            });
            if let Some(entity) = e {
                let var = extract_cs_lhs_var(t);
                cs_add_entity_ref(&entity, "query-expression", &mut entity_refs);
                if let Some(v) = var { entity_var_map.insert(v, entity.clone()); }
                last_entity_context = Some(entity);
            }
        }

        // â”€â”€ 7. Bracket access: entity["attr"] / entity.Attributes["attr"] â”€â”€â”€
        {
            let mut search = t;
            while let Some(pos) = search.find("[\"") {
                let after = &search[pos + 2..];
                if let Some(end) = after.find("\"]") {
                    let raw_attr = &after[..end];
                    let attr = cs_resolve_const(&const_map, raw_attr).to_string();
                    if is_cs_logical_name(&attr) {
                        // Find the variable before `["` (strip `.Attributes` if present)
                        let before = &search[..pos];
                        let before = before.trim_end_matches(".Attributes");
                        let var: &str = before.split(|c: char| !c.is_alphanumeric() && c != '_')
                            .filter(|s| !s.is_empty()).last().unwrap_or("");
                        let entity = entity_var_map.get(var).cloned()
                            .or_else(|| primary_entity.clone());
                        cs_add_attr_ref(&entity, &attr, "bracket-access", &mut attr_refs, &mut ambiguous_attrs);
                    }
                    search = &search[pos + 2..];
                } else { break; }
            }
        }

        // â”€â”€ 7b. Bracket access with variable: entity[varName] â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Handles `const string X = "attr"; entity[X]` patterns by resolving
        // through const_map. Skips string-literal brackets (handled above).
        {
            let mut search = t;
            while let Some(pos) = search.find('[') {
                let after = &search[pos + 1..];
                if !after.starts_with('"') {
                    if let Some(close) = after.find(']') {
                        let raw = after[..close].trim();
                        if !raw.is_empty()
                            && raw.chars().next().map_or(false, |c| c.is_alphabetic() || c == '_')
                            && raw.chars().all(|c| c.is_alphanumeric() || c == '_')
                        {
                            if let Some(resolved) = const_map.get(raw) {
                                let attr = resolved.clone();
                                if is_cs_logical_name(&attr) {
                                    let before = &search[..pos];
                                    let before_stripped = before.trim_end_matches(".Attributes");
                                    let obj_var: &str = before_stripped
                                        .split(|c: char| !c.is_alphanumeric() && c != '_')
                                        .filter(|s| !s.is_empty())
                                        .last()
                                        .unwrap_or("");
                                    let entity = entity_var_map.get(obj_var).cloned()
                                        .or_else(|| primary_entity.clone());
                                    cs_add_attr_ref(&entity, &attr, "bracket-access-var", &mut attr_refs, &mut ambiguous_attrs);
                                }
                            }
                        }
                        search = &search[pos + 1..];
                    } else {
                        break;
                    }
                } else {
                    search = &search[pos + 1..];
                }
            }
        }

        // â”€â”€ 8. .GetAttributeValue<T>("attr") / .GetAttributeValue<T>(ConstVar) â”€
        if lower.contains("getattributevalue") {
            let raw_attr_opt = extract_all_cs_string_args(t, "GetAttributeValue").into_iter().next()
                .or_else(|| {
                    // Variable form: find opening ( after the keyword (possibly after <T>), extract identifier
                    lower.find("getattributevalue").and_then(|kw_pos| {
                        let after_kw = &t[kw_pos + "getattributevalue".len()..];
                        let paren_pos = after_kw.find('(')?;
                        let after_paren = after_kw[paren_pos + 1..].trim_start();
                        if after_paren.starts_with('"') { return None; }
                        let end = after_paren.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(after_paren.len());
                        let var_name = &after_paren[..end];
                        if !var_name.is_empty() { const_map.get(var_name).cloned() } else { None }
                    })
                });
            if let Some(raw_attr) = raw_attr_opt {
                let attr = cs_resolve_const(&const_map, &raw_attr).to_string();
                if is_cs_logical_name(&attr) {
                    let entity = infer_entity_for_cs_method(t, "getattributevalue", &entity_var_map, &primary_entity);
                    cs_add_attr_ref(&entity, &attr, "get-attribute-value", &mut attr_refs, &mut ambiguous_attrs);
                }
            }
        }

        // â”€â”€ 9. .SetAttributeValue("attr" / varName, ...) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if lower.contains("setattributevalue(") {
            let raw_attr_opt: Option<String> = if lower.contains("setattributevalue(\"") {
                extract_after_cs_keyword(t, "SetAttributeValue(\"")
            } else {
                lower.find("setattributevalue(").and_then(|pos| {
                    let arg_start = pos + "setattributevalue(".len();
                    let rest = &t[arg_start..];
                    let end = rest.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(rest.len());
                    let var_name = &rest[..end];
                    if !var_name.is_empty() { const_map.get(var_name).cloned() } else { None }
                })
            };
            if let Some(raw_attr) = raw_attr_opt {
                let attr = cs_resolve_const(&const_map, &raw_attr).to_string();
                if is_cs_logical_name(&attr) {
                    let entity = infer_entity_for_cs_method(t, "setattributevalue", &entity_var_map, &primary_entity);
                    cs_add_attr_ref(&entity, &attr, "set-attribute-value", &mut attr_refs, &mut ambiguous_attrs);
                }
            }
        }

        // â”€â”€ 10. .Attributes.Contains("attr" / varName) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if lower.contains("attributes.contains(") {
            let raw_attr_opt: Option<String> = if lower.contains("attributes.contains(\"") {
                extract_after_cs_keyword(t, "Attributes.Contains(\"")
            } else {
                lower.find("attributes.contains(").and_then(|pos| {
                    let arg_start = pos + "attributes.contains(".len();
                    let rest = &t[arg_start..];
                    let end = rest.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(rest.len());
                    let var_name = &rest[..end];
                    if !var_name.is_empty() { const_map.get(var_name).cloned() } else { None }
                })
            };
            if let Some(raw_attr) = raw_attr_opt {
                let attr = cs_resolve_const(&const_map, &raw_attr).to_string();
                if is_cs_logical_name(&attr) {
                    let entity = infer_entity_for_cs_method(t, "attributes.contains", &entity_var_map, &primary_entity);
                    cs_add_attr_ref(&entity, &attr, "attributes-contains", &mut attr_refs, &mut ambiguous_attrs);
                }
            }
        }

        // â”€â”€ 11. new ColumnSet(â€¦) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Handles both literal strings and const-variable arguments.
        // Entity binding:
        //   - Assignment form (`ColumnSet = new ColumnSet(â€¦)` or `var.ColumnSet = â€¦`):
        //     look for an explicit var before .ColumnSet, then fall back to last_entity_context.
        //   - Argument form (`new ColumnSet(â€¦)` passed to a method like Retrieve):
        //     use primary_entity.
        if lower.contains("new columnset(") {
            let entity_for_col: Option<String> = if lower.contains("columnset = new columnset(") {
                // Object-initializer or property-assignment form: find the variable before .ColumnSet
                let col_pos = lower.find("columnset = new columnset(").unwrap_or(0);
                let before_col = t[..col_pos].trim_end_matches(|c: char| c == '.' || c.is_whitespace());
                let var: &str = before_col
                    .split(|c: char| !c.is_alphanumeric() && c != '_')
                    .filter(|s| !s.is_empty()).last().unwrap_or("");
                entity_var_map.get(var).cloned()
                    .or_else(|| last_entity_context.clone())
                    .or_else(|| primary_entity.clone())
            } else {
                // Argument form: use the primary entity
                primary_entity.clone()
            };
            // Literal args
            for raw_attr in extract_all_cs_string_args(t, "ColumnSet(") {
                let attr = cs_resolve_const(&const_map, &raw_attr).to_string();
                if is_cs_logical_name(&attr) {
                    cs_add_attr_ref(&entity_for_col, &attr, "column-set", &mut attr_refs, &mut ambiguous_attrs);
                }
            }
            // Const-variable args: resolve identifiers inside ColumnSet(â€¦) through const_map
            for resolved_attr in cs_col_var_args(t, &const_map) {
                if is_cs_logical_name(&resolved_attr) {
                    cs_add_attr_ref(&entity_for_col, &resolved_attr, "column-set-var", &mut attr_refs, &mut ambiguous_attrs);
                }
            }
        }

        // â”€â”€ 12. new ConditionExpression("attr" / ConstVar, â€¦) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Entity binding:
        //   - Single-line with var.Criteria.AddCondition(â€¦): entity from the query var.
        //   - Multi-line (ConditionExpression on its own line): use last_entity_context.
        //   - Fallback: primary_entity.
        if lower.contains("conditionexpression(") {
            let raw_attr_opt: Option<String> = if lower.contains("conditionexpression(\"") {
                extract_after_cs_keyword(t, "ConditionExpression(\"")
            } else {
                lower.find("conditionexpression(").and_then(|pos| {
                    let arg_start = pos + "conditionexpression(".len();
                    let rest = &t[arg_start..];
                    let end = rest.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(rest.len());
                    let var_name = &rest[..end];
                    if !var_name.is_empty() { const_map.get(var_name).cloned() } else { None }
                })
            };
            if let Some(raw_attr) = raw_attr_opt {
                let attr = cs_resolve_const(&const_map, &raw_attr).to_string();
                if is_cs_logical_name(&attr) {
                    // Single-line: try to find the query variable before .Criteria.AddCondition / .Criteria
                    let entity = cs_infer_entity_before_method(t, &lower, "criteria.addcondition", &entity_var_map)
                        .or_else(|| cs_infer_entity_before_method(t, &lower, "criteria.conditions", &entity_var_map))
                        .or_else(|| cs_infer_entity_before_method(t, &lower, "addcondition", &entity_var_map))
                        .or_else(|| last_entity_context.clone())
                        .or_else(|| primary_entity.clone());
                    cs_add_attr_ref(&entity, &attr, "condition-expression", &mut attr_refs, &mut ambiguous_attrs);
                }
            }
        }

        // â”€â”€ 13. new OrderExpression("attr", ...) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if lower.contains("new orderexpression(\"") {
            if let Some(raw_attr) = extract_after_cs_keyword(t, "OrderExpression(\"") {
                let attr = cs_resolve_const(&const_map, &raw_attr).to_string();
                if is_cs_logical_name(&attr) {
                    cs_add_attr_ref(&primary_entity, &attr, "order-expression", &mut attr_refs, &mut ambiguous_attrs);
                }
            }
        }

        // â”€â”€ 14. OptionSetValue write: entity[attr] = new OptionSetValue(n) â”€â”€
        if lower.contains("optionsetvalue(") {
            // Extract integer value from OptionSetValue(n) or OptionSetValue(ConstInt)
            if let Some(ov_pos) = lower.find("optionsetvalue(") {
                let arg_start = ov_pos + "optionsetvalue(".len();
                let rest = &t[arg_start..];
                let end = rest.find(|c: char| !c.is_ascii_digit() && c != '-').unwrap_or(0);
                let raw_val_str = rest[..end.max(1)].trim_end_matches(|c: char| !c.is_ascii_digit() && c != '-');
                let value_opt: Option<i64> = rest
                    .find(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
                    .and_then(|end2| {
                        let raw = rest[..end2].trim();
                        raw.parse::<i64>().ok().or_else(|| int_const_map.get(raw).copied())
                    })
                    .or_else(|| raw_val_str.parse().ok());
                if let Some(val) = value_opt {
                    // Find attribute on LHS (before `= new OptionSetValue`)
                    let eq_pos = lower.find("= new optionsetvalue").or_else(|| lower.find("=new optionsetvalue"));
                    if let Some(eq) = eq_pos {
                        if let Some((entity, attr)) = cs_extract_bracket_lhs(&t[..eq], &const_map, &entity_var_map, &primary_entity) {
                            if !option_set_assignments.iter().any(|r| r["attributeLogicalName"].as_str() == Some(&attr) && r["value"].as_i64() == Some(val)) {
                                option_set_assignments.push(serde_json::json!({
                                    "entityLogicalName": entity,
                                    "attributeLogicalName": attr,
                                    "value": val,
                                    "sourceReason": "optionsetvalue-assignment",
                                }));
                            }
                        }
                    }
                }
            }
        }

        // â”€â”€ 15. Lookup assignment: entity[attr] = new EntityReference(target, ...) â”€â”€
        //        or entity[attr] = existingEntityRefVar
        if lower.contains("] = ") || lower.contains("] =\t") {
            // Detect assignment form (not equality check)
            let eq_pos = lower.find("] = ").or_else(|| lower.find("] =\t"));
            if let Some(eq) = eq_pos {
                let lhs = &t[..eq + 1]; // up to and including `]`
                let rhs_lower = &lower[eq + 3..];
                let rhs = &t[eq + 3..];

                // RHS: explicit new EntityReference(target, ...)
                let target_from_rhs = extract_after_cs_keyword(rhs, "EntityReference(\"")
                    .filter(|s| is_cs_logical_name(s))
                    .or_else(|| cs_resolve_identifier_arg(rhs, rhs_lower, "EntityReference(", &const_map)
                        .filter(|s| is_cs_logical_name(s)));

                // RHS: variable that was previously assigned from EntityReference
                let target_from_var = target_from_rhs.clone().or_else(|| {
                    let rhs_trimmed = rhs.trim_start();
                    let var_end = rhs_trimmed.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(rhs_trimmed.len());
                    let var_name = &rhs_trimmed[..var_end];
                    if !var_name.is_empty() { entity_ref_targets.get(var_name).cloned() } else { None }
                });

                if let Some(target) = target_from_var {
                    if let Some((entity, attr)) = cs_extract_bracket_lhs(lhs, &const_map, &entity_var_map, &primary_entity) {
                        if !lookup_assignments.iter().any(|r| r["attributeLogicalName"].as_str() == Some(&attr) && r["targetEntityLogicalName"].as_str() == Some(&target)) {
                            lookup_assignments.push(serde_json::json!({
                                "entityLogicalName": entity,
                                "attributeLogicalName": attr,
                                "targetEntityLogicalName": target,
                                "sourceReason": "entityreference-assignment",
                            }));
                        }
                    }
                }

                // Track the write as a field access regardless of RHS type
                if let Some((entity, attr)) = cs_extract_bracket_lhs(lhs, &const_map, &entity_var_map, &primary_entity) {
                    if !field_accesses.iter().any(|r| r["attributeLogicalName"].as_str() == Some(&attr) && r["access"].as_str() == Some("write") && r["entityLogicalName"].as_str() == entity.as_deref()) {
                        field_accesses.push(serde_json::json!({
                            "entityLogicalName": entity,
                            "attributeLogicalName": attr,
                            "access": "write",
                            "sourceReason": "bracket-assignment",
                        }));
                    }
                }
            }
        }

        // â”€â”€ 16. Field read accesses (GetAttributeValue, Attributes.Contains) â”€
        if lower.contains("getattributevalue") {
            // Already handled in section 8; add read access record here
            let raw_attr_opt = extract_all_cs_string_args(t, "GetAttributeValue").into_iter().next()
                .or_else(|| {
                    lower.find("getattributevalue").and_then(|kw_pos| {
                        let after_kw = &t[kw_pos + "getattributevalue".len()..];
                        let paren_pos = after_kw.find('(')?;
                        let after_paren = after_kw[paren_pos + 1..].trim_start();
                        if after_paren.starts_with('"') { return None; }
                        let end = after_paren.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(after_paren.len());
                        let var_name = &after_paren[..end];
                        if !var_name.is_empty() { const_map.get(var_name).cloned() } else { None }
                    })
                });
            if let Some(raw_attr) = raw_attr_opt {
                let attr = cs_resolve_const(&const_map, &raw_attr).to_string();
                if is_cs_logical_name(&attr) {
                    let entity = infer_entity_for_cs_method(t, "getattributevalue", &entity_var_map, &primary_entity);
                    if !field_accesses.iter().any(|r| r["attributeLogicalName"].as_str() == Some(&attr) && r["access"].as_str() == Some("read") && r["entityLogicalName"].as_str() == entity.as_deref()) {
                        field_accesses.push(serde_json::json!({
                            "entityLogicalName": entity,
                            "attributeLogicalName": attr,
                            "access": "read",
                            "sourceReason": "get-attribute-value",
                        }));
                    }
                }
            }
        }
    }

    // Collect unique entity logical names
    let mut entities: Vec<String> = entity_refs.iter()
        .filter_map(|r| r["logicalName"].as_str().map(str::to_string))
        .collect();
    entities.sort(); entities.dedup();

    let attrs_map = cs_build_attrs_map(&attr_refs);

    let stage_name: Option<&str> = scanner_stage.and_then(|s| match s {
        10 => Some("PreValidation"),
        20 => Some("PreOperation"),
        40 => Some("PostOperation"),
        _  => None,
    });
    let mode_name: Option<&str> = scanner_mode.and_then(|m| match m {
        0 => Some("Synchronous"),
        1 => Some("Asynchronous"),
        _ => None,
    });

    serde_json::json!({
        "entities":           entities,
        "entityReferences":   entity_refs,
        "attributeReferences": attr_refs,
        "ambiguousAttributes": ambiguous_attrs,
        "ambiguousReferences": [],
        "relationshipReferences": [],
        "notes": [],
        "attributes": attrs_map,
        "lookupAssignments":    lookup_assignments,
        "optionSetAssignments": option_set_assignments,
        "fieldAccesses":        field_accesses,
        "pluginContext": {
            "primaryEntityName": primary_entity,
            "primaryEntitySource": primary_entity.as_ref().map(|_| "entity-guard").unwrap_or("unknown"),
            "messages": message_checks,
            "stage": scanner_stage,
            "stageName": stage_name,
            "mode": scanner_mode,
            "modeName": mode_name,
            "filteringAttributes": [],
            "usesPreEntityImages": false,
            "usesPostEntityImages": false,
            "imageAttributes": {},
            "targetAttributes": [],
            "notes": [],
        }
    })
}

/// Extracts (entity, attr) from the LHS of a bracket assignment: `entity[attr]` or `entity.Attributes[attr]`.
/// Handles both string literals and const variable names.
fn cs_extract_bracket_lhs(
    lhs: &str,
    const_map: &std::collections::HashMap<String, String>,
    entity_var_map: &std::collections::HashMap<String, String>,
    primary_entity: &Option<String>,
) -> Option<(Option<String>, String)> {
    let bracket_start = lhs.rfind('[')?;
    let bracket_content = &lhs[bracket_start + 1..];
    let bracket_end = bracket_content.find(']').unwrap_or(bracket_content.len());
    let raw_key = &bracket_content[..bracket_end];
    let attr: String = if raw_key.starts_with('"') {
        // String literal: strip quotes
        let inner = raw_key.trim_matches('"');
        cs_resolve_const(const_map, inner).to_string()
    } else {
        // Identifier: resolve through const_map
        cs_resolve_const(const_map, raw_key).to_string()
    };
    if !is_cs_logical_name(&attr) { return None; }
    let before = lhs[..bracket_start].trim_end_matches(".Attributes");
    let obj_var: &str = before
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|s| !s.is_empty()).last().unwrap_or("");
    let entity = entity_var_map.get(obj_var).cloned().or_else(|| primary_entity.clone());
    Some((entity, attr))
}

/// Loads customers.json from the app data directory.
fn task_mcp_load_customers(app: &tauri::AppHandle) -> Result<Vec<Value>, String> {
    let dir  = app_data_dir(app)?;
    let path = dir.join("customers.json");
    match read_json(&path)? {
        Value::Array(arr) => Ok(arr),
        _                 => Ok(Vec::new()),
    }
}

/// Finds the customer whose `id` matches the given customer_id.
fn task_mcp_find_customer<'a>(customers: &'a [Value], customer_id: &str) -> Option<&'a Value> {
    if customer_id.is_empty() { return None; }
    customers.iter().find(|c| c["id"].as_str().unwrap_or("") == customer_id)
}

/// Builds a sanitized developer-defaults object from a customer.
/// Returns None when no relevant defaults are configured.
/// crm_base_dir is the global CRM base directory from settings (may be empty).
fn task_mcp_customer_dev_defaults(customer: &Value, crm_base_dir: &str) -> Option<Value> {
    // Priority: repositoryRootOverride â†’ repositoryRoot â†’ folderName + crm_base_dir.
    // resolvedRepositoryPath is computed client-side and not persisted.
    let repo_root: Option<String> = customer["repositoryRootOverride"].as_str()
        .or_else(|| customer["repositoryRoot"].as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let folder = customer["folderName"].as_str()?.trim();
            if folder.is_empty() || crm_base_dir.is_empty() { return None; }
            Some(format!("{}/{}", crm_base_dir.trim_end_matches('/'), folder))
        });
    let repo_root = repo_root.as_deref();
    let script_dir   = customer["scriptFolder"].as_str().filter(|s| !s.is_empty());
    let plugin_dir   = customer["pluginFolder"].as_str().filter(|s| !s.is_empty());
    let js_conv      = customer["jsConventionsSource"].as_str().filter(|s| !s.is_empty());
    let plugin_conv  = customer["pluginConventionsSource"].as_str().filter(|s| !s.is_empty());

    if repo_root.is_none() && script_dir.is_none() && plugin_dir.is_none()
        && js_conv.is_none() && plugin_conv.is_none() {
        return None;
    }

    let mut obj = serde_json::json!({});
    if let Some(v) = repo_root   { obj["repositoryRoot"]          = serde_json::json!(v); }
    if let Some(v) = script_dir  { obj["scriptDirectory"]         = serde_json::json!(v); }
    if let Some(v) = plugin_dir  { obj["pluginProjectPath"]       = serde_json::json!(v); }
    if let Some(v) = js_conv     { obj["jsConventionsSource"]     = serde_json::json!(v); }
    if let Some(v) = plugin_conv { obj["pluginConventionsSource"] = serde_json::json!(v); }
    Some(obj)
}

/// Computes a resolved script naming block for a script task.
/// Uses customer dev defaults (scriptDirectory, repositoryRoot), task workflowSetup,
/// and technical plan target to derive file name, function names, and paths.
/// Returns None when the entity logical name cannot be determined.
fn task_mcp_compute_script_naming(task: &Value, customer_dev_defaults: Option<&Value>) -> Option<Value> {
    let setup = &task["workflowSetup"];
    let plan_target = &task["crmDeveloperWorkflow"]["technicalPlan"]["target"];

    let entity_name = setup["primaryEntityLogicalName"].as_str()
        .or_else(|| plan_target["entityLogicalName"].as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)?;

    let event_field_name = setup["eventFieldName"].as_str()
        .or_else(|| plan_target["eventFieldName"].as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let scripts_folder_abs = customer_dev_defaults
        .and_then(|d| d["scriptDirectory"].as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let repo_root = customer_dev_defaults
        .and_then(|d| d["repositoryRoot"].as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    // Derive relative folder from absolute minus repo root
    let scripts_folder_rel: Option<String> = scripts_folder_abs.as_deref().and_then(|abs| {
        if let Some(root) = repo_root.as_deref() {
            let norm_root = root.trim_end_matches(|c: char| c == '/' || c == '\\');
            if abs.to_lowercase().starts_with(&norm_root.to_lowercase()) {
                let rel = &abs[norm_root.len()..];
                let rel = rel.trim_start_matches(|c: char| c == '/' || c == '\\');
                if !rel.is_empty() {
                    return Some(rel.to_string());
                }
            }
        }
        // Fallback: last path component
        abs.replace('\\', "/").split('/').filter(|s| !s.is_empty()).last().map(str::to_string)
    });

    let uses_backslash = scripts_folder_abs.as_deref().map(|s| s.contains('\\')).unwrap_or(false)
        || repo_root.as_deref().map(|s| s.contains('\\')).unwrap_or(false);
    let sep = if uses_backslash { "\\" } else { "/" };

    let naming_source = setup["namingSource"].as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("Scripts_Naming")
        .to_string();

    let desired_script_file = setup["desiredScriptFile"].as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}_events.js", entity_name));

    let script_path = scripts_folder_rel.as_deref()
        .map(|rel| format!("{}{}{}", rel, sep, desired_script_file));

    let absolute_script_path = scripts_folder_abs.as_deref()
        .map(|abs| format!("{}{}{}", abs, sep, desired_script_file));

    let on_load_fn = setup["onLoadFunctionName"].as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}_OnLoad", entity_name));

    let on_change_fn = setup["onChangeFunctionName"].as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| event_field_name.as_deref().map(|f| format!("{}_OnChange", f)));

    let main_helper = setup["mainHelperSuggestion"].as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let mut obj = serde_json::json!({
        "namingSource": naming_source,
        "entityLogicalName": entity_name,
        "desiredScriptFile": desired_script_file,
        "onLoadFunctionName": on_load_fn,
        "helperNamingRule": "descriptive camelCase, no nvr_ prefix by default",
    });
    if let Some(v) = scripts_folder_abs   { obj["scriptsFolderAbsolute"]  = serde_json::json!(v); }
    if let Some(v) = scripts_folder_rel   { obj["scriptsFolderRelative"]  = serde_json::json!(v); }
    if let Some(v) = script_path          { obj["scriptPath"]             = serde_json::json!(v); }
    if let Some(v) = absolute_script_path { obj["absoluteScriptPath"]     = serde_json::json!(v); }
    if let Some(v) = on_change_fn         { obj["onChangeFunctionName"]   = serde_json::json!(v); }
    if let Some(v) = main_helper          { obj["mainHelperSuggestion"]   = serde_json::json!(v); }
    Some(obj)
}

/// Resolves the artifact (.cs) path for a task.
///
/// Priority:
///   1. `task.workflowSetup.artifactPath` (explicit, already persisted)
///   2. Infer by listing .cs files in the plugin project subfolder;
///      succeeds only when exactly one non-AssemblyInfo candidate exists.
///
/// If `persist_inferred` is true and a path was inferred, it is written back into
/// `tasks[task_index]["workflowSetup"]["artifactPath"]`.
///
/// Returns `(path, inferred)` or a descriptive error.
fn mcp_resolve_artifact_path(
    app: &tauri::AppHandle,
    task: &Value,
    persist_inferred: bool,
    tasks: &mut Vec<Value>,
    task_index: usize,
) -> Result<(String, bool), String> {
    // 1. Explicit path
    if let Some(p) = task["workflowSetup"]["artifactPath"].as_str().filter(|s| !s.trim().is_empty()) {
        return Ok((p.replace('\\', "/"), false));
    }

    // 1b. scriptPath fallback for script tasks (old data may only have scriptPath set).
    if let Some(p) = task["workflowSetup"]["scriptPath"].as_str().filter(|s| !s.trim().is_empty()) {
        return Ok((p.replace('\\', "/"), false));
    }

    // 2. Inference
    let project_name = task["workflowSetup"]["pluginProject"].as_str()
        .or_else(|| task["selectedPluginProject"].as_str())
        .unwrap_or("").trim();
    if project_name.is_empty() {
        return Err("No artifactPath and no pluginProject set on this task. Set workflowSetup.pluginProject or artifactPath.".into());
    }

    // Build candidate project folder paths to search
    let mut candidates: Vec<String> = Vec::new();

    // Option A: repositoryRoot/Plugins/ProjectName/ProjectName
    if let Some(repo) = task["workflowSetup"]["repositoryRoot"].as_str() {
        candidates.push(format!("{}/Plugins/{}/{}", repo.replace('\\', "/").trim_end_matches('/'), project_name, project_name));
    }

    // Option B: customer.pluginFolder/ProjectName/ProjectName  or
    //           settings.crmBaseDirectory/customer.folderName/Plugins/ProjectName/ProjectName
    let customer_id = task["customerId"].as_str().unwrap_or("");
    if !customer_id.is_empty() {
        if let Ok(customers) = task_mcp_load_customers(app) {
            if let Some(cust) = customers.iter().find(|c| c["id"].as_str() == Some(customer_id)) {
                if let Some(pf) = cust["pluginFolder"].as_str() {
                    candidates.push(format!("{}/{}/{}", pf.replace('\\', "/").trim_end_matches('/'), project_name, project_name));
                }
                if let Ok(settings) = load_settings(app.clone()) {
                    if let (Some(base), Some(folder)) = (
                        settings["crmBaseDirectory"].as_str(),
                        cust["folderName"].as_str(),
                    ) {
                        candidates.push(format!("{}/{}/Plugins/{}/{}", base.replace('\\', "/").trim_end_matches('/'), folder, project_name, project_name));
                    }
                }
            }
        }
    }

    for folder in &candidates {
        let p = std::path::Path::new(folder);
        if !p.is_dir() { continue; }
        let cs_files: Vec<String> = fs::read_dir(p)
            .map_err(|e| format!("Cannot list '{folder}': {e}"))?
            .flatten()
            .filter(|e| {
                let path = e.path();
                path.extension().map_or(false, |ext| ext.eq_ignore_ascii_case("cs"))
                    && !path.file_name()
                        .map_or(false, |n| n.to_string_lossy().to_lowercase().contains("assemblyinfo"))
            })
            .map(|e| e.path().to_string_lossy().replace('\\', "/"))
            .collect();
        match cs_files.len() {
            0 => continue,
            1 => {
                let path = cs_files.into_iter().next().unwrap();
                if persist_inferred {
                    tasks[task_index]["workflowSetup"]["artifactPath"] = Value::String(path.clone());
                }
                return Ok((path, true));
            }
            _ => {
                return Err(format!(
                    "Multiple .cs files found in '{}'. Set workflowSetup.artifactPath explicitly: {}",
                    folder, cs_files.join(", ")
                ));
            }
        }
    }

    Err(format!(
        "Could not find a plugin project folder for '{}'. Set workflowSetup.artifactPath or workflowSetup.repositoryRoot.",
        project_name
    ))
}

#[cfg(test)]
mod task_storage_tests {
    use super::*;
    use tempfile::TempDir;

    fn make_tasks(n: usize) -> Value {
        let items: Vec<Value> = (0..n).map(|i| serde_json::json!({ "id": i })).collect();
        Value::Array(items)
    }

    // â”€â”€ guard: non-empty file cannot be overwritten with [] â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn blocks_empty_overwrite_of_nonempty_file() {
        let dir = TempDir::new().unwrap();
        let d   = dir.path().to_path_buf();

        save_tasks_impl(&d, &make_tasks(3), false).unwrap();

        let result = save_tasks_impl(&d, &Value::Array(vec![]), false);
        assert!(result.is_err(), "expected error when overwriting with []");
        let err = result.unwrap_err();
        assert!(
            err.contains("ERR_EMPTY_OVERWRITE"),
            "expected ERR_EMPTY_OVERWRITE prefix in: {err}"
        );
        assert!(err.contains('3'), "expected existing count in error: {err}");

        // tasks.json must still contain 3 tasks
        assert_eq!(count_tasks_on_disk(&d.join("tasks.json")).unwrap(), 3);
    }

    // â”€â”€ first-run: missing tasks.json can be created as [] â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn first_run_missing_file_allows_empty_write() {
        let dir = TempDir::new().unwrap();
        let d   = dir.path().to_path_buf();

        // No tasks.json exists yet â†’ existing_count == 0 â†’ guard not triggered
        save_tasks_impl(&d, &Value::Array(vec![]), false).unwrap();

        assert_eq!(count_tasks_on_disk(&d.join("tasks.json")).unwrap(), 0);
    }

    // â”€â”€ normal save with tasks succeeds â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn normal_nonempty_save_works() {
        let dir = TempDir::new().unwrap();
        let d   = dir.path().to_path_buf();

        save_tasks_impl(&d, &make_tasks(5), false).unwrap();

        assert_eq!(count_tasks_on_disk(&d.join("tasks.json")).unwrap(), 5);
    }

    // â”€â”€ explicit reset is the only path that can overwrite with [] â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn explicit_reset_allows_empty_overwrite() {
        let dir = TempDir::new().unwrap();
        let d   = dir.path().to_path_buf();

        save_tasks_impl(&d, &make_tasks(4), false).unwrap();

        // allow_empty_overwrite = true â†’ should succeed
        save_tasks_impl(&d, &Value::Array(vec![]), true).unwrap();
        assert_eq!(count_tasks_on_disk(&d.join("tasks.json")).unwrap(), 0);
    }

    // â”€â”€ backup pruning keeps only the configured maximum â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn prune_keeps_at_most_five_backups() {
        let dir = TempDir::new().unwrap();
        let d   = dir.path().to_path_buf();

        // Manually create 8 backup files with distinct sortable timestamps
        for i in 1u64..=8 {
            let name    = format!("tasks.backup-{:010}.json", i * 1_000);
            let content = serde_json::to_string_pretty(&make_tasks(1)).unwrap();
            fs::write(d.join(&name), &content).unwrap();
        }

        prune_task_backups(&d, 5);

        let kept = list_task_backups(&d);
        assert_eq!(kept.len(), 5, "expected exactly 5 backups after prune");

        // The 5 with highest timestamps (4000â€“8000) must be kept
        for bp in &kept {
            let fname = bp.file_name().unwrap().to_str().unwrap();
            let ts: u64 = fname
                .strip_prefix("tasks.backup-").unwrap()
                .strip_suffix(".json").unwrap()
                .parse().unwrap();
            assert!(ts >= 4_000, "expected only recent backups kept, got ts={ts}");
        }
    }

    // â”€â”€ a backup is created before every overwrite â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn backup_is_created_before_overwrite() {
        let dir = TempDir::new().unwrap();
        let d   = dir.path().to_path_buf();

        // Seed 3 tasks
        save_tasks_impl(&d, &make_tasks(3), false).unwrap();
        let backups_before = list_task_backups(&d).len();

        // Overwrite with 5 tasks â†’ a backup of the 3-task version should appear
        save_tasks_impl(&d, &make_tasks(5), false).unwrap();
        let backups_after = list_task_backups(&d);

        assert!(
            !backups_after.is_empty() && backups_after.len() >= backups_before,
            "expected at least one backup after second save"
        );

        // The backup should hold the pre-second-save content (3 tasks)
        let backup_val = read_json(backups_after.last().unwrap()).unwrap();
        assert_eq!(json_array_len(&backup_val), 3);
    }

    // â”€â”€ check_task_storage: normal non-empty case â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn check_storage_normal_nonempty() {
        let dir = TempDir::new().unwrap();
        let d   = dir.path().to_path_buf();

        save_tasks_impl(&d, &make_tasks(7), false).unwrap();
        let status = check_task_storage_impl(&d).unwrap();

        assert_eq!(status.task_count, 7);
        assert!(!status.empty_with_nonempty_backups);
        assert_eq!(status.newest_backup_task_count, 0);
    }

    // â”€â”€ check_task_storage: empty file with non-empty backups â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn check_storage_detects_empty_file_with_nonempty_backup() {
        let dir = TempDir::new().unwrap();
        let d   = dir.path().to_path_buf();

        // Write tasks, then explicitly clear to empty (which creates a backup)
        save_tasks_impl(&d, &make_tasks(4), false).unwrap();
        save_tasks_impl(&d, &Value::Array(vec![]), true).unwrap();

        let status = check_task_storage_impl(&d).unwrap();

        assert_eq!(status.task_count, 0);
        assert!(status.backup_count > 0);
        assert!(status.empty_with_nonempty_backups);
        assert_eq!(status.newest_backup_task_count, 4);
    }

    // â”€â”€ check_task_storage: first-run (no file, no backups) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn check_storage_first_run_all_zero() {
        let dir = TempDir::new().unwrap();
        let d   = dir.path().to_path_buf();

        let status = check_task_storage_impl(&d).unwrap();

        assert_eq!(status.task_count, 0);
        assert_eq!(status.backup_count, 0);
        assert!(!status.empty_with_nonempty_backups);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_truncated_five_column_schema_as_incomplete() {
        let payload = serde_json::json!({
            "columns": [
                { "logicalName": "fullname" },
                { "logicalName": "ownerid" },
                { "logicalName": "emailaddress1" },
                { "logicalName": "telephone1" },
                { "logicalName": "mobilephone" }
            ]
        });

        let entry = build_entity_metadata_cache_entry(&payload, "list_columns", None, false, true);
        assert_eq!(entry.column_count, 5);
        assert_eq!(entry.schema_completeness, "incomplete");
        assert!(entry.note.unwrap_or_default().contains("truncated"));
    }

    #[test]
    fn marks_complete_schema_when_total_matches_returned_columns() {
        let payload = serde_json::json!({
            "columns": [
                { "logicalName": "fullname" },
                { "logicalName": "ownerid" },
                { "logicalName": "emailaddress1" },
                { "logicalName": "telephone1" },
                { "logicalName": "mobilephone" },
                { "logicalName": "jobtitle" }
            ],
            "totalCount": 6,
            "hasMore": false
        });

        let entry = build_entity_metadata_cache_entry(&payload, "list_columns", Some("all=true".to_string()), true, true);
        assert_eq!(entry.column_count, 6);
        assert_eq!(entry.schema_completeness, "complete");
    }

    #[test]
    fn js_primary_form_entity_produces_inferred_confidence() {
        let scan = CrmScanResult {
            entity_references: vec![CrmScanEntityReference {
                logical_name: "account".to_string(),
                source_reason: "from primary form entity inference".to_string(),
                context_type: "primary_form_entity".to_string(),
            }],
            ..Default::default()
        };
        assert_eq!(compute_static_inference_confidence(&scan), "inferred");
    }

    #[test]
    fn no_entity_reference_and_no_attrs_produces_unknown_confidence() {
        let scan = CrmScanResult::default();
        assert_eq!(compute_static_inference_confidence(&scan), "unknown");
    }

    #[test]
    fn attribute_refs_without_entity_produce_low_confidence() {
        let scan = CrmScanResult {
            attribute_references: vec![CrmScanAttributeReference {
                logical_name: "fullname".to_string(),
                entity_logical_name: None,
                source_reason: "from formContext".to_string(),
                context_type: "formContext".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(compute_static_inference_confidence(&scan), "low");
    }

    #[test]
    fn unable_to_verify_reasons_dedup_removes_exact_duplicates() {
        let mut reasons = vec![
            "Column metadata for entity 'account' was incomplete; only 5 columns were returned.".to_string(),
            "Column metadata for entity 'account' was incomplete; only 5 columns were returned.".to_string(),
            "Primary form entity: account.".to_string(),
        ];
        reasons.sort();
        reasons.dedup();
        assert_eq!(reasons.len(), 2);
    }

    #[test]
    fn attribute_in_incomplete_schema_is_not_marked_confirmed() {
        let entry = EntityMetadataCacheEntry {
            attributes: ["fullname", "ownerid"].iter().map(|s| s.to_string()).collect(),
            column_count: 2,
            schema_completeness: "incomplete".to_string(),
            ..Default::default()
        };
        // Attribute is present in returned columns but schema is not complete.
        // The classification condition: found && !complete â†’ ambiguous branch.
        let found = entry.attributes.contains("fullname");
        let would_confirm = entry.schema_completeness == "complete";
        assert!(found, "attribute must be in the returned columns");
        assert!(!would_confirm, "incomplete schema must not trigger the confirmed branch");
    }

    #[test]
    fn list_columns_real_mcp_response_extracts_attrs_via_fallback() {
        // Simulates the real MCP response shape from Primarch list_columns:
        //   {"content":[{"type":"text","text":"{\"entity\":\"account\",\"count\":5,\"columns\":[{\"n\":\"...\"}]}"}]}
        // collect_column_names returns 0 (no "logicalName" key); fallback extracts from text string.
        let payload = serde_json::json!({
            "content": [{
                "type": "text",
                "text": "{\"entity\":\"account\",\"count\":5,\"columns\":[{\"n\":\"nvr_erprelevant\",\"d\":\"ERP Relevant\",\"t\":\"Boolean\"},{\"n\":\"nvr_sendtoerp\",\"d\":\"Send to ERP\",\"t\":\"Boolean\"},{\"n\":\"parentaccountid\",\"d\":\"Parent Account\",\"t\":\"Lookup\"},{\"n\":\"fullname\",\"d\":\"Full Name\",\"t\":\"String\"},{\"n\":\"telephone1\",\"d\":\"Business Phone\",\"t\":\"String\"}]}"
            }]
        });
        // list_columns has no paging params: supports_paging=false, limit params never sent
        let entry = build_entity_metadata_cache_entry(&payload, "list_columns", None, false, true);
        // All 5 real column names must be in the attributes set (extracted via fallback string scan)
        assert!(entry.attributes.contains("nvr_erprelevant"), "nvr_erprelevant must be found");
        assert!(entry.attributes.contains("nvr_sendtoerp"), "nvr_sendtoerp must be found");
        assert!(entry.attributes.contains("parentaccountid"), "parentaccountid must be found");
        assert!(entry.attributes.contains("fullname"), "fullname must be found");
        assert!(entry.attributes.contains("telephone1"), "telephone1 must be found");
        // column_count is at least 5 (may be more due to false positives from display name substrings)
        assert!(entry.column_count >= 5, "column_count must be at least 5");
        // The count:5 is inside the nested text string, which find_count_key does not parse.
        // False-positive tokens from display names ("ERP Relevant" â†’ "elevant", etc.) push
        // column_count above 5, so the <=5 incomplete heuristic does not fire.
        // Result: schema_completeness = "unknown" (conservative â€” we cannot prove it is complete or truncated).
        assert_eq!(entry.schema_completeness, "unknown",
            "list_columns text-wrapper format: count buried in string â†’ unknown, not incomplete");
    }

    // â”€â”€ validate_working_directory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn validate_wd_empty_string_returns_none() {
        assert_eq!(validate_working_directory(""), Ok(None));
    }

    #[test]
    fn validate_wd_whitespace_only_returns_none() {
        assert_eq!(validate_working_directory("   "), Ok(None));
    }

    #[test]
    fn validate_wd_existing_directory_is_accepted() {
        let dir = std::env::temp_dir();
        let result = validate_working_directory(dir.to_str().unwrap());
        assert!(result.is_ok(), "temp dir should be accepted: {:?}", result);
        assert!(result.unwrap().is_some());
    }

    #[test]
    fn validate_wd_nonexistent_path_is_rejected_with_clear_message() {
        let result = validate_working_directory("/nonexistent/path/task_workbench_test_xyz_99999");
        assert!(result.is_err());
        let msg = result.unwrap_err().to_lowercase();
        assert!(
            msg.contains("does not exist") || msg.contains("working directory"),
            "expected 'does not exist' or 'working directory' in: {msg}"
        );
    }

    #[test]
    fn validate_wd_file_path_is_rejected_with_folder_hint() {
        let tmp_file = std::env::temp_dir().join("task_workbench_wd_file_test.js");
        std::fs::write(&tmp_file, b"// test").expect("write temp file");
        let result = validate_working_directory(tmp_file.to_str().unwrap());
        let _ = std::fs::remove_file(&tmp_file);
        assert!(result.is_err(), "file path must be rejected");
        let msg = result.unwrap_err().to_lowercase();
        assert!(
            msg.contains("file") || msg.contains("folder"),
            "message must mention 'file' or 'folder': {msg}"
        );
    }

    // â”€â”€ task_mcp_customer_dev_defaults â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn customer_dev_defaults_folder_name_plus_crm_base_dir() {
        let customer = serde_json::json!({"id": "vsk", "folderName": "VSK-Test"});
        let result = task_mcp_customer_dev_defaults(&customer, "C:/Dev/repos").unwrap();
        assert_eq!(result["repositoryRoot"].as_str(), Some("C:/Dev/repos/VSK-Test"));
    }

    #[test]
    fn customer_dev_defaults_explicit_repository_root_takes_priority() {
        let customer = serde_json::json!({"id": "vsk", "folderName": "VSK-Test", "repositoryRoot": "D:/custom/path"});
        let result = task_mcp_customer_dev_defaults(&customer, "C:/Dev/repos").unwrap();
        assert_eq!(result["repositoryRoot"].as_str(), Some("D:/custom/path"));
    }

    #[test]
    fn customer_dev_defaults_override_beats_repository_root() {
        let customer = serde_json::json!({"id": "vsk", "repositoryRoot": "D:/base", "repositoryRootOverride": "E:/override"});
        let result = task_mcp_customer_dev_defaults(&customer, "").unwrap();
        assert_eq!(result["repositoryRoot"].as_str(), Some("E:/override"));
    }

    #[test]
    fn customer_dev_defaults_folder_name_without_crm_base_dir_no_repo_root() {
        let customer = serde_json::json!({"id": "vsk", "folderName": "VSK-Test", "scriptFolder": "/Scripts"});
        let result = task_mcp_customer_dev_defaults(&customer, "").unwrap();
        assert!(result.get("repositoryRoot").is_none() || result["repositoryRoot"].is_null(),
            "repositoryRoot must be absent when crmBaseDir is empty");
        assert_eq!(result["scriptDirectory"].as_str(), Some("/Scripts"));
    }

    #[test]
    fn customer_dev_defaults_empty_customer_returns_none() {
        let customer = serde_json::json!({"id": "vsk"});
        assert!(task_mcp_customer_dev_defaults(&customer, "").is_none());
    }

    #[test]
    fn customer_dev_defaults_trailing_slash_stripped_from_base_dir() {
        let customer = serde_json::json!({"id": "vsk", "folderName": "VSK-Test"});
        let result = task_mcp_customer_dev_defaults(&customer, "C:/Dev/repos/").unwrap();
        assert_eq!(result["repositoryRoot"].as_str(), Some("C:/Dev/repos/VSK-Test"));
    }

    #[test]
    fn list_columns_full_186_column_response_is_schema_unknown() {
        // With 186 columns returned: column_count > 5, no paging params, no detectable totalCount
        // â†’ schema_completeness = "unknown" (conservative: we can't prove completeness from this format)
        let mut cols = Vec::new();
        for i in 0..186u32 {
            cols.push(serde_json::json!({"n": format!("attr_{:03}", i), "d": "Display", "t": "String"}));
        }
        let text = serde_json::json!({
            "entity": "account",
            "count": 186,
            "columns": cols
        }).to_string();
        let payload = serde_json::json!({
            "content": [{"type": "text", "text": text}]
        });
        let entry = build_entity_metadata_cache_entry(&payload, "list_columns", None, false, true);
        assert!(entry.column_count > 5, "186 columns â†’ count > 5");
        // totalCount is buried inside text string, find_count_key won't see it â†’ unknown not complete
        assert_eq!(entry.schema_completeness, "unknown",
            "186-column result stays unknown because count is nested in text string");
        // Attributes are still usable: verify a few are present
        assert!(entry.attributes.contains("attr_000"));
        assert!(entry.attributes.contains("attr_185"));
    }
}
// --- Entry point -----------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            start_task_mcp_bridge(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_tasks,
            save_tasks,
            clear_all_tasks,
            check_task_storage,
            restore_tasks_from_latest_backup,
            load_customers,
            save_customers,
            load_settings,
            save_settings,
            open_path,
            open_in_vscode,
            open_in_vscode_workspace,
            open_with_shell,
            open_url_in_edge,
            pick_folder,
            pick_file,
            check_path_exists,
            rescan_repositories,
            validate_template,
            create_repository_from_template,
            initialize_git_repository,
            analyze_task,
            generate_reply,
            generate_skeleton_preview,
            save_generated_file,
            restore_nuget_packages,
            check_plugin_build_readiness,
            add_compile_include_to_csproj,
            run_ai_file_review,
            create_plugin_project_from_template,
            classify_inbox_item,
            reset_local_data,
            connect_microsoft_account,
            refresh_microsoft_connection,
            disconnect_microsoft_account,
            get_microsoft_connection_state,
            get_outlook_messages,
            get_outlook_flagged_list,
            get_outlook_message_full,
            get_teams_chats,
            get_teams_chat_messages,
            get_teams_intake_messages,
            get_teams_recent_messages,
            get_teams_self_chat_messages,
            collect_git_review_context,
            collect_git_file_review_context,
            read_file_content,
            list_directory_files,
            list_files_with_paths,
            infer_review_file_path,
            list_crm_folders,
            get_git_branch,
            git_has_head,
            get_git_branch_quick,
            list_git_branches,
            git_has_uncommitted,
            git_checkout_branch,
            get_git_diff,
            run_ai_change_review,
            run_ai_kit_implementation,
                get_task_mcp_bridge_status,
                test_primarch_mcp_connection,
                list_primarch_mcp_tools,
                generate_crm_skeleton,
                scan_cs_file_for_crm,
                verify_against_crm,
                get_git_commit_preview,
                commit_task_changes,
                push_task_branch,
                commit_and_push_task_changes,
                create_git_branch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

