// ─── SyncTabs E2EE Crypto Module ──────────────────────────────────────────────
// Standalone module using the Web Crypto API (AES-GCM 256-bit).
// Attaches to `self.SyncTabsE2EE` for service-worker compatibility.

(() => {
  'use strict';

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  /** Convert a Uint8Array to a hex string. */
  function bufToHex(buf) {
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** Convert a hex string to a Uint8Array. */
  function hexToBuf(hex) {
    if (typeof hex !== 'string' || hex.length % 2 !== 0) {
      throw new Error('Invalid hex string');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Generate a new AES-GCM 256-bit CryptoKey.
   * @returns {Promise<CryptoKey>}
   */
  async function generateKey() {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,    // extractable — needed for export
      ['encrypt', 'decrypt'],
    );
  }

  /**
   * Export a CryptoKey to a hex string (raw format).
   * @param {CryptoKey} cryptoKey
   * @returns {Promise<string>} 64-char hex string (32 bytes)
   */
  async function exportKey(cryptoKey) {
    const raw = await crypto.subtle.exportKey('raw', cryptoKey);
    return bufToHex(raw);
  }

  /**
   * Import a hex string back into an AES-GCM CryptoKey.
   * @param {string} hexString  64-char hex (32 bytes)
   * @returns {Promise<CryptoKey>}
   */
  async function importKey(hexString) {
    const raw = hexToBuf(hexString);
    return crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
  }

  /**
   * Encrypt a plaintext string with AES-GCM using a random 12-byte IV.
   * @param {CryptoKey} cryptoKey
   * @param {string}    plaintext
   * @returns {Promise<{iv: string, ciphertext: string}>}  Both values are hex strings.
   */
  async function encrypt(cryptoKey, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));   // 96-bit IV recommended for AES-GCM
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertextBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      encoded,
    );
    return {
      iv: bufToHex(iv),
      ciphertext: bufToHex(ciphertextBuf),
    };
  }

  /**
   * Decrypt hex iv + ciphertext back to a plaintext string.
   * @param {CryptoKey} cryptoKey
   * @param {string}    ivHex         Hex-encoded 12-byte IV
   * @param {string}    ciphertextHex Hex-encoded ciphertext (includes GCM auth tag)
   * @returns {Promise<string>}
   */
  async function decrypt(cryptoKey, ivHex, ciphertextHex) {
    const iv = hexToBuf(ivHex);
    const ciphertext = hexToBuf(ciphertextHex);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      ciphertext,
    );
    return new TextDecoder().decode(decrypted);
  }

  /**
   * Generate a random 16-byte hex room ID (32 hex chars).
   * @returns {string}
   */
  function generateRoomId() {
    return bufToHex(crypto.getRandomValues(new Uint8Array(16)));
  }

  // ─── Attach to global scope ─────────────────────────────────────────────────
  self.SyncTabsE2EE = {
    generateKey,
    exportKey,
    importKey,
    encrypt,
    decrypt,
    generateRoomId,
  };
})();
