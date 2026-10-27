// Real X videos (unlike GIFs) stream through MSE, so the page never exposes an
// MP4 URL. Both the extension and the PWA look the post up instead and pick
// one of the progressive MP4 variants X keeps for every video.

// Longer videos only get the MP4: as a GIF they'd be huge and slow to make.
export const MAX_GIF_SECONDS = 60;

const VARIANT_SIZE = /\/vid\/(?:\w+\/)?(\d+)x(\d+)\//;

/**
 * Pick a variant from [{ url, bitrate }]. With maxWidth 0 it's the best one;
 * otherwise the smallest that is still at least maxWidth wide, since the
 * converter scales down to that anyway and a smaller file downloads faster.
 */
export function pickVariant(variants, maxWidth = 0) {
  const sized = variants
    .filter((v) => /\.mp4(\?|$)/.test(v.url))
    .map((v) => ({ ...v, width: Number(v.url.match(VARIANT_SIZE)?.[1] || 0) }))
    .sort((a, b) => a.width - b.width || (a.bitrate || 0) - (b.bitrate || 0));
  if (!sized.length) throw new Error("no MP4 version of this video");
  return (maxWidth > 0 && sized.find((v) => v.width >= maxWidth)) || sized.at(-1);
}

export function checkGifLength(seconds) {
  if (seconds > MAX_GIF_SECONDS) {
    throw new Error(`Video is ${Math.round(seconds)}s; GIFs are limited to ${MAX_GIF_SECONDS}s. Use MP4 instead.`);
  }
}
