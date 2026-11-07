use crate::{error, ssh::Session, store::checked, Workspace};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    net::Ipv6Addr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalForward {
    pub id: Uuid,
    pub name: String,
    pub local_port: u16,
    pub remote_address: String,
    pub remote_port: u16,
}
pub fn normalize_rules(rules: &mut Vec<LocalForward>) -> Result<(), String> {
    if rules.len() > 32 {
        return Err("每台主机最多保存 32 条本地转发规则。".into());
    }
    let (mut ids, mut ports) = (HashSet::new(), HashSet::new());
    for rule in rules {
        if rule.id.is_nil() {
            rule.id = Uuid::new_v4();
        }
        rule.name = checked(&rule.name, "规则名称", 120)?;
        rule.remote_address = checked(&rule.remote_address, "目标地址", 255)?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .into();
        if rule.remote_address.is_empty()
            || rule.remote_address.contains(['/', '@', '\\'])
            || rule.remote_address.contains(char::is_whitespace)
            || (rule.remote_address.contains(':')
                && rule.remote_address.parse::<Ipv6Addr>().is_err())
        {
            return Err("请输入目标服务的主机名或 IP 地址。".into());
        }
        if rule.local_port == 0 || rule.remote_port == 0 {
            return Err("端口须在 1 至 65535 之间。".into());
        }
        if !ids.insert(rule.id) || !ports.insert(rule.local_port) {
            return Err("规则标识和本地监听端口不能重复。".into());
        }
    }
    Ok(())
}
#[derive(Default)]
pub struct Forwards {
    jobs: Mutex<HashMap<Uuid, Arc<Forward>>>,
}
struct Forward {
    id: Uuid,
    session_id: Uuid,
    host_id: Uuid,
    host_name: String,
    rule: LocalForward,
    cancel: CancellationToken,
    done: CancellationToken,
    stats: Mutex<Stats>,
}
#[derive(Default)]
struct Stats {
    active: usize,
    error: String,
}
impl Forward {
    fn value(&self, status: &str) -> Value {
        let stats = self.stats.lock().unwrap();
        json!({"type":"forward","id":self.id,"sessionId":self.session_id,"hostId":self.host_id,
            "hostName":self.host_name,"rule":self.rule,"status":status,"activeConnections":stats.active,"error":stats.error})
    }
}
impl Forwards {
    pub fn list(&self) -> Value {
        json!(self
            .jobs
            .lock()
            .unwrap()
            .values()
            .map(|j| j.value(if j.cancel.is_cancelled() {
                "stopping"
            } else {
                "running"
            }))
            .collect::<Vec<_>>())
    }
    pub fn stop_all(&self) {
        for job in self.jobs.lock().unwrap().values() {
            job.cancel.cancel();
        }
    }
    pub async fn stop(&self, id: Uuid) -> Result<(), String> {
        let job = self.jobs.lock().unwrap().get(&id).cloned();
        if let Some(job) = job {
            job.cancel.cancel();
            job.done.cancelled().await;
        }
        Ok(())
    }
    fn uses_rule(&self, host: Uuid, rule: Uuid) -> bool {
        self.jobs
            .lock()
            .unwrap()
            .values()
            .any(|j| j.host_id == host && j.rule.id == rule)
    }
}

pub fn save_rule(ws: &Workspace, action: &str, value: Value) -> Result<Value, String> {
    let host_id = crate::id(&value["hostId"])?;
    let mut store = ws.store.lock().unwrap();
    let mut data = store.data()?.clone();
    let host = data
        .hosts
        .iter_mut()
        .find(|h| h.id == host_id)
        .ok_or("主机已删除。")?;
    let mut rule: LocalForward = crate::parse(value["rule"].clone())?;
    if !rule.id.is_nil() {
        let old = host
            .local_forwards
            .iter()
            .find(|r| r.id == rule.id)
            .ok_or("规则已删除，请刷新。")?;
        if serde_json::to_value(old).map_err(error)? != value["expected"] {
            return Err("规则已变化，请刷新后重试。".into());
        }
        if ws.forwards.uses_rule(host_id, rule.id) {
            return Err("请先停止该规则在所有会话中的转发，再编辑或删除。".into());
        }
    } else if action == "forwards:delete" {
        return Err("规则不存在。".into());
    }
    if action == "forwards:delete" {
        host.local_forwards.retain(|r| r.id != rule.id);
    } else {
        if rule.id.is_nil() {
            rule.id = Uuid::new_v4();
        }
        host.local_forwards.retain(|r| r.id != rule.id);
        host.local_forwards.push(rule);
        normalize_rules(&mut host.local_forwards)?;
    }
    let hosts = json!(data.hosts);
    store.update(data)?;
    Ok(hosts)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    session_id: Uuid,
    rule_id: Uuid,
    expected: LocalForward,
}

