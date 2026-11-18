use std::io;
use std::path::{Path, PathBuf};

use tokio::fs;
use tokio::io::AsyncWriteExt;

/**
 * 会话凭据的本地文件（迁移切片 2）。
 *
 * 与 Electron 版的不同是**文件名**：旧版用 `safeStorage`（macOS 钥匙串）加密，
 * 新壳读不了那份密文，也不能共用同一个文件——两边各自升级会把对方的格式反复
 * 重写成自己认得的，最后谁都不认。所以新壳用独立的 `session-credential-tauri-v1.txt`：
 * 迁移期两个壳各自持有自己的会话；切成单壳后这份文件就是权威。
 *
 * 存储形态按 Owner 裁决：0600 明文文件，不走钥匙串、不弹系统授权。文件里
 * 只有一枚短期会话令牌，服务端 401 即作废。
 */
pub struct FileSessionCredentialStore {
    file: PathBuf,
    temporary: PathBuf,
    /// Electron 版（加密格式）的文件路径：只用来**识别并避开**，不读不写。
    foreign: PathBuf,
}

const ELECTRON_ENCRYPTED_PREFIX: &str = "astella-safe-storage-v1:";

impl FileSessionCredentialStore {
    pub fn new(user_data_dir: &Path) -> Self {
        let file = user_data_dir.join("session-credential-tauri-v1.txt");
        let temporary = user_data_dir.join("session-credential-tauri-v1.txt.tmp");
        let foreign = user_data_dir.join("session-credential-local-v1.txt");
        Self { file, temporary, foreign }
    }

    pub fn file_path(&self) -> &Path {
        &self.file
    }

    /// 同步的「有没有存过」：运行快照在凭据被采纳之前就要回答这一格。
    pub fn has_stored(&self) -> bool {
        self.file.is_file() || self.foreign.is_file()
    }

    /// 读不出来就当没有：一次偶发的读取失败不该让人重登。
    pub async fn load(&self) -> Option<String> {
        let raw = fs::read_to_string(&self.file).await.ok()?;
        if raw.starts_with(ELECTRON_ENCRYPTED_PREFIX) {
            // 不可能出现在这个文件名下；防御处理，绝不把密文当令牌用。
            return None;
        }
        let token = raw.trim();
        if token.is_empty() { None } else { Some(token.to_string()) }
    }

    pub async fn save(&self, token: &str) -> io::Result<()> {
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).await?;
        }
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options.open(&self.temporary).await?;
        handle.write_all(token.as_bytes()).await?;
        handle.flush().await?;
        drop(handle);
        fs::rename(&self.temporary, &self.file).await
    }

    pub async fn clear(&self) -> io::Result<()> {
        let _ = fs::remove_file(&self.file).await;
        let _ = fs::remove_file(&self.temporary).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "astella-tauri-credentials-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn saves_and_loads_with_owner_only_permissions() {
        let dir = scratch_dir();
        let store = FileSessionCredentialStore::new(&dir);
        assert!(!store.has_stored());
        assert!(store.load().await.is_none());

        store.save("token-abc").await.expect("save");
        assert!(store.has_stored());
        assert_eq!(store.load().await.as_deref(), Some("token-abc"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(store.file_path()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        store.clear().await.expect("clear");
        assert!(!store.has_stored());
        assert!(store.load().await.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn never_returns_the_electron_encrypted_payload_as_a_token() {
        let dir = scratch_dir();
        let store = FileSessionCredentialStore::new(&dir);
        tokio::fs::write(store.file_path(), "astella-safe-storage-v1:AAAA").await.unwrap();
        assert!(store.load().await.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn electron_credential_file_is_recognised_but_never_touched() {
        let dir = scratch_dir();
        let store = FileSessionCredentialStore::new(&dir);
        let electron = dir.join("session-credential-local-v1.txt");
        tokio::fs::write(&electron, "astella-safe-storage-v1:AAAA").await.unwrap();
        assert!(store.has_stored(), "Electron 已登录时，门的文案应说本机有凭据");
        assert!(store.load().await.is_none(), "但密文不会被当成令牌");
        store.clear().await.unwrap();
        assert!(electron.exists(), "清除新壳凭据不能删掉旧壳的文件");
        std::fs::remove_dir_all(&dir).ok();
    }
}