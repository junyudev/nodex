#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
mod windows;

fn main() {
    #[cfg(windows)]
    if let Err(error) = windows::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    {
        eprintln!("Installation maintenance requires Windows");
        std::process::exit(1);
    }
}
