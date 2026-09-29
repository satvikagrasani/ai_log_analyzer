const analyzeBtn = document.getElementById('analyze-btn');
const logInput = document.getElementById('log-input');
const statusText = document.getElementById('status-text');
const resultPanel = document.getElementById('result-panel');
const resultContent = document.getElementById('result-content');
const fileInput = document.getElementById('log-file');
const fileName = document.getElementById('file-name');
const MAX_FILE_BYTES = 90 * 1024; // stay under express.json's 100kb default

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;

  if (file.size > MAX_FILE_BYTES) {
    statusText.textContent = `File too large (${Math.round(file.size / 1024)}kb). Max is 90kb.`;
    fileInput.value = '';
    return;
  }

  logInput.value = await file.text();
  fileName.textContent = `${file.name} loaded`;
  statusText.textContent = '';
  fileInput.value = ''; // allow re-selecting the same file
});

analyzeBtn.addEventListener('click', async () => {
  const logs = logInput.value.trim();

  if (!logs) {
    statusText.textContent = 'Paste or upload some logs before analyzing.';
    return;
  }

  statusText.textContent = 'Analyzing...';
  analyzeBtn.disabled = true;

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs })
    });
    const data = await res.json();

    resultPanel.hidden = false;
    renderResult(data);

    await new Promise((resolve) => setTimeout(resolve, 700)); // simulated delay
    statusText.textContent = '';
  } catch (err) {
    statusText.textContent = `Request failed: ${err.message}`;
  } finally {
    analyzeBtn.disabled = false;
  }
});

// Build DOM nodes with textContent only, never innerHTML: model output is untrusted.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(title, ...children) {
  const wrap = el('div', 'report__section');
  wrap.append(el('h3', 'report__heading', title), ...children);
  return wrap;
}

function renderResult(data) {
  resultContent.replaceChildren();

  if (data.error) {
    const err = el('div', 'report__error', data.error);
    if (data.details) err.append(el('div', 'report__muted', data.details));
    resultContent.append(err);
    if (data.guardrail) resultContent.append(guardrailSection(data.guardrail));
    if (data.raw) resultContent.append(rawToggle(data.raw));
    return;
  }

  const severity = String(data.severity || 'UNKNOWN').toUpperCase();
  const head = el('div', 'report__head');
  head.append(
    el('span', `severity severity--${severity.toLowerCase()}`, severity),
    el('p', 'report__summary', data.summary || '')
  );
  resultContent.append(head);

  if (data.possibleRootCause) {
    resultContent.append(section('ROOT CAUSE', el('p', 'report__root', data.possibleRootCause)));
  }

  if (Array.isArray(data.causalChain) && data.causalChain.length) {
    const list = el('ol', 'chain');
    for (const step of data.causalChain) {
      const stage = String(step.stage || '').toLowerCase();
      const item = el('li', `chain__step chain__step--${stage.replace(/\s+/g, '-')}`);
      const meta = el('div', 'chain__meta');
      meta.append(el('span', 'chain__stage', stage || 'step'), el('span', 'chain__service', step.service || ''));
      item.append(meta, el('p', 'chain__event', step.event || ''));
      list.append(item);
    }
    resultContent.append(section('CAUSAL CHAIN', list));
  }

  if (Array.isArray(data.recommendations) && data.recommendations.length) {
    const list = el('ol', 'report__list');
    data.recommendations.forEach((r) => list.append(el('li', '', r)));
    resultContent.append(section('RECOMMENDATIONS', list));
  }

  if (Array.isArray(data.evidence) && data.evidence.length) {
    const list = el('div', 'evidence');
    data.evidence.forEach((line) => list.append(el('code', 'evidence__line', line)));
    resultContent.append(section('EVIDENCE', list));
  }

  if (data.guardrail) resultContent.append(guardrailSection(data.guardrail));

  resultContent.append(rawToggle(JSON.stringify(data, null, 2)));
}

// Groups findings like "EMAIL ×2 · masked" for the input and output checks
function guardrailSection({ input = [], output = [] }) {
  const wrap = el('div', 'guardrail');
  for (const [label, findings] of [['INPUT', input], ['OUTPUT', output]]) {
    const row = el('div', 'guardrail__row');
    row.append(el('span', 'guardrail__label', label));

    const counts = new Map();
    for (const f of findings) {
      const key = `${f.kind}|${f.action}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    if (!counts.size) {
      row.append(el('span', 'guardrail__clean', 'clean'));
    }
    for (const [key, n] of counts) {
      const [kind, action] = key.split('|');
      const verb = action === 'BLOCKED' ? 'blocked' : action === 'ANONYMIZED' ? 'masked' : String(action).toLowerCase();
      const tag = el('span', `guardrail__tag guardrail__tag--${verb}`, `${kind}${n > 1 ? ` ×${n}` : ''} · ${verb}`);
      row.append(tag);
    }
    wrap.append(row);
  }
  return section('GUARDRAIL', wrap);
}

function rawToggle(text) {
  const details = el('details', 'report__raw');
  details.append(el('summary', '', 'RAW JSON'), el('pre', '', text));
  return details;
}
