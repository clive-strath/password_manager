"use strict";

/*
 * Brand logos for the web UI.
 *
 * Logos come from the `simple-icons` package (CC0), which ships in
 * node_modules, so no request ever leaves this machine. Using a public
 * favicon service would tell that service every site in the vault.
 *
 * iconFor("open.spotify.com") -> { title, hex, path } or a letter fallback.
 */

const simpleIcons = require("simple-icons");

const bySlug = new Map();
for (const icon of Object.values(simpleIcons)) {
  if (icon && icon.slug) bySlug.set(icon.slug, icon);
}

// Hosts whose logo isn't the obvious "second-level label" one.
const HOST_ALIASES = {
  "mail.google.com": "gmail",
  "gmail.com": "gmail",
  "googlemail.com": "gmail",
  "drive.google.com": "googledrive",
  "docs.google.com": "googledocs",
  "sheets.google.com": "googlesheets",
  "photos.google.com": "googlephotos",
  "maps.google.com": "googlemaps",
  "calendar.google.com": "googlecalendar",
  "meet.google.com": "googlemeet",
  "play.google.com": "googleplay",
  "music.youtube.com": "youtubemusic",
  "twitter.com": "x",
  "x.com": "x",
  "fb.com": "facebook",
  "messenger.com": "messenger",
  "wa.me": "whatsapp",
  "appleid.apple.com": "apple",
  "music.apple.com": "applemusic",
  "tv.apple.com": "appletv",
  "ycombinator.com": "ycombinator",
  "news.ycombinator.com": "ycombinator",
  "playstation.com": "playstation",
  "store.steampowered.com": "steam",
  "steampowered.com": "steam",
  "steamcommunity.com": "steam",
  "epicgames.com": "epicgames",
  "battle.net": "battledotnet",
  "proton.me": "proton",
  "protonmail.com": "protonmail",
};

// Big brands the icon set doesn't carry. Shown as a letter in brand colour.
const FALLBACK_BRANDS = {
  amazon: { title: "Amazon", hex: "FF9900" },
  aws: { title: "AWS", hex: "FF9900" },
  microsoft: { title: "Microsoft", hex: "5E5E5E" },
  live: { title: "Microsoft", hex: "5E5E5E" },
  outlook: { title: "Outlook", hex: "0078D4" },
  hotmail: { title: "Outlook", hex: "0078D4" },
  office: { title: "Microsoft 365", hex: "D83B01" },
  linkedin: { title: "LinkedIn", hex: "0A66C2" },
  yahoo: { title: "Yahoo", hex: "6001D2" },
  primevideo: { title: "Prime Video", hex: "1F2E3E" },
  disneyplus: { title: "Disney+", hex: "113CCF" },
  hulu: { title: "Hulu", hex: "1CE783" },
  openai: { title: "OpenAI", hex: "10A37F" },
  chatgpt: { title: "ChatGPT", hex: "10A37F" },
  slack: { title: "Slack", hex: "4A154B" },
  adobe: { title: "Adobe", hex: "FA0F00" },
  canva: { title: "Canva", hex: "00C4CC" },
  xbox: { title: "Xbox", hex: "107C10" },
  nintendo: { title: "Nintendo", hex: "E60012" },
  minecraft: { title: "Minecraft", hex: "62B47A" },
  bbc: { title: "BBC", hex: "000000" },
};

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

/** "https://www.Open.Spotify.com:443/x" -> "open.spotify.com" */
function hostOf(domain) {
  return String(domain)
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^[^@]*@/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\d?\./, "")
    .replace(/\.$/, "");
}

/** Main name of a host: "accounts.google.co.uk" -> "google". */
function siteName(host) {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 1) return labels[0] || "";
  let i = labels.length - 2;
  if (labels.length >= 3 && SECOND_LEVEL.has(labels[i]) && labels[labels.length - 1].length === 2) i--;
  return labels[i];
}

function fromSimpleIcon(icon) {
  return { title: icon.title, hex: icon.hex, path: icon.path };
}

function iconFor(domain) {
  const host = hostOf(domain);
  const name = siteName(host);
  const slugKey = (s) => s.replace(/[^a-z0-9]/g, "");

  const candidates = [HOST_ALIASES[host], slugKey(name), slugKey(host)];
  for (const slug of candidates) {
    if (slug && bySlug.has(slug)) return fromSimpleIcon(bySlug.get(slug));
  }

  const first = host.split(".")[0];
  const brand = FALLBACK_BRANDS[first] || FALLBACK_BRANDS[name];
  if (brand) return { title: brand.title, hex: brand.hex, path: null };

  return {
    title: name ? name.charAt(0).toUpperCase() + name.slice(1) : String(domain),
    hex: null,
    path: null,
  };
}

module.exports = { iconFor, hostOf };
