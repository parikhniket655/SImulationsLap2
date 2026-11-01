/**
 * /api/admin
 *
 * GET  — returns all submissions as leaderboard JSON
 * PATCH — updates memo_score for a given email
 *
 * Security: requires BOTH
 *   - Query param  ?key=ADMIN_URL_KEY
 *   - Header       x-admin-pass: ADMIN_PASSWORD
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_URL_KEY = process.env.ADMIN_URL_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function authenticate(req) {
  const urlKey = req.query?.key || new URL(req.url, 'http://localhost').searchParams.get('key');
  const passHeader = req.headers['x-admin-pass'];
  return urlKey === ADMIN_URL_KEY && passHeader === ADMIN_PASSWORD;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-pass');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!authenticate(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── GET: fetch all submissions ─────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('submissions')
      .select('id, email, name, start_time, end_time, time_taken_seconds, answers, crises, meters, auto_score, memo_score, total_score, raw_log, created_at')
      .order('total_score', { ascending: false })
      .order('time_taken_seconds', { ascending: true });

    if (error) return res.status(500).json({ ok: false, error: error.message });

    const stats = {
      total: data.length,
      started: data.filter(r => r.start_time).length,
      finished: data.filter(r => r.end_time).length,
    };

    return res.status(200).json({ ok: true, stats, submissions: data });
  }

  // ── PATCH: update memo score ───────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { email, memo_score } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'Missing email' });

    const score = parseFloat(memo_score);
    if (isNaN(score) || score < 0 || score > 12) {
      return res.status(400).json({ ok: false, error: 'memo_score must be 0–12' });
    }

    const { error } = await supabase
      .from('submissions')
      .update({ memo_score: score })
      .eq('email', email.toLowerCase());

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
