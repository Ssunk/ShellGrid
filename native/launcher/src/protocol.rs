use serde::Deserialize;
use std::io::{BufRead, Read};

const MAX_FRAME_BYTES: u64 = 256 * 1024;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    Start {
        shell: String,
        args: Vec<String>,
        cwd: String,
        focused: bool,
    },
    Resume,
    Close,
}

// Independent control channel only. Never read, parse or forward terminal content.
pub fn read_command(reader: &mut impl BufRead) -> Result<Command, ()> {
    let mut bytes = Vec::new();
    let count = reader
        .take(MAX_FRAME_BYTES + 1)
        .read_until(b'\n', &mut bytes);
    match count {
        Ok(0) | Err(_) => Err(()),
        Ok(size) if size as u64 > MAX_FRAME_BYTES || bytes.last() != Some(&b'\n') => Err(()),
        Ok(_) => serde_json::from_slice(&bytes).map_err(|_| ()),
    }
}

// Windows CommandLineToArgvW / CRT quoting, including empty arguments and trailing
// backslashes. Always supply lpApplicationName separately to CreateProcessW.
pub fn quote_argument(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        if character == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            slashes * if character == '"' { 2 } else { 1 },
        ));
        if character == '"' {
            result.push('\\');
        }
        result.push(character);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

pub fn command_line(shell: &str, args: &[String]) -> Result<Vec<u16>, ()> {
    if shell.trim().is_empty() || shell.contains('\0') || args.iter().any(|arg| arg.contains('\0'))
    {
        return Err(());
    }
    let line = std::iter::once(shell)
        .chain(args.iter().map(String::as_str))
        .map(quote_argument)
        .collect::<Vec<_>>()
        .join(" ");
    let wide: Vec<u16> = line.encode_utf16().chain(Some(0)).collect();
    if wide.len() > 32_767 {
        return Err(());
    }
    Ok(wide)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn quotes_spaces_empty_unicode_and_trailing_backslash() {
        assert_eq!(quote_argument(""), "\"\"");
        assert_eq!(quote_argument("中文 a"), "\"中文 a\"");
        assert_eq!(quote_argument("C:\\a b\\"), "\"C:\\a b\\\\\"");
        assert_eq!(quote_argument("a\\\"b"), "\"a\\\\\\\"b\"");
    }

    #[test]
    fn rejects_nul_and_overlong_command_lines() {
        assert!(command_line("pwsh.exe", &["a\0b".into()]).is_err());
        assert!(command_line("pwsh.exe", &["x".repeat(32_767)]).is_err());
        assert!(command_line("pwsh.exe", &["-NoLogo".into()]).is_ok());
    }

    #[test]
    fn control_frames_are_bounded_and_require_a_complete_line() {
        assert!(matches!(
            read_command(&mut Cursor::new(b"{\"type\":\"close\"}\n")),
            Ok(Command::Close)
        ));
        assert!(read_command(&mut Cursor::new(b"{\"type\":\"close\"}")).is_err());
        assert!(read_command(&mut Cursor::new(vec![b' '; MAX_FRAME_BYTES as usize + 1])).is_err());
        assert!(read_command(&mut Cursor::new(b"{\"type\":\"input\"}\n")).is_err());
    }
}
