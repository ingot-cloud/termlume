use super::*;
use tauri::ipc::InvokeResponseBody;
use tokio::sync::mpsc;

#[tokio::test]
async fn sftp_places_are_local_to_each_host_and_survive_restart() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    for name in ["first.test", "second.test"] {
        call(&ws, "hosts:save", json!({"address":name,"username":"ops","auth":"agent"})).await;
    }
    let (first, second) = {
        let mut store = ws.store.lock().unwrap();
        let mut data = store.data().unwrap().clone();
        let (first, second) = (data.hosts[0].id, data.hosts[1].id);
        let places = data.directory_places.entry(first).or_default();
        for i in 0..14 { places.change("visit", format!("/dir/{i}")).unwrap(); }
        places.change("visit", "/dir/5".into()).unwrap();
        places.change("pin", "/pinned-dir".into()).unwrap();
        assert!(!places.change("pin", "/pinned-dir".into()).unwrap());
        assert_eq!(places.recent.len(), 12);
        assert_eq!(places.recent[0], "/dir/5");
        data.directory_places.entry(second).or_default().change("pin", "/another-dir".into()).unwrap();
        assert!(!serde_json::to_string(&data.snapshot()).unwrap().contains("/pinned-dir"));
        store.update(data).unwrap();
        (first, second)
    };
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    let store = ws.store.lock().unwrap();
    let places = &store.data().unwrap().directory_places;
    assert_eq!(places[&first].favorites, ["/pinned-dir"]);
    assert_eq!(places[&second].favorites, ["/another-dir"]);
    assert!(places[&second].recent.is_empty());
}

#[test]
#[cfg(any(target_os = "macos", windows))]
fn reveal_uses_completed_download_destination_from_saved_history() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let path = home.path().join("配置文件 (2).json");
    let ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    {
        let mut store = ws.store.lock().unwrap();
        let mut data = store.data().unwrap().clone();
        data.transfer_history = vec![
            json!({"id":ids[0],"direction":"down","status":"done","local":path}),
            json!({"id":ids[1],"direction":"up","status":"done","local":path}),
            json!({"id":ids[2],"direction":"down","status":"failed","local":path}),
        ];
        store.update(data).unwrap();
    }
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(ws.transfers.download_location(&ws, ids[0]).unwrap(), path);
    assert_eq!(platform::reveal_download(&path).unwrap_err(), "本机文件已移动或删除。");
    for id in [ids[1], ids[2], Uuid::new_v4()] {
        assert!(ws.transfers.download_location(&ws, id).is_err());
    }
    for id in ids {
        assert_eq!(ws.transfers.record_for_location(&ws, id).unwrap()["local"], json!(path));
    }
    assert!(ws.transfers.record_for_location(&ws, Uuid::new_v4()).is_err());
    assert_eq!(platform::transfer_location(&path).unwrap(), (home.path(), false));
    std::fs::write(&path, b"test").unwrap();
    assert_eq!(platform::transfer_location(&path).unwrap(), (path.as_path(), true));
    assert!(platform::transfer_location(&home.path().join("missing/file")).is_err());
    assert!(platform::transfer_location(std::path::Path::new("relative")).is_err());
}

#[tokio::test]
async fn master_password_changes_preserve_data_recovery_and_automatic_unlock() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let password = "  主密码 test 🌸  ";
    let next = " 新主密码 rose 🌷 ";
    let recovery = vault::recovery_code();
    let host = call(&ws, "hosts:save", json!({"address":"password-change.test","username":"ops","auth":"password","localPassword":"preserved secret"})).await[0].clone();
    call(&ws, "vault:enable", json!({"password":password,"recovery":recovery})).await;
    // Reproduce the complete set → immediate lock → password unlock path.
    call(&ws, "vault:lock", Value::Null).await;
    call(&ws, "vault:unlock", json!({"secret":password})).await;
    call(&ws, "vault:set-startup-unlock", json!(false)).await;
    let before = std::fs::read(profile.path().join("workspace.json")).unwrap();
    assert!(dispatch(&ws, "vault:change-password", json!({"secret":"wrong","password":next})).await.is_err());
    assert!(dispatch(&ws, "vault:change-password", json!({"secret":password,"password":"short"})).await.is_err());
    assert_eq!(before, std::fs::read(profile.path().join("workspace.json")).unwrap());
    let old = ws.store.lock().unwrap().envelope.clone().unwrap();
    let old_key = ws.store.lock().unwrap().key.clone().unwrap();
    call(&ws, "vault:change-password", json!({"secret":password,"password":next})).await;
    {
        let store = ws.store.lock().unwrap();
        let envelope = store.envelope.as_ref().unwrap();
        assert_eq!(envelope.header.id, old.header.id);
        assert_eq!(store.key.as_ref().unwrap(), &old_key);
        assert_eq!(store.status()["startupUnlockRequired"], false);
        let bytes = serde_json::to_value(envelope).unwrap();
        let prior = serde_json::to_value(&old).unwrap();
        assert_eq!(bytes["header"]["recovery"], prior["header"]["recovery"]);
        assert!(envelope.unlock::<Data>(password, false, "local").is_err());
        assert!(envelope.unlock::<Data>(next, false, "local").is_ok());
        assert!(envelope.unlock::<Data>(&recovery, true, "local").is_ok());
    }
    // Restart with automatic unlock; local credentials and host bindings survive.
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "hosts:reveal-password", host["id"].clone()).await, "preserved secret");
    call(&ws, "vault:lock", Value::Null).await;
    assert!(dispatch(&ws, "vault:unlock", json!({"secret":password})).await.is_err());
    call(&ws, "vault:unlock", json!({"secret":next})).await;
    call(&ws, "vault:change-password", json!({"secret":recovery,"useRecovery":true,"password":password})).await;
    call(&ws, "vault:lock", Value::Null).await;
    call(&ws, "vault:unlock", json!({"secret":password})).await;
    assert_eq!(call(&ws, "hosts:reveal-password", host["id"].clone()).await, "preserved secret");
    // A previously exported backup still accepts its original password.
    assert!(old.unlock::<Data>(password, false, "local").is_ok());
}

#[tokio::test]
async fn failed_master_password_change_keeps_the_original_envelope() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    call(&ws, "vault:enable", json!({"password":"original password","recovery":vault::recovery_code()})).await;
    let file = profile.path().join("workspace.json");
    let saved = profile.path().join("saved-workspace");
    std::fs::rename(&file, &saved).unwrap();
    std::fs::create_dir(&file).unwrap();
    assert!(dispatch(&ws, "vault:change-password", json!({"secret":"original password","password":"replacement password"})).await.is_err());
    assert!(ws.store.lock().unwrap().envelope.as_ref().unwrap().unlock::<Data>("original password", false, "local").is_ok());
    std::fs::remove_dir(file).unwrap();
    std::fs::rename(saved, profile.path().join("workspace.json")).unwrap();
}

#[tokio::test]
async fn app_credentials_persist_without_a_master_password_and_stay_out_of_snapshots() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let secret = "app-local-password-测试";
    let host = call(&ws, "hosts:save", json!({"address":"app-password.test","username":"ops","auth":"password","localPassword":secret})).await[0].clone();
    let host_id = id(&host["id"]).unwrap();
    assert_eq!(call(&ws, "hosts:reveal-password", json!(host_id)).await, secret);
    let identity = call(&ws, "identities:save", json!({"identity":{"name":"local identity","username":"ops","auth":"password"},"localPassword":"identity-local-secret"})).await;
    assert!(identity["identityId"].is_string());
    let key_path = home.path().join("test-key");
    std::fs::write(&key_path, "fixture").unwrap();
    call(&ws, "hosts:save", json!({"address":"app-key.test","username":"ops","auth":"key","keyPath":key_path,"localKeyPassphrase":"key-local-secret"})).await;
    {
        let store = ws.store.lock().unwrap();
        let data = store.data().unwrap();
        assert_eq!(data.local_secrets.len(), 3);
        let snapshot = serde_json::to_string(&data.snapshot()).unwrap();
        for text in [secret, "identity-local-secret", "key-local-secret", "localSecrets"] {
            assert!(!snapshot.contains(text));
        }
        assert!(!store.status()["enabled"].as_bool().unwrap());
    }
    let raw = std::fs::read_to_string(profile.path().join("workspace.json")).unwrap();
    for text in [secret, "identity-local-secret", "key-local-secret", "app-password.test"] {
        assert!(!raw.contains(text));
    }
    assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["format"], "termlume-local-workspace");
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "hosts:reveal-password", json!(host_id)).await, secret);
    let mut renamed = host;
    renamed["name"] = json!("renamed");
    call(&ws, "hosts:save", renamed.clone()).await;
    assert_eq!(call(&ws, "hosts:reveal-password", json!(host_id)).await, secret);
    renamed["localPassword"] = json!("replacement-local-secret");
    call(&ws, "hosts:save", renamed.clone()).await;
    assert_eq!(ws.store.lock().unwrap().data().unwrap().local_secrets.len(), 3);
    renamed["address"] = json!("other.test");
    renamed.as_object_mut().unwrap().remove("localPassword");
    call(&ws, "hosts:save", renamed).await;
    assert_eq!(call(&ws, "hosts:has-password", json!(host_id)).await, false);
    assert_eq!(ws.store.lock().unwrap().data().unwrap().local_secrets.len(), 2);
}

#[tokio::test]
async fn local_credentials_follow_vault_locking_and_survive_disabling_master_protection() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let host = call(&ws, "hosts:save", json!({"address":"vault-password.test","username":"ops","auth":"password","localPassword":"local-vault-secret"})).await[0].clone();
    call(&ws, "vault:enable", json!({"password":"fixture master password","recovery":vault::recovery_code()})).await;
    call(&ws, "vault:lock", Value::Null).await;
    assert!(dispatch(&ws, "hosts:reveal-password", host["id"].clone()).await.is_err());
    let raw = std::fs::read(profile.path().join("workspace.json")).unwrap();
    let bytes = std::fs::read(profile.path().join("workspace.key")).unwrap();
    let mut device_key = vault::Key::default();
    device_key.copy_from_slice(&bytes);
    assert!(vault::decode_local::<Data>(&device_key, &raw).is_err());
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    call(&ws, "vault:unlock", json!({"secret":"fixture master password"})).await;
    assert_eq!(call(&ws, "hosts:reveal-password", host["id"].clone()).await, "local-vault-secret");
    call(&ws, "vault:disable", json!({"secret":"fixture master password"})).await;
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "hosts:reveal-password", host["id"].clone()).await, "local-vault-secret");
    let raw = std::fs::read_to_string(profile.path().join("workspace.json")).unwrap();
    assert!(!raw.contains("local-vault-secret"));
    assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["format"], "termlume-local-workspace");
}

#[test]
fn local_workspace_rejects_missing_wrong_keys_and_tampering_without_overwriting_data() {
    let profile = tempfile::tempdir().unwrap();
    let mut store = Store::open(profile.path(), None).unwrap();
    store.update(Data::default()).unwrap();
    drop(store);
    let path = profile.path().join("workspace.json");
    let key_path = profile.path().join("workspace.key");
    let raw = std::fs::read(&path).unwrap();
    let key = std::fs::read(&key_path).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o077, 0);
    }
    std::fs::remove_file(&key_path).unwrap();
    assert!(Store::open(profile.path(), None).is_err());
    assert!(!key_path.exists());
    assert_eq!(std::fs::read(&path).unwrap(), raw);
    std::fs::write(&key_path, [9; 32]).unwrap();
    assert!(Store::open(profile.path(), None).is_err());
    std::fs::write(&key_path, &key).unwrap();
    let mut tampered: Value = serde_json::from_slice(&raw).unwrap();
    let ciphertext = tampered["payload"]["ciphertext"].as_str().unwrap();
    let replacement = if ciphertext.starts_with('A') { "B" } else { "A" };
    tampered["payload"]["ciphertext"] = json!(format!("{replacement}{}", &ciphertext[1..]));
    std::fs::write(&path, serde_json::to_vec(&tampered).unwrap()).unwrap();
    assert!(Store::open(profile.path(), None).is_err());
    std::fs::write(&path, raw).unwrap();
    assert!(Store::open(profile.path(), None).is_ok());
}

#[test]
fn plaintext_workspaces_are_upgraded_and_unknown_formats_are_rejected() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join("workspace.json");
    let mut data = Data::default();
    data.hosts.push(Host { id: Uuid::new_v4(), address: "legacy-private.test".into(), ..Default::default() });
    std::fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let store = Store::open(profile.path(), None).unwrap();
    assert_eq!(store.data().unwrap().hosts[0].address, "legacy-private.test");
    assert!(!std::fs::read_to_string(&path).unwrap().contains("legacy-private.test"));
    drop(store);
    assert_eq!(Store::open(profile.path(), None).unwrap().data().unwrap().hosts.len(), 1);
    std::fs::write(&path, br#"{"format":"future-unsupported-format"}"#).unwrap();
    assert!(Store::open(profile.path(), None).is_err());
}

#[tokio::test]
async fn failed_credential_save_preserves_the_previous_password() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let mut host = call(&ws, "hosts:save", json!({"address":"write-failure.test","username":"ops","auth":"password","localPassword":"old-local-secret"})).await[0].clone();
    let path = profile.path().join("workspace.json");
    let backup = profile.path().join("saved-workspace");
    std::fs::rename(&path, &backup).unwrap();
    std::fs::create_dir(&path).unwrap();
    host["localPassword"] = json!("failed-new-secret");
    assert!(dispatch(&ws, "hosts:save", host.clone()).await.is_err());
    assert_eq!(call(&ws, "hosts:reveal-password", host["id"].clone()).await, "old-local-secret");
    assert_eq!(ws.store.lock().unwrap().data().unwrap().local_secrets.len(), 1);
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&backup, &path).unwrap();
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "hosts:reveal-password", host["id"].clone()).await, "old-local-secret");
}

