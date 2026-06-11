//! OpenAI response text extractor — centralised parser for all OpenAI API formats.
//!
//! Supported response shapes (tried in order):
//!   A) Responses API top-level `output_text` (convenience field)
//!   B) Responses API `output[].content[].text`
//!      — types "output_text", "text", or missing type with a "text" key
//!      — multiple text blocks joined with "\n"
//!   C) Chat Completions `choices[0].message.content`
//!   D) Older Completions `choices[0].text`
//!
//! Error messages produced here are sanitized — they never contain API keys,
//! prompts, instructions, or customer data.

use serde_json::Value;

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/// Attempts to extract generated text from an OpenAI API response.
///
/// Returns `Ok(text)` on success.
/// Returns `Err(internal_reason)` when no text can be extracted — the caller
/// should use `sanitize_openai_response_error` to produce the UI-facing message.
pub fn extract_openai_response_text(value: &Value) -> Result<String, String> {
    // A) Responses API top-level convenience field
    if let Some(text) = value["output_text"].as_str() {
        let trimmed = text.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }

    // B) Responses API output array
    if let Some(output) = value["output"].as_array() {
        let mut parts: Vec<String> = Vec::new();

        for item in output {
            if let Some(content_arr) = item["content"].as_array() {
                for block in content_arr {
                    let block_type = block["type"].as_str();
                    // Accept: "output_text", "text", or missing type when a "text" key is present
                    let is_text = match block_type {
                        Some("output_text") | Some("text") => true,
                        None => block["text"].as_str().is_some(),
                        _ => false, // "function_call_output", "refusal", etc. — skip
                    };
                    if is_text {
                        if let Some(t) = block["text"].as_str() {
                            let trimmed = t.trim().to_string();
                            if !trimmed.is_empty() {
                                parts.push(trimmed);
                            }
                        }
                    }
                }
            }
        }

        if !parts.is_empty() {
            return Ok(parts.join("\n"));
        }

        // output array was present but contained no extractable text
        return Err("output array present but contains no extractable text".to_string());
    }

    // C) Chat Completions: choices[0].message.content
    if let Some(text) = value["choices"][0]["message"]["content"].as_str() {
        let trimmed = text.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }

    // D) Older Completions: choices[0].text
    if let Some(text) = value["choices"][0]["text"].as_str() {
        let trimmed = text.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }

    Err("no recognizable text output in response".to_string())
}

// ---------------------------------------------------------------------------
// Sanitized error formatting
// ---------------------------------------------------------------------------

