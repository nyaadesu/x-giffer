// Conversion presets shared by the extension and the PWA.
// maxFps 0 = keep every source frame; maxWidth 0 = keep original size.
export const PRESETS = {
  original: { label: "Original — full size, every frame", maxFps: 0, maxWidth: 0, colors: 256 },
  balanced: { label: "Balanced — up to 720px, 30 fps", maxFps: 30, maxWidth: 720, colors: 256 },
  small: { label: "Small — up to 480px, 20 fps", maxFps: 20, maxWidth: 480, colors: 256 },
  tiny: { label: "Tiny — 320px, 12 fps, for chat apps", maxFps: 12, maxWidth: 320, colors: 128 },
};

export const DEFAULT_PRESET = "original";

export function presetOptions(name) {
  return PRESETS[name] || PRESETS[DEFAULT_PRESET];
}

/** Fill a <select> with the presets and select `current`. */
export function fillPresetSelect(select, current) {
  select.replaceChildren(
    ...Object.entries(PRESETS).map(([value, { label }]) => new Option(label, value)),
  );
  select.value = PRESETS[current] ? current : DEFAULT_PRESET;
}
