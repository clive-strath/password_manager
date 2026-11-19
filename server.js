"use strict";

/*
 * Local web UI for the Keychain library.
 *
 * Run with:  npm run ui   (then open http://localhost:3000)
 *
 * This file is NOT part of the assignment submission. It only calls the
 * public API of password-manager.js (init, load, dump, set, get, remove)
 * and handles what the library leaves out: HTTP, the browser UI, and
 * saving the vault to disk.
 *
 * Files on disk:
 *   vault-data/vault.json    the output of dump()[0] (already encrypted)
 *   vault-data/vault.sha256  the output of dump()[1]; stands in for the
 *                            "trusted storage" used for rollback protection
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Keychain } = require("./password-manager");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.VAULT_DIR || path.join(__dirname, "vault-data");
const VAULT_FILE = path.join(DATA_DIR, "vault.json");
const CHECKSUM_FILE = path.join(DATA_DIR, "vault.sha256");
const UI_DIR = path.join(__dirname, "ui");
const IDLE_LOCK_MS = 10 * 60 * 1000; // auto-lock after 10 minutes idle
const MAX_BODY_BYTES = 16 * 1024;

const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

/********* Vault state ********/

let keychain = null; // unlocked Keychain, or null when locked
let domains = [];    // in-memory copy of the encrypted domain index
let lastActivity = 0;

function vaultExists() {
  return fs.existsSync(VAULT_FILE);
}

function lock() {
  keychain = null;
  domains = [];
}

/********* Domain index ********
 *
 * The library stores domains only as HMACs, so it can't list them. To list
 * them, the UI keeps an index *inside the keychain* as ordinary entries:
 *
 *   "\0index-count"  -> number of indexed domains
 *   "\0index:0"      -> first domain name
 *   "\0index:1"      -> second domain name ...
 *
 * These entries are encrypted, padded and swap/rollback-protected exactly
 * like passwords. The "\0" prefix can't appear in a real domain (control
 * characters are rejected), so the index never collides with user entries.
 */

const INDEX_COUNT = "\u0000index-count";
const indexSlot = (i) => `\u0000index:${i}`;

async function loadIndex() {
  const countText = await keychain.get(INDEX_COUNT);
  const count = countText === null ? 0 : Number(countText);
  if (!Number.isInteger(count) || count < 0) throw new Error("Domain index is corrupt");

  const list = [];
  for (let i = 0; i < count; i++) {
    const domain = await keychain.get(indexSlot(i));
    if (domain === null) throw new Error("Domain index is corrupt");
    list.push(domain);
  }
  domains = list;
}

async function indexAdd(domain) {
  if (domains.includes(domain)) return false;
  await keychain.set(indexSlot(domains.length), domain);
  domains.push(domain);
  await keychain.set(INDEX_COUNT, String(domains.length));
  return true;
}

async function indexRemove(domain) {
  const i = domains.indexOf(domain);
  if (i === -1) return false;
  const last = domains.length - 1;
  if (i !== last) {
    // Move the last domain into the freed slot so slots stay contiguous.
    await keychain.set(indexSlot(i), domains[last]);
    domains[i] = domains[last];
  }
  await keychain.remove(indexSlot(last));
  domains.pop();
  await keychain.set(INDEX_COUNT, String(domains.length));
  return true;
}

function writeFileAtomic(file, contents) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function saveVault() {
  const [repr, checksum] = await keychain.dump();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(VAULT_FILE, repr);
  writeFileAtomic(CHECKSUM_FILE, checksum);
}

setInterval(() => {
  if (keychain && Date.now() - lastActivity > IDLE_LOCK_MS) {
    lock();
    console.log("Vault auto-locked after inactivity.");
  }
}, 30 * 1000).unref();

