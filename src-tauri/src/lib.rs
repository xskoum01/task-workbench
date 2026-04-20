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

    let instructions = "Jsi asistent Dynamics 365 / Dataverse vyvojare. \
Analyzujes pracovni pozadavky a vracis strukturovany JSON v cestine. \
Odpovedej POUZE validnim JSON — zadny markdown, zadne code fences.";

    let prompt = format!(
        "Analyzuj tento pracovni pozadavek.\n\n\
Task:\n- Nazev: {title}\n- Typ: {task_type}\n- Zdroj: {source}\n- Zprava: {message}\n\n\
Zakaznik:\n- Nazev: {customer_name}\n- Namespace: {namespace}\n- Repozitar: {repo_name}\n\n\
Odpovedej POUZE timto JSON (bez markdownu, bez code fences):\n\
{{\"summary\":\"Kratke ceske shrnuteni (1-2 vety)\",\
\"problemPoints\":[\"Co je problem.\",\"Kde se to projevuje.\",\"Co je potreba udelat.\"],\
\"suggestedActions\":[{{\"id\":\"ai1\",\"label\":\"Konkretni krok cesky\"}}],\
\"confidence\":85,\
\"nextStep\":\"Nejdulezitejsi nasledujici krok cesky\"}}\n\n\
Pravidla:\n\
- Pis cesky, strucne a srozumitelne. summary: 1-2 vety.\n\
- problemPoints: 2-4 kratke body (co je problem, kde, co udelat).\n\
- suggestedActions: 3-5 kroku cesky. confidence: 0-100.\n\
- Technicke identifikatory (soubory, entity, fieldy) zachovej beze zmeny.\n\
- Zadny marketingovy ton, zadne dlouhe odstavce."
    );

    let text = call_openai(&api_key, &model, instructions, &prompt).await?;

    serde_json::from_str(strip_fences(&text)).map_err(|e| {
        let snippet = &text[..text.len().min(300)];
        format!("Failed to parse AI response: {e}. Response: {snippet}")
    })
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

    let prompt = format!(
        "Generate a C# plugin class skeleton.\n\n\
Task:\n- Title: {title}\n- Type: {task_type}\n- Message: {message}\n\n\
Customer namespace: {namespace}\n\n\
Respond with ONLY this JSON (no markdown, no fences):\n\
{{\"fileName\":\"PluginClassName.cs\",\"content\":\"// full C# file\",\"targetPath\":\"\"}}\n\n\
Rules:\n\
- fileName: PascalCase class name + .cs\n\
- content: complete C# file with using statements, namespace block, class implementing IPlugin, \
Execute method stub with TODO comments derived from the task\n\
- targetPath: relative subfolder within plugin folder (empty string for root)"
    );

    let text = call_openai(&api_key, &model, instructions, &prompt).await?;

    serde_json::from_str(strip_fences(&text)).map_err(|e| {
        let snippet = &text[..text.len().min(300)];
        format!("Failed to parse AI response: {e}. Response: {snippet}")
    })
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
\"summary\":\"1-2 sentences: what needs to be done and why\",\
\"customerName\":null,\"taskType\":\"other\",\"estimatedEffort\":null,\"dueAt\":null,\
\"suggestedReply\":null,\"skipReason\":null}}\n\n\
Field rules:\n\
- taskType: bug-fix | feature | review | question | deployment | other\n\
- confidence: integer 0-100\n\
- estimatedEffort: hours as number or null\n\
- dueAt: ISO 8601 date or null\n\
- skipReason: brief reason if isTask=false, else null\n\
- suggestedReply: 1-2 sentence acknowledgement if a reply is appropriate, else null"
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
    let resp = Client::new()
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
                format!("Missing Teams permissions ({code}): {msg}"),
            "InvalidAuthenticationToken" | "AuthenticationError" =>
                format!("Microsoft connection expired — please reconnect ({code})"),
            _ =>
                format!("Teams API error [{status}] {code}: {msg}"),
        };
        eprintln!("[Graph] Error response: {friendly}");
        return Err(friendly);
    }

    if !status.is_success() {
        let err = format!("Teams request failed with HTTP {status}");
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
    let url = format!(
        "{MS_GRAPH_BASE}/me/messages\
         ?$top=25\
         &$orderby=receivedDateTime%20desc\
         &$select=id,subject,from,receivedDateTime,bodyPreview,webLink,body"
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
            let mut body_full = strip_html(body_html);
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
            serde_json::json!({
                "id": m["id"],
                "subject": m["subject"].as_str().unwrap_or("(no subject)"),
                "fromName": m["from"]["emailAddress"]["name"].as_str().unwrap_or(""),
                "fromEmail": m["from"]["emailAddress"]["address"].as_str().unwrap_or(""),
                "receivedAt": m["receivedDateTime"],
                "bodyPreview": m["bodyPreview"],
                "bodyFull": body_full,
                "webLink": m["webLink"],
            })
        })
        .collect();
    Ok(serde_json::json!(messages))
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
            classify_inbox_item,
            reset_local_data,
            connect_microsoft_account,
            refresh_microsoft_connection,
            disconnect_microsoft_account,
            get_microsoft_connection_state,
            get_outlook_messages,
            get_teams_chats,
            get_teams_chat_messages,
            get_teams_recent_messages,
            read_file_content,
            list_directory_files,
            list_crm_folders,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
