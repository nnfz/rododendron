use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Exclusive lock on `<data-dir>/rododendron.lock`.
/// The handle stays open for the process lifetime, so a second process that
/// uses the same directory cannot write profiles or subscription files.
static HELD: Mutex<Option<InstanceLock>> = Mutex::new(None);

pub struct InstanceLock {
    _file: File,
    _path: PathBuf,
}

pub fn acquire(dir: &Path) -> Result<(), String> {
    let lock = try_lock(dir)?;
    let mut held = HELD.lock().map_err(|err| err.to_string())?;
    if held.is_some() {
        return Err(already_running());
    }
    *held = Some(lock);
    Ok(())
}

pub fn try_lock(dir: &Path) -> Result<InstanceLock, String> {
    fs::create_dir_all(dir).map_err(|err| format!("Failed to create data dir: {err}"))?;
    let path = dir.join("rododendron.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|err| format!("Failed to open instance lock: {err}"))?;
    lock_exclusive(&file)?;
    Ok(InstanceLock {
        _file: file,
        _path: path,
    })
}

fn already_running() -> String {
    "Rododendron is already running with this data directory".to_string()
}

#[cfg(target_os = "windows")]
fn lock_exclusive(file: &File) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    unsafe {
        let mut overlapped = std::mem::zeroed::<OVERLAPPED>();
        let ok = LockFileEx(
            file.as_raw_handle() as _,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlapped,
        );
        if ok == 0 {
            return Err(already_running());
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn lock_exclusive(file: &File) -> Result<(), String> {
    use std::os::unix::io::AsRawFd;
    nix::fcntl::flock(file.as_raw_fd(), nix::fcntl::FlockArg::LockExclusiveNonblock)
        .map_err(|_| already_running())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_lock_on_the_same_directory_is_rejected() {
        let dir = std::env::temp_dir().join(format!(
            "rododendron-lock-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let first = try_lock(&dir).unwrap();
        let second = try_lock(&dir);
        assert!(second.is_err());
        drop(first);
        let third = try_lock(&dir).unwrap();
        drop(third);
        let _ = fs::remove_dir_all(&dir);
    }
}
