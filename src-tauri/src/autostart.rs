#[cfg(target_os = "windows")]
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::AppHandle;

#[cfg(target_os = "windows")]
fn run_reg(args: &[String]) -> Result<(), String> {
    let mut cmd = Command::new("reg");
    cmd.creation_flags(0x08000000);
    for a in args {
        cmd.arg(a);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[tauri::command]
pub fn set_autostart(_app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = _app;
        let _ = enabled;
        return Err("autostart is only implemented for Windows in this build".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe.to_string_lossy().to_string();

        let key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run".to_string();
        let name = "Rododendron".to_string();

        if enabled {
            run_reg(&[
                "add".to_string(),
                key,
                "/v".to_string(),
                name,
                "/t".to_string(),
                "REG_SZ".to_string(),
                "/d".to_string(),
                exe_str,
                "/f".to_string(),
            ])
        } else {
            let res = run_reg(&[
                "delete".to_string(),
                key,
                "/v".to_string(),
                name,
                "/f".to_string(),
            ]);
            match res {
                Ok(()) => Ok(()),
                Err(_) => Ok(()),
            }
        }
    }
}
