import { fillPresetSelect } from "./presets.js";
import { loadPreset } from "./settings.js";

const select = document.getElementById("preset");
const status = document.getElementById("status");

fillPresetSelect(select, await loadPreset());
select.addEventListener("change", async () => {
  await browser.storage.sync.set({ preset: select.value });
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 1200);
});
