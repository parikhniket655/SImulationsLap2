/**
 * POST /api/submit
 * Body: { email, name, answers, crises, meters, log, startTime, endTime, timeTakenSeconds }
 *
 * Auto-scores objective questions Q1–Q8 + crisis choices.
 * Saves full submission to Supabase.
 * Returns { ok: true, autoScore, totalScore }
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---------------------------------------------------------------------------
// SCORING ENGINE
// All correct answers are defined here; change as needed before each event.
// ---------------------------------------------------------------------------

/**
 * Q1 (8 marks) — MCQ: Which conclusion is best supported by Exhibits 1 & 2?
 * Options: 0=A, 1=B, 2=C, 3=D
 * Correct: B (index 1) — IndiGo leads share+punctuality but ended in a loss.
 */
function scoreQ1(v) {
  return v === 1 ? 8 : 0;
}

/**
 * Q2 (8 marks) — Numeric: % change in RASK FY25→FY26
 * FY25 RASK = 5.00, FY26 RASK = 4.80
 * % change = (4.80 - 5.00) / 5.00 * 100 = -4%
 * Accept range: -4.5 to -3.5
 */
function scoreQ2(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  return n >= -4.5 && n <= -3.5 ? 8 : n >= -5 && n <= -3 ? 4 : 0;
}

/**
 * Q3 (8 marks) — Numeric: Extra fuel cost in ₹ crore
 * (2.50 - 1.40) * 175 billion ASK = 1.10 * 175 = 192.5 billion ₹ = 19,250 crore
 * Accept range: 18,000 – 21,000 crore
 */
function scoreQ3(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  return n >= 18000 && n <= 21000 ? 8 : n >= 16000 && n <= 23000 ? 4 : 0;
}

/**
 * Q4 (8 marks) — Budget allocation of ₹1,000 crore across 5 projects
 * Scored on: crew resilience ≥ 200, maintenance ≥ 100, low loyalty (<150)
 * This is partially subjective — we reward sensible distributions.
 * Projects: [0]=Crew, [1]=Maintenance, [2]=Fuel, [3]=App, [4]=Loyalty
 */
function scoreQ4(v) {
  if (!Array.isArray(v) || v.length < 5) return 0;
  const [crew, maint, fuel, app, loyalty] = v.map(Number);
  const total = crew + maint + fuel + app + loyalty;
  if (Math.abs(total - 1000) > 1) return 0; // must sum to 1000

  let score = 0;
  if (crew >= 200) score += 3;       // crew resilience is most important
  if (maint >= 100) score += 2;      // maintenance matters
  if (loyalty <= 150) score += 1;    // don't over-invest in loyalty now
  if (app >= 50) score += 1;         // app comms matter
  if (crew + maint >= 400) score += 1; // ops-first mindset
  return Math.min(score, 8);
}

/**
 * Q5 (8 marks) — Numeric: % volume increase needed if Route A fare cut 10%
 * New fare = 5000 * 0.9 = 4500. New contribution = 4500 - 4000 = 500
 * Old contribution per pax = 1000
 * Volume ratio needed = 1000 / 500 = 2x → passengers must rise by 100%
 * Accept: 95% – 105%
 */
function scoreQ5(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  return n >= 95 && n <= 105 ? 8 : n >= 85 && n <= 115 ? 4 : 0;
}

/**
 * Q6 (8 marks) — Pick 2 non-fare customer retention actions
 * Options: 0=priority rebooking, 1=proactive app msg, 2=corporate contracts,
 *          3=15% fare cut (wrong), 4=cheapest ads (wrong), 5=legroom upsell
 * Any 2 of {0,1,2,5} score full marks.
 */
function scoreQ6(v) {
  if (!Array.isArray(v) || v.length !== 2) return 0;
  const good = new Set([0, 1, 2, 5]);
  const correct = v.filter(x => good.has(x)).length;
  return correct === 2 ? 8 : correct === 1 ? 4 : 0;
}

