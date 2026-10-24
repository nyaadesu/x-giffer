import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.js";

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
 * Convert an MP4 blob into an animated GIF blob by seeking through the video
 * frame by frame, drawing each frame to a canvas and encoding it with gifenc.
 */
export async function mp4ToGif(mp4Blob, { fps, maxWidth, colors }, onProgress = () => {}) {
  const url = URL.createObjectURL(mp4Blob);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;

  try {
    await once(video, "loadeddata");

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("could not determine video duration");
    }

    const scale = maxWidth > 0 && video.videoWidth > maxWidth ? maxWidth / video.videoWidth : 1;
    // GIF dimensions must be integers; keep them even for nicer scaling.
    const width = Math.max(2, Math.round((video.videoWidth * scale) / 2) * 2);
    const height = Math.max(2, Math.round((video.videoHeight * scale) / 2) * 2);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const gif = GIFEncoder();
    const frameCount = Math.max(1, Math.round(duration * fps));
    // GIF delays are whole centiseconds; distribute the rounding error across
    // frames so the total length matches the video instead of drifting.
    const delayFor = (i) => (Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps)) * 10;

    for (let i = 0; i < frameCount; i++) {
      // Sample the middle of each frame interval to avoid landing exactly on
      // boundaries, which some decoders round to the previous frame.
      const t = Math.min((i + 0.5) / fps, duration - 0.001);
      video.currentTime = t;
      await once(video, "seeked");

      ctx.drawImage(video, 0, 0, width, height);
      const { data } = ctx.getImageData(0, 0, width, height);
      const palette = quantize(data, colors);
      const index = applyPalette(data, palette);
      gif.writeFrame(index, width, height, { palette, delay: delayFor(i) });

      onProgress((i + 1) / frameCount);
    }

    gif.finish();
    return new Blob([gif.bytesView()], { type: "image/gif" });
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
