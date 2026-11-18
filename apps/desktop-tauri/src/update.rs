use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::patch::{apply_patch, delta_asset_name, delta_meta_name, sha256_hex};

/**
 * 桌面端更新（迁移切片 5）。2026-11-18 Owner 裁决：
 * **mac/Windows 都要增量，只保留上一版**，方案为自研补丁包（qbsdiff），
 * 因此不再使用 tauri-plugin-updater（它只支持整包）。
 *
 * 链路：
 *  1. 检查：自家 API `/updates/desktop/latest-mac.yml`（electron-builder 清单，
 *     与 Electron 版同一份；Windows 用 `latest.yml`），进程内缓存 6 小时。
 *  2. 增量：发布流水线在 release 资产旁产出
 *     `astella-<to>-from-<from>.qbsdiff` + `.json`（patch/结果 sha256）。
 *     客户端把补丁抹到**当前主二进制**上，核对结果的 sha256；没有补丁就回退整包。
 *  3. 安装：macOS 写 `install.sh`（等本进程退出 → 替换二进制 → 重开）；
 *     Windows 的安装器切片后续实现，当前如实报 `failed`。
 */
const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct UpdateState {
    cached: tokio::sync::Mutex<Option<(Instant, Value)>>,
    live: tokio::sync::Mutex<Option<Value>>,
    staged: tokio::sync::Mutex<Option<Staged>>,
    gate: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
struct Staged {
    payload: PathBuf,
    mode: &'static str,
}

pub fn bridge() -> &'static UpdateState {
    static STATE: OnceLock<UpdateState> = OnceLock::new();
    STATE.get_or_init(|| UpdateState {
        cached: tokio::sync::Mutex::new(None),
        live: tokio::sync::Mutex::new(None),
        staged: tokio::sync::Mutex::new(None),
        gate: tokio::sync::Mutex::new(()),
    })
}

fn base_state(phase: &str) -> Value {
    json!({
        "phase": phase,
        "currentVersion": CURRENT_VERSION,
        "availableVersion": null,
        "releaseNotes": null,
        "releaseName": null,
        "releaseDate": null,
        "fileSize": null,
        "releaseUrl": null,
        "percent": null,
        "transferred": null,
        "total": null,
        "message": null,
        "installBlockedReason": null,
    })
}

#[derive(Clone, Debug, PartialEq)]
struct Manifest {
    version: String,
    url: String,
    sha512: String,
    size: u64,
}

fn parse_manifest(text: &str) -> Option<Manifest> {
    let mut version = None;
    let mut url = None;
    let mut sha512 = None;
    let mut size = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("version:") {
            version = Some(value.trim().trim_matches('"').to_string());
        } else if let Some(value) = trimmed.strip_prefix("- url:").or_else(|| trimmed.strip_prefix("url:")) {
            if url.is_none() {
                url = Some(value.trim().trim_matches('"').to_string());
            }
        } else if let Some(value) = trimmed.strip_prefix("sha512:") {
            if sha512.is_none() {
                sha512 = Some(value.trim().trim_matches('"').to_string());
            }
        } else if let Some(value) = trimmed.strip_prefix("size:") {
            if size.is_none() {
                size = value.trim().parse().ok();
            }
        }
    }
    Some(Manifest { version: version?, url: url?, sha512: sha512?, size: size? })
}

#[derive(Clone, Debug, PartialEq)]
struct DeltaMeta {
    from: String,
    to: String,
    patch_sha256: String,
    result_sha256: String,
}

fn parse_delta_meta(value: &Value) -> Option<DeltaMeta> {
    Some(DeltaMeta {
        from: value.get("from")?.as_str()?.to_string(),
        to: value.get("to")?.as_str()?.to_string(),
        patch_sha256: value.get("patchSha256")?.as_str()?.to_string(),
        result_sha256: value.get("resultSha256")?.as_str()?.to_string(),
    })
}

