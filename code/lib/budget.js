'use strict';
/**
 * QUARRY lib/budget.js — price table and budget guard for the Muse stages.
 *
 * Mirrors PROVIDER_CONFIG / MODEL_PRICES in tagger.js. The two are kept in sync by hand until
 * tagger.js is pointed at this file (follow-up): when a rate changes, change both.
 *
 * Unlike tagger.js, checkBudget THROWS BudgetError instead of calling process.exit, so a batch
 * can finish its in-flight work and report cleanly.
 */
const BUDGET_CEILING = parseFloat(process.env.BUDGET_CEILING_USD || '10.00');

const PROVIDER_CONFIG = {
  grok:       { costPerMillionIn: 2.00,  costPerMillionOut: 6.00,  budgetEstimate: 0.02  },
  gemini:     { costPerMillionIn: 1.25, costPerMillionOut: 10.00,  budgetEstimate: 0.003 },
  claude:     { costPerMillionIn: 3.00,  costPerMillionOut: 15.00, budgetEstimate: 0.02  },
  openrouter: { costPerMillionIn: 0,     costPerMillionOut: 0,     budgetEstimate: 0     },
};
const MODEL_PRICES = {
  grok: [
    { match: /^grok-4\.(6|7)\b/, in: 2.00, out: 6.00 },
    { match: /^grok-4\.3\b|^grok-4\.20|^grok-4$/, in: 1.25, out: 2.50 },
  ],
  gemini: [
    // Order matters: the first match wins, so flash-lite must precede flash.
    // flash: $0.30 / $2.50 per M. Checked 2026-10-27 against the Google bill (INR 3.73K over Oct 22-27 at about INR 95/USD = about $39,
    // list-price recompute of the recorded tokens = $43.7; billing lags by hours). The old $0.075 / $0.30 under-recorded spend about 6x.
    // lite and pro are published list prices (2025), not re-checked against a bill; re-verify when the resolver moves to them.
    { match: /^gemini-2\.5-flash-lite\b/, in: 0.10, out: 0.40 },
    { match: /^gemini-2\.5-flash\b/,      in: 0.30, out: 2.50 },
    { match: /^gemini-2\.5-pro\b/,        in: 1.25, out: 10.00 },
  ],
};
const LONG_CONTEXT_TOKENS = { grok: 200000 };

class BudgetError extends Error {
  constructor(msg) { super(msg); this.name = 'BudgetError'; }
}

function priceFor(provider, model, tokIn) {
  const cfg = PROVIDER_CONFIG[provider];
  if (!cfg) return null;
  let rate = { in: cfg.costPerMillionIn, out: cfg.costPerMillionOut, known: !MODEL_PRICES[provider] };
  const table = MODEL_PRICES[provider];
  if (table && model) {
    const hit = table.find(function (r) { return r.match.test(model); });
    if (hit) rate = { in: hit.in, out: hit.out, known: true };
  }
  if (LONG_CONTEXT_TOKENS[provider] && tokIn >= LONG_CONTEXT_TOKENS[provider]) rate = { in: rate.in * 2, out: rate.out * 2, known: rate.known };
  return rate;
}

function spentToDate(db) {
  return db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS t FROM api_budget').get().t;
}

function checkBudget(db, provider, ceiling) {
  const cap = ceiling == null ? BUDGET_CEILING : ceiling;
  const spent = spentToDate(db);
  const cfg = PROVIDER_CONFIG[provider];
  const est = cfg ? cfg.budgetEstimate : 0.005;
  if (spent + est > cap) throw new BudgetError('Budget ceiling reached: spent $' + spent.toFixed(4) + ' of $' + cap.toFixed(2));
}

function recordSpend(db, provider, component, noteId, tokIn, tokOut, model, warn) {
  const rate = priceFor(provider, model, tokIn || 0);
  const cost = rate ? ((tokIn || 0) * rate.in / 1e6) + ((tokOut || 0) * rate.out / 1e6) : 0;
  if (warn) {
    if (!rate) warn('recordSpend: unknown provider, recorded as $0', { provider: provider });
    else if (!rate.known) warn('recordSpend: no price for this model, charged at the highest known rate', { provider: provider, model: model });
  }
  db.prepare('INSERT INTO api_budget (provider,component,note_id,tokens_in,tokens_out,cost_usd,called_at) VALUES (?,?,?,?,?,?,?)')
    .run(provider, component, noteId || null, tokIn || 0, tokOut || 0, cost, new Date().toISOString());
  return cost;
}

module.exports = { BUDGET_CEILING, PROVIDER_CONFIG, BudgetError, priceFor, spentToDate, checkBudget, recordSpend };
