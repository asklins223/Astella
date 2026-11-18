#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod bridge_context;
mod bundle_import;
mod chat_stream;
mod collab;
mod collab_client;
mod companion_model;
mod devices;
mod update;
mod voice_engine;
mod voice_model;
mod gateway;
mod patch;
#[cfg(target_os = "macos")]
mod pdf_export;
#[cfg(target_os = "windows")]
mod pdf_export_windows;
mod docx_export;
mod markdown_images;
mod note_writing;
mod opened_files;
mod protocol;
mod window;

use tauri::Manager;

fn main() {
    let mut builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths: Vec<std::path::PathBuf> = argv
                .into_iter()
                .skip(1)
                .map(std::path::PathBuf::from)
                .filter(|path| path.extension().is_some())
                .collect();
            if !paths.is_empty() {
                crate::opened_files::broker().receive(paths);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            bridge::probe_report,
            bridge::astella_invoke,
            bridge::window_control,
            bridge::window_frame,
            bridge::window_zoom,
            bridge::gateway_connect,
            bridge::gateway_status,
        ]);
    protocol::register(builder)
        .setup(|app| {
            // 会话凭据与 API 传输的宿主（切片 2）。目录取 Tauri 的 app data：
            // macOS 上是 ~/Library/Application Support/com.astella.desktop。
            // 打包安装时随资源附带的部署默认值：env 优先，缺失才由 deployment.json 补。
            if let Ok(resource_dir) = app.path().resource_dir() {
                if let Ok(document) = std::fs::read_to_string(resource_dir.join("deployment.json")) {
                    let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
                    if gateway::config::apply_deployment_defaults(&mut env, &document).is_ok() {
                        for key in ["DESKTOP_API_ORIGIN", "ASTELLA_DOMAIN_SCHEMA_REVISION", "DESKTOP_DEPLOYMENT_CONFIG_REVISION"] {
                            if std::env::var_os(key).is_none() {
                                if let Some(value) = env.get(key) {
                                    std::env::set_var(key, value);
                                }
                            }
                        }
                    }
                }
            }
            let user_data = app.path().app_data_dir().expect("app data dir");
            voice_model::install(&user_data);
            voice_engine::install(&user_data);
            let gateway = gateway::Gateway::from_env(&user_data);
            let contract = bridge::contract::contract_snapshot(gateway.configuration());
            // PDF 导出演练钩子：显式设置 ASTELLA_PDF_REHEARSAL=<输出路径> 才触发（生产不设置）。
            if let Ok(pdf_path) = std::env::var("ASTELLA_PDF_REHEARSAL") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let input = serde_json::json!({
                        "action": "export", "format": "pdf", "title": "PDF 演练",
                        "markdown": "# PDF 演练\n\n中文正文一段。\n"
                    });
                    std::env::set_var("ASTELLA_EXPORT_PATH", &pdf_path);
                    let result = note_writing::export_pdf(&input, Some(&handle)).await;
                    std::env::remove_var("ASTELLA_EXPORT_PATH");
                    match result {
                        Ok(outcome) => println!("PDF_REHEARSAL ok {}", outcome.body["path"]),
                        Err(code) => println!("PDF_REHEARSAL failed {code}"),
                    }
                    handle.exit(0);
                });
            }
            // 升级演练钩子：只在显式设置该环境变量时触发（CI/本地演练），生产不会设置。
            if std::env::var("ASTELLA_UPDATE_REHEARSAL").is_ok() {
                let data = user_data.clone();
                std::thread::spawn(move || {
                    tauri::async_runtime::block_on(async move {
                        let bridge = update::bridge();
                        let checked = bridge.check(true).await;
                        println!("REHEARSAL check {}", checked["phase"]);
                        if checked["phase"] != "available" {
                            return;
                        }
                        bridge.start_download(data.join("updates"));
                        for _ in 0..240 {
                            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                            let state = bridge.state().await;
                            match state["phase"].as_str() {
                                Some("ready") => {
                                    println!("REHEARSAL ready {}", state["availableVersion"]);
                                    let install = bridge.install().await;
                                    println!("REHEARSAL install {}", install["phase"]);
                                    if install["phase"] == "ready" {
                                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                        std::process::exit(0);
                                    }
                                    return;
                                }
                                Some("failed") => {
                                    println!("REHEARSAL failed {}", state["message"]);
                                    return;
                                }
                                _ => {}
                            }
                        }
                        println!("REHEARSAL timeout");
                    });
                });
            }
            let models = std::sync::Arc::new(companion_model::ModelRegistry::new(user_data.join("companion-models")));
            tauri::async_runtime::block_on(models.sweep());
            app.manage(std::sync::Arc::new(tokio::sync::Mutex::new(gateway)));
            app.manage(models);
            window::create_main_window(app, bridge::boot_script(&contract))?;
            // 冷启动时随命令行带进来的文件（Windows 关联/命令行打开）。
            let launch_paths: Vec<std::path::PathBuf> = std::env::args()
                .skip(1)
                .map(std::path::PathBuf::from)
                .filter(|path| path.extension().is_some())
                .collect();
            if !launch_paths.is_empty() {
                opened_files::broker().receive(launch_paths);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build astella desktop shell")
        .run(|_app, event| {
            #[cfg(target_os = "macos")]
            match event {
                tauri::RunEvent::Opened { urls } => {
                    let paths = urls.into_iter().filter_map(|url| url.to_file_path().ok()).collect();
                    crate::opened_files::broker().receive(paths);
                }
                _ => {}
            }
            #[cfg(not(target_os = "macos"))]
            let _ = event;
        });
}