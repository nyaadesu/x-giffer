import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.js";
import { frameTimes, videoSamples } from "./mp4.js";

// GIF delays are whole centiseconds and browsers bump anything under 2cs to
// 10cs, so 50fps is the fastest a GIF can really play.
const MAX_FPS = 50;
const FALLBACK_FPS = 30;
// Pixels sampled across all frames to build the shared palette.
const PALETTE_SAMPLE = 4_000_000;
// Keep decoded frames in memory between passes up to this size; beyond it
// they are decoded again instead.
const FRAME_CACHE_BYTES = 256 * 1024 * 1024;
// Without the cache every frame is decoded twice, so the palette pass only
// samples this many frames spread across the clip instead of all of them.
const PALETTE_FRAMES = 60;
// Squared RGB distance below which a pixel counts as unchanged from what is
// already on screen, so video compression noise doesn't shimmer.
const NOISE_THRESHOLD = 3 * 4 * 4;
// Encoded chunks queued in the WebCodecs decoder before waiting for it.
const DECODE_AHEAD = 8;
// How long a decoder may go without producing anything before we give up.
// Some fail by going silent instead of reporting an error, which would leave
// the button spinning forever.
const STALL_MS = 20_000;

function once(target, event, errorEvent = "error") {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      target.removeEventListener(event, ok);
      target.removeEventListener(errorEvent, fail);
    };
    const ok = () => {
      done();
      resolve();
    };
    const fail = () => {
      done();
      reject(new Error(`video ${errorEvent} while waiting for ${event}`));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`video timed out waiting for ${event}`));
    }, STALL_MS);
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

// A frame source opens the MP4 and reads frames out of it as RGBA pixels:
// { width, height, rotation, timing, read(frames, draw), close() }. width and
// height are as displayed; images handed to draw() still need turning
// clockwise by `rotation` degrees. read() takes plan entries in increasing
// order and yields draw(image) for each one.

// WebCodecs failed while decoding, so mp4ToGif retries with a <video>.
class DecodeError extends Error {}

/**
 * Decode with WebCodecs. Firefox on macOS can't decode a <video> in an
 * extension's background page at all ("Expected Planar YCbCr image"), and
 * this also skips the seeking. Null if the browser or the file isn't supported.
 */
