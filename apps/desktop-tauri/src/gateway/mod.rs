pub mod config;
pub mod credentials;
pub mod transport;

pub use config::{ConfigurationError, GatewayConfig, OriginKind};
pub use credentials::FileSessionCredentialStore;
pub use transport::{ConnectionState, Gateway, GatewayFailure};

/// 与 `@astella/shared/desktop-ipc-contracts` 的 `DESKTOP_IPC_CONTRACT_VERSION` 同值。
/// 合同版本是信任握手与合同快照的判据，两侧数字必须永远一致。
pub const CONTRACT_VERSION: &str = "desktop-ipc-v1";
/// `DESKTOP_API_SERVICE_ID`：信任握手回执里的服务名。
pub const API_SERVICE_ID: &str = "astella-api";