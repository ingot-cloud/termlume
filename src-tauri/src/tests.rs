use super::*;
use tauri::ipc::InvokeResponseBody;
use tokio::sync::mpsc;

#[test]
fn git_envelope_hides_password_material_and_reads_legacy_snapshots() {
    let password = "vault fixture password";
    let recovery = vault::recovery_code();
    let sync_key = vault::git_key(&vault::recovery_code()).unwrap();
    let wrong_key = vault::git_key(&vault::recovery_code()).unwrap();
    let (key, header) = vault::create(password, &recovery).unwrap();
    let rows =
        json!({"hosts": [{"address": "private.example.test", "password": "server password"}]});
    let legacy = vault::encode(&key, &header, "portable", &rows).unwrap();
    let legacy_copy: vault::GitEnvelope =
        serde_json::from_value(serde_json::to_value(&legacy).unwrap()).unwrap();
    assert!(!legacy_copy.is_protected());
    assert!(legacy_copy.open(None).is_ok());

    let protected = vault::GitEnvelope::protect(&legacy, &sync_key).unwrap();
    let document = serde_json::to_value(&protected).unwrap();
    assert!(document.get("header").is_none());
    let restored: vault::GitEnvelope = serde_json::from_value(document).unwrap();
    assert!(restored.is_protected());
    assert!(restored.open(None).is_err());
    assert!(restored.open(Some(&wrong_key)).is_err());
    let inner = restored.open(Some(&sync_key)).unwrap();
    assert!(inner
        .unlock::<Value>("wrong password", false, "portable")
        .is_err());
    let (_, decoded) = inner.unlock::<Value>(password, false, "portable").unwrap();
    assert_eq!(decoded, rows);
}

fn make_workspace(
    home: &std::path::Path,
    legacy: Option<PathBuf>,
) -> (tempfile::TempDir, Workspace) {
    let profile = tempfile::tempdir().unwrap();
    let ws = Workspace::new(profile.path().to_path_buf(), home.into(), legacy).unwrap();
    (profile, ws)
}
fn events(ws: &Workspace) -> mpsc::UnboundedReceiver<Value> {
    let (send, receive) = mpsc::unbounded_channel();
    let weak = Arc::downgrade(&ws.0);
    *ws.events.lock().unwrap() = Some(Channel::new(move |response| {
        if let InvokeResponseBody::Json(payload) = response {
            let event: Value = serde_json::from_str(&payload).unwrap();
            if let Some(inner) = weak.upgrade() {
                if let Ok(ack) = id(&event["ack"]) {
                    if let Some(tx) = inner.acks.lock().unwrap().remove(&ack) {
                        let _ = tx.send(());
                    }
                }
            }
            let _ = send.send(event);
        }
        Ok(())
    }));
    receive
}
async fn until(
    rx: &mut mpsc::UnboundedReceiver<Value>,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = rx.recv().await.unwrap();
            if predicate(&event) {
                return event;
            }
        }
    })
    .await
    .expect("timed out waiting for a workbench event")
}
async fn call(ws: &Workspace, name: &str, value: Value) -> Value {
    dispatch(ws, name, value)
        .await
        .unwrap_or_else(|e| panic!("{name}: {e}"))
}

#[tokio::test]
async fn invalid_touch_id_credential_leaves_vault_locked_and_can_be_removed() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let password = "workspace test password";
    let state = call(
        &ws,
        "vault:enable",
        json!({"password": password, "recovery": vault::recovery_code()}),
    )
    .await;
    assert_eq!(state["touchIdEnabled"], false);
    let path = ws.store.lock().unwrap().touch_id_path().unwrap();
    store::write_atomic(&path, b"invalid credential").unwrap();
    drop(ws);

    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert!(dispatch(&ws, "vault:set-touch-id", json!(false))
        .await
        .is_err());
    assert!(dispatch(&ws, "vault:unlock", json!({"useTouchId":true}))
        .await
        .is_err());
    assert_eq!(call(&ws, "vault:state", Value::Null).await["locked"], true);

    call(&ws, "vault:unlock", json!({"secret":password})).await;
    let state = call(&ws, "vault:set-touch-id", json!(false)).await;
    assert_eq!(state["touchIdEnabled"], false);
    assert!(!path.exists());
}

#[tokio::test]
async fn auto_lock_settings_respect_activity_and_survive_restart() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let legacy: Data = serde_json::from_value(json!({"hosts":[],"fingerprints":[]})).unwrap();
    assert_eq!(legacy.lock_settings.auto_lock_minutes, Some(15));
    assert_eq!(
        call(&ws, "vault:state", Value::Null).await["autoLockMinutes"],
        15
    );
    assert!(dispatch(&ws, "vault:set-auto-lock", json!(5))
        .await
        .is_err());
    let password = "test1234";
    call(
        &ws,
        "vault:enable",
        json!({"password":password,"recovery":vault::recovery_code()}),
    )
    .await;
    for invalid in [json!(0), json!(1441), json!(-1), json!(1.5), json!("5")] {
        assert!(dispatch(&ws, "vault:set-auto-lock", invalid).await.is_err());
    }
    assert_eq!(
        call(&ws, "vault:state", Value::Null).await["autoLockMinutes"],
        15
    );
    *ws.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(14 * 60);
    assert_eq!(ws.lock(true)["locked"], false);
    let state = call(&ws, "vault:set-auto-lock", json!(5)).await;
    assert_eq!(state["autoLockMinutes"], 5);
    assert_eq!(ws.lock(true)["locked"], false);
    *ws.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(5 * 60 - 1);
    assert_eq!(ws.lock(true)["locked"], false);
    *ws.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(5 * 60);
    assert_eq!(ws.lock(true)["locked"], true);
    call(&ws, "vault:unlock", json!({"secret":password})).await;
    call(&ws, "vault:set-auto-lock", Value::Null).await;
    *ws.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(2 * 24 * 60 * 60);
    assert_eq!(ws.lock(true)["locked"], false);
    {
        let store = ws.store.lock().unwrap();
        let snapshot = serde_json::to_value(git::Snapshot {
            hosts: store.data().unwrap().snapshot(),
            parent_commit: None,
        })
        .unwrap();
        assert!(snapshot.get("lockSettings").is_none());
        assert!(snapshot.get("autoLockMinutes").is_none());
    }
    let document = std::fs::read_to_string(profile.path().join("workspace.json")).unwrap();
    assert!(!document.contains("lockSettings"));
    assert_eq!(call(&ws, "vault:lock", Value::Null).await["locked"], true);
    assert!(dispatch(&ws, "vault:set-auto-lock", json!(1))
        .await
        .is_err());
    drop(ws);

    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    let state = call(&ws, "vault:unlock", json!({"secret":password})).await;
    assert!(state["autoLockMinutes"].is_null());
    call(&ws, "vault:set-auto-lock", json!(1440)).await;
    *ws.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(1440 * 60 - 1);
    assert_eq!(ws.lock(true)["locked"], false);
    call(&ws, "vault:set-auto-lock", json!(1)).await;
    *ws.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(61);
    call(&ws, "vault:activity", Value::Null).await;
    assert_eq!(ws.lock(true)["locked"], false);
    drop(ws);

    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    let state = call(&ws, "vault:unlock", json!({"secret":password})).await;
    assert_eq!(state["autoLockMinutes"], 1);
    *ws.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(60);
    assert_eq!(ws.lock(true)["locked"], true);
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "requires the macOS login keychain"]
async fn startup_unlock_preserves_encryption_and_is_local_to_the_workspace() {
    struct SavedKey(String);
    impl Drop for SavedKey {
        fn drop(&mut self) {
            let _ = startup_unlock::delete(&self.0);
        }
    }

    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let password = "test1234";
    let recovery = vault::recovery_code();
    let hosts = call(
        &ws,
        "hosts:save",
        json!({"name":"private startup fixture","address":"private.example.test","username":"ops","port":22,"auth":"agent"}),
    )
    .await;
    let state = call(
        &ws,
        "vault:enable",
        json!({"password":password,"recovery":recovery}),
    )
    .await;
    assert_eq!(state["startupUnlockRequired"], true);
    let original = std::fs::read(profile.path().join("workspace.json")).unwrap();
    let state = call(&ws, "vault:set-startup-unlock", json!(false)).await;
    assert_eq!(state["startupUnlockRequired"], false);
    let (settings, account) = {
        let store = ws.store.lock().unwrap();
        let settings = store.startup_unlock_path();
        let account = store
            .startup_unlock
            .as_ref()
            .unwrap()
            .account(&settings)
            .unwrap();
        let snapshot = git::Snapshot {
            hosts: store.data().unwrap().snapshot(),
            parent_commit: None,
        };
        let envelope = vault::encode(
            store.key.as_ref().unwrap(),
            &store.envelope.as_ref().unwrap().header,
            "portable",
            &snapshot,
        )
        .unwrap();
        let encoded = serde_json::to_string(&envelope).unwrap();
        assert!(!encoded.contains("private startup fixture"));
        assert!(!encoded.contains("private.example.test"));
        assert!(envelope
            .unlock::<git::Snapshot>(password, false, "portable")
            .is_ok());
        assert!(envelope
            .unlock::<git::Snapshot>(&recovery, true, "portable")
            .is_ok());
        (settings, account)
    };
    let _cleanup = SavedKey(account.clone());
    assert_eq!(
        std::fs::read(profile.path().join("workspace.json")).unwrap(),
        original
    );
    let preferences = std::fs::read_to_string(&settings).unwrap();
    assert!(!preferences.contains(password));
    assert!(!preferences.contains("private startup fixture"));
    drop(ws);

    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "vault:state", Value::Null).await["locked"], false);
    assert_eq!(call(&ws, "hosts:list", Value::Null).await, hosts);
    call(&ws, "vault:lock", Value::Null).await;
    assert_eq!(call(&ws, "vault:state", Value::Null).await["locked"], true);
    assert!(dispatch(&ws, "vault:set-startup-unlock", json!(true))
        .await
        .is_err());

    let copied = tempfile::tempdir().unwrap();
    std::fs::copy(
        profile.path().join("workspace.json"),
        copied.path().join("workspace.json"),
    )
    .unwrap();
    std::fs::copy(&settings, copied.path().join("startup-unlock.json")).unwrap();
    let other = Workspace::new(copied.path().into(), home.path().into(), None).unwrap();
    let state = call(&other, "vault:state", Value::Null).await;
    assert_eq!(state["locked"], true);
    assert!(state["startupUnlockError"].is_string());

    startup_unlock::delete(&account).unwrap();
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    let state = call(&ws, "vault:state", Value::Null).await;
    assert_eq!(state["locked"], true);
    assert_eq!(state["startupUnlockRequired"], false);
    assert!(state["startupUnlockError"].is_string());
    let state = call(&ws, "vault:unlock", json!({"secret":password})).await;
    assert!(state["startupUnlockError"].is_null());
    let state = call(&ws, "vault:set-startup-unlock", json!(true)).await;
    assert_eq!(state["startupUnlockRequired"], true);
    assert!(!settings.exists());

    call(&ws, "vault:set-startup-unlock", json!(false)).await;
    let account = {
        let store = ws.store.lock().unwrap();
        store
            .startup_unlock
            .as_ref()
            .unwrap()
            .account(&settings)
            .unwrap()
    };
    let _cleanup = SavedKey(account.clone());
    call(&ws, "vault:set-startup-unlock", json!(true)).await;
    assert!(startup_unlock::read(&account).is_err());
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "vault:state", Value::Null).await["locked"], true);
}

