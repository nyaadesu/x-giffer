import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.js";
import { frameTimes } from "./mp4.js";

// GIF delays are whole centiseconds and browsers bump anything under 2cs to
// 10cs, so 50fps is the fastest a GIF can really play.
const MAX_FPS = 50;
const FALLBACK_FPS = 30;
// Pixels sampled across all frames to build the shared palette.
const PALETTE_SAMPLE = 4_000_000;
// Keep decoded frames in memory between passes up to this size; beyond it
// they are decoded again instead.
const FRAME_CACHE_BYTES = 256 * 1024 * 1024;
// Squared RGB distance below which a pixel counts as unchanged from what is
// already on screen, so video compression noise doesn't shimmer.
const NOISE_THRESHOLD = 3 * 4 * 4;

function once(target, event, errorEvent = "error") {
  return new Promise((resolve, reject) => {
    const ok = () => {
      target.removeEventListener(errorEvent, fail);
      resolve();
    };
    const fail = () => {
      target.removeEventListener(event, ok);
      reject(new Error(`video ${errorEvent} while waiting for ${event}`));
    };
    target.addEventListener(event, ok, { once: true });
    target.addEventListener(errorEvent, fail, { once: true });
  });
}

/**
 * Pick which source frames to keep: every frame, unless that would exceed
 * maxFps. Returns [{ seek, start }] where `seek` lands inside the frame.
 */
function planFrames(timing, maxFps) {
  const fps = Math.min(maxFps > 0 ? maxFps : MAX_FPS, MAX_FPS);
  const minGap = 1 / fps - 1e-6;
  const { times, duration } = timing;
  const plan = [];
  for (let i = 0; i < times.length; i++) {
    const start = times[i];
    if (plan.length && start - plan.at(-1).start < minGap) continue;
    // Seek to the middle of the source frame so rounding in the decoder
    // can't land on a neighbour.
    const next = times[i + 1] ?? duration;
    plan.push({ start, seek: Math.min((start + next) / 2, duration - 0.0005) });
  }
  return plan;
}

/**
 * Convert an MP4 blob into an animated GIF blob, keeping the source frames
 * and their timing. Options: maxFps (0 = source), maxWidth (0 = original),
 * colors (2-256 per frame).
 */
export async function mp4ToGif(mp4Blob, { maxFps = 0, maxWidth = 0, colors = 256 }, onProgress = () => {}) {
  const url = URL.createObjectURL(mp4Blob);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;

  try {
    const [buffer] = await Promise.all([mp4Blob.arrayBuffer(), once(video, "loadeddata")]);

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("could not determine video duration");
    }

    let timing = frameTimes(buffer);
    if (!timing || timing.times.at(-1) > duration + 0.1) {
      const n = Math.max(1, Math.round(duration * FALLBACK_FPS));
      timing = { times: Array.from({ length: n }, (_, i) => i / FALLBACK_FPS), duration };
    }
    const end = Math.min(timing.duration, duration);
    const plan = planFrames({ times: timing.times, duration: end }, maxFps);

    const scale = maxWidth > 0 && video.videoWidth > maxWidth ? maxWidth / video.videoWidth : 1;
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";

    const grab = async (frame) => {
      video.currentTime = frame.seek;
      await once(video, "seeked");
      ctx.drawImage(video, 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height).data;
    };

    // Pass 1: decode every frame and sample its pixels for one palette shared
    // by the whole GIF. Per-frame palettes make gradients band differently on
    // every frame, which shows up as shimmering colours.
    const pixels = width * height;
    const stride = Math.max(1, Math.ceil((pixels * plan.length) / PALETTE_SAMPLE));
    const sample = new Uint32Array(Math.ceil(pixels / stride) * plan.length);
    let sampled = 0;
    const cacheFrames = pixels * 4 * plan.length <= FRAME_CACHE_BYTES;
    const frames = [];
    for (let i = 0; i < plan.length; i++) {
      const data = await grab(plan[i]);
      if (cacheFrames) frames.push(data);
      const px = new Uint32Array(data.buffer);
      // Offset the start per frame so sampling doesn't always hit the same pixels.
      for (let p = i % stride; p < px.length; p += stride) sample[sampled++] = px[p];
      onProgress((0.5 * (i + 1)) / plan.length);
    }

    // The last palette slot is reserved for "unchanged since last frame".
    const palette = quantize(new Uint8Array(sample.buffer, 0, sampled * 4), Math.min(colors, 256) - 1);
    const transparentIndex = palette.length;
    const gifPalette = [...palette, [0, 0, 0]];

    // Pass 2: map each frame onto the palette. Pixels that are unchanged (or
    // only differ by compression noise) are left transparent so the previous
    // frame shows through: no shimmer on static areas and much smaller files.
    const gif = GIFEncoder();
    const shown = new Int16Array(pixels).fill(-1);
    let pending = null;
    const flush = () => {
      if (!pending) return;
      // Round cumulative times rather than each delay so the total length
      // doesn't drift; clamp to the 2cs minimum browsers honour.
      const cs = Math.max(2, Math.round(pending.end * 100) - Math.round(pending.start * 100));
      gif.writeFrame(pending.index, width, height, {
        palette: pending.first ? gifPalette : undefined,
        delay: cs * 10,
        transparent: true,
        transparentIndex,
        dispose: 1,
      });
    };

    for (let i = 0; i < plan.length; i++) {
      const frameEnd = plan[i + 1]?.start ?? end;
      const data = cacheFrames ? frames[i] : await grab(plan[i]);
      if (cacheFrames) frames[i] = null;
      const index = applyPalette(data, palette);

      let changed = false;
      for (let p = 0, o = 0; p < pixels; p++, o += 4) {
        const prev = shown[p];
        if (prev >= 0) {
          if (index[p] === prev) {
            index[p] = transparentIndex;
            continue;
          }
          const c = palette[prev];
          const dr = data[o] - c[0];
          const dg = data[o + 1] - c[1];
          const db = data[o + 2] - c[2];
          if (dr * dr + dg * dg + db * db <= NOISE_THRESHOLD) {
            index[p] = transparentIndex;
            continue;
          }
        }
        shown[p] = index[p];
        changed = true;
      }

      if (pending && !changed) {
        // Nothing visible changed: just hold the previous frame longer.
        pending.end = frameEnd;
      } else {
        flush();
        pending = { index, first: !pending, start: plan[i].start, end: frameEnd };
      }
      onProgress(0.5 + (0.5 * (i + 1)) / plan.length);
    }
    flush();

    gif.finish();
    return new Blob([gif.bytesView()], { type: "image/gif" });
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
