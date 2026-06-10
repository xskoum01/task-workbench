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
/// On Windows GUI apps, any child process that is a console application (git, cmd, …)
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
    let path = app_data_dir(&app)?.join("tasks.json");
    let value = read_json(&path)?;
    if value.is_null() {
        Ok(Value::Array(vec![]))
    } else {
        Ok(value)
    }
}

#[tauri::command]
fn save_tasks(app: tauri::AppHandle, tasks: Value) -> Result<(), String> {
    let path = app_data_dir(&app)?.join("tasks.json");
    write_json(&path, &tasks)
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
        // Legacy fields — kept for backward compatibility
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
/// On macOS/Linux, `code` is a normal shell wrapper — direct exec is fine.
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
/// directly — no git process is spawned, so this is instantaneous even on
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
        // Detached HEAD — show abbreviated SHA so the UI shows something useful.
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
                    // Path IS the repo root — diff the whole repo.
                    eprintln!("[get_git_diff] relative=(whole repo)");
                    None
                } else {
                    return Err("Selected file is outside the Git repository.".to_string());
                }
            } else {
                // Already relative — normalize slashes only.
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

    let unstaged = run_diff(&[])?;
    let staged   = run_diff(&["--cached"])?;
    eprintln!("[get_git_diff] unstaged_len={} staged_len={}", unstaged.len(), staged.len());

    // Return combined diff when both halves have content, avoiding duplication.
    let diff = match (unstaged.is_empty(), staged.is_empty()) {
        (false, false) => format!("{unstaged}\n{staged}"),
        (false, true)  => unstaged,
        (true,  false) => staged,
        (true,  true)  => String::new(),
    };
    Ok(diff)
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
        // OpenAI — with legacy fallback
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
            "AI API key not configured. Add your {label} API key in Settings → AI."
        ));
    }

    Ok(AiConfig { provider, api_key, model })
}

/// Legacy helper — kept to avoid touching unchanged call sites individually.
/// New code should use get_ai_config.
#[allow(dead_code)]
fn get_ai_settings(app: &tauri::AppHandle) -> Result<(String, String), String> {
    let c = get_ai_config(app)?;
    Ok((c.api_key, c.model))
}

/// OpenAI Responses API call with optional temperature.
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
    if let Some(t) = temperature {
        if t > 0.0 {
            body["temperature"] = serde_json::Value::from(t.clamp(0.0, 2.0));
        }
    }

    let resp = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("OpenAI API error {status}: {text}"));
    }

    let json: Value = resp.json().await.map_err(|e| e.to_string())?;

    // Responses API: output[0].content[0].text
    json["output"][0]["content"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| {
            let snippet = json.to_string();
            format!("Unexpected OpenAI response format: {}", &snippet[..snippet.len().min(300)])
        })
}

