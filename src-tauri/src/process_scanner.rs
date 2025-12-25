#[cfg(target_os = "windows")]
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Serialize, Clone)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub path: Option<String>,
    pub icon: Option<String>, // Base64 encoded PNG
}

#[cfg(target_os = "windows")]
fn extract_icon(path: &str) -> Option<String> {
    use std::ptr;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::UI::Shell::ExtractIconExW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    unsafe {
        let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

        let mut large_icon: isize = 0;
        let count = ExtractIconExW(wide_path.as_ptr(), 0, &mut large_icon, ptr::null_mut(), 1);

        if count == 0 || large_icon == 0 {
            return None;
        }

        let mut icon_info: ICONINFO = std::mem::zeroed();
        if GetIconInfo(large_icon, &mut icon_info) == 0 {
            DestroyIcon(large_icon);
            return None;
        }

        let hbm_color = icon_info.hbmColor;
        if hbm_color == 0 {
            if icon_info.hbmMask != 0 {
                DeleteObject(icon_info.hbmMask);
            }
            DestroyIcon(large_icon);
            return None;
        }

        let hdc = CreateCompatibleDC(0);
        if hdc == 0 {
            DeleteObject(hbm_color);
            if icon_info.hbmMask != 0 {
                DeleteObject(icon_info.hbmMask);
            }
            DestroyIcon(large_icon);
            return None;
        }

        let old_bmp = SelectObject(hdc, hbm_color);

        let width: i32 = 32;
        let height: i32 = 32;
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width;
        bmi.bmiHeader.biHeight = -height;
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;

        let mut pixels: Vec<u8> = vec![0u8; (width * height * 4) as usize];
        let result = GetDIBits(
            hdc,
            hbm_color,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut _,
            &mut bmi,
            DIB_RGB_COLORS,
        );

        SelectObject(hdc, old_bmp);
        DeleteDC(hdc);
        DeleteObject(hbm_color);
        if icon_info.hbmMask != 0 {
            DeleteObject(icon_info.hbmMask);
        }
        DestroyIcon(large_icon);

        if result == 0 {
            return None;
        }

        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        let png_data = encode_png(&pixels, width as u32, height as u32)?;
        Some(STANDARD.encode(&png_data))
    }
}

#[cfg(target_os = "windows")]
fn encode_png(rgba: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    let mut png_data = Vec::new();

    png_data.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.push(8);
    ihdr.push(6);
    ihdr.push(0);
    ihdr.push(0);
    ihdr.push(0);
    write_chunk(&mut png_data, b"IHDR", &ihdr);

    let mut raw_data = Vec::new();
    for y in 0..height {
        raw_data.push(0);
        let row_start = (y * width * 4) as usize;
        let row_end = row_start + (width * 4) as usize;
        raw_data.extend_from_slice(&rgba[row_start..row_end]);
    }

    let mut zlib_data = Vec::new();
    zlib_data.push(0x78);
    zlib_data.push(0x01);

    let mut remaining = &raw_data[..];
    while !remaining.is_empty() {
        let block_size = remaining.len().min(65535);
        let is_final = block_size == remaining.len();
        zlib_data.push(if is_final { 1 } else { 0 });
        zlib_data.extend_from_slice(&(block_size as u16).to_le_bytes());
        zlib_data.extend_from_slice(&(!(block_size as u16)).to_le_bytes());
        zlib_data.extend_from_slice(&remaining[..block_size]);
        remaining = &remaining[block_size..];
    }

    let adler = adler32(&raw_data);
    zlib_data.extend_from_slice(&adler.to_be_bytes());

    write_chunk(&mut png_data, b"IDAT", &zlib_data);
    write_chunk(&mut png_data, b"IEND", &[]);

    Some(png_data)
}

#[cfg(target_os = "windows")]
fn write_chunk(png: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) {
    png.extend_from_slice(&(data.len() as u32).to_be_bytes());
    png.extend_from_slice(chunk_type);
    png.extend_from_slice(data);

    let mut crc_data = Vec::new();
    crc_data.extend_from_slice(chunk_type);
    crc_data.extend_from_slice(data);
    let crc = crc32(&crc_data);
    png.extend_from_slice(&crc.to_be_bytes());
}

#[cfg(target_os = "windows")]
fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFFFFFF;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xEDB88320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