#[tokio::test]
async fn os_only_credentials_require_reentry_without_changing_the_workspace() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let host = call(&ws, "hosts:save", json!({"address":"old-password.test","username":"ops","auth":"password"})).await[0].clone();
    let host_id = id(&host["id"]).unwrap();
    let token = Uuid::new_v4();
    {
        let mut store = ws.store.lock().unwrap();
        let mut data = store.data().unwrap().clone();
        data.local_passwords.insert(host_id, LocalPassword::Saved { token, fingerprint: None });
        store.update(data).unwrap();
    }
    let path = profile.path().join("workspace.json");
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(call(&ws, "hosts:has-password", json!(host_id)).await, false);
    assert!(ws.store.lock().unwrap().read_secret(token).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert!(ws.store.lock().unwrap().data().unwrap().local_secrets.is_empty());
    let mut updated = host;
    updated["localPassword"] = json!("replacement-app-password");
    call(&ws, "hosts:save", updated).await;
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "hosts:reveal-password", json!(host_id)).await, "replacement-app-password");
    assert!(!ws.store.lock().unwrap().data().unwrap().local_secrets.contains_key(&token));
}

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

#[test]
#[cfg(unix)]
fn closing_workspace_releases_its_lock_while_a_child_is_waiting_to_exec() {
    use std::{io::{Read, Write}, os::unix::{net::UnixStream, process::CommandExt}};
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    assert!(Workspace::new(profile.path().into(), home.path().into(), None).is_err());
    let (mut ready, mut child_ready) = UnixStream::pair().unwrap();
    let (mut release, mut child_release) = UnixStream::pair().unwrap();
    ready.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    child_release.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let child = std::thread::spawn(move || {
        let mut command = std::process::Command::new("/usr/bin/true");
        // Only socket reads/writes run after fork; no allocation, locks, or workspace access.
        unsafe {
            command.pre_exec(move || {
                child_ready.write_all(b"1")?;
                child_release.read_exact(&mut [0])?;
                Ok(())
            });
        }
        command.status()
    });
    ready.read_exact(&mut [0]).unwrap();
    drop(ws);
    let reopened = Workspace::new(profile.path().into(), home.path().into(), None);
    release.write_all(b"1").unwrap();
    assert!(child.join().unwrap().unwrap().success());
    let reopened = reopened.unwrap();
    assert!(Workspace::new(profile.path().into(), home.path().into(), None).is_err());
    drop(reopened);
    Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
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
    let inactive_since = *ws.last_activity.lock().unwrap();
    assert!(dispatch(&ws, "ssh:server-info", json!(Uuid::new_v4())).await.is_err());
    assert_eq!(*ws.last_activity.lock().unwrap(), inactive_since);
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

#[tokio::test]
async fn disabling_protection_requires_credentials_and_keeps_workspace() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let recovery = vault::recovery_code();
    let hosts = call(&ws, "hosts:save", json!({
        "name":"test host","address":"example.test","username":"ops","port":22,"auth":"agent"
    })).await;
    call(&ws, "vault:enable", json!({"password":"fixture password","recovery":recovery})).await;
    assert!(dispatch(&ws, "vault:disable", json!({"secret":"wrong password"})).await.is_err());
    assert_eq!(call(&ws, "vault:state", Value::Null).await["enabled"], true);
    let state = call(&ws, "vault:disable", json!({"secret":recovery,"useRecovery":true})).await;
    assert_eq!(state["enabled"], false);
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "hosts:list", Value::Null).await, hosts);
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "requires the isolated HTTPS Git fixture"]
async fn git_pull_only_and_automatic_sync_respect_local_changes_and_conflicts() {
    let fixture = PathBuf::from(std::env::var_os("TERMLUME_TEST_FIXTURE").unwrap());
    let port = std::fs::read_to_string(fixture.join("https-port")).unwrap();
    let remote = format!("https://127.0.0.1:{port}/repo.git");
    let auth = json!({"username":"fixture","token":"test-repository-token"});
    let branch = "vault/auto-pull";
    let password = "fixture sync password";
    let (_profile, ws) = make_workspace(&fixture, None);
    let (_other_profile, other) = make_workspace(&fixture, None);
    let host = |name: &str| json!({"name":name,"address":"example.test","username":"ops","port":22,"auth":"agent"});
    let shared = call(&ws, "hosts:save", host("shared")).await[0].clone();
    call(&ws, "vault:enable", json!({"password":password,"recovery":vault::recovery_code()})).await;
    call(&ws, "vault:sync", json!({"address":remote,"branch":branch,"auth":auth})).await;
    call(&other, "vault:restore-git", json!({"address":remote,"branch":branch,"auth":auth,"secret":password})).await;
    call(&ws, "hosts:save", host("local change")).await;
    call(&other, "hosts:save", host("remote change")).await;
    call(&other, "vault:sync", json!({})).await;
    let pulled = call(&ws, "vault:sync", json!({"pullOnly":true})).await;
    assert_eq!(pulled["pending"], true);
    assert!(pulled["state"]["lastFetched"].is_u64());
    assert_eq!(call(&ws, "hosts:list", Value::Null).await.as_array().unwrap().len(), 3);
    call(&other, "vault:sync", json!({"pullOnly":true})).await;
    assert_eq!(call(&other, "hosts:list", Value::Null).await.as_array().unwrap().len(), 2);

    let state = call(&ws, "vault:set-git-settings", json!({"paused":true,"onUnlock":true})).await;
    assert_eq!(state["remote"], remote);
    assert!(dispatch(&ws, "vault:sync", json!({"pullOnly":true})).await.is_err());
    call(&ws, "vault:set-git-settings", json!({"onUnlock":true})).await;
    let mut rx = events(&ws);
    let worker = tokio::spawn(git_auto::run(ws.clone()));
    let result = until(&mut rx, |e| e["type"] == "git-auto").await;
    worker.abort();
    assert!(result["state"]["syncAttention"].is_null(), "{result}");
    call(&other, "vault:sync", json!({"pullOnly":true})).await;
    assert_eq!(call(&other, "hosts:list", Value::Null).await.as_array().unwrap().len(), 3);

    let mut ours = shared.clone();
    let mut theirs = shared.clone();
    ours["note"] = json!("local edit");
    theirs["note"] = json!("remote edit");
    call(&ws, "hosts:save", ours).await;
    call(&other, "hosts:save", theirs).await;
    call(&other, "vault:sync", json!({})).await;
    let (epoch, policy) = {
        let store = ws.store.lock().unwrap();
        (store.epoch, store.data().unwrap().git_settings)
    };
    assert!(git::synchronize_automatically(&ws, epoch, policy).await);
    assert!(until(&mut rx, |e| e["type"] == "git-auto").await["state"]["syncAttention"].is_string());
    assert!(!git::synchronize_automatically(&ws, epoch, policy).await);
    let conflict = call(&ws, "vault:sync", json!({"pullOnly":true})).await;
    assert_eq!(conflict["conflicts"][0]["id"], shared["id"]);
    let choices = HashMap::from([(shared["id"].as_str().unwrap(), "remote")]);
    let resolved = call(&ws, "vault:sync", json!({"pullOnly":true,"ticket":conflict["ticket"],"choices":choices})).await;
    assert_eq!(resolved["pending"], false);
    assert!(resolved["state"]["syncAttention"].is_null());
}

#[tokio::test]
async fn startup_unlock_preserves_encryption_and_is_local_to_the_workspace() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let password = "test1234";
    let recovery = vault::recovery_code();
    let hosts = call(&ws, "hosts:save", json!({"name":"private startup fixture","address":"private.example.test","username":"ops","auth":"agent"})).await;
    let state = call(&ws, "vault:enable", json!({"password":password,"recovery":recovery})).await;
    assert_eq!(state["startupUnlockSupported"], true);
    assert_eq!(state["startupUnlockRequired"], true);
    let original = std::fs::read(profile.path().join("workspace.json")).unwrap();
    let state = call(&ws, "vault:set-startup-unlock", json!(false)).await;
    assert_eq!(state["startupUnlockRequired"], false);
    let settings = profile.path().join("startup-unlock.json");
    let preferences = std::fs::read_to_string(&settings).unwrap();
    assert!(serde_json::from_str::<Value>(&preferences).unwrap()["protected"]["payload"]["ciphertext"].is_string());
    assert!(!preferences.contains(password));
    assert!(!preferences.contains("private startup fixture"));
    {
        use base64::Engine;
        let store = ws.store.lock().unwrap();
        assert!(!store.startup_unlock.as_ref().unwrap().is_legacy());
        assert!(!preferences.contains(&base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&**store.key.as_ref().unwrap())));
        let snapshot = serde_json::to_string(&store.data().unwrap().snapshot()).unwrap();
        assert!(!snapshot.contains("startupUnlock") && !snapshot.contains("protected"));
    }
    assert_eq!(std::fs::read(profile.path().join("workspace.json")).unwrap(), original);
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "vault:state", Value::Null).await["locked"], false);
    assert_eq!(call(&ws, "hosts:list", Value::Null).await, hosts);
    *ws.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(3600);
    assert_eq!(ws.lock(true)["locked"], false);
    call(&ws, "vault:lock", Value::Null).await;
    assert!(dispatch(&ws, "vault:set-startup-unlock", json!(true)).await.is_err());
    let copied = tempfile::tempdir().unwrap();
    for name in ["workspace.json", "startup-unlock.json", "workspace.key"] {
        std::fs::copy(profile.path().join(name), copied.path().join(name)).unwrap();
    }
    let other = Workspace::new(copied.path().into(), home.path().into(), None).unwrap();
    let state = call(&other, "vault:state", Value::Null).await;
    assert_eq!(state["locked"], true);
    assert!(state["startupUnlockError"].is_string());
    drop(ws);
    let mut damaged: Value = serde_json::from_str(&preferences).unwrap();
    damaged["protected"]["payload"]["ciphertext"] = json!("broken");
    std::fs::write(&settings, serde_json::to_vec(&damaged).unwrap()).unwrap();
    let before = std::fs::read(&settings).unwrap();
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    let state = call(&ws, "vault:state", Value::Null).await;
    assert_eq!(state["locked"], true);
    assert!(state["startupUnlockError"].is_string());
    assert!(dispatch(&ws, "vault:unlock", json!({"secret":"wrong password"})).await.is_err());
    assert_eq!(std::fs::read(&settings).unwrap(), before);
    let state = call(&ws, "vault:unlock", json!({"secret":password})).await;
    assert!(state["startupUnlockError"].is_null());
    assert_eq!(call(&ws, "hosts:list", Value::Null).await, hosts);
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "vault:state", Value::Null).await["locked"], false);
    let state = call(&ws, "vault:set-startup-unlock", json!(true)).await;
    assert_eq!(state["startupUnlockRequired"], true);
    assert!(!settings.exists());
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "vault:state", Value::Null).await["locked"], true);
    call(&ws, "vault:unlock", json!({"secret":recovery,"useRecovery":true})).await;
    call(&ws, "vault:set-startup-unlock", json!(false)).await;
    call(&ws, "vault:disable", json!({"secret":password})).await;
    assert!(!settings.exists());
    assert_eq!(call(&ws, "hosts:list", Value::Null).await, hosts);
}

#[tokio::test]
async fn missing_auto_unlock_device_key_requires_authentication_before_repair() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    call(&ws, "vault:enable", json!({"password":"fixture password","recovery":vault::recovery_code()})).await;
    call(&ws, "vault:set-startup-unlock", json!(false)).await;
    let path = profile.path().join("workspace.key");
    let old = std::fs::read(&path).unwrap();
    drop(ws);
    std::fs::remove_file(&path).unwrap();
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert!(!path.exists());
    let state = call(&ws, "vault:state", Value::Null).await;
    assert_eq!(state["locked"], true);
    assert!(state["startupUnlockError"].is_string());
    assert!(dispatch(&ws, "vault:unlock", json!({"secret":"wrong password"})).await.is_err());
    assert!(!path.exists());
    let state = call(&ws, "vault:unlock", json!({"secret":"fixture password"})).await;
    assert!(state["startupUnlockError"].is_null());
    assert_ne!(std::fs::read(&path).unwrap(), old);
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "vault:state", Value::Null).await["locked"], false);
}

#[tokio::test]
async fn failed_auto_unlock_setting_writes_preserve_the_previous_policy() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    call(&ws, "vault:enable", json!({"password":"fixture password","recovery":vault::recovery_code()})).await;
    let path = profile.path().join("startup-unlock.json");
    std::fs::create_dir(&path).unwrap();
    assert!(dispatch(&ws, "vault:set-startup-unlock", json!(false)).await.is_err());
    assert_eq!(call(&ws, "vault:state", Value::Null).await["startupUnlockRequired"], true);
    std::fs::remove_dir(&path).unwrap();
    call(&ws, "vault:set-startup-unlock", json!(false)).await;
    let backup = profile.path().join("saved-auto-unlock");
    std::fs::rename(&path, &backup).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(dispatch(&ws, "vault:set-startup-unlock", json!(true)).await.is_err());
    assert_eq!(call(&ws, "vault:state", Value::Null).await["startupUnlockRequired"], false);
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&backup, &path).unwrap();
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "vault:state", Value::Null).await["locked"], false);
}

#[tokio::test]
async fn legacy_auto_unlock_without_keychain_can_migrate_after_master_password_unlock() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    call(&ws, "vault:enable", json!({"password":"fixture password","recovery":vault::recovery_code()})).await;
    {
        let mut store = ws.store.lock().unwrap();
        let credential = startup_unlock::Credential::new(store.envelope.as_ref().unwrap().header.id);
        store.set_startup_unlock(Some(credential)).unwrap();
    }
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "vault:state", Value::Null).await["locked"], true);
    let state = call(&ws, "vault:unlock", json!({"secret":"fixture password"})).await;
    assert!(state["startupUnlockError"].is_null());
    assert!(!ws.store.lock().unwrap().startup_unlock.as_ref().unwrap().is_legacy());
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "vault:state", Value::Null).await["locked"], false);
}

