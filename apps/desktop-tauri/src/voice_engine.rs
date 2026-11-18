use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(feature = "voice-engine")]
use sherpa_rs::sense_voice::{SenseVoiceConfig, SenseVoiceRecognizer};

/**
 * 本机语音识别引擎（2026-11-18 Owner 裁决：sherpa-rs 原生链接）。
 *
 * 与 Electron 版同一形态：模型不在安装包里，用户在设置里下到
 * `<appData>/voice-models/`；引擎**懒加载**，空闲 90 秒后卸载（同 Electron 的
 * `voice-asr-engine.ts` 口径）。音频只在本机内存里过一遍，不出设备。
 *
 * SenseVoice 是离线（非流式）识别：一段录音一次解码，返回整句文本。
 */
#[cfg(feature = "voice-engine")]
const IDLE_UNLOAD: Duration = Duration::from_secs(90);
#[cfg(feature = "voice-engine")]
const MODEL_FILE: &str = "model.int8.onnx";
#[cfg(feature = "voice-engine")]
const TOKENS_FILE: &str = "tokens.txt";

#[cfg(feature = "voice-engine")]
struct EngineState {
    recognizer: Option<SenseVoiceRecognizer>,
    last_used: Instant,
}
#[cfg(not(feature = "voice-engine"))]
struct EngineState {
    last_used: Instant,
}

static MODELS: OnceLock<PathBuf> = OnceLock::new();
static ENGINE: OnceLock<Mutex<EngineState>> = OnceLock::new();

pub fn install(app_data: &Path) {
    let _ = MODELS.set(app_data.join("voice-models"));
    #[cfg(feature = "voice-engine")]
    {
        let _ = ENGINE.set(Mutex::new(EngineState { recognizer: None, last_used: Instant::now() }));
    }
    #[cfg(not(feature = "voice-engine"))]
    {
        let _ = ENGINE.set(Mutex::new(EngineState { last_used: Instant::now() }));
    }
    // 空闲卸载：每 30 秒看一眼，够久就把识别器丢掉（内存随之释放）。
    #[cfg(feature = "voice-engine")]
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if let Some(engine) = ENGINE.get() {
                if let Ok(mut state) = engine.lock() {
                    if state.recognizer.is_some() && state.last_used.elapsed() > IDLE_UNLOAD {
                        state.recognizer = None;
                    }
                }
            }
        }
    });
}

#[cfg(feature = "voice-engine")]
fn models_ready(directory: &Path) -> bool {
    let model = directory.join(MODEL_FILE);
    let tokens = directory.join(TOKENS_FILE);
    let expected = |path: &Path, bytes: u64| {
        std::fs::metadata(path).map(|info| info.is_file() && info.len() == bytes).unwrap_or(false)
    };
    expected(&model, 239_233_841) && expected(&tokens, 315_894)
}

/// 一段 16 kHz 单声道 PCM 的整句识别。阻塞调用；调用方负责放到阻塞线程。
#[cfg(not(feature = "voice-engine"))]
pub fn transcribe(_pcm: &[i16], sample_rate: u32) -> Result<String, &'static str> {
    if sample_rate != 16_000 {
        return Err("validation");
    }
    Err("voice_engine_unavailable")
}

#[cfg(feature = "voice-engine")]
pub fn transcribe(pcm: &[i16], sample_rate: u32) -> Result<String, &'static str> {
    if sample_rate != 16_000 {
        return Err("validation");
    }
    let directory = MODELS.get().ok_or("voice_engine_unavailable")?;
    let engine = ENGINE.get().ok_or("voice_engine_unavailable")?;
    let mut state = engine.lock().map_err(|_| "voice_engine_unavailable")?;
    if state.recognizer.is_none() {
        if !models_ready(directory) {
            return Err("voice_engine_unavailable");
        }
        let config = SenseVoiceConfig {
            model: directory.join(MODEL_FILE).to_string_lossy().to_string(),
            tokens: directory.join(TOKENS_FILE).to_string_lossy().to_string(),
            language: "auto".to_string(),
            use_itn: true,
            provider: None,
            num_threads: Some(2),
            debug: false,
        };
        state.recognizer = Some(SenseVoiceRecognizer::new(config).map_err(|_| "voice_engine_unavailable")?);
    }
    state.last_used = Instant::now();
    let samples: Vec<f32> = pcm.iter().map(|sample| *sample as f32 / 32_768.0).collect();
    let result = state
        .recognizer
        .as_mut()
        .ok_or("voice_engine_unavailable")?
        .transcribe(sample_rate, &samples);
    Ok(result.text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_wrong_sample_rate_before_touching_the_engine() {
        assert_eq!(transcribe(&[0i16; 16], 44_100), Err("validation"));
    }

    #[cfg(feature = "voice-engine")]
    #[test]
    fn uninstalled_models_fail_honestly() {
        let dir = std::env::temp_dir().join(format!("astella-voice-empty-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        assert!(!models_ready(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }
}

/// 真模型联调（默认忽略）：需要用 ASTELLA_LIVE_VOICE_DIR 指向装好模型的目录。
#[cfg(all(test, feature = "voice-engine"))]
mod live_engine_tests {
    #[test]
    #[ignore = "needs the 239MB SenseVoice model installed"]
    fn live_transcribe_silence() {
        let dir = std::env::var("ASTELLA_LIVE_VOICE_DIR").expect("ASTELLA_LIVE_VOICE_DIR");
        let path = std::path::Path::new(&dir);
        // 允许指向 `<appData>` 或 `<appData>/voice-models`：install 内部会再拼一层。
        let app_data = if path.file_name().and_then(|name| name.to_str()) == Some("voice-models") {
            path.parent().expect("parent")
        } else {
            path
        };
        super::install(app_data);
        // 1 秒 16 kHz 静音：引擎能加载、能解码、不报错；文字允许为空。
        let pcm = vec![0i16; 16_000];
        let text = super::transcribe(&pcm, 16_000).expect("engine should load and decode");
        println!("live transcribe -> {text:?}");
        assert!(text.len() < 200);
    }
}
