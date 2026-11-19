"use strict";

/********* External Imports ********/

const { stringToBuffer, bufferToString, encodeBuffer, decodeBuffer, getRandomBytes } = require("./lib");
const { subtle } = require('crypto').webcrypto;

/********* Constants ********/

const PBKDF2_ITERATIONS = 100000; // number of iterations for PBKDF2 algorithm
const MAX_PASSWORD_LENGTH = 64;   // we can assume no password is longer than this many characters

/********* Implementation ********/
class Keychain {
  /**
   * Initializes the keychain using the provided information. Note that external
   * users should likely never invoke the constructor directly and instead use
   * either Keychain.init or Keychain.load. 
   * Arguments:
   *  You may design the constructor with any parameters you would like. 
   * Return Type: void
   */
  constructor(data, secrets) {
    this.data = data;
    this.secrets = secrets;
  };

  /** 
    * Creates an empty keychain with the given password.
    *
    * Arguments:
    *   password: string
    * Return Type: void
    */
  static async init(password) {
    const salt = getRandomBytes(16);
    const masterKeyBytes = await deriveMasterKey(password, salt);
    const secrets = await deriveSecrets(masterKeyBytes);

    const passwordCheck = encodeBuffer(await subtle.sign(
      "HMAC",
      secrets.masterHmacKey,
      stringToBuffer("password-check")
    ));

    const data = {
      salt: encodeBuffer(salt),
      passwordCheck,
      kvs: {}
    };

    return new Keychain(data, secrets);
  }

  /**
    * Loads the keychain state from the provided representation (repr). The
    * repr variable will contain a JSON encoded serialization of the contents
    * of the KVS (as returned by the dump function). The trustedDataCheck
    * is an *optional* SHA-256 checksum that can be used to validate the 
    * integrity of the contents of the KVS. If the checksum is provided and the
    * integrity check fails, an exception should be thrown. You can assume that
    * the representation passed to load is well-formed (i.e., it will be
    * a valid JSON object).Returns a Keychain object that contains the data
    * from repr. 
    *
    * Arguments:
    *   password:           string
    *   repr:               string
    *   trustedDataCheck: string
    * Return Type: Keychain
    */
  static async load(password, repr, trustedDataCheck) {
    if (trustedDataCheck !== undefined) {
      const digest = await subtle.digest("SHA-256", stringToBuffer(repr));
      const actualChecksum = encodeBuffer(digest);
      if (actualChecksum !== trustedDataCheck) {
        throw "Trusted integrity check failed";
      }
    }

    let serialized;
    try {
      serialized = JSON.parse(repr);
    } catch (error) {
      throw "Invalid keychain representation";
    }

    if (!serialized || typeof serialized !== "object" ||
        typeof serialized.salt !== "string" ||
        typeof serialized.passwordCheck !== "string" ||
        !serialized.kvs || typeof serialized.kvs !== "object") {
      throw "Invalid keychain representation";
    }

    const salt = decodeBuffer(serialized.salt);
    const masterKeyBytes = await deriveMasterKey(password, salt);
    const secrets = await deriveSecrets(masterKeyBytes);
    const validPassword = await subtle.verify(
      "HMAC",
      secrets.masterHmacKey,
      decodeBuffer(serialized.passwordCheck),
      stringToBuffer("password-check")
    );

    if (!validPassword) {
      throw "Incorrect password";
    }

    return new Keychain({
      salt: serialized.salt,
      passwordCheck: serialized.passwordCheck,
      kvs: serialized.kvs
    }, secrets);
  };

  /**
    * Returns a JSON serialization of the contents of the keychain that can be 
    * loaded back using the load function. The return value should consist of
    * an array of two strings:
    *   arr[0] = JSON encoding of password manager
    *   arr[1] = SHA-256 checksum (as a string)
    * As discussed in the handout, the first element of the array should contain
    * all of the data in the password manager. The second element is a SHA-256
    * checksum computed over the password manager to preserve integrity.
    *
    * Return Type: array
    */ 
  async dump() {
    const representation = JSON.stringify(this.data);
    const digest = await subtle.digest("SHA-256", stringToBuffer(representation));
    return [representation, encodeBuffer(digest)];
  };