#[test]
fn failed_legacy_auto_unlock_conversion_preserves_settings_for_manual_retry() {
    let profile = tempfile::tempdir().unwrap();
    let mut store = Store::open(profile.path(), None).unwrap();
    let (key, header) = vault::create("fixture password", &vault::recovery_code()).unwrap();
    store.install(key, &header, Data::default()).unwrap();
    store.set_startup_unlock(Some(startup_unlock::Credential::new(header.id))).unwrap();
    let path = store.startup_unlock_path();
    let backup = profile.path().join("saved-auto-unlock");
    std::fs::rename(&path, &backup).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(store.enable_startup_unlock().is_err());
    assert!(store.startup_unlock.as_ref().unwrap().is_legacy());
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&backup, &path).unwrap();
    drop(store);
    let mut store = Store::open(profile.path(), None).unwrap();
    assert!(store.data.is_none());
    let envelope = store.envelope.as_ref().unwrap();
    let (key, data) = envelope.unlock::<Data>("fixture password", false, "local").unwrap();
    store.unlock(key, data);
    assert!(!store.startup_unlock.as_ref().unwrap().is_legacy());
    drop(store);
    assert!(Store::open(profile.path(), None).unwrap().data.is_some());
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
#[ignore = "requires the isolated OpenSSH fixture"]
async fn macos_host_key_passphrase_persists_connects_and_cleans_up() {
    let fixture = PathBuf::from(std::env::var("TERMLUME_TEST_FIXTURE").unwrap());
    let (profile, ws) = make_workspace(&fixture, None);
    let port: u16 = std::fs::read_to_string(fixture.join("openssh-port"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let secret = "fixture key passphrase";
    let mut host = call(&ws, "hosts:save", json!({"address":"127.0.0.1", "port":port, "username":std::env::var("USER").unwrap(), "auth":"key", "keyPath":fixture.join("client-rsa"), "localKeyPassphrase":secret})).await[0].clone();
    let host_id = id(&host["id"]).unwrap();
    assert_eq!(
        call(&ws, "hosts:has-key-passphrase", json!(host_id)).await,
        true
    );
    let token = {
        let store = ws.store.lock().unwrap();
        let data = store.data().unwrap();
        let rows = serde_json::to_string(&data.snapshot()).unwrap();
        assert!(!rows.contains(secret));
        assert!(!rows.contains("keyPassphrases"));
        data.key_passphrases[&host_id].token
    };
    assert_eq!(ws.store.lock().unwrap().read_secret(token).unwrap().as_str(), secret);
    assert!(
        !std::fs::read_to_string(profile.path().join("workspace.json"))
            .unwrap()
            .contains(secret)
    );
    host["name"] = json!("renamed key host");
    host = call(&ws, "hosts:save", host).await[0].clone();
    assert_eq!(
        ws.store.lock().unwrap().data().unwrap().key_passphrases[&host_id].token,
        token
    );
    drop(ws);
    let ws = Workspace::new(profile.path().into(), fixture.clone(), None).unwrap();
    let mut rx = events(&ws);
    let tab = connect_tab(&ws, &mut rx, &host, "", false, false).await;
    call(&ws, "ssh:close", json!(tab)).await;

    host["localKeyPassphrase"] = json!(secret);
    host = call(&ws, "hosts:save", host).await[0].clone();
    assert!(ws.store.lock().unwrap().read_secret(token).is_err());
    let replaced = ws.store.lock().unwrap().data().unwrap().key_passphrases[&host_id].token;
    host["keyPath"] = json!(fixture.join("client"));
    host = call(&ws, "hosts:save", host).await[0].clone();
    assert_eq!(
        call(&ws, "hosts:has-key-passphrase", json!(host_id)).await,
        false
    );
    assert!(ws.store.lock().unwrap().read_secret(replaced).is_err());

    host["localKeyPassphrase"] = json!(secret);
    host = call(&ws, "hosts:save", host).await[0].clone();
    host["clearKeyPassphrase"] = json!(true);
    host = call(&ws, "hosts:save", host).await[0].clone();
    assert_eq!(
        call(&ws, "hosts:has-key-passphrase", json!(host_id)).await,
        false
    );
    host["localKeyPassphrase"] = json!(secret);
    call(&ws, "hosts:save", host).await;
    let last = ws.store.lock().unwrap().data().unwrap().key_passphrases[&host_id].token;
    call(&ws, "hosts:delete", json!(host_id)).await;
    assert!(ws.store.lock().unwrap().read_secret(last).is_err());
}

#[tokio::test]
#[cfg(unix)]
#[ignore = "requires an isolated SSH_AUTH_SOCK"]
async fn key_loading_into_agent_keeps_the_private_file_encrypted() {
    let directory = tempfile::tempdir().unwrap();
    let key = keys::generate(directory.path(), "fixture", "disposable passphrase", "ed25519", None).unwrap();
    let path = PathBuf::from(key["path"].as_str().unwrap());
    let original = std::fs::read(&path).unwrap();
    assert!(keys::read_private_key(&path, "incorrect").is_err());
    assert!(keys::read_private_key(&path.with_extension("pub"), "").is_err());
    let private = keys::read_private_key(&path, "disposable passphrase").unwrap();
    let added = keys::add_to_agent(&private).await.unwrap();
    assert_eq!(added["fingerprint"], key["fingerprint"]);
    let identities = keys::agent_keys().await;
    assert!(identities["keys"].as_array().unwrap().iter().any(|item| item["fingerprint"] == key["fingerprint"]));
    assert_eq!(std::fs::read(&path).unwrap(), original);
}

#[tokio::test]
async fn created_private_keys_validate_pairs_preserve_encryption_and_reject_overwrites() {
    let home = tempfile::tempdir().unwrap();
    let (_profile, ws) = make_workspace(home.path(), None);
    let original = call(&ws, "keys:generate", json!({"name":"source","passphrase":"fixture passphrase"})).await;
    let private = std::fs::read_to_string(original["path"].as_str().unwrap()).unwrap();
    let public = original["publicKey"].as_str().unwrap();
    let request = json!({"name":"imported","privateKey":private,"publicKey":public,"passphrase":"fixture passphrase"});
    let saved = call(&ws, "keys:create", request.clone()).await;
    assert_eq!(saved["fingerprint"], original["fingerprint"]);
    assert_eq!(saved["encrypted"], true);
    assert_eq!(std::fs::read_to_string(saved["path"].as_str().unwrap()).unwrap(), private);
    assert!(dispatch(&ws, "keys:create", request.clone()).await.is_err());
    assert_eq!(std::fs::read_to_string(saved["path"].as_str().unwrap()).unwrap(), private);
    let mut derived = request.clone(); derived["name"] = json!("derived"); derived["publicKey"] = json!("");
    assert_eq!(call(&ws, "keys:create", derived).await["fingerprint"], original["fingerprint"]);
    let other = call(&ws, "keys:generate", json!({"name":"other","passphrase":""})).await;
    for invalid in [
        json!({"name":"bad","privateKey":private,"publicKey":other["publicKey"],"passphrase":"fixture passphrase"}),
        json!({"name":"bad","privateKey":private,"passphrase":"wrong"}),
        json!({"name":"bad","privateKey":"invalid","passphrase":""}),
        json!({"name":"../escape","privateKey":private,"passphrase":"fixture passphrase"}),
        json!({"directory":"/not-approved","name":"bad","privateKey":private,"passphrase":"fixture passphrase"}),
    ] { assert!(dispatch(&ws, "keys:create", invalid).await.is_err()); }
    assert!(!home.path().join(".ssh/bad").exists());
    let public_path = home.path().join(".ssh/conflict.pub"); std::fs::write(&public_path, "preserved").unwrap();
    let mut conflict = request; conflict["name"] = json!("conflict");
    assert!(dispatch(&ws, "keys:create", conflict).await.is_err());
    assert!(!home.path().join(".ssh/conflict").exists());
    assert_eq!(std::fs::read_to_string(public_path).unwrap(), "preserved");
}

#[tokio::test]
async fn key_passphrase_reveal_requires_the_saved_host_key_binding() {
    let home = tempfile::tempdir().unwrap();
    let (_profile, ws) = make_workspace(home.path(), None);
    let mut host = json!({"name":"key reveal","address":"key.test","username":"ops","auth":"key","keyPath":home.path().join("one"),"localKeyPassphrase":"fixture secret"});
    let saved = call(&ws, "hosts:save", host.clone()).await[0].clone();
    let request = json!({"id":saved["id"],"keyPath":saved["keyPath"]});
    assert_eq!(call(&ws, "hosts:reveal-key-passphrase", request.clone()).await, "fixture secret");
    assert!(dispatch(&ws, "hosts:reveal-key-passphrase", json!({"id":saved["id"],"keyPath":home.path().join("wrong")})).await.is_err());
    host["id"] = saved["id"].clone();host["keyPath"] = json!(home.path().join("two"));host.as_object_mut().unwrap().remove("localKeyPassphrase");
    call(&ws, "hosts:save", host).await;
    assert!(dispatch(&ws, "hosts:reveal-key-passphrase", request).await.is_err());
    assert!(dispatch(&ws, "hosts:reveal-key-passphrase", json!({"id":saved["id"],"keyPath":home.path().join("two")})).await.is_err());
}

#[tokio::test]
async fn key_generation_validates_algorithms_and_preserves_existing_files() {
    let home = tempfile::tempdir().unwrap();
    let (_profile, ws) = make_workspace(home.path(), None);
    for (algorithm, bits, expected) in [
        ("ed25519", None, "ssh-ed25519"),
        ("rsa", Some(2048), "ssh-rsa"),
        ("rsa", Some(3072), "ssh-rsa"),
        ("rsa", Some(4096), "ssh-rsa"),
        ("ecdsa", Some(256), "ecdsa-sha2-nistp256"),
        ("ecdsa", Some(384), "ecdsa-sha2-nistp384"),
        ("ecdsa", Some(521), "ecdsa-sha2-nistp521"),
    ] {
        let name = format!("fixture-{algorithm}-{}", bits.unwrap_or(0));
        let mut request = json!({"name":name,"passphrase":"fixture passphrase","type":algorithm});
        if let Some(bits) = bits { request["bits"] = json!(bits); }
        let result = call(&ws, "keys:generate", request.clone()).await;
        let path = PathBuf::from(result["path"].as_str().unwrap());
        let contents = std::fs::read(&path).unwrap();
        let key = russh::keys::PrivateKey::from_openssh(&contents).unwrap().decrypt("fixture passphrase").unwrap();
        assert_eq!(key.algorithm().to_string(), expected);
        if algorithm == "rsa" {
            assert_eq!(key.public_key().key_data().rsa().unwrap().n().as_bytes().len(), bits.unwrap() as usize / 8 + 1);
        }
        assert_eq!(key.public_key().fingerprint(russh::keys::HashAlg::Sha256).to_string(), result["fingerprint"]);
        assert!(!result.as_object().unwrap().contains_key("privateKey"));
        assert!(dispatch(&ws, "keys:generate", request).await.is_err());
        assert_eq!(std::fs::read(path).unwrap(), contents);
    }
    for (algorithm, bits) in [("dsa", 1024), ("rsa", 1024), ("rsa", 8192), ("ecdsa", 3072), ("ed25519", 256)] {
        assert!(dispatch(&ws, "keys:generate", json!({"name":"invalid","passphrase":"","type":algorithm,"bits":bits})).await.is_err());
    }
    assert!(!home.path().join(".ssh/invalid").exists());
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
    let info = call(&ws, "ssh:server-info", json!(second)).await;
    let info = info.as_str().unwrap();
    assert!(info.contains("__TERMLUME_INFO__platform\nDarwin\n"));
    assert!(info.contains("__TERMLUME_INFO__architecture\narm64\n"));
    assert!(info.contains("__TERMLUME_INFO__disks\n"));
    assert!(info.contains("__TERMLUME_INFO__networkBefore\n"));
    assert!(info.contains("__TERMLUME_INFO__networkAfter\n"));
    assert!(info.contains("Ibytes"));
    assert!(info.contains("Obytes"));
    assert!(info.contains("__TERMLUME_INFO__diskIoBefore\n"));
    assert!(info.contains("__TERMLUME_INFO__diskIoAfter\n"));
    assert!(info.contains("\"Bytes (Read)\"="));
    assert!(info.contains("\"Bytes (Write)\"="));
    assert!(info.contains("\"Operations (Read)\"="));
    assert!(info.contains("\"Operations (Write)\"="));
    assert!(info.contains("\"Total Time (Read)\"="));
    assert!(info.contains("\"Total Time (Write)\"="));
    assert!(info.trim_end().ends_with("__TERMLUME_INFO__end\nok"));
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
        .join(format!("测试 中文'引号-{}.bin", Uuid::new_v4()));
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
    for record in records {
        let session = &record["sessionId"];
        assert!(record["route"]["target"]["fingerprint"].is_string());
        let location = call(&ws, "files:remote-location", json!({"id":session, "recordId":record["id"]})).await;
        assert_eq!(location["path"], record["remote"]);
        assert_eq!(location["route"], record["route"]);
    }
    let removed = call(&ws, "files:remove-history", result["id"].clone()).await;
    assert_eq!(removed, json!([result["id"]]));
    let cleared = call(&ws, "files:remove-history", Value::Null).await;
    assert_eq!(cleared.as_array().unwrap().len(), 5);
    assert!(downloaded.join("nested/with spaces.txt").is_file());
    assert!(output.is_file());
    let remaining = call(&ws, "files:history", Value::Null).await;
    assert!(remaining.as_array().unwrap().is_empty());
    let reopened = Store::open(profile.path(), None).unwrap();
    assert!(reopened.data().is_err());
    let persisted: Data = reopened
        .envelope
        .unwrap()
        .decode(ws.store.lock().unwrap().key.as_ref().unwrap(), "local")
        .unwrap();
    assert_eq!(json!(persisted.transfer_history), remaining);

    // Lose a source after confirming, then prepare again from the persisted record.
    let retry_source = remote_dir.join(&folder).join("retry.txt");
    let retry_local = fixture.join("local").join("retried.txt");
    std::fs::write(&retry_source, b"original").unwrap();
    let prepared = ws.transfers.stage(ws.connections.connected(second).unwrap(), false,
        vec![(retry_source.to_str().unwrap().into(), retry_local.clone())]).await.unwrap();
    std::fs::remove_file(&retry_source).unwrap();
    call(&ws, "files:enqueue", json!({"ticket":prepared["ticket"],"policy":"skip"})).await;
    let failed = until(&mut rx, |e| e["type"] == "transfer" && e["status"] == "failed").await;
    let retry = json!({"recordId":failed["id"],"id":second});
    {
        let mut store = ws.store.lock().unwrap();
        let mut data = store.data().unwrap().clone();
        let row = data.transfer_history.iter_mut().find(|r| r["id"] == failed["id"]).unwrap();
        row.as_object_mut().unwrap().remove("route");
        store.update(data).unwrap();
    }
    assert!(dispatch(&ws, "files:remote-location", retry.clone()).await.is_err());
    let mut confirm_host = retry.clone();
    confirm_host["legacyHost"] = host2["id"].clone();
    let first_location = call(&ws, "files:remote-location", confirm_host).await;
    assert_eq!(first_location["path"], failed["remote"]);
    assert_eq!(call(&ws, "files:remote-location", retry.clone()).await, first_location);
    assert!(dispatch(&ws, "files:prepare-retry", retry.clone()).await.is_err());
    std::fs::write(&retry_source, b"fresh").unwrap();
    std::fs::write(&retry_local, b"existing").unwrap();
    let prepared = call(&ws, "files:prepare-retry", retry.clone()).await;
    assert_eq!(prepared["files"][0]["exists"], true);
    call(&ws, "files:enqueue", json!({"ticket":prepared["ticket"],"policy":"keep"})).await;
    until(&mut rx, |e| e["type"] == "transfer" && e["status"] == "done").await;
    assert_eq!(std::fs::read(&retry_local).unwrap(), b"existing");
    assert_eq!(std::fs::read(retry_local.with_file_name("retried (2).txt")).unwrap(), b"fresh");
    {
        let mut store = ws.store.lock().unwrap();
        let mut data = store.data().unwrap().clone();
        let row = data.transfer_history.iter_mut().find(|r| r["id"] == failed["id"]).unwrap();
        row["route"]["target"]["fingerprint"] = json!("another fingerprint");
        store.update(data).unwrap();
    }
    assert!(dispatch(&ws, "files:remote-location", retry.clone()).await.unwrap_err().contains("指纹"));
    assert!(dispatch(&ws, "files:prepare-retry", retry).await.unwrap_err().contains("指纹"));

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
        .any(|row| row.password_saved()));
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

#[tokio::test]
async fn shared_identity_records_resolve_update_and_sync_without_local_keys() {
    let home = tempfile::tempdir().unwrap();
    let (_p, ws) = make_workspace(home.path(), None);
    let key_path = home.path().join("local identity 私钥");
    std::fs::write(&key_path, "fixture").unwrap();
    assert!(key_path.is_absolute());
    assert!(dispatch(
        &ws,
        "identities:save",
        json!({"identity":{"name":"相对路径","username":"ops","auth":"key","keyPath":"local-identity-key"}}),
    )
    .await
    .is_err());
    let added=call(&ws,"identities:save",json!({"identity":{"name":"运维身份","username":"ops","auth":"key","keyPath":key_path}})).await;
    let identity = added["identities"][0].clone();
    let id = identity["id"].clone();
    for address in ["one.test", "two.test"] {
        call(
            &ws,
            "hosts:save",
            json!({"address":address,"port":22,"identityId":id}),
        )
        .await;
    }
    let hosts = call(&ws, "hosts:list", Value::Null).await;
    assert_eq!(hosts[0]["username"], "ops");
    assert_eq!(hosts[1]["keyPath"], json!(key_path));
    let expected = call(&ws, "identities:list", Value::Null).await[0].clone();
    assert_eq!(expected["hosts"].as_array().unwrap().len(), 2);
    // Check portability while the key is still configured, before switching to Agent.
    {
        let store = ws.store.lock().unwrap();
        let data = store.data().unwrap();
        let snapshot = serde_json::to_value(data.snapshot()).unwrap();
        assert_eq!(data.identities[0].key_path.as_ref(), Some(&key_path));
        let identities: Vec<_> = snapshot.as_array().unwrap().iter()
            .filter(|row| row["asset"]["kind"] == "identity").collect();
        assert_eq!(identities.len(), 1);
        assert!(identities[0]["asset"]["value"].get("keyPath").is_none());
    }
    assert!(dispatch(
        &ws,
        "identities:delete",
        json!({"id":id,"expected":expected})
    )
    .await
    .is_err());
    let changed=call(&ws,"identities:save",json!({"identity":{"id":id,"name":"新版身份","username":"admin","auth":"agent"},"expected":expected})).await;
    assert_eq!(changed["hosts"][0]["username"], "admin");
    assert!(dispatch(
        &ws,
        "ssh:connect",
        json!({"id":Uuid::new_v4(),"expected":hosts[0],"secret":""})
    )
    .await
    .is_err());
    let data = ws.store.lock().unwrap().data().unwrap().clone();
    let rows = data.snapshot();
    let serialized = json!(rows);
    assert!(serialized
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["asset"]["kind"] == "identity"));
    assert!(!serde_json::to_value(&rows).unwrap().as_array().unwrap().iter()
        .any(|row| row["asset"]["value"].get("keyPath").is_some()));
    let mut other = Data::default();
    other.apply(store::portable_rows(rows).unwrap(), None);
    assert_eq!(other.connection_hosts()[0].username, "admin");
    other.identities.clear();
    assert!(other.connection_host(other.hosts[0].id).is_err());
}

#[tokio::test]
#[ignore = "requires the localhost password SSH fixture"]
async fn macos_shared_identity_passwords_migrate_and_verify_each_endpoint() {
    let fixture = PathBuf::from(std::env::var("TERMLUME_TEST_FIXTURE").unwrap());
    let home = tempfile::tempdir().unwrap();
    let (_p, ws) = make_workspace(home.path(), None);
    let server: Value =
        serde_json::from_slice(&std::fs::read(fixture.join("password-server.json")).unwrap())
            .unwrap();
    let original=call(&ws,"hosts:save",json!({"address":"127.0.0.1","port":server["port"],"username":"pilot","auth":"password","localPassword":"pilot-local-only"})).await[0].clone();
    let created=call(&ws,"identities:save",json!({"identity":{"name":"共享密码","username":"pilot","auth":"password"},"copySavedPassword":true,"sourceHostId":original["id"]})).await;
    let id = created["identityId"].clone();
    let mut bound = original.clone();
    bound["identityId"] = id.clone();
    let first = call(&ws, "hosts:save", bound).await[0].clone();
    let second = call(
        &ws,
        "hosts:save",
        json!({"address":"localhost","port":server["port"],"identityId":id}),
    )
    .await[1]
        .clone();
    assert!(ws
        .store
        .lock()
        .unwrap()
        .data()
        .unwrap()
        .portable_passwords
        .is_empty());
    assert!(
        !serde_json::to_string(&ws.store.lock().unwrap().data().unwrap().snapshot())
            .unwrap()
            .contains("pilot-local-only")
    );
    let mut rx = events(&ws);
    let a = connect_tab(&ws, &mut rx, &first, "", true, false).await;
    call(&ws, "ssh:close", json!(a)).await;
    let count = || {
        std::fs::read(fixture.join("password-attempts"))
            .unwrap_or_default()
            .len()
    };
    let before = count();
    let denied = Uuid::new_v4();
    call(
        &ws,
        "ssh:connect",
        json!({"id":denied,"expected":second,"secret":"","useSaved":true}),
    )
    .await;
    let trust = until(&mut rx, |e| {
        e["type"] == "trust" && e["id"] == denied.to_string()
    })
    .await;
    assert_eq!(count(), before);
    call(
        &ws,
        "ssh:trust",
        json!({"id":denied,"accepted":false,"challenge":trust["challenge"]}),
    )
    .await;
    until(&mut rx, |e| {
        e["type"] == "session" && e["id"] == denied.to_string() && e["status"] == "closed"
    })
    .await;
    assert_eq!(count(), before);
    let b = connect_tab(&ws, &mut rx, &second, "", true, false).await;
    call(&ws, "ssh:close", json!(b)).await;
    let expected = call(&ws, "identities:list", Value::Null).await[0].clone();
    call(&ws,"identities:save",json!({"identity":{"id":id,"name":"共享密码","username":"pilot","auth":"password"},"expected":expected,"clearPassword":true})).await;
    assert_eq!(
        call(&ws, "hosts:has-password", first["id"].clone()).await,
        false
    );
    ws.connections.close_all();
}

#[tokio::test]
async fn groups_preserve_empty_nodes_inheritance_and_legacy_mapping() {
    let home = tempfile::tempdir().unwrap();
    let (_p, ws) = make_workspace(home.path(), None);
    let i = call(
        &ws,
        "identities:save",
        json!({"identity":{"name":"default","username":"ops","auth":"agent"}}),
    )
    .await["identityId"]
        .clone();
    let root = call(
        &ws,
        "groups:save",
        json!({"group":{"name":"生产","port":2222,"identityId":i,"terminalTheme":"light"}}),
    )
    .await["groups"][0]
        .clone();
    let result = call(
        &ws,
        "groups:save",
        json!({"group":{"name":"API","parentId":root["id"]}}),
    )
    .await;
    let child = result["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == "API")
        .unwrap()
        .clone();
    assert_eq!(child["path"], "生产 / API");
    assert!(call(&ws, "hosts:list", Value::Null)
        .await
        .as_array()
        .unwrap()
        .is_empty());
    let host=call(&ws,"hosts:save",json!({"address":"inherited.test","groupId":child["id"],"inheritPort":true,"inheritIdentity":true,"inheritTheme":true,"keepaliveInterval":0,"connectTimeout":90})).await[0].clone();
    assert_eq!(host["port"], 2222);
    assert_eq!(host["username"], "ops");
    assert_eq!(host["terminalTheme"], "light");
    assert_eq!(host["keepaliveInterval"], 0);
    assert_eq!(host["connectTimeout"], 90);
    let override_host=call(&ws,"hosts:save",json!({"address":"override.test","port":2022,"username":"own","auth":"agent","groupId":child["id"]})).await[1].clone();
    let current = call(&ws, "groups:list", Value::Null)
        .await
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["id"] == root["id"])
        .unwrap()
        .clone();
    let mut changed = current.clone();
    changed["name"] = json!("Production");
    changed["port"] = json!(2200);
    changed["terminalTheme"] = json!("dark");
    let updated = call(
        &ws,
        "groups:save",
        json!({"group":changed,"expected":current}),
    )
    .await;
    assert_eq!(updated["hosts"][0]["group"], "Production / API");
    assert_eq!(updated["hosts"][0]["port"], 2200);
    assert_eq!(updated["hosts"][0]["terminalTheme"], "dark");
    assert_eq!(updated["hosts"][1]["port"], override_host["port"]);
    let root = updated["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["id"] == root["id"])
        .unwrap()
        .clone();
    let mut cycle = root.clone();
    cycle["parentId"] = child["id"].clone();
    assert!(
        dispatch(&ws, "groups:save", json!({"group":cycle,"expected":root}))
            .await
            .is_err()
    );
    assert!(
        dispatch(&ws, "groups:delete", json!({"group":root,"expected":root}))
            .await
            .is_err()
    );
    let rows = ws.store.lock().unwrap().data().unwrap().snapshot();
    let mut other = Data::default();
    other.apply(store::portable_rows(rows).unwrap(), None);
    assert_eq!(
        other
            .connection_host(Uuid::parse_str(host["id"].as_str().unwrap()).unwrap())
            .unwrap()
            .port,
        2200
    );
    let old: Host =
        serde_json::from_value(json!({"id":Uuid::new_v4(),"name":"legacy","group":"old team"}))
            .unwrap();
    let (mut a, mut b) = (Data::default(), Data::default());
    a.hosts.push(old.clone());
    b.hosts.push(old);
    assets::migrate_groups(&mut a);
    assets::migrate_groups(&mut b);
    assert_eq!(a.groups[0].id, b.groups[0].id);
}

#[tokio::test]
#[ignore = "requires isolated OpenSSH SFTP fixture"]
#[cfg(unix)]
async fn macos_transfer_checkpoints_resume_files_and_directories_both_ways() {
    let fixture = PathBuf::from(std::env::var("TERMLUME_TEST_FIXTURE").unwrap());
    let home = tempfile::tempdir().unwrap();
    let root = fixture.join("remote/checkpoint-test");
    std::fs::create_dir(&root).unwrap();
    let port: u16 = std::fs::read_to_string(fixture.join("openssh-port"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let data: Vec<u8> = (0..8 * 1024 * 1024).map(|n| (n % 251) as u8).collect();
    for (upload, folder) in [(true, false), (false, false), (true, true), (false, true)] {
        let (profile, ws) = make_workspace(home.path(), None);
        let host = call(&ws,"hosts:save",json!({"address":"127.0.0.1","port":port,"username":std::env::var("USER").unwrap(),"auth":"agent"})).await[0].clone();
        let mut rx = events(&ws);
        let tab = connect_tab(&ws, &mut rx, &host, "", false, false).await;
        let remote = root.join(format!("round ' trip-{upload}-{folder}"));
        let local = home.path().join(format!("local-{upload}-{folder}"));
        let (source, destination) = if upload {
            (&local, &remote)
        } else {
            (&remote, &local)
        };
        let contents = |path: &std::path::Path| {
            if folder {
                path.join("nested/data.bin")
            } else {
                path.to_path_buf()
            }
        };
        if folder {
            std::fs::create_dir_all(source.join("nested")).unwrap();
            std::fs::write(source.join("empty"), b"").unwrap();
        }
        std::fs::write(contents(source), &data).unwrap();
        let prepared = ws
            .transfers
            .stage(
                ws.connections.connected(tab).unwrap(),
                upload,
                vec![(remote.to_str().unwrap().into(), local.clone())],
            )
            .await
            .unwrap();
        call(
            &ws,
            "files:enqueue",
            json!({"ticket":prepared["ticket"],"policy":"skip"}),
        )
        .await;
        let running = until(&mut rx, |e| {
            e["type"] == "transfer"
                && e["status"] == "running"
                && e["bytes"].as_u64().unwrap_or(0) > 0
        })
        .await;
        if upload && !folder {
            ws.connections.connected(tab).unwrap().cancel.cancel();
        } else {
            call(&ws, "files:pause", running["id"].clone()).await;
        }
        let paused = until(&mut rx, |e| {
            e["id"] == running["id"] && e["status"] == "paused"
        })
        .await;
        let offset = paused["bytes"].as_u64().unwrap();
        assert!(offset > 0 && offset < data.len() as u64, "{paused}");
        assert!(!destination.exists());
        assert!(call(&ws, "files:remove-history", Value::Null)
            .await
            .as_array()
            .unwrap()
            .is_empty());
        call(&ws, "ssh:close", json!(tab)).await;
        drop(rx);
        drop(ws);
        // The test process still owns async SSH cleanup tasks. Load exactly the
        // persisted bytes in a new profile to simulate a separate process.
        let restored = tempfile::tempdir().unwrap();
        for name in ["workspace.json", "workspace.key"] {
            std::fs::copy(profile.path().join(name), restored.path().join(name)).unwrap();
        }
        let ws = Workspace::new(restored.path().into(), home.path().into(), None).unwrap();
        let mut rx = events(&ws);
        let pending = call(&ws, "files:pending", Value::Null).await;
        assert_eq!(pending[0]["bytes"], offset);
        let fresh = connect_tab(&ws, &mut rx, &host, "", false, false).await;
        assert_eq!(call(&ws, "files:remote-location", json!({"id":fresh, "recordId":paused["id"]})).await["path"], json!(remote));
        let request = json!({"sessionId":fresh,"id":paused["id"]});
        if !folder && !upload {
            use std::io::Write;
            let part =
                local.with_file_name(format!(".termlume-{}.part", paused["id"].as_str().unwrap()));
            std::fs::OpenOptions::new()
                .write(true)
                .open(&part)
                .unwrap()
                .write_all(b"changed")
                .unwrap();
            call(&ws, "files:resume", request.clone()).await;
            let rejected = until(&mut rx, |e| {
                e["id"] == paused["id"] && e["status"] == "paused"
            })
            .await;
            assert!(rejected["message"].as_str().unwrap().contains("校验"));
            assert!(!destination.exists());
            std::fs::OpenOptions::new()
                .write(true)
                .open(&part)
                .unwrap()
                .write_all(&data[..7])
                .unwrap();
        }
        call(&ws, "files:resume", request).await;
        let result = until(&mut rx, |e| {
            e["id"] == paused["id"] && (e.get("finishedAt").is_some() || e["status"] == "paused")
        })
        .await;
        assert_eq!(result["status"], "done", "{result}");
        assert_eq!(std::fs::read(contents(destination)).unwrap(), data);
        if folder {
            assert!(destination.join("empty").is_file());
        }
        assert!(call(&ws, "files:pending", Value::Null)
            .await
            .as_array()
            .unwrap()
            .is_empty());
        call(&ws, "ssh:close", json!(fresh)).await;
    }
}

#[tokio::test]
#[ignore = "requires isolated OpenSSH SFTP fixture"]
#[cfg(unix)]
async fn macos_remote_mutations_upload_directory_and_edit_conflicts() {
    let fixture = PathBuf::from(std::env::var("TERMLUME_TEST_FIXTURE").unwrap());
    let home = tempfile::tempdir().unwrap();
    let (_p, ws) = make_workspace(home.path(), None);
    let port: u16 = std::fs::read_to_string(fixture.join("openssh-port"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let host=call(&ws,"hosts:save",json!({"address":"127.0.0.1","port":port,"username":std::env::var("USER").unwrap(),"auth":"agent"})).await[0].clone();
    let mut rx = events(&ws);
    let tab = connect_tab(&ws, &mut rx, &host, "", false, false).await;
    let root = fixture.join("remote/mutation-test");
    std::fs::create_dir_all(&root).unwrap();
    let source = root.join("source ' name.txt");
    let target = root.join("renamed.txt");
    std::fs::write(&source, b"original").unwrap();
    std::fs::write(&target, b"keep target").unwrap();
    let preview = call(
        &ws,
        "files:mutation-preview",
        json!({"id":tab,"paths":[source]}),
    )
    .await;
    assert!(dispatch(
        &ws,
        "files:rename",
        json!({"id":tab,"source":source,"destination":target,"expected":preview["nodes"][0]})
    )
    .await
    .is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"keep target");
    std::fs::remove_file(&target).unwrap();
    call(
        &ws,
        "files:rename",
        json!({"id":tab,"source":source,"destination":target,"expected":preview["nodes"][0]}),
    )
    .await;
    let tree = root.join("tree");
    std::fs::create_dir_all(tree.join("nested/empty")).unwrap();
    std::fs::write(tree.join("nested/data.txt"), b"data").unwrap();
    std::os::unix::fs::symlink(&target, tree.join("link")).unwrap();
    let preview = call(
        &ws,
        "files:mutation-preview",
        json!({"id":tab,"paths":[tree]}),
    )
    .await;
    std::fs::write(tree.join("new"), b"changed").unwrap();
    assert!(dispatch(
        &ws,
        "files:remove",
        json!({"id":tab,"roots":preview["roots"],"expected":preview["nodes"]})
    )
    .await
    .is_err());
    assert!(tree.join("nested/data.txt").exists());
    let preview = call(
        &ws,
        "files:mutation-preview",
        json!({"id":tab,"paths":[tree]}),
    )
    .await;
    let removed = call(
        &ws,
        "files:remove",
        json!({"id":tab,"roots":preview["roots"],"expected":preview["nodes"]}),
    )
    .await;
    assert!(
        removed
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["status"] == "done"),
        "{removed}"
    );
    assert!(!tree.exists());
    assert!(target.exists());
    let local = fixture.join("local/upload-tree");
    std::fs::create_dir_all(local.join("nested/empty")).unwrap();
    std::fs::write(local.join("nested/a.txt"), b"directory upload").unwrap();
    std::os::unix::fs::symlink(&target, local.join("skip-link")).unwrap();
    let remote = root.join("uploaded");
    let session = ws.connections.connected(tab).unwrap();
    let prepared = ws
        .transfers
        .stage(
            session.clone(),
            true,
            vec![(remote.to_string_lossy().into_owned(), local.clone())],
        )
        .await
        .unwrap();
    assert_eq!(prepared["files"][0]["skipped"], 1);
    call(
        &ws,
        "files:enqueue",
        json!({"ticket":prepared["ticket"],"policy":"skip"}),
    )
    .await;
    let result = until(&mut rx, |e| {
        e["type"] == "transfer" && matches!(e["status"].as_str(), Some("done" | "failed"))
    })
    .await;
    assert_eq!(result["status"], "done", "{result}");
    assert_eq!(
        std::fs::read(remote.join("nested/a.txt")).unwrap(),
        b"directory upload"
    );
    assert!(remote.join("nested/empty").is_dir());
    assert!(!remote.join("skip-link").exists());
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
    let edited = transfer::open_editor(&ws, session.clone(), target.to_str().unwrap(), false)
        .await
        .unwrap();
    let local_edit = PathBuf::from(edited["local"].as_str().unwrap());
    assert_eq!(edited["host"], host["name"]);
    assert!(edited["endpoint"].as_str().unwrap().contains("127.0.0.1"));
    std::fs::write(&local_edit, b"new local text").unwrap();
    std::fs::write(&target, b"remote change").unwrap();
    assert!(dispatch(&ws, "editors:prepare", edited["id"].clone())
        .await
        .is_err());
    call(&ws, "editors:close", edited["id"].clone()).await;
    assert!(!local_edit.exists());
    let edited = transfer::open_editor(&ws, session, target.to_str().unwrap(), false)
        .await
        .unwrap();
    std::fs::write(edited["local"].as_str().unwrap(), b"approved local text").unwrap();
    let prepared = call(&ws, "editors:prepare", edited["id"].clone()).await;
    call(
        &ws,
        "files:enqueue",
        json!({"ticket":prepared["ticket"],"policy":"replace"}),
    )
    .await;
    let result = until(&mut rx, |e| {
        e["type"] == "transfer" && matches!(e["status"].as_str(), Some("done" | "failed"))
    })
    .await;
    assert_eq!(result["status"], "done", "{result}");
    assert_eq!(std::fs::read(&target).unwrap(), b"approved local text");
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o640
    );
    call(&ws, "editors:close", edited["id"].clone()).await;
    assert!(call(&ws, "editors:list", Value::Null)
        .await
        .as_array()
        .unwrap()
        .is_empty());
    let opened = call(&ws, "files:read-text", json!({"id":tab,"path":target})).await;
    assert_eq!(opened["text"], "approved local text");
    let saved = call(
        &ws,
        "files:save-text",
        json!({"id":tab,"path":opened["path"],"revision":opened["revision"],"text":"新内容\r\n"}),
    )
    .await;
    assert_eq!(std::fs::read(&target).unwrap(), "新内容\r\n".as_bytes());
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o640
    );
    let saved = call(
        &ws,
        "files:save-text",
        json!({"id":tab,"path":opened["path"],"revision":saved["revision"],"text":"keep\n"}),
    )
    .await;
    std::fs::write(&target, b"edit\n").unwrap();
    assert_eq!(call(
        &ws,
        "files:save-text",
        json!({"id":tab,"path":opened["path"],"revision":saved["revision"],"text":"overwrite"}),
    )
    .await["conflict"], true);
    assert_eq!(std::fs::read(&target).unwrap(), b"edit\n");
    let large_log = target.with_extension("log");
    std::fs::File::create(&large_log).unwrap().set_len(4 * 1024 * 1024 + 1).unwrap();
    let large = call(&ws, "files:read-text", json!({"id":tab,"path":large_log})).await;
    assert_eq!(large["tooLarge"], true);
    assert!(large.get("text").is_none());
    let visit = json!({"id":tab, "action":"visit", "path":"/var/log"});
    call(&ws, "files:places", visit.clone()).await;
    call(&ws, "files:places", visit).await;
    let places = call(&ws, "files:places", json!({"id":tab,"action":"pin","path":"/var/log"})).await;
    assert_eq!(places, json!({"recent":["/var/log"],"favorites":["/var/log"]}));
    let places = call(&ws, "files:places", json!({"id":tab,"action":"unpin","path":"/var/log"})).await;
    assert_eq!(places["favorites"], json!([]));
    std::fs::write(&target, b"binary\0").unwrap();
    assert!(dispatch(&ws, "files:read-text", json!({"id":tab,"path":target}))
        .await
        .is_err());
    call(&ws, "ssh:close", json!(tab)).await;
}

#[test]
fn csv_and_workspace_state_records_validate_without_executing_input() {
    let preview=imports::csv_preview("\u{feff}name,address,port,username,auth,tags\r\n\"API, prod\",example.test,2222,ops,agent,prod;api\r\n").unwrap();
    assert_eq!(preview["rows"][0]["name"], "API, prod");
    assert_eq!(preview["rows"][0]["tags"], json!(["prod", "api"]));
    assert!(imports::csv_rows("a,b\n\"unterminated").is_err());
    assert!(imports::csv_preview("address,address\na,b").is_err());
    assert_eq!(
        imports::csv_preview("address,username\nvalid.test,").unwrap()["rows"][0]["editable"],
        true
    );
    assert_eq!(
        imports::csv_preview("address,username\ninvalid/path,").unwrap()["rows"][0]["editable"],
        false
    );
    let valid = ssh::command_for("tail", "/tmp/valid", 2).unwrap();
    assert!(valid.contains("tail"));
    let command = ssh::CommandRequest {
        action: "custom".into(),
        argument: "printf 'a'; printf 'b'".into(),
        lines: 100,
    };
    assert!(command.preview().unwrap().starts_with("sh -c '"));
}
#[tokio::test]
async fn layouts_keep_four_panes_and_both_ratios_across_restore() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let tabs = (0..4).map(|i| json!({"hostId":Uuid::new_v4(),"title":format!("pane {i}")})).collect::<Vec<_>>();
    let pair = call(&ws, "layouts:save", json!({"layout":{
        "name":"legacy pair","tabs":&tabs[..2],"split":[0,1],"direction":"horizontal","ratio":60
    }})).await[0].clone();
    assert!(pair.get("rowRatio").is_none());
    let grid = json!({"name":"grid","tabs":tabs,"split":[0,1,2,3],"direction":"grid","ratio":60,"rowRatio":55});
    let saved = call(&ws, "layouts:save", json!({"layout":grid})).await[1].clone();
    assert_eq!(saved["rowRatio"], 55);
    for indices in [json!([0,1,1,3]), json!([0,1,2,4]), json!([0,1])] {
        let mut invalid = grid.clone();
        invalid["split"] = indices;
        assert!(dispatch(&ws, "layouts:save", json!({"layout":invalid})).await.is_err());
    }
    let mut wrong_direction = grid.clone();
    wrong_direction["direction"] = json!("vertical");
    assert!(dispatch(&ws, "layouts:save", json!({"layout":wrong_direction})).await.is_err());
    let rows = ws.store.lock().unwrap().data().unwrap().snapshot();
    let mut restored = Data::default();
    restored.apply(store::portable_rows(rows).unwrap(), None);
    let restored_grid = restored.layouts.iter().find(|layout| layout.id.to_string() == saved["id"].as_str().unwrap()).unwrap();
    assert_eq!(json!(restored_grid), saved);
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    let reopened = call(&ws, "layouts:list", Value::Null).await;
    assert_eq!(reopened[0], pair);
    assert_eq!(reopened[1], saved);
}

#[tokio::test]
async fn editable_builtins_pins_order_and_parameters_survive_restart_and_sync() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let original = call(&ws, "snippets:list", Value::Null).await;
    assert_eq!(original.as_array().unwrap().len(), 4);
    assert!(ws.store.lock().unwrap().data().unwrap().snippets.is_empty());
    let mut legacy = Data::default();
    let mut legacy_builtin: assets::Snippet = serde_json::from_value(original[0].clone()).unwrap();
    legacy_builtin.builtin = None;
    legacy_builtin.command = "df -h /tmp".into();
    legacy.snippets.push(legacy_builtin);
    assert_eq!(assets::all_snippets(&legacy)[0].builtin.as_deref(), Some("disk"));
    assert_eq!(assets::all_snippets(&legacy)[0].command, "df -h /tmp");
    let disk = original[0].clone();
    let mut edited = disk.clone();
    edited["name"] = json!("常用磁盘"); edited["command"] = json!("df -h /tmp"); edited["pinned"] = json!(false);
    call(&ws, "snippets:save", json!({"snippet":edited,"expected":disk})).await;
    assert!(dispatch(&ws, "snippets:save", json!({"snippet":disk,"expected":disk})).await.is_err());
    let before = call(&ws, "snippets:list", Value::Null).await;
    let mut ids: Vec<Value> = before.as_array().unwrap().iter().map(|s| s["id"].clone()).collect();
    ids.reverse();
    call(&ws, "snippets:reorder", json!({"ids":ids,"expected":before})).await;
    assert!(dispatch(&ws, "snippets:reorder", json!({"ids":ids,"expected":before})).await.is_err());
    let ordered = call(&ws, "snippets:list", Value::Null).await;
    assert_eq!(ordered[0]["id"], ids[0]);
    let mut restored = Data::default();
    restored.apply(store::portable_rows(ws.store.lock().unwrap().data().unwrap().snapshot()).unwrap(), None);
    assert_eq!(json!(assets::all_snippets(&restored)), ordered);
    let tail: assets::Snippet = serde_json::from_value(ordered.as_array().unwrap().iter().find(|s| s["builtin"] == "tail").unwrap().clone()).unwrap();
    assert_eq!(tail.rendered(&json!({"path":"/tmp/中文 ' {{service}}.log","lines":12})).unwrap(), "tail -n 12 '/tmp/中文 '\\'' {{service}}.log'");
    assert!(tail.rendered(&json!({"path":"relative","lines":12})).is_err());
    assert!(tail.rendered(&json!({"path":"/tmp/log","lines":0})).is_err());
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "snippets:list", Value::Null).await, ordered);
    let saved_disk = ordered.as_array().unwrap().iter().find(|s| s["id"] == disk["id"]).unwrap();
    call(&ws, "snippets:delete", json!({"snippet":saved_disk,"expected":saved_disk})).await;
    let reset = call(&ws, "snippets:list", Value::Null).await;
    assert_eq!(reset.as_array().unwrap().iter().find(|s| s["id"] == disk["id"]).unwrap(), &disk);
    let mut invalid_ids = ids.clone(); invalid_ids[0] = invalid_ids[1].clone();
    assert!(dispatch(&ws, "snippets:reorder", json!({"ids":invalid_ids,"expected":reset})).await.is_err());
}

