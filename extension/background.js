import { mp4ToGif } from "./converter.js";
import { fetchOrStall } from "./net.js";
import { loadSettings } from "./settings.js";
import { checkGifLength, pickVariant, videoGifSettings } from "./video.js";

const MP4_URL = /^https:\/\/video\.twimg\.com\/tweet_video\/[\w-]+\.mp4(\?.*)?$/;
const VIDEO_URL = /^https:\/\/video\.twimg\.com\/(?:amplify_video|ext_tw_video)\/\d+\/[\w/-]+\.mp4(\?.*)?$/;

// Object URLs handed to downloads.download must stay alive until the
// download finishes, so track them and revoke on completion.
const pendingUrls = new Map();

function release(id) {
  const url = pendingUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    pendingUrls.delete(id);
  }
}

browser.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state === "complete" || state === "interrupted") release(delta.id);
});

async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await browser.downloads.download({ url, filename, conflictAction: "uniquify" });
    pendingUrls.set(id, url);
    // A small file can finish before the line above runs, and then its
    // onChanged event has already been and gone.
    const [item] = await browser.downloads.search({ id });
    if (!item || item.state !== "in_progress") release(id);
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

async function fetchMp4(url) {
  // video.twimg.com 403s any non-X Referer, so send none.
  const res = await fetchOrStall(url, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  return res.blob();
}

// The token X's embed widget sends with syndication lookups, derived from the ID.
function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

/**
 * Find a video's MP4 variants via X's own embed API. The video may be in the
 * post itself or in a post it quotes, so match it by the media ID from its poster.
 */
async function lookupVideo(tweetId, mediaId) {
  const res = await fetchOrStall(
    `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${syndicationToken(tweetId)}`,
    { credentials: "omit", referrerPolicy: "no-referrer" },
  );
  if (res.status === 404) throw new Error("X won't share this post's video (it may be age-restricted or private)");
  if (!res.ok) throw new Error(`post lookup failed: HTTP ${res.status}`);
  const tweet = await res.json();
  const videos = [tweet, tweet.quoted_tweet].flatMap((t) => t?.mediaDetails || []).filter((m) => m.video_info);
  const media = videos.find((m) => m.media_url_https?.includes(`/${mediaId}/`)) || (videos.length === 1 && videos[0]);
  if (!media) throw new Error("couldn't find this video in the post");
  return {
    variants: media.video_info.variants.filter((v) => v.content_type === "video/mp4"),
    seconds: (media.video_info.duration_millis || 0) / 1000,
  };
}

async function handle(port, { url, tweetId, mediaId, basename, format }) {
  let settings = format === "mp4" ? null : await loadSettings();
  if (mediaId) {
    if (!/^\d+$/.test(tweetId) || !/^\d+$/.test(mediaId)) throw new Error("couldn't tell which post this video is from");
    const { variants, seconds } = await lookupVideo(tweetId, mediaId);
    if (settings) {
      checkGifLength(seconds);
      settings = videoGifSettings(variants, seconds, settings);
    }
    url = pickVariant(variants, settings?.maxWidth ?? 0).url;
    if (!VIDEO_URL.test(url)) throw new Error("unexpected video url");
  } else if (!MP4_URL.test(url)) {
    throw new Error("not a twitter GIF url");
  }

  if (format === "mp4") {
    // Let Firefox stream it to disk with its own progress, rather than holding
    // the whole video in memory here. Extension downloads send no Referer,
    // which is what video.twimg.com needs.
    await browser.downloads.download({ url, filename: `${basename}.mp4`, conflictAction: "uniquify" });
    return;
  }

  const send = (msg) => {
    try {
      port.postMessage(msg);
    } catch {
      // Tab navigated away; keep going so the download still lands.
    }
  };
  send({ type: "progress", stage: "fetch", value: 0 });
  const blob = await fetchMp4(url);
  const gif = await mp4ToGif(blob, settings, (value) => send({ type: "progress", stage: "encode", value }));
  await saveBlob(gif, `${basename}.gif`);
}

// Firefox stops an idle event page after ~30s, even mid-conversion, and
// neither open ports nor timers count as activity. Extension API calls do,
// so make a cheap one every few seconds while any job is running.
let activeJobs = 0;
let keepAliveTimer = null;

async function keepAlive(job) {
  if (activeJobs++ === 0) {
    keepAliveTimer = setInterval(() => browser.runtime.getPlatformInfo(), 10_000);
  }
  try {
    return await job();
  } finally {
    if (--activeJobs === 0) clearInterval(keepAliveTimer);
  }
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "xgd-download") return;
  port.onMessage.addListener(async (msg) => {
    try {
      await keepAlive(() => handle(port, msg));
      port.postMessage({ type: "done" });
    } catch (err) {
      console.error("[X Giffer]", err);
      try {
        port.postMessage({ type: "error", message: String(err?.message || err) });
      } catch {}
    }
  });
});
