use reqwest::header::{ACCEPT, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

use crate::mihomo;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const USER_AGENT_VALUE: &str = "rododendron";
const GITHUB_API_URL: &str = "https://api.github.com/repos/nnfz/rododendron/releases/latest";

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    body: Option<String>,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Serialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub asset_name: Option<String>,
    pub download_url: Option<String>,
    pub release_notes: Option<String>,
}

#[inline]
fn normalize_tag_to_version(tag: &str) -> String {
    tag.trim()
        .strip_prefix("app-v")
        .or_else(|| tag.strip_prefix('v'))
        .unwrap_or(tag)
        .trim()
        .to_string()
}

fn parse_version_triplet(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.split('.');
    let a = parts.next()?.trim().parse::<u64>().ok()?;
    let b = parts.next()?.trim().parse::<u64>().ok()?;
    let c_raw = parts.next()?.trim();
    let c_digits: String = c_raw.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if c_digits.is_empty() {
        return None;
    }
    let c = c_digits.parse::<u64>().ok()?;
    Some((a, b, c))
}

#[inline]
fn is_newer_version(current: &str, latest: &str) -> Option<bool> {
    let c = parse_version_triplet(current)?;
    let l = parse_version_triplet(latest)?;
    Some(l > c)
}

#[cfg(target_os = "windows")]
fn select_platform_asset(assets: &[GitHubAsset]) -> Option<&GitHubAsset> {
    assets
        .iter()
        .find(|a| a.name.to_ascii_lowercase().ends_with(".exe"))
}

#[cfg(target_os = "macos")]
fn select_platform_asset(assets: &[GitHubAsset]) -> Option<&GitHubAsset> {
    const PREFER: &[&str] = &[".dmg", ".zip"];
    for &ext in PREFER {
        if let Some(a) = assets.iter().find(|x| x.name.to_ascii_lowercase().ends_with(ext)) {
            return Some(a);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn select_platform_asset(assets: &[GitHubAsset]) -> Option<&GitHubAsset> {
    const PREFER: &[&str] = &[".appimage", ".deb", ".tar.gz", ".zip"];
    for &ext in PREFER {
        if let Some(a) = assets.iter().find(|x| x.name.to_ascii_lowercase().ends_with(ext)) {
            return Some(a);
        }
    }
    None
}

async fn fetch_latest_release() -> Result<GitHubRelease, String> {
    let client = reqwest::Client::new();
    client
        .get(GITHUB_API_URL)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Request failed: {e}"))?
        .json::<GitHubRelease>()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn check_for_updates() -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();

    let release = fetch_latest_release().await?;

    let latest_version = normalize_tag_to_version(&release.tag_name);
    let update_available = is_newer_version(&current_version, &latest_version).unwrap_or(false);

    let (asset_name, download_url) = if update_available {
        if let Some(asset) = select_platform_asset(&release.assets) {
            (Some(asset.name.clone()), Some(asset.browser_download_url.clone()))
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    Ok(UpdateCheckResult {
        current_version,
        latest_version,
        update_available,
        asset_name,
        download_url,
        release_notes: release.body,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let release = fetch_latest_release().await?;
    let latest_version = normalize_tag_to_version(&release.tag_name);
    let update_available = is_newer_version(&current_version, &latest_version).unwrap_or(false);

    if !update_available {
        return Err("No update available".to_string());
    }

    let asset = select_platform_asset(&release.assets)
        .ok_or_else(|| "No compatible asset found in the latest release".to_string())?;

    let client = reqwest::Client::new();
    let bytes = client
        .get(&asset.browser_download_url)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .header(ACCEPT, "application/octet-stream")
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    let mut path = std::env::temp_dir();
    path.push(&asset.name);

    fs::write(&path, &bytes).map_err(|e| format!("Failed to write installer: {e}"))?;

    let _ = mihomo::stop_vpn().await;

    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", mihomo::get_mihomo_binary_name().as_str()])
            .creation_flags(0x08000000)
            .output();
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let _ = std::process::Command::new("pkill")
            .arg("-9")
            .arg(mihomo::get_mihomo_binary_name())
            .output();
    }

    spawn_installer(&path).map_err(|e| format!("Failed to launch installer: {e}"))?;

    app.exit(0);
    Ok(())
}

fn spawn_installer(path: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new(path);

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(path);
        c
    };

    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(path);
        c
    };

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}