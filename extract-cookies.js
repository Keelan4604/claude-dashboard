/**
 * Extracts claude.ai cookies from Chrome's encrypted cookie store.
 * Uses DPAPI via PowerShell to decrypt, then AES-256-GCM to decrypt cookie values.
 * Outputs cookies as JSON to stdout or a file.
 */

const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROFILE = 'Profile 6';
const LOCAL_APP_DATA = process.env.LOCALAPPDATA;
const USER_DATA = path.join(LOCAL_APP_DATA, 'Google', 'Chrome', 'User Data');
const COOKIE_DB = path.join(USER_DATA, PROFILE, 'Network', 'Cookies');
const LOCAL_STATE = path.join(USER_DATA, 'Local State');
const COOKIE_COPY = path.join(__dirname, '_cookies_tmp.db');
const OUTPUT_FILE = path.join(__dirname, '.claude-cookies.json');

function log(msg) {
  console.log('[cookie-extract] ' + msg);
}

// Step 1: Get the AES key via DPAPI
function getDecryptionKey() {
  const localState = JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf8'));
  const encKeyB64 = localState.os_crypt.encrypted_key;
  const encKeyBuf = Buffer.from(encKeyB64, 'base64');

  // Remove "DPAPI" prefix (5 bytes), then decrypt with DPAPI via PowerShell
  const dpapiBlob = encKeyBuf.slice(5).toString('base64');
  const psScript = `
    Add-Type -AssemblyName System.Security
    $blob = [Convert]::FromBase64String('${dpapiBlob}')
    $key = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
    [Convert]::ToBase64String($key)
  `.replace(/\n/g, '; ');

  const keyB64 = execSync(`powershell -Command "${psScript}"`, { encoding: 'utf8' }).trim();
  return Buffer.from(keyB64, 'base64');
}

// Step 2: Decrypt a Chrome v10+ cookie value
function decryptCookieValue(encryptedValue, key) {
  if (!encryptedValue || encryptedValue.length < 15) return '';

  // Check for v10/v20 prefix
  const prefix = encryptedValue.slice(0, 3).toString('ascii');
  if (prefix === 'v10' || prefix === 'v20') {
    const nonce = encryptedValue.slice(3, 15);       // 12 bytes
    const ciphertext = encryptedValue.slice(15, -16); // everything except last 16 bytes
    const tag = encryptedValue.slice(-16);             // last 16 bytes = GCM auth tag

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return decrypted.toString('utf8');
    } catch (e) {
      return '';
    }
  }

  return '';
}

// Step 3: Read cookies from SQLite
function readCookies(key) {
  // Copy DB since Chrome locks it
  fs.copyFileSync(COOKIE_DB, COOKIE_COPY);

  const Database = require('better-sqlite3');
  const db = new Database(COOKIE_COPY, { readonly: true });

  const rows = db.prepare(
    "SELECT name, encrypted_value, host_key, path, is_secure, is_httponly, expires_utc FROM cookies WHERE host_key LIKE '%claude.ai%' OR host_key LIKE '%anthropic%'"
  ).all();

  db.close();

  const cookies = rows.map(row => ({
    name: row.name,
    value: decryptCookieValue(row.encrypted_value, key),
    domain: row.host_key,
    path: row.path,
    secure: row.is_secure === 1,
    httpOnly: row.is_httponly === 1,
    expires: row.expires_utc
  })).filter(c => c.value); // Only keep successfully decrypted

  return cookies;
}

try {
  log('Extracting Chrome decryption key via DPAPI...');
  const key = getDecryptionKey();
  log('Got ' + key.length + '-byte key');

  log('Reading cookies for claude.ai...');
  const cookies = readCookies(key);
  log('Found ' + cookies.length + ' cookies');

  if (cookies.length > 0) {
    cookies.forEach(c => log('  ' + c.name + ' = ' + c.value.substring(0, 30) + '...'));
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(cookies, null, 2));
    log('Saved to ' + OUTPUT_FILE);
  } else {
    log('No claude.ai cookies found. Is claude.ai logged in on ' + PROFILE + '?');
  }

  // Cleanup
  try { fs.unlinkSync(COOKIE_COPY); } catch {}
} catch (e) {
  log('Error: ' + e.message);
  process.exit(1);
}