#[tokio::test]
async fn command_library_layouts_preferences_and_empty_workspace_guards() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let snippet = call(
        &ws,
        "snippets:save",
        json!({"snippet":{"name":"status","command":"printf 'one'; printf 'two'","tags":["test"]}}),
    )
    .await[0]
        .clone();
    let layout=call(&ws,"layouts:save",json!({"layout":{"name":"pair","tabs":[{"hostId":Uuid::new_v4(),"title":"left"},{"hostId":Uuid::new_v4(),"title":"right"}],"split":[0,1],"direction":"horizontal","ratio":60}})).await[0].clone();
    assert!(dispatch(&ws, "snippets:delete", json!({"snippet":snippet}))
        .await
        .is_err());
    let preferences = call(&ws, "preferences:get", Value::Null).await;
    let mut p = preferences.clone();
    p["theme"] = json!("light");
    p["terminalTheme"] = json!("light");
    p["fontSize"] = json!(18);
    p["recordCommands"] = json!(true);
    call(&ws, "preferences:save", p.clone()).await;
    let mut invalid = p.clone();
    invalid["fontSize"] = json!(100);
    assert!(dispatch(&ws, "preferences:save", invalid).await.is_err());
    let rows = ws.store.lock().unwrap().data().unwrap().snapshot();
    let mut restored = Data::default();
    restored.apply(store::portable_rows(rows).unwrap(), None);
    assert_eq!(json!(restored.snippets)[0], snippet);
    assert_eq!(json!(restored.layouts)[0], layout);
    assert_eq!(restored.preferences.font_size, 18);
    assert!(!restored.preferences.record_commands);
    assert!(ws.store.lock().unwrap().ensure_empty().is_err());
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "preferences:get", Value::Null).await, p);
    call(
        &ws,
        "snippets:delete",
        json!({"snippet":snippet,"expected":snippet}),
    )
    .await;
    call(
        &ws,
        "layouts:delete",
        json!({"layout":layout,"expected":layout}),
    )
    .await;
}

