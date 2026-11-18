use qbsdiff::{Bsdiff, Bspatch};
use sha2::{Digest, Sha256};

/**
 * 自研增量更新核心（2026-11-18 Owner 裁决：mac/Windows 都要增量，只保留上一版）。
 *
 * 补丁对象是**应用主二进制**：我们的安装内容是一个自包含可执行文件（前端资源内嵌），
 * 所以 `bsdiff(旧二进制, 新二进制)` 就是整个应用的增量。这一层只做纯字节运算与校验，
 * 下载、结果替换、退出重启由更新状态机负责。
 *
 * 资产命名（发布流水线按此产出）：
 *   astella-<to>-from-<from>-<os>-<arch>.qbsdiff
 *   astella-<to>-from-<from>.json   { "from":…, "to":…, "patchSha256":…, "resultSha256":… }
 */
/// mac/Windows 共用同一发布目录，补丁名必须带平台，避免同名互撞。
fn platform_tag() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

pub fn delta_asset_name(to: &str, from: &str) -> String {
    format!("astella-{to}-from-{from}-{}.qbsdiff", platform_tag())
}

pub fn delta_meta_name(to: &str, from: &str) -> String {
    format!("astella-{to}-from-{from}-{}.json", platform_tag())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(bytes);
    hex::encode(hash.finalize())
}

pub fn make_patch(old: &[u8], new: &[u8]) -> Result<Vec<u8>, String> {
    let mut patch = Vec::new();
    Bsdiff::new(old, new)
        .compare(std::io::Cursor::new(&mut patch))
        .map_err(|error| format!("生成补丁失败（{error}）。"))?;
    Ok(patch)
}

/// 应用补丁；返回的字节必须再由调用方核对 `resultSha256`。
pub fn apply_patch(old: &[u8], patch: &[u8]) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    Bspatch::new(patch)
        .and_then(|bspatch| bspatch.apply(old, std::io::Cursor::new(&mut result)))
        .map_err(|_| "增量补丁无法应用到当前版本（包可能已损坏）。".to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(size: usize, salt: u8) -> Vec<u8> {
        (0..size).map(|index| ((index as u64 * 31 + salt as u64) % 251) as u8).collect()
    }

    #[test]
    fn patch_round_trip_restores_the_new_binary() {
        let old = sample(200_000, 7);
        let mut new = old.clone();
        new.extend_from_slice(b"tauri-migration-payload");
        new[500] ^= 0xff;
        let patch = make_patch(&old, &new).expect("diff");
        assert!(patch.len() < old.len(), "patch should be smaller than payload");
        let restored = apply_patch(&old, &patch).expect("patch");
        assert_eq!(sha256_hex(&restored), sha256_hex(&new));
    }

    #[test]
    fn corrupted_patch_never_passes_result_verification() {
        // bsdiff 格式不带校验和：篡改要么解码失败，要么解出错误字节。
        // 真正的闸门是调用方核对 `resultSha256`——这里断言它必定不相等。
        let old = sample(10_000, 3);
        let new = sample(10_000, 4);
        let mut patch = make_patch(&old, &new).expect("diff");
        let middle = patch.len() / 2;
        patch[middle] ^= 0xff;
        match apply_patch(&old, &patch) {
            Err(_) => {}
            Ok(bytes) => assert_ne!(sha256_hex(&bytes), sha256_hex(&new)),
        }
    }

    #[test]
    fn asset_names_follow_the_pipeline_convention() {
        assert_eq!(delta_asset_name("2.0.7", "2.0.6"), format!("astella-2.0.7-from-2.0.6-{}.qbsdiff", platform_tag()));
        assert_eq!(delta_meta_name("2.0.7", "2.0.6"), format!("astella-2.0.7-from-2.0.6-{}.json", platform_tag()));
    }
}
