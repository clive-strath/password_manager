"use strict";

const $ = (id) => document.getElementById(id);

const views = ["view-loading", "view-setup", "view-unlock", "view-vault"];
let currentPassword = null; // password shown in the lookup result
let toastTimer = null;

function showView(name) {
  for (const v of views) $(v).hidden = v !== name;
  $("lock-btn").hidden = name !== "view-vault";
  if (name === "view-vault") refreshDomains();
  const focusTarget = {
    "view-setup": "setup-password",
    "view-unlock": "unlock-password",
    "view-vault": "lookup-domain",
  }[name];
  if (focusTarget) $(focusTarget).focus();
}

function toast(message, kind = "ok") {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

async function api(path, body) {
  const options = body === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (res.status === 423) {
    clearSensitive();
    showView("view-unlock");
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

function clearSensitive() {
  currentPassword = null;
  allDomains = [];
  $("domain-list").replaceChildren();
  $("domain-filter").value = "";
  $("lookup-result").hidden = true;
  $("lookup-empty").hidden = true;
  $("result-password").textContent = "";
  for (const id of ["setup-password", "setup-confirm", "unlock-password", "save-password", "lookup-domain", "save-domain"]) {
    $(id).value = "";
  }
}

function setToggle(button, visible) {
  button.textContent = visible ? "Hide" : "Show";
}

/********* Domain list ********/

let allDomains = [];

async function refreshDomains() {
  try {
    ({ domains: allDomains } = await api("/api/list", {}));
  } catch (e) {
    toast(e.message, "error");
    return;
  }
  renderDomains();
}

function renderDomains() {
  const filter = $("domain-filter").value.trim().toLowerCase();
  const shown = allDomains.filter((d) => d.includes(filter));
  const active = $("lookup-result").hidden ? null : $("result-domain").textContent;

  $("domain-count").textContent = `(${allDomains.length})`;
  const list = $("domain-list");
  list.replaceChildren(...shown.map((domain) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = domain;
    if (domain === active) button.classList.add("active");
    button.addEventListener("click", () => lookup(domain));
    li.append(button);
    return li;
  }));

  const empty = $("domain-list-empty");
  empty.hidden = shown.length > 0;
  empty.textContent = allDomains.length === 0
    ? "No saved domains yet."
    : "No domains match the filter.";
}

$("domain-filter").addEventListener("input", renderDomains);

/********* Lookup result ********/

async function lookup(domainInput) {
  const { domain, password } = await api("/api/get", { domain: domainInput });
  $("lookup-domain").value = domain;
  if (password === null) renderNotFound(domain);
  else renderResult(domain, password);
  await refreshDomains(); // a lookup can add an older entry to the list
}

function renderResult(domain, password) {
  currentPassword = password;
  $("lookup-empty").hidden = true;
  $("lookup-result").hidden = false;
  $("result-domain").textContent = domain;
  $("result-password").textContent = "•".repeat(12);
  setToggle($("result-toggle"), false);
}

function renderNotFound(domain) {
  currentPassword = null;
  $("lookup-result").hidden = true;
  $("lookup-empty").hidden = false;
  $("lookup-empty").textContent = `No password saved for ${domain}.`;
}

/********* Password generator ********/

function generatePassword(length = 20) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+?";
  const limit = 256 - (256 % chars.length); // rejection sampling avoids modulo bias
  let out = "";
  const buf = new Uint8Array(1);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) out += chars[buf[0] % chars.length];
  }
  return out;
}

/********* Event handlers ********/

$("setup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  withBusy(e.target, async () => {
    const password = $("setup-password").value;
    if (password !== $("setup-confirm").value) {
      throw new Error("The passwords don't match.");
    }
    await api("/api/unlock", { password });
    clearSensitive();
    showView("view-vault");
    toast("Vault created.");
  });
});

$("unlock-form").addEventListener("submit", (e) => {
  e.preventDefault();
  withBusy(e.target, async () => {
    await api("/api/unlock", { password: $("unlock-password").value });
    clearSensitive();
    showView("view-vault");
  });
});

$("lock-btn").addEventListener("click", async () => {
  try { await api("/api/lock", {}); } catch { /* lock locally regardless */ }
  clearSensitive();
  showView("view-unlock");
  toast("Vault locked.");
});

$("lookup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  withBusy(e.target, () => lookup($("lookup-domain").value));
});

$("result-toggle").addEventListener("click", () => {
  if (currentPassword === null) return;
  const showing = $("result-toggle").textContent === "Hide";
  $("result-password").textContent = showing ? "•".repeat(12) : currentPassword;
  setToggle($("result-toggle"), !showing);
});

$("result-copy").addEventListener("click", async () => {
  if (currentPassword === null) return;
  try {
    await navigator.clipboard.writeText(currentPassword);
    toast("Copied to clipboard.");
  } catch {
    toast("Couldn't access the clipboard.", "error");
  }
});

$("result-edit").addEventListener("click", () => {
  $("save-domain").value = $("result-domain").textContent;
  $("save-password").value = "";
  $("save-password").focus();
});

$("result-delete").addEventListener("click", async () => {
  const domain = $("result-domain").textContent;
  if (!confirm(`Delete the password for ${domain}?`)) return;
  try {
    const { removed } = await api("/api/remove", { domain });
    $("lookup-result").hidden = true;
    currentPassword = null;
    toast(removed ? `Deleted ${domain}.` : `${domain} was already gone.`);
    await refreshDomains();
  } catch (err) {
    toast(err.message, "error");
  }
});

$("save-toggle").addEventListener("click", () => {
  const input = $("save-password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  setToggle($("save-toggle"), show);
});

$("save-generate").addEventListener("click", () => {
  const input = $("save-password");
  input.value = generatePassword();
  input.type = "text";
  setToggle($("save-toggle"), true);
});

$("save-form").addEventListener("submit", (e) => {
  e.preventDefault();
  withBusy(e.target, async () => {
    const { domain } = await api("/api/set", {
      domain: $("save-domain").value,
      password: $("save-password").value,
    });
    $("save-domain").value = "";
    $("save-password").value = "";
    $("save-password").type = "password";
    setToggle($("save-toggle"), false);
    if ($("result-domain").textContent === domain) $("lookup-result").hidden = true;
    toast(`Saved password for ${domain}.`);
    await refreshDomains();
  });
});

/********* Start ********/

(async () => {
  try {
    const { exists, unlocked } = await api("/api/status");
    showView(unlocked ? "view-vault" : exists ? "view-unlock" : "view-setup");
  } catch (e) {
    toast(`Can't reach the server: ${e.message}`, "error");
  }
})();
