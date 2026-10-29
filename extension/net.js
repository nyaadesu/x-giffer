// Network helpers shared by the extension and the PWA.

// Give up on a request once it has gone this long without receiving anything.
// A connection that stalls mid-download (flaky Wi-Fi, a captive portal) would
// otherwise leave the button spinning forever. Slow but steady downloads are
// fine: the clock restarts with every chunk.
const STALL_MS = 30_000;

/**
 * fetch() that fails if the response stops arriving for STALL_MS. The body is
 * read in full before returning, so the result works like any Response.
 */
export async function fetchOrStall(url, init = {}) {
  const controller = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error(`download stalled: nothing received for ${STALL_MS / 1000}s`)),
      STALL_MS,
    );
  };

  arm();
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const chunks = [];
    const reader = res.body.getReader();
    for (;;) {
      arm();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const type = res.headers.get("content-type") || "";
    return new Response(new Blob(chunks, { type }), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } finally {
    clearTimeout(timer);
  }
}