#[tokio::test]
#[ignore = "requires isolated OpenSSH, TCP fixture, and local log files"]
async fn macos_commands_logs_remote_and_dynamic_forwards() {
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
    let fixture = PathBuf::from(std::env::var("TERMLUME_TEST_FIXTURE").unwrap());
    let home = tempfile::tempdir().unwrap();
    let (_p, ws) = make_workspace(home.path(), None);
    let port: u16 = std::fs::read_to_string(fixture.join("openssh-port"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let echo: u16 = std::fs::read_to_string(fixture.join("echo-port"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let host=call(&ws,"hosts:save",json!({"address":"127.0.0.1","port":port,"username":std::env::var("USER").unwrap(),"auth":"agent","startupCommand":"printf 'STARTUP_%s\\n' 'DONE'; printf 'CHARMAP_'; locale charmap","startupEnabled":true,"autoReconnect":true})).await[0].clone();
    let mut rx = events(&ws);
    let tab = connect_tab(&ws, &mut rx, &host, "", false, false).await;
    let mut output = String::new();
    while !output.contains("STARTUP_DONE") || !output.contains("CHARMAP_UTF-8") {
        let e = until(&mut rx, |e| {
            e["type"] == "output" && e["id"] == tab.to_string()
        })
        .await;
        output.push_str(&String::from_utf8_lossy(
            &STANDARD.decode(e["bytes"].as_str().unwrap()).unwrap(),
        ));
    }
    let log = call(&ws, "logs:start", json!(tab)).await;
    let mut p = call(&ws, "preferences:get", Value::Null).await;
    p["recordCommands"] = json!(true);
    call(&ws, "preferences:save", p).await;
    let snippet=call(&ws,"snippets:save",json!({"snippet":{"name":"compound","command":"printf 'FIRST_%s\\n' 'DONE'; printf 'SECOND_%s\\n' 'DONE'"}})).await[0].clone();
    let command = Uuid::new_v4();
    call(
        &ws,
        "snippets:run",
        json!({"id":command,"sessionId":tab,"snippetId":snippet["id"],"expected":snippet}),
    )
    .await;
    let mut output = String::new();
    loop {
        let e = until(&mut rx, |e| e["id"] == command.to_string()).await;
        if e["type"] == "output" {
            output.push_str(&String::from_utf8_lossy(
                &STANDARD.decode(e["bytes"].as_str().unwrap()).unwrap(),
            ));
        }
        if e["type"] == "command" && e["status"] == "done" {
            break;
        }
    }
    assert!(
        output.contains("FIRST_DONE") && output.contains("SECOND_DONE"),
        "{output}"
    );
    assert_eq!(
        call(&ws, "history:list", Value::Null)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    call(&ws, "logs:stop", json!(tab)).await;
    let text = call(&ws, "logs:read", log["id"].clone()).await;
    assert!(text.as_str().unwrap().contains("SECOND_DONE"));
    call(&ws, "logs:delete", log["id"].clone()).await;
    assert!(call(&ws, "logs:list", Value::Null)
        .await
        .as_array()
        .unwrap()
        .is_empty());
    call(&ws, "history:clear", Value::Null).await;
    for kind in ["remote", "dynamic"] {
        let listen = free_port().await;
        let mut rule = json!({"name":kind,"kind":kind,"localPort":listen,"remoteAddress":"127.0.0.1","remotePort":echo});
        if kind == "dynamic" {
            rule["remoteAddress"] = json!("");
            rule["remotePort"] = json!(0);
        }
        let saved = call(
            &ws,
            "forwards:save",
            json!({"hostId":host["id"],"rule":rule}),
        )
        .await;
        let rule = saved[0]["localForwards"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .clone();
        let run = call(
            &ws,
            "forwards:start",
            json!({"sessionId":tab,"ruleId":rule["id"],"expected":rule}),
        )
        .await;
        let mut socket = TcpStream::connect(("127.0.0.1", listen)).await.unwrap();
        if kind == "dynamic" {
            socket.write_all(&[5, 1, 0]).await.unwrap();
            let mut response = [0; 2];
            socket.read_exact(&mut response).await.unwrap();
            assert_eq!(response, [5, 0]);
            let domain = b"localhost";
            let mut request = vec![5, 1, 0, 3, domain.len() as u8];
            request.extend(domain);
            request.extend(echo.to_be_bytes());
            socket.write_all(&request).await.unwrap();
            let mut response = [0; 10];
            socket.read_exact(&mut response).await.unwrap();
            assert_eq!(response[1], 0);
        }
        let payload = b"forward round trip";
        socket.write_all(payload).await.unwrap();
        let mut response = vec![0; payload.len()];
        tokio::time::timeout(Duration::from_secs(10), socket.read_exact(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response, payload);
        drop(socket);
        call(&ws, "forwards:stop", run["id"].clone()).await;
        assert!(TcpListener::bind(("127.0.0.1", listen)).await.is_ok());
        assert!(ws.connections.connected(tab).is_ok());
    }
    // An abrupt SSH disconnect is retryable, while normal shell exits are not.
    ws.connections
        .connected(tab)
        .unwrap()
        .client
        .get()
        .unwrap()
        .disconnect(russh::Disconnect::ByApplication, "test transport loss", "")
        .await
        .unwrap();
    let closed = until(&mut rx, |e| {
        e["type"] == "session" && e["id"] == tab.to_string() && e["status"] == "closed"
    })
    .await;
    assert_eq!(closed["retryable"], true);
    assert_eq!(closed["exited"], false);
    let normal = connect_tab(&ws, &mut rx, &host, "", false, false).await;
    call(&ws, "ssh:input", json!({"id":normal,"data":"exit\r"})).await;
    let closed = until(&mut rx, |e| {
        e["type"] == "session" && e["id"] == normal.to_string() && e["status"] == "closed"
    })
    .await;
    assert_eq!(closed["retryable"], false);
    assert_eq!(closed["exited"], true);
}

#[tokio::test]
async fn layouts_keep_tree_geometry_and_reject_invalid_or_future_records() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let leaf = |index| json!({"type":"pane","index":index});
    let tabs = (0..3).map(|_| json!({"hostId":Uuid::new_v4(),"title":""})).collect::<Vec<_>>();
    let layout = json!({"name":"three panes","tabs":tabs,"direction":"tree","ratio":50,
        "split":{"version":2,"root":{"type":"split","axis":"column","ratio":60,"first":leaf(0),
            "second":{"type":"split","axis":"row","ratio":45,"first":leaf(1),"second":leaf(2)}}}});
    let saved = call(&ws, "layouts:save", json!({"layout":layout})).await[0].clone();
    assert_eq!(saved["split"], layout["split"]);
    // The prior client's Vec<usize> decoder fails instead of dropping geometry.
    assert!(serde_json::from_value::<Vec<usize>>(saved["split"].clone()).is_err());
    for pointer in ["/split/root/second/second/index", "/split/root/ratio", "/split/root/axis", "/split/version"] {
        let mut invalid = layout.clone();
        *invalid.pointer_mut(pointer).unwrap() = match pointer {
            "/split/root/second/second/index" => json!(0),
            "/split/root/ratio" => json!(10),
            "/split/root/axis" => json!("diagonal"),
            _ => json!(3),
        };
        assert!(dispatch(&ws, "layouts:save", json!({"layout":invalid})).await.is_err());
    }
    let mut out_of_range = layout.clone();
    out_of_range["split"]["root"]["first"]["index"] = json!(3);
    assert!(dispatch(&ws, "layouts:save", json!({"layout":out_of_range})).await.is_err());
    let mut omitted = layout.clone();
    omitted["split"]["root"]["second"] = leaf(1);
    assert!(dispatch(&ws, "layouts:save", json!({"layout":omitted})).await.is_err());
    let rows = ws.store.lock().unwrap().data().unwrap().snapshot();
    let mut restored = Data::default();
    restored.apply(store::portable_rows(rows).unwrap(), None);
    assert_eq!(json!(restored.layouts)[0], saved);
    let summary = restored.snapshot().into_iter().find(|row| row.summary()["recordType"] == "layout").unwrap().summary();
    assert_eq!(summary["split"], saved["split"]);
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "layouts:list", Value::Null).await[0], saved);
}

#[tokio::test]
async fn layouts_keep_large_and_deep_trees_across_restore() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let tabs = (0..32).map(|_| json!({"hostId":Uuid::new_v4(),"title":""})).collect::<Vec<_>>();
    // Exceeds the former pane, tab and depth limits in one persisted record.
    let mut root = json!({"type":"pane","index":0});
    for index in 1..32 {
        root = json!({"type":"split","axis":"row","ratio":50,"first":root,
            "second":{"type":"pane","index":index}});
    }
    let split = json!({"version":2,"root":root});
    let saved = call(&ws, "layouts:save", json!({"layout":{
        "name":"large workspace","tabs":tabs,"direction":"tree","ratio":50,"split":split
    }})).await[0].clone();
    assert_eq!(saved["tabs"].as_array().unwrap().len(), 32);
    assert_eq!(saved["split"], split);
    let rows = ws.store.lock().unwrap().data().unwrap().snapshot();
    let mut restored = Data::default();
    restored.apply(store::portable_rows(rows).unwrap(), None);
    assert_eq!(json!(restored.layouts)[0], saved);
    drop(ws);
    let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
    assert_eq!(call(&ws, "layouts:list", Value::Null).await[0], saved);
}

#[test]
fn initial_window_fits_the_available_work_area() {
    assert_eq!(initial_window_size(None), (1280.0, 800.0));
    assert_eq!(initial_window_size(Some((1920.0, 1080.0))), (1280.0, 800.0));
    assert_eq!(initial_window_size(Some((1024.0, 720.0))), (976.0, 672.0));
    assert_eq!(initial_window_size(Some((600.0, 540.0))), (552.0, 492.0));
}

#[tokio::test]
async fn csv_import_is_additive_atomic_and_preserves_existing_credentials() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let saved = call(&ws, "hosts:save", json!({"address":"csv-existing.test","username":"ops","auth":"password","localPassword":"existing-secret"})).await[0].clone();
    let preview = imports::csv_preview("address,username,auth\ncsv-existing.test,ops,password\nnew-key.test,ops,key\n").unwrap();
    let result = call(&ws, "hosts:import", preview).await;
    assert_eq!(result["count"], 1);
    assert_eq!(call(&ws, "hosts:reveal-password", saved["id"].clone()).await, "existing-secret");
    let file = profile.path().join("workspace.json");
    let before = std::fs::read(&file).unwrap();
    let group = Uuid::new_v4();
    assert!(dispatch(&ws,"hosts:import",json!({"groups":[{"id":group,"name":"must not be saved"}],"rows":[{"id":Uuid::new_v4(),"address":"invalid-import.test","username":"ops","jumpHostId":Uuid::new_v4()}]})).await.is_err());
    assert_eq!(std::fs::read(file).unwrap(), before);
    assert_eq!(call(&ws,"hosts:list",Value::Null).await.as_array().unwrap().len(),2);
}

#[tokio::test]
async fn deleting_group_subtrees_ungroups_hosts_and_preserves_connections_and_credentials() {
    for legacy in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let (profile, ws) = make_workspace(home.path(), None);
        let identity = call(&ws,"identities:save",json!({"identity":{"name":"shared","username":"ops","auth":"password"},"localPassword":"shared-secret"})).await["identityId"].clone();
        let root = call(&ws,"groups:save",json!({"group":{"name":"delete-root","port":2222,"identityId":identity,"terminalTheme":"light"}})).await["groups"][0].clone();
        let child = call(
            &ws,
            "groups:save",
            json!({"group":{"name":"child","parentId":root["id"]}}),
        )
        .await["groups"][1]
            .clone();
        call(&ws, "groups:save", json!({"group":{"name":"unrelated"}})).await;
        let direct = call(&ws,"hosts:save",json!({"address":"direct.test","username":"own","auth":"password","groupId":root["id"],"inheritPort":true,"inheritTheme":true,"localPassword":"direct-secret"})).await[0].clone();
        let inherited = call(&ws,"hosts:save",json!({"address":"inherited.test","groupId":child["id"],"inheritPort":true,"inheritIdentity":true,"inheritTheme":true})).await[1].clone();
        let key = call(&ws,"hosts:save",json!({"address":"key.test","username":"key-user","auth":"key","keyPath":home.path().join("group-delete-key"),"localKeyPassphrase":"key-secret","groupId":child["id"],"port":2200})).await[2].clone();
        let outside = call(
            &ws,
            "hosts:save",
            json!({"address":"outside.test","username":"outside","auth":"agent"}),
        )
        .await[3]
            .clone();
        let (passwords, passphrases, secrets) = {
            let store = ws.store.lock().unwrap();
            let data = store.data().unwrap();
            (
                data.local_passwords.clone(),
                data.key_passphrases.clone(),
                serde_json::to_value(&data.local_secrets).unwrap(),
            )
        };
        let all = call(&ws, "groups:list", Value::Null).await;
        let root = all
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g["id"] == root["id"])
            .unwrap()
            .clone();
        if legacy {
            call(&ws, "hosts:remove-group", json!("delete-root")).await;
        } else {
            let expected: Vec<_> = all
                .as_array()
                .unwrap()
                .iter()
                .filter(|g| g["id"] == root["id"] || g["id"] == child["id"])
                .cloned()
                .collect();
            call(
                &ws,
                "groups:delete",
                json!({"group":root,"expected":root,"expectedGroups":expected}),
            )
            .await;
        }
        let remaining = call(&ws, "groups:list", Value::Null).await;
        assert_eq!(remaining.as_array().unwrap().len(), 1);
        assert_eq!(remaining[0]["name"], "unrelated");
        let after = call(&ws, "hosts:list", Value::Null).await;
        assert_eq!(after.as_array().unwrap().len(), 4);
        for before in [&direct, &inherited, &key] {
            let mut expected: Host = serde_json::from_value(before.clone()).unwrap();
            expected.group.clear();
            expected.group_id = None;
            expected.inherit_port = false;
            expected.inherit_identity = false;
            expected.inherit_theme = false;
            let actual: Host = serde_json::from_value(
                after
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|h| h["id"] == before["id"])
                    .unwrap()
                    .clone(),
            )
            .unwrap();
            assert_eq!(actual, expected);
        }
        assert_eq!(after[3], outside);
        assert_eq!(
            call(&ws, "hosts:reveal-password", direct["id"].clone()).await,
            "direct-secret"
        );
        assert_eq!(
            call(&ws, "hosts:reveal-password", inherited["id"].clone()).await,
            "shared-secret"
        );
        assert_eq!(
            call(&ws, "hosts:has-key-passphrase", key["id"].clone()).await,
            true
        );
        {
            let store = ws.store.lock().unwrap();
            let data = store.data().unwrap();
            assert!(data.local_passwords == passwords);
            assert!(data.key_passphrases == passphrases);
            assert_eq!(serde_json::to_value(&data.local_secrets).unwrap(), secrets);
        }
        drop(ws);
        let ws = Workspace::new(profile.path().into(), home.path().into(), None).unwrap();
        assert_eq!(
            call(&ws, "hosts:reveal-password", inherited["id"].clone()).await,
            "shared-secret"
        );
        assert_eq!(call(&ws, "hosts:list", Value::Null).await, after);
    }
}

