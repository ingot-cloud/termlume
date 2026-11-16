use crate::{store::Data, Workspace};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use uuid::Uuid;

pub fn state(data: &Data, kind: &str) -> Value {
    let mut rows: Vec<_> = if kind == "group" {
        data.groups
            .iter()
            .map(|g| (g.id, g.parent_id, g.sort_order))
            .collect()
    } else {
        data.hosts
            .iter()
            .map(|h| (h.id, h.group_id, h.sort_order))
            .collect()
    };
    rows.sort_by_key(|r| r.0);
    json!(rows
        .into_iter()
        .map(|(id, parent, order)| json!({"id":id,"parentId":parent,"sortOrder":order}))
        .collect::<Vec<_>>())
}

pub fn next(data: &Data, kind: &str, parent: Option<Uuid>) -> Option<u32> {
    let orders: Vec<_> = if kind == "group" {
        data.groups
            .iter()
            .filter(|g| g.parent_id == parent)
            .filter_map(|g| g.sort_order)
            .collect()
    } else {
        data.hosts
            .iter()
            .filter(|h| h.group_id == parent)
            .filter_map(|h| h.sort_order)
            .collect()
    };
    orders
        .into_iter()
        .max()
        .map(|order| order.saturating_add(1))
        .or_else(|| {
            let mode = if kind == "group" {
                &data.preferences.group_sort
            } else {
                &data.preferences.host_sort
            };
            (mode == "manual").then_some(0)
        })
}

pub fn append_unordered(data: &mut Data) {
    for i in 0..data.groups.len() {
        if data.groups[i].sort_order.is_none() {
            data.groups[i].sort_order = next(data, "group", data.groups[i].parent_id);
        }
    }
    for i in 0..data.hosts.len() {
        if data.hosts[i].sort_order.is_none() {
            data.hosts[i].sort_order = next(data, "host", data.hosts[i].group_id);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    parent_id: Option<Uuid>,
    ids: Vec<Uuid>,
}

pub fn request(ws: &Workspace, value: Value) -> Result<Value, String> {
    let kind = value["kind"].as_str().ok_or("排序类型无效。")?;
    let mode = value["mode"].as_str().ok_or("排序方式无效。")?;
    if !matches!(kind, "host" | "group")
        || !matches!(mode, "name-asc" | "name-desc" | "manual" | "recent")
        || kind == "group" && mode == "recent"
    {
        return Err("排序类型或方式无效。".into());
    }
    let scopes: Vec<Scope> = crate::parse(value["scopes"].clone())?;
    let mut store = ws.store.lock().unwrap();
    let mut data = store.data()?.clone();
    let previous_mode = if kind == "group" {
        &data.preferences.group_sort
    } else {
        &data.preferences.host_sort
    };
    if state(&data, kind) != value["expected"] || value["expectedMode"] != *previous_mode {
        return Err("主机、分组或顺序已变化，请刷新后重试。".into());
    }
    if mode != "manual" && !scopes.is_empty() {
        return Err("自动排序不能修改手动位置。".into());
    }
    let mut parents = HashSet::new();
    for scope in &scopes {
        if !parents.insert(scope.parent_id)
            || scope
                .parent_id
                .is_some_and(|id| !data.groups.iter().any(|g| g.id == id))
        {
            return Err("排序父级无效。".into());
        }
        let current: HashSet<_> = if kind == "group" {
            data.groups
                .iter()
                .filter(|g| g.parent_id == scope.parent_id)
                .map(|g| g.id)
                .collect()
        } else {
            data.hosts
                .iter()
                .filter(|h| h.group_id == scope.parent_id)
                .map(|h| h.id)
                .collect()
        };
        let requested: HashSet<_> = scope.ids.iter().copied().collect();
        if requested.len() != scope.ids.len() || requested != current {
            return Err("请提交完整的同级顺序，不能跨分组排序。".into());
        }
        for (index, id) in scope.ids.iter().enumerate() {
            if kind == "group" {
                data.groups
                    .iter_mut()
                    .find(|g| g.id == *id)
                    .unwrap()
                    .sort_order = Some(index as u32);
            } else {
                data.hosts
                    .iter_mut()
                    .find(|h| h.id == *id)
                    .unwrap()
                    .sort_order = Some(index as u32);
            }
        }
    }
    if kind == "group" {
        data.preferences.group_sort = mode.into();
    } else {
        data.preferences.host_sort = mode.into();
    }
    let result = json!({"hosts":data.connection_hosts(),"groups":crate::assets::groups(&data),"preferences":data.preferences});
    store.update(data)?;
    Ok(result)
}
