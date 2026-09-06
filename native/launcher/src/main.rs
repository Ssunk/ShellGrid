mod protocol;
#[cfg(windows)]
mod windows;

fn main() {
    #[cfg(windows)]
    std::process::exit(windows::run().unwrap_or(1) as i32);
    #[cfg(not(windows))]
    std::process::exit(1);
}