#[cfg(target_os = "windows")]
fn adler32(data: &[u8]) -> u32 {
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for byte in data {
        a = (a + *byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

#[cfg(target_os = "windows")]
fn is_system_process(name: &str, path: &Option<String>) -> bool {
    let system_names = [
        "System", "Registry", "smss.exe", "csrss.exe", "wininit.exe", 
        "services.exe", "lsass.exe", "svchost.exe", "winlogon.exe",
        "dwm.exe", "fontdrvhost.exe", "WUDFHost.exe", "sihost.exe",
        "taskhostw.exe", "RuntimeBroker.exe", "dllhost.exe", 
        "conhost.exe", "spoolsv.exe", "SearchIndexer.exe",
        "SearchHost.exe", "StartMenuExperienceHost.exe",
        "ShellExperienceHost.exe", "TextInputHost.exe",
        "SecurityHealthService.exe", "MsMpEng.exe", "NisSrv.exe",
        "SgrmBroker.exe", "audiodg.exe", "SearchProtocolHost.exe",
        "SearchFilterHost.exe", "WmiPrvSE.exe", "TrustedInstaller.exe",
        "TiWorker.exe", "wuauclt.exe", "UsoClient.exe"
    ];

    if system_names.iter().any(|&sys_name| name.eq_ignore_ascii_case(sys_name)) {
        return true;
    }

    if let Some(p) = path {
        let p_lower = p.to_lowercase();
        if p_lower.contains("\\windows\\system32\\") 
            || p_lower.contains("\\windows\\syswow64\\")
            || p_lower.contains("\\windows\\winsxs\\") {
            return true;
        }
    }

    false
}

#[tauri::command]
pub fn get_running_processes() -> Vec<ProcessInfo> {
    let mut processes: HashMap<String, ProcessInfo> = HashMap::new();

    #[cfg(target_os = "windows")]
    {
        use std::mem;
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, MAX_PATH};
        use windows_sys::Win32::System::ProcessStatus::{
            EnumProcessModules, EnumProcesses, GetModuleBaseNameW, GetModuleFileNameExW,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
        };

        unsafe {
            let mut pids: [u32; 4096] = [0; 4096];
            let mut bytes_returned: u32 = 0;

            if EnumProcesses(
                pids.as_mut_ptr(),
                mem::size_of_val(&pids) as u32,
                &mut bytes_returned,
            ) == 0
            {
                return vec![];
            }

            let num_processes = bytes_returned as usize / mem::size_of::<u32>();

            for i in 0..num_processes {
                let pid = pids[i];
                if pid == 0 {
                    continue;
                }

                let handle: HANDLE =
                    OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
                if handle == 0 {
                    continue;
                }

                let mut module: isize = 0;
                let mut cb_needed: u32 = 0;

                if EnumProcessModules(
                    handle,
                    &mut module,
                    mem::size_of::<isize>() as u32,
                    &mut cb_needed,
                ) != 0
                {
                    let mut name_buf: [u16; MAX_PATH as usize] = [0; MAX_PATH as usize];
                    let mut path_buf: [u16; MAX_PATH as usize] = [0; MAX_PATH as usize];

                    let name_len = GetModuleBaseNameW(handle, module, name_buf.as_mut_ptr(), MAX_PATH);
                    let path_len = GetModuleFileNameExW(handle, module, path_buf.as_mut_ptr(), MAX_PATH);

                    if name_len > 0 {
                        let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
                        let path = if path_len > 0 {
                            Some(String::from_utf16_lossy(&path_buf[..path_len as usize]))
                        } else {
                            None
                        };

                        // Фильтруем системные процессы
                        if is_system_process(&name, &path) {
                            CloseHandle(handle);
                            continue;
                        }

                        let icon = path.as_ref().and_then(|p| extract_icon(p));

                        if !processes.contains_key(&name) {
                            processes.insert(name.clone(), ProcessInfo { pid, name, path, icon });
                        }
                    }
                }

                CloseHandle(handle);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        use std::fs;

        if let Ok(entries) = fs::read_dir("/proc") {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(pid_str) = path.file_name().and_then(|n| n.to_str()) {
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        let comm_path = path.join("comm");
                        let exe_path = path.join("exe");

                        if let Ok(name) = fs::read_to_string(&comm_path) {
                            let name = name.trim().to_string();
                            let exe = fs::read_link(&exe_path).ok().map(|p| p.display().to_string());

                            if !processes.contains_key(&name) {
                                processes.insert(
                                    name.clone(),
                                    ProcessInfo {
                                        pid,
                                        name,
                                        path: exe,
                                        icon: None,
                                    },
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        if let Ok(output) = Command::new("ps").args(["-axo", "pid,comm"]).output() {
            if let Ok(stdout) = String::from_utf8(output.stdout) {
                for line in stdout.lines().skip(1) {
                    let parts: Vec<&str> = line.trim().splitn(2, ' ').collect();
                    if parts.len() == 2 {
                        if let Ok(pid) = parts[0].trim().parse::<u32>() {
                            let full_path = parts[1].trim().to_string();
                            let name = full_path.rsplit('/').next().unwrap_or(&full_path).to_string();

                            if !processes.contains_key(&name) {
                                processes.insert(
                                    name.clone(),
                                    ProcessInfo {
                                        pid,
                                        name,
                                        path: Some(full_path),
                                        icon: None,
                                    },
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    let mut result: Vec<ProcessInfo> = processes.into_values().collect();
    result.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    result
}