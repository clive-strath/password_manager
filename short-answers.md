# Project 1: Short-answer Questions

## 1. Hiding password lengths

Before encryption, every password is padded to the same fixed length. `padPassword` builds a 68-byte buffer. The first 4 bytes hold the password's byte length, the next bytes hold the password, and the rest are zeros, up to the 64-byte maximum. AES-GCM is a stream-style mode, so the ciphertext is exactly as long as the plaintext plus a 16-byte tag. Every record is therefore 84 bytes, and every IV is 12 bytes, whatever the password. An adversary looking at the serialized database sees identical lengths for all entries and learns nothing about any password's length. On decryption, `unpadPassword` checks that the length field is at most 64 and that all padding bytes are zero. Malformed padding is treated as tampering.

## 2. Preventing swap attacks

Each record is encrypted with AES-GCM, and the record's KVS key, HMAC(k_domain, domain), is used as the associated data (AD). On `get(domain)`, the HMAC is recomputed and used as the AD for decryption. Suppose the adversary moves the record stored under HMAC(k, A) to the slot for HMAC(k, B). Decryption then runs with AD = HMAC(k, B), but the tag was computed over AD = HMAC(k, A). AES-GCM provides ciphertext integrity, so without the AES key the adversary cannot produce a ciphertext and tag that verify under a different AD, except with negligible probability. Decryption fails and an exception is thrown. The defense does not use the SHA-256 checksum, so it holds even when no `trustedDataCheck` is supplied.

## 3. Is a trusted location necessary for rollback defense?

Yes. Some trusted state that the adversary cannot roll back is needed. Every old dump was produced honestly with the same master password and keys, so it is internally consistent. Any MAC, signature or encryption over it still verifies, because the keys never change. If everything is stored where the adversary can replace it, they can swap the entire current database for an older valid one. The password manager, given only the password and the data on disk, cannot tell the two apart. Defending against this requires remembering something about the latest state. That could be a hash, a version counter or a timestamp, kept somewhere the adversary cannot modify, such as a flash drive, a secure hardware counter or a trusted server. The stored value only needs integrity, not secrecy.

## 4. Lookup with a randomized MAC

With a randomized MAC, recomputing MAC(k, domain) gives a different tag each time, so the tag cannot be used as a direct dictionary key. Each record would instead store its tag alongside its encrypted data. A lookup for domain x scans every record and runs MAC verification of x against each stored tag until one verifies (or none do). The performance penalty is that `get`, `set` and `remove` go from O(1) to O(n), costing up to n MAC verifications per operation instead of one HMAC and one dictionary lookup.

## 5. Leaking only ⌊log₂ k⌋ records

Pad the KVS with dummy records so that the total number of stored entries depends only on ⌊log₂ k⌋. With k real records, store exactly 2^(⌊log₂ k⌋+1) entries, plus a fixed size such as 0 or 1 for k = 0. All k between 2^j and 2^(j+1) − 1 then produce the same number of entries.

- **Dummy keys** are random 32-byte strings. Real keys are HMAC outputs, which are pseudorandom, so the two are indistinguishable.
- **Dummy values** are AES-GCM encryptions of a padded plaintext with a fresh IV, the same length as real records. Inside the encrypted plaintext, a flag byte marks whether the entry is real or dummy. Only the key holder can tell them apart.
- **Insert:** when a new real record is added, a dummy is removed to make room. If no dummies remain (k reaches 2^(j+1)), the store grows to the next power of two by adding new dummies.
- **Remove:** the real record is replaced with a dummy, and the store shrinks when k drops below 2^j.

An observer sees only the total entry count, which reveals ⌊log₂ k⌋ and nothing more precise.

## 6. Multi-user support for a shared site

Give the shared site its own independent key and store that key inside each user's private keychain.

- Create a random shared key K_s, from which a shared HMAC key and a shared AES-GCM key are derived. The shared record (for example, nytimes) is kept in a separate shared KVS, encrypted under K_s using the same HMAC-indexing, padding and AD-binding scheme.
- Alice stores K_s as an ordinary encrypted entry in her keychain, and Bob does the same in his. Each user decrypts K_s with their own master password, then reads or updates the shared record.
- Neither user ever learns the other's master password or derived keys. Their personal records stay encrypted under their own keys, so sharing nytimes reveals nothing about their other sites. Sharing K_s is safe because it is independent of both users' keys.
- The shared KVS gets its own SHA-256 checksum kept in trusted storage, for rollback protection on shared updates. To revoke a user, generate a new K_s, re-encrypt the shared record and distribute the new key only to the remaining users. If the users have public keys, K_s can be shared by encrypting it under each user's public key instead of transferring it some other way.
