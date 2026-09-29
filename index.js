require('dotenv').config();
const { BedrockRuntimeClient, InvokeModelCommand, ApplyGuardrailCommand } = require('@aws-sdk/client-bedrock-runtime');
const express = require("express");

const app = express();
const PORT = 3000;
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

const SYSTEM_PROMPT = `You are an incident log analyzer. Identify the most likely ROOT CAUSE of the primary business failure in the logs the user sends.

If the logs show no significant incident, set severity to LOW and say so in the summary. Otherwise set severity to MEDIUM, HIGH, or CRITICAL based on the impact shown in the logs.

Rules:
1. Trace events chronologically. Separate root cause, intermediate failures, and the final user-facing error, naming the service for each.
2. Not every ERROR/WARN is related. Ignore unrelated noise.
3. Only claim causes the logs support. If unclear, say "uncertain". Separate facts from inferences.
4. The root cause is the earliest event that explains the others. Ask "why did this happen?" of each failure until the logs stop answering. Resource exhaustion (pools, memory, threads) is usually a symptom: look for what consumed the resource.
5. Recommendations must fix the root cause first. Don't suggest raising timeouts or limits unless the logs show the limit itself is wrong.
6. evidence: at most 5 exact log lines, only those in the causal chain.
7. Values like {EMAIL} or {IP_ADDRESS} were redacted before you saw the logs. Treat them as placeholders and don't guess the original values.
8. Return ONLY the JSON object. No code fences or extra text.

Required JSON shape (fields in this order):
{
  "severity": "LOW | MEDIUM | HIGH | CRITICAL",
  "summary": "one or two sentence plain-text summary",
  "causalChain": [
    { "stage": "root cause | intermediate | final error", "service": "service name", "event": "what happened, citing the log line" }
  ],
  "evidence": ["exact log line", "..."],
  "possibleRootCause": "the earliest event in causalChain that explains the rest, or \"uncertain\"",
  "recommendations": ["..."]
}`;

// Runs the Bedrock Guardrail over text. Returns the (possibly masked) text and
// what the guardrail found. Only the finding types go to the client, never the
// matched values, since those are the sensitive data being masked.
async function applyGuardrail(text, source) {
  if (!process.env.GUARDRAIL_ID) {
    console.log(`Guardrail ${source}: skipped (GUARDRAIL_ID not set)`);
    return { blocked: false, text, findings: [] };
  }

  const version = process.env.GUARDRAIL_VERSION || 'DRAFT';
  const res = await bedrock.send(new ApplyGuardrailCommand({
    guardrailIdentifier: process.env.GUARDRAIL_ID,
    guardrailVersion: version,
    source, // 'INPUT' or 'OUTPUT'
    content: [{ text: { text } }]
  }));

  const findings = [];
  for (const a of res.assessments ?? []) {
    for (const e of a.sensitiveInformationPolicy?.piiEntities ?? []) findings.push({ kind: e.type, action: e.action });
    for (const r of a.sensitiveInformationPolicy?.regexes ?? []) findings.push({ kind: r.name, action: r.action });
    for (const f of a.contentPolicy?.filters ?? []) findings.push({ kind: f.type, action: f.action });
    for (const t of a.topicPolicy?.topics ?? []) findings.push({ kind: t.name, action: t.action });
    for (const w of a.wordPolicy?.customWords ?? []) findings.push({ kind: 'CUSTOM_WORD', action: w.action });
    for (const w of a.wordPolicy?.managedWordLists ?? []) findings.push({ kind: w.type, action: w.action });
  }

  // GUARDRAIL_INTERVENED also covers masking, so only a BLOCKED finding stops the request
  const blocked = findings.some((f) => f.action === 'BLOCKED');
  const intervened = res.action === 'GUARDRAIL_INTERVENED';

  // Policies with billed units > 0 are the ones that actually evaluated this text
  const policies = Object.entries(res.usage ?? {})
    .filter(([key, units]) => units > 0 && !key.endsWith('FreeUnits'))
    .map(([key]) => key.replace(/PolicyUnits$/, ''));
  console.log(`Guardrail ${source}:`, {
    guardrail: `${process.env.GUARDRAIL_ID}:${version}`,
    action: res.action,
    policiesEvaluated: policies,
    findings: findings.map((f) => `${f.kind}:${f.action}`)
  });

  return { blocked, text: intervened ? res.outputs?.[0]?.text ?? text : text, findings };
}

app.use(express.static("public"));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.post('/api/analyze', async (req, res) => {
  const { logs } = req.body;

  if (!logs) {
    return res.status(400).json({ error: 'logs field is required' });
  }

  try {
    const input = await applyGuardrail(logs, 'INPUT');
    if (input.blocked) {
      return res.status(422).json({ error: 'Logs blocked by guardrail', guardrail: { input: input.findings, output: [] } });
    }

    const command = new InvokeModelCommand({
      modelId: 'amazon.nova-lite-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text: `LOGS:\n${input.text}` }] }],
        inferenceConfig: { maxTokens: 1200, temperature: 0.2 }
      })
    });

    const response = await bedrock.send(command);
    const raw = JSON.parse(new TextDecoder().decode(response.body));
    console.log('Token usage:', raw.usage);
    let modelText = raw.output.message.content[0].text;

    // Strip markdown code fences if present
    modelText = modelText.trim();
    if (modelText.startsWith('```')) {
      modelText = modelText.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
    }

    const output = await applyGuardrail(modelText, 'OUTPUT');
    const guardrail = { input: input.findings, output: output.findings };
    if (output.blocked) {
      return res.status(422).json({ error: 'Analysis blocked by guardrail', guardrail });
    }

    let parsed;
    try {
      parsed = JSON.parse(output.text);
    } catch (parseErr) {
      console.error('Model did not return clean JSON:', output.text);
      return res.status(502).json({ error: 'Model response was not valid JSON', raw: output.text });
    }

    if (process.env.GUARDRAIL_ID) parsed.guardrail = guardrail;
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Analysis failed', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});