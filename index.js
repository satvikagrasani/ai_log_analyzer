require('dotenv').config();
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const express = require("express");

const app = express();
const PORT = 3000;
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

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

  const prompt = `You are an incident log analyzer.

    Analyze the incident logs below and identify the most likely ROOT CAUSE of the primary business failure.

    Prerequisites:
    1. If the entered log is not log worthy, return a JSON object with severity set to LOW and a summary stating that the logs do not indicate a significant incident.
    2. If the logs indicate a significant incident, return a JSON object with severity set to MEDIUM, HIGH, or CRITICAL based on the impact of the incident. 

    Important instructions:
    1. Do not assume that every ERROR or WARN line is related to the incident.
    2. Distinguish the root cause from downstream symptoms and unrelated errors.
    3. Trace the sequence of events chronologically before deciding the root cause.
    4. Use specific log lines as evidence.
    5. Do not recommend increasing timeouts unless the logs provide a clear reason that the timeout configuration itself is the problem.
    6. Recommendations should address the likely root cause, not just the final error.
    7. If the root cause is uncertain, say so rather than inventing one.
    8. Severity should reflect the impact shown in the logs.
    9. Return ONLY valid JSON matching the exact structure below — no markdown code fences (no \`\`\`), no explanations, no text before or after the JSON object.
    10. Clearly distinguish observed facts from assumptions or inferences.
    11. Do not claim a specific underlying cause (such as network issues, database issues, or service degradation) unless supported by the logs.
    12. Evidence must explain the causal chain, not merely list error messages.
    13. For each important failure, identify the service that generated it.
    14. Distinguish root cause, intermediate failure, and final propagated error.
    15. Recommendations must address the underlying cause before suggesting configuration changes.
    16. Do not recommend increasing resource limits unless the logs provide evidence that the limit itself is insufficient.
    17. Where possible, explain how the root cause propagated to the final HTTP error.

    Required JSON shape (evidence must be an array of plain strings, each string an exact log line — not objects):
    {
      "severity": "LOW | MEDIUM | HIGH | CRITICAL",
      "summary": "one or two sentence plain-text summary",
      "possibleRootCause": "plain-text explanation, or \\"uncertain\\" if the logs don't clearly support one",
      "evidence": ["exact log line 1", "exact log line 2"],
      "recommendations": ["recommendation 1", "recommendation 2"]
    }

    LOGS:
${logs}`;

  try {
    const command = new InvokeModelCommand({
      modelId: 'amazon.nova-lite-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 800, temperature: 0.2 }
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

    let parsed;
    try {
      parsed = JSON.parse(modelText);
    } catch (parseErr) {
      console.error('Model did not return clean JSON:', modelText);
      return res.status(502).json({ error: 'Model response was not valid JSON', raw: modelText });
    }

    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Analysis failed', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
