const analyzeBtn = document.getElementById('analyze-btn');
const logInput = document.getElementById('log-input');
const statusText = document.getElementById('status-text');
const resultPanel = document.getElementById('result-panel');
const resultContent = document.getElementById('result-content');

analyzeBtn.addEventListener('click', async () => {
  const logs = logInput.value.trim();

  if (!logs) {
    statusText.textContent = 'Paste some logs before analyzing.';
    return;
  }

  statusText.textContent = 'Analyzing...';
  analyzeBtn.disabled = true;

  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logs })
  });
  const data = await res.json();

  resultPanel.hidden = false;
  resultContent.textContent = JSON.stringify(data, null, 2);

  await new Promise((resolve) => setTimeout(resolve, 700)); // simulated delay

  statusText.textContent = '';
  analyzeBtn.disabled = false;
});
