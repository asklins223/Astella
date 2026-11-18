use std::io::Cursor;

use qbsdiff::{Bsdiff, Bspatch};
use sha2::{Digest, Sha256};

/**
 * 发布侧：为「上一版 → 当前版」生成增量补丁（2026-11-18 Owner 裁决）。
 *
 * 用法（CI 对两个 release 主二进制跑）：
 *   cargo run --release --bin make_patch -- \
 *     --from old/Astella --to new/Astella --from-version 2.0.6 --to-version 2.0.7 --out dist/ --verify
 *
 * 产出 `astella-<to>-from-<from>-<os>-<arch>.qbsdiff` 与同名 `.json`
 * （{from,to,patchSha256,resultSha256,fullSize,patchSize}），与客户端 `src/update.rs` 约定一致。
 * `--verify` 会用旧字节把补丁抹回去并核对结果哈希，防止产出坏补丁。
 */
fn arg(name: &str) -> Option<String> {
    let index = std::env::args().position(|value| value == format!("--{name}"))?;
    std::env::args().nth(index + 1)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(bytes);
    hex::encode(hash.finalize())
}

fn main() {
    let from = arg("from").expect("--from <old binary>");
    let to = arg("to").expect("--to <new binary>");
    let from_version = arg("from-version").expect("--from-version <semver>");
    let to_version = arg("to-version").expect("--to-version <semver>");
    let out = arg("out").unwrap_or_else(|| ".".to_string());

    let old = std::fs::read(&from).expect("read old binary");
    let new = std::fs::read(&to).expect("read new binary");
    let mut patch = Vec::new();
    Bsdiff::new(&old, &new).compare(Cursor::new(&mut patch)).expect("diff");
    let result_sha = sha256_hex(&new);
    let patch_sha = sha256_hex(&patch);

    if std::env::args().any(|value| value == "--verify") {
        let mut restored = Vec::new();
        Bspatch::new(&patch)
            .and_then(|patched| patched.apply(&old, Cursor::new(&mut restored)))
            .expect("apply patch");
        assert_eq!(sha256_hex(&restored), result_sha, "patch result mismatch");
    }

    let base = format!(
        "astella-{to_version}-from-{from_version}-{}-{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    std::fs::create_dir_all(&out).expect("create out dir");
    let patch_path = format!("{out}/{base}.qbsdiff");
    let meta_path = format!("{out}/{base}.json");
    std::fs::write(&patch_path, &patch).expect("write patch");
    let meta = serde_json::json!({
        "from": from_version,
        "to": to_version,
        "patchSha256": patch_sha,
        "resultSha256": result_sha,
        "fullSize": new.len(),
        "patchSize": patch.len(),
    });
    std::fs::write(&meta_path, serde_json::to_vec_pretty(&meta).expect("meta")).expect("write meta");
    println!("patch {} bytes (full {} bytes) -> {patch_path}", patch.len(), new.len());
}
