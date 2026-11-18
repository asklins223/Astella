use serde_json::{json, Value};

use crate::gateway::{ConfigurationError, GatewayConfig, CONTRACT_VERSION};

/**
 * 合同快照（迁移切片 3）。与 Electron `contractSnapshot()` 同一份判据：
 * 渲染层的 `inspectDesktopContract` 只认三件事——合同版本、必需命名空间、
 * `room.home` 这条路由。值来自 `@astella/shared/desktop-ipc-contracts` 的枚举，
 * 两侧同时变更时以共享合同为准。
 */
const NAMESPACES: &[&str] = &[
    "runtime", "navigation", "auth", "workspace", "capabilities", "room", "source",
    "note", "understanding", "search", "companion", "settings", "window", "subscriptions",
];

pub(crate) const ROUTES: &[&str] = &[
    "auth.login", "auth.register", "room.home", "source.library", "source.detail",
    "note.library", "note.detail", "note.artifact", "understanding.graph", "search.global",
    "settings.section", "companion.center", "companion.drawer",
];

pub fn contract_snapshot(config: Result<&GatewayConfig, ConfigurationError>) -> Value {
    let (domain_revision, deployment_revision) = match config {
        Ok(config) => (config.expected_domain_schema_revision.clone(), config.config_revision.clone()),
        Err(_) => ("unconfigured".to_string(), "unconfigured".to_string()),
    };
    json!({
        "version": 1,
        "contractVersion": CONTRACT_VERSION,
        "domainSchemaRevision": domain_revision,
        "deploymentConfigRevision": deployment_revision,
        "namespaces": NAMESPACES,
        "enabledRoutes": ROUTES,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_carries_the_gate_requirements() {
        let contract = contract_snapshot(Err(ConfigurationError::Missing));
        assert_eq!(contract["contractVersion"], CONTRACT_VERSION);
        for namespace in ["runtime", "auth", "workspace", "room", "subscriptions"] {
            assert!(contract["namespaces"].as_array().unwrap().iter().any(|value| value == namespace));
        }
        assert!(contract["enabledRoutes"].as_array().unwrap().iter().any(|value| value == "room.home"));
        assert_eq!(contract["domainSchemaRevision"], "unconfigured");
    }
}
