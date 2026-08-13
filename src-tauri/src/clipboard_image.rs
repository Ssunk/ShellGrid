use base64::Engine;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// 前端经 Tauri IPC 传来的 base64 载荷；相比 JSON 数字数组可显著缩小传输体积。
pub fn decode_image_data(data: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| "剪贴板图片数据无效".to_string())
}

pub fn save(directory: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("剪贴板图片为空".into());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("剪贴板图片超过 20 MiB 限制".into());
    }
    let extension = detect_extension(bytes).ok_or("剪贴板内容不是支持的图片格式")?;
    fs::create_dir_all(directory).map_err(|_| "无法创建剪贴板图片目录".to_string())?;
    cleanup_stale(directory);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_millis());
    let path = directory.join(format!(
        "clipboard-{stamp}-{}.{}",
        Uuid::new_v4(),
        extension
    ));
    fs::write(&path, bytes).map_err(|_| "无法保存剪贴板图片".to_string())?;
    Ok(path)
}

fn detect_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.starts_with(b"BM") {
        Some("bmp")
    } else {
        None
    }
}

fn cleanup_stale(directory: &Path) {
    let now = SystemTime::now();
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_owned_image = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("clipboard-"));
        if !is_owned_image {
            continue;
        }
        let is_stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > RETENTION);
        if is_stale {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_bitmap_formats() {
        assert_eq!(detect_extension(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(detect_extension(b"\xff\xd8\xffrest"), Some("jpg"));
        assert_eq!(detect_extension(b"GIF89arest"), Some("gif"));
        assert_eq!(detect_extension(b"RIFFxxxxWEBPrest"), Some("webp"));
        assert_eq!(detect_extension(b"BMrest"), Some("bmp"));
        assert_eq!(detect_extension(b"not an image"), None);
    }

    #[test]
    fn writes_valid_images_with_a_safe_generated_name() {
        let directory = tempfile::tempdir().unwrap();
        let bytes = b"\x89PNG\r\n\x1a\nrest";
        let path = save(directory.path(), bytes).unwrap();
        assert_eq!(path.parent(), Some(directory.path()));
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("png")
        );
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn rejects_unknown_and_oversized_contents() {
        let directory = tempfile::tempdir().unwrap();
        assert!(save(directory.path(), b"plain text").is_err());
        let oversized = vec![0_u8; MAX_IMAGE_BYTES + 1];
        assert!(save(directory.path(), &oversized).is_err());
    }

    #[test]
    fn decodes_base64_payload_before_saving() {
        use base64::Engine;
        let directory = tempfile::tempdir().unwrap();
        let png = b"\x89PNG\r\n\x1a\npayload";
        let encoded = base64::engine::general_purpose::STANDARD.encode(png);
        let bytes = decode_image_data(&encoded).unwrap();
        assert_eq!(bytes, png);
        let path = save(directory.path(), &bytes).unwrap();
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("png")
        );
        assert!(decode_image_data("not-base64!!").is_err());
    }
}
