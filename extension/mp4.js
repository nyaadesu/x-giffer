// Minimal MP4 (ISO BMFF) reader: returns the presentation timestamps of the
// first video track's frames, so the GIF can reuse the source frame timing
// instead of resampling at a fixed rate. Returns null for anything it doesn't
// understand (e.g. fragmented MP4); callers fall back to fixed-rate sampling.

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

function* boxes(view, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      view.getUint8(pos + 4), view.getUint8(pos + 5), view.getUint8(pos + 6), view.getUint8(pos + 7),
    );
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function find(view, box, path) {
  const [head, ...rest] = path;
  for (const child of boxes(view, box.start, box.end)) {
    if (child.type !== head) continue;
    if (!rest.length) return child;
    const hit = CONTAINERS.has(head) ? find(view, child, rest) : null;
    if (hit) return hit;
  }
  return null;
}

function videoTrak(view, moov) {
  for (const trak of boxes(view, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    const hdlr = find(view, trak, ["mdia", "hdlr"]);
    // hdlr: version/flags(4) pre_defined(4) handler_type(4)
    if (hdlr && view.getUint32(hdlr.start + 8) === 0x76696465 /* "vide" */) return trak;
  }
  return null;
}

/**
 * Presentation time in seconds of each sample of the track, in decode order,
 * counted from the first frame, plus the track's length. Null if unreadable.
 */
function trackTiming(view, trak) {
  const mdhd = find(view, trak, ["mdia", "mdhd"]);
  const stts = find(view, trak, ["mdia", "minf", "stbl", "stts"]);
  if (!mdhd || !stts) return null;

  const v1 = view.getUint8(mdhd.start) === 1;
  const timescale = view.getUint32(mdhd.start + (v1 ? 20 : 12));
  if (!timescale) return null;

  // stts gives decode-order sample durations.
  const pts = [];
  let t = 0;
  const sttsCount = view.getUint32(stts.start + 4);
  for (let i = 0; i < sttsCount; i++) {
    const count = view.getUint32(stts.start + 8 + i * 8);
    const delta = view.getUint32(stts.start + 12 + i * 8);
    for (let j = 0; j < count; j++, t += delta) pts.push(t);
  }
  if (!pts.length) return null;
  const end = t;

  // ctts (present with B-frames) shifts decode times to presentation times.
  const ctts = find(view, trak, ["mdia", "minf", "stbl", "ctts"]);
  if (ctts) {
    const signed = view.getUint8(ctts.start) === 1;
    const n = view.getUint32(ctts.start + 4);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const count = view.getUint32(ctts.start + 8 + i * 8);
      const at = ctts.start + 12 + i * 8;
      const offset = signed ? view.getInt32(at) : view.getUint32(at);
      for (let j = 0; j < count && k < pts.length; j++, k++) pts[k] += offset;
    }
  }

  // Normalise so the first frame starts at 0; B-frame streams are shifted
  // by the composition offset (normally undone by an edit list).
  const first = pts.reduce((a, b) => Math.min(a, b));
  const times = pts.map((p) => (p - first) / timescale);
  const last = times.reduce((a, b) => Math.max(a, b));
  // Total of the sample durations is the presentation length.
  return { times, duration: Math.max(end / timescale, last) };
}

function sorted(timing) {
  return { times: [...timing.times].sort((a, b) => a - b), duration: timing.duration };
}

/** @returns {{ times: number[], duration: number } | null} frame start times in seconds, sorted */
export function frameTimes(buffer) {
  try {
    const view = new DataView(buffer);
    const moov = find(view, { start: 0, end: buffer.byteLength }, ["moov"]);
    const trak = moov && videoTrak(view, moov);
    const timing = trak && trackTiming(view, trak);
    return timing && sorted(timing);
  } catch {
    return null;
  }
}

/** Clockwise rotation (0, 90, 180 or 270) from the tkhd display matrix. */
function rotation(view, trak) {
  const tkhd = find(view, trak, ["tkhd"]);
  if (!tkhd) return 0;
  // tkhd: the 3×3 matrix (16.16 fixed point a, b, u, c, d, v, x, y, w)
  // follows 40 bytes of fields in version 0, 52 in version 1.
  const at = tkhd.start + (view.getUint8(tkhd.start) === 1 ? 52 : 40);
  const a = view.getInt32(at);
  const b = view.getInt32(at + 4);
  const degrees = Math.round(Math.atan2(b, a) / (Math.PI / 2)) * 90;
  return (degrees + 360) % 360;
}

