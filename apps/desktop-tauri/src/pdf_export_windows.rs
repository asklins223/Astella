#![cfg(target_os = "windows")]

use std::path::Path;
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_7, ICoreWebView2Environment6, ICoreWebView2PrintSettings,
};
use webview2_com::PrintToPdfCompletedHandler;
use windows::core::{Interface, PCWSTR};

/**
 * PDF 导出（Windows）：与 macOS 同样的隐藏 WebView 宿主（`artifacts/<id>.html`
 * 经 `astella-app://artifact/<id>` 打开），捕获改用 WebView2 的 `PrintToPdf`。
 * A4 纸面（8.27×11.69 英寸）并打印背景，与 WKWebView 那条路的输出对齐。
 */
pub async fn export_html_to_pdf(app: &AppHandle, html: &str, out_path: &Path) -> Result<(), &'static str> {
    let app_data = app.path().app_data_dir().map_err(|_| "local_storage_unavailable")?;
    let artifacts = app_data.join("artifacts");
    std::fs::create_dir_all(&artifacts).map_err(|_| "local_storage_unavailable")?;
    let artifact_id = crate::opened_files::uuid_v4();
    let artifact_file = artifacts.join(format!("{artifact_id}.html"));
    std::fs::write(&artifact_file, html.as_bytes()).map_err(|_| "local_storage_unavailable")?;

    let url = tauri::Url::parse(&format!("astella-app://artifact/{artifact_id}")).map_err(|_| "safe_internal_error")?;
    let label = format!("pdf-export-{}", &artifact_id[..8]);
    let (loaded_tx, loaded_rx) = tokio::sync::oneshot::channel::<()>();
    let loaded_tx = std::sync::Mutex::new(Some(loaded_tx));
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .visible(false)
        .decorations(false)
        .inner_size(794.0, 1123.0)
        .on_page_load(move |_webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if let Some(tx) = loaded_tx.lock().ok().and_then(|mut slot| slot.take()) {
                    let _ = tx.send(());
                }
            }
        })
        .build()
        .map_err(|_| "safe_internal_error")?;

    let loaded = tokio::time::timeout(Duration::from_secs(15), loaded_rx).await.is_ok();
    let result = if !loaded {
        Err("api_unavailable")
    } else {
        let out_path = out_path.to_path_buf();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<(), &'static str>>();
        let done_tx = std::sync::Arc::new(std::sync::Mutex::new(Some(done_tx)));
        {
            let done_tx = done_tx.clone();
            window
                .as_ref()
                .with_webview(move |platform| {
                    let send = |outcome: Result<(), &'static str>| {
                        if let Some(tx) = done_tx.lock().ok().and_then(|mut slot| slot.take()) {
                            let _ = tx.send(outcome);
                        }
                    };
                    let outcome = (|| -> Result<(), &'static str> {
                        unsafe {
                            let core = platform.controller().CoreWebView2().map_err(|_| "api_unavailable")?;
                            let webview7: ICoreWebView2_7 = core.cast().map_err(|_| "api_unavailable")?;
                            let environment6: ICoreWebView2Environment6 =
                                platform.environment().cast().map_err(|_| "api_unavailable")?;
                            let settings: ICoreWebView2PrintSettings =
                                environment6.CreatePrintSettings().map_err(|_| "safe_internal_error")?;
                            let _ = settings.SetPageWidth(8.27);
                            let _ = settings.SetPageHeight(11.69);
                            let _ = settings.SetShouldPrintBackgrounds(true);

                            let wide: Vec<u16> = out_path
                                .to_string_lossy()
                                .encode_utf16()
                                .chain(std::iter::once(0))
                                .collect();
                            let path = PCWSTR::from_raw(wide.as_ptr());
                            let done_for_handler = done_tx.clone();
                            let handler = PrintToPdfCompletedHandler::create(Box::new(
                                move |status: windows::core::Result<()>, ok: bool| {
                                    if let Some(tx) = done_for_handler.lock().ok().and_then(|mut slot| slot.take()) {
                                        let outcome = if status.is_ok() && ok { Ok(()) } else { Err("safe_internal_error") };
                                        let _ = tx.send(outcome);
                                    }
                                    Ok(())
                                },
                            ));
                            webview7
                                .PrintToPdf(path, None::<&ICoreWebView2PrintSettings>, Some(&handler))
                                .map_err(|_| "api_unavailable")?;
                        }
                        Ok(())
                    })();
                    if let Err(code) = outcome {
                        send(Err(code));
                    }
                })
                .map_err(|_| "safe_internal_error")?;
        }
        tokio::time::timeout(Duration::from_secs(30), done_rx)
            .await
            .map_err(|_| "api_unavailable")?
            .map_err(|_| "safe_internal_error")?
    };

    let _ = window.close();
    let _ = std::fs::remove_file(&artifact_file);
    result
}
