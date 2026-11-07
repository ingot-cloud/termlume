use crate::{error, ssh::Session, store::checked, Workspace};
use russh::{client, Channel};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    net::Ipv6Addr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalForward {
    pub id: Uuid,
    pub name: String,
    pub kind: String,
    pub local_port: u16,
    pub remote_address: String,
    pub remote_port: u16,
}
impl Default for LocalForward {
    fn default() -> Self {
        Self {
            id: Uuid::nil(),
            name: String::new(),
            kind: "local".into(),
            local_port: 0,
            remote_address: String::new(),
            remote_port: 0,
        }
    }
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
        if !matches!(rule.kind.as_str(), "local" | "remote" | "dynamic") {
            return Err("转发类型无效。".into());
        }
        if rule.kind == "dynamic" {
            rule.remote_address = String::new();
            rule.remote_port = 0;
        } else {
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
        }
        if rule.local_port == 0 || (rule.kind != "dynamic" && rule.remote_port == 0) {
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
    incoming: Option<mpsc::Sender<Channel<client::Msg>>>,
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
    pub fn offer_remote(&self, session: Uuid, port: u32, channel: Channel<client::Msg>) -> bool {
        let sender = self
            .jobs
            .lock()
            .unwrap()
            .values()
            .find(|job| {
                job.session_id == session
                    && job.rule.kind == "remote"
                    && u32::from(job.rule.local_port) == port
                    && !job.cancel.is_cancelled()
            })
            .and_then(|j| j.incoming.clone());
        if let Some(sender) = sender {
            match sender.try_send(channel) {
                Ok(()) => true,
                Err(e) => {
                    drop(e.into_inner().into_stream());
                    false
                }
            }
        } else {
            drop(channel.into_stream());
            false
        }
    }
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
    let client = session.client.get().ok_or("SSH 已断开。")?.clone();
    let listener = if rule.kind == "remote" {
        match tokio::time::timeout(
            Duration::from_secs(15),
            client.tcpip_forward("127.0.0.1", rule.local_port.into()),
        )
        .await
        {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(format!("远程监听被拒绝：{e}")),
            Err(_) => {
                session.cancel.cancel();
                return Err("远程监听确认超时，已关闭 SSH 以释放可能创建的监听。".into());
            }
        }
        None
    } else {
        Some(
            TcpListener::bind(("127.0.0.1", rule.local_port))
                .await
                .map_err(|e| format!("无法监听 127.0.0.1:{}：{e}", rule.local_port))?,
        )
    };
    let (incoming, receiver) = mpsc::channel(32);
    let job = Arc::new(Forward {
        id: Uuid::new_v4(),
        session_id: session.id,
        host_id: session.host.id,
        host_name: session.host.name.clone(),
        rule: rule.clone(),
        cancel: session.cancel.child_token(),
        done: CancellationToken::new(),
        stats: Mutex::default(),
        incoming: (rule.kind == "remote").then_some(incoming),
    });
    let registered = (|| -> Result<(), String> {
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
        Ok(())
    })();
    if let Err(error) = registered {
        if rule.kind == "remote" {
            if !matches!(
                tokio::time::timeout(
                    Duration::from_secs(5),
                    client.cancel_tcpip_forward("127.0.0.1", rule.local_port.into())
                )
                .await,
                Ok(Ok(()))
            ) {
                session.cancel.cancel();
            }
        }
        return Err(error);
    }
    let initial = job.value("running");
    ws.emit(initial.clone());
    let ws = ws.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(listener) = listener {
            run(&ws, &session, job, listener).await;
        } else {
            run_remote(&ws, &session, job, receiver).await;
        }
    });
    Ok(initial)
}

async fn relay(
    session: Arc<Session>,
    mut socket: TcpStream,
    peer: std::net::SocketAddr,
    mut rule: LocalForward,
) -> Result<(), String> {
    let client = session.client.get().ok_or("SSH 会话已断开。")?;
    let dynamic = rule.kind == "dynamic";
    if dynamic {
        let (address, port) =
            tokio::time::timeout(Duration::from_secs(10), socks_target(&mut socket))
                .await
                .map_err(|_| "SOCKS 握手超时。")??;
        rule.remote_address = address;
        rule.remote_port = port;
    }
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        client.channel_open_direct_tcpip(
            rule.remote_address,
            rule.remote_port.into(),
            peer.ip().to_string(),
            peer.port().into(),
        ),
    )
    .await
    .map_err(|_| "目标连接超时。".to_string())
    .and_then(|r| r.map_err(|e| format!("目标连接失败：{e}")));
    if dynamic {
        let reply = if result.is_ok() { 0 } else { 5 };
        socket
            .write_all(&[5, reply, 0, 1, 0, 0, 0, 0, 0, 0])
            .await
            .map_err(error)?;
    }
    let channel = result?;
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

