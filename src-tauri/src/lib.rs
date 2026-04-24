use std::fs;
use std::io;
use std::io::BufRead;
use std::net::TcpListener;
use std::path::PathBuf;
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
#[tauri::command]
fn list_crm_folders(base_dir: String) -> Vec<String> {
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
}

// --- Settings --------------------------------------------------------------

fn default_settings() -> Value {
    serde_json::json!({
        "appName": "Task Workbench",
        "theme": "dark",
        "defaultTaskConfidence": 80,
        "aiModel": "",
        "aiApiKey": "",
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

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<Value, String> {
    let path = app_data_dir(&app)?.join("settings.json");
    let value = read_json(&path)?;
    if value.is_null() {
        let defaults = default_settings();
        write_json(&path, &defaults)?;
        Ok(defaults)
    } else {
        Ok(value)
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
        std::process::Command::new("cmd")
            .args(["/c", "code", &path])
            .spawn()
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

/// Open a file or folder using the OS default application (respects file
/// associations, so .sln opens Visual Studio, .pdf opens a viewer, etc.).
/// Uses `cmd /c start "" "path"` on Windows for correct association handling.
#[tauri::command]
fn open_with_shell(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &path])
            .spawn()
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

// --- Git helpers -----------------------------------------------------------

/// Helper: run a git command in repo_path; return trimmed stdout or an error string.
fn git_run(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let p = std::path::Path::new(repo_path);
    if !p.exists() {
        return Err(format!("Repository path not found: {repo_path}"));
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()
        .map_err(|e| {
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
#[tauri::command]
fn get_git_branch(repo_path: String) -> Result<String, String> {
    let branch = git_run(&repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if branch.is_empty() {
        Err("Could not determine current branch.".to_string())
    } else {
        Ok(branch)
    }
}

/// Returns a sorted list of local branch names (the `*` marker is stripped).
#[tauri::command]
fn list_git_branches(repo_path: String) -> Result<Vec<String>, String> {
    let raw = git_run(&repo_path, &["branch", "--list"])?;
    let mut branches: Vec<String> = raw
        .lines()
        .map(|l| l.trim_start_matches('*').trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    branches.sort();
    Ok(branches)
}

/// Returns true when the working tree has uncommitted changes.
/// Untracked files are included (same as `git status --short`).
#[tauri::command]
fn git_has_uncommitted(repo_path: String) -> Result<bool, String> {
    let out = git_run(&repo_path, &["status", "--short"])?;
    Ok(!out.is_empty())
}

/// Checks out the given branch in the repository.
/// Returns an error when the branch does not exist or there are conflicts.
#[tauri::command]
fn git_checkout_branch(repo_path: String, branch: String) -> Result<(), String> {
    git_run(&repo_path, &["checkout", &branch]).map(|_| ())
}

// --- AI helpers ------------------------------------------------------------

/// Reads aiApiKey and aiModel from settings.json.
/// Returns an error if the API key is empty.
fn get_ai_settings(app: &tauri::AppHandle) -> Result<(String, String), String> {
    let path = app_data_dir(app)?.join("settings.json");
    let settings = read_json(&path)?;

    let api_key = settings["aiApiKey"].as_str().unwrap_or("").to_string();
    if api_key.is_empty() {
        return Err(
            "AI API key not configured. Add your OpenAI API key in Settings.".to_string(),
        );
    }

    let model = {
        let m = settings["aiModel"].as_str().unwrap_or("");
        if m.is_empty() {
            "gpt-4.1-mini".to_string()
        } else {
            m.to_string()
        }
    };

    Ok((api_key, model))
}

/// Calls the OpenAI Responses API and returns the text of the first output message.
/// `prompt` is sent as the user input; `instructions` is the optional system prompt.
async fn call_openai(
    api_key: &str,
    model: &str,
    instructions: &str,
    prompt: &str,
) -> Result<String, String> {
    let client = Client::new();

    let mut body = serde_json::json!({
        "model": model,
        "input": prompt,
    });
    if !instructions.is_empty() {
        body["instructions"] = serde_json::Value::String(instructions.to_string());
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

/// Analyses a task using OpenAI and returns a TaskAnalysis JSON object.
#[tauri::command]
async fn analyze_task(app: tauri::AppHandle, task: Value, customer: Value) -> Result<Value, String> {
    let (api_key, model) = get_ai_settings(&app)?;

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

    let text = call_openai(&api_key, &model, instructions, &prompt).await?;

    let parsed: Value = serde_json::from_str(strip_fences(&text)).map_err(|e| {
        let snippet = &text[..text.len().min(300)];
        format!("Failed to parse AI response: {e}. Response: {snippet}")
    })?;

    Ok(normalize_task_analysis(parsed))
}

/// Generates a professional reply draft. Returns plain text.
#[tauri::command]
async fn generate_reply(app: tauri::AppHandle, task: Value, customer: Value) -> Result<String, String> {
    let (api_key, model) = get_ai_settings(&app)?;

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

    call_openai(&api_key, &model, instructions, &prompt).await
}

/// Generates a C# plugin skeleton and returns a SkeletonPreview JSON object.
#[tauri::command]
async fn generate_skeleton_preview(app: tauri::AppHandle, task: Value, customer: Value) -> Result<Value, String> {
    let (api_key, model) = get_ai_settings(&app)?;

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

    let text = call_openai(&api_key, &model, instructions, &prompt).await?;

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
    // Read API key and base model from settings
    let (api_key, base_model) = get_ai_settings(&app)?;
    let model = if model_override.trim().is_empty() { base_model } else { model_override.trim().to_string() };

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

    let client = reqwest::Client::new();
    let mut body = serde_json::json!({
        "model": model,
        "input": prompt,
        "instructions": full_instructions,
    });
    if temperature > 0.0 {
        body["temperature"] = serde_json::Value::from(temperature.clamp(0.0, 2.0));
    }

    let resp = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(&api_key)
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
    let text = json["output"][0]["content"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| {
            let snippet = json.to_string();
            format!("Unexpected OpenAI response: {}", &snippet[..snippet.len().min(300)])
        })?;

    // Strip optional markdown fences the model might still emit despite the instruction.
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

    // Optionally create an initial plugin class file
    if create_initial_class {
        let class_name = format!("{}Plugin", &project_name);
        let class_file = dest.join(format!("{class_name}.cs"));
        if !class_file.exists() {
            let content = format!(
                "using Microsoft.Xrm.Sdk;\n\
using System;\n\n\
namespace {namespace}\n{{{{\
\n    /// <summary>\n\
    /// Initial plugin class for {project_name}.\n\
    /// </summary>\n\
    public class {class_name} : IPlugin\n\
    {{{{\n\
        public void Execute(IServiceProvider serviceProvider)\n\
        {{{{\n\
            // TODO: implement plugin logic\n\
        }}}}\n\
    }}}}\n\
}}}}"
            );
            fs::write(&class_file, content).map_err(|e| format!("Failed to write initial class: {e}"))?;
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

    // Try OpenAI. If not configured or call fails, use heuristic fallback.
    let ai_result = get_ai_settings(&app);
    match ai_result {
        Ok((api_key, model)) => {
            // --- OpenAI path ---
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
- *Cz fields: natural Czech. *En fields: natural English."
            );

            let text_result = call_openai(&api_key, &model, instructions, &prompt).await;
            match text_result {
                Ok(text) => {
                    match serde_json::from_str::<Value>(strip_fences(&text)) {
                        Ok(v) => {
                            eprintln!("[classify] OpenAI result for \"{title}\": isTask={} conf={}",
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
    let init_out = std::process::Command::new("git")
        .args(["init", "-b", &branch, &path])
        .output();

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
        let add_ok = std::process::Command::new("git")
            .args(["-C", &path, "add", "."])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if add_ok {
            // Create commit — tolerate failure silently (e.g. nothing to commit)
            let commit_ok = std::process::Command::new("git")
                .args(["-C", &path, "commit", "-m", "Initial commit"])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
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
    let resp: TokenResponse = client
        .post(format!("{authority}/oauth2/v2.0/token"))
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

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
    let resp: TokenResponse = client
        .post(format!("{authority}/oauth2/v2.0/token"))
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

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
    eprintln!("[Graph] GET {url}");
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
    let body: Value = resp.json().await.map_err(|e| format!("Failed to parse Graph response: {e}"))?;

    // Graph API returns structured errors as JSON even on non-200 status codes.
    // Surfacing them here prevents silent empty results from masking real failures.
    if let Some(err_obj) = body.get("error") {
        let code = err_obj["code"].as_str().unwrap_or("unknown");
        let msg  = err_obj["message"].as_str().unwrap_or("no detail");
        let friendly = match code {
            "Authorization_RequestDenied" | "Unauthorized" | "AccessDenied" =>
                format!("Missing Microsoft permissions ({code}): {msg}"),
            "InvalidAuthenticationToken" | "AuthenticationError" =>
                format!("Microsoft connection expired — please reconnect ({code})"),
            _ =>
                format!("Microsoft Graph API error [{status}] {code}: {msg}"),
        };
        eprintln!("[Graph] Error response: {friendly}");
        return Err(friendly);
    }

    if !status.is_success() {
        let err = format!("Microsoft Graph request failed with HTTP {status}");
        eprintln!("[Graph] {err}");
        return Err(err);
    }

    Ok(body)
}

/// Resolve a potentially-expired token cache: refresh if needed, return access token.
async fn ensure_valid_token(app: &tauri::AppHandle, client_id: &str) -> Result<String, String> {
    let cache = load_token_cache(app).ok_or("Not authenticated. Please sign in first.")?;
    if now_unix() < cache.expires_at {
        return Ok(cache.access_token);
    }
    let client = Client::new();
    let new_cache = refresh_access_token(&client, client_id, &cache.tenant_id, &cache.refresh_token).await?;
    save_token_cache(app, &new_cache)?;
    Ok(new_cache.access_token)
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

/// Returns an ISO 8601 UTC timestamp for "now" without pulling in chrono.
fn chrono_now_iso() -> String {
    let secs = now_unix();
    // Format as a rough ISO 8601 string (accuracy sufficient for sync timestamps)
    let days_since_epoch = secs / 86400;
    let time_of_day = secs % 86400;
    let h = time_of_day / 3600;
    let m = (time_of_day % 3600) / 60;
    let s = time_of_day % 60;
    // Very simple date arithmetic (no leap-year handling needed for sync timestamps)
    let year = 1970 + days_since_epoch / 365;
    format!("{year:04}-01-01T{h:02}:{m:02}:{s:02}Z")
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

// --- Entry point -----------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_tasks,
            save_tasks,
            load_customers,
            save_customers,
            load_settings,
            save_settings,
            open_path,
            open_in_vscode,
            open_with_shell,
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
            list_git_branches,
            git_has_uncommitted,
            git_checkout_branch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
