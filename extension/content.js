const LOW_CONFIDENCE_THRESHOLD = 0.65;
const SUMMARY_ID = "job-copilot-autofill-summary";
const STYLE_ID = "job-copilot-autofill-style";

const FIELD_RULES = [
  {
    key: "first_name",
    patterns: [/\bfirst\s*name\b/, /\bgiven\s*name\b/],
    confidence: 0.95
  },
  {
    key: "last_name",
    patterns: [/\blast\s*name\b/, /\bfamily\s*name\b/, /\bsurname\b/],
    confidence: 0.95
  },
  {
    key: "email",
    patterns: [/\be[-\s]*mail\b/, /\bemail\b/],
    confidence: 0.98
  },
  {
    key: "phone",
    patterns: [/\bphone\b/, /\bmobile\b/, /\bcell\b/, /\btelephone\b/],
    confidence: 0.9
  },
  {
    key: "linkedin",
    patterns: [/\blinkedin\b/, /\blinked\s*in\b/],
    confidence: 0.92
  }
];

const profileKeyMap = {
  first_name: (profile) => profile.personal?.first_name,
  last_name: (profile) => profile.personal?.last_name,
  email: (profile) => profile.personal?.email,
  phone: (profile) => profile.personal?.phone,
  linkedin: (profile) => profile.links?.linkedin
};

function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textFromNode(node) {
  return normalize(node?.textContent || "");
}

function getCandidateText(input) {
  const candidates = [];

  if (input.labels?.length) {
    for (const label of input.labels) {
      candidates.push(label.textContent || "");
    }
  }

  if (input.id) {
    const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (label) {
      candidates.push(label.textContent || "");
    }
  }

  candidates.push(input.getAttribute("aria-label") || "");
  candidates.push(input.getAttribute("placeholder") || "");
  candidates.push(input.name || "");
  candidates.push(input.id || "");

  const parentText = textFromNode(input.closest("label"));
  if (parentText) {
    candidates.push(parentText);
  }

  const fieldContainer = input.closest(".field, .application-field, .input-wrapper, .form-field");
  if (fieldContainer) {
    const heading = fieldContainer.querySelector("label, legend, h3, h4, p");
    if (heading) {
      candidates.push(heading.textContent || "");
    }
  }

  const normalized = candidates.map(normalize).filter(Boolean);
  return Array.from(new Set(normalized)).join(" ");
}

function mapFieldFromText(haystack) {
  if (!haystack) {
    return null;
  }

  let best = null;
  for (const rule of FIELD_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(haystack)) {
        if (!best || rule.confidence > best.confidence) {
          best = {
            key: rule.key,
            confidence: rule.confidence,
            labelText: haystack
          };
        }
      }
    }
  }

  if (best && best.key === "first_name" && haystack === "name") {
    return { ...best, confidence: 0.4 };
  }

  return best;
}

function getProfileValue(profile, key) {
  const reader = profileKeyMap[key];
  if (!reader) {
    return "";
  }
  return (reader(profile) || "").toString().trim();
}

