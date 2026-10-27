// Real X videos (unlike GIFs) stream through MSE, so the page never exposes an
// MP4 URL. Both the extension and the PWA look the post up instead and pick
// one of the progressive MP4 variants X keeps for every video.

// Longer videos only get the MP4: as a GIF they'd be huge and slow to make.
export const MAX_GIF_SECONDS = 60;
// Width × height × frames allowed in a GIF made from a video; bigger ones are
// scaled down to fit. Camera footage costs about 0.36 bytes per pixel even
// with unchanged pixels skipped, so this keeps GIFs to roughly 70 MB.
export const MAX_VIDEO_GIF_PIXELS = 200_000_000;
// Only used to estimate the frame count before the video is downloaded.
const ASSUMED_FPS = 30;

const VARIANT_SIZE = /\/vid\/(?:\w+\/)?(\d+)x(\d+)\//;

function bySize(variants) {
  return variants
    .filter((v) => /\.mp4(\?|$)/.test(v.url))
    .map((v) => {
      const m = v.url.match(VARIANT_SIZE);
      return { ...v, width: Number(m?.[1] || 0), height: Number(m?.[2] || 0) };
    })
    .sort((a, b) => a.width - b.width || (a.bitrate || 0) - (b.bitrate || 0));
}

/**
 * Pick a variant from [{ url, bitrate }]. With maxWidth 0 it's the best one;
 * otherwise the smallest that is still at least maxWidth wide, since the
 * converter scales down to that anyway and a smaller file downloads faster.
 */
export function pickVariant(variants, maxWidth = 0) {
  const sized = bySize(variants);
  if (!sized.length) throw new Error("no MP4 version of this video");
  return (maxWidth > 0 && sized.find((v) => v.width >= maxWidth)) || sized.at(-1);
}

/**
 * Settings for turning a video into a GIF: the preset plus the pixel budget,
 * with maxWidth lowered to roughly what the budget will allow so that
 * pickVariant doesn't fetch a much bigger file than the GIF needs.
 */
export function videoGifSettings(variants, seconds, settings) {
  const best = bySize(variants).at(-1);
  let { maxWidth } = settings;
  if (best?.height && seconds > 0) {
    const frames = seconds * Math.min(settings.maxFps || ASSUMED_FPS, ASSUMED_FPS);
    const fit = Math.floor(Math.sqrt((MAX_VIDEO_GIF_PIXELS / frames) * (best.width / best.height)));
    maxWidth = maxWidth > 0 ? Math.min(maxWidth, fit) : fit;
  }
  return { ...settings, maxWidth, maxPixels: MAX_VIDEO_GIF_PIXELS };
}

export function checkGifLength(seconds) {
  if (seconds > MAX_GIF_SECONDS) {
    throw new Error(`Video is ${Math.round(seconds)}s; GIFs are limited to ${MAX_GIF_SECONDS}s. Use MP4 instead.`);
  }
}
