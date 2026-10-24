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

/** @returns {{ times: number[], duration: number } | null} frame start times in seconds, sorted */
export function frameTimes(buffer) {
  try {
    const view = new DataView(buffer);
    const moov = find(view, { start: 0, end: buffer.byteLength }, ["moov"]);
    const trak = moov && videoTrak(view, moov);
    const mdhd = trak && find(view, trak, ["mdia", "mdhd"]);
    const stts = trak && find(view, trak, ["mdia", "minf", "stbl", "stts"]);
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

    pts.sort((a, b) => a - b);
    // Normalise so the first frame starts at 0; B-frame streams are shifted
    // by the composition offset (normally undone by an edit list).
    const first = pts[0];
    const times = pts.map((p) => (p - first) / timescale);
    // Total of the sample durations is the presentation length.
    return { times, duration: Math.max(end / timescale, times.at(-1)) };
  } catch {
    return null;
  }
}
