import { DEFAULT_PRESET, presetOptions } from "./presets.js";

export async function loadPreset() {
  const { preset } = await browser.storage.sync.get({ preset: DEFAULT_PRESET });
  return preset;
}

export async function loadSettings() {
  return presetOptions(await loadPreset());
}
