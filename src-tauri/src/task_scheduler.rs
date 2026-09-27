use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const TASK_NAME: &str = "RododendronAutostart";

/// Проверяет, существует ли задача автозапуска
#[tauri::command]
pub fn is_task_scheduler_enabled() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("schtasks");
        cmd.args(["/query", "/tn", TASK_NAME]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        match cmd.output() {
            Ok(output) => Ok(output.status.success()),
            Err(_) => Ok(false),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Task Scheduler is only supported on Windows".to_string())
    }
}

/// Включает автозапуск через Task Scheduler (с правами администратора)
#[tauri::command]
pub fn enable_task_scheduler(_app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("Failed to get executable path: {}", e))?;

        let exe_path_str = exe_path
            .to_str()
            .ok_or_else(|| "Invalid executable path".to_string())?;

        // Создаем задачу с правами администратора
        let mut cmd = Command::new("schtasks");
        cmd.args([
            "/create",
            "/tn", TASK_NAME,
            "/tr", exe_path_str,
            "/sc", "onlogon",
            "/rl", "highest", // Запуск с правами администратора
            "/f", // Перезаписать если существует
        ]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to execute schtasks: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Failed to create scheduled task: {}", stderr))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Task Scheduler is only supported on Windows".to_string())
    }
}

/// Отключает автозапуск через Task Scheduler
#[tauri::command]
pub fn disable_task_scheduler() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("schtasks");
        cmd.args(["/delete", "/tn", TASK_NAME, "/f"]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to execute schtasks: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            // Если задача не найдена - это тоже успех
            Ok(())
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Task Scheduler is only supported on Windows".to_string())
    }
}

/// Синхронизирует состояние автозапуска
#[tauri::command]
pub fn sync_task_scheduler(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let current = is_task_scheduler_enabled()?;

    if enabled && !current {
        enable_task_scheduler(app)?;
    } else if !enabled && current {
        disable_task_scheduler()?;
    }

    Ok(())
}