/// Produces a safe, user-facing error message for an OpenAI response that
/// yielded no extractable text.
///
/// Deliberately excludes: API keys, Authorization headers, prompts, instructions,
/// customer/task data, and the full raw JSON.  Only diagnostic metadata is shown.
pub fn sanitize_openai_response_error(value: &Value, model: &str) -> String {
    let mut lines: Vec<String> = vec![
        "OpenAI returned a response, but Task Workbench could not extract text output.".to_string(),
        format!("Provider: OpenAI | Model: {model}"),
    ];

    // Response ID (safe — just an opaque identifier)
    if let Some(id) = value["id"].as_str() {
        lines.push(format!("Response ID: {id}"));
    }

    // Top-level field names only (not values, which may contain prompts/data)
    if let Some(obj) = value.as_object() {
        let fields: Vec<&str> = obj.keys().map(String::as_str).collect();
        lines.push(format!("Top-level fields: {}", fields.join(", ")));
    }

    // Output item types (safe — these are schema types, not user content)
    if let Some(output) = value["output"].as_array() {
        let item_types: Vec<String> = output
            .iter()
            .map(|item| item["type"].as_str().unwrap_or("(no type)").to_string())
            .collect();
        if !item_types.is_empty() {
            lines.push(format!("Output item types: {}", item_types.join(", ")));
        }

        let content_types: Vec<String> = output
            .iter()
            .filter_map(|item| item["content"].as_array())
            .flatten()
            .map(|b| b["type"].as_str().unwrap_or("(no type)").to_string())
            .collect();
        if !content_types.is_empty() {
            lines.push(format!("Content block types: {}", content_types.join(", ")));
        }
    }

    // API-level error message (from the response's "error" object, not from customer data)
    if let Some(obj) = value.as_object() {
        if let Some(err) = obj.get("error") {
            if !err.is_null() {
                let summary = err["message"]
                    .as_str()
                    .unwrap_or("(error object present)");
                // Cap at 200 chars — error messages are usually short but guard anyway
                let safe = &summary[..summary.len().min(200)];
                lines.push(format!("Response error: {safe}"));
            }
        }
    }

    // incomplete_details — may contain a reason code, cap it
    if let Some(obj) = value.as_object() {
        if let Some(details) = obj.get("incomplete_details") {
            if !details.is_null() {
                let raw = details.to_string();
                let safe = &raw[..raw.len().min(200)];
                lines.push(format!("Incomplete details: {safe}"));
            }
        }
    }

    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── Responses API: extraction ─────────────────────────────────────────────

    #[test]
    fn extracts_top_level_output_text() {
        let v = json!({ "output_text": "Hello from gpt-5.5" });
        assert_eq!(
            extract_openai_response_text(&v),
            Ok("Hello from gpt-5.5".to_string())
        );
    }

    #[test]
    fn extracts_output_content_text_type_output_text() {
        let v = json!({
            "output": [{
                "type": "message",
                "content": [{ "type": "output_text", "text": "Generated content" }]
            }]
        });
        assert_eq!(
            extract_openai_response_text(&v),
            Ok("Generated content".to_string())
        );
    }

    #[test]
    fn extracts_output_content_text_type_text() {
        let v = json!({
            "output": [{
                "content": [{ "type": "text", "text": "Text block content" }]
            }]
        });
        assert_eq!(
            extract_openai_response_text(&v),
            Ok("Text block content".to_string())
        );
    }

    #[test]
    fn extracts_text_when_content_type_missing() {
        let v = json!({
            "output": [{
                "content": [{ "text": "No type key but text present" }]
            }]
        });
        assert_eq!(
            extract_openai_response_text(&v),
            Ok("No type key but text present".to_string())
        );
    }

    #[test]
    fn extracts_and_joins_multiple_text_blocks() {
        let v = json!({
            "output": [{
                "content": [
                    { "type": "output_text", "text": "Part one" },
                    { "type": "output_text", "text": "Part two" }
                ]
            }]
        });
        assert_eq!(
            extract_openai_response_text(&v),
            Ok("Part one\nPart two".to_string())
        );
    }

    #[test]
    fn ignores_non_text_content_blocks() {
        let v = json!({
            "output": [{
                "content": [
                    { "type": "function_call_output", "output": "some data" },
                    { "type": "refusal", "refusal": "I cannot do that" },
                    { "type": "output_text", "text": "Actual text block" }
                ]
            }]
        });
        assert_eq!(
            extract_openai_response_text(&v),
            Ok("Actual text block".to_string())
        );
    }

    #[test]
    fn returns_error_when_output_exists_but_contains_no_text() {
        let v = json!({
            "output": [{ "type": "function_call", "content": [] }]
        });
        let result = extract_openai_response_text(&v);
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("output array"), "expected 'output array' in: {msg}");
    }

    #[test]
    fn returns_error_for_response_with_error_field_and_empty_output() {
        let v = json!({
            "output": [],
            "error": { "message": "model capacity exceeded", "code": "server_error" }
        });
        assert!(extract_openai_response_text(&v).is_err());
    }

    // ── Chat Completions compatibility ────────────────────────────────────────

    #[test]
    fn extracts_choices_message_content() {
        let v = json!({
            "choices": [{ "message": { "content": "Chat completion text" } }]
        });
        assert_eq!(
            extract_openai_response_text(&v),
            Ok("Chat completion text".to_string())
        );
    }

    #[test]
    fn extracts_choices_text() {
        let v = json!({
            "choices": [{ "text": "Old completions format text" }]
        });
        assert_eq!(
            extract_openai_response_text(&v),
            Ok("Old completions format text".to_string())
        );
    }

    // ── Sanitized error safety ────────────────────────────────────────────────

    #[test]
    fn sanitized_error_does_not_include_instructions_field_value() {
        let v = json!({
            "id": "resp_abc123",
            "instructions": "You are an expert Navertica CRM developer implementing a task for VSK-Test customer",
            "output": []
        });
        let msg = sanitize_openai_response_error(&v, "gpt-5.5");
        assert!(
            !msg.contains("You are an expert Navertica CRM developer"),
            "sanitized error must not leak instructions content"
        );
        assert!(
            !msg.to_lowercase().contains("navertica"),
            "sanitized error must not contain customer name from instructions"
        );
    }

    #[test]
    fn sanitized_error_does_not_include_prompt_fragments() {
        let v = json!({
            "id": "resp_abc456",
            "input": "Implement nvr_account_events.js for VSK-Test"
        });
        let msg = sanitize_openai_response_error(&v, "gpt-5.5");
        // Should list field name "input" but NOT its value
        assert!(
            !msg.contains("nvr_account_events.js"),
            "sanitized error must not include prompt content"
        );
    }

    #[test]
    fn sanitized_error_does_not_include_api_key_or_auth_header() {
        let v = json!({ "id": "resp_safe" });
        let msg = sanitize_openai_response_error(&v, "gpt-5.5");
        assert!(!msg.contains("sk-"), "must not contain API key pattern");
        assert!(!msg.contains("Authorization"), "must not mention auth header");
    }

    #[test]
    fn sanitized_error_includes_response_id_and_model() {
        let v = json!({ "id": "resp_xyz789", "output": [] });
        let msg = sanitize_openai_response_error(&v, "gpt-5.5");
        assert!(msg.contains("resp_xyz789"), "must include response ID");
        assert!(msg.contains("gpt-5.5"), "must include model name");
    }

    #[test]
    fn sanitized_error_lists_top_level_field_names_not_values() {
        let v = json!({
            "id": "resp_1",
            "output": [],
            "error": null,
            "model": "gpt-5.5",
            "instructions": "secret system prompt"
        });
        let msg = sanitize_openai_response_error(&v, "gpt-5.5");
        // Field names should appear in the "Top-level fields" line
        assert!(msg.contains("Top-level fields"), "must list field names");
        assert!(msg.contains("instructions"), "field name 'instructions' should appear");
        // But the value "secret system prompt" must NOT appear
        assert!(
            !msg.contains("secret system prompt"),
            "field value must not be included"
        );
    }

    #[test]
    fn sanitized_error_includes_output_item_types() {
        let v = json!({
            "id": "resp_2",
            "output": [
                { "type": "message", "content": [] },
                { "type": "file_search_call" }
            ]
        });
        let msg = sanitize_openai_response_error(&v, "gpt-5.5");
        assert!(msg.contains("message"), "output item types should be listed");
    }

    #[test]
    fn sanitized_error_includes_response_error_message() {
        let v = json!({
            "id": "resp_err",
            "error": { "message": "content_filter triggered", "code": "content_filter" }
        });
        let msg = sanitize_openai_response_error(&v, "gpt-5.5");
        assert!(
            msg.contains("content_filter triggered"),
            "response error message should be included"
        );
    }

    // ── Integration: gpt-5.5 style response roundtrip ─────────────────────────

    #[test]
    fn gpt55_style_response_with_output_text_field_succeeds() {
        // Simulate what a real gpt-5.5 Responses API response looks like
        let v = json!({
            "id": "resp_gpt55_001",
            "object": "response",
            "created_at": 1749600000,
            "model": "gpt-5.5",
            "output_text": "{\"proposedContent\":\"function accountOnLoad(executionContext) {}\",\"summary\":\"Added handler\",\"risks\":[],\"testScenarios\":[]}",
            "output": [{
                "type": "message",
                "id": "msg_001",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "{\"proposedContent\":\"function accountOnLoad(executionContext) {}\",\"summary\":\"Added handler\",\"risks\":[],\"testScenarios\":[]}"
                }]
            }],
            "error": null
        });

        let result = extract_openai_response_text(&v).expect("should extract text");
        // output_text takes priority (checked first)
        assert!(result.contains("proposedContent"));
        assert!(result.contains("accountOnLoad"));
    }

    #[test]
    fn extracted_text_can_be_parsed_as_ai_kit_json() {
        let ai_kit_json = r#"{"proposedContent":"var x = 1;","summary":"Test","changedSections":["section1"],"risks":["none"],"testScenarios":["open form"],"clarificationNeeded":null}"#;
        let v = json!({
            "output_text": ai_kit_json
        });
        let text = extract_openai_response_text(&v).expect("should extract");
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("should parse as JSON");
        assert!(parsed["proposedContent"].is_string());
        assert!(parsed["summary"].is_string());
        assert!(parsed["risks"].is_array());
    }

    #[test]
    fn invalid_no_text_response_returns_sanitized_error() {
        let v = json!({
            "id": "resp_bad",
            "output": [{ "type": "function_call" }],
            "error": null
        });
        let extract_result = extract_openai_response_text(&v);
        assert!(extract_result.is_err());
        let err_msg = sanitize_openai_response_error(&v, "gpt-5.5");
        assert!(err_msg.contains("could not extract text output"));
        assert!(err_msg.contains("gpt-5.5"));
        assert!(!err_msg.contains("sk-"));
    }

    #[test]
    fn old_chat_completions_response_still_works() {
        let v = json!({
            "id": "chatcmpl-abc",
            "object": "chat.completion",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "{\"summary\":\"Legacy format still works\",\"proposedContent\":\"var y = 2;\"}"
                },
                "finish_reason": "stop"
            }]
        });
        let text = extract_openai_response_text(&v).expect("should extract from chat completions");
        assert!(text.contains("Legacy format still works"));
    }
}
