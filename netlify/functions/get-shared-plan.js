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

// Call Google Places API (New) and return a photo CDN URL, or null.
async function fetchPlacePhoto(name, location, googleKey) {
  if (!googleKey || !name) return null;
  try {
    const query = location ? `${name} ${location.split(',')[0]}` : name;

    // 1. Text Search (New) — find the place and get a photo name
    const searchRes = await fetch(
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': googleKey,
          'X-Goog-FieldMask': 'places.photos',
        },
        body: JSON.stringify({ textQuery: query }),
      }
    );
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();

    const photoName = searchData.places?.[0]?.photos?.[0]?.name;
    if (!photoName) return null;

    // 2. Fetch photo media — follow the redirect to get a key-free CDN URL
    const photoRes = await fetch(
      `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=800&key=${googleKey}`,
      { redirect: 'follow' }
    );
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

    const ownerProfile = Array.isArray(ownerRows) ? ownerRows[0] : null;

    // Resolve display name: profile table first, then auth user_metadata (same
    // fallback chain as useUser.ts in the mobile app).
    let ownerName = ownerProfile?.display_name || ownerProfile?.username || null;
    if (!ownerName && session.created_by) {
      try {
        const authRes = await fetch(
          `${SUPABASE_URL}/auth/v1/admin/users/${session.created_by}`,
          { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
        );
        if (authRes.ok) {
          const authUser = await authRes.json();
          ownerName =
            authUser.user_metadata?.full_name ||
            authUser.user_metadata?.name      ||
            null;
        }
      } catch (_) {}
    }

    const owner = { resolvedName: ownerName };
    const options = Array.isArray(rawOptions) ? rawOptions : [];

    // 3. Fetch option photos + destination hero photo in parallel
    const destination = session.context?.destination || null;
    const [enriched, heroImageUrl] = await Promise.all([
      Promise.all(
        options.map(async (o) => {
          if (o.image_url && !o.image_url.includes('maps.googleapis.com')) return o;
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
      ),
      fetchPlacePhoto(destination, null, GOOGLE_KEY),
    ]);

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
        sessionId:    session.id,
        title:        session.title,
        sessionType:  session.session_type,
        context:      session.context || {},
        ownerName:    owner.resolvedName || 'A Qulture user',
        heroImageUrl: heroImageUrl || null,
        options:      displayOpts,
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
