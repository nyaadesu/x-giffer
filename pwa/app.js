import { mp4ToGif } from "../extension/converter.js";
import { DEFAULT_PRESET, fillPresetSelect, presetOptions } from "../extension/presets.js";

const STATUS_RE = /(?:x|twitter|fxtwitter|fixupx|vxtwitter)\.com\/(?:([\w]+)\/status|i\/status|i\/web\/status)\/(\d+)/i;

const $ = (id) => document.getElementById(id);
const form = $("form");
const linkInput = $("link");
const goButton = $("go");
const statusEl = $("status");
const progressEl = $("progress");
const resultsEl = $("results");
const presetSelect = $("preset");
const autosaveBox = $("autosave");
const autocloseBox = $("autoclose");
let lastLink = null;

function loadSetting(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function storeSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function initPreset() {
  fillPresetSelect(presetSelect, loadSetting("xgd-preset", DEFAULT_PRESET));
  presetSelect.addEventListener("change", () => {
    storeSetting("xgd-preset", presetSelect.value);
    // Re-convert the post that's on screen with the new preset.
    if (lastLink && !goButton.disabled) run(lastLink);
  });
}

// What to do after converting a shared post. Auto-save is on unless turned off.
function initToggles() {
  autosaveBox.checked = loadSetting("xgd-autosave", "1") === "1";
  autocloseBox.checked = loadSetting("xgd-autoclose", "0") === "1";
  const sync = () => (autocloseBox.disabled = !autosaveBox.checked);
  sync();
  autosaveBox.addEventListener("change", () => {
    storeSetting("xgd-autosave", autosaveBox.checked ? "1" : "0");
    sync();
  });
  autocloseBox.addEventListener("change", () => storeSetting("xgd-autoclose", autocloseBox.checked ? "1" : "0"));
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function parseStatus(text) {
  const m = text && text.match(STATUS_RE);
  return m ? { user: m[1] || "i", id: m[2] } : null;
}

// fxtwitter's public API is CORS-enabled and resolves a status ID to its media.
async function lookupGifs(id) {
  const res = await fetch(`https://api.fxtwitter.com/status/${id}`);
  if (!res.ok) throw new Error(`Couldn't load the post (HTTP ${res.status})`);
  const { tweet } = await res.json();
  if (!tweet) throw new Error("Post not found");
  // X serves GIFs from /tweet_video/; match on that as well as the type label.
  const isGif = (v) => v.type === "gif" || v.type === "animated_gif" || /\/tweet_video\//.test(v.url || "");
  const collect = (t) => [...(t?.media?.videos || []), ...(t?.media?.all || [])].filter(isGif);
  const gifs = [...collect(tweet), ...collect(tweet.quote)];
  // media.all and media.videos can overlap; dedupe by URL.
  const unique = [...new Map(gifs.map((g) => [g.url, g])).values()];
  return { tweet, gifs: unique };
}

function renderResult(file, mp4Url) {
  const card = document.createElement("div");
  card.className = "result";
  const url = URL.createObjectURL(file);

  const img = document.createElement("img");
  img.src = url;
  img.alt = file.name;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;

  const actions = document.createElement("div");
  actions.className = "actions";

  if (navigator.canShare?.({ files: [file] })) {
    const share = document.createElement("button");
    share.textContent = "Share GIF";
    share.addEventListener("click", () => navigator.share({ files: [file] }).catch(() => {}));
    actions.append(share);
  }

  const save = document.createElement("a");
  save.className = "btn" + (actions.childElementCount ? " secondary" : "");
  save.href = url;
  save.download = file.name;
  save.textContent = "Save GIF";

  const mp4 = document.createElement("a");
  mp4.className = "btn secondary";
  mp4.href = mp4Url;
  mp4.target = "_blank";
  mp4.rel = "noopener noreferrer";
  mp4.textContent = "Original MP4";

  actions.append(save, mp4);
  card.append(img, meta, actions);
  resultsEl.append(card);
  return save;
}

async function run(text, { shared = false } = {}) {
  const parsed = parseStatus(text);
  if (!parsed) {
    setStatus("That doesn't look like an X post link.", true);
    return;
  }
  lastLink = text;
  goButton.disabled = true;
  presetSelect.disabled = true;
  resultsEl.replaceChildren();
  progressEl.hidden = true;

  try {
    setStatus("Looking up post…");
    const { tweet, gifs } = await lookupGifs(parsed.id);
    if (!gifs.length) throw new Error("This post has no GIF.");
    const user = tweet.author?.screen_name || parsed.user;
    const settings = presetOptions(presetSelect.value);
    const saves = [];

    for (const [i, gif] of gifs.entries()) {
      const label = gifs.length > 1 ? ` ${i + 1}/${gifs.length}` : "";
      setStatus(`Downloading${label}…`);
      // video.twimg.com 403s any non-X Referer, so send none.
      const res = await fetch(gif.url, { referrerPolicy: "no-referrer" });
      if (!res.ok) throw new Error(`Couldn't download the GIF video (HTTP ${res.status})`);
      const mp4 = await res.blob();

      setStatus(`Converting${label}…`);
      progressEl.hidden = false;
      progressEl.value = 0;
      const blob = await mp4ToGif(mp4, settings, (v) => (progressEl.value = v));
      const suffix = gifs.length > 1 ? `_${i + 1}` : "";
      saves.push(renderResult(new File([blob], `${user}_${tweet.id}${suffix}.gif`, { type: "image/gif" }), gif.url));
    }
    if (shared && autosaveBox.checked) {
      for (const save of saves) save.click();
      if (autocloseBox.checked) {
        setStatus("Saved to Downloads. Closing…");
        // Give the download a moment to read the blob before the page goes away.
        // window.close() is allowed here because a share launch has one history entry.
        setTimeout(() => {
          window.close();
          setStatus("Saved to Downloads.");
        }, 1500);
      } else {
        setStatus("Saved to Downloads.");
      }
    } else {
      setStatus("Done.");
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  } finally {
    goButton.disabled = false;
    presetSelect.disabled = false;
    progressEl.hidden = true;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  run(linkInput.value);
});

initPreset();
initToggles();

// Android share sheet lands here as ?title=…&text=…&url=… (see manifest share_target).
const params = new URLSearchParams(location.search);
const shared = ["url", "text", "title"].map((k) => params.get(k)).find((v) => parseStatus(v));
if (shared) {
  linkInput.value = shared;
  history.replaceState(null, "", location.pathname);
  run(shared, { shared: true });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
