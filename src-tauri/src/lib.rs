mod process_scanner;
mod mihomo;
mod autostart;
mod updater;

use process_scanner::get_running_processes;
use mihomo::{
    parse_config, generate_config, import_config,
    start_vpn, stop_vpn, get_vpn_status,
    list_configs, read_config, delete_config,
    save_rules_to_config, save_rules_to_path, resolve_config_path, get_mihomo_logs, clear_mihomo_logs,
    mihomo_get_traffic, mihomo_get_proxies, mihomo_get_connections, mihomo_get_delay, ping_host,
};

use autostart::set_autostart;

use updater::{check_for_updates, install_update};

use tauri::Manager;
use tauri::{menu::{Menu, MenuItemBuilder}, tray::TrayIconBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};

use std::sync::{LazyLock, Mutex};

#[derive(Clone, Copy)]
enum CloseBehavior {
    Tray,
    Exit,
}

static CLOSE_BEHAVIOR: LazyLock<Mutex<CloseBehavior>> = LazyLock::new(|| Mutex::new(CloseBehavior::Tray));

#[tauri::command(rename_all = "camelCase")]
fn set_close_behavior(behavior: String) -> Result<(), String> {
    let next = match behavior.as_str() {
        "exit" => CloseBehavior::Exit,
        _ => CloseBehavior::Tray,
    };
    let mut guard = CLOSE_BEHAVIOR.lock().map_err(|e| e.to_string())?;
    *guard = next;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.ico"))?;
            let show = MenuItemBuilder::with_id("tray_show", "Show").build(app)?;
            let quit = MenuItemBuilder::with_id("tray_quit", "Quit").build(app)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::<tauri::Wry>::with_id("main-tray")
                .icon(icon)
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button, button_state, .. } = event {
                        if matches!(button, MouseButton::Left) && matches!(button_state, MouseButtonState::Down) {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    }
                })
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "tray_show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "tray_quit" => {
                            let _ = tauri::async_runtime::block_on(async { stop_vpn().await });
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                let win = window.clone();
                let behavior = CLOSE_BEHAVIOR
                    .lock()
                    .map(|v| *v)
                    .unwrap_or(CloseBehavior::Tray);

                match behavior {
                    CloseBehavior::Exit => {
                        tauri::async_runtime::spawn(async move {
                            let _ = stop_vpn().await;
                            app.exit(0);
                        });
                    }
                    CloseBehavior::Tray => {
                        let _ = win.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_running_processes,
            parse_config,
            generate_config,
            import_config,
            set_autostart,
            set_close_behavior,
            start_vpn,
            stop_vpn,
            get_vpn_status,
            list_configs,
            read_config,
            delete_config,
            get_mihomo_logs,
            clear_mihomo_logs,
            save_rules_to_config,
            save_rules_to_path,
            resolve_config_path,
            mihomo_get_traffic,
            mihomo_get_proxies,
            mihomo_get_connections,
            mihomo_get_delay,
            ping_host,
            check_for_updates,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}