#[tokio::test]
async fn group_deletion_requires_an_unchanged_complete_subtree_preview() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let root =
        call(&ws, "groups:save", json!({"group":{"name":"root"}})).await["groups"][0].clone();
    let expected = call(&ws, "groups:list", Value::Null).await;
    call(
        &ws,
        "groups:save",
        json!({"group":{"name":"new child","parentId":root["id"]}}),
    )
    .await;
    let file = profile.path().join("workspace.json");
    let before = std::fs::read(&file).unwrap();
    let error = dispatch(
        &ws,
        "groups:delete",
        json!({"group":root,"expected":root,"expectedGroups":expected}),
    )
    .await
    .unwrap_err();
    assert!(error.contains("已变化"));
    assert_eq!(std::fs::read(file).unwrap(), before);
    assert_eq!(
        call(&ws, "groups:list", Value::Null)
            .await
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn deleting_hosts_cleans_only_their_credentials_and_keeps_shared_logins() {
    let home = tempfile::tempdir().unwrap();
    let (_profile, ws) = make_workspace(home.path(), None);
    let identity=call(&ws,"identities:save",json!({"identity":{"name":"shared","username":"ops","auth":"password"},"localPassword":"shared-secret"})).await["identityId"].clone();
    let target=call(&ws,"hosts:save",json!({"address":"delete.test","username":"own","auth":"password","localPassword":"own-secret"})).await[0].clone();
    let shared = call(
        &ws,
        "hosts:save",
        json!({"address":"shared.test","identityId":identity}),
    )
    .await[1]
        .clone();
    let key=call(&ws,"hosts:save",json!({"address":"key.test","username":"ops","auth":"key","keyPath":home.path().join("host-delete-key"),"localKeyPassphrase":"key-secret"})).await[2].clone();
    call(&ws, "hosts:touch", target["id"].clone()).await;
    let target_id = Uuid::parse_str(target["id"].as_str().unwrap()).unwrap();
    let key_id = Uuid::parse_str(key["id"].as_str().unwrap()).unwrap();
    let tokens = {
        let store = ws.store.lock().unwrap();
        let data = store.data().unwrap();
        let password = match data.local_passwords[&target_id] {
            LocalPassword::Saved { token, .. } => token,
            _ => panic!("saved credential expected"),
        };
        [password, data.key_passphrases[&key_id].token]
    };
    call(&ws, "hosts:delete", target["id"].clone()).await;
    call(&ws, "hosts:delete", key["id"].clone()).await;
    assert_eq!(
        call(&ws, "hosts:list", Value::Null).await,
        json!([shared.clone()])
    );
    assert_eq!(
        call(&ws, "hosts:reveal-password", shared["id"].clone()).await,
        "shared-secret"
    );
    let mut store = ws.store.lock().unwrap();
    let data = store.data().unwrap();
    assert!(!data.recent.contains_key(&target_id));
    assert!(!data.local_passwords.contains_key(&target_id));
    assert!(!data.key_passphrases.contains_key(&key_id));
    assert!(tokens
        .iter()
        .all(|token| store.read_secret(*token).is_err()));
}

#[tokio::test]
async fn host_order_is_atomic_scoped_persistent_and_keeps_credentials() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(), None);
    let first = call(&ws, "hosts:save", json!({"name":"host2","address":"two.test","username":"ops","auth":"password","localPassword":"order-test-secret"})).await[0].clone();
    call(&ws, "hosts:save", json!({"name":"host10","address":"ten.test","username":"ops","auth":"agent"})).await;
    let before = call(&ws,"hosts:list",Value::Null).await;
    let first_id = first["id"].clone();
    let second_id = before[1]["id"].clone();
    let expected = host_order::state(ws.store.lock().unwrap().data().unwrap(), "host");
    let request = json!({"kind":"host","mode":"manual","expectedMode":"recent","expected":expected,"scopes":[{"parentId":null,"ids":[second_id,first_id]}]});
    let result = call(&ws, "hosts:reorder", request.clone()).await;
    assert_eq!(result["preferences"]["hostSort"], "manual");
    assert_eq!(call(&ws,"hosts:reveal-password",first_id.clone()).await,"order-test-secret");
    let file = profile.path().join("workspace.json");
    let saved = std::fs::read(&file).unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&saved).unwrap()["version"],3);
    assert!(dispatch(&ws,"hosts:reorder",request).await.is_err(),"Stale ordering must not overwrite newer positions");
    let expected = host_order::state(ws.store.lock().unwrap().data().unwrap(), "host");
    for ids in [json!([first_id]), json!([first_id,first_id]), json!([first_id,Uuid::new_v4()])] {
        assert!(dispatch(&ws,"hosts:reorder",json!({"kind":"host","mode":"manual","expectedMode":"manual","expected":expected,"scopes":[{"parentId":null,"ids":ids}]})).await.is_err());
        assert_eq!(std::fs::read(&file).unwrap(),saved);
    }
    // General editing ignores stale/client-supplied positions and keeps the stored one.
    let mut renamed = first;
    renamed["name"] = json!("renamed"); renamed["sortOrder"] = json!(0);
    call(&ws,"hosts:save",renamed).await;
    assert_eq!(ws.store.lock().unwrap().data().unwrap().host(id(&first_id).unwrap()).unwrap().sort_order,Some(1));
    call(&ws,"hosts:save",json!({"name":"new","address":"new.test","username":"ops","auth":"agent"})).await;
    assert_eq!(call(&ws,"hosts:list",Value::Null).await[2]["sortOrder"],2);
    let expected = host_order::state(ws.store.lock().unwrap().data().unwrap(), "host");
    call(&ws,"hosts:reorder",json!({"kind":"host","mode":"name-desc","expectedMode":"manual","expected":expected,"scopes":[]})).await;
    assert_eq!(ws.store.lock().unwrap().data().unwrap().host(id(&first_id).unwrap()).unwrap().sort_order,Some(1));
    let preferences = call(&ws,"preferences:get",Value::Null).await;
    let mut stale = preferences; stale["hostSort"] = json!("recent");
    assert_eq!(call(&ws,"preferences:save",stale).await["hostSort"],"name-desc");
    drop(ws);
    let ws = Workspace::new(profile.path().into(),home.path().into(),None).unwrap();
    assert_eq!(call(&ws,"preferences:get",Value::Null).await["hostSort"],"name-desc");
    assert_eq!(call(&ws,"hosts:reveal-password",first_id).await,"order-test-secret");
}

