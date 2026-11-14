const config = require('../config');
const { tokenize, conceptsOf } = require('./concepts');

function fnv1a(str, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function normalize(v) {
  let n = 0; for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

// Offline embedder: signed feature hashing of tokens + bigrams + domain-concept features.
// Not as good as a neural model, but deterministic, free and "semantic enough" for the demo.
function mockEmbed(text, dim = config.embedDim) {
  const v = new Array(dim).fill(0);
  const add = (feat, w) => {
    const h = fnv1a(feat);
    const sign = fnv1a(feat, 99991) & 1 ? 1 : -1;
    v[h % dim] += sign * w;
  };
  const toks = tokenize(text);
  toks.forEach((t) => add('t:' + t, 1));
  for (let i = 0; i < toks.length - 1; i++) add('b:' + toks[i] + '_' + toks[i + 1], 0.4);
  conceptsOf(text).forEach((c) => add('c:' + c, 3));
  return normalize(v);
}

async function openaiEmbed(text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openaiKey}` },
    body: JSON.stringify({ model: config.openaiEmbedModel, input: text.slice(0, 8000), dimensions: config.embedDim }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return normalize(data.data[0].embedding);
}

async function embed(text) {
  if (config.embeddingProvider === 'openai') {
    try { return await openaiEmbed(text); }
    catch (e) { console.error('[embed] openai failed, falling back to local:', e.message); }
  }
  return mockEmbed(text);
}

module.exports = { embed, mockEmbed, normalize };
