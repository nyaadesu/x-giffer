import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.js";
import { frameTimes } from "./mp4.js";

// GIF delays are whole centiseconds and browsers bump anything under 2cs to
// 10cs, so 50fps is the fastest a GIF can really play.
const MAX_FPS = 50;
const FALLBACK_FPS = 30;

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

function sameFrame(a, b) {
  if (!a || a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer);
  const y = new Uint32Array(b.buffer);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
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

    const gif = GIFEncoder();
    // Frames are written one behind so identical neighbours can be merged
    // into a single longer frame.
    let pending = null;
    const flush = () => {
      if (!pending) return;
      // Round cumulative times rather than each delay so the total length
      // doesn't drift; clamp to the 2cs minimum browsers honour.
      const cs = Math.max(2, Math.round(pending.end * 100) - Math.round(pending.start * 100));
      gif.writeFrame(pending.index, width, height, { palette: pending.palette, delay: cs * 10 });
    };

    for (let i = 0; i < plan.length; i++) {
      const frame = plan[i];
      const frameEnd = plan[i + 1]?.start ?? end;
      video.currentTime = frame.seek;
      await once(video, "seeked");

      ctx.drawImage(video, 0, 0, width, height);
      const { data } = ctx.getImageData(0, 0, width, height);

      if (pending && sameFrame(pending.raw, data)) {
        pending.end = frameEnd;
      } else {
        flush();
        const palette = quantize(data, colors);
        const index = applyPalette(data, palette);
        pending = { raw: data, index, palette, start: frame.start, end: frameEnd };
      }
      onProgress((i + 1) / plan.length);
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