fn platform_manifest_name() -> &'static str {
    if cfg!(target_os = "windows") { "latest.yml" } else { "latest-mac.yml" }
}

fn api_origin() -> String {
    std::env::var("DESKTOP_API_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:4000".to_string())
}

fn manifest_url() -> String {
    format!("{}/updates/desktop/{}", api_origin().trim_end_matches('/'), platform_manifest_name())
}

fn version_is_newer(candidate: &str, current: &str) -> bool {
    let parse = |value: &str| -> Option<Vec<u64>> {
        let mut parts = Vec::new();
        for segment in value.trim().trim_start_matches('v').split('.') {
            let digits: String = segment.chars().take_while(|c| c.is_ascii_digit()).collect();
            parts.push(digits.parse().ok()?);
            if parts.len() == 3 {
                break;
            }
        }
        (parts.len() == 3).then_some(parts)
    };
    matches!((parse(candidate), parse(current)), (Some(a), Some(b)) if a > b)
}

fn release_directory(full_url: &str) -> Option<String> {
    full_url.rsplit_once('/').map(|(base, _)| base.to_string())
}

async fn fetch_manifest(client: &reqwest::Client) -> Result<Manifest, String> {
    let response = client
        .get(manifest_url())
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|_| "这次没有拿到更新信息（更新源不可达）。".to_string())?;
    if !response.status().is_success() {
        return Err("这次没有拿到更新信息（更新源暂时不可用）。".to_string());
    }
    let text = response.text().await.map_err(|_| "更新清单无法读取。".to_string())?;
    parse_manifest(&text).ok_or_else(|| "更新清单缺少必需字段。".to_string())
}

impl UpdateState {
    pub async fn state(&self) -> Value {
        if let Some(live) = self.live.lock().await.as_ref() {
            return live.clone();
        }
        match self.cached.lock().await.as_ref() {
            Some((at, value)) if at.elapsed() < CACHE_TTL => value.clone(),
            _ => base_state("idle"),
        }
    }

    pub async fn check(&self, force: bool) -> Value {
        if !force {
            if let Some((at, value)) = self.cached.lock().await.as_ref() {
                if at.elapsed() < CACHE_TTL {
                    return value.clone();
                }
            }
        }
        let client = reqwest::Client::new();
        let state = match fetch_manifest(&client).await {
            Ok(manifest) => {
                let mut state = base_state(if version_is_newer(&manifest.version, CURRENT_VERSION) {
                    "available"
                } else {
                    "upToDate"
                });
                state["availableVersion"] = json!(manifest.version);
                state["fileSize"] = json!(manifest.size);
                state["releaseUrl"] = json!(manifest.url);
                state
            }
            Err(message) => {
                let mut state = base_state("unreachable");
                state["message"] = json!(message);
                state
            }
        };
        *self.cached.lock().await = Some((Instant::now(), state.clone()));
        state
    }

    pub fn start_download(&'static self, user_data: PathBuf) {
        tauri::async_runtime::spawn(async move {
            let _gate = self.gate.lock().await;
            let client = reqwest::Client::new();
            let manifest = match fetch_manifest(&client).await {
                Ok(manifest) => manifest,
                Err(message) => return self.fail(&message).await,
            };
            if !version_is_newer(&manifest.version, CURRENT_VERSION) {
                return self.fail("当前已经是最新版本。").await;
            }
            if tokio::fs::create_dir_all(&user_data).await.is_err() {
                return self.fail("更新暂存目录无法创建。").await;
            }
            let mut live = base_state("downloading");
            live["availableVersion"] = json!(manifest.version);
            live["transferred"] = json!(0);
            *self.live.lock().await = Some(live);

            match self.try_delta(&client, &manifest, &user_data).await {
                Ok(Some(staged)) => {
                    *self.staged.lock().await = Some(staged);
                    let mut ready = base_state("ready");
                    ready["availableVersion"] = json!(manifest.version);
                    ready["percent"] = json!(100);
                    *self.live.lock().await = Some(ready);
                    return;
                }
                Ok(None) => {}
                Err(message) => return self.fail(&message).await,
            }
            // 没有可用补丁：如实说明需要整包（整包安装随安装器切片实现）。
            self.fail("这一版没有可用的增量补丁；请到下载页获取完整安装包。").await;
            let _ = &manifest.sha512;
        });
    }

