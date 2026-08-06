//! OS credential store for anything that must never sit in plaintext JSON on
//! disk: the OpenAI/Anthropic API keys and the Microsoft OAuth token cache.
//! Backed by the platform credential manager (Windows Credential Manager /
//! macOS Keychain / Linux Secret Service) via the `keyring` crate.

const SERVICE: &str = "com.vskoumal.task-workbench";

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|error| error.to_string())
}

/// Stores `value` under `account`. An empty value clears the entry instead —
/// callers never need a separate empty-string case in the credential store.
pub fn store(account: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return clear(account);
    }
    entry(account)?
        .set_password(value)
        .map_err(|error| error.to_string())
}

/// Returns the stored value, or `None` if nothing is stored (never an error
/// for the common "not configured yet" case).
pub fn load(account: &str) -> Option<String> {
    entry(account).ok()?.get_password().ok()
}

/// Deletes the entry. Missing entries are not an error — the end state
/// ("nothing stored under this account") is what the caller wants either way.
pub fn clear(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // These exercise the real OS credential store (no mock backend), so they
    // use account names namespaced to this test run to avoid colliding with
    // real app data if the tests happen to run on a machine that also runs
    // the app. They are skipped gracefully (not failed) when no credential
    // backend is available, e.g. a headless Linux CI runner with no
    // Secret Service daemon — that environment gap is not a regression in
    // this module's logic.
    fn test_account(name: &str) -> String {
        format!("test-{name}-{}", std::process::id())
    }

    #[test]
    fn store_then_load_round_trips() {
        let account = test_account("round-trip");
        if store(&account, "sk-example-123").is_err() {
            return; // no credential backend available in this environment
        }
        assert_eq!(load(&account), Some("sk-example-123".to_string()));
        let _ = clear(&account);
    }

    #[test]
    fn storing_an_empty_value_clears_instead() {
        let account = test_account("empty-clears");
        if store(&account, "sk-example-456").is_err() {
            return;
        }
        assert!(load(&account).is_some());
        store(&account, "").unwrap();
        assert_eq!(load(&account), None);
    }

    #[test]
    fn clearing_a_missing_entry_is_not_an_error() {
        let account = test_account("missing-clear");
        assert!(clear(&account).is_ok());
    }

    #[test]
    fn loading_a_missing_entry_returns_none_not_an_error() {
        let account = test_account("missing-load");
        assert_eq!(load(&account), None);
    }
}
