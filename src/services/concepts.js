// A small domain lexicon used by the offline ("mock") embedder and reranker so the project works
// with ZERO API keys. In production with real embeddings this file is only used for the
// human-readable "why was this routed?" explanation.
const LEXICON = {
  promo: 'discount off offer cashback deal sale coupon promo promotion voucher reward saving flat bonus',
  festive: 'diwali festive festival holi eid christmas navratri dussehra season celebration onam pongal',
  food_delivery: 'food delivery deliver restaurant swiggy zomato meal dining grocery instamart takeaway',
  payments: 'payment pay upi card wallet phonepe paytm gpay checkout transaction merchant bnpl cashless',
  banking: 'bank banking loan credit debit hdfc emi financing finance mortgage insurance lending interest',
  ecommerce: 'ecommerce e-commerce shopping retail flipkart marketplace seller product catalog cart',
  automotive: 'bike motorcycle scooter vehicle car auto ev electric dealer dealership showroom bajaj two-wheeler mileage pulsar',
  logistics: 'shipping logistics supply courier warehouse fulfilment fulfillment',
  travel: 'flight hotel travel trip booking airline tourism',
  markets: 'market stock sensex nifty rbi rate inflation forex economy repo',
};

const STOP = new Set('a an the and or of to in on for with at by from is are was were be been this that it its as we you our your will all any'.split(' '));

function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [])
    .map(stem)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

const WORD_TO_CONCEPTS = new Map();
for (const [concept, words] of Object.entries(LEXICON)) {
  for (const w of words.split(' ')) {
    const s = stem(w);
    if (!WORD_TO_CONCEPTS.has(s)) WORD_TO_CONCEPTS.set(s, new Set());
    WORD_TO_CONCEPTS.get(s).add(concept);
  }
}

function conceptsOf(text) {
  const out = new Set();
  for (const t of tokenize(text)) {
    const c = WORD_TO_CONCEPTS.get(t);
    if (c) c.forEach((x) => out.add(x));
  }
  return out;
}

module.exports = { tokenize, conceptsOf, LEXICON };