    async fn try_delta(
        &self,
        client: &reqwest::Client,
        manifest: &Manifest,
        directory: &std::path::Path,
    ) -> Result<Option<Staged>, String> {
        let Some(base) = release_directory(&manifest.url) else { return Ok(None) };
        let meta_url = format!("{base}/{}", delta_meta_name(&manifest.version, CURRENT_VERSION));
        let meta = match client.get(&meta_url).timeout(Duration::from_secs(10)).send().await {
            Ok(response) if response.status().is_success() => {
                response.json::<Value>().await.ok().and_then(|value| parse_delta_meta(&value))
            }
            _ => None,
        };
        let Some(meta) = meta else {
            return Ok(None);
        };
        if meta.from != CURRENT_VERSION || meta.to != manifest.version {
            return Ok(None);
        }
        let patch_url = format!("{base}/{}", delta_asset_name(&manifest.version, CURRENT_VERSION));
        let patch_bytes = client
            .get(&patch_url)
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .map_err(|_| "增量补丁下载失败（网络不可达）。".to_string())?
            .bytes()
            .await
            .map_err(|_| "增量补丁下载中断。".to_string())?;
        if sha256_hex(&patch_bytes) != meta.patch_sha256 {
            return Err("增量补丁校验未通过，请稍后重试。".to_string());
        }
        let current_exe = std::env::current_exe().map_err(|_| "无法定位当前应用。".to_string())?;
        let old_bytes = tokio::fs::read(&current_exe).await.map_err(|_| "无法读取当前应用。".to_string())?;
        let new_bytes = apply_patch(&old_bytes, &patch_bytes)?;
        if sha256_hex(&new_bytes) != meta.result_sha256 {
            return Err("增量补丁生成了错误的应用，已中止。".to_string());
        }
        let payload = directory.join(format!("pending-{}", manifest.version));
        tokio::fs::write(&payload, &new_bytes).await.map_err(|_| "更新暂存目录不可写。".to_string())?;
        Ok(Some(Staged { payload, mode: "delta" }))
    }

    pub async fn install(&self) -> Value {
        let staged = self.staged.lock().await.clone();
        let Some(staged) = staged else {
            return self.fail_value("没有已下载的更新包，请先下载。");
        };
        if staged.mode != "delta" {
            return self.fail_value("整包安装还未移植；请到下载页获取完整安装包。");
        }
        let Ok(current_exe) = std::env::current_exe() else {
            return self.fail_value("无法定位当前应用。");
        };
        #[cfg(target_os = "windows")]
        {
            let script = match write_windows_install_script(&staged.payload, &current_exe) {
                Ok(script) => script,
                Err(message) => return self.fail_value(&message),
            };
            let _ = std::process::Command::new("cmd")
                .arg("/C")
                .arg(&script)
                .spawn();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let Some(app_bundle) = current_exe.ancestors().nth(3) else {
                return self.fail_value("无法定位应用包（.app）。");
            };
            let script = match write_macos_install_script(&staged.payload, &current_exe, app_bundle) {
                Ok(script) => script,
                Err(message) => return self.fail_value(&message),
            };
            let _ = std::process::Command::new("/bin/sh").arg(&script).spawn();
        }
        base_state("ready")
    }

    async fn fail(&self, message: &str) {
        let state = self.fail_value(message);
        *self.live.lock().await = Some(state);
    }

    fn fail_value(&self, message: &str) -> Value {
        let mut state = base_state("failed");
        state["message"] = json!(message);
        state
    }
}

