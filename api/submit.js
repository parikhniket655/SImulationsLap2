/**
 * POST /api/submit
 * Body: { email, name, answers, crises, meters, log, startTime, endTime, timeTakenSeconds }
 *
 * Scoring Engine matching the official COTY 2027 Answer Key:
 * - 8 questions at 8 marks each = 64 marks
 * - 8 crisis twists at 3 / 1 / 0 marks = 24 marks
 * Total Auto Score = 88 marks
 * - Speed bonus (up to 1 mark for tie-breaks): 1 - time / 900
 * Saves full submission to Supabase.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---------------------------------------------------------------------------
// OFFICIAL ANSWER KEY & SCORING LOGIC
// ---------------------------------------------------------------------------

/**
 * Q1 (8 marks) — MCQ: Best supported conclusion
 * Correct: B (index 1) — IndiGo leads share & punctuality, yet ended in loss.
 */
function scoreQ1(v) {
  return v === 1 ? 8 : 0;
}

/**
 * Q2 (8 marks) — Numeric: % change in RASK (FY25 to FY26)
 * (4.80 - 5.00) / 5.00 = -0.04 (-4%). Accept 3.8 to 4.2 fall (or -4.2 to -3.8).
 */
function scoreQ2(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  // Accept negative or positive if candidate forgot minus sign
  if ((n >= -4.2 && n <= -3.8) || (n >= 3.8 && n <= 4.2)) return 8;
  return 0;
}

/**
 * Q3 (8 marks) — Numeric: Extra fuel cost in ₹ crore
 * 1.10 * 175 billion = 192.5 billion = ₹19,250 crore.
 * Accept ±1.5% (18,960 to 19,540 crore).
 */
function scoreQ3(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  if (n >= 18960 && n <= 19540) return 8;
  return 0;
}

/**
 * Q4 (8 marks) — Balanced allocation of ₹1,000 crore across 5 projects
 * Formula: 8 * (sum of share * project weight) - max(0, largest share - 0.40)
 * Projects: [0]=Crew (1.0), [1]=Maintenance (0.9), [2]=Fuel (0.7), [3]=App (0.8), [4]=Loyalty (0.4)
 */
function scoreQ4(v) {
  if (!Array.isArray(v) || v.length < 5) return 0;
  const num = v.map(x => Math.max(0, parseFloat(x) || 0));
  const total = num.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1000) > 1) return 0; // must total 1,000 crore

  const weights = [1.0, 0.9, 0.7, 0.8, 0.4];
  let weightedSum = 0;
  let maxShare = 0;

  for (let i = 0; i < 5; i++) {
    const share = num[i] / 1000;
    weightedSum += share * weights[i];
    if (share > maxShare) maxShare = share;
  }

  const penalty = Math.max(0, maxShare - 0.40);
  const score = 8 * weightedSum - penalty;
  return Math.max(0, Math.min(8, Math.round(score * 100) / 100));
}

/**
 * Q5 (8 marks) — Numeric: % volume increase needed if Route A fare cut 10%
 * New fare ₹4,500, contribution ₹500. Old contribution ₹1,000 / ₹500 = 2.0 (+100%).
 * Accept 98 to 102.
 */
function scoreQ5(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  if (n >= 98 && n <= 102) return 8;
  return 0;
}

/**
 * Q6 (8 marks) — Pick 2 non-fare retention actions
 * Options: 0=Rebooking (3), 1=Honest msgs (3), 2=Corporate (2), 3=15% cut (0), 4=Ads cheapest (0), 5=Legroom (1)
 * Marks = sum of weights * 4/3, capped at 8.
 */
function scoreQ6(v) {
  if (!Array.isArray(v) || v.length !== 2) return 0;
  const weights = { 0: 3, 1: 3, 2: 2, 3: 0, 4: 0, 5: 1 };
  const sumWeights = (weights[v[0]] || 0) + (weights[v[1]] || 0);
  const score = Math.min(8, sumWeights * (4 / 3));
  return Math.round(score * 100) / 100;
}

