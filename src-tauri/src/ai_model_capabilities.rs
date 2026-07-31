/// AI model capability profiles.
///
/// Different providers and models support different request parameters.
/// This module is the single source of truth for what to include in each
/// API request body. Call sites should not hard-code model names.
///
/// Design:
/// - OpenAI: temperature is omitted for reasoning models (o-series) and the
///   gpt-5 family, which reject it with HTTP 400.
/// - Anthropic: all current Claude models support temperature in [0.0, 1.0].
/// - Unknown models use a conservative profile (omit optional params) to
///   avoid 400 errors on unrecognized model names.

#[derive(Debug, Clone, PartialEq)]
pub struct ModelCapabilities {
    /// Whether the model accepts a `temperature` parameter.
    pub supports_temperature: bool,
    /// Valid clamp range for temperature when supported.
    pub temperature_clamp: (f64, f64),
}

impl Default for ModelCapabilities {
    /// Conservative default: omit optional sampling params.
    /// Applied for unknown OpenAI model names.
    fn default() -> Self {
        Self {
            supports_temperature: false,
            temperature_clamp: (0.0, 1.0),
        }
    }
}

/// Returns the capability profile for an OpenAI model.
///
/// Families that do NOT support temperature:
/// - Reasoning models: o1, o2, o3, o4 (and mini/preview variants)
/// - gpt-5 family (including gpt-5.5)
///
/// Families that DO support temperature:
/// - gpt-4 (including gpt-4o, gpt-4.1, gpt-4-turbo, etc.)
/// - gpt-3.5
///
/// Unknown models use a conservative profile (no temperature) to avoid 400 errors.
pub fn openai_capabilities(model: &str) -> ModelCapabilities {
    let m = model.to_lowercase();

    // Reasoning / o-series models do not support temperature.
    if m.starts_with("o1") || m.starts_with("o2") || m.starts_with("o3") || m.starts_with("o4") {
        return ModelCapabilities {
            supports_temperature: false,
            temperature_clamp: (0.0, 2.0),
        };
    }

    // gpt-5 family (gpt-5, gpt-5.5, gpt-5-turbo, …) does not support temperature.
    // Note: "gpt-5" prefix will NOT match "gpt-4" or "gpt-4.5" which start with "gpt-4".
    if m.starts_with("gpt-5") {
        return ModelCapabilities {
            supports_temperature: false,
            temperature_clamp: (0.0, 2.0),
        };
    }

    // gpt-4 and gpt-3.5 families support temperature in [0.0, 2.0].
    if m.starts_with("gpt-4") || m.starts_with("gpt-3") {
        return ModelCapabilities {
            supports_temperature: true,
            temperature_clamp: (0.0, 2.0),
        };
    }

    // Unknown model — conservative profile: omit temperature to avoid 400 errors.
    ModelCapabilities::default()
}

/// Returns the capability profile for an Anthropic model.
/// All current Claude models support temperature in [0.0, 1.0].
pub fn anthropic_capabilities(_model: &str) -> ModelCapabilities {
    ModelCapabilities {
        supports_temperature: true,
        temperature_clamp: (0.0, 1.0),
    }
}

/// Returns the capability profile for the given provider and model.
pub fn model_capabilities(provider: &str, model: &str) -> ModelCapabilities {
    match provider {
        "anthropic" => anthropic_capabilities(model),
        _ => openai_capabilities(model),
    }
}

/// Convenience: returns whether the provider/model combination supports temperature.
#[allow(dead_code)]
pub fn supports_temperature(provider: &str, model: &str) -> bool {
    model_capabilities(provider, model).supports_temperature
}

