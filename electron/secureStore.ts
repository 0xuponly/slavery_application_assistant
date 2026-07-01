import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const KEY_LEN = 32
const KEY_FILE = 'apply-assistant-key'
const DEK_PLAINTEXT_MARKER = 'pln:' // indicates DEK is stored unencrypted (keyring unavailable)

/**
 * Returns a 32-byte data encryption key, unsealed from the on-disk DEK file.
 * If the key file doesn't exist, generates a new DEK, seals it via safeStorage
 * (or stores it in plaintext with a marker if encryption is unavailable), and
 * writes it.
 *
 * If `required` is true, throws when safeStorage is unavailable so callers can
 * refuse to proceed.
 */
export function getOrCreateDek(required = false): Buffer {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const keyPath = join(dir, KEY_FILE)

  if (existsSync(keyPath)) {
    const stored = readFileSync(keyPath, 'utf-8').trim()
    if (stored.startsWith(DEK_PLAINTEXT_MARKER)) {
      if (required) {
        throw new Error(
          'Encryption unavailable on this system. The app requires OS keyring access to keep your data private.'
        )
      }
      return Buffer.from(stored.slice(DEK_PLAINTEXT_MARKER.length), 'hex')
    }
    if (!safeStorage.isEncryptionAvailable()) {
      if (required) {
        throw new Error('safeStorage unavailable; cannot unseal data encryption key.')
      }
      return Buffer.from(stored, 'hex')
    }
    try {
      const buf = Buffer.from(stored, 'hex')
      // safeStorage.decryptString returns the original plaintext that was
      // passed to encryptString — in our case that was `dek.toString('hex')`,
      // a 64-char hex string. Convert back to 32 raw bytes for AES-256-GCM.
      return Buffer.from(safeStorage.decryptString(buf), 'hex')
    } catch {
      // Sealed key corrupted; regenerate
    }
  }

  // First run: generate DEK
  const dek = randomBytes(KEY_LEN)
  if (safeStorage.isEncryptionAvailable()) {
    const sealed = safeStorage.encryptString(dek.toString('hex'))
    const sealedHex = Buffer.isBuffer(sealed) ? sealed.toString('hex') : String(sealed)
    writeFileSync(keyPath, sealedHex)
  } else {
    if (required) {
      throw new Error(
        'Encryption unavailable on this system. The app requires OS keyring access to keep your data private.'
      )
    }
    writeFileSync(keyPath, DEK_PLAINTEXT_MARKER + dek.toString('hex'))
  }
  try {
    if (process.platform !== 'win32') require('fs').chmodSync(keyPath, 0o600)
  } catch {
    // best-effort
  }
  return dek
}

export function deleteDek(): void {
  const keyPath = join(app.getPath('userData'), KEY_FILE)
  if (existsSync(keyPath)) unlinkSync(keyPath)
}

export function encryptionMode(): 'sealed' | 'plaintext-fallback' {
  const dir = app.getPath('userData')
  const keyPath = join(dir, KEY_FILE)
  if (!existsSync(keyPath)) return safeStorage.isEncryptionAvailable() ? 'sealed' : 'plaintext-fallback'
  const stored = readFileSync(keyPath, 'utf-8').trim()
  return stored.startsWith(DEK_PLAINTEXT_MARKER) ? 'plaintext-fallback' : 'sealed'
}

function deriveMachineSalt(): Buffer {
  // Deterministic per-user salt from stable identifiers. Combined with the
  // safeStorage-sealed DEK (or the plaintext DEK on fallback) this provides
  // a key that's at least bound to the user account, not just an attacker
  // who can read the data file.
  const seed = `${process.platform}|${process.env.USER || process.env.USERNAME || 'unknown'}|${app.getPath('userData')}`
  return createHash('sha256').update(seed).digest().subarray(0, 16)
}

export function encryptString(plaintext: string, dek: Buffer): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, dek, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

export function decryptString(payload: string, dek: Buffer): string {
  const buf = Buffer.from(payload, 'base64')
  if (buf.length < IV_LEN + 16) return ''
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + 16)
  const ct = buf.subarray(IV_LEN + 16)
  const decipher = createDecipheriv(ALGO, dek, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8')
}

/**
 * Encrypt an entire JSON-serializable object and return a self-describing
 * envelope string. The envelope includes a version byte, the algorithm, and
 * a payload marker so future versions can be detected.
 */
const ENVELOPE_PREFIX = 'enc:v1:'

export function encryptJson(obj: unknown, dek: Buffer): string {
  const json = JSON.stringify(obj)
  return ENVELOPE_PREFIX + encryptString(json, dek)
}

export function decryptJson<T = unknown>(payload: string, dek: Buffer): T {
  if (!payload.startsWith(ENVELOPE_PREFIX)) {
    // Not encrypted — assume plaintext legacy format
    return JSON.parse(payload) as T
  }
  return JSON.parse(decryptString(payload.slice(ENVELOPE_PREFIX.length), dek)) as T
}

export { deriveMachineSalt }