  /**
    * Fetches the data (as a string) corresponding to the given domain from the KVS.
    * If there is no entry in the KVS that matches the given domain, then return
    * null.
    *
    * Arguments:
    *   name: string
    * Return Type: Promise<string>
    */
  async get(name) {
    const domainKey = await this._domainKey(name);
    const record = this.data.kvs[domainKey];
    if (record === undefined) {
      return null;
    }

    if (!record || typeof record.iv !== "string" ||
        typeof record.ciphertext !== "string") {
      throw "Tampering detected";
    }

    let plaintext;
    try {
      plaintext = await subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decodeBuffer(record.iv),
          additionalData: stringToBuffer(domainKey),
          tagLength: 128
        },
        this.secrets.aesKey,
        decodeBuffer(record.ciphertext)
      );
    } catch (error) {
      throw "Tampering detected";
    }

    return unpadPassword(plaintext);
  };

  /** 
  * Inserts the domain and associated data into the KVS. If the domain is
  * already in the password manager, this method should update its value. If
  * not, create a new entry in the password manager.
  *
  * Arguments:
  *   name: string
  *   value: string
  * Return Type: void
  */
  async set(name, value) {
    const domainKey = await this._domainKey(name);
    const iv = getRandomBytes(12);
    const padded = padPassword(value);

    const ciphertext = await subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: stringToBuffer(domainKey),
        tagLength: 128
      },
      this.secrets.aesKey,
      padded
    );

    this.data.kvs[domainKey] = {
      iv: encodeBuffer(iv),
      ciphertext: encodeBuffer(ciphertext)
    };
  };

  /**
    * Removes the record with name from the password manager. Returns true
    * if the record with the specified name is removed, false otherwise.
    *
    * Arguments:
    *   name: string
    * Return Type: Promise<boolean>
  */
  async remove(name) {
    const domainKey = await this._domainKey(name);
    if (!Object.prototype.hasOwnProperty.call(this.data.kvs, domainKey)) {
      return false;
    }

    delete this.data.kvs[domainKey];
    return true;
  };

  async _domainKey(name) {
    const tag = await subtle.sign(
      "HMAC",
      this.secrets.domainHmacKey,
      stringToBuffer(name)
    );
    return encodeBuffer(tag);
  }
};

async function deriveMasterKey(password, salt) {
  const passwordKey = await subtle.importKey(
    "raw",
    stringToBuffer(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  return await subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    passwordKey,
    256
  );
}

async function deriveSecrets(masterKeyBytes) {
  const masterHmacKey = await subtle.importKey(
    "raw",
    masterKeyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );

  const domainKeyBytes = await subtle.sign(
    "HMAC",
    masterHmacKey,
    stringToBuffer("domain-name-hmac")
  );
  const aesKeyBytes = await subtle.sign(
    "HMAC",
    masterHmacKey,
    stringToBuffer("aes-gcm-key")
  );

  const domainHmacKey = await subtle.importKey(
    "raw",
    domainKeyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const aesKey = await subtle.importKey(
    "raw",
    aesKeyBytes,
    "AES-GCM",
    true,
    ["encrypt", "decrypt"]
  );

  return {
    masterHmacKey,
    domainHmacKey,
    aesKey
  };
}

function padPassword(password) {
  if (typeof password !== "string") {
    throw "Password must be a string";
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw "Password exceeds maximum length";
  }

  const text = Buffer.from(password, "utf8");
  if (text.length > MAX_PASSWORD_LENGTH) {
    throw "Password exceeds maximum encoded length";
  }

  const padded = Buffer.alloc(MAX_PASSWORD_LENGTH + 4);
  padded.writeUInt32BE(text.length, 0);
  text.copy(padded, 4);
  return padded;
}

function unpadPassword(padded) {
  const bytes = Buffer.from(padded);
  if (bytes.length !== MAX_PASSWORD_LENGTH + 4) {
    throw "Tampering detected";
  }

  const length = bytes.readUInt32BE(0);
  if (length > MAX_PASSWORD_LENGTH) {
    throw "Tampering detected";
  }

  for (let i = 4 + length; i < bytes.length; i++) {
    if (bytes[i] !== 0) {
      throw "Tampering detected";
    }
  }

  return bufferToString(bytes.subarray(4, 4 + length));
}

module.exports = { Keychain }
