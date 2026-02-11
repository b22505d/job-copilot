const LOW_CONFIDENCE_THRESHOLD = 0.65;
const AI_FILL_CONFIDENCE_THRESHOLD = 0.72;
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

function dispatchFieldEvents(element) {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function getOptionLabelFromInput(input) {
  if (input.labels?.length) {
    return normalize(input.labels[0].textContent || "");
  }

  const parentLabel = input.closest("label");
  if (parentLabel) {
    return normalize(parentLabel.textContent || "");
  }

  const siblingText = input.parentElement?.textContent || "";
  return normalize(siblingText);
}

function getCandidateTextFromElement(input) {
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

  const fieldContainer = input.closest(".field, .application-field, .input-wrapper, .form-field, fieldset");
  if (fieldContainer) {
    const heading = fieldContainer.querySelector("label, legend, h3, h4, p");
    if (heading) {
      candidates.push(heading.textContent || "");
    }
  }

  const normalized = candidates.map(normalize).filter(Boolean);
  return Array.from(new Set(normalized)).join(" ");
}

function makeFieldIdFactory() {
  const counts = new Map();
  return (prefix, raw) => {
    const basePart = normalize(raw || "field").replace(/\s+/g, "_") || "field";
    const base = `${prefix}:${basePart}`;
    const existing = counts.get(base) || 0;
    counts.set(base, existing + 1);
    return existing === 0 ? base : `${base}_${existing + 1}`;
  };
}

function isRequiredField(element) {
  return (
    !!element.required ||
    element.getAttribute("aria-required") === "true" ||
    normalize(element.closest("label, .field, .application-field, fieldset")?.textContent || "").includes("required")
  );
}

function extractFieldCandidates() {
  const nextFieldId = makeFieldIdFactory();
  const candidates = [];

  const textLike = Array.from(document.querySelectorAll("input, textarea, select"));
  for (const element of textLike) {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || "text").toLowerCase();

    if (tag === "input" && ["hidden", "submit", "button", "password", "file", "radio", "checkbox"].includes(type)) {
      continue;
    }

    const fieldType = tag === "textarea" ? "textarea" : tag === "select" ? "select" : "text";
    const labelText = getCandidateTextFromElement(element);
    const rawId = element.id || element.name || labelText;

    const options =
      fieldType === "select"
        ? Array.from(element.options || [])
            .map((opt) => (opt.textContent || "").trim())
            .filter(Boolean)
        : [];

    candidates.push({
      id: nextFieldId(fieldType, rawId),
      fieldType,
      labelText,
      options,
      required: isRequiredField(element),
      elements: [element]
    });
  }

  const radioInputs = Array.from(document.querySelectorAll("input[type='radio']"));
  const radioGroups = new Map();
  for (const input of radioInputs) {
    const key = input.name || input.id || getCandidateTextFromElement(input) || "radio";
    if (!radioGroups.has(key)) {
      radioGroups.set(key, []);
    }
    radioGroups.get(key).push(input);
  }

  for (const [groupKey, inputs] of radioGroups.entries()) {
    const labelText = getCandidateTextFromElement(inputs[0]);
    const options = inputs
      .map((input) => getOptionLabelFromInput(input) || normalize(input.value || ""))
      .filter(Boolean);

    candidates.push({
      id: nextFieldId("radio", groupKey),
      fieldType: "radio",
      labelText,
      options,
      required: inputs.some((input) => isRequiredField(input)),
      elements: inputs
    });
  }

  const checkboxInputs = Array.from(document.querySelectorAll("input[type='checkbox']"));
  const checkboxGroups = new Map();
  for (const input of checkboxInputs) {
    const key = input.name || input.id || `checkbox_${checkboxGroups.size + 1}`;
    if (!checkboxGroups.has(key)) {
      checkboxGroups.set(key, []);
    }
    checkboxGroups.get(key).push(input);
  }

  for (const [groupKey, inputs] of checkboxGroups.entries()) {
    const labelText = getCandidateTextFromElement(inputs[0]);
    const options = inputs
      .map((input) => getOptionLabelFromInput(input) || normalize(input.value || ""))
      .filter(Boolean);

    candidates.push({
      id: nextFieldId("checkbox", groupKey),
      fieldType: "checkbox",
      labelText,
      options,
      required: inputs.some((input) => isRequiredField(input)),
      elements: inputs
    });
  }

  return candidates;
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

function findBestOptionMatch(options, value) {
  const normalizedValue = normalize(Array.isArray(value) ? value.join(" ") : String(value || ""));
  if (!normalizedValue) {
    return null;
  }

  for (const option of options) {
    const optionLabel = normalize(option.label || option.text || option.value || "");
    const optionValue = normalize(option.value || "");
    if (
      optionLabel === normalizedValue ||
      optionValue === normalizedValue ||
      optionLabel.includes(normalizedValue) ||
      normalizedValue.includes(optionLabel)
    ) {
      return option;
    }
  }

  return null;
}

function fillCandidate(candidate, value) {
  if (value === null || value === undefined || value === "") {
    return { status: "missing-profile-value" };
  }

  const primary = candidate.elements[0];
  if (!primary) {
    return { status: "missing-element" };
  }

  if (candidate.fieldType === "text" || candidate.fieldType === "textarea") {
    if (primary.disabled || primary.readOnly) {
      return { status: "not-editable" };
    }
    if ((primary.value || "").trim()) {
      return { status: "already-populated" };
    }
    primary.focus();
    primary.value = String(value);
    dispatchFieldEvents(primary);
    primary.blur();
    return { status: "filled" };
  }

  if (candidate.fieldType === "select") {
    if (primary.disabled) {
      return { status: "not-editable" };
    }

    const options = Array.from(primary.options || []);
    const matched = findBestOptionMatch(options, value);
    if (!matched) {
      return { status: "option-not-found" };
    }

    primary.value = matched.value;
    dispatchFieldEvents(primary);
    return { status: "filled" };
  }

  if (candidate.fieldType === "radio") {
    const options = candidate.elements.map((input) => ({
      input,
      value: input.value,
      label: getOptionLabelFromInput(input)
    }));
    const matched = findBestOptionMatch(options, value);
    if (!matched) {
      return { status: "option-not-found" };
    }

    if (!matched.input.checked) {
      matched.input.click();
      dispatchFieldEvents(matched.input);
    }
    return { status: "filled" };
  }

  if (candidate.fieldType === "checkbox") {
    const inputs = candidate.elements;

    if (inputs.length === 1 && typeof value === "boolean") {
      const input = inputs[0];
      if (input.checked !== value) {
        input.checked = value;
        dispatchFieldEvents(input);
      }
      return { status: "filled" };
    }

    if (inputs.length === 1 && typeof value === "string") {
      const normalized = normalize(value);
      const shouldCheck = ["yes", "true", "1", "checked"].some((token) => normalized.includes(token));
      const input = inputs[0];
      if (input.checked !== shouldCheck) {
        input.checked = shouldCheck;
        dispatchFieldEvents(input);
      }
      return { status: "filled" };
    }

    const targetValues = Array.isArray(value) ? value : [value];
    let matchedAny = false;

    for (const target of targetValues) {
      const matched = findBestOptionMatch(
        inputs.map((input) => ({
          input,
          value: input.value,
          label: getOptionLabelFromInput(input)
        })),
        target
      );
      if (matched) {
        matched.input.checked = true;
        dispatchFieldEvents(matched.input);
        matchedAny = true;
      }
    }

    return matchedAny ? { status: "filled" } : { status: "option-not-found" };
  }

  return { status: "unsupported-field-type" };
}

function getCurrentCandidateValue(candidate) {
  const primary = candidate.elements[0];
  if (!primary) {
    return "";
  }

  if (candidate.fieldType === "text" || candidate.fieldType === "textarea") {
    return (primary.value || "").trim();
  }

  if (candidate.fieldType === "select") {
    return (primary.value || "").trim();
  }

  if (candidate.fieldType === "radio") {
    const selected = candidate.elements.find((input) => input.checked);
    return selected ? selected.value : "";
  }

  if (candidate.fieldType === "checkbox") {
    const checked = candidate.elements.filter((input) => input.checked).map((input) => input.value || "true");
    return checked;
  }

  return "";
}

function isCandidateFilled(candidate) {
  const value = getCurrentCandidateValue(candidate);
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(String(value || "").trim());
}

function highlightCandidate(candidate) {
  for (const element of candidate.elements) {
    element.classList.add("job-copilot-low-confidence");
  }
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
      width: 340px;
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
    `deterministic filled: ${summary.filledRuleCount}`,
    `ai filled: ${summary.filledAiCount}`,
    `total filled: ${summary.filledCount}`,
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

function extractJobDescriptionText() {
  const selectors = [
    ".opening",
    ".job-post",
    ".job-description",
    "[data-qa='job-description']",
    "#content"
  ];

  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const text = (node?.innerText || "").trim();
    if (text.length > 400) {
      return text.slice(0, 12000);
    }
  }

  return (document.body?.innerText || "").slice(0, 12000);
}

function extractJobTitle() {
  const explicit = document.querySelector("h1");
  if (explicit?.textContent) {
    return explicit.textContent.trim();
  }
  return (document.title || "").split("|")[0].trim();
}

function extractCompanyName() {
  const title = document.title || "";
  const parts = title.split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    return parts[parts.length - 1];
  }
  return "";
}