/**
 * Q7 (8 marks) — Numeric: % pilot pool must grow (100 -> 80 hours)
 * 100 / 80 = 1.25 (+25%).
 * Accept 24 to 26.
 */
function scoreQ7(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  if (n >= 24 && n <= 26) return 8;
  return 0;
}

/**
 * Q8 (8 marks) — MCQ: Strongest 12-month strategy
 * Correct: B (index 1) — Protect trust and reliability first.
 */
function scoreQ8(v) {
  return v === 1 ? 8 : 0;
}

/**
 * Crisis twists (8 twists * 3 marks = 24 marks total)
 * Scoring matrix per twist (options 0 / 1 / 2):
 * Twist 1: [0, 3, 1]
 * Twist 2: [1, 3, 1]
 * Twist 3: [3, 1, 0]
 * Twist 4: [3, 0, 1]
 * Twist 5: [3, 0, 1]
 * Twist 6: [3, 0, 1]
 * Twist 7: [3, 0, 1]
 * Twist 8: [3, 0, 1]
 */
const CRISIS_SCORES = [
  [0, 3, 1], // Twist 1: Trim off-peak capacity (opt 1) = 3
  [1, 3, 1], // Twist 2: Yield target route growth (opt 1) = 3
  [3, 1, 0], // Twist 3: Hedge about half staged (opt 0) = 3
  [3, 0, 1], // Twist 4: Delay loyalty upgrade (opt 0) = 3
  [3, 0, 1], // Twist 5: Targeted offers for sensitive segments (opt 0) = 3
  [3, 0, 1], // Twist 6: Run honest context (opt 0) = 3
  [3, 0, 1], // Twist 7: Refuse & trim schedule (opt 0) = 3
  [3, 0, 1], // Twist 8: Evidence pack on crew rest (opt 0) = 3
];

function scoreCrises(crises) {
  if (!crises || typeof crises !== 'object') return 0;
  let total = 0;
  for (let i = 0; i < 8; i++) {
    const chosen = crises[`tw${i + 1}`];
    if (chosen !== undefined && CRISIS_SCORES[i][chosen] !== undefined) {
      total += CRISIS_SCORES[i][chosen];
    }
  }
  return total;
}

function autoScore(answers, crises, timeTakenSeconds) {
  const a = answers || {};
  const q1 = scoreQ1(a.q1);
  const q2 = scoreQ2(a.q2);
  const q3 = scoreQ3(a.q3);
  const q4 = scoreQ4(a.q4);
  const q5 = scoreQ5(a.q5);
  const q6 = scoreQ6(a.q6);
  const q7 = scoreQ7(a.q7);
  const q8 = scoreQ8(a.q8);
  const twistScore = scoreCrises(crises);

  const questionTotal = q1 + q2 + q3 + q4 + q5 + q6 + q7 + q8;
  const rawAuto = questionTotal + twistScore; // out of 88

  // Speed tie-breaker point (up to 1 point): 1 - time / 900
  const speedPoint = timeTakenSeconds ? Math.max(0, Math.min(1, 1 - (timeTakenSeconds / 900))) : 0;
  const roundedAuto = Math.round((rawAuto + speedPoint) * 100) / 100;

  const breakdown = {
    q1, q2, q3, q4, q5, q6, q7, q8,
    questionsSum: questionTotal,
    twistScore,
    speedPoint: Math.round(speedPoint * 100) / 100,
  };

  return { total: roundedAuto, breakdown };
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

    // Auto-score according to official COTY key
    const { total: auto_score, breakdown } = autoScore(answers, crises, timeTakenSeconds);

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
      const { error } = await supabase
        .from('submissions')
        .update(payload)
        .eq('email', normalEmail);
      dbError = error;
    } else {
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
