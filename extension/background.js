import { mp4ToGif } from "./converter.js";
import { loadSettings } from "./settings.js";

const MP4_URL = /^https:\/\/video\.twimg\.com\/tweet_video\/[\w-]+\.mp4(\?.*)?$/;

// Object URLs handed to downloads.download must stay alive until the
// download finishes, so track them and revoke on completion.
const pendingUrls = new Map();

browser.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;
  const url = pendingUrls.get(delta.id);
  if (url) {
    URL.revokeObjectURL(url);
    pendingUrls.delete(delta.id);
  }
});

async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await browser.downloads.download({ url, filename, conflictAction: "uniquify" });
    pendingUrls.set(id, url);
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

async function fetchMp4(url) {
  // video.twimg.com 403s any non-X Referer, so send none.
  const res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  return res.blob();
}

async function handle(port, { url, basename, format }) {
  if (!MP4_URL.test(url)) throw new Error("not a twitter GIF url");
  const send = (msg) => {
    try {
      port.postMessage(msg);
    } catch {
      // Tab navigated away; keep going so the download still lands.
    }
  };

  if (format === "mp4") {
    const blob = await fetchMp4(url);
    await saveBlob(blob, `${basename}.mp4`);
    return;
  }

  send({ type: "progress", stage: "fetch", value: 0 });
  const [blob, settings] = await Promise.all([fetchMp4(url), loadSettings()]);
  const gif = await mp4ToGif(blob, settings, (value) => send({ type: "progress", stage: "encode", value }));
  await saveBlob(gif, `${basename}.gif`);
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "xgd-download") return;
  port.onMessage.addListener(async (msg) => {
    try {
      await handle(port, msg);
      port.postMessage({ type: "done" });
    } catch (err) {
      console.error("[X GIF Downloader]", err);
      try {
        port.postMessage({ type: "error", message: String(err?.message || err) });
      } catch {}
    }
  });
});