function fillInput(input, value) {
  if (!value) {
    return { status: "missing-profile-value" };
  }

  if (input.disabled || input.readOnly) {
    return { status: "not-editable" };
  }

  if ((input.value || "").trim()) {
    return { status: "already-populated" };
  }

  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur();

  return { status: "filled" };
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .job-copilot-low-confidence {
      outline: 2px dashed #ef6c00 !important;
      outline-offset: 1px;
      background: #fff6e6 !important;
    }

    #${SUMMARY_ID} {
      position: fixed;
      top: 12px;
      right: 12px;
      width: 320px;
      z-index: 2147483647;
      background: #101624;
      color: #f7f9fc;
      border-radius: 8px;
      padding: 12px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      line-height: 1.4;
    }

    #${SUMMARY_ID} h2 {
      margin: 0 0 8px;
      font-size: 13px;
    }

    #${SUMMARY_ID} ul {
      margin: 0;
      padding-left: 18px;
    }
  `;

  document.documentElement.appendChild(style);
}

function renderSummary(summary) {
  ensureStyles();

  document.getElementById(SUMMARY_ID)?.remove();

  const panel = document.createElement("div");
  panel.id = SUMMARY_ID;

  const items = [
    `filled: ${summary.filledCount}`,
    `skipped: ${summary.skippedCount}`,
    `low confidence: ${summary.lowConfidenceCount}`,
    `missing profile values: ${summary.missingValues.length}`,
    "manual review required before submit"
  ];

  panel.innerHTML = `
    <h2>Job Copilot Autofill</h2>
    <ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>
  `;

  document.body.appendChild(panel);
}

function getFillableInputs() {
  const inputs = Array.from(document.querySelectorAll("input, textarea"));
  return inputs.filter((input) => {
    const type = (input.getAttribute("type") || "text").toLowerCase();
    if (["hidden", "submit", "button", "checkbox", "radio", "file", "password"].includes(type)) {
      return false;
    }
    return true;
  });
}

async function fetchProfile(apiBaseUrl) {
  const response = await fetch(`${apiBaseUrl}/profile`);
  if (!response.ok) {
    throw new Error(`Profile fetch failed (${response.status})`);
  }
  return response.json();
}

async function emitAudit(apiBaseUrl, payload) {
  try {
    await fetch(`${apiBaseUrl}/events/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (_error) {
    // Audit failures should not block autofill.
  }
}

const greenhouseAdapter = {
  id: "greenhouse",

  detect() {
    return window.location.hostname.includes("greenhouse.io");
  },

  extract_fields() {
    return getFillableInputs();
  },

  map_fields(input) {
    const haystack = getCandidateText(input);
    return mapFieldFromText(haystack);
  },

  fill(input, value) {
    return fillInput(input, value);
  },

  upload_resume() {
    // Not in MVP. Resume upload can be added after basic fill quality is stable.
    return { status: "not-implemented" };
  }
};

const adapters = [greenhouseAdapter];

function findAdapter() {
  return adapters.find((adapter) => adapter.detect());
}

async function runAutofill(apiBaseUrl) {
  const adapter = findAdapter();
  if (!adapter) {
    return { ok: false, error: "Current page is not supported yet." };
  }

  const profile = await fetchProfile(apiBaseUrl);
  const fields = adapter.extract_fields();

  const filled = [];
  const skipped = [];
  const lowConfidence = [];
  const missingValues = [];

  for (const field of fields) {
    const match = adapter.map_fields(field);
    if (!match) {
      continue;
    }

    if (match.confidence < LOW_CONFIDENCE_THRESHOLD) {
      field.classList.add("job-copilot-low-confidence");
      lowConfidence.push({ key: match.key, label: match.labelText, confidence: match.confidence });
      skipped.push({ key: match.key, reason: "low-confidence" });
      continue;
    }

    const value = getProfileValue(profile, match.key);
    if (!value) {
      missingValues.push(match.key);
      skipped.push({ key: match.key, reason: "missing-profile-value" });
      continue;
    }

    const fillResult = adapter.fill(field, value);
    if (fillResult.status === "filled") {
      filled.push({ key: match.key, label: match.labelText });
    } else {
      skipped.push({ key: match.key, reason: fillResult.status });
    }
  }

  const summary = {
    ok: true,
    site: adapter.id,
    filledCount: filled.length,
    skippedCount: skipped.length,
    lowConfidenceCount: lowConfidence.length,
    missingValues: Array.from(new Set(missingValues)),
    message: "Autofill complete. Review all fields before submitting."
  };

  renderSummary(summary);

  await emitAudit(apiBaseUrl, {
    site: adapter.id,
    job_url: window.location.href,
    filled_fields: filled.map((item) => item.key),
    skipped_fields: skipped.map((item) => `${item.key}:${item.reason}`),
    metadata: {
      filled_count: summary.filledCount,
      skipped_count: summary.skippedCount,
      low_confidence_count: summary.lowConfidenceCount
    }
  });

  return summary;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "JOB_COPILOT_AUTOFILL") {
    return;
  }

  const apiBaseUrl = (message.apiBaseUrl || "http://127.0.0.1:8000").replace(/\/$/, "");
  runAutofill(apiBaseUrl)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});