/**
 * Everything needed to decode the first video track with WebCodecs: the
 * VideoDecoderConfig plus every sample in decode order, with presentation
 * times in seconds counted from the first frame. Only plain (unfragmented)
 * H.264, which is what X serves; null for anything else. rotation is how far
 * the picture must be turned clockwise for display.
 * @returns {{ config: VideoDecoderConfig, rotation: number,
 *   timing: { times: number[], duration: number },
 *   samples: { offset: number, size: number, time: number, key: boolean }[] } | null}
 */
export function videoSamples(buffer) {
  try {
    const view = new DataView(buffer);
    const moov = find(view, { start: 0, end: buffer.byteLength }, ["moov"]);
    const trak = moov && videoTrak(view, moov);
    const stbl = trak && find(view, trak, ["mdia", "minf", "stbl"]);
    const timing = trak && trackTiming(view, trak);
    if (!stbl || !timing) return null;
    const box = (type) => find(view, stbl, [type]);

    // stsd: version/flags(4) entry_count(4), then sample entries. A visual
    // sample entry has 78 bytes of fields (width at 24, height at 26) before
    // its child boxes, one of which is avcC.
    const stsd = box("stsd");
    const entry = stsd && boxes(view, stsd.start + 8, stsd.end).next().value;
    if (!entry || (entry.type !== "avc1" && entry.type !== "avc3")) return null;
    const avcC = find(view, { start: entry.start + 78, end: entry.end }, ["avcC"]);
    if (!avcC) return null;
    const description = new Uint8Array(buffer.slice(avcC.start, avcC.end));
    const hex = (i) => description[i].toString(16).padStart(2, "0");
    const codedWidth = view.getUint16(entry.start + 24);
    const codedHeight = view.getUint16(entry.start + 26);

    const stsz = box("stsz");
    const stsc = box("stsc");
    const stco = box("stco") || box("co64");
    if (!stsz || !stsc || !stco) return null;

    // stsz: version/flags(4) sample_size(4) sample_count(4) [entry_size(4)...]
    const fixedSize = view.getUint32(stsz.start + 4);
    const count = view.getUint32(stsz.start + 8);
    if (count !== timing.times.length) return null;
    const samples = Array.from({ length: count }, (_, i) => ({
      size: fixedSize || view.getUint32(stsz.start + 12 + i * 4),
      offset: 0,
      time: timing.times[i],
      key: true,
    }));

    // stsc maps chunks to how many samples they hold; stco/co64 give each
    // chunk's file offset, and its samples follow back to back.
    const co64 = stco.type === "co64";
    const chunks = view.getUint32(stco.start + 4);
    const chunkOffset = (c) =>
      co64 ? Number(view.getBigUint64(stco.start + 8 + c * 8)) : view.getUint32(stco.start + 8 + c * 4);
    const runs = view.getUint32(stsc.start + 4);
    let s = 0;
    for (let r = 0; r < runs; r++) {
      const first = view.getUint32(stsc.start + 8 + r * 12) - 1;
      const perChunk = view.getUint32(stsc.start + 12 + r * 12);
      const last = r + 1 < runs ? view.getUint32(stsc.start + 20 + r * 12) - 1 : chunks;
      for (let c = first; c < last; c++) {
        let offset = chunkOffset(c);
        for (let k = 0; k < perChunk && s < count; k++, s++) {
          samples[s].offset = offset;
          offset += samples[s].size;
        }
      }
    }
    if (s !== count) return null;

    // stss lists the keyframes (1-based); without it every sample is one.
    const stss = box("stss");
    if (stss) {
      samples.forEach((sample) => (sample.key = false));
      const n = view.getUint32(stss.start + 4);
      for (let i = 0; i < n; i++) {
        const sample = samples[view.getUint32(stss.start + 8 + i * 4) - 1];
        if (sample) sample.key = true;
      }
    }

    if (samples.some((sample) => sample.offset + sample.size > buffer.byteLength)) return null;
    return {
      config: { codec: `avc1.${hex(1)}${hex(2)}${hex(3)}`, codedWidth, codedHeight, description },
      rotation: rotation(view, trak),
      timing: sorted(timing),
      samples,
    };
  } catch {
    return null;
  }
}
