// Crypto primitives reproducing the Sijilat site's public handshake.
//
// The registry's own JavaScript authenticates with a public OAuth password
// grant (HMAC-SHA256 of a constant app name) and encrypts non-search request
// bodies with CryptoJS.AES (OpenSSL "Salted__" / MD5-KDF / AES-256-CBC). Both
// are reproduced here so this API replays everything over plain HTTPS. None of
// these constants are user secrets — they are identical for every visitor.

import { createHash, createHmac, createCipheriv, randomBytes } from "node:crypto";

const TOKEN_HMAC_KEY = "UHxNtYMRYwvfpO1dS5pWLKL0M2DgOj40EbN4SoBWgfc";
const TOKEN_APP_NAME = "sijilat_test";
const AES_PASSPHRASE = "MySecretKey";

/** Reproduces `sha256.hmac(key, "sijilat_test")`: HMAC-SHA256, lowercase hex. */
export function tokenPassword(): string {
  return createHmac("sha256", TOKEN_HMAC_KEY).update(TOKEN_APP_NAME).digest("hex");
}

/**
 * Reproduces `CryptoJS.AES.encrypt(plaintext, "MySecretKey").toString()`:
 * base64("Salted__" + salt[8] + AES-256-CBC ciphertext) with key+IV derived via
 * the MD5-based OpenSSL EVP_BytesToKey KDF.
 */
export function encryptBody(plaintext: string): string {
  const salt = randomBytes(8);
  const { key, iv } = evpBytesToKey(Buffer.from(AES_PASSPHRASE), salt, 32, 16);
  const cipher = createCipheriv("aes-256-cbc", key, iv); // PKCS#7 padding by default
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([Buffer.from("Salted__"), salt, ct]).toString("base64");
}

function evpBytesToKey(
  passphrase: Buffer,
  salt: Buffer,
  keyLen: number,
  ivLen: number,
): { key: Buffer; iv: Buffer } {
  let derived = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (derived.length < keyLen + ivLen) {
    const h = createHash("md5");
    h.update(prev);
    h.update(passphrase);
    h.update(salt);
    prev = h.digest();
    derived = Buffer.concat([derived, prev]);
  }
  return { key: derived.subarray(0, keyLen), iv: derived.subarray(keyLen, keyLen + ivLen) };
}

export const TOKEN_USERNAME = "sijilat";
