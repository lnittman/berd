use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

const ELICITATION_PERSISTENCE_FILENAME: &str = "elicitation-persistence.json";
const ELICITATION_PERSISTENCE_VERSION: u64 = 4;
const MAX_ELICITATION_PERSISTENCE_BYTES: usize = 256 * 1024;
static ELICITATION_PERSISTENCE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn elicitation_persistence_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(ELICITATION_PERSISTENCE_FILENAME))
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))
}

#[tauri::command]
pub async fn load_elicitation_persistence(app: AppHandle) -> Result<Option<String>, String> {
    let path = elicitation_persistence_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(serialized) if serialized.len() <= MAX_ELICITATION_PERSISTENCE_BYTES => {
            Ok(Some(serialized))
        }
        Ok(_) => Err("Persisted elicitation data exceeds the supported size".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read persisted elicitations: {error}")),
    }
}

#[tauri::command]
pub async fn persist_elicitation_updates(
    app: AppHandle,
    serialized_updates: String,
) -> Result<(), String> {
    persist_elicitation_updates_at_path(&elicitation_persistence_path(&app)?, &serialized_updates)
}

#[tauri::command]
pub async fn clear_elicitation_persistence(app: AppHandle) -> Result<(), String> {
    let _guard = ELICITATION_PERSISTENCE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Elicitation persistence lock was poisoned".to_string())?;
    remove_elicitation_persistence_at_path(&elicitation_persistence_path(&app)?)
}

fn read_records(path: &Path) -> Result<Map<String, Value>, String> {
    let serialized = match fs::read_to_string(path) {
        Ok(serialized) => serialized,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(format!("Failed to read persisted elicitations: {error}")),
    };
    if serialized.len() > MAX_ELICITATION_PERSISTENCE_BYTES {
        return Err("Persisted elicitation data exceeds the supported size".to_string());
    }
    let envelope: Value = serde_json::from_str(&serialized)
        .map_err(|error| format!("Failed to parse persisted elicitations: {error}"))?;
    if envelope.get("version").and_then(Value::as_u64) != Some(ELICITATION_PERSISTENCE_VERSION) {
        return Ok(Map::new());
    }
    envelope
        .get("records")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| "Persisted elicitation envelope has invalid records".to_string())
}

fn persist_elicitation_updates_at_path(
    path: &Path,
    serialized_updates: &str,
) -> Result<(), String> {
    let _guard = ELICITATION_PERSISTENCE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Elicitation persistence lock was poisoned".to_string())?;
    let updates: Map<String, Value> = serde_json::from_str(serialized_updates)
        .map_err(|error| format!("Failed to parse elicitation updates: {error}"))?;
    let mut records = read_records(path)?;
    for (record_key, record) in updates {
        if record.is_null() {
            records.remove(&record_key);
        } else {
            records.insert(record_key, record);
        }
    }
    if records.is_empty() {
        return remove_elicitation_persistence_at_path(path);
    }
    let serialized = serde_json::to_string(&json!({
        "version": ELICITATION_PERSISTENCE_VERSION,
        "records": records,
    }))
    .map_err(|error| format!("Failed to serialize persisted elicitations: {error}"))?;
    if serialized.len() > MAX_ELICITATION_PERSISTENCE_BYTES {
        return Err("Persisted elicitation data exceeds the supported size".to_string());
    }
    write_elicitation_persistence(path, &serialized)
}

fn write_elicitation_persistence(path: &Path, serialized: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Elicitation persistence path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create elicitation persistence directory: {error}"))?;
    let pending_path = path.with_extension("json.pending");
    fs::write(&pending_path, serialized)
        .map_err(|error| format!("Failed to write persisted elicitations: {error}"))?;
    fs::rename(&pending_path, path)
        .map_err(|error| format!("Failed to commit persisted elicitations: {error}"))
}

fn remove_elicitation_persistence_at_path(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove persisted elicitations: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_independent_renderer_records_transactionally() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(ELICITATION_PERSISTENCE_FILENAME);

        persist_elicitation_updates_at_path(
            &path,
            r#"{"main/session-a":{"identity":{"accountId":"a"},"sessionId":"session-a","queue":[1]}}"#,
        )
        .unwrap();
        persist_elicitation_updates_at_path(
            &path,
            r#"{"secondary/session-b":{"identity":{"accountId":"a"},"sessionId":"session-b","queue":[2]}}"#,
        )
        .unwrap();

        let records = read_records(&path).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records["main/session-a"]["queue"], json!([1]));
        assert_eq!(records["secondary/session-b"]["queue"], json!([2]));

        persist_elicitation_updates_at_path(&path, r#"{"main/session-a":null}"#).unwrap();
        let records = read_records(&path).unwrap();
        assert_eq!(records.len(), 1);
        assert!(records.contains_key("secondary/session-b"));
    }

    #[test]
    fn ignores_an_obsolete_envelope_before_applying_updates() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(ELICITATION_PERSISTENCE_FILENAME);
        fs::write(&path, r#"{"version":3,"records":{"old":{}}}"#).unwrap();

        persist_elicitation_updates_at_path(&path, r#"{"fresh":{"queue":[]}}"#).unwrap();

        let serialized = fs::read_to_string(&path).unwrap();
        let envelope: Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(envelope["version"], ELICITATION_PERSISTENCE_VERSION);
        assert!(envelope["records"].get("old").is_none());
        assert!(envelope["records"].get("fresh").is_some());
    }

    #[test]
    fn empty_updates_remove_the_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(ELICITATION_PERSISTENCE_FILENAME);
        fs::write(
            &path,
            serde_json::to_string(&json!({
                "version": ELICITATION_PERSISTENCE_VERSION,
                "records": {},
            }))
            .unwrap(),
        )
        .unwrap();

        persist_elicitation_updates_at_path(&path, "{}").unwrap();

        assert!(!path.exists());
    }
}
