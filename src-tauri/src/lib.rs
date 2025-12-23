mod process_scanner;
mod mihomo;

use process_scanner::get_running_processes;
use mihomo::{
    parse_config, generate_config, import_config,
    start_vpn, stop_vpn, get_vpn_status,
    list_configs, read_config, delete_config,
    save_rules_to_config,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_running_processes,
            parse_config,
            generate_config,
            import_config,
            start_vpn,
            stop_vpn,
            get_vpn_status,
            list_configs,
            read_config,
            delete_config,
            save_rules_to_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}