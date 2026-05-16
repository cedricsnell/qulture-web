// Serverless proxy that fetches a shared planning session from Supabase
// using the service role key (bypasses RLS) so unauthenticated web visitors
// can view the shared plan without logging in.
//
// Required Netlify env vars (set in the Netlify dashboard):
//   SUPABASE_URL          — e.g. https://blqitgtdqtjoxkupolut.supabase.co
//   SUPABASE_SERVICE_KEY  — service role key from Supabase Settings → API
//
// Called by: GET /.netlify/functions/get-shared-plan?token={shareToken}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const token = event.queryStringParameters?.token;
  if (!token || typeof token !== 'string' || token.length > 80) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid token' }),
    };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return {
      statusCode: 503,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'service not configured' }),
    };
  }

  const base = `${SUPABASE_URL}/rest/v1`;
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Fetch the planning session by share_token
    const sessionRes = await fetch(
      `${base}/planning_sessions?share_token=eq.${encodeURIComponent(token)}&select=id,title,session_type,context,created_by&limit=1`,
      { headers }
    );
    const sessionRows = await sessionRes.json();

    if (!Array.isArray(sessionRows) || sessionRows.length === 0) {
      return {
        statusCode: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'not_found' }),
      };
    }

    const session = sessionRows[0];

    // 2. Fetch options + owner profile in parallel
    const [optionsRes, ownerRes] = await Promise.all([
      fetch(
        `${base}/planning_options?session_id=eq.${session.id}&status=in.(decided,considering)&select=id,title,category,day_label,location,price_range,description,image_url,url,status&order=sort_order.asc`,
        { headers }
      ),
      fetch(
        `${base}/user_profiles?id=eq.${session.created_by}&select=display_name,username&limit=1`,
        { headers }
      ),
    ]);

    const [rawOptions, ownerRows] = await Promise.all([optionsRes.json(), ownerRes.json()]);

    const owner = Array.isArray(ownerRows) ? ownerRows[0] : null;
    const options = Array.isArray(rawOptions) ? rawOptions : [];

    // Prefer decided items; fall back to all if none decided
    const decidedOptions = options.filter((o) => o.status === 'decided');
    const displayOptions = (decidedOptions.length > 0 ? decidedOptions : options).map((o) => ({
      id: o.id,
      title: o.title,
      category: o.category || 'general',
      dayLabel: o.day_label || null,
      location: o.location || null,
      priceRange: o.price_range || null,
      description: o.description || null,
      imageUrl: o.image_url || null,
      url: o.url || null,
      status: o.status,
    }));

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        title: session.title,
        sessionType: session.session_type,
        ownerName: owner?.display_name || owner?.username || 'A Qulture user',
        options: displayOptions,
      }),
    };
  } catch (err) {
    console.error('[get-shared-plan] error:', err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'internal_error' }),
    };
  }
};
