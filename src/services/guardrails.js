// Input guardrails for posts & comments. Layered: (1) cheap regex rules here,
// (2) optional Llama-Guard-style model in production, (3) strict data/prompt separation on the receiving side.
const INJECTION_PATTERNS = [
  [/ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i, 'instruction-override'],
  [/disregard\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|your)\s+(instructions?|rules?|guidelines?)/i, 'instruction-override'],
  [/(reveal|print|output|show|leak|send|exfiltrate)\b[^.]{0,40}\b(system\s*prompt|api[\s_-]?keys?|secrets?|passwords?|credentials?|tokens?)/i, 'secret-exfiltration'],
  [/\b(system\s*prompt|developer\s*message)\b/i, 'prompt-probing'],
  [/you\s+are\s+now\s+(a|an|the|in)\b/i, 'role-hijack'],
  [/<\|?(im_start|im_end|system|assistant)\|?>/i, 'chat-template-injection'],
  [/\b(transfer|wire|send)\s+(all\s+)?(funds|money|₹|rs\.?|inr)\b/i, 'financial-action-request'],
];

function checkContent(text) {
  const reasons = [];
  for (const [re, label] of INJECTION_PATTERNS) if (re.test(text)) reasons.push(label);
  const urls = (text.match(/https?:\/\/\S+/gi) || []).length;
  if (urls > 3) reasons.push('too-many-links');
  if (/[A-Za-z0-9+/]{200,}={0,2}/.test(text)) reasons.push('encoded-blob');
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

module.exports = { checkContent };
