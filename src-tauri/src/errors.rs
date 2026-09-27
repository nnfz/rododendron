use thiserror::Error;

#[derive(Error, Debug)]
pub enum MihomoError {
    #[error("Mihomo process failed to start: {0}")]
    StartupFailed(String),

    #[error("Mihomo did not become ready in time: {0}")]
    ReadyTimeout(String),

    #[error("Configuration error: {0}")]
    ConfigError(String),

    #[error("API request failed: {0}")]
    ApiError(#[from] reqwest::Error),

    #[error("Invalid proxy configuration: {0}")]
    InvalidProxy(String),

    #[error("Process not running")]
    ProcessNotRunning,

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("YAML error: {0}")]
    YamlError(#[from] serde_yaml::Error),

    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),

    #[error("Lock error: {0}")]
    LockError(String),
}

impl From<MihomoError> for String {
    fn from(err: MihomoError) -> Self {
        err.to_string()
    }
}

impl<T> From<std::sync::PoisonError<T>> for MihomoError {
    fn from(err: std::sync::PoisonError<T>) -> Self {
        MihomoError::LockError(err.to_string())
    }
}
