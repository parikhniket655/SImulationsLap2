/**
 * POST /api/auth
 * Body: { email: string }
 *
 * 1. Validates email against Google Sheet whitelist (CSV).
 * 2. Checks Supabase to see if participant already submitted.
 * 3. Returns { ok: true, name } or { ok: false, error }
 */

import { createClient } from '@supabase/supabase-js';

const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// In-memory whitelist cache (refreshes every 2 minutes per instance)
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 2 * 60 * 1000;

async function fetchWhitelist() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL) return _cache;

  const res = await fetch(SHEET_CSV_URL);
  if (!res.ok) throw new Error('Could not fetch participant list');
  const text = await res.text();

  // Parse CSV: expect rows like  Name,Email  or just Email
  const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const whitelist = {}; // email (lowercase) -> name

  for (const line of lines) {
    const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    if (!cols.length) continue;

    // Detect which column has an email by scanning for '@'
    let email = null;
    let name = null;
    for (const col of cols) {
      if (col.includes('@')) { email = col.toLowerCase(); break; }
    }
    if (!email) continue; // skip header or non-email rows

    // Name is whatever non-email column comes first (usually col 0 or 1)
    name = cols.find(c => !c.includes('@') && c.length > 0 && !c.toLowerCase().includes('email') && !c.toLowerCase().includes('name')) || '';
    whitelist[email] = name;
  }

  _cache = whitelist;
  _cacheTs = Date.now();
  return whitelist;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  }

  const normalEmail = email.trim().toLowerCase();

  try {
    // 1. Check whitelist
    const whitelist = await fetchWhitelist();
    if (!whitelist.hasOwnProperty(normalEmail)) {
      return res.status(403).json({
        ok: false,
        error: 'Your email is not on the participant list. Please check with your organiser.'
      });
    }

    // 2. Check if already submitted (block re-entry)
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from('submissions')
      .select('id, end_time')
      .eq('email', normalEmail)
      .maybeSingle();

    if (error) throw error;

    if (data && data.end_time) {
      return res.status(409).json({
        ok: false,
        error: 'Your submission has already been received. Contact the organiser if this is a mistake.'
      });
    }

    // 3. Create a pending session row if none exists
    if (!data) {
      await supabase.from('submissions').insert({
        email: normalEmail,
        name: whitelist[normalEmail] || '',
        start_time: new Date().toISOString()
      });
    }

    return res.status(200).json({ ok: true, name: whitelist[normalEmail] || '' });
  } catch (err) {
    console.error('[auth]', err);
    return res.status(500).json({ ok: false, error: 'Server error: ' + (err.message || String(err)) });
  }
}
