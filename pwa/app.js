import { mp4ToGif } from "../extension/converter.js";
import { fetchOrStall } from "../extension/net.js";
import { DEFAULT_PRESET, fillPresetSelect, presetOptions } from "../extension/presets.js";
import { checkGifLength, MAX_GIF_SECONDS, pickVariant, videoGifSettings } from "../extension/video.js";

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
// Returns the post's GIFs and short videos as [{ url, mp4Url, settings }]:
// `url` is what to convert and with which settings, `mp4Url` the best version
// for the "Original MP4" link.
async function lookupMedia(id, settings) {
  const res = await fetchOrStall(`https://api.fxtwitter.com/status/${id}`);
  if (!res.ok) throw new Error(`Couldn't load the post (HTTP ${res.status})`);
  const { tweet } = await res.json();
  if (!tweet) throw new Error("Post not found");
  // X serves GIFs from /tweet_video/; match on that as well as the type label.
  const isGif = (v) => v.type === "gif" || v.type === "animated_gif" || /\/tweet_video\//.test(v.url || "");
  const isVideo = (v) => v.type === "video" && v.url;
  const collect = (t) => [...(t?.media?.videos || []), ...(t?.media?.all || [])].filter((v) => isGif(v) || isVideo(v));
  // media.all and media.videos can overlap; dedupe by URL.
  const found = [...new Map([...collect(tweet), ...collect(tweet.quote)].map((v) => [v.url, v])).values()];

  const media = [];
  let tooLong = 0;
  for (const v of found) {
    if (isGif(v)) {
      media.push({ url: v.url, mp4Url: v.url, settings });
    } else if (v.duration > MAX_GIF_SECONDS) {
      tooLong = Math.max(tooLong, v.duration);
    } else {
      const variants = (v.formats || []).filter((f) => f.container === "mp4");
      if (!variants.length) variants.push({ url: v.url });
      const videoSettings = videoGifSettings(variants, v.duration, settings);
      media.push({
        url: pickVariant(variants, videoSettings.maxWidth).url,
        mp4Url: pickVariant(variants).url,
        settings: videoSettings,
      });
    }
  }
  if (!media.length && tooLong) checkGifLength(tooLong);
  return { tweet, media, skipped: found.length - media.length };
}

// Object URLs of the GIFs on screen, freed when the next conversion starts.
let resultUrls = [];

function clearResults() {
  resultUrls.forEach((u) => URL.revokeObjectURL(u));
  resultUrls = [];
  resultsEl.replaceChildren();
}

function renderResult(file, mp4Url) {
  const card = document.createElement("div");
  card.className = "result";
  const url = URL.createObjectURL(file);
  resultUrls.push(url);

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
  clearResults();
  progressEl.hidden = true;

  try {
    setStatus("Looking up post…");
    const settings = presetOptions(presetSelect.value);
    const { tweet, media: gifs, skipped } = await lookupMedia(parsed.id, settings);
    if (!gifs.length) throw new Error("This post has no GIF or video.");
    const user = tweet.author?.screen_name || parsed.user;
    const saves = [];
    let bytes = 0;

    for (const [i, gif] of gifs.entries()) {
      const label = gifs.length > 1 ? ` ${i + 1}/${gifs.length}` : "";
      setStatus(`Downloading${label}…`);
      // video.twimg.com 403s any non-X Referer, so send none.
      const res = await fetchOrStall(gif.url, { referrerPolicy: "no-referrer" });
      if (!res.ok) throw new Error(`Couldn't download the video (HTTP ${res.status})`);
      const mp4 = await res.blob();

      setStatus(`Converting${label}…`);
      progressEl.hidden = false;
      progressEl.value = 0;
      const blob = await mp4ToGif(mp4, gif.settings, (v) => (progressEl.value = v));
      const suffix = gifs.length > 1 ? `_${i + 1}` : "";
      saves.push(renderResult(new File([blob], `${user}_${tweet.id}${suffix}.gif`, { type: "image/gif" }), gif.mp4Url));
      bytes += blob.size;
    }
    const note = skipped ? ` Skipped ${skipped} video${skipped > 1 ? "s" : ""} over ${MAX_GIF_SECONDS}s.` : "";
    if (shared && autosaveBox.checked) {
      for (const save of saves) save.click();
      if (saves.length > 1) {
        // Chrome asks before a page saves several files at once, and closing
        // would dismiss that prompt, so stay open.
        setStatus(
          `Saved ${saves.length} GIFs. If Chrome asks about downloading multiple files, allow it, ` +
            `or tap Save GIF on any that are missing.${note}`,
        );
      } else if (autocloseBox.checked) {
        setStatus(`Saved to Downloads. Closing…${note}`);
        // Give the download time to read the blob before the page goes away,
        // longer for big files. window.close() is allowed here because a
        // share launch has one history entry.
        const wait = Math.min(10_000, 1500 + (bytes / 1024 / 1024) * 100);
        setTimeout(() => {
          window.close();
          setStatus(`Saved to Downloads.${note}`);
        }, wait);
      } else {
        setStatus(`Saved to Downloads.${note}`);
      }
    } else {
      setStatus(`Done.${note}`);
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
