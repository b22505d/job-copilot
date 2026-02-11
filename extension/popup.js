const DEFAULT_API_BASE_URL = "http://127.0.0.1:8000";

const apiBaseInput = document.getElementById("apiBaseUrl");
const autofillButton = document.getElementById("autofillButton");
const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function loadSettings() {
  const data = await chrome.storage.local.get({ apiBaseUrl: DEFAULT_API_BASE_URL });
  apiBaseInput.value = data.apiBaseUrl;
}

async function saveSettings(apiBaseUrl) {
  await chrome.storage.local.set({ apiBaseUrl });
}

async function sendAutofillMessage(tabId, apiBaseUrl) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "JOB_COPILOT_AUTOFILL", apiBaseUrl }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response from content script." });
    });
  });
}

autofillButton.addEventListener("click", async () => {
  const apiBaseUrl = (apiBaseInput.value || "").trim() || DEFAULT_API_BASE_URL;

  autofillButton.disabled = true;
  setStatus("Running autofill...");

  try {
    await saveSettings(apiBaseUrl);
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus("No active tab found.");
      return;
    }

    const result = await sendAutofillMessage(tab.id, apiBaseUrl);
    if (!result?.ok) {
      setStatus(`Autofill failed:\n${result?.error || "Unknown error"}`);
      return;
    }

    const summary = [
      `Site: ${result.site || "unknown"}`,
      `Rule Filled: ${result.filledRuleCount || 0}`,
      `AI Filled: ${result.filledAiCount || 0}`,
      `Filled: ${result.filledCount || 0}`,
      `Skipped: ${result.skippedCount || 0}`,
      result.message || "Done. Review values before submitting.",
      result.aiMessage ? `AI Note: ${result.aiMessage}` : ""
    ];

    setStatus(summary.filter(Boolean).join("\n"));
  } catch (error) {
    setStatus(`Unexpected error:\n${error.message || String(error)}`);
  } finally {
    autofillButton.disabled = false;
  }
});

loadSettings().catch((error) => {
  setStatus(`Settings load failed: ${error.message || String(error)}`);
});
