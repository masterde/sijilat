// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

// Package sijilatapi is a hand-authored client for Bahrain's Sijilat commercial
// registry. The upstream is an undocumented JSON API: it authenticates with a
// public OAuth password grant whose credentials are constants embedded in the
// site's own JavaScript (so no user key is required), and its detail endpoints
// expect a CryptoJS-AES-encrypted request body. Both mechanisms are replicated
// here in pure Go so the CLI replays everything over plain HTTPS.
package sijilatapi

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/md5" // #nosec G501 -- MD5 is required by OpenSSL EVP_BytesToKey, the KDF CryptoJS.AES uses; it is the wire format, not a security choice.
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
)

// These are PUBLIC constants lifted verbatim from the Sijilat site bundle
// (the same values every visitor's browser uses). They are not user secrets;
// they are the app-level handshake the public search depends on.
const (
	tokenHMACKey  = "UHxNtYMRYwvfpO1dS5pWLKL0M2DgOj40EbN4SoBWgfc" // #nosec G101 -- public app-handshake key lifted verbatim from the site's own JS bundle; identical for every visitor, not a user secret.
	tokenAppName  = "sijilat_test"                                // hmac message ("password" arg)
	tokenUsername = "sijilat"                                     // form username
	aesPassphrase = "MySecretKey"                                 // CryptoJS.AES passphrase
)

// tokenPassword reproduces the site's `sha256.hmac(key, "sijilat_test")`:
// HMAC-SHA256 over the app name, lowercase hex. This is the value POSTed as the
// OAuth `password` field.
func tokenPassword() string {
	mac := hmac.New(sha256.New, []byte(tokenHMACKey))
	mac.Write([]byte(tokenAppName))
	return hex.EncodeToString(mac.Sum(nil))
}

// encryptBody reproduces `CryptoJS.AES.encrypt(plaintext, "MySecretKey").toString()`,
// which is OpenSSL's salted format: base64("Salted__" + salt[8] + AES-256-CBC
// ciphertext), with the key+IV derived from the passphrase and salt via the
// MD5-based EVP_BytesToKey KDF. The detail endpoints reject anything else.
func encryptBody(plaintext []byte) (string, error) {
	salt := make([]byte, 8)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generating salt: %w", err)
	}
	key, iv := evpBytesToKey([]byte(aesPassphrase), salt, 32, 16)

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("aes cipher: %w", err)
	}
	padded := pkcs7Pad(plaintext, block.BlockSize())
	ct := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ct, padded)

	out := make([]byte, 0, 16+len(ct))
	out = append(out, []byte("Salted__")...)
	out = append(out, salt...)
	out = append(out, ct...)
	return base64.StdEncoding.EncodeToString(out), nil
}

// evpBytesToKey is OpenSSL's legacy MD5 key-derivation (the default CryptoJS
// uses): repeatedly hash (previous || passphrase || salt) until enough bytes
// for key+IV are produced.
func evpBytesToKey(passphrase, salt []byte, keyLen, ivLen int) (key, iv []byte) {
	var derived []byte
	var prev []byte
	for len(derived) < keyLen+ivLen {
		h := md5.New() // #nosec G401 -- MD5 here is the OpenSSL EVP_BytesToKey KDF that CryptoJS uses; mandated by the upstream wire format, not used for integrity.
		h.Write(prev)
		h.Write(passphrase)
		h.Write(salt)
		prev = h.Sum(nil)
		derived = append(derived, prev...)
	}
	return derived[:keyLen], derived[keyLen : keyLen+ivLen]
}

func pkcs7Pad(data []byte, blockSize int) []byte {
	pad := blockSize - len(data)%blockSize
	out := make([]byte, len(data)+pad)
	copy(out, data)
	for i := len(data); i < len(out); i++ {
		out[i] = byte(pad) // #nosec G115 -- pad is 1..blockSize (<=16 for AES), always within a byte; PKCS#7 by construction.
	}
	return out
}
