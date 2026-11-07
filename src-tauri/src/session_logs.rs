use crate::{error, now, ssh::Session};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Mutex,
};
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: Uuid,
    session_id: Uuid,
    host: String,
    address: String,
    started: u64,
    ended: Option<u64>,
    bytes: u64,
}
struct State {
    entries: Vec<Entry>,
    active: HashMap<Uuid, Uuid>,
    aliases: HashMap<Uuid, Uuid>,
}
pub struct Logs {
    directory: PathBuf,
    state: Mutex<State>,
}
impl Logs {
    pub fn new(directory: PathBuf) -> Result<Self, String> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory).map_err(error)?;
        let mut entries = Vec::new();
        for file in fs::read_dir(&directory).map_err(error)? {
            let file = file.map_err(error)?;
            if file.path().extension().is_some_and(|e| e == "json") {
                if let Ok(bytes) = fs::read(file.path()) {
                    if bytes.len() < 16384 {
                        if let Ok(entry) = serde_json::from_slice::<Entry>(&bytes) {
                            entries.push(entry);
                        }
                    }
                }
            }
        }
        entries.sort_by_key(|e| e.started);
        Ok(Self {
            directory,
            state: Mutex::new(State {
                entries,
                active: HashMap::new(),
                aliases: HashMap::new(),
            }),
        })
    }
    fn meta(&self, entry: &Entry) -> Result<(), String> {
        crate::store::write_atomic(
            &self.directory.join(format!("{}.json", entry.id)),
            &serde_json::to_vec(entry).map_err(error)?,
        )
    }
    pub fn list(&self) -> Value {
        let state = self.state.lock().unwrap();
        json!(state
            .entries
            .iter()
            .rev()
            .map(|e| {
                let mut v = json!(e);
                v["active"] = json!(state.active.get(&e.session_id) == Some(&e.id));
                v
            })
            .collect::<Vec<_>>())
    }
    pub fn start(&self, session: &Session) -> Result<Value, String> {
        let mut state = self.state.lock().unwrap();
        if state.active.contains_key(&session.id) {
            return Err("此会话正在录制。".into());
        }
        while state.entries.len() >= 50 {
            let Some(index) = state
                .entries
                .iter()
                .position(|e| !state.active.values().any(|id| *id == e.id))
            else {
                return Err("活跃日志已达上限。".into());
            };
            let old = state.entries.remove(index);
            let _ = fs::remove_file(self.directory.join(format!("{}.json", old.id)));
            let _ = fs::remove_file(self.directory.join(format!("{}.jsonl", old.id)));
        }
        let entry = Entry {
            id: Uuid::new_v4(),
            session_id: session.id,
            host: session.host.name.clone(),
            address: format!(
                "{}@{}:{}",
                session.host.username, session.host.address, session.host.port
            ),
            started: now(),
            ended: None,
            bytes: 0,
        };
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(self.directory.join(format!("{}.jsonl", entry.id)))
            .map_err(error)?;
        self.meta(&entry)?;
        state.active.insert(session.id, entry.id);
        state.entries.push(entry.clone());
        Ok(json!(entry))
    }
    pub fn alias(&self, id: Uuid, session: Uuid) {
        self.state.lock().unwrap().aliases.insert(id, session);
    }
    pub fn unalias(&self, id: Uuid) {
        self.state.lock().unwrap().aliases.remove(&id);
    }
    pub fn record(&self, source: Uuid, bytes: &[u8]) -> Option<(Uuid, String)> {
        let mut state = self.state.lock().unwrap();
        let session = *state.aliases.get(&source).unwrap_or(&source);
        let id = *state.active.get(&session)?;
        let entry = state.entries.iter_mut().find(|e| e.id == id)?;
        if entry.bytes + bytes.len() as u64 > 20 * 1024 * 1024 {
            entry.ended = Some(now());
            let _ = self.meta(entry);
            state.active.remove(&session);
            return Some((session, "日志达到 20 MiB 上限，已停止录制。".into()));
        }
        let result = (|| {
            let mut file = OpenOptions::new()
                .append(true)
                .open(self.directory.join(format!("{id}.jsonl")))
                .map_err(error)?;
            let line = serde_json::to_vec(
                &json!({"at":now(),"source":source,"bytes":STANDARD.encode(bytes)}),
            )
            .map_err(error)?;
            file.write_all(&line).map_err(error)?;
            file.write_all(b"\n").map_err(error)?;
            Ok::<_, String>(())
        })();
        if let Err(error) = result {
            entry.ended = Some(now());
            let _ = self.meta(entry);
            state.active.remove(&session);
            Some((session, format!("日志写入失败，已停止：{error}")))
        } else {
            entry.bytes += bytes.len() as u64;
            None
        }
    }
    pub fn stop(&self, session: Uuid) {
        let mut state = self.state.lock().unwrap();
        if let Some(id) = state.active.remove(&session) {
            if let Some(entry) = state.entries.iter_mut().find(|e| e.id == id) {
                entry.ended = Some(now());
                let _ = self.meta(entry);
            }
        }
    }
    pub fn stop_all(&self) {
        let sessions: Vec<_> = self.state.lock().unwrap().active.keys().copied().collect();
        for session in sessions {
            self.stop(session);
        }
    }
    pub fn read(&self, id: Uuid) -> Result<String, String> {
        let entry = self
            .state
            .lock()
            .unwrap()
            .entries
            .iter()
            .find(|e| e.id == id)
            .cloned()
            .ok_or("日志不存在。")?;
        let bytes = crate::vault::bounded_read(
            &self.directory.join(format!("{id}.jsonl")),
            32 * 1024 * 1024,
        )?;
        let mut output = format!("{} · {} · {}\n", entry.host, entry.address, entry.started);
        for line in bytes.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
            if let Ok(event) = serde_json::from_slice::<Value>(line) {
                if let Some(bytes) = event["bytes"]
                    .as_str()
                    .and_then(|s| STANDARD.decode(s).ok())
                {
                    output.push_str(&format!(
                        "\n[{} / {}]\n{}",
                        event["at"],
                        event["source"],
                        String::from_utf8_lossy(&bytes)
                    ));
                }
            }
        }
        Ok(output)
    }
    pub fn remove(&self, id: Uuid) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if state.active.values().any(|active| *active == id) {
            return Err("请先停止录制再删除日志。".into());
        }
        if !state.entries.iter().any(|e| e.id == id) {
            return Err("日志不存在。".into());
        }
        for suffix in ["jsonl", "json"] {
            let path = self.directory.join(format!("{id}.{suffix}"));
            if path.exists() {
                fs::remove_file(path).map_err(error)?;
            }
        }
        state.entries.retain(|e| e.id != id);
        Ok(())
    }
}
