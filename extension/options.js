import { DEFAULTS, loadSettings } from "./settings.js";

const LIMITS = { fps: [1, 50], maxWidth: [0, 4096], colors: [2, 256] };
const status = document.getElementById("status");

const settings = await loadSettings();
for (const key of Object.keys(DEFAULTS)) {
  const input = document.getElementById(key);
  input.value = settings[key];
  input.addEventListener("change", async () => {
    const [min, max] = LIMITS[key];
    const value = Math.min(max, Math.max(min, Math.round(Number(input.value) || DEFAULTS[key])));
    input.value = value;
    await browser.storage.sync.set({ [key]: value });
    status.textContent = "Saved.";
    setTimeout(() => (status.textContent = ""), 1200);
  });
}
