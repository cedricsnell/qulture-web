// Serverless proxy that fetches a shared planning session from Supabase
// using the service role key (bypasses RLS) so unauthenticated web visitors
// can view the shared plan without logging in.
//
// Also enriches options that have no image_url with a Google Places photo,
// then back-fills the Supabase row so the next request is free (cache-on-write).
//
// Required Netlify env vars:
//   SUPABASE_URL          — e.g. https://blqitgtdqtjoxkupolut.supabase.co
//   SUPABASE_SERVICE_KEY  — service role key from Supabase Settings → API
//   GOOGLE_MAPS_KEY       — Maps Platform key with Places API enabled

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Call Google Places "Find Place from Text" and return a photo URL, or null.
async function fetchPlacePhoto(name, location, googleKey) {
  if (!googleKey || !name) return null;
  try {
    const query = location ? `${name} ${location.split(',')[0]}` : name;
    const findUrl =
      'https://maps.googleapis.com/maps/api/place/findplacefromtext/json'
      + `?input=${encodeURIComponent(query)}`
      + '&inputtype=textquery'
      + '&fields=photos'
      + `&key=${googleKey}`;

    const res = await fetch(findUrl);
    if (!res.ok) return null;
    const data = await res.json();

    if (data.status !== 'OK') return null;
    const candidate = data.candidates && data.candidates[0];
    const photo = candidate && candidate.photos && candidate.photos[0];
    if (!photo || !photo.photo_reference) return null;

    // Follow the redirect server-side so the returned URL is a key-free CDN URL
    // (lh3.googleusercontent.com) that the browser can load without CORS issues.
    const photoApiUrl = (
      'https://maps.googleapis.com/maps/api/place/photo'
      + `?maxwidth=800&photo_reference=${photo.photo_reference}&key=${googleKey}`
    );
    const photoRes = await fetch(photoApiUrl, { redirect: 'follow' });
    if (!photoRes.ok) return null;
    return photoRes.url;
  } catch (_) {
    return null;
  }
}

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
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
  const GOOGLE_KEY   = process.env.GOOGLE_MAPS_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return {
      statusCode: 503,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'service not configured' }),
    };
  }

  const base = `${SUPABASE_URL}/rest/v1`;
  const sbHeaders = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };

  try {
    // 1. Fetch the planning session by share_token
    const sessionRes = await fetch(
      `${base}/planning_sessions?share_token=eq.${encodeURIComponent(token)}`
      + `&select=id,title,session_type,context,created_by&limit=1`,
      { headers: sbHeaders }
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
        `${base}/planning_options?session_id=eq.${session.id}`
        + `&status=in.(decided,considering)`
        + `&select=id,title,category,day_label,location,price_range,description,image_url,url,status`
        + `&order=sort_order.asc`,
        { headers: sbHeaders }
      ),
      fetch(
        `${base}/user_profiles?id=eq.${session.created_by}&select=display_name,username&limit=1`,
        { headers: sbHeaders }
      ),
    ]);

    const [rawOptions, ownerRows] = await Promise.all([optionsRes.json(), ownerRes.json()]);

    const owner   = Array.isArray(ownerRows) ? ownerRows[0] : null;
    const options = Array.isArray(rawOptions) ? rawOptions : [];

    // 3. For options missing image_url, fetch a Google Places photo in parallel
    const enriched = await Promise.all(
      options.map(async (o) => {
        if (o.image_url) return o;
        const photoUrl = await fetchPlacePhoto(o.title, o.location, GOOGLE_KEY);
        if (!photoUrl) return o;

        // Cache back to Supabase so the next request is free (fire-and-forget)
        fetch(
          `${base}/planning_options?id=eq.${o.id}`,
          {
            method: 'PATCH',
            headers: sbHeaders,
            body: JSON.stringify({ image_url: photoUrl }),
          }
        ).catch(() => {});

        return { ...o, image_url: photoUrl };
      })
    );

    // 4. Prefer decided items; fall back to all if none decided
    const decided     = enriched.filter((o) => o.status === 'decided');
    const displayOpts = (decided.length > 0 ? decided : enriched).map((o) => ({
      id:          o.id,
      title:       o.title,
      category:    o.category || 'general',
      dayLabel:    o.day_label  || null,
      location:    o.location   || null,
      priceRange:  o.price_range || null,
      description: o.description || null,
      imageUrl:    o.image_url   || null,
      url:         o.url         || null,
      status:      o.status,
    }));

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId:   session.id,
        title:       session.title,
        sessionType: session.session_type,
        context:     session.context || {},
        ownerName:   owner?.display_name || owner?.username || 'A Qulture user',
        options:     displayOpts,
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
