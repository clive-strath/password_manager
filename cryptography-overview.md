# Cryptography Used in the Password Manager

The project uses six cryptographic tools: PBKDF2, HMAC-SHA-256, AES-GCM, SHA-256, a secure random number generator, and length padding. Almost all of it lives in [password-manager.js](password-manager.js) and goes through Node's built-in Web Crypto API (`subtle`). The web UI adds no cryptography of its own; it only calls the library, apart from one random-number use in the password generator.

## 1. PBKDF2 (turns the master password into a key)

- **Where:** `deriveMasterKey` in [password-manager.js:234-253](password-manager.js#L234-L253), called once in `init` ([line 37](password-manager.js#L37)) and once in `load`.
- **How:** PBKDF2 with SHA-256, 100,000 iterations and a random 16-byte (128-bit) salt. It outputs a 256-bit master key.
- **Why:** it's deliberately slow, which makes guessing master passwords expensive. The salt means an attacker has to start over for each vault and can't reuse precomputed tables. The salt is stored in the clear, which is safe; the master password is never stored.

## 2. HMAC-SHA-256 (used three ways)

**a) Deriving the sub-keys.** In `deriveSecrets` ([password-manager.js:255-295](password-manager.js#L255-L295)), the master key is used as an HMAC key and HMAC is evaluated on two fixed labels: `"domain-name-hmac"` and `"aes-gcm-key"`. The outputs become two independent keys, one for HMAC on domain names and one for AES-GCM. HMAC acts as a PRF here, as the spec asks.

**b) Hiding domain names.** `_domainKey` ([password-manager.js:224-231](password-manager.js#L224-L231)) computes HMAC(domain key, domain). The result is the KVS key, so domains never appear in the clear. HMAC is deterministic, so the same domain always maps to the same key, which is what makes lookups O(1).

**c) Checking the master password.** `init` stores `passwordCheck` = HMAC(master key, `"password-check"`) ([line 40](password-manager.js#L40)). On `load`, `subtle.verify` ([line 98](password-manager.js#L98)) recomputes it and compares, using a constant-time comparison. A wrong password gives a different key, so verification fails. The stored value reveals nothing about the password beyond what an attacker could learn by trying passwords offline anyway.

## 3. AES-GCM (encrypts passwords and checks they haven't been changed)

- **Where:** `subtle.encrypt` in `set` ([password-manager.js:189](password-manager.js#L189)) and `subtle.decrypt` in `get` ([line 157](password-manager.js#L157)).
- **How:** a 256-bit key, a fresh random 12-byte IV for every record ([line 186](password-manager.js#L186)), and a 128-bit authentication tag. Each record is encrypted separately, as the spec requires.
- **Associated data:** the record's domain HMAC is passed as `additionalData` ([lines 161, 193](password-manager.js#L161)). This is the **swap-attack defense**. If a record is moved to another domain's slot, its tag no longer verifies and `get` throws. It works even without the checksum.

## 4. SHA-256 (rollback defense)

- **Where:** `dump` hashes the whole serialized vault ([password-manager.js:130](password-manager.js#L130)), and `load` recomputes the hash and compares it to the trusted value ([line 74](password-manager.js#L74)).
- **Why:** an attacker can't substitute an older copy of the vault or edit the file without changing the hash. The web UI keeps this hash in `vault-data/vault.sha256` as a stand-in for trusted storage.

## 5. Secure random number generation

- **Where:** `getRandomBytes` in [lib.js:47-49](lib.js#L47-L49), which uses Node's cryptographically secure `crypto.getRandomValues`.
- **Used for:** the PBKDF2 salt (16 bytes) and every AES-GCM IV (12 bytes).
- **In the UI:** the password generator ([ui/app.js:149](ui/app.js#L149)) uses the browser's `crypto.getRandomValues`, with rejection sampling so every character is equally likely.

## 6. Length-hiding padding (not a cryptographic primitive, but security-relevant)

- **Where:** `padPassword` and `unpadPassword` ([password-manager.js:297-337](password-manager.js#L297-L337)).
- **How:** every password is padded to a fixed 68 bytes before encryption: a 4-byte length field, then the password, then zeros. All ciphertexts end up the same length, so the file doesn't reveal any password's length. On decryption, bad padding is treated as tampering.

## Not cryptography

**Base64** (`encodeBuffer`/`decodeBuffer` in [lib.js](lib.js)) is only an encoding. It turns binary data into text so it can be stored as JSON and used as object keys, and it doesn't hide anything.

## How the keys fit together

```
master password ──PBKDF2(salt, 100k)──▶ master key
                                          ├─HMAC("domain-name-hmac")─▶ domain HMAC key ─▶ KVS keys
                                          ├─HMAC("aes-gcm-key")──────▶ AES-GCM key ────▶ encrypted passwords
                                          └─HMAC("password-check")───▶ passwordCheck (stored)
```