async fn connect_tab(
    ws: &Workspace,
    rx: &mut mpsc::UnboundedReceiver<Value>,
    host: &Value,
    secret: &str,
    saved: bool,
    remember: bool,
) -> Uuid {
    let tab = Uuid::new_v4();
    call(ws,"ssh:connect",json!({"id":tab,"expected":host,"secret":secret,"useSaved":saved,"remember":remember,"dimensions":{"rows":24,"cols":80}})).await;
    loop {
        let e = until(rx, |e| {
            e["id"] == tab.to_string() && matches!(e["type"].as_str(), Some("trust" | "session"))
        })
        .await;
        if e["type"] == "trust" {
            call(ws, "ssh:trust", json!({"id":tab,"accepted":true})).await;
        } else {
            assert_eq!(e["status"], "ready", "{e}");
            return tab;
        }
    }
}

#[tokio::test]
async fn vault_and_host_requests_round_trip() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let hosts = call(&ws,"hosts:save",json!({"address":" [::1] ","port":2222,"username":" root ","auth":"agent","group":"test","tags":["one","one"],"logPath":"/tmp/a'b"})).await;
    assert_eq!(hosts[0]["address"], "::1");
    assert_eq!(hosts[0]["tags"], json!(["one"]));
    let recovery = call(&ws, "vault:recovery-code", Value::Null).await;
    let rejected = dispatch(
        &ws,
        "vault:enable",
        json!({"password":"vault12", "recovery":recovery}),
    )
    .await
    .unwrap_err();
    assert!(rejected.contains("至少需要 8 个字符"));
    call(
        &ws,
        "vault:enable",
        json!({"password":"vault123", "recovery":recovery}),
    )
    .await;
    call(&ws, "vault:lock", Value::Null).await;
    assert!(dispatch(&ws, "hosts:list", Value::Null).await.is_err());
    assert!(dispatch(&ws, "vault:unlock", json!({"secret":"bad"}))
        .await
        .is_err());
    call(&ws, "vault:unlock", json!({"secret":"vault123"})).await;
    assert_eq!(call(&ws, "hosts:list", Value::Null).await, hosts);
    call(&ws, "vault:lock", Value::Null).await;
    call(
        &ws,
        "vault:unlock",
        json!({"secret":recovery,"useRecovery":true}),
    )
    .await;
    assert_eq!(call(&ws, "hosts:list", Value::Null).await, hosts);
    assert!(
        !std::fs::read_to_string(profile.path().join("workspace.json"))
            .unwrap()
            .contains("root")
    );
    assert_eq!(
        call(
            &ws,
            "commands:preview",
            json!({"action":"tail","argument":"/tmp/a'b","lines":4})
        )
        .await,
        "tail -n 4 '/tmp/a'\\''b'"
    );
    let key = call(
        &ws,
        "keys:generate",
        json!({"name":"fixture","passphrase":"test key passphrase"}),
    )
    .await;
    assert!(key["publicKey"]
        .as_str()
        .unwrap()
        .starts_with("ssh-ed25519 "));
    let keys = call(&ws, "keys:scan", Value::Null).await;
    assert_eq!(keys["keys"].as_array().unwrap().len(), 1);
    assert_eq!(keys["keys"][0]["encrypted"], true);
    assert!(dispatch(
        &ws,
        "keys:generate",
        json!({"name":"fixture","passphrase":""})
    )
    .await
    .is_err());
    let preview = keys::import_config("Host jump\n HostName server\n ProxyJump other\nHost plain\n HostName direct\n User admin\n IdentityFile ~/localkey\n",home.path());
    assert_eq!(preview["rows"][0]["issue"], "需要跳板机或代理");
    assert_eq!(preview["rows"][1]["auth"], "key");
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "requires an isolated localhost OpenSSH fixture and agent"]
async fn macos_transport_migration_and_sync() {
    let fixture = PathBuf::from(std::env::var_os("TERMLUME_TEST_FIXTURE").unwrap());
    let (profile, ws) = make_workspace(&fixture, Some(fixture.join("legacy.json")));
    assert_eq!(call(&ws, "vault:state", Value::Null).await["locked"], true);
    call(
        &ws,
        "vault:unlock",
        json!({"secret":"fixture passphrase 测试"}),
    )
    .await;
    let old = call(&ws, "hosts:list", Value::Null).await;
    assert_eq!(old[0]["name"], "旧主机");
    assert_eq!(
        call(&ws, "hosts:has-password", old[0]["id"].clone()).await,
        false
    );
    let user = std::env::var("USER").unwrap();
    let openssh_port = std::fs::read_to_string(fixture.join("openssh-port"))
        .unwrap()
        .trim()
        .parse::<u16>()
        .unwrap();
    let add_host = |auth: &str, key_path: Option<PathBuf>, port: u16, user: &str| json!({"name":auth,"address":"127.0.0.1","port":port,"username":user,"auth":auth,"keyPath":key_path});
    let agent = call(&ws, "keys:agent", Value::Null).await;
    assert_eq!(agent["available"], true);
    assert!(!agent["keys"].as_array().unwrap().is_empty());
    let host1 = call(
        &ws,
        "hosts:save",
        add_host("agent", None, openssh_port, &user),
    )
    .await[1]
        .clone();
    let host2 = call(
        &ws,
        "hosts:save",
        add_host("key", Some(fixture.join("client-rsa")), openssh_port, &user),
    )
    .await[2]
        .clone();
    let mut rx = events(&ws);
    let first = connect_tab(&ws, &mut rx, &host1, "", false, false).await;
    let second = connect_tab(&ws, &mut rx, &host2, "fixture key passphrase", false, false).await;
    call(
        &ws,
        "ssh:resize",
        json!({"id":first,"size":{"rows":34,"cols":92}}),
    )
    .await;
    call(
        &ws,
        "ssh:input",
        json!({"id":first,"data":"printf 'TERMLUME_%s\\n' 'TERMINAL'; stty size\r"}),
    )
    .await;
    let mut terminal = String::new();
    loop {
        let e = until(&mut rx, |e| {
            e["type"] == "output" && e["id"] == first.to_string()
        })
        .await;
        terminal.push_str(&String::from_utf8_lossy(
            &STANDARD.decode(e["bytes"].as_str().unwrap()).unwrap(),
        ));
        if terminal.contains("TERMLUME_TERMINAL") && terminal.contains("34 92") {
            break;
        }
    }
    let command = Uuid::new_v4();
    let remote_dir = fixture.join("remote");
    let log = remote_dir.join("sample log.txt");
    call(&ws,"commands:start",json!({"id":command,"sessionId":second,"request":{"action":"tail","argument":log,"lines":2}})).await;
    let output = until(&mut rx, |e| {
        e["type"] == "output" && e["id"] == command.to_string()
    })
    .await;
    assert!(
        String::from_utf8_lossy(&STANDARD.decode(output["bytes"].as_str().unwrap()).unwrap())
            .contains("日志回归")
    );
    assert_eq!(
        until(&mut rx, |e| e["type"] == "command"
            && e["id"] == command.to_string()
            && e["status"] != "running")
        .await["status"],
        "done"
    );
    let follow = Uuid::new_v4();
    call(
        &ws,
        "commands:start",
        json!({"id":follow,"sessionId":second,"request":{"action":"follow","argument":log}}),
    )
    .await;
    until(&mut rx, |e| {
        e["type"] == "output" && e["id"] == follow.to_string()
    })
    .await;
    call(&ws, "commands:stop", json!(follow)).await;
    assert_eq!(
        until(&mut rx, |e| e["type"] == "command"
            && e["id"] == follow.to_string()
            && e["status"] != "running")
        .await["status"],
        "stopped"
    );

    let files = call(
        &ws,
        "files:list",
        json!({"id":second,"directory":remote_dir}),
    )
    .await;
    assert!(files["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["name"] == "sample log.txt"));
    let folder = format!("mkdir-{}", Uuid::new_v4());
    call(
        &ws,
        "files:mkdir",
        json!({"id":second,"directory":remote_dir,"name":folder}),
    )
    .await;
    assert!(remote_dir.join(&folder).is_dir());
    let new_file = json!({"id":second,"directory":remote_dir.join(&folder),"name":"new empty.txt"});
    call(&ws, "files:create-file", new_file.clone()).await;
    let created = remote_dir.join(&folder).join("new empty.txt");
    assert_eq!(std::fs::metadata(&created).unwrap().len(), 0);
    std::fs::write(&created, b"keep original").unwrap();
    assert!(dispatch(&ws, "files:create-file", new_file).await.is_err());
    assert_eq!(std::fs::read(&created).unwrap(), b"keep original");
    for (path, kind) in [(&remote_dir, "directory"), (&log, "file")] {
        assert_eq!(
            call(&ws, "files:inspect", json!({"id":second,"path":path})).await["kind"],
            kind
        );
    }
    let session = ws.connections.connected(second).unwrap();
    let source = fixture
        .join("local")
        .join(format!("input-{}.bin", Uuid::new_v4()));
    let data = vec![42; 1024 * 1024];
    std::fs::write(&source, &data).unwrap();
    let drop_request = json!({
        "id": second, "direction": "up", "directory": remote_dir.join(&folder),
        "dropTicket": ws.transfers.capture_drop(vec![source.clone()])
    });
    let prepared = call(&ws, "files:prepare", drop_request.clone()).await;
    assert!(dispatch(&ws, "files:prepare", drop_request).await.is_err());
    call(
        &ws,
        "files:enqueue",
        json!({"ticket":prepared["ticket"],"policy":"skip"}),
    )
    .await;
    let result = until(&mut rx, |e| {
        e["type"] == "transfer" && e["bytes"] == 1048576 && e["status"] == "done"
    })
    .await;
    assert_eq!(result["sessionId"], second.to_string());
    assert_eq!(
        std::fs::read(remote_dir.join(&folder).join(source.file_name().unwrap())).unwrap(),
        data
    );
    let remote = remote_dir
        .join(&folder)
        .join("round trip.bin")
        .to_string_lossy()
        .into_owned();
    let output = fixture
        .join("local")
        .join(format!("output-{}.bin", Uuid::new_v4()));
    for (upload, local, policy) in [
        (true, source.clone(), "skip"),
        (true, source.clone(), "replace"),
        (false, output.clone(), "skip"),
        (false, output.clone(), "keep"),
    ] {
        let prepared = ws
            .transfers
            .stage(session.clone(), upload, vec![(remote.clone(), local)])
            .await
            .unwrap();
        call(
            &ws,
            "files:enqueue",
            json!({"ticket":prepared["ticket"],"policy":policy}),
        )
        .await;
        let result = until(&mut rx, |e| {
            e["type"] == "transfer"
                && matches!(
                    e["status"].as_str(),
                    Some("done" | "skipped" | "failed" | "unverified")
                )
        })
        .await;
        assert_eq!(result["status"], "done", "{result}");
        assert_eq!(result["bytes"], 1048576);
    }
    assert_eq!(std::fs::read(&output).unwrap(), data);
    let tree = remote_dir.join("download-tree");
    std::fs::create_dir_all(tree.join("nested/empty")).unwrap();
    std::fs::write(tree.join("nested/with spaces.txt"), b"directory download").unwrap();
    std::os::unix::fs::symlink(&log, tree.join("ignored-link")).unwrap();
    let local_tree = fixture.join("local/download-tree");
    std::fs::create_dir(&local_tree).unwrap();
    std::fs::write(local_tree.join("keep"), b"original").unwrap();
    let prepared = ws
        .transfers
        .stage(
            session,
            false,
            vec![(tree.to_string_lossy().into_owned(), local_tree.clone())],
        )
        .await
        .unwrap();
    assert_eq!(prepared["files"][0]["skipped"], 1);
    assert_eq!(prepared["files"][0]["canReplace"], false);
    call(
        &ws,
        "files:enqueue",
        json!({"ticket":prepared["ticket"],"policy":"keep"}),
    )
    .await;
    let result = until(&mut rx, |e| {
        e["type"] == "transfer"
            && matches!(e["status"].as_str(), Some("done" | "skipped" | "failed"))
    })
    .await;
    assert_eq!(result["status"], "done", "{result}");
    let downloaded = local_tree.with_file_name("download-tree (2)");
    assert!(downloaded.join("nested/empty").is_dir());
    assert_eq!(
        std::fs::read(downloaded.join("nested/with spaces.txt")).unwrap(),
        b"directory download"
    );
    assert!(!downloaded.join("ignored-link").exists());
    assert_eq!(std::fs::read(local_tree.join("keep")).unwrap(), b"original");
    let history = call(&ws, "files:history", Value::Null).await;
    let records = history.as_array().unwrap();
    assert_eq!(
        records
            .iter()
            .filter(|record| record["direction"] == "up")
            .count(),
        3
    );
    assert_eq!(
        records
            .iter()
            .filter(|record| record["direction"] == "down")
            .count(),
        3
    );
    assert!(records
        .iter()
        .all(|record| record["finishedAt"].as_u64().is_some()));
    let removed = call(&ws, "files:remove-history", result["id"].clone()).await;
    assert_eq!(removed, json!([result["id"]]));
    let cleared = call(&ws, "files:remove-history", Value::Null).await;
    assert_eq!(cleared.as_array().unwrap().len(), 2);
    assert!(downloaded.join("nested/with spaces.txt").is_file());
    assert!(output.is_file());
    let remaining = call(&ws, "files:history", Value::Null).await;
    assert_eq!(remaining.as_array().unwrap().len(), 3);
    assert!(remaining
        .as_array()
        .unwrap()
        .iter()
        .all(|record| record["direction"] == "up"));
    let reopened = Store::open(profile.path(), None).unwrap();
    assert!(reopened.data().is_err());
    let persisted: Data = reopened
        .envelope
        .unwrap()
        .decode(ws.store.lock().unwrap().key.as_ref().unwrap(), "local")
        .unwrap();
    assert_eq!(json!(persisted.transfer_history), remaining);
    let password_attempts_before = std::fs::read(fixture.join("password-attempts"))
        .unwrap_or_default()
        .len();
    let password_fixture: Value =
        serde_json::from_slice(&std::fs::read(fixture.join("password-server.json")).unwrap())
            .unwrap();
    let port = password_fixture["port"].as_u64().unwrap() as u16;
    let mut draft = add_host("password", None, port, "pilot");
    draft["localPassword"] = json!("pilot-local-only");
    let host3 = call(&ws, "hosts:save", draft).await[3].clone();
    assert!(host3.get("localPassword").is_none());
    assert_eq!(
        call(&ws, "hosts:reveal-password", host3["id"].clone()).await,
        "pilot-local-only"
    );
    assert!(!ws
        .store
        .lock()
        .unwrap()
        .data()
        .unwrap()
        .snapshot()
        .iter()
        .any(|row| row.password.is_some()));
    let rejected = Uuid::new_v4();
    call(
        &ws,
        "ssh:connect",
        json!({"id":rejected, "expected":host3, "secret":"", "useSaved":true}),
    )
    .await;
    until(&mut rx, |e| {
        e["id"] == rejected.to_string() && e["type"] == "trust"
    })
    .await;
    assert_eq!(
        std::fs::read(fixture.join("password-attempts"))
            .unwrap_or_default()
            .len(),
        password_attempts_before
    );
    call(&ws, "ssh:trust", json!({"id":rejected, "accepted":false})).await;
    until(&mut rx, |e| {
        e["id"] == rejected.to_string() && e["status"] == "closed"
    })
    .await;
    assert_eq!(
        std::fs::read(fixture.join("password-attempts"))
            .unwrap_or_default()
            .len(),
        password_attempts_before
    );
    let offline_saved = connect_tab(&ws, &mut rx, &host3, "", true, false).await;
    call(&ws, "ssh:close", json!(offline_saved)).await;
    let mut renamed = host3.clone();
    renamed["name"] = json!("密码主机");
    call(&ws, "hosts:save", renamed.clone()).await;
    assert_eq!(
        call(&ws, "hosts:reveal-password", host3["id"].clone()).await,
        "pilot-local-only"
    );
    let mut replace = renamed.clone();
    replace["localPassword"] = json!("new-local-only");
    call(&ws, "hosts:save", replace).await;
    assert_eq!(
        call(&ws, "hosts:reveal-password", host3["id"].clone()).await,
        "new-local-only"
    );
    let mut retarget = renamed;
    retarget["username"] = json!("other");
    call(&ws, "hosts:save", retarget).await;
    assert!(dispatch(&ws, "hosts:reveal-password", host3["id"].clone())
        .await
        .is_err());
    call(&ws, "hosts:save", host3.clone()).await;
    let password_tab = connect_tab(&ws, &mut rx, &host3, "pilot-local-only", false, true).await;
    let save = until(&mut rx, |e| {
        e["type"] == "password" && e["id"] == password_tab.to_string()
    })
    .await;
    assert_eq!(save["failed"], false, "{save}");
    let saved = connect_tab(&ws, &mut rx, &host3, "", true, false).await;
    call(&ws, "ssh:close", json!(saved)).await;
    call(&ws, "hosts:clear-password", host3["id"].clone()).await;
    assert_eq!(
        call(&ws, "hosts:has-password", host3["id"].clone()).await,
        false
    );

    let remote = format!(
        "ssh://{user}@127.0.0.1:{openssh_port}{}/repo.git",
        fixture.display()
    );
    let branch = "vault/test";
    let synced = call(
        &ws,
        "vault:sync",
        json!({"address": remote, "branch": branch}),
    )
    .await;
    assert_eq!(synced["state"]["remote"], remote);
    assert_eq!(synced["state"]["branch"], branch);
    assert!(synced["state"].get("syncKey").is_none());
    let (_other, other) = make_workspace(&fixture, None);
    let wrong_password = json!({"address":remote,"branch":branch,"secret":"wrong vault password"});
    assert!(dispatch(&other, "vault:restore-git", wrong_password)
        .await
        .unwrap_err()
        .contains("无法解锁"));
    call(
        &other,
        "vault:restore-git",
        json!({"address":remote,"branch":branch,"secret":"fixture passphrase 测试"}),
    )
    .await;
    let on_other = call(&other, "hosts:list", Value::Null).await;
    assert_eq!(on_other.as_array().unwrap().len(), 4);
    let mut ours = host1.clone();
    ours["note"] = json!("本机修改");
    call(&ws, "hosts:save", ours).await;
    let mut theirs = on_other
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["id"] == host1["id"])
        .unwrap()
        .clone();
    theirs["note"] = json!("仓库修改");
    call(&other, "hosts:save", theirs).await;
    call(&other, "vault:sync", json!({"address":remote})).await;
    let conflict = call(&ws, "vault:sync", json!({"address":remote})).await;
    assert_eq!(conflict["conflicts"][0]["id"], host1["id"]);
    let mut choices = serde_json::Map::new();
    choices.insert(host1["id"].as_str().unwrap().to_string(), json!("remote"));
    call(
        &ws,
        "vault:sync",
        json!({"address":remote,"ticket":conflict["ticket"],"choices":choices}),
    )
    .await;
    let resolved = call(&ws, "hosts:list", Value::Null).await;
    assert!(resolved
        .as_array()
        .unwrap()
        .iter()
        .any(|h| h["id"] == host1["id"] && h["note"] == "仓库修改"));
    let new_branch = "vault/renamed";
    let result = dispatch(&ws, "vault:sync", json!({"branch":new_branch})).await;
    assert!(result.unwrap_err().contains("目标分支"));
    let status = std::process::Command::new("/usr/bin/git")
        .arg("--git-dir")
        .arg(fixture.join("repo.git"))
        .args(["branch", "-m", branch, new_branch])
        .status()
        .unwrap();
    assert!(status.success());
    let switched = call(&ws, "vault:sync", json!({"branch":new_branch})).await;
    assert_eq!(switched["state"]["branch"], new_branch);
    assert_eq!(
        call(&other, "vault:sync", json!({"branch":new_branch})).await["state"]["branch"],
        new_branch
    );
    let port = std::fs::read_to_string(fixture.join("https-port")).unwrap();
    let https = format!("https://127.0.0.1:{port}/repo.git");
    let auth = json!({"username":"fixture","token":"test-repository-token"});
    let switched = call(
        &ws,
        "vault:sync",
        json!({
            "address":https,"changeConnection":true,"auth":auth
        }),
    )
    .await;
    assert_eq!(switched["state"]["remote"], https);
    assert!(switched["state"].get("auth").is_none());
    let mut modified = resolved
        .as_array()
        .unwrap()
        .iter()
        .find(|host| host["id"] == host1["id"])
        .unwrap()
        .clone();
    modified["note"] = json!("HTTPS 设备更新");
    call(&ws, "hosts:save", modified).await;
    call(&ws, "vault:sync", json!({})).await;
    call(&other, "vault:sync", json!({})).await;
    assert!(call(&other, "hosts:list", Value::Null)
        .await
        .as_array()
        .unwrap()
        .iter()
        .any(|host| host["id"] == host1["id"] && host["note"] == "HTTPS 设备更新"));

    let (_third, third) = make_workspace(&fixture, None);
    let mut request =
        json!({"address":https,"branch":new_branch,"secret":"fixture passphrase 测试","auth":auth});
    request["auth"]["token"] = json!("wrong-token");
    assert!(dispatch(&third, "vault:restore-git", request.clone())
        .await
        .is_err());
    request["auth"] = auth;
    assert_eq!(
        call(&third, "vault:restore-git", request).await["remote"],
        https
    );
    ws.connections.close_all();
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "requires an isolated localhost OpenSSH fixture and agent"]
async fn macos_migrates_legacy_git_snapshot_and_resumes_after_push() {
    use std::{os::unix::fs::PermissionsExt, process::Command};

    let fixture = PathBuf::from(std::env::var_os("TERMLUME_TEST_FIXTURE").unwrap());
    let user = std::env::var("USER").unwrap();
    let port = std::fs::read_to_string(fixture.join("openssh-port")).unwrap();
    let address = |repo: &str| {
        format!(
            "ssh://{user}@127.0.0.1:{}{}/{repo}",
            port.trim(),
            fixture.display()
        )
    };
    let old = address("legacy-migrate.git");
    let new = address("migrated.git");
    let old_ref = "refs/heads/termlume-vault";
    let branch = "vault/fresh";
    let new_ref = "refs/heads/vault/fresh";
    let password = "fixture passphrase 测试";
    let (profile, ws) = make_workspace(&fixture, None);
    call(
        &ws,
        "vault:restore-git",
        json!({"address":old,"secret":password}),
    )
    .await;
    let mut host = call(&ws, "hosts:list", Value::Null).await[0].clone();
    host["note"] = json!("本机的修改");
    call(&ws, "hosts:save", host.clone()).await;
    let added = call(
        &ws,
        "hosts:save",
        json!({
            "name":"本机新增", "address":"local-only.example.test",
            "username":"fixture", "port":22, "auth":"password"
        }),
    )
    .await
    .as_array()
    .unwrap()
    .last()
    .unwrap()
    .clone();

    let git = |repo: &str, args: &[&str]| {
        Command::new("/usr/bin/git")
            .arg("--git-dir")
            .arg(fixture.join(repo))
            .args(args)
            .output()
            .unwrap()
    };
    let ids: Value =
        serde_json::from_slice(&std::fs::read(fixture.join("legacy-migration-refs.json")).unwrap())
            .unwrap();
    let latest = ids["latest"].as_str().unwrap();
    let base = ids["base"].as_str().unwrap();
    assert!(
        git("legacy-migrate.git", &["update-ref", old_ref, latest, base])
            .status
            .success()
    );
    let occupied = dispatch(
        &ws,
        "vault:migrate-git",
        json!({
            "address":address("legacy-migrate.git/"), "branch":branch
        }),
    )
    .await
    .unwrap_err();
    assert!(occupied.contains("目标仓库必须为空"), "{occupied}");

    let migration = json!({"address":new,"branch":branch});
    let conflict = call(&ws, "vault:migrate-git", migration.clone()).await;
    assert_eq!(conflict["conflicts"][0]["id"], host["id"]);
    assert!(git("migrated.git", &["for-each-ref"]).stdout.is_empty());
    let mut request = migration;
    request["ticket"] = conflict["ticket"].clone();
    let mut choices = serde_json::Map::new();
    choices.insert(host["id"].as_str().unwrap().into(), json!("remote"));
    request["choices"] = Value::Object(choices);

    // Lock the local vault after receive-pack wrote the ref but before it returned.
    let hook = fixture.join("migrated.git/hooks/post-receive");
    std::fs::write(&hook, "#!/bin/sh\n: > migration-received\nsleep 4\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    let received = fixture.join("migrated.git/migration-received");
    let interrupt = async {
        tokio::time::timeout(Duration::from_secs(20), async {
            while !received.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("destination never received the new root");
        assert_eq!(call(&ws, "vault:lock", Value::Null).await["locked"], true);
    };
    let (attempt, ()) = tokio::join!(dispatch(&ws, "vault:migrate-git", request), interrupt);
    assert!(attempt.is_err());
    drop(ws);
    let ws = Workspace::new(profile.path().to_path_buf(), fixture.clone(), None).unwrap();
    let state = call(&ws, "vault:unlock", json!({"secret":password})).await;
    assert_eq!(state["remote"], old);
    assert_eq!(state["gitMigration"]["remote"], new);
    assert!(state["gitMigration"].get("syncKey").is_none());

    let resumed = call(&ws, "vault:migrate-git", json!({})).await;
    assert_eq!(resumed["state"]["remote"], new);
    assert_eq!(resumed["state"]["branch"], branch);
    assert!(resumed["state"]["gitMigration"].is_null());
    assert_eq!(
        git("migrated.git", &["rev-list", "--count", "--all"]).stdout,
        b"1\n"
    );
    assert!(!git("migrated.git", &["cat-file", "-e", latest])
        .status
        .success());
    assert_eq!(
        String::from_utf8_lossy(&git("legacy-migrate.git", &["rev-parse", old_ref]).stdout).trim(),
        latest
    );
    let commit = git("migrated.git", &["rev-list", "--parents", new_ref]);
    assert_eq!(
        String::from_utf8_lossy(&commit.stdout)
            .split_whitespace()
            .count(),
        1
    );

    let (_other, other) = make_workspace(&fixture, None);
    call(
        &other,
        "vault:restore-git",
        json!({"address":new,"branch":branch,"secret":password}),
    )
    .await;
    let hosts = call(&other, "hosts:list", Value::Null).await;
    let hosts = hosts.as_array().unwrap();
    assert!(hosts
        .iter()
        .any(|h| h["id"] == host["id"] && h["note"] == "旧仓库的更新"));
    assert!(hosts.iter().any(|h| h["id"] == added["id"]));

    let (_legacy, legacy) = make_workspace(&fixture, None);
    let mut restore = json!({"address":old,"branch":"legacy/protected","secret":password});
    assert!(dispatch(&legacy, "vault:restore-git", restore.clone())
        .await
        .unwrap_err()
        .contains("旧版同步密钥"));
    restore["syncKey"] = json!(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([23; 32]));
    call(&legacy, "vault:restore-git", restore.clone()).await;
    call(&legacy, "vault:sync", json!({})).await;
    restore.as_object_mut().unwrap().remove("syncKey");
    let (_updated, updated) = make_workspace(&fixture, None);
    call(&updated, "vault:restore-git", restore).await;
}

#[tokio::test]
async fn jump_routes_validate_references_and_survive_local_and_portable_data() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let legacy: Host = serde_json::from_value(json!({"address":"legacy.test"})).unwrap();
    assert!(legacy.jump_host_id.is_none());
    let jump = call(
        &ws,
        "hosts:save",
        json!({"address":"jump.test","port":22,"username":"ops","auth":"agent"}),
    )
    .await[0]
        .clone();
    let mut target = json!({"address":"target.test","port":22,"username":"ops","auth":"password","jumpHostId":jump["id"]});
    let host = call(&ws, "hosts:save", target.clone()).await[1].clone();
    target["id"] = host["id"].clone();
    for bad in [host["id"].clone(), json!(Uuid::new_v4())] {
        target["jumpHostId"] = bad;
        assert!(dispatch(&ws, "hosts:save", target.clone()).await.is_err());
    }
    let mut chain = jump.clone();
    chain["jumpHostId"] = host["id"].clone();
    assert!(dispatch(&ws, "hosts:save", chain).await.is_err());
    assert!(dispatch(&ws, "hosts:delete", jump["id"].clone())
        .await
        .is_err());
    assert!(dispatch(
        &ws,
        "ssh:connect",
        json!({"id":Uuid::new_v4(),"expected":host,"secret":"target"})
    )
    .await
    .is_err());
    {
        let data = ws.store.lock().unwrap().data().unwrap().clone();
        let rows = data.snapshot();
        assert!(serde_json::to_value(&rows)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == host["id"] && row["jumpHostId"] == jump["id"]));
        let recovery = vault::recovery_code();
        let (key, header) = vault::create("route test password", &recovery).unwrap();
        let encrypted = vault::encode(&key, &header, "portable", &rows).unwrap();
        let (_, decoded) = encrypted
            .unlock::<Vec<store::Row>>("route test password", false, "portable")
            .unwrap();
        assert!(decoded == rows);
    }
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(
        call(&ws, "hosts:list", Value::Null).await[1]["jumpHostId"],
        jump["id"]
    );
    // Sync can retain a deleted reference for repair; connection must fail closed.
    let mut data = ws.store.lock().unwrap().data().unwrap().clone();
    data.hosts
        .retain(|h| h.id.to_string() != jump["id"].as_str().unwrap());
    ws.store.lock().unwrap().update(data).unwrap();
    assert!(dispatch(&ws, "ssh:connect", json!({"id":Uuid::new_v4(),"expected":host,"secret":"target","jump":{"expected":jump,"secret":""}})).await.is_err());
}

#[tokio::test]
#[ignore = "requires isolated localhost jump and OpenSSH fixtures"]
async fn macos_jump_routes_gate_both_hosts_and_carry_all_channels() {
    let fixture = PathBuf::from(std::env::var("TERMLUME_TEST_FIXTURE").unwrap());
    let home = tempfile::tempdir().unwrap();
    let (_profile, ws) = make_workspace(home.path(), None);
    let jump_port: Value =
        serde_json::from_slice(&std::fs::read(fixture.join("jump-server.json")).unwrap()).unwrap();
    let password_port: Value =
        serde_json::from_slice(&std::fs::read(fixture.join("password-server.json")).unwrap())
            .unwrap();
    let target_port: u16 = std::fs::read_to_string(fixture.join("openssh-port"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let jump = call(&ws, "hosts:save", json!({"name":"fixture jump","address":"127.0.0.1","port":jump_port["port"],"username":"jump","auth":"password"})).await[0].clone();
    let target = call(&ws, "hosts:save", json!({"name":"private target","address":"target.internal.test","port":target_port,"username":std::env::var("USER").unwrap(),"auth":"agent","jumpHostId":jump["id"]})).await[1].clone();
    let mut rx = events(&ws);
    let canceled = Uuid::new_v4();
    call(&ws,"ssh:connect",json!({"id":canceled,"expected":target,"secret":"","jump":{"expected":jump,"secret":"jump-only-secret"}})).await;
    let pending = until(&mut rx, |e| {
        e["type"] == "trust" && e["id"] == canceled.to_string()
    })
    .await;
    call(
        &ws,
        "ssh:trust",
        json!({"id":canceled,"accepted":false,"challenge":pending["challenge"]}),
    )
    .await;
    assert_eq!(
        until(&mut rx, |e| e["type"] == "session"
            && e["id"] == canceled.to_string())
        .await["status"],
        "closed"
    );
    assert!(!fixture.join("jump-password-attempts").exists());
    let tab = Uuid::new_v4();
    call(&ws,"ssh:connect",json!({"id":tab,"expected":target,"secret":"","jump":{"expected":jump,"secret":"jump-only-secret","remember":true}})).await;
    let trust = until(&mut rx, |e| {
        e["type"] == "trust" && e["id"] == tab.to_string()
    })
    .await;
    assert_eq!(trust["stage"], "jump");
    let jump_challenge = trust["challenge"].clone();
    assert_eq!(trust["host"]["id"], jump["id"]);
    assert!(!fixture.join("jump-password-attempts").exists());
    call(
        &ws,
        "ssh:trust",
        json!({"id":tab,"accepted":true,"challenge":trust["challenge"]}),
    )
    .await;
    let trust = until(&mut rx, |e| {
        e["type"] == "trust" && e["id"] == tab.to_string()
    })
    .await;
    assert_eq!(trust["stage"], "target");
    call(
        &ws,
        "ssh:trust",
        json!({"id":tab,"accepted":true,"challenge":jump_challenge}),
    )
    .await;
    assert!(ws.connections.get(tab).unwrap().client.get().is_none());
    assert_eq!(trust["host"]["id"], target["id"]);
    call(
        &ws,
        "ssh:trust",
        json!({"id":tab,"accepted":true,"challenge":trust["challenge"]}),
    )
    .await;
    let ready = until(&mut rx, |e| {
        e["type"] == "session" && e["id"] == tab.to_string()
    })
    .await;
    assert_eq!(ready["status"], "ready", "{ready}");
    let saved_password = until(&mut rx, |e| {
        e["type"] == "password" && e["id"] == tab.to_string() && e["host"]["id"] == jump["id"]
    })
    .await;
    assert_eq!(saved_password["failed"], false, "{saved_password}");
    assert_eq!(
        call(&ws, "hosts:has-password", jump["id"].clone()).await,
        true
    );
    assert!(std::fs::read_to_string(fixture.join("jump-forwards"))
        .unwrap()
        .contains("target.internal.test:"));
    call(
        &ws,
        "ssh:input",
        json!({"id":tab,"data":"printf 'JUMP_%s\\n' 'TERMINAL'\r"}),
    )
    .await;
    let mut output = String::new();
    loop {
        let e = until(&mut rx, |e| {
            e["type"] == "output" && e["id"] == tab.to_string()
        })
        .await;
        output.push_str(&String::from_utf8_lossy(
            &STANDARD.decode(e["bytes"].as_str().unwrap()).unwrap(),
        ));
        if output.contains("JUMP_TERMINAL") {
            break;
        }
    }
    let remote = fixture.join("remote");
    let listing = call(&ws, "files:list", json!({"id":tab,"directory":remote})).await;
    assert!(listing["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["name"] == "sample log.txt"));
    let log = remote.join("sample log.txt");
    let command = Uuid::new_v4();
    call(
        &ws,
        "commands:start",
        json!({"id":command,"sessionId":tab,"request":{"action":"tail","argument":log,"lines":2}}),
    )
    .await;
    let out = until(&mut rx, |e| {
        e["type"] == "output" && e["id"] == command.to_string()
    })
    .await;
    assert!(
        String::from_utf8_lossy(&STANDARD.decode(out["bytes"].as_str().unwrap()).unwrap())
            .contains("日志回归")
    );
    let session = ws.connections.connected(tab).unwrap();
    let source = fixture.join("local/jump-input.bin");
    let downloaded = fixture.join("local/jump-output.bin");
    let remote_file = remote
        .join("jump-transfer.bin")
        .to_string_lossy()
        .to_string();
    let bytes = vec![73; 256 * 1024];
    std::fs::write(&source, &bytes).unwrap();
    for (up, local) in [(true, source), (false, downloaded.clone())] {
        let ticket = ws
            .transfers
            .stage(session.clone(), up, vec![(remote_file.clone(), local)])
            .await
            .unwrap();
        call(
            &ws,
            "files:enqueue",
            json!({"ticket":ticket["ticket"],"policy":"replace"}),
        )
        .await;
        let transfer = until(&mut rx, |e| {
            e["type"] == "transfer"
                && e["sessionId"] == tab.to_string()
                && matches!(e["status"].as_str(), Some("done" | "failed"))
        })
        .await;
        assert_eq!(transfer["status"], "done", "{transfer}");
    }
    assert_eq!(std::fs::read(downloaded).unwrap(), bytes);
    // Cancel the target's first trust prompt: no target password may be sent.
    let private_password = call(&ws,"hosts:save",json!({"address":"password.internal.test","port":password_port["port"],"username":"pilot","auth":"password","jumpHostId":jump["id"]})).await.as_array().unwrap().last().unwrap().clone();
    let rejected = Uuid::new_v4();
    let attempts = || {
        std::fs::read(fixture.join("password-attempts"))
            .unwrap_or_default()
            .len()
    };
    let before = attempts();
    call(&ws,"ssh:connect",json!({"id":rejected,"expected":private_password,"secret":"pilot-local-only","jump":{"expected":jump,"secret":"","useSaved":true}})).await;
    let trust = until(&mut rx, |e| {
        e["type"] == "trust" && e["id"] == rejected.to_string()
    })
    .await;
    assert_eq!(trust["stage"], "target");
    assert_eq!(attempts(), before);
    call(
        &ws,
        "ssh:trust",
        json!({"id":rejected,"accepted":false,"challenge":trust["challenge"]}),
    )
    .await;
    assert_eq!(
        until(&mut rx, |e| e["type"] == "session"
            && e["id"] == rejected.to_string())
        .await["status"],
        "closed"
    );
    assert_eq!(attempts(), before);
    // Target password auth (including a failure) remains independent of jump auth.
    let wrong = Uuid::new_v4();
    call(&ws,"ssh:connect",json!({"id":wrong,"expected":private_password,"secret":"wrong-target-password","jump":{"expected":jump,"secret":"","useSaved":true}})).await;
    let pending = until(&mut rx, |e| {
        e["type"] == "trust" && e["id"] == wrong.to_string()
    })
    .await;
    call(
        &ws,
        "ssh:trust",
        json!({"id":wrong,"accepted":true,"challenge":pending["challenge"]}),
    )
    .await;
    let failed = until(&mut rx, |e| {
        e["type"] == "session" && e["id"] == wrong.to_string()
    })
    .await;
    assert_eq!(failed["status"], "closed");
    assert!(failed["message"].as_str().unwrap().contains("目标主机"));
    let password_tab = Uuid::new_v4();
    call(&ws,"ssh:connect",json!({"id":password_tab,"expected":private_password,"secret":"pilot-local-only","jump":{"expected":jump,"secret":"","useSaved":true}})).await;
    let ready = until(&mut rx, |e| {
        e["type"] == "session" && e["id"] == password_tab.to_string()
    })
    .await;
    assert_eq!(ready["status"], "ready", "{ready}");
    call(&ws, "ssh:close", json!(password_tab)).await;
    let wrong_jump = Uuid::new_v4();
    let forwards_before = std::fs::read(fixture.join("jump-forwards")).unwrap().len();
    call(&ws,"ssh:connect",json!({"id":wrong_jump,"expected":target,"secret":"","jump":{"expected":jump,"secret":"wrong-jump-password"}})).await;
    let failed = until(&mut rx, |e| {
        e["type"] == "session" && e["id"] == wrong_jump.to_string()
    })
    .await;
    assert_eq!(failed["status"], "closed");
    assert!(failed["message"].as_str().unwrap().contains("跳板机"));
    assert_eq!(
        std::fs::read(fixture.join("jump-forwards")).unwrap().len(),
        forwards_before
    );
    // An encrypted private key also authenticates the target through the tunnel.
    let key_host = call(&ws,"hosts:save",json!({"address":"target.internal.test","port":target_port,"username":std::env::var("USER").unwrap(),"auth":"key","keyPath":fixture.join("client-rsa"),"jumpHostId":jump["id"]})).await.as_array().unwrap().last().unwrap().clone();
    let key_tab = Uuid::new_v4();
    call(&ws,"ssh:connect",json!({"id":key_tab,"expected":key_host,"secret":"fixture key passphrase","jump":{"expected":jump,"secret":"","useSaved":true}})).await;
    let ready = until(&mut rx, |e| {
        e["type"] == "session" && e["id"] == key_tab.to_string()
    })
    .await;
    assert_eq!(ready["status"], "ready", "{ready}");
    call(&ws, "ssh:close", json!(key_tab)).await;
    let blocked_host = call(&ws,"hosts:save",json!({"address":"blocked.internal.test","port":target_port,"username":"ops","auth":"agent","jumpHostId":jump["id"]})).await.as_array().unwrap().last().unwrap().clone();
    let blocked = Uuid::new_v4();
    call(&ws,"ssh:connect",json!({"id":blocked,"expected":blocked_host,"secret":"","jump":{"expected":jump,"secret":"","useSaved":true}})).await;
    let failed = until(&mut rx, |e| {
        e["type"] == "session" && e["id"] == blocked.to_string()
    })
    .await;
    assert_eq!(failed["status"], "closed");
    assert!(failed["message"]
        .as_str()
        .unwrap()
        .contains("跳板机无法连接目标"));
    // A changed jump fingerprint must block saved-password authentication.
    let before_jump = std::fs::read(fixture.join("jump-password-attempts"))
        .unwrap()
        .len();
    {
        let mut store = ws.store.lock().unwrap();
        let mut data = store.data().unwrap().clone();
        data.fingerprints
            .iter_mut()
            .find(|f| f.port == jump_port["port"].as_u64().unwrap() as u16)
            .unwrap()
            .fingerprint = format!("SHA256:{}", "A".repeat(43));
        store.update(data).unwrap();
    }
    let changed = Uuid::new_v4();
    call(&ws,"ssh:connect",json!({"id":changed,"expected":target,"secret":"","jump":{"expected":jump,"secret":"","useSaved":true}})).await;
    let failure = until(&mut rx, |e| {
        e["type"] == "session" && e["id"] == changed.to_string()
    })
    .await;
    assert_eq!(failure["status"], "closed");
    assert!(failure["message"].as_str().unwrap().contains("指纹已变化"));
    assert_eq!(
        std::fs::read(fixture.join("jump-password-attempts"))
            .unwrap()
            .len(),
        before_jump
    );
    // Transport loss closes the target and all its dependent channels.
    std::fs::write(fixture.join("jump-disconnect"), b"close").unwrap();
    assert_eq!(
        until(&mut rx, |e| e["type"] == "session"
            && e["id"] == tab.to_string())
        .await["status"],
        "closed"
    );
    assert!(ws.connections.connected(tab).is_err());
    assert!(
        dispatch(&ws, "files:list", json!({"id":tab,"directory":remote}))
            .await
            .is_err()
    );
    std::fs::remove_file(fixture.join("jump-disconnect")).unwrap();
    call(&ws, "hosts:clear-password", jump["id"].clone()).await;
    ws.connections.close_all();
}

#[tokio::test]
async fn local_forward_rules_validate_persist_and_compare_changes() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let host = call(
        &ws,
        "hosts:save",
        json!({"address":"forward.test","port":22,"username":"ops","auth":"agent"}),
    )
    .await[0]
        .clone();
    assert!(host.get("localForwards").is_none());
    let valid =
        json!({"name":"数据库","localPort":15432,"remoteAddress":"[::1]","remotePort":5432});
    for field in [
        json!({"localPort":0}),
        json!({"remotePort":65536}),
        json!({"remoteAddress":"user@service"}),
        json!({"remoteAddress":"[]"}),
        json!({"name":""}),
    ] {
        let mut bad = valid.clone();
        for (k, v) in field.as_object().unwrap() {
            bad[k] = v.clone();
        }
        assert!(dispatch(
            &ws,
            "forwards:save",
            json!({"hostId":host["id"],"rule":bad})
        )
        .await
        .is_err());
    }
    let saved = call(
        &ws,
        "forwards:save",
        json!({"hostId":host["id"],"rule":valid}),
    )
    .await[0]
        .clone();
    let rule = saved["localForwards"][0].clone();
    let mut renamed = host.clone();
    renamed["name"] = json!("renamed host");
    let preserved = call(&ws, "hosts:save", renamed).await;
    assert_eq!(preserved[0]["localForwards"][0], rule);
    assert_eq!(rule["remoteAddress"], "::1");
    assert!(dispatch(
        &ws,
        "forwards:save",
        json!({"hostId":host["id"],"rule":valid})
    )
    .await
    .is_err());
    let mut edited = rule.clone();
    edited["name"] = json!("主库");
    assert!(dispatch(
        &ws,
        "forwards:save",
        json!({"hostId":host["id"],"rule":edited})
    )
    .await
    .is_err());
    call(
        &ws,
        "forwards:save",
        json!({"hostId":host["id"],"rule":edited,"expected":rule}),
    )
    .await;
    assert!(dispatch(
        &ws,
        "forwards:delete",
        json!({"hostId":host["id"],"rule":rule,"expected":rule})
    )
    .await
    .is_err());
    let data = ws.store.lock().unwrap().data().unwrap().clone();
    let rows = data.snapshot();
    assert_eq!(json!(rows)[0]["localForwards"][0], edited);
    let recovery = vault::recovery_code();
    let (key, header) = vault::create("forward fixture password", &recovery).unwrap();
    let envelope = vault::encode(&key, &header, "portable", &rows).unwrap();
    let (_, decoded) = envelope
        .unlock::<Vec<store::Row>>("forward fixture password", false, "portable")
        .unwrap();
    assert!(rows == decoded);
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(
        call(&ws, "hosts:list", Value::Null).await[0]["localForwards"][0],
        edited
    );
    call(
        &ws,
        "forwards:delete",
        json!({"hostId":host["id"],"rule":edited,"expected":edited}),
    )
    .await;
    assert!(call(&ws, "hosts:list", Value::Null).await[0]
        .get("localForwards")
        .is_none());
}

#[tokio::test]
#[ignore = "requires isolated localhost SSH, jump, and TCP echo fixtures"]
async fn macos_local_forward_relays_and_releases_resources() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };
    async fn free_port() -> u16 {
        TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }
    async fn echo(port: u16, bytes: Vec<u8>) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (mut read, mut write) = stream.split();
        let expected = bytes.clone();
        let send = async {
            write.write_all(&bytes).await.unwrap();
            write.shutdown().await.unwrap();
        };
        let receive = async {
            let mut data = Vec::new();
            read.read_to_end(&mut data).await.unwrap();
            assert_eq!(data, expected);
        };
        tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(send, receive);
        })
        .await
        .unwrap();
    }
    let fixture = PathBuf::from(std::env::var("TERMLUME_TEST_FIXTURE").unwrap());
    let home = tempfile::tempdir().unwrap();
    let (_profile, ws) = make_workspace(home.path(), None);
    let ssh_port: u16 = std::fs::read_to_string(fixture.join("openssh-port"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let echo_port: u16 = std::fs::read_to_string(fixture.join("echo-port"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let jump_port: Value =
        serde_json::from_slice(&std::fs::read(fixture.join("jump-server.json")).unwrap()).unwrap();
    let jump = call(
        &ws,
        "hosts:save",
        json!({"address":"127.0.0.1","port":jump_port["port"],"username":"jump","auth":"password"}),
    )
    .await[0]
        .clone();
    let mut rx = events(&ws);
    for routed in [false, true] {
        let mut draft = json!({"address":if routed {"target.internal.test"} else {"127.0.0.1"},"port":ssh_port,"username":std::env::var("USER").unwrap(),"auth":"agent"});
        if routed {
            draft["jumpHostId"] = jump["id"].clone();
        }
        let host = call(&ws, "hosts:save", draft)
            .await
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .clone();
        let tab = if !routed {
            connect_tab(&ws, &mut rx, &host, "", false, false).await
        } else {
            let tab = Uuid::new_v4();
            call(&ws,"ssh:connect",json!({"id":tab,"expected":host,"secret":"","jump":{"expected":jump,"secret":"jump-only-secret"}})).await;
            loop {
                let event = until(&mut rx, |e| {
                    e["id"] == tab.to_string()
                        && matches!(e["type"].as_str(), Some("trust" | "session"))
                })
                .await;
                if event["type"] == "trust" {
                    call(
                        &ws,
                        "ssh:trust",
                        json!({"id":tab,"accepted":true,"challenge":event["challenge"]}),
                    )
                    .await;
                } else {
                    assert_eq!(event["status"], "ready", "{event}");
                    break;
                }
            }
            tab
        };
        let port = free_port().await;
        let rules = call(&ws,"forwards:save",json!({"hostId":host["id"],"rule":{"name":"echo","localPort":port,"remoteAddress":"127.0.0.1","remotePort":echo_port}})).await;
        let rule = rules
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["id"] == host["id"])
            .unwrap()["localForwards"][0]
            .clone();
        let request = json!({"sessionId":tab,"ruleId":rule["id"],"expected":rule});
        let occupied = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        assert!(dispatch(&ws, "forwards:start", request.clone())
            .await
            .unwrap_err()
            .contains("无法监听"));
        drop(occupied);
        let run = call(&ws, "forwards:start", request.clone()).await;
        assert_eq!(run["status"], "running");
        assert!(dispatch(&ws, "forwards:start", request.clone())
            .await
            .is_err());
        assert!(dispatch(
            &ws,
            "forwards:delete",
            json!({"hostId":host["id"],"rule":rule,"expected":rule})
        )
        .await
        .is_err());
        let bytes: Vec<_> = (0..1024 * 1024).map(|i| (i % 251) as u8).collect();
        tokio::join!(echo(port, bytes.clone()), echo(port, bytes));
        // Stop closes established sockets, then the same port is immediately reusable.
        let mut held = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        held.write_all(b"held").await.unwrap();
        let mut response = [0; 4];
        held.read_exact(&mut response).await.unwrap();
        call(&ws, "forwards:stop", run["id"].clone()).await;
        let mut byte = [0];
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), held.read(&mut byte)).await,
            Ok(Ok(0)) | Ok(Err(_))
        ));
        let bind = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        drop(bind);
        // A target-channel failure is reported without closing the SSH session or listener.
        let unavailable = free_port().await;
        let mut broken = rule.clone();
        broken["remotePort"] = json!(unavailable);
        let changed = call(
            &ws,
            "forwards:save",
            json!({"hostId":host["id"],"rule":broken,"expected":rule}),
        )
        .await;
        let broken = changed
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["id"] == host["id"])
            .unwrap()["localForwards"][0]
            .clone();
        let run = call(
            &ws,
            "forwards:start",
            json!({"sessionId":tab,"ruleId":rule["id"],"expected":broken}),
        )
        .await;
        let _connection = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let failed = until(&mut rx, |e| {
            e["type"] == "forward"
                && e["id"] == run["id"]
                && e["error"].as_str().is_some_and(|s| !s.is_empty())
        })
        .await;
        assert_eq!(failed["status"], "running");
        assert!(ws.connections.connected(tab).is_ok());
        call(&ws, "forwards:stop", run["id"].clone()).await;
        call(
            &ws,
            "forwards:save",
            json!({"hostId":host["id"],"rule":rule,"expected":broken}),
        )
        .await;
        if !routed {
            let locking = call(&ws, "forwards:start", request.clone()).await;
            call(
                &ws,
                "vault:enable",
                json!({"password":"forward vault password","recovery":vault::recovery_code()}),
            )
            .await;
            call(&ws, "vault:lock", Value::Null).await;
            until(&mut rx, |e| {
                e["type"] == "forward" && e["id"] == locking["id"] && e["status"] == "stopped"
            })
            .await;
            assert!(ws.connections.connected(tab).is_ok());
            assert!(dispatch(&ws, "forwards:start", request.clone())
                .await
                .is_err());
            call(
                &ws,
                "vault:unlock",
                json!({"secret":"forward vault password"}),
            )
            .await;
            assert_eq!(call(&ws, "forwards:list", Value::Null).await, json!([]));
        }
        let restarted = call(&ws, "forwards:start", request.clone()).await;
        if routed {
            std::fs::write(fixture.join("jump-disconnect"), b"close").unwrap();
        } else {
            call(&ws, "ssh:close", json!(tab)).await;
        }
        until(&mut rx, |e| {
            e["type"] == "forward" && e["id"] == restarted["id"] && e["status"] == "stopped"
        })
        .await;
        let bind = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        drop(bind);
        assert!(dispatch(&ws, "forwards:start", request.clone())
            .await
            .is_err());
        if routed {
            std::fs::remove_file(fixture.join("jump-disconnect")).unwrap();
        }
    }
    assert_eq!(call(&ws, "forwards:list", Value::Null).await, json!([]));
    ws.connections.close_all();
}