async function webCodecsSource(buffer) {
  if (typeof VideoDecoder === "undefined") return null;
  const track = videoSamples(buffer);
  if (!track) return null;
  const { config, samples, rotation, timing } = track;
  const micros = (seconds) => Math.round(seconds * 1e6);
  const chunk = (sample) =>
    new EncodedVideoChunk({
      type: sample.key ? "key" : "delta",
      timestamp: micros(sample.time),
      data: new Uint8Array(buffer, sample.offset, sample.size),
    });

  // Decode the first frame up front: it proves the decoder really works, and
  // its display size includes the pixel aspect from the stream, as a <video>
  // would show it.
  let size = null;
  const probe = new VideoDecoder({
    output: (frame) => {
      size ??= { width: frame.displayWidth, height: frame.displayHeight };
      frame.close();
    },
    error: () => {},
  });
  try {
    if (!samples[0]?.key || !(await VideoDecoder.isConfigSupported(config)).supported) return null;
    probe.configure(config);
    probe.decode(chunk(samples[0]));
    let timer;
    await Promise.race([
      probe.flush(),
      new Promise((_, reject) => (timer = setTimeout(reject, STALL_MS))),
    ]).finally(() => clearTimeout(timer));
  } catch {
    return null;
  } finally {
    if (probe.state !== "closed") probe.close();
  }
  if (!size?.width || !size?.height) return null;

  async function* read(frames, draw) {
    // Decode everything in order and keep the frames the plan asks for.
    const wanted = frames.map((f) => micros(f.start));
    const ready = [];
    let next = 0;
    // A decoder error is retried with a <video>; an error of our own isn't.
    let failure = null;
    let drawError = null;
    const stopped = () => failure || drawError;
    let wake = null;
    let lastActivity = Date.now();
    const notify = () => {
      lastActivity = Date.now();
      wake?.();
    };
    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          // Take the first frame at or after each wanted time, so a frame the
          // decoder drops or retimes doesn't cost every frame after it.
          if (!drawError && frame.timestamp >= wanted[next]) {
            const data = draw(frame);
            while (frame.timestamp >= wanted[next]) {
              ready.push(data);
              next++;
            }
          }
        } catch (err) {
          drawError = err;
        } finally {
          frame.close();
          notify();
        }
      },
      error: (err) => {
        failure = err;
        notify();
      },
    });
    decoder.addEventListener("dequeue", notify);
    // Wake on decoder activity, or shortly anyway: Chrome before 106 has no
    // dequeue event. Give up if the decoder goes quiet for too long.
    const waitForDecoder = async () => {
      await new Promise((resolve) => {
        wake = resolve;
        setTimeout(resolve, 100);
      });
      wake = null;
      if (Date.now() - lastActivity > STALL_MS) throw new DecodeError("video decode stalled");
    };

    try {
      decoder.configure(config);
      for (const sample of samples) {
        if (stopped() || next === wanted.length) break;
        decoder.decode(chunk(sample));
        lastActivity = Date.now();
        while (ready.length) yield ready.shift();
        while (!stopped() && decoder.decodeQueueSize > DECODE_AHEAD) await waitForDecoder();
      }
      if (!stopped() && next < wanted.length) {
        let flushed = false;
        const flush = decoder.flush().finally(() => {
          flushed = true;
          notify();
        });
        flush.catch(() => {});
        while (!flushed) await waitForDecoder();
        await flush;
      }
      if (drawError) throw drawError;
      if (failure) throw new DecodeError(`video decode failed: ${failure.message || failure}`);
      while (ready.length) yield ready.shift();
      if (next < wanted.length) throw new DecodeError("video decode skipped frames");
    } catch (err) {
      if (err instanceof DecodeError || err === drawError) throw err;
      throw new DecodeError(`video decode failed: ${err?.message || err}`);
    } finally {
      if (decoder.state !== "closed") decoder.close();
    }
  }

  const turned = rotation % 180 !== 0;
  return {
    width: turned ? size.height : size.width,
    height: turned ? size.width : size.height,
    rotation,
    timing,
    read,
    close() {},
  };
}

/** Play the MP4 in a <video> element and seek to each frame. */
async function videoSource(mp4Blob, buffer) {
  const url = URL.createObjectURL(mp4Blob);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  const close = () => {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  };

  try {
    await once(video, "loadeddata");

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("could not determine video duration");
    }

    let timing = frameTimes(buffer);
    if (!timing || timing.times.at(-1) > duration + 0.1) {
      const n = Math.max(1, Math.round(duration * FALLBACK_FPS));
      timing = { times: Array.from({ length: n }, (_, i) => i / FALLBACK_FPS), duration };
    }

    async function* read(frames, draw) {
      for (const frame of frames) {
        video.currentTime = frame.seek;
        await once(video, "seeked");
        yield draw(video);
      }
    }

    return {
      // The <video> already shows it turned the right way.
      width: video.videoWidth,
      height: video.videoHeight,
      rotation: 0,
      timing: { times: timing.times, duration: Math.min(timing.duration, duration) },
      read,
      close,
    };
  } catch (err) {
    close();
    throw err;
  }
}

/**
 * Convert an MP4 blob into an animated GIF blob, keeping the source frames
 * and their timing. Options: maxFps (0 = source), maxWidth (0 = original),
 * colors (2-256 per frame), maxPixels (width × height × frames budget,
 * 0 = none; the GIF is scaled down to fit).
 */