async fn socks_target(socket: &mut TcpStream) -> Result<(String, u16), String> {
    let mut header = [0; 2];
    socket.read_exact(&mut header).await.map_err(error)?;
    if header[0] != 5 || header[1] == 0 || header[1] > 16 {
        return Err("仅支持 SOCKS5 CONNECT。".into());
    }
    let mut methods = vec![0; header[1] as usize];
    socket.read_exact(&mut methods).await.map_err(error)?;
    if !methods.contains(&0) {
        socket.write_all(&[5, 255]).await.map_err(error)?;
        return Err("SOCKS5 仅支持本机无认证连接。".into());
    }
    socket.write_all(&[5, 0]).await.map_err(error)?;
    let mut request = [0; 4];
    socket.read_exact(&mut request).await.map_err(error)?;
    if request[0] != 5 || request[1] != 1 || request[2] != 0 {
        socket
            .write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0])
            .await
            .map_err(error)?;
        return Err("不支持 SOCKS BIND 或 UDP。".into());
    }
    let address = match request[3] {
        1 => {
            let mut bytes = [0; 4];
            socket.read_exact(&mut bytes).await.map_err(error)?;
            std::net::Ipv4Addr::from(bytes).to_string()
        }
        4 => {
            let mut bytes = [0; 16];
            socket.read_exact(&mut bytes).await.map_err(error)?;
            std::net::Ipv6Addr::from(bytes).to_string()
        }
        3 => {
            let len = socket.read_u8().await.map_err(error)?;
            if len == 0 {
                return Err("SOCKS 目标为空。".into());
            }
            let mut bytes = vec![0; len as usize];
            socket.read_exact(&mut bytes).await.map_err(error)?;
            String::from_utf8(bytes).map_err(error)?
        }
        _ => return Err("SOCKS 地址类型不支持。".into()),
    };
    let port = socket.read_u16().await.map_err(error)?;
    if port == 0
        || address.chars().any(|c| c.is_control() || c.is_whitespace())
        || address.contains(['/', '@', '\\'])
    {
        return Err("SOCKS 目标无效。".into());
    }
    Ok((address, port))
}
async fn run_remote(
    ws: &Workspace,
    session: &Arc<Session>,
    job: Arc<Forward>,
    mut receiver: mpsc::Receiver<Channel<client::Msg>>,
) {
    let mut sockets = JoinSet::new();
    loop {
        tokio::select! {biased;_ = job.cancel.cancelled()=>break,
            result=sockets.join_next(),if !sockets.is_empty()=>{let mut stats=job.stats.lock().unwrap();stats.active=stats.active.saturating_sub(1);if let Some(Ok(Err(e)))=result{stats.error=e;}drop(stats);ws.emit(job.value("running"));},
            channel=receiver.recv()=>{let Some(channel)=channel else{break;};if sockets.len()>=32{drop(channel.into_stream());job.stats.lock().unwrap().error="远程连接已达 32 条上限。".into();continue;}job.stats.lock().unwrap().active+=1;let address=job.rule.remote_address.clone();let port=job.rule.remote_port;sockets.spawn(async move{let mut stream=channel.into_stream();let mut socket=tokio::time::timeout(Duration::from_secs(10),TcpStream::connect((address.as_str(),port))).await.map_err(|_|"本机目标连接超时。".to_string())?.map_err(error)?;tokio::io::copy_bidirectional(&mut stream,&mut socket).await.map_err(error)?;Ok::<_,String>(())});ws.emit(job.value("running"));}
        }
    }
    receiver.close();
    sockets.shutdown().await;
    if let Some(client) = session.client.get() {
        if !session.cancel.is_cancelled()
            && !matches!(
                tokio::time::timeout(
                    Duration::from_secs(5),
                    client.cancel_tcpip_forward("127.0.0.1", job.rule.local_port.into())
                )
                .await,
                Ok(Ok(()))
            )
        {
            job.stats.lock().unwrap().error = "无法确认远程端口释放，已关闭 SSH 连接。".into();
            session.cancel.cancel();
        }
    }
    job.stats.lock().unwrap().active = 0;
    ws.forwards.jobs.lock().unwrap().remove(&job.id);
    ws.emit(job.value("stopped"));
    job.done.cancel();
}