#[tokio::test]
async fn host_order_groups_and_backups_reject_old_format_rewrites() {
    let home = tempfile::tempdir().unwrap();
    let (_profile, ws) = make_workspace(home.path(), None);
    let result = call(&ws,"groups:save",json!({"group":{"name":"A"}})).await;
    let a = result["groups"][0]["id"].clone();
    let result = call(&ws,"groups:save",json!({"group":{"name":"B"}})).await;
    let b = result["groups"][1]["id"].clone();
    let result = call(&ws,"groups:save",json!({"group":{"name":"child","parentId":a}})).await;
    let child = result["groups"][2]["id"].clone();
    let expected = host_order::state(ws.store.lock().unwrap().data().unwrap(),"group");
    assert!(dispatch(&ws,"hosts:reorder",json!({"kind":"group","mode":"manual","expectedMode":"name-asc","expected":expected,"scopes":[{"parentId":null,"ids":[a,child,b]}]})).await.is_err());
    call(&ws,"hosts:reorder",json!({"kind":"group","mode":"manual","expectedMode":"name-asc","expected":expected,"scopes":[{"parentId":null,"ids":[b,a]},{"parentId":a,"ids":[child]}]})).await;
    call(&ws,"groups:save",json!({"group":{"name":"C"}})).await;
    let data = ws.store.lock().unwrap().data().unwrap().clone();
    assert_eq!(data.groups.last().unwrap().sort_order,Some(2));
    let mut restored = Data::default();
    restored.apply(store::portable_rows(data.snapshot()).unwrap(),None);
    assert_eq!(host_order::state(&restored,"group"),host_order::state(&data,"group"));
    assert_eq!(restored.preferences.group_sort,"manual","Display preference follows the shared settings");
    let (key, header) = vault::create("ordering password", &vault::recovery_code()).unwrap();
    for (scope,value) in [("local",json!(data)),("portable",json!({"hosts":data.snapshot()}))] {
        let envelope = vault::encode(&key,&header,scope,&value).unwrap();
        let mut serialized = serde_json::to_value(&envelope).unwrap();
        assert_eq!(serialized["version"],3);
        assert_eq!(envelope.decode::<Value>(&key,scope).unwrap(),value);
        serialized["version"] = json!(1);
        let tampered: vault::Envelope = serde_json::from_value(serialized).unwrap();
        assert!(tampered.decode::<Value>(&key,scope).is_err(),"Version is authenticated");
    }
    let legacy = vault::encode(&key,&header,"local",&Data::default()).unwrap();
    assert_eq!(serde_json::to_value(legacy).unwrap()["version"],1);
    let mut local: Value = serde_json::from_slice(&vault::encode_local(&key,&data).unwrap()).unwrap();
    assert_eq!(local["version"],3);
    local["version"] = json!(1);
    assert!(vault::decode_local::<Data>(&key,&serde_json::to_vec(&local).unwrap()).is_err());
}