pub async fn start(ws: &Workspace, req: StartRequest) -> Result<Value, String> {
    let session = ws.connections.connected(req.session_id)?;
    let (rule, epoch) = {
        let store = ws.store.lock().unwrap();
        let data = store.data()?;
        session.check_route(data)?;
        let rule = data
            .host(session.host.id)?
            .local_forwards
            .iter()
            .find(|r| r.id == req.rule_id)
            .ok_or("转发规则已删除。")?
            .clone();
        if rule != req.expected {
            return Err("转发规则已变化，请刷新后重试。".into());
        }
        (rule, store.epoch)
    };
    let listener = TcpListener::bind(("127.0.0.1", rule.local_port))
        .await
        .map_err(|e| format!("无法监听 127.0.0.1:{}：{e}", rule.local_port))?;
    let job = Arc::new(Forward {
        id: Uuid::new_v4(),
        session_id: session.id,
        host_id: session.host.id,
        host_name: session.host.name.clone(),
        rule: rule.clone(),
        cancel: session.cancel.child_token(),
        done: CancellationToken::new(),
        stats: Mutex::default(),
    });
    {
        let store = ws.store.lock().unwrap();
        crate::ensure_epoch(&store, epoch)?;
        session.check_route(store.data()?)?;
        if session.cancel.is_cancelled()
            || !store
                .data()?
                .host(session.host.id)?
                .local_forwards
                .contains(&rule)
        {
            return Err("会话或规则已变化，请重新启动。".into());
        }
        let mut jobs = ws.forwards.jobs.lock().unwrap();
        if jobs.len() >= 32 {
            return Err("同时运行的转发规则已达 32 条上限。".into());
        }
        jobs.insert(job.id, job.clone());
    }
    let initial = job.value("running");
    ws.emit(initial.clone());
    let ws = ws.clone();
    tauri::async_runtime::spawn(async move {
        run(&ws, &session, job, listener).await;
    });
    Ok(initial)
}

async fn relay(
    session: Arc<Session>,
    mut socket: TcpStream,
    peer: std::net::SocketAddr,
    rule: LocalForward,
) -> Result<(), String> {
    let client = session.client.get().ok_or("SSH 会话已断开。")?;
    let channel = tokio::time::timeout(
        Duration::from_secs(15),
        client.channel_open_direct_tcpip(
            rule.remote_address,
            rule.remote_port.into(),
            peer.ip().to_string(),
            peer.port().into(),
        ),
    )
    .await
    .map_err(|_| "目标连接超时。".to_string())?
    .map_err(|e| format!("目标连接失败：{e}"))?;
    let mut stream = channel.into_stream();
    tokio::io::copy_bidirectional(&mut socket, &mut stream)
        .await
        .map_err(error)?;
    Ok(())
}
async fn run(ws: &Workspace, session: &Arc<Session>, job: Arc<Forward>, listener: TcpListener) {
    let mut sockets = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = job.cancel.cancelled() => break,
            result = sockets.join_next(), if !sockets.is_empty() => {
                let mut stats = job.stats.lock().unwrap();
                stats.active = stats.active.saturating_sub(1);
                if let Some(Ok(Err(error))) = result { stats.error = error; }
                drop(stats);
                ws.emit(job.value("running"));
            }
            accepted = listener.accept() => match accepted {
                Ok((socket, peer)) => {
                    if sockets.len() >= 32 {
                        job.stats.lock().unwrap().error = "同时连接已达 32 条上限，请稍后重试。".into();
                        drop(socket);
                    } else {
                        job.stats.lock().unwrap().active += 1;
                        job.stats.lock().unwrap().error.clear();
                        sockets.spawn(relay(session.clone(), socket, peer, job.rule.clone()));
                    }
                    ws.emit(job.value("running"));
                }
                Err(e) => { job.stats.lock().unwrap().error = format!("监听已中断：{e}"); break; }
            }
        }
    }
    // Drop the listening socket and every relay before reporting stopped / allowing a restart.
    drop(listener);
    sockets.shutdown().await;
    job.stats.lock().unwrap().active = 0;
    ws.forwards.jobs.lock().unwrap().remove(&job.id);
    ws.emit(job.value("stopped"));
    job.done.cancel();
}
