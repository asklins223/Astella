pub mod contract;
pub mod dispatch;
pub mod session;

pub const SHIM: &str = include_str!("shim.js");

/// 注入到页面脚本之前的引导脚本：合同快照 + 平台 + 桥本体。
/// 合同必须是**真实快照**（来自部署配置），渲染层的合同门只认这一份。
pub fn boot_script(contract: &serde_json::Value) -> String {
    format!(
        "window.__ASTELLA_BOOT__ = {{\"contract\": {}, \"platform\": \"darwin\", \"version\": \"{}\"}};\n{}",
        contract, env!("CARGO_PKG_VERSION"), SHIM
    )
}

/**
 * 启动探针（切片 1 起保留）。
 *
 * 渲染层经初始化脚本把挂载状态、WebGL 能力与未捕获错误回报到 stderr，
 * 用来在没有 devtools 自动化的前提下验证外壳。
 */
#[tauri::command]
pub fn probe_report(report: String) {
    println!("PROBE {report}");
}

/**
 * 渲染层网关的唯一入口（切片 3）。每个 `window.astella.*` 方法落到这里，
 * 按 Electron 通道名分派；回执是 `GatewayResultV1` 同形信封。
 */
#[tauri::command]
pub async fn astella_invoke(
    channel: String,
    input: serde_json::Value,
    gateway: tauri::State<'_, std::sync::Arc<tokio::sync::Mutex<crate::gateway::Gateway>>>,
    models: tauri::State<'_, std::sync::Arc<crate::companion_model::ModelRegistry>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let mut gateway = gateway.lock().await;
    Ok(dispatch::invoke(&mut gateway, &models, Some(&app), &channel, &input).await)
}

/**
 * 自定义标题栏的窗口按钮（迁移切片 4）。渲染层自己画关闭/最小化/最大化，
 * 动作必须落到真正的窗口上——否则无边框窗口连关闭都做不到。
 */
#[tauri::command]
pub async fn window_control(
    action: String,
    window: tauri::WebviewWindow,
) -> Result<serde_json::Value, String> {
    match action.as_str() {
        "minimize" => window.minimize().map_err(|error| error.to_string())?,
        "toggle-maximize" => {
            if window.is_maximized().map_err(|error| error.to_string())? {
                window.unmaximize().map_err(|error| error.to_string())?;
            } else {
                window.maximize().map_err(|error| error.to_string())?;
            }
        }
        "close" => window.close().map_err(|error| error.to_string())?,
        _ => return Err("invalid window action".to_string()),
    }
    Ok(serde_json::json!({ "applied": true }))
}

#[tauri::command]
pub async fn window_frame(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    let frame = if window.is_fullscreen().unwrap_or(false) {
        "fullscreen"
    } else if window.is_maximized().unwrap_or(false) {
        "maximized"
    } else {
        "floating"
    };
    Ok(serde_json::json!({ "frame": frame, "revision": 1 }))
}

/**
 * 页面缩放（Cmd/Ctrl +/-/0）。与 Electron 的窗口缩放快捷键同一档位语义：
 * 0.1 一步、0.5–2.0 夹紧、0 复位。缩放比例按 window label 记在本进程里。
 */
#[tauri::command]
pub async fn window_zoom(direction: String, window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    use std::sync::Mutex;
    use std::collections::HashMap;
    static ZOOMS: Mutex<Option<HashMap<String, f64>>> = Mutex::new(None);
    let mut guard = ZOOMS.lock().map_err(|_| "zoom lock".to_string())?;
    let zooms = guard.get_or_insert_with(HashMap::new);
    let current = *zooms.get(window.label()).unwrap_or(&1.0);
    let next = match direction.as_str() {
        "in" => (current + 0.1).min(2.0),
        "out" => (current - 0.1).max(0.5),
        "reset" => 1.0,
        _ => return Err("invalid zoom direction".to_string()),
    };
    window.set_zoom(next).map_err(|error| error.to_string())?;
    zooms.insert(window.label().to_string(), next);
    Ok(serde_json::json!({ "zoom": next }))
}

/** 调试用：按环境配置连一次 API，返回连接状态 JSON。 */
#[tauri::command]
pub async fn gateway_connect(
    gateway: tauri::State<'_, tokio::sync::Mutex<crate::gateway::Gateway>>,
) -> Result<String, String> {
    let mut gateway = gateway.lock().await;
    gateway.ensure_connected().await.map_err(|failure| failure.code.to_string())?;
    serde_json::to_string(gateway.connection()).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn gateway_status(
    gateway: tauri::State<'_, tokio::sync::Mutex<crate::gateway::Gateway>>,
) -> Result<String, String> {
    let gateway = gateway.lock().await;
    let payload = serde_json::json!({
        "configured": gateway.configuration().is_ok(),
        "connection": gateway.connection(),
        "storedCredential": gateway.has_stored_credential(),
    });
    serde_json::to_string(&payload).map_err(|error| error.to_string())
}