#[tokio::test]
async fn host_order_failed_write_does_not_change_memory() {
    let home = tempfile::tempdir().unwrap();
    let (profile, ws) = make_workspace(home.path(),None);
    call(&ws,"hosts:save",json!({"address":"atomic.test","username":"ops","auth":"agent"})).await;
    let expected = host_order::state(ws.store.lock().unwrap().data().unwrap(),"host");
    let file = profile.path().join("workspace.json");
    let saved = profile.path().join("saved-workspace");
    std::fs::rename(&file,&saved).unwrap(); std::fs::create_dir(&file).unwrap();
    assert!(dispatch(&ws,"hosts:reorder",json!({"kind":"host","mode":"name-asc","expectedMode":"recent","expected":expected,"scopes":[]})).await.is_err());
    assert_eq!(ws.store.lock().unwrap().data().unwrap().preferences.host_sort,"recent");
    std::fs::remove_dir(&file).unwrap(); std::fs::rename(saved,file).unwrap();
}

#[tokio::test]
async fn host_order_import_and_group_removal_append_without_losing_positions() {
    let home = tempfile::tempdir().unwrap();
    let (_profile, ws) = make_workspace(home.path(),None);
    let result = call(&ws,"groups:save",json!({"group":{"name":"ordered"}})).await;
    let group_id = result["groups"][0]["id"].clone();
    call(&ws,"hosts:save",json!({"name":"A","address":"a.test","username":"ops","auth":"agent","groupId":group_id})).await;
    call(&ws,"hosts:save",json!({"name":"B","address":"b.test","username":"ops","auth":"agent","groupId":group_id})).await;
    let hosts = call(&ws,"hosts:list",Value::Null).await;
    let a = hosts[0]["id"].clone(); let b = hosts[1]["id"].clone();
    let expected = host_order::state(ws.store.lock().unwrap().data().unwrap(),"host");
    call(&ws,"hosts:reorder",json!({"kind":"host","mode":"manual","expectedMode":"recent","expected":expected,"scopes":[{"parentId":group_id,"ids":[b,a]}]})).await;
    call(&ws,"hosts:save",json!({"name":"root","address":"root.test","username":"ops","auth":"agent"})).await;
    let imported_group = Uuid::new_v4();
    call(&ws,"hosts:import",json!({"groups":[{"id":imported_group,"name":"ordered","sortOrder":0}],"rows":[{"name":"imported","address":"imported.test","username":"ops","auth":"agent","groupId":imported_group}]})).await;
    let result = call(&ws,"hosts:list",Value::Null).await;
    assert_eq!(result.as_array().unwrap().iter().find(|h|h["name"]=="imported").unwrap()["sortOrder"],2);
    let groups = call(&ws,"groups:list",Value::Null).await;
    call(&ws,"groups:delete",json!({"group":groups[0],"expected":groups[0],"expectedGroups":groups})).await;
    let mut hosts = ws.store.lock().unwrap().data().unwrap().hosts.clone();
    hosts.sort_by_key(|h|h.sort_order);
    assert_eq!(hosts.iter().map(|h|h.name.as_str()).collect::<Vec<_>>(),vec!["root","B","A","imported"]);
    assert!(hosts.iter().all(|h|h.group_id.is_none()));
}

#[tokio::test]
async fn shared_preferences_round_trip_excludes_device_settings_and_activity() {
    let home = tempfile::tempdir().unwrap();
    let (_profile, ws) = make_workspace(home.path(),None);
    let mut p=call(&ws,"preferences:get",Value::Null).await;
    p["theme"]=json!("light");p["terminalTheme"]=json!("light");p["fontFamily"]=json!("Example Font, monospace");p["fontSize"]=json!(19);p["recordCommands"]=json!(true);
    call(&ws,"preferences:save",p).await;
    call(&ws,"preferences:view",json!({"hostLayout":"tree","navigationCollapsed":true})).await;
    let expected=host_order::state(ws.store.lock().unwrap().data().unwrap(),"host");
    call(&ws,"hosts:reorder",json!({"kind":"host","mode":"name-desc","expectedMode":"recent","expected":expected,"scopes":[]})).await;
    let mut source=ws.store.lock().unwrap().data().unwrap().clone();
    source.transfer_history.push(json!({"name":"private-transfer-marker"}));
    source.command_history.push(json!({"command":"private-history-marker"}));
    source.git_settings.on_unlock=true;
    let rows=source.snapshot();
    let serialized=serde_json::to_string(&rows).unwrap();
    for excluded in ["recordCommands","private-transfer-marker","private-history-marker","gitSettings","localSecrets","lockSettings"] { assert!(!serialized.contains(excluded),"{excluded}"); }
    let mut target=Data::default();
    target.preferences.record_commands=true;
    target.transfer_history.push(json!({"name":"target-transfer"}));
    target.command_history.push(json!({"command":"target-history"}));
    target.lock_settings.auto_lock_minutes=Some(7);
    target.apply(store::portable_rows(rows).unwrap(),None);
    assert_eq!(target.preferences.theme,"light");assert_eq!(target.preferences.font_size,19);
    assert_eq!(target.preferences.font_family,"Example Font, monospace");
    assert_eq!(target.preferences.host_layout.as_deref(),Some("tree"));assert_eq!(target.preferences.navigation_collapsed,Some(true));
    assert_eq!(target.preferences.host_sort,"name-desc");assert!(target.preferences.record_commands);
    assert!(!target.git_settings.on_unlock);assert_eq!(target.lock_settings.auto_lock_minutes,Some(7));
    assert_eq!(target.transfer_history[0]["name"],"target-transfer");assert_eq!(target.command_history[0]["command"],"target-history");
    let (key,header)=vault::create("shared settings password",&vault::recovery_code()).unwrap();
    let envelope=vault::encode(&key,&header,"portable",&json!({"hosts":source.snapshot()})).unwrap();
    let mut value=serde_json::to_value(&envelope).unwrap();assert_eq!(value["version"],3);
    assert!(envelope.decode::<git::Snapshot>(&key,"portable").is_ok());
    value["version"]=json!(2);
    assert!(serde_json::from_value::<vault::Envelope>(value).unwrap().decode::<git::Snapshot>(&key,"portable").is_err());
    let local=vault::encode_local(&key,&source).unwrap();assert_eq!(serde_json::from_slice::<Value>(&local).unwrap()["version"],3);
    assert_eq!(vault::decode_local::<Data>(&key,&local).unwrap().preferences.font_size,19);
}

#[tokio::test]
async fn shared_preferences_are_validated_and_do_not_block_empty_workspace_restore() {
    let home=tempfile::tempdir().unwrap();let (profile,ws)=make_workspace(home.path(),None);
    call(&ws,"preferences:view",json!({"hostLayout":"rows","navigationCollapsed":null})).await;
    assert!(ws.store.lock().unwrap().ensure_empty().is_ok());
    let file=profile.path().join("workspace.json");let before=std::fs::read(&file).unwrap();
    for invalid in [json!({"hostLayout":"invalid"}),json!({"hostLayout":"cards","navigationCollapsed":"false"}),json!({"hostLayout":"cards","token":"not allowed"})] {
        assert!(dispatch(&ws,"preferences:view",invalid).await.is_err());assert_eq!(std::fs::read(&file).unwrap(),before);
    }
    let data=ws.store.lock().unwrap().data().unwrap().clone();
    let shared=data.snapshot().into_iter().find(|r|r.id()==shared_preferences::ID).unwrap();
    for (field,bad) in [("version",json!(99)),("fontSize",json!(100)),("hostLayout",json!("invalid")),("id",json!(Uuid::new_v4()))] {
        let mut value=json!(shared);value["asset"]["value"][field]=bad;
        let row:store::Row=serde_json::from_value(value).unwrap();assert!(store::portable_rows(vec![row]).is_err());
    }
    let mut target=data;target.preferences.theme="light".into();
    target.apply(vec![],None);assert_eq!(target.preferences.theme,"light","Legacy snapshots leave current preferences intact");
    drop(ws);let ws=Workspace::new(profile.path().into(),home.path().into(),None).unwrap();
    assert_eq!(call(&ws,"preferences:get",Value::Null).await["hostLayout"],"rows");
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "requires isolated HTTPS Git fixture"]
async fn shared_preferences_sync_between_workspaces_and_resolve_conflicts() {
    let fixture=PathBuf::from(std::env::var_os("TERMLUME_TEST_FIXTURE").unwrap());
    let port=std::fs::read_to_string(fixture.join("https-port")).unwrap();
    let remote=format!("https://127.0.0.1:{port}/repo.git");let branch="vault/shared-preferences";
    let auth=json!({"username":"fixture","token":"test-repository-token"});let password="shared preferences password";
    let (_a,ws)=make_workspace(&fixture,None);let (_b,other)=make_workspace(&fixture,None);
    let mut p=call(&ws,"preferences:get",Value::Null).await;p["fontSize"]=json!(18);p["recordCommands"]=json!(true);
    call(&ws,"preferences:save",p).await;call(&ws,"preferences:view",json!({"hostLayout":"rows","navigationCollapsed":false})).await;
    call(&ws,"vault:enable",json!({"password":password,"recovery":vault::recovery_code()})).await;
    call(&ws,"vault:sync",json!({"address":remote,"branch":branch,"auth":auth})).await;
    // A fresh app has already migrated its local view; that must still allow restore.
    call(&other,"preferences:view",json!({"hostLayout":"cards","navigationCollapsed":null})).await;
    call(&other,"vault:restore-git",json!({"address":remote,"branch":branch,"auth":auth,"secret":password})).await;
    let imported=call(&other,"preferences:get",Value::Null).await;
    assert_eq!(imported["fontSize"],18);assert_eq!(imported["hostLayout"],"rows");assert_eq!(imported["recordCommands"],false);
    call(&other,"preferences:view",json!({"hostLayout":"tree","navigationCollapsed":true})).await;
    call(&other,"vault:sync",json!({})).await;call(&ws,"vault:sync",json!({"pullOnly":true})).await;
    assert_eq!(call(&ws,"preferences:get",Value::Null).await["hostLayout"],"tree");
    assert_eq!(call(&ws,"preferences:get",Value::Null).await["recordCommands"],true);
    let mut local=call(&ws,"preferences:get",Value::Null).await;local["theme"]=json!("light");call(&ws,"preferences:save",local).await;
    let mut remote_p=call(&other,"preferences:get",Value::Null).await;remote_p["fontSize"]=json!(21);call(&other,"preferences:save",remote_p).await;
    call(&other,"vault:sync",json!({})).await;
    let conflict=call(&ws,"vault:sync",json!({})).await;
    assert_eq!(conflict["conflicts"].as_array().unwrap().len(),1);
    assert_eq!(conflict["conflicts"][0]["local"]["recordType"],"preferences");
    let choices=json!({shared_preferences::ID.to_string():"remote"});
    call(&ws,"vault:sync",json!({"ticket":conflict["ticket"],"choices":choices})).await;
    let final_p=call(&ws,"preferences:get",Value::Null).await;assert_eq!(final_p["fontSize"],21);assert_eq!(final_p["recordCommands"],true);
}
