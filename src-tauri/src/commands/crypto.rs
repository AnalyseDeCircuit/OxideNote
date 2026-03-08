/**
 * Crypto module — per-note AES-256-GCM encryption with Argon2id key derivation.
 *
 * Encrypted file format:
 *   Line 1: "---OXIDENOTE-ENCRYPTED---"
 *   Line 2: Base64-encoded salt (16 bytes)
 *   Line 3: Base64-encoded nonce (12 bytes)
 *   Line 4+: Base64-encoded ciphertext
 *
 * Security design:
 *   · Argon2id for password → key derivation (resists GPU/ASIC attacks)
 *   · AES-256-GCM for authenticated encryption (confidentiality + integrity)
 *   · Random 16-byte salt per file (prevents rainbow tables)
 *   · Random 12-byte nonce per encryption (prevents nonce reuse across files)
 *   · Key never stored — derived from password on each decrypt
 *   · Atomic write (tmp → rename) prevents data loss on crash
 */

use std::fs;
use std::path::Path;

use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, KeyInit};
use argon2::Argon2;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::Serialize;
use tauri::State;

use crate::state::AppState;
use super::util::{validate_path_inside_vault, PathValidationError, atomic_write};

const ENCRYPTED_HEADER: &str = "---OXIDENOTE-ENCRYPTED---";
const SALT_LEN: usize = 16;
const KEY_LEN: usize = 32; // AES-256

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("No vault opened")]
    NoVault,
    #[error("Access denied: path outside vault")]
    AccessDenied,
    #[error("IO error: {0}")]
    Io(String),
    #[error("Encryption error: {0}")]
    Encrypt(String),
    #[error("Decryption failed — wrong password or corrupted file")]
    DecryptFailed,
    #[error("File is not encrypted")]
    NotEncrypted,
    #[error("File is already encrypted")]
    AlreadyEncrypted,
}

impl Serialize for CryptoError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<PathValidationError> for CryptoError {
    fn from(e: PathValidationError) -> Self {
        match e {
            PathValidationError::AccessDenied => CryptoError::AccessDenied,
            PathValidationError::Io(msg) => CryptoError::Io(msg),
        }
    }
}

/// Derive a 256-bit key from password + salt using Argon2id.
fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], CryptoError> {
    let mut key = [0u8; KEY_LEN];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| CryptoError::Encrypt(e.to_string()))?;
    Ok(key)
}

/// Shared decryption logic: reads an encrypted file, decrypts, returns plaintext string.
/// Used by both `decrypt_note` and `decrypt_note_to_disk` to avoid duplication.
fn decrypt_file_internal(full_path: &Path, password: &str) -> Result<String, CryptoError> {
    let content = fs::read_to_string(full_path)
        .map_err(|e| CryptoError::Io(e.to_string()))?;

    if !content.starts_with(ENCRYPTED_HEADER) {
        return Err(CryptoError::NotEncrypted);
    }

    let lines: Vec<&str> = content.lines().collect();
    if lines.len() < 4 {
        return Err(CryptoError::DecryptFailed);
    }

    let salt = B64.decode(lines[1])
        .map_err(|_| CryptoError::DecryptFailed)?;
    let nonce_bytes = B64.decode(lines[2])
        .map_err(|_| CryptoError::DecryptFailed)?;
    let ciphertext = B64.decode(lines[3])
        .map_err(|_| CryptoError::DecryptFailed)?;

    let key = derive_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| CryptoError::DecryptFailed)?;
    let nonce = aes_gcm::Nonce::from_slice(&nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| CryptoError::DecryptFailed)?;

    String::from_utf8(plaintext)
        .map_err(|_| CryptoError::DecryptFailed)
}

/// Check if a file is encrypted (starts with the encrypted header).
#[tauri::command]
pub async fn is_note_encrypted(
    path: String,
    state: State<'_, AppState>,
) -> Result<bool, CryptoError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(CryptoError::NoVault)?;
    let full_path = validate_path_inside_vault(vault, &path)?;
    let content = fs::read_to_string(&full_path)
        .map_err(|e| CryptoError::Io(e.to_string()))?;
    Ok(content.starts_with(ENCRYPTED_HEADER))
}

/// Encrypt a note file in-place with a password.
/// Uses atomic write (tmp → rename) to prevent data loss on crash.
#[tauri::command]
pub async fn encrypt_note(
    path: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<(), CryptoError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(CryptoError::NoVault)?;
    let full_path = validate_path_inside_vault(vault, &path)?;

    let content = fs::read_to_string(&full_path)
        .map_err(|e| CryptoError::Io(e.to_string()))?;

    // Prevent double encryption
    if content.starts_with(ENCRYPTED_HEADER) {
        return Err(CryptoError::AlreadyEncrypted);
    }

    // Generate random salt and nonce
    let salt: [u8; SALT_LEN] = rand::random();
    let key = derive_key(&password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| CryptoError::Encrypt(e.to_string()))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);

    let ciphertext = cipher
        .encrypt(&nonce, content.as_bytes())
        .map_err(|e| CryptoError::Encrypt(e.to_string()))?;

    // Build encrypted format string
    let encrypted = format!(
        "{}\n{}\n{}\n{}",
        ENCRYPTED_HEADER,
        B64.encode(salt),
        B64.encode(nonce),
        B64.encode(&ciphertext),
    );

    // Atomic write: tmp → rename to prevent data loss on crash
    atomic_write(&full_path, encrypted.as_bytes())
        .map_err(|e| CryptoError::Io(e.to_string()))?;

    Ok(())
}

/// Decrypt an encrypted note file, returning the plaintext content.
/// Does NOT write back to disk — the frontend decides when to save.
#[tauri::command]
pub async fn decrypt_note(
    path: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<String, CryptoError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(CryptoError::NoVault)?;
    let full_path = validate_path_inside_vault(vault, &path)?;
    decrypt_file_internal(&full_path, &password)
}

/// Decrypt an encrypted note and write the plaintext back to disk (permanent unlock).
/// Uses atomic write (tmp → rename) to prevent data loss on crash.
#[tauri::command]
pub async fn decrypt_note_to_disk(
    path: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<(), CryptoError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(CryptoError::NoVault)?;
    let full_path = validate_path_inside_vault(vault, &path)?;
    let text = decrypt_file_internal(&full_path, &password)?;

    // Atomic write: tmp → rename to prevent data loss on crash
    atomic_write(&full_path, text.as_bytes())
        .map_err(|e| CryptoError::Io(e.to_string()))?;

    Ok(())
}
