use serde_json::{json, Value};

/**
 * `/auth/me` 回执 → `SessionContextV1`（迁移切片 3）。
 *
 * 字段来源见 Electron `rawAuthMeSchema`：服务端边界令牌（workspaceEpoch）是
 * 本机纪元的权威值，缺了或形状不对就按契约不符处理，不悄悄退回本地计数。
 */
pub fn anonymous_session() -> Value {
    json!({
        "version": 1,
        "status": "anonymous",
        "user": null,
        "workspace": null,
        "membership": null,
        "capabilities": null,
        "workspaceEpoch": 0,
        "credentialPersistence": "none",
    })
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

pub fn authenticated_session(
    me: &Value,
    persistence: &str,
    deployment_ref: &str,
) -> Option<Value> {
    let user_id = string(me, "userId")?;
    let workspace_id = string(me, "workspaceId")?;
    let email = string(me, "email")?;
    let role = string(me, "role")?;
    let workspace_name = string(me, "workspaceName")?;
    let workspace_type = string(me, "workspaceType")?;
    let is_personal = me.get("isPersonal")?.as_bool()?;
    let workspace_epoch = me.get("workspaceEpoch")?.as_u64()?;
    if !matches!(role.as_str(), "owner" | "member")
        || !matches!(workspace_type.as_str(), "personal" | "collaborative")
        || workspace_epoch == 0
    {
        return None;
    }
    let display_name = me.get("displayName").and_then(Value::as_str);
    let user = match display_name {
        Some(name) if !name.is_empty() => json!({
            "userId": user_id,
            "email": email,
            "displayName": name,
        }),
        _ => json!({ "userId": user_id, "email": email }),
    };
    Some(json!({
        "version": 1,
        "status": "authenticated",
        "deploymentRef": deployment_ref,
        "user": user,
        "workspace": {
            "version": 1,
            "workspaceId": workspace_id,
            "name": workspace_name,
            "role": role,
            "workspaceType": workspace_type,
            "isPersonal": is_personal,
            "workspaceEpoch": workspace_epoch,
        },
        "membership": { "role": role },
        "capabilities": null,
        "workspaceEpoch": workspace_epoch,
        "credentialPersistence": persistence,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me() -> Value {
        json!({
            "userId": "11111111-2222-4333-8444-555555555555",
            "workspaceId": "11111111-2222-4333-8444-666666666666",
            "email": "learner@example.com",
            "role": "owner",
            "displayName": "拾星",
            "avatarUrl": null,
            "workspaceName": "我的书房",
            "workspaceType": "personal",
            "isPersonal": true,
            "personalWorkspaceId": null,
            "workspaceEpoch": 7,
        })
    }

    #[test]
    fn maps_auth_me_to_the_session_contract() {
        let session = authenticated_session(&me(), "local_file", "http://127.0.0.1:4000").expect("valid");
        assert_eq!(session["status"], "authenticated");
        assert_eq!(session["workspaceEpoch"], 7);
        assert_eq!(session["user"]["displayName"], "拾星");
        assert_eq!(session["workspace"]["workspaceEpoch"], 7);
        assert_eq!(session["membership"]["role"], "owner");
    }

    #[test]
    fn rejects_a_missing_boundary_token() {
        let mut broken = me();
        broken["workspaceEpoch"] = json!(null);
        assert!(authenticated_session(&broken, "local_file", "ref").is_none());
    }
}