/// Windows 安装脚本：等本进程退出（被占用时可覆盖 exe）→ 覆盖 → 启动 → 自删。
/// 纯字符串构造，macOS 上也能单测其内容。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn write_windows_install_script(
    payload: &std::path::Path,
    executable: &std::path::Path,
) -> Result<PathBuf, String> {
    let script_path = std::env::temp_dir().join(format!("astella-tauri-install-{}.bat", std::process::id()));
    let body = format!(
        "@echo off\r\nsetlocal\r\n:wait\r\ntasklist /FI \"PID eq {pid}\" 2>/dev/null | find \"{pid}\" >NUL\r\nif not errorlevel 1 (\r\n  timeout /t 1 /nobreak >NUL\r\n  goto wait\r\n)\r\ncopy /Y \"{payload}\" \"{executable}\" >NUL\r\nstart \"\" \"{executable}\"\r\n(goto) 2>/dev/null & del \"%~f0\"\r\n",
        pid = std::process::id(),
        payload = payload.display(),
        executable = executable.display(),
    );
    std::fs::write(&script_path, body).map_err(|_| "无法写入安装脚本。".to_string())?;
    Ok(script_path)
}

#[cfg(not(target_os = "windows"))]
fn write_macos_install_script(payload: &std::path::Path, executable: &std::path::Path, app_bundle: &std::path::Path) -> Result<PathBuf, String> {
    let script_path = std::env::temp_dir().join(format!("astella-tauri-install-{}.sh", std::process::id()));
    let body = format!(
        "#!/bin/sh\nPID={pid}\nwhile kill -0 \"$PID\" 2>/dev/null; do sleep 0.2; done\ncp \"{payload}\" \"{executable}\"\nchmod +x \"{executable}\"\nopen -n \"{bundle}\"\nrm -f \"$0\"\n",
        pid = std::process::id(),
        payload = payload.display(),
        executable = executable.display(),
        bundle = app_bundle.display(),
    );
    std::fs::write(&script_path, body).map_err(|_| "无法写入安装脚本。".to_string())?;
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o700));
    Ok(script_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_electron_builder_manifest() {
        let text = "version: 2.0.7\nfiles:\n  - url: https://example.com/c-v2.0.7/astella-2.0.7-mac-arm64.zip\n    sha512: abc==\n    size: 999\n";
        let manifest = parse_manifest(text).expect("manifest");
        assert_eq!(manifest.version, "2.0.7");
        assert_eq!(manifest.size, 999);
        assert_eq!(release_directory(&manifest.url).as_deref(), Some("https://example.com/c-v2.0.7"));
    }

    #[test]
    fn compares_versions() {
        assert!(version_is_newer("2.0.7", "2.0.6"));
        assert!(!version_is_newer("2.0.6", "2.0.6"));
        assert!(!version_is_newer("x", "2.0.6"));
    }

    #[test]
    fn windows_install_script_waits_replaces_and_relaunches() {
        let script = write_windows_install_script(
            std::path::Path::new("C:/temp/pending-2.0.7"),
            std::path::Path::new("C:/Apps/Astella/Astella.exe"),
        )
        .expect("script");
        let body = std::fs::read_to_string(&script).expect("read script");
        assert!(body.contains(":wait"));
        assert!(body.contains("C:/Apps/Astella/Astella.exe"));
        assert!(body.contains("C:/temp/pending-2.0.7"));
        assert!(body.contains("start \"\""));
        let _ = std::fs::remove_file(script);
    }

    #[test]
    fn parses_delta_meta() {
        let meta = parse_delta_meta(&json!({
            "from": "2.0.6", "to": "2.0.7",
            "patchSha256": "a", "resultSha256": "b"
        }))
        .expect("meta");
        assert_eq!(meta.from, "2.0.6");
        assert_eq!(meta.to, "2.0.7");
    }
}
