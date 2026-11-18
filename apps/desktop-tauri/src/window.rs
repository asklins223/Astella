use tauri::{App, WebviewUrl, WebviewWindowBuilder};

/**
 * 主窗口（迁移切片 1）。尺寸与 Electron 版对齐（1280×832，最小 960×640）。
 * macOS 上走 Overlay 红绿灯 + 隐藏标题：渲染层自己画标题栏（hiddenInset 语义）。
 * `boot` 是初始化脚本（合同快照 + 桥），在页面任何脚本之前执行。
 */
pub fn create_main_window(app: &App, boot: String) -> tauri::Result<()> {
    let url = tauri::Url::parse("astella-app://bundle/index.html").expect("app scheme url");
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("拾星笔记")
        .inner_size(1280.0, 832.0)
        .min_inner_size(960.0, 640.0)
        .initialization_script(boot);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    #[cfg(debug_assertions)]
    {
        builder = builder.devtools(true);
    }
    builder.build()?;
    Ok(())
}