export async function mp4ToGif(mp4Blob, options, onProgress = () => {}) {
  const buffer = await mp4Blob.arrayBuffer();
  const fast = await webCodecsSource(buffer);
  let fastError = null;
  if (fast) {
    try {
      return await encode(fast, options, onProgress);
    } catch (err) {
      // A browser can claim support and still fail partway; start over the slow way.
      if (!(err instanceof DecodeError)) throw err;
      console.warn("[X Giffer] WebCodecs failed, retrying with <video>:", err);
      fastError = err;
      onProgress(0);
    }
  }
  try {
    return await encode(await videoSource(mp4Blob, buffer), options, onProgress);
  } catch (err) {
    // Show both, or the failure that made us retry would be hidden.
    if (!fastError) throw err;
    throw new Error(`${err.message} (after ${fastError.message})`, { cause: err });
  }
}

async function encode(source, { maxFps = 0, maxWidth = 0, colors = 256, maxPixels = 0 }, onProgress) {
  let rest = null;

  try {
    const end = source.timing.duration;
    const plan = planFrames(source.timing, maxFps);

    let scale = maxWidth > 0 && source.width > maxWidth ? maxWidth / source.width : 1;
    const total = source.width * source.height * scale * scale * plan.length;
    if (maxPixels > 0 && total > maxPixels) scale *= Math.sqrt(maxPixels / total);
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";

    // Turn the canvas about its centre once, then draw every frame unturned.
    const turned = source.rotation % 180 !== 0;
    const [drawWidth, drawHeight] = turned ? [height, width] : [width, height];
    ctx.translate(width / 2, height / 2);
    ctx.rotate((source.rotation * Math.PI) / 180);
    const draw = (image) => {
      ctx.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
      return ctx.getImageData(0, 0, width, height).data;
    };

    // Pass 1: decode frames and sample their pixels for one palette shared by
    // the whole GIF. Per-frame palettes make gradients band differently on
    // every frame, which shows up as shimmering colours. If the frames fit in
    // the cache, decode all of them now; otherwise just a spread of them.
    const pixels = width * height;
    const cacheFrames = pixels * 4 * plan.length <= FRAME_CACHE_BYTES;
    const count = cacheFrames ? plan.length : Math.min(plan.length, PALETTE_FRAMES);
    const picks = Array.from({ length: count }, (_, j) => Math.floor(((j + 0.5) * plan.length) / count));
    // Share of the progress bar for pass 1, by how many frames each pass decodes.
    const split = cacheFrames ? 0.5 : count / (count + plan.length);
    const stride = Math.max(1, Math.ceil((pixels * count) / PALETTE_SAMPLE));
    const sample = new Uint32Array(Math.ceil(pixels / stride) * count);
    let sampled = 0;
    const frames = [];
    let j = 0;
    for await (const data of source.read(picks.map((i) => plan[i]), draw)) {
      if (cacheFrames) frames.push(data);
      const px = new Uint32Array(data.buffer);
      // Offset the start per frame so sampling doesn't always hit the same pixels.
      for (let p = j % stride; p < px.length; p += stride) sample[sampled++] = px[p];
      onProgress((split * ++j) / count);
    }

    // The last palette slot is reserved for "unchanged since last frame".
    const palette = quantize(new Uint8Array(sample.buffer, 0, sampled * 4), Math.min(colors, 256) - 1);
    const transparentIndex = palette.length;
    const gifPalette = [...palette, [0, 0, 0]];

    // Pass 2: map each frame onto the palette. Pixels that are unchanged (or
    // only differ by compression noise) are left transparent so the previous
    // frame shows through: no shimmer on static areas and much smaller files.
    rest = cacheFrames ? null : source.read(plan, draw);
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
      const data = cacheFrames ? frames[i] : (await rest.next()).value;
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
      onProgress(split + ((1 - split) * (i + 1)) / plan.length);
    }
    flush();

    gif.finish();
    return new Blob([gif.bytesView()], { type: "image/gif" });
  } finally {
    await rest?.return();
    source.close();
  }
}
