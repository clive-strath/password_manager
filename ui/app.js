"use strict";

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const MASK = "•".repeat(12);

let items = [];        // [{ domain, icon }] from /api/list
let detail = null;     // { domain, password, icon } shown in the detail dialog
let editing = null;    // domain being edited in the item dialog, or null when adding
let toastTimer = null;

/********* Small helpers ********/

const UI_ICONS = {
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  refresh: "M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4",
  dice: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01",
};

function uiIcon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", UI_ICONS[name]);
  svg.append(path);
  return svg;
}

function setIcon(button, name) {
  button.replaceChildren(uiIcon(name));
}

function toast(message, kind = "ok") {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

async function api(path, body) {
  const options = body === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (res.status === 423) {
    clearSensitive();
    showView("unlock");
    throw new Error("The vault locked. Unlock it to continue.");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function withBusy(form, fn) {
  const buttons = form.querySelectorAll("button");
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await fn();
  } catch (e) {
    toast(e.message, "error");
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

async function copyText(text, what = "Password") {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied to clipboard.`);
  } catch {
    toast("Couldn't access the clipboard.", "error");
  }
}

/********* Logos ********/

function hueOf(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function isLight(hex) {
  const n = parseInt(hex, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 186;
}

/** Brand background + glyph colour for an item. */
function brandColors(icon, domain) {
  const hex = icon && /^[0-9a-f]{6}$/i.test(icon.hex || "") ? icon.hex : null;
  if (!hex) return { bg: `hsl(${hueOf(domain)} 38% 42%)`, fg: "#ffffff" };
  return { bg: `#${hex}`, fg: isLight(hex) ? "#14161a" : "#ffffff" };
}

function applyBrand(el, icon, domain) {
  const { bg, fg } = brandColors(icon, domain);
  el.style.setProperty("--brand", bg);
  el.style.setProperty("--glyph", fg);
}

function displayName(item) {
  return (item.icon && item.icon.title) || item.domain;
}

/** Fills `el` with the brand glyph, or the first letter of the name. */
function fillGlyph(el, icon, domain) {
  if (icon && typeof icon.path === "string" && icon.path) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", icon.path);
    svg.append(path);
    el.replaceChildren(svg);
  } else {
    const letter = document.createElement("span");
    letter.className = "letter";
    letter.textContent = ((icon && icon.title) || domain || "?").trim().charAt(0).toUpperCase();
    el.replaceChildren(letter);
  }
}

function logoEl(icon, domain, size) {
  const el = document.createElement("div");
  el.className = `logo logo-${size}`;
  applyBrand(el, icon, domain);
  fillGlyph(el, icon, domain);
  return el;
}

/********* Views ********/

function showView(name) {
  const auth = name !== "vault";
  $("view-auth").hidden = !auth;
  $("view-vault").hidden = auth;
  $("auth-loading").hidden = name !== "loading";
  $("setup-form").hidden = name !== "setup";
  $("unlock-form").hidden = name !== "unlock";

  if (name === "vault") refreshItems();
  const focusTarget = { setup: "setup-password", unlock: "unlock-password", vault: "search" }[name];
  if (focusTarget) $(focusTarget).focus();
}

function closeDialogs() {
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
}

function clearSensitive() {
  closeDialogs();
  detail = null;
  editing = null;
  items = [];
  $("items").replaceChildren();
  $("detail-password").textContent = "";
  $("gen-password").textContent = "";
  for (const id of ["setup-password", "setup-confirm", "unlock-password", "item-password", "item-domain", "search"]) {
    $(id).value = "";
  }
}

/********* Item list ********/

let layout = "grid";
try { if (localStorage.getItem("keychain.layout") === "list") layout = "list"; } catch { /* ignore */ }

function setLayout(next) {
  layout = next;
  try { localStorage.setItem("keychain.layout", next); } catch { /* ignore */ }
  $("items").className = `items ${next}`;
  $("view-grid").setAttribute("aria-pressed", String(next === "grid"));
  $("view-list").setAttribute("aria-pressed", String(next === "list"));
}

async function refreshItems() {
  try {
    const data = await api("/api/list", {});
    // Older servers return { domains: [...] } without icons.
    items = Array.isArray(data.items)
      ? data.items
      : (data.domains || []).map((domain) => ({ domain, icon: null }));
    items.sort((a, b) => displayName(a).localeCompare(displayName(b)) || a.domain.localeCompare(b.domain));
  } catch (e) {
    toast(e.message, "error");
    return;
  }
  renderItems();
}

function renderItems() {
  const q = $("search").value.trim().toLowerCase();
  const shown = items.filter((it) =>
    it.domain.includes(q) || displayName(it).toLowerCase().includes(q));

  $("item-count").textContent = items.length ? `(${items.length})` : "";
  $("nav-count").textContent = String(items.length);
  $("items").replaceChildren(...shown.map(tileEl));

  const empty = $("empty");
  empty.hidden = shown.length > 0;
  const lookup = $("empty-lookup");
  if (items.length === 0 && !q) {
    $("empty-title").textContent = "Your vault is empty";
    $("empty-text").textContent = "Add your first password and it will show up here with the site's logo.";
    lookup.hidden = true;
  } else {
    $("empty-title").textContent = "No matches";
    $("empty-text").textContent = `Nothing in the list matches “${q}”. Older entries only appear after a lookup.`;
    lookup.hidden = !q;
    lookup.textContent = `Look up “${q}”`;
  }
}

function tileEl(item) {
  const li = document.createElement("li");
  li.className = "tile";

  const main = document.createElement("button");
  main.type = "button";
  main.className = "tile-main";
  main.setAttribute("aria-label", `${displayName(item)} (${item.domain})`);
  main.addEventListener("click", () => openDetail(item.domain));

  const art = document.createElement("div");
  art.className = "tile-art";
  applyBrand(art, item.icon, item.domain);
  fillGlyph(art, item.icon, item.domain);

  const text = document.createElement("div");
  text.className = "tile-text";
  const name = document.createElement("span");
  name.className = "tile-name";
  name.textContent = displayName(item);
  const domain = document.createElement("span");
  domain.className = "tile-domain";
  domain.textContent = item.domain;
  text.append(name, domain);
  main.append(art, text);

  const actions = document.createElement("div");
  actions.className = "tile-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.title = "Copy password";
  copy.setAttribute("aria-label", `Copy password for ${item.domain}`);
  copy.append(uiIcon("copy"));
  copy.addEventListener("click", () => quickCopy(item.domain));
  const edit = document.createElement("button");
  edit.type = "button";
  edit.title = "Edit";
  edit.setAttribute("aria-label", `Edit ${item.domain}`);
  edit.append(uiIcon("edit"));
  edit.addEventListener("click", () => quickEdit(item.domain));
  actions.append(copy, edit);

  li.append(main, actions);
  return li;
}

async function fetchEntry(domain) {
  const entry = await api("/api/get", { domain });
  if (entry.password === null) {
    toast(`No password saved for ${entry.domain}.`, "error");
    await refreshItems();
    return null;
  }
  return entry;
}

async function quickCopy(domain) {
  try {
    const entry = await fetchEntry(domain);
    if (entry) await copyText(entry.password);
  } catch (e) {
    toast(e.message, "error");
  }
}

async function quickEdit(domain) {
  try {
    const entry = await fetchEntry(domain);
    if (entry) openItemDialog(entry);
  } catch (e) {
    toast(e.message, "error");
  }
}

/********* Detail dialog ********/

let deleteArmed = false;
let deleteTimer = null;

function disarmDelete() {
  deleteArmed = false;
  clearTimeout(deleteTimer);
  $("detail-delete").textContent = "Delete";
  $("detail-delete").classList.remove("armed");
}

async function openDetail(domain) {
  let entry;
  try {
    entry = await fetchEntry(domain);
  } catch (e) {
    toast(e.message, "error");
    return;
  }
  if (!entry) return;
  detail = entry;

  const hero = $("detail-hero");
  applyBrand(hero, entry.icon, entry.domain);
  hero.querySelector(".logo")?.remove();
  hero.append(logoEl(entry.icon, entry.domain, "xl"));

  $("detail-name").textContent = displayName(entry);
  $("detail-domain").textContent = entry.domain;
  setSecretVisible(false);
  disarmDelete();

  if (!$("detail-dialog").open) $("detail-dialog").showModal();
  $("detail-copy").focus();
  if (!items.some((it) => it.domain === entry.domain)) await refreshItems(); // a lookup can add an older entry
}

function setSecretVisible(visible) {
  $("detail-password").textContent = visible && detail ? detail.password : MASK;
  setIcon($("detail-toggle"), visible ? "eyeOff" : "eye");
  $("detail-toggle").setAttribute("aria-label", visible ? "Hide password" : "Show password");
  $("detail-toggle").dataset.visible = String(visible);
}

$("detail-toggle").addEventListener("click", () => {
  setSecretVisible($("detail-toggle").dataset.visible !== "true");
});
$("detail-copy").addEventListener("click", () => { if (detail) copyText(detail.password); });
$("detail-close").addEventListener("click", () => $("detail-dialog").close());
$("detail-x").addEventListener("click", () => $("detail-dialog").close());
$("detail-edit").addEventListener("click", () => {
  if (!detail) return;
  const entry = detail;
  $("detail-dialog").close();
  openItemDialog(entry);
});

$("detail-delete").addEventListener("click", async () => {
  if (!detail) return;
  if (!deleteArmed) {
    deleteArmed = true;
    $("detail-delete").textContent = "Click again to delete";
    $("detail-delete").classList.add("armed");
    deleteTimer = setTimeout(disarmDelete, 4000);
    return;
  }
  const { domain } = detail;
  try {
    const { removed } = await api("/api/remove", { domain });
    $("detail-dialog").close();
    toast(removed ? `Deleted ${domain}.` : `${domain} was already gone.`);
    await refreshItems();
  } catch (e) {
    toast(e.message, "error");
  }
});

$("detail-dialog").addEventListener("close", () => {
  detail = null;
  $("detail-password").textContent = "";
  disarmDelete();
});

/********* Add / edit dialog ********/

let iconTimer = null;
let iconRequest = 0;

function setItemLogo(icon, domain) {
  $("item-logo").replaceChildren(logoEl(icon, domain || "?", "md"));
}

function openItemDialog(entry = null) {
  editing = entry ? entry.domain : null;
  $("item-title").textContent = entry ? `Edit ${displayName(entry)}` : "Add password";
  $("item-sub").textContent = entry ? entry.domain : "Popular sites get their logo automatically.";
  $("item-domain").value = entry ? entry.domain : "";
  $("item-password").value = entry ? entry.password : "";
  setItemPasswordVisible(false);
  updateStrength();
  setItemLogo(entry ? entry.icon : null, entry ? entry.domain : "");
  $("item-dialog").showModal();
  $(entry ? "item-password" : "item-domain").focus();
}

function setItemPasswordVisible(visible) {
  $("item-password").type = visible ? "text" : "password";
  setIcon($("item-toggle"), visible ? "eyeOff" : "eye");
  $("item-toggle").setAttribute("aria-label", visible ? "Hide password" : "Show password");
}

$("item-domain").addEventListener("input", () => {
  const value = $("item-domain").value.trim();
  clearTimeout(iconTimer);
  if (!value) { setItemLogo(null, ""); return; }
  iconTimer = setTimeout(async () => {
    const ticket = ++iconRequest;
    try {
      const { icon } = await api("/api/icon", { domain: value });
      if (ticket === iconRequest) setItemLogo(icon, value);
    } catch { /* preview only */ }
  }, 180);
});

$("item-toggle").addEventListener("click", () => {
  setItemPasswordVisible($("item-password").type === "password");
});

$("item-generate").addEventListener("click", () => {
  $("item-password").value = generatePassword();
  setItemPasswordVisible(true);
  updateStrength();
});

$("item-password").addEventListener("input", updateStrength);
$("item-gen-options").addEventListener("click", () => openGenerator(true));
$("item-cancel").addEventListener("click", () => $("item-dialog").close());

$("item-dialog").addEventListener("close", () => {
  editing = null;
  $("item-password").value = "";
  setItemPasswordVisible(false);
});

$("item-form").addEventListener("submit", (e) => {
  e.preventDefault();
  withBusy(e.target, async () => {
    const original = editing;
    const { domain } = await api("/api/set", {
      domain: $("item-domain").value,
      password: $("item-password").value,
    });
    if (original && original !== domain) {
      await api("/api/remove", { domain: original });
    }
    $("item-dialog").close();
    toast(original ? `Updated ${domain}.` : `Saved password for ${domain}.`);
    await refreshItems();
  });
});

/********* Strength meter ********/

function updateStrength() {
  const pw = $("item-password").value;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  const bits = pw.length * Math.log2(pool || 1);

  const levels = [
    [0, "", "var(--muted)"],
    [1, "Weak", "var(--danger)"],
    [45, "Fair", "var(--warn)"],
    [65, "Good", "var(--ok)"],
    [90, "Strong", "var(--ok)"],
  ];
  let level = levels[0];
  for (const l of levels) if (bits >= l[0] && pw) level = l;
  $("strength-fill").style.width = pw ? `${Math.min(100, Math.max(8, (bits / 110) * 100))}%` : "0";
  $("strength-fill").style.background = level[2];
  $("strength-label").textContent = level[1];
  $("strength-label").style.color = level[2];
}

/********* Password generator ********/

const gen = { length: 20, upper: true, digits: true, symbols: true };
try { Object.assign(gen, JSON.parse(localStorage.getItem("keychain.gen") || "{}")); } catch { /* ignore */ }

function generatePassword(opts = gen) {
  const sets = ["abcdefghijkmnopqrstuvwxyz"];
  if (opts.upper) sets.push("ABCDEFGHJKLMNPQRSTUVWXYZ");
  if (opts.digits) sets.push("23456789");
  if (opts.symbols) sets.push("!@#$%^&*-_=+?");
  const chars = sets.join("");
  const length = Math.min(64, Math.max(8, Number(opts.length) || 20));
  const limit = 256 - (256 % chars.length); // rejection sampling avoids modulo bias
  const buf = new Uint8Array(1);

  for (;;) {
    let out = "";
    while (out.length < length) {
      crypto.getRandomValues(buf);
      if (buf[0] < limit) out += chars[buf[0] % chars.length];
    }
    // Make sure every chosen character type actually appears.
    if (sets.every((set) => [...out].some((c) => set.includes(c)))) return out;
  }
}

let genForItem = false;

function syncGenControls() {
  $("gen-length").value = gen.length;
  $("gen-length-out").textContent = gen.length;
  $("gen-upper").checked = gen.upper;
  $("gen-digits").checked = gen.digits;
  $("gen-symbols").checked = gen.symbols;
}

function regenerate() {
  $("gen-password").textContent = generatePassword();
}

function openGenerator(forItem) {
  genForItem = forItem;
  $("gen-use").textContent = forItem ? "Use password" : "Save as new item";
  syncGenControls();
  regenerate();
  $("gen-dialog").showModal();
}

function saveGenSettings() {
  try { localStorage.setItem("keychain.gen", JSON.stringify(gen)); } catch { /* ignore */ }
}

$("gen-length").addEventListener("input", () => {
  gen.length = Number($("gen-length").value);
  $("gen-length-out").textContent = gen.length;
  regenerate();
  saveGenSettings();
});
for (const [id, key] of [["gen-upper", "upper"], ["gen-digits", "digits"], ["gen-symbols", "symbols"]]) {
  $(id).addEventListener("change", () => {
    gen[key] = $(id).checked;
    regenerate();
    saveGenSettings();
  });
}
$("gen-refresh").addEventListener("click", regenerate);
$("gen-copy").addEventListener("click", () => copyText($("gen-password").textContent));
$("gen-close").addEventListener("click", () => $("gen-dialog").close());
$("gen-use").addEventListener("click", () => {
  const pw = $("gen-password").textContent;
  $("gen-dialog").close();
  if (!genForItem) openItemDialog();
  $("item-password").value = pw;
  setItemPasswordVisible(true);
  updateStrength();
});
$("gen-dialog").addEventListener("close", () => { $("gen-password").textContent = ""; });

/********* Shell events ********/

$("search").addEventListener("input", renderItems);
$("search").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = $("search").value.trim().toLowerCase();
  const matches = items.filter((it) => it.domain.includes(q) || displayName(it).toLowerCase().includes(q));
  if (matches.length === 1) openDetail(matches[0].domain);
  else if (matches.length === 0 && q) openDetail(q);
});

$("empty-lookup").addEventListener("click", () => openDetail($("search").value.trim()));
$("empty-add").addEventListener("click", () => {
  const q = $("search").value.trim();
  openItemDialog();
  if (q) {
    $("item-domain").value = q;
    $("item-domain").dispatchEvent(new Event("input"));
    $("item-password").focus();
  }
});

$("add-btn").addEventListener("click", () => openItemDialog());
$("fab").addEventListener("click", () => openItemDialog());
$("nav-generator").addEventListener("click", () => openGenerator(false));
$("nav-all").addEventListener("click", () => {
  $("search").value = "";
  renderItems();
  $("search").focus();
});
$("view-grid").addEventListener("click", () => setLayout("grid"));
$("view-list").addEventListener("click", () => setLayout("list"));

$("lock-btn").addEventListener("click", async () => {
  try { await api("/api/lock", {}); } catch { /* lock locally regardless */ }
  clearSensitive();
  showView("unlock");
  toast("Vault locked.");
});

// Close a dialog when its backdrop is clicked.
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || $("view-vault").hidden || document.querySelector("dialog[open]")) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  e.preventDefault();
  $("search").focus();
});

/********* Auth forms ********/

$("setup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  withBusy(e.target, async () => {
    const password = $("setup-password").value;
    if (password !== $("setup-confirm").value) {
      throw new Error("The passwords don't match.");
    }
    await api("/api/unlock", { password });
    clearSensitive();
    showView("vault");
    toast("Vault created.");
  });
});

$("unlock-form").addEventListener("submit", (e) => {
  e.preventDefault();
  withBusy(e.target, async () => {
    await api("/api/unlock", { password: $("unlock-password").value });
    clearSensitive();
    showView("vault");
  });
});

/********* Start ********/

setLayout(layout);
setIcon($("detail-copy"), "copy");
setIcon($("gen-refresh"), "refresh");
setIcon($("gen-copy"), "copy");
setIcon($("item-generate"), "dice");

(async () => {
  try {
    const { exists, unlocked } = await api("/api/status");
    showView(unlocked ? "vault" : exists ? "unlock" : "setup");
  } catch (e) {
    toast(`Can't reach the server: ${e.message}`, "error");
  }
})();
