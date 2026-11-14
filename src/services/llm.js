// Thin provider wrapper. Used by (a) the LLM relevance judge and (b) the demo agents' reply drafting.
const config = require('../config');

async function chat({ system, user, json = false, maxTokens = 600 }) {
  if (config.llmProvider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openaiKey}` },
      body: JSON.stringify({
        model: config.openaiChatModel,
        temperature: 0.2,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI chat ${res.status}: ${await res.text()}`);
    return (await res.json()).choices[0].message.content;
  }
  if (config.llmProvider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    return (await res.json()).content.map((b) => b.text || '').join('');
  }
  throw new Error('LLM_PROVIDER is mock; no remote LLM available');
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text);
}

module.exports = { chat, extractJson, enabled: () => config.llmProvider !== 'mock' };