async function fetchProfile(apiBaseUrl) {
  const response = await fetch(`${apiBaseUrl}/profile`);
  if (!response.ok) {
    throw new Error(`Profile fetch failed (${response.status})`);
  }
  return response.json();
}

async function fetchAiAnswers(apiBaseUrl, payload) {
  const response = await fetch(`${apiBaseUrl}/ai/answer-fields`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`AI answer request failed (${response.status})`);
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
    return extractFieldCandidates();
  },

  map_fields(candidate) {
    const haystack = normalize(`${candidate.labelText} ${candidate.id}`);
    return mapFieldFromText(haystack);
  },

  fill(candidate, value) {
    return fillCandidate(candidate, value);
  },

  upload_resume() {
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
  const handledIds = new Set();
  const blockedForAiIds = new Set();

  for (const field of fields) {
    const match = adapter.map_fields(field);
    if (!match) {
      continue;
    }

    if (match.confidence < LOW_CONFIDENCE_THRESHOLD) {
      blockedForAiIds.add(field.id);
      highlightCandidate(field);
      lowConfidence.push({ key: match.key, label: match.labelText, confidence: match.confidence });
      skipped.push({ key: match.key, reason: "low-confidence-rule" });
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
      handledIds.add(field.id);
      filled.push({ key: match.key, source: "rule" });
    } else {
      if (fillResult.status === "already-populated" || fillResult.status === "not-editable") {
        handledIds.add(field.id);
      }
      skipped.push({ key: match.key, reason: fillResult.status });
    }
  }

  const aiCandidates = fields.filter(
    (field) => !handledIds.has(field.id) && !blockedForAiIds.has(field.id) && !isCandidateFilled(field)
  );
  let aiResult = { answers: [], used_llm: false, model: "", message: "" };

  if (aiCandidates.length > 0) {
    const payload = {
      site: adapter.id,
      job_url: window.location.href,
      job_title: extractJobTitle(),
      company: extractCompanyName(),
      job_description: extractJobDescriptionText(),
      fields: aiCandidates.map((field) => ({
        field_id: field.id,
        label: field.labelText,
        field_type: field.fieldType,
        required: field.required,
        options: field.options,
        current_value: getCurrentCandidateValue(field)
      }))
    };

    try {
      aiResult = await fetchAiAnswers(apiBaseUrl, payload);
    } catch (error) {
      skipped.push({ key: "ai", reason: `ai-request-failed:${error.message || String(error)}` });
    }
  }

  const aiAnswerMap = new Map((aiResult.answers || []).map((answer) => [answer.field_id, answer]));

  for (const field of aiCandidates) {
    const answer = aiAnswerMap.get(field.id);
    if (!answer) {
      continue;
    }

    const confidence = Number(answer.confidence || 0);
    if (confidence < AI_FILL_CONFIDENCE_THRESHOLD) {
      highlightCandidate(field);
      lowConfidence.push({ key: field.id, label: field.labelText, confidence });
      skipped.push({ key: field.id, reason: "low-confidence-ai" });
      continue;
    }

    const fillResult = adapter.fill(field, answer.value);
    if (fillResult.status === "filled") {
      filled.push({ key: field.id, source: "ai" });
    } else {
      skipped.push({ key: field.id, reason: `ai-${fillResult.status}` });
    }
  }

  const filledRuleCount = filled.filter((item) => item.source === "rule").length;
  const filledAiCount = filled.filter((item) => item.source === "ai").length;

  const summary = {
    ok: true,
    site: adapter.id,
    filledRuleCount,
    filledAiCount,
    filledCount: filled.length,
    skippedCount: skipped.length,
    lowConfidenceCount: lowConfidence.length,
    missingValues: Array.from(new Set(missingValues)),
    message: "Autofill complete. Review all fields before submitting.",
    aiMessage: aiResult.message || ""
  };

  renderSummary(summary);

  await emitAudit(apiBaseUrl, {
    site: adapter.id,
    job_url: window.location.href,
    filled_fields: filled.map((item) => `${item.key}:${item.source}`),
    skipped_fields: skipped.map((item) => `${item.key}:${item.reason}`),
    metadata: {
      filled_count: summary.filledCount,
      filled_rule_count: summary.filledRuleCount,
      filled_ai_count: summary.filledAiCount,
      skipped_count: summary.skippedCount,
      low_confidence_count: summary.lowConfidenceCount,
      ai_used: Boolean(aiResult.used_llm),
      ai_model: aiResult.model || "",
      ai_message: summary.aiMessage
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
