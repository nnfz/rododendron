mod mihomo;
mod process_scanner;
mod updater;

use mihomo::{
    clear_mihomo_logs, delete_config, export_config_to_path, generate_config,
    get_mihomo_binary_name, get_mihomo_logs, get_vpn_status, import_config, list_configs,
    mihomo_get_connections, mihomo_get_delay, mihomo_get_proxies, mihomo_get_traffic,
    parse_config, parse_config_yaml, ping_host, read_config, reload_mihomo_config,
    resolve_config_path, stringify_config_yaml,
    save_rules_to_config, save_rules_to_path, start_vpn, stop_vpn, switch_mihomo_mode,
    switch_proxy_group,
    cleanup_mihomo, health_check, restore_config_backup,
    // === НОВЫЕ КОМАНДЫ AmneziaWG ===
    convert_amnezia_wg_conf,
    import_amnezia_wg_as_config,
};
use process_scanner::get_running_processes;
use updater::{check_for_updates, install_update};

use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::Emitter;
use tauri::Manager;
use tauri::{
    menu::{Menu, MenuItemBuilder},
    tray::TrayIconBuilder,
};
use tauri::RunEvent;
use image::codecs::png::PngEncoder;
use image::ColorType;
use image::ImageEncoder;
use image::Rgba;

use std::sync::{LazyLock, Mutex};

// ─── Tray icon ───────────────────────────────────────────────────────────────

fn build_tray_icon_png(vpn_enabled: bool) -> Result<tauri::image::Image<'static>, String> {
    let base_bytes: &[u8] = include_bytes!("../icons/32x32.png");
    let dyn_img = image::load_from_memory(base_bytes).map_err(|e| e.to_string())?;
    let mut rgba = dyn_img.to_rgba8();

    if vpn_enabled {
        let w = rgba.width() as i32;
        let h = rgba.height() as i32;
        let r: i32 = 6;
        let cx: i32 = w - (r + 3);
        let cy: i32 = h - (r + 3);

        let fill = Rgba([59u8, 130u8, 255u8, 255u8]);
        let outline = Rgba([255u8, 255u8, 255u8, 230u8]);

        for y in (cy - r - 1)..=(cy + r + 1) {
            for x in (cx - r - 1)..=(cx + r + 1) {
                if x < 0 || y < 0 || x >= w || y >= h {
                    continue;
                }
                let dx = x - cx;
                let dy = y - cy;
                let d2 = dx * dx + dy * dy;
                let px = x as u32;
                let py = y as u32;

                if d2 <= r * r {
                    rgba.put_pixel(px, py, fill);
                } else if d2 <= (r + 1) * (r + 1) {
                    rgba.put_pixel(px, py, outline);
                }
            }
        }
    }

    let mut out = Vec::<u8>::new();
    let encoder = PngEncoder::new(&mut out);
    encoder
        .write_image(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            ColorType::Rgba8.into(),
        )
        .map_err(|e| e.to_string())?;

    tauri::image::Image::from_bytes(&out).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn set_tray_vpn_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "Tray icon not found".to_string())?;

    let icon = build_tray_icon_png(enabled)?;
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Close behavior ─────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
enum CloseBehavior {
    Tray,
    Exit,
}

static CLOSE_BEHAVIOR: LazyLock<Mutex<CloseBehavior>> =
    LazyLock::new(|| Mutex::new(CloseBehavior::Tray));

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

// ─── App entry ──────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Rododendron")
                .build(),
        )
        .setup(|app| {
            // ── Tray icon ──
            let icon = build_tray_icon_png(false)?;
            let start = MenuItemBuilder::with_id("tray_start", "Start").build(app)?;
            let stop = MenuItemBuilder::with_id("tray_stop", "Stop").build(app)?;
            let restart = MenuItemBuilder::with_id("tray_restart", "Restart").build(app)?;
            let show = MenuItemBuilder::with_id("tray_show", "Show").build(app)?;
            let quit = MenuItemBuilder::with_id("tray_quit", "Quit").build(app)?;
            let menu = Menu::with_items(app, &[&start, &stop, &restart, &show, &quit])?;

            TrayIconBuilder::<tauri::Wry>::with_id("main-tray")
                .icon(icon)
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button,
                        button_state,
                        ..
                    } = event
                    {
                        if matches!(button, MouseButton::Left)
                            && matches!(button_state, MouseButtonState::Down)
                        {
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
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "tray_start" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("tray://start", ());
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "tray_stop" => {
                        tauri::async_runtime::spawn(async move {
                            let _ = stop_vpn().await;
                        });
                    }
                    "tray_restart" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("tray://restart", ());
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "tray_show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "tray_quit" => {
                        cleanup_mihomo();
                        app.exit(0);
                    }
                    _ => {}
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
                        cleanup_mihomo();
                        app.exit(0);
                    }
                    CloseBehavior::Tray => {
                        let _ = win.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // ── Process scanner ──
            get_running_processes,
            // ── Config management ──
            parse_config,
            parse_config_yaml,
            stringify_config_yaml,
            generate_config,
            import_config,
            read_config,
            delete_config,
            list_configs,
            export_config_to_path,
            resolve_config_path,
            restore_config_backup,
            // ── Rules ──
            save_rules_to_config,
            save_rules_to_path,
            // ── Core VPN ──
            start_vpn,
            stop_vpn,
            get_vpn_status,
            reload_mihomo_config,
            switch_mihomo_mode,
            switch_proxy_group,
            // ── Mihomo API ──
            mihomo_get_traffic,
            mihomo_get_proxies,
            mihomo_get_connections,
            mihomo_get_delay,
            // ── Logs ──
            get_mihomo_logs,
            clear_mihomo_logs,
            // ── Utilities ──
            ping_host,
            get_mihomo_binary_name,
            health_check,
            // ── UI ──
            set_tray_vpn_enabled,
            set_close_behavior,
            // ── Updater ──
            check_for_updates,
            install_update,
            // === НОВЫЕ КОМАНДЫ ДЛЯ AMNEZIAWG ===
            convert_amnezia_wg_conf,
            import_amnezia_wg_as_config,
        ])
        // ═══ .run() → .build().run() для перехвата Exit ═══
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|_app_handle, event| match event {
            RunEvent::Exit => {
                cleanup_mihomo();
            }
            RunEvent::ExitRequested { api, .. } => {
                let _ = api;
            }
            _ => {}
        });
}