/********* HTTP helpers ********/

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function errorText(e) {
  return typeof e === "string" ? e : (e && e.message) || "Unknown error";
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const type = req.headers["content-type"] || "";
    if (!type.startsWith("application/json")) {
      reject(new HttpError(415, "Expected application/json"));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(new HttpError(400, "Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `${field} is required`);
  }
  return value;
}

function requireDomain(value) {
  const domain = requireString(typeof value === "string" ? value.trim() : value, "Domain");
  if (/[\u0000-\u001f\u007f]/.test(domain)) {
    throw new HttpError(400, "Domain contains invalid characters");
  }
  if (domain.length > 64) {
    throw new HttpError(400, "Domain must be 64 characters or fewer");
  }
  return domain.toLowerCase();
}

function requireUnlocked() {
  if (!keychain) throw new HttpError(423, "Vault is locked");
  lastActivity = Date.now();
}

/********* API routes ********/

const routes = {
  "GET /api/status": async () => ({
    exists: vaultExists(),
    unlocked: keychain !== null,
  }),

  "POST /api/unlock": async (body) => {
    const password = requireString(body.password, "Master password");

    if (!vaultExists()) {
      keychain = await Keychain.init(password);
      domains = [];
      await saveVault();
      lastActivity = Date.now();
      return { created: true };
    }

    const repr = fs.readFileSync(VAULT_FILE, "utf8");
    const checksum = fs.existsSync(CHECKSUM_FILE)
      ? fs.readFileSync(CHECKSUM_FILE, "utf8").trim()
      : undefined;

    try {
      keychain = await Keychain.load(password, repr, checksum);
    } catch (e) {
      const text = errorText(e);
      if (/password/i.test(text)) {
        throw new HttpError(401, "Wrong master password.");
      }
      if (/integrity/i.test(text)) {
        throw new HttpError(409,
          "The vault file doesn't match its saved checksum. It may have been tampered with or rolled back.");
      }
      throw new HttpError(500, `Could not open vault: ${text}`);
    }

    try {
      await loadIndex();
    } catch (e) {
      lock();
      throw new HttpError(409, `The domain list failed its integrity check: ${errorText(e)}`);
    }
    lastActivity = Date.now();
    return { created: false };
  },

  "POST /api/list": async () => {
    requireUnlocked();
    return { domains: [...domains].sort() };
  },

  "POST /api/lock": async () => {
    lock();
    return { locked: true };
  },

  "POST /api/set": async (body) => {
    requireUnlocked();
    const domain = requireDomain(body.domain);
    const password = requireString(body.password, "Password");
    try {
      await keychain.set(domain, password);
    } catch (e) {
      throw new HttpError(400, errorText(e));
    }
    await indexAdd(domain);
    await saveVault();
    return { saved: true, domain };
  },

  "POST /api/get": async (body) => {
    requireUnlocked();
    const domain = requireDomain(body.domain);
    let password;
    try {
      password = await keychain.get(domain);
    } catch (e) {
      throw new HttpError(409, `This entry failed its integrity check: ${errorText(e)}`);
    }
    // Entries saved before the index existed get added the first time
    // they're looked up.
    if (password !== null && await indexAdd(domain)) await saveVault();
    return { domain, password };
  },

  "POST /api/remove": async (body) => {
    requireUnlocked();
    const domain = requireDomain(body.domain);
    const removed = await keychain.remove(domain);
    const unindexed = await indexRemove(domain);
    if (removed || unindexed) await saveVault();
    return { removed, domain };
  },
};

/********* Server ********/

const server = http.createServer(async (req, res) => {
  try {
    // Reject requests not addressed to this local server (DNS rebinding).
    if (!ALLOWED_HOSTS.has(req.headers.host || "")) {
      throw new HttpError(403, "Forbidden host");
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && STATIC_FILES[url.pathname]) {
      const { file, type } = STATIC_FILES[url.pathname];
      send(res, 200, fs.readFileSync(path.join(UI_DIR, file)), type);
      return;
    }

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) throw new HttpError(404, "Not found");

    let body = {};
    if (req.method === "POST") {
      // Block cross-site requests from other pages open in the browser.
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) {
        throw new HttpError(403, "Forbidden origin");
      }
      body = await readJsonBody(req);
    }

    send(res, 200, await handler(body));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: errorText(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Password manager UI running at http://localhost:${PORT}`);
  console.log(`Vault files: ${DATA_DIR}`);
});
