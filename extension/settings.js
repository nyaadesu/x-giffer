// Shared defaults for the background converter and the options page.
export const DEFAULTS = {
  fps: 15, // frames per second sampled from the MP4
  maxWidth: 480, // GIF is scaled down to this width (0 = keep original)
  colors: 256, // palette size per frame (2-256)
};

export async function loadSettings() {
  const stored = await browser.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}