/// Clamps a temperature value to the valid range for the given provider/model.
/// Returns None when the model does not support temperature at all.
pub fn clamp_temperature(provider: &str, model: &str, temperature: f64) -> Option<f64> {
    let caps = model_capabilities(provider, model);
    if !caps.supports_temperature {
        return None;
    }
    let (lo, hi) = caps.temperature_clamp;
    Some(temperature.clamp(lo, hi))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- OpenAI: models that do NOT support temperature ---

    #[test]
    fn gpt_5_5_does_not_support_temperature() {
        assert!(!supports_temperature("openai", "gpt-5.5"));
    }

    #[test]
    fn gpt_5_does_not_support_temperature() {
        assert!(!supports_temperature("openai", "gpt-5"));
    }

    #[test]
    fn gpt_5_turbo_does_not_support_temperature() {
        assert!(!supports_temperature("openai", "gpt-5-turbo"));
    }

    #[test]
    fn o1_does_not_support_temperature() {
        assert!(!supports_temperature("openai", "o1"));
        assert!(!supports_temperature("openai", "o1-mini"));
        assert!(!supports_temperature("openai", "o1-preview"));
    }

    #[test]
    fn o3_does_not_support_temperature() {
        assert!(!supports_temperature("openai", "o3"));
        assert!(!supports_temperature("openai", "o3-mini"));
    }

    #[test]
    fn o4_does_not_support_temperature() {
        assert!(!supports_temperature("openai", "o4"));
        assert!(!supports_temperature("openai", "o4-mini"));
    }

    #[test]
    fn unknown_openai_model_uses_conservative_profile() {
        // Unknown models must NOT silently send temperature to avoid 400 errors.
        assert!(!supports_temperature("openai", "some-future-model-xyz"));
        assert!(!supports_temperature("openai", ""));
    }

    // --- OpenAI: models that DO support temperature ---

    #[test]
    fn gpt_4_supports_temperature() {
        assert!(supports_temperature("openai", "gpt-4"));
        assert!(supports_temperature("openai", "gpt-4-turbo"));
    }

    #[test]
    fn gpt_4_1_supports_temperature() {
        assert!(supports_temperature("openai", "gpt-4.1"));
        assert!(supports_temperature("openai", "gpt-4.1-mini"));
        assert!(supports_temperature("openai", "gpt-4.1-nano"));
    }

    #[test]
    fn gpt_4o_supports_temperature() {
        assert!(supports_temperature("openai", "gpt-4o"));
        assert!(supports_temperature("openai", "gpt-4o-mini"));
    }

    #[test]
    fn gpt_3_5_supports_temperature() {
        assert!(supports_temperature("openai", "gpt-3.5-turbo"));
    }

    #[test]
    fn gpt_4_5_supports_temperature() {
        // gpt-4.5 starts with "gpt-4" — treated as supported.
        assert!(supports_temperature("openai", "gpt-4.5"));
    }

    // --- Anthropic ---

    #[test]
    fn anthropic_claude_supports_temperature() {
        assert!(supports_temperature("anthropic", "claude-sonnet-4-6"));
        assert!(supports_temperature("anthropic", "claude-opus-4-8"));
        assert!(supports_temperature("anthropic", "claude-haiku-4-5"));
        assert!(supports_temperature("anthropic", "claude-3-opus-20240229"));
    }

    #[test]
    fn anthropic_temperature_clamped_to_1() {
        let caps = anthropic_capabilities("claude-sonnet-4-6");
        assert_eq!(caps.temperature_clamp, (0.0, 1.0));
    }

    // --- clamp_temperature ---

    #[test]
    fn clamp_temperature_returns_none_for_gpt_5_5() {
        assert_eq!(clamp_temperature("openai", "gpt-5.5", 0.2), None);
    }

    #[test]
    fn clamp_temperature_returns_clamped_value_for_gpt_4() {
        let result = clamp_temperature("openai", "gpt-4", 0.2);
        assert_eq!(result, Some(0.2));
    }

    #[test]
    fn clamp_temperature_clamps_out_of_range_for_anthropic() {
        let result = clamp_temperature("anthropic", "claude-sonnet-4-6", 1.5);
        assert_eq!(result, Some(1.0)); // clamped to max 1.0
    }

    // --- unsupported params are None, not null/zero ---

    #[test]
    fn unsupported_params_omitted_not_null() {
        // Verify that when temperature is not supported, we get None (not Some(0.0)).
        // The request body must not include the field at all — not even as null.
        let result = clamp_temperature("openai", "gpt-5.5", 0.2);
        assert!(
            result.is_none(),
            "unsupported temperature must be None, not Some(...)"
        );
    }

    // --- Provider routing ---

    #[test]
    fn unknown_provider_falls_back_to_openai_conservative() {
        // Unrecognized provider treated as OpenAI — conservative for unknown model.
        assert!(!supports_temperature("some-provider", "unknown-model"));
    }
}
