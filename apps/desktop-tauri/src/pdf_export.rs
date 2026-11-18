#![cfg(target_os = "macos")]

use std::path::Path;
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/**
 * PDF 导出（macOS）：把导出 HTML 落到 `artifacts/<id>.html`，用一个隐藏 WebView
 * 通过 `astella-app://artifact/<id>` 打开，再调 WKWebView 的 `createPDF` 写文件。
 *
 * Electron 用隐藏窗口 `webContents.printToPDF`；这里是同一位置的原生实现
 * （wry 没有跨平台 printToPDF 接口，macOS 走 WebKit 自己的 PDF API）。
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
        {
            use std::sync::Mutex;
            let done_tx = Mutex::new(Some(done_tx));
            window
                .as_ref()
                .with_webview(move |platform| {
                    let done_tx = done_tx.lock().ok().and_then(|mut slot| slot.take());
                    let Some(done_tx) = done_tx else { return };
                    unsafe {
                        let Some(mtm) = objc2::MainThreadMarker::new() else {
                            let _ = done_tx.send(Err("safe_internal_error"));
                            return;
                        };
                        let webview: &objc2_web_kit::WKWebView = &*(platform.inner() as *const objc2_web_kit::WKWebView);
                        let script = objc2_foundation::NSString::from_str("document.documentElement.scrollHeight");
                        let width = 794f64;
                        let webview_addr = webview as *const objc2_web_kit::WKWebView as usize;
                        let state = std::sync::Mutex::new(Some((done_tx, out_path.clone())));
                        let create_pdf = block2::RcBlock::new(move |data: *mut objc2_foundation::NSData, error: *mut objc2_foundation::NSError| {
                            let payload = state.lock().ok().and_then(|mut slot| slot.take());
                            let Some((done_tx, pdf_file)) = payload else { return };
                            if !error.is_null() || data.is_null() {
                                let _ = done_tx.send(Err("safe_internal_error"));
                                return;
                            }
                            let bytes = (&*data).to_vec();
                            let outcome = std::fs::write(&pdf_file, bytes).map_err(|_| "local_storage_unavailable");
                            let _ = done_tx.send(outcome);
                        });
                        let eval_handler = block2::RcBlock::new(move |result: *mut objc2::runtime::AnyObject, _error: *mut objc2_foundation::NSError| {
                            // 取不到高度就按默认 A4 高度出一页，不放弃整次导出。
                            let height = if result.is_null() {
                                1123f64
                            } else {
                                let number: &objc2_foundation::NSNumber = &*(result as *const objc2_foundation::NSNumber);
                                number.doubleValue().max(1123.0)
                            };
                            let webview: &objc2_web_kit::WKWebView = &*(webview_addr as *const objc2_web_kit::WKWebView);
                            let config = objc2_web_kit::WKPDFConfiguration::new(mtm);
                            let rect = objc2_core_foundation::CGRect::new(
                                objc2_core_foundation::CGPoint::ZERO,
                                objc2_core_foundation::CGSize::new(width, height.min(20000.0)),
                            );
                            config.setRect(rect);
                            webview.createPDFWithConfiguration_completionHandler(Some(&config), &create_pdf);
                        });
                        webview.evaluateJavaScript_completionHandler(&script, Some(&eval_handler));
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