/**
 * Q7 (8 marks) — Numeric: % pilot pool must grow (100→80 hrs rule)
 * Pool needed = old_hrs / new_hrs = 100 / 80 = 1.25x → 25% more
 * Accept: 23% – 27%
 */
function scoreQ7(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  return n >= 23 && n <= 27 ? 8 : n >= 20 && n <= 30 ? 4 : 0;
}

/**
 * Q8 (8 marks) — MCQ: Strongest 12-month Board strategy
 * Options: 0=A (chase volume/deep fares), 1=B (protect trust+reliability) ✓,
 *          2=C (trim maintenance/crew rest), 3=D (pause investment)
 * Correct: B (index 1)
 */
function scoreQ8(v) {
  return v === 1 ? 8 : 0;
}

/**
 * Crisis twist scoring (bonus/penalty applied on top)
 * Best response indices per twist, yielding +4 bonus each.
 * TW0→1, TW1→1, TW2→0, TW3→0, TW4→0, TW5→0, TW6→0, TW7→0
 */
const BEST_CRISIS = [1, 1, 0, 0, 0, 0, 0, 0];

function scoreCrises(crises) {
  if (!crises || typeof crises !== 'object') return 0;
  let bonus = 0;
  BEST_CRISIS.forEach((best, i) => {
    const chosen = crises[`tw${i + 1}`];
    if (chosen !== undefined && chosen === best) bonus += 4;
  });
  return Math.min(bonus, 24); // cap crisis bonus
}

function autoScore(answers, crises) {
  const a = answers || {};
  const q1 = scoreQ1(a.q1);
  const q2 = scoreQ2(a.q2);
  const q3 = scoreQ3(a.q3);
  const q4 = scoreQ4(a.q4);
  const q5 = scoreQ5(a.q5);
  const q6 = scoreQ6(a.q6);
  const q7 = scoreQ7(a.q7);
  const q8 = scoreQ8(a.q8);
  const crisisBonus = scoreCrises(crises);

  const breakdown = { q1, q2, q3, q4, q5, q6, q7, q8, crisisBonus };
  const total = q1 + q2 + q3 + q4 + q5 + q6 + q7 + q8 + crisisBonus;
  return { total, breakdown };
}

// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { email, name, answers, crises, meters, log, startTime, endTime, timeTakenSeconds } = req.body || {};

  if (!email) return res.status(400).json({ ok: false, error: 'Missing email' });

  const normalEmail = email.trim().toLowerCase();
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Check for duplicate complete submission
    const { data: existing } = await supabase
      .from('submissions')
      .select('id, end_time')
      .eq('email', normalEmail)
      .maybeSingle();

    if (existing?.end_time) {
      return res.status(409).json({ ok: false, error: 'Already submitted.' });
    }

    // Score
    const { total: auto_score, breakdown } = autoScore(answers, crises);

    const payload = {
      email: normalEmail,
      name: name || '',
      start_time: startTime || null,
      end_time: endTime || new Date().toISOString(),
      time_taken_seconds: timeTakenSeconds || null,
      answers: answers || {},
      crises: crises || {},
      meters: meters || {},
      auto_score,
      raw_log: log || [],
    };

    let dbError;
    if (existing) {
      // Update the pending row
      const { error } = await supabase
        .from('submissions')
        .update(payload)
        .eq('email', normalEmail);
      dbError = error;
    } else {
      // Insert fresh
      const { error } = await supabase.from('submissions').insert(payload);
      dbError = error;
    }

    if (dbError) throw dbError;

    return res.status(200).json({
      ok: true,
      autoScore: auto_score,
      breakdown,
      message: 'Submission received! Well done, Commander.'
    });
  } catch (err) {
    console.error('[submit]', err);
    return res.status(500).json({ ok: false, error: 'Server error saving submission: ' + (err.message || String(err)) });
  }
}