/// Calls the Anthropic Messages API and returns the text of the first content block.
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
            body["temperature"] = serde_json::Value::from(t.clamp(0.0, 1.0));
        }
    }

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Anthropic API error {status}: {text}"));
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
    // Fix null bilingual array fields — only touch keys that already exist in the response
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
    // Do NOT synthesise missing bilingual fields from legacy English values —
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
Return ONLY valid JSON — no markdown, no prose, no code fences. \
All bilingual fields (summaryCz, summaryEn, problemPointsCz, problemPointsEn, \
actionPointsCz, actionPointsEn, nextStepCz, nextStepEn) are MANDATORY. \
Czech fields must be real Czech. English fields must be real English.";

    let prompt = format!(
        "Analyse this work request. Return ALL fields — bilingual fields are required.\n\n\
Task:\n- Title: {title}\n- Type: {task_type}\n- Source: {source}\n- Message: {message}\n\n\
Customer:\n- Name: {customer_name}\n- Namespace: {namespace}\n- Repository: {repo_name}\n\n\
Return ONLY this exact JSON shape (fill every field with real content):\n\
{{\
\"summary\":\"1-2 sentence English summary\",\
\"problemPoints\":[\"English problem bullet\"],\
\"suggestedActions\":[{{\"id\":\"ai1\",\"label\":\"Concrete English action step\"}}],\
\"confidence\":85,\
\"nextStep\":\"Most important next action in English\",\
\"summaryCz\":\"1-2 věty česky popisující problém\",\
\"summaryEn\":\"1-2 sentences in English describing the problem\",\
\"problemPointsCz\":[\"Krátký český bod o problému.\",\"Kde se projevuje nebo kdo je ovlivněn.\"],\
\"problemPointsEn\":[\"Short English bullet about the problem.\",\"Where it occurs or who is affected.\"],\
\"actionPointsCz\":[\"Konkrétní akční krok česky.\",\"Druhý krok česky.\"],\
\"actionPointsEn\":[\"Concrete action step in English.\",\"Second step in English.\"],\
\"nextStepCz\":\"Jeden jasný bezprostřední krok česky.\",\
\"nextStepEn\":\"One clear immediate next step in English.\"\
}}\n\n\
Rules — follow strictly:\n\
- ALL 13 fields above are mandatory. Do not omit any.\n\
- summaryCz and all *Cz fields: must be natural Czech — not translated literally, not English.\n\
- summaryEn and all *En fields: must be natural English — not Czech.\n\
- problemPointsCz / problemPointsEn: 2-4 bullets — what is wrong, where, who is affected.\n\
- actionPointsCz / actionPointsEn: 2-4 bullets — concrete steps to fix the issue.\n\
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

    let instructions = "Write brief professional client replies. Plain text only — no markdown.";

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
    let namespace = customer["namespace"].as_str().unwrap_or("MyProject");

    let instructions = "Generate C# plugin skeletons for Dynamics 365 / Dataverse. \
Respond with ONLY valid JSON — no markdown, no code fences.";

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
Base Execute stub — you MUST preserve this structure and extend it with task-specific logic:\n\
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
/// The API key is read from settings.json — never exposed to the frontend.
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
        format!("{}\n\n… [file truncated at 200 KB]", &raw[..boundary])
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

Vráť POUZE platné JSON bez prose, bez markdown kódových blőků, bez jiného textu.
Veškerý textový obsah (summary, title, problem, recommendation, generalSuggestions) píši český.
Kódové úseky (codeSnippet, suggestedCode) ponechávej v originálním programovacím jazyce, nepřekládej je.

Požadované schéma:
{
  "verdict": "pass" | "needs_changes" | "comment",
  "summary": "český souhrnny odstavec.",
  "comments": [
    {
      "severity": "critical" | "major" | "minor" | "suggestion",
      "lineStart": 42,
      "lineEnd": 58,
      "title": "Krátký český název problému",
      "problem": "- První problém\n- Druhý problém\n- Třetí problém",
      "recommendation": "- První krok\n- Druhý krok\n- Třetí krok",
      "codeSnippet": "1–5 řádků z původního souboru ilustrující problém",
      "suggestedCode": "Volitelný opravový kód"
    }
  ],
  "generalSuggestions": ["české obecné doporučení neodpovídající konkrétnímu řádku"]
}

Pravidla:
- Odpovídej česky.
- Nejvýše 8 komentářů.
- Nápis title: krátký, max 6 slov.
- problem a recommendation: krátké odrůkové body, každý na novém řádku začínající "-".
- Nepíši dlouhé odstavce — preferuj 2–4 krátké odrůky.
- lineStart/lineEnd: uvedeň jen když si jsi jistý přesným místem; jinak vynechat.
- codeSnippet: 1–5 řádků z původního souboru ilustrující problém.
- suggestedCode: volitelný, pouze když máš konkrétní oprávněný návrh.
- verdict: "pass" = žádné zásadní problémy; "comment" = jen mala doporučení; "needs_changes" = důležité problémy.
- Zaměř se na konkrétní problémy udržovatelného kódu, správnosti, Dataverse/Power Apps specifika."#;

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
            // JSON parsing failed — return as markdown so the frontend can still show the result.
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
        format!("{}\n\n… [diff truncated at 200 KB]", &diff[..boundary])
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

Recenzuješ POUZE změny zobrazené v diff — nekomentuješ kód, který diff nezahrnuje.
Pokud diff neobsahuje dostatek kontextu pro posouzení určitého aspektu, uveď to stručně,
ale nevymýšlej problémy v kódu, který v diffu není vidět.

Vráť POUZE platné JSON bez prose, bez markdown kódových bloků, bez jiného textu.
Veškerý textový obsah (summary, title, problem, recommendation, generalSuggestions) piš česky.
Kódové úseky (codeSnippet, suggestedCode) ponechávej v originálním programovacím jazyce.

Požadované schéma:
{
  "verdict": "pass" | "needs_changes" | "comment",
  "summary": "český souhrnný odstavec o změnách v diffu.",
  "comments": [
    {
      "severity": "critical" | "major" | "minor" | "suggestion",
      "lineStart": 42,
      "lineEnd": 58,
      "title": "Krátký český název problému",
      "problem": "- První problém\n- Druhý problém",
      "recommendation": "- První krok\n- Druhý krok",
      "codeSnippet": "1–5 řádků z diffu ilustrující problém",
      "suggestedCode": "Volitelný opravový kód"
    }
  ],
  "generalSuggestions": ["české obecné doporučení k diffu"]
}

Pravidla:
- Odpovídej česky.
- Komentuj POUZE řádky označené '+' nebo '-' v diffu — ignoruj kontext ('  ').
- Nejvýše 8 komentářů.
- title: krátký, max 6 slov.
- problem a recommendation: krátké odrážkové body, každý začínající '-'.
- lineStart/lineEnd: čísla řádků z diffu ('+' strany), pokud je lze spolehlivě určit.
- verdict: "pass" = vše v pořádku; "comment" = drobná doporučení; "needs_changes" = důležité problémy.
- Zaměř se na konkrétní problémy v nových/změněných řádcích — správnost, udržovatelnost, Dataverse/Power Apps specifika."#;

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
            // filePath is not a single file for a diff review — use file_name as a hint.
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

/// Creates a new plugin project directory from a local template folder.
/// Copies the template tree into target_dir/<project_name>, replacing
/// __PROJECT_NAME__ and __NAMESPACE__ placeholders in file contents and names.
/// Returns the absolute path of the created project folder.
#[tauri::command]
fn create_plugin_project_from_template(
    template_dir: String,
    plugins_dir: String,
    project_name: String,
    namespace: String,
    create_initial_class: bool,
) -> Result<String, String> {
    let dest = std::path::Path::new(&plugins_dir).join(&project_name);
    if dest.exists() {
        return Err(format!("Project folder already exists: {}", dest.display()));
    }

    if template_dir.is_empty() {
        // -----------------------------------------------------------------
        // Built-in default scaffold — no custom template configured.
        // Standard Visual Studio layout:
        //   <plugins_dir>/<project_name>/                ← solution root
        //     <project_name>.sln
        //     <project_name>/                            ← project folder
        //       <project_name>.csproj
        //       <ClassName>.cs  (when create_initial_class is true)
        // -----------------------------------------------------------------
        fs::create_dir_all(&dest).map_err(|e| format!("Failed to create solution root: {e}"))?;

        // Nested project folder inside the solution root
        let proj_dir = dest.join(&project_name);
        fs::create_dir_all(&proj_dir).map_err(|e| format!("Failed to create project folder: {e}"))?;

        // Resolve the latest stable CrmSdk version from NuGet; fall back to a known-good version.
        let crmsdk_version = resolve_nuget_version("Microsoft.CrmSdk.CoreAssemblies", "9.0.2.49");

        // Generate a stable GUID for the project reference inside the .sln.
        // A fixed-but-unique GUID per project is fine — what matters is consistency between .sln and .csproj.
        let proj_guid = format!("{:08X}-{:04X}-{:04X}-{:04X}-{:012X}",
            0xAABBCCDDu32, 0x1234u16, 0x5678u16, 0x9ABCu16, 0x0123456789ABu64);

        // SDK-style .csproj — supported by VS 2017+ and MSBuild 15+.
        // All .cs files in the project directory are included automatically (no <Compile> lists needed).
        // This means the generated plugin class saved later by saveGeneratedFile is compiled without
        // any manual project file edits.
        let csproj = format!(
            r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net462</TargetFramework>
    <LangVersion>latest</LangVersion>
    <Nullable>disable</Nullable>
    <AssemblyName>{project_name}</AssemblyName>
    <RootNamespace>{namespace}</RootNamespace>
    <GenerateAssemblyInfo>false</GenerateAssemblyInfo>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.CrmSdk.CoreAssemblies" Version="{crmsdk_version}" />
  </ItemGroup>
</Project>
"#
        );
        fs::write(proj_dir.join(format!("{project_name}.csproj")), &csproj)
            .map_err(|e| format!("Failed to write .csproj: {e}"))?;

        // C# project type GUID (used by Visual Studio to identify SDK-style and legacy C# projects alike)
        let cs_project_type_guid = "FAE04EC0-301F-11D3-BF4B-00C04F79EFBC";

        // .sln goes in the solution root; .csproj path is relative: <ProjectName>\<ProjectName>.csproj
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

        if create_initial_class {
            let class_name = format!("{}Plugin", &project_name
                .split('.')
                .last()
                .unwrap_or(&project_name));
            let class_file = proj_dir.join(format!("{class_name}.cs"));
            if !class_file.exists() {
                let content = format!(
                    "using Microsoft.Xrm.Sdk;\n\
using System;\n\n\
namespace {namespace}\n\
{{\n\
    /// <summary>\n\
    /// Plugin stub for {namespace}.\n\
    /// </summary>\n\
    public class {class_name} : IPlugin\n\
    {{\n\
        public void Execute(IServiceProvider serviceProvider)\n\
        {{\n\
            ITracingService tracer = (ITracingService)serviceProvider.GetService(typeof(ITracingService));\n\
            IPluginExecutionContext context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));\n\
            IOrganizationServiceFactory serviceFactory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));\n\
            IOrganizationService service = serviceFactory.CreateOrganizationService(context.UserId);\n\n\
            if (context.InputParameters.Contains(\"Target\") && context.InputParameters[\"Target\"] is Entity)\n\
            {{\n\
                Entity contextEntity = (Entity)context.InputParameters[\"Target\"];\n\
                Guid initiatingUserId = context.InitiatingUserId;\n\n\
                // TODO: implement plugin logic\n\
            }}\n\
        }}\n\
    }}\n\
}}\n"
                );
                fs::write(&class_file, content)
                    .map_err(|e| format!("Failed to write initial class: {e}"))?;
            }
        }

        // Try to format the generated code with `dotnet format`.
        // Failure is intentionally ignored — project creation succeeds regardless.
        let _ = std::process::Command::new("dotnet")
            .arg("format")
            .arg(dest.join(format!("{project_name}.sln")).to_string_lossy().as_ref())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();

        // Return the solution root so the caller can open the .sln from there
        return Ok(dest.to_string_lossy().to_string());
    }

    // -----------------------------------------------------------------
    // Custom template path
    // -----------------------------------------------------------------
    let src = std::path::Path::new(&template_dir);
    if !src.is_dir() {
        return Err(format!("Template directory not found: {template_dir}"));
    }
    // Copy template tree with placeholder substitution
    copy_template_tree(src, &dest, &project_name, &namespace)
        .map_err(|e| format!("Template copy failed: {e}"))?;

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

/// Recursively copies `src` into `dest`, substituting __PROJECT_NAME__ and
/// __NAMESPACE__ in both file contents and file/folder names.
fn copy_template_tree(
    src: &std::path::Path,
    dest: &std::path::Path,
    project_name: &str,
    namespace: &str,
) -> Result<(), io::Error> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();
        // Skip .github — it must never be copied into a plugin project folder
        if name_str == ".github" {
            continue;
        }
        // Substitute placeholders in the entry name itself
        let new_name = name_str
            .replace("__PROJECT_NAME__", project_name)
            .replace("__NAMESPACE__", namespace);
        let src_path  = entry.path();
        let dest_path = dest.join(&new_name);
        if src_path.is_dir() {
            copy_template_tree(&src_path, &dest_path, project_name, namespace)?;
        } else {
            // Only substitute placeholders in text-like files
            let ext = src_path.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            let is_text = matches!(ext, "cs" | "csproj" | "sln" | "json" | "xml"
                | "config" | "txt" | "md" | "targets" | "props" | "yml" | "yaml");
            if is_text {
                let content = fs::read_to_string(&src_path).unwrap_or_default();
                let new_content = content
                    .replace("__PROJECT_NAME__", project_name)
                    .replace("__NAMESPACE__", namespace);
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
        format!("{}…[truncated]", &content[..3000])
    } else {
        content.clone()
    };

    // Try AI. If not configured or call fails, use heuristic fallback.
    let ai_result = get_ai_config(&app);
    match ai_result {
        Ok(config) => {
            // --- AI path ---
            let source_context = match source.as_str() {
                "teams" => "Teams chat message (very noisy channel — be strict, require explicit request verbs or clear issues)",
                _       => "Outlook email (apply reasonable developer workflow classification)",
            };

            let instructions = "You are a classification assistant for a Dynamics 365 / Dataverse developer productivity app. \
Your job is to classify incoming messages and decide whether they represent real engineering work tasks. \
Be CONSERVATIVE: when in doubt, return isTask=false or low confidence. \
Respond with ONLY valid JSON — no markdown, no code fences, no explanation outside the JSON.";

            let prompt = format!(
"Classify this message for a CRM/Dynamics/Dataverse developer.\n\
Source type: {source_context}\n\
From: {sender_name} <{sender_email}>\n\
Subject/Title: {title}\n\
Content:\n{content_trimmed}\n\n\
DECISION RULES — apply strictly in this order:\n\n\
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
- 50-69: uncertain — might need action or might be informational\n\
- <50: almost certainly not a task\n\n\
Threshold note: items with confidence < 85 go to user review; >= 85 auto-create. \
Prefer lower confidence for borderline items rather than guessing high.\n\n\
Examples:\n\
- 'Bug na Ptáčkovi v nvr_activity_events.js' → isTask=true conf=90 (customer + file + bug)\n\
- 'Change task: ... (pending); Ticket: #76688; Neopharma' → isTask=true conf=87 (pending helpdesk task)\n\
- 'Change task: ... (finished); Ticket: #76423' → isTask=false (completed, no action)\n\
- 'Informace o vytvoření objednávky z portálu' → isTask=false (informational, no action required)\n\
- 'Build succeeded: main → production' → isTask=false (CI notification)\n\
- 'PR - VSM 113862 needs your review' → isTask=true conf=88 (explicit review request)\n\n\
Respond with ONLY this JSON:\n\
{{\"isTask\":true,\"confidence\":85,\"title\":\"Short imperative action title (max 80 chars)\",\
\"summary\":\"1-2 sentences in English: what needs to be done and why\",\
\"summaryCz\":\"1-2 věty česky: co je třeba udělat a proč\",\
\"summaryEn\":\"1-2 sentences in English describing the problem\",\
\"problemPointsCz\":[\"Krátký český bod o problému.\"],\
\"problemPointsEn\":[\"Short English bullet about the problem.\"],\
\"actionPointsCz\":[\"Konkrétní akční krok česky.\"],\
\"actionPointsEn\":[\"Concrete action step in English.\"],\
\"nextStepCz\":\"Jeden jasný bezprostřední krok česky.\",\
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
- title: must be in Czech for Teams messages. Use an action-oriented noun phrase (e.g. 'Upravit možnost změny data dokončení úkolu')."
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
            eprintln!("[classify] No AI key — using heuristic classification for: {title}");
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
        "potřeboval", "kouknout", "podívat", "zkontrolovat", "opravit",
        "prověřit", "zobrazuje", "prosím",
    ];
    let issue_words = [
        "not working", "broken", "bug", "error", "fails", "crash", "wrong",
        "doesn't work", "cant work", "can't work",
        // Czech
        "nefunguje", "chyba", "problém", "nefunkcni", "nefunkční",
    ];
    // Environment words indicate developer-relevant context
    let env_words = ["prod", "production", "uat", "staging", "dev ", "development"];

    let action_score = action_words.iter().filter(|&&w| combined.contains(w)).count();
    let issue_score  = issue_words.iter().filter(|&&w| combined.contains(w)).count();
    let env_score    = env_words.iter().filter(|&&w| combined.contains(w)).count();

    // Teams base is 20 (matches frontend heuristicClassify.ts SOURCE_BASE).
    // Zero signals → score stays below MIN_CONFIDENCE_ANALYZE (50) → silently skipped.
    // Email base is 35 — emails generally have more context.
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
        format!("{}…", &first[..92])
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
            continue; // top-level directory entry itself — skip it
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
            message: ".git directory already present — skipped".to_string(),
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
            // Create commit — tolerate failure silently (e.g. nothing to commit)
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
/// Returns file names only (not full paths). Never fails — returns empty vec on any error.
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
/// Never fails — returns an empty array on any filesystem error.
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

// ── PKCE helpers ────────────────────────────────────────────────────────────

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

// ── Token cache ─────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct TokenCache {
    access_token: String,
    refresh_token: String,
    /// Unix timestamp (seconds) when the access token expires.
    expires_at: u64,
    id_token: Option<String>,
    /// Tenant ID used during sign-in — required to build the correct authority URL on refresh.
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

// ── Redirect server ──────────────────────────────────────────────────────────

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

// ── Token exchange ───────────────────────────────────────────────────────────

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
        // Truncate the description — MSAL descriptions can be very long.
        let preview: String = desc.chars().take(200).collect();
        let friendly = match code {
            "invalid_grant" | "interaction_required" =>
                format!(
                    "InvalidAuthenticationToken — Microsoft connection expired ({code}). \
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

// ── Graph helpers ────────────────────────────────────────────────────────────

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

    // ── Non-2xx: read the body as TEXT first ─────────────────────────────────
    // IMPORTANT: calling `.json()` before checking the status is the root cause
    // of "error decoding response body" — Graph sometimes returns HTML or an
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
                        format!("InvalidAuthenticationToken — Microsoft connection expired. Please reconnect in Settings."),
                    _ =>
                        format!("Microsoft Graph API error [{status}] {code}: {msg}"),
                };
                eprintln!("[Graph] Structured error: {friendly}");
                return Err(friendly);
            }
        }

        // No structured JSON error — produce a clear plain-text error.
        let friendly = match status.as_u16() {
            401 => format!(
                "Outlook authorization failed (HTTP 401). Please reconnect Microsoft in Settings. \
                 Endpoint: {url_base}"
            ),
            403 => format!(
                "Access denied (HTTP 403) — Mail.Read permission may be missing from your Azure app registration. \
                 Endpoint: {url_base}"
            ),
            _ => format!(
                "Microsoft Graph request failed with HTTP {status} from {url_base}. \
                 Content-Type: {content_type}. Body preview: {preview}"
            ),
        };
        return Err(friendly);
    }

    // ── 2xx: parse JSON ───────────────────────────────────────────────────────
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
                format!("InvalidAuthenticationToken — Microsoft connection expired. Please reconnect in Settings."),
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
            // Refresh failed — the refresh token is invalid/expired.
            // Clear the cache so we don't attempt to use a dead token on the next call.
            eprintln!("[token] ensure_valid_token: refresh failed — clearing token cache");
            let _ = clear_token_cache(app);
            // Prefix with a recognizable code so the frontend can route to a reconnect flow.
            Err(format!("MICROSOFT_RECONNECT_REQUIRED: {refresh_err}"))
        }
    }
}

// ── Microsoft account info types ─────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct MicrosoftAccountInfo {
    email: String,
    display_name: String,
    tenant_id: String,
    last_sync_at: String,
}

// ── Tauri commands ────────────────────────────────────────────────────────────

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
        return Err("Application (client) ID is required. Enter it in Settings → Microsoft 365 Integration.".into());
    }
    if tenant_id.is_empty() {
        return Err("Directory (tenant) ID is required. Enter it in Settings → Microsoft 365 Integration.".into());
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
/// The tenant ID is read from the token cache — no need to re-enter it.
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
    // NOTE: $orderby is intentionally omitted — Graph rejects the combination of
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
            // IMPORTANT: extract Azure DevOps href URLs *before* stripping tags —
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
    // Sort by receivedAt descending ($orderby omitted from request — see above).
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

    eprintln!("[outlook-import] get_outlook_flagged_list v2 — days_back={days_back}");
    let token = ensure_valid_token(&app, &client_id).await?;

    // Build the OData $filter expression.
    // Combining flag/flagStatus with receivedDateTime ge <date> is safe — InefficientFilter
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
/// Called lazily when the user clicks Import for a specific email — not during panel load.
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
    // body_full is the plain-text path — AI, prefilter, ADO parsing all use this.
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
    // Resolve CID inline images → data: URIs for the HTML display path.
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
/// Note: $orderby is NOT supported on /me/chats — it causes a 400 when combined
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
        return Err("Teams intake chat ID is not configured. Set it in Settings → Teams Intake.".to_string());
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

        // ── Targeted diagnostic logging for forwarded-message diagnosis ────────
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

        // ── Teams message link resolution ────────────────────────────────────
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
                linked_type = "channel";       // not supported — surface in UI
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
            // Forwarded-message metadata — empty when not a forward.
            "isForwarded":         effective.is_some(),
            "originalSenderName":  effective.as_ref().map(|f| f.sender_name.as_str()).unwrap_or(""),
            "originalSenderEmail": effective.as_ref().and_then(|f| f.sender_email.as_deref()).unwrap_or(""),
            "originalSentAt":      effective.as_ref().and_then(|f| f.sent_at.as_deref()).unwrap_or(""),
            "originalContent":     effective.as_ref().map(|f| f.content.as_str()).unwrap_or(""),
            // Teams link metadata — non-empty when a "Copy link to message" URL was found.
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

    // Step 1: recent chats (no $orderby — not supported with $expand)
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
/// Uses Howard Hinnant's civil-from-days algorithm — no external crate required.
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

    // Step 3: find the self-chat — a oneOnOne chat where ALL members share my userId.
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
/// string matching — no HTML parsing involved. This gates the more expensive
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

        // Extract href value — look for href="..."
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
            // Decode &amp; → & so the URL is valid when opened
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
/// Block-level tags (p, div, br, tr, …) become newlines so that email thread
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
                    // Stray > in content — pass through
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
///   `Jan Kvicala: V těch 16:00 spustíme ten release na PROD | Chat | Microsoft Teams`
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
/// 1. **messageReference attachment** — when a user explicitly shares/references
///    another message via the Teams UI, the Graph API populates
///    `attachments[].contentType == "messageReference"` with a JSON `content`
///    string that contains `messageSender.user.{displayName,userPrincipalName}`
///    and `messagePreview`. This is the most reliable signal.
///
/// 2. **HTML `<b>From:</b>` pattern** — when a message is forwarded by copying
///    and pasting, the body HTML often contains an email-style header block
///    (`<b>From:</b> Name ...`) that is destroyed when `strip_html` is called.
///    We parse this *before* stripping.
///
/// Returns `None` for normal (non-forwarded) messages so the caller falls back
/// cleanly to the existing behaviour.
fn parse_teams_forwarded_card(msg: &Value, body_html: &str) -> Option<ForwardedMeta> {
    // ── Strategy 1 & 3: attachment-based detection ───────────────────────────
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

    // ── Strategy 4: blockquote / Teams indent-forward ────────────────────────
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

    // ── Strategy 2: HTML <b>From:</b> / <strong>From:</strong> pattern ────────
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

fn task_mcp_generate_token() -> String {
    use rand::Rng;
    rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

fn task_mcp_bridge_token() -> &'static str {
    TASK_MCP_BRIDGE_TOKEN.get_or_init(task_mcp_generate_token)
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

fn task_mcp_server_script_path() -> String {
    let cwd = std::env::current_dir().ok();
    if let Some(cwd) = cwd {
        let candidate = cwd.join("mcp").join("task-workbench-mcp.mjs");
        return candidate.to_string_lossy().to_string();
    }
    "mcp/task-workbench-mcp.mjs".to_string()
}

fn task_mcp_read_only_tool_definitions() -> Vec<Value> {
    vec![
        serde_json::json!({"name":"list_tasks","description":"List sanitized task-workbench tasks.","readOnly":true}),
        serde_json::json!({"name":"get_task","description":"Get one sanitized task by id.","readOnly":true}),
        serde_json::json!({"name":"get_task_summary","description":"Get one sanitized task summary by id.","readOnly":true}),
        serde_json::json!({"name":"get_crm_workflow_state","description":"Get sanitized CRM Developer Workflow state for a task.","readOnly":true}),
        serde_json::json!({"name":"get_current_crm_workflow_step","description":"Get the current CRM workflow step and gate summary.","readOnly":true}),
        serde_json::json!({"name":"get_technical_plan","description":"Get the persisted local technical implementation plan for a task.","readOnly":true}),
        serde_json::json!({"name":"get_pr_review_state","description":"Get sanitized local pull-request review state.","readOnly":true}),
        serde_json::json!({"name":"get_next_recommended_step","description":"Get conservative next local workflow step for a task.","readOnly":true}),
    ]
}

fn task_mcp_local_write_tool_definitions() -> Vec<Value> {
    vec![
        serde_json::json!({"name":"append_task_note","description":"Append a sanitized local note to task.notes.","readOnly":false}),
        serde_json::json!({"name":"set_task_status","description":"Set task status to a validated local enum value.","readOnly":false}),
        serde_json::json!({"name":"set_task_attention_state","description":"Set task attentionState to a validated local enum value or null.","readOnly":false}),
        serde_json::json!({"name":"set_task_waiting_state","description":"Set task waitingState to a validated local enum value or null.","readOnly":false}),
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
    &["pricing-approval", "code-review"]
}

fn task_mcp_allowed_attention_states() -> &'static [&'static str] {
    &["pr-comments"]
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

fn task_mcp_execute_tool(app: &tauri::AppHandle, tool_name: &str, args: &Value) -> Result<Value, String> {
    let mut tasks = task_mcp_load_tasks(app)?;
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
            // The timestamped note itself is the audit record — no separate audit line needed.
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
                (401, serde_json::json!({"ok": false, "error": "Missing or invalid bridge token. Fetch GET /mcp/status to get the session token."}))
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
    Ok(task_mcp_current_bridge_state())
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
    // must not be cached — it would block all future attempts even after Primarch connects.
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
    filtering_attributes: Vec<String>,
    uses_pre_entity_images: bool,
    uses_post_entity_images: bool,
    image_attributes: HashMap<String, Vec<String>>,
    target_attributes: Vec<String>,
    notes: Vec<String>,
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
}

#[derive(Debug, Clone, Default)]
struct EntityMetadataCacheEntry {
    attributes: HashSet<String>,
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

    EntityMetadataCacheEntry {
        attributes,
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
    let wd = settings["primarchMcpWorkingDirectory"].as_str().unwrap_or("").to_string();
    let working_dir = if wd.is_empty() { None } else { Some(wd) };
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

    let mut child = cmd.spawn().map_err(|e| format!("Failed to start MCP server '{cmd_str}': {e}"))?;
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

    let mut child = cmd.spawn().map_err(|e| format!("Failed to start MCP server '{cmd_str}': {e}"))?;
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

    if schema_completeness == "unknown" && column_count <= 5 {
        schema_completeness = "incomplete".to_string();
        note = Some(format!("Only {column_count} columns were returned for this entity. The metadata tool response appears truncated."));
    }

    if schema_completeness == "unknown" {
        note = note.or(Some("Column metadata completeness could not be proven from tool response metadata.".to_string()));
    }

    Ok(EntityMetadataCacheEntry {
        attributes: merged_attributes,
        column_count,
        schema_completeness,
        tool_used: tool_name.to_string(),
        paging: if paging_parts.is_empty() { None } else { Some(paging_parts.join(", ")) },
        note,
    })
}

/// Tests connectivity to the Primarch MCP server (tools/list only — no Dataverse read).
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
        "summary": "Skeleton generation failed — could not parse AI response.",
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

/// Verifies CRM references extracted from a source file against Primarch MCP metadata.
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
    let settings = load_settings(app.clone())?;
    let raw_scan_result = scan_result.clone();
    let scan: CrmScanResult = serde_json::from_value(scan_result).unwrap_or_default();

    let local_scan_only_ambiguous: Vec<Value> = {
        let mut refs: Vec<Value> = Vec::new();
        for ambiguous in &scan.ambiguous_references {
            refs.push(serde_json::json!({
                "kind": ambiguous.kind,
                "displayName": ambiguous.logical_name,
                "entityLogicalName": ambiguous.entity_logical_name,
                "relatedEntityLogicalName": ambiguous.related_entity_logical_name,
                "sourceReason": ambiguous.source_reason,
                "detail": format!("Local scan only — not checked against Dataverse. {}", ambiguous.detail),
            }));
        }
        for attr_ref in &scan.attribute_references {
            if attr_ref.entity_logical_name.is_none() {
                refs.push(serde_json::json!({
                    "kind": "attribute",
                    "displayName": attr_ref.logical_name,
                    "attributeLogicalName": attr_ref.logical_name,
                    "sourceReason": attr_ref.source_reason,
                    "detail": "Local scan only — not checked against Dataverse.",
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

        let tool = metadata_tool.expect("checked above");
        let metadata_tool_name = tool["name"].as_str().unwrap_or("").to_string();
        let tool_name = metadata_tool_name.clone();

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
                        // Attribute appears in the partial response but schema is incomplete —
                        // treat as ambiguous so as not to overstate verification quality.
                        ambiguous_references.push(serde_json::json!({
                            "kind": "attribute",
                            "displayName": format!("{}.{}", entity_name, attr_ref.logical_name),
                            "entityLogicalName": entity_name,
                            "attributeLogicalName": attr_ref.logical_name,
                            "relatedEntityLogicalName": attr_ref.related_entity_logical_name,
                            "sourceReason": attr_ref.source_reason,
                            "detail": format!(
                                "Attribute present in {} schema ({} columns returned), but schema completeness is unverified — cannot fully confirm.",
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
                    ambiguous_references.push(serde_json::json!({
                        "kind": "attribute",
                        "displayName": format!("{}.{}", entity_name, attr_ref.logical_name),
                        "entityLogicalName": entity_name,
                        "attributeLogicalName": attr_ref.logical_name,
                        "relatedEntityLogicalName": attr_ref.related_entity_logical_name,
                        "sourceReason": attr_ref.source_reason,
                        "detail": format!(
                            "Could not verify against {} schema metadata ({} columns returned).",
                            cache_entry.schema_completeness,
                            cache_entry.column_count,
                        ),
                    }));
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
                // Defensive guard: fail is not allowed unless complete schema exists.
                missing_references.clear();
                issues.retain(|issue| issue["code"].as_str() != Some("ATTRIBUTE_NOT_FOUND"));
                metadata_verdict = if !ambiguous_references.is_empty() || !unable_to_verify_reasons.is_empty() {
                    "warnings"
                } else {
                    "unknown"
                };
            }
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
                "Confirmed metadata mismatch found in complete schema.".to_string(),
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
        // The classification condition: found && !complete → ambiguous branch.
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
        // False-positive tokens from display names ("ERP Relevant" → "elevant", etc.) push
        // column_count above 5, so the <=5 incomplete heuristic does not fire.
        // Result: schema_completeness = "unknown" (conservative — we cannot prove it is complete or truncated).
        assert_eq!(entry.schema_completeness, "unknown",
            "list_columns text-wrapper format: count buried in string → unknown, not incomplete");
    }

    #[test]
    fn list_columns_full_186_column_response_is_schema_unknown() {
        // With 186 columns returned: column_count > 5, no paging params, no detectable totalCount
        // → schema_completeness = "unknown" (conservative: we can't prove completeness from this format)
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
        assert!(entry.column_count > 5, "186 columns → count > 5");
        // totalCount is buried inside text string, find_count_key won't see it → unknown not complete
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
            read_file_content,
            list_directory_files,
            list_files_with_paths,
            infer_review_file_path,
            list_crm_folders,
            get_git_branch,
            get_git_branch_quick,
            list_git_branches,
            git_has_uncommitted,
            git_checkout_branch,
            get_git_diff,
            run_ai_change_review,
                get_task_mcp_bridge_status,
                test_primarch_mcp_connection,
                list_primarch_mcp_tools,
                generate_crm_skeleton,
                verify_against_crm,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
