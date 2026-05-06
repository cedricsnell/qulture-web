// Serverless proxy that fetches a shared list from Supabase using the
// service role key (bypasses RLS) so unauthenticated web visitors can
// see the list content without logging in.
//
// Required Netlify env vars (set in the Netlify dashboard):
//   SUPABASE_URL          — e.g. https://blqitgtdqtjoxkupolut.supabase.co
//   SUPABASE_SERVICE_KEY  — service role key from Supabase Settings → API
//
// Called by: GET /.netlify/functions/get-shared-list?token={shareToken}

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
    // 1. Fetch the share record
    const shareRes = await fetch(
      `${base}/shared_lists?share_token=eq.${encodeURIComponent(token)}&select=list_id,owner_id,expires_at&limit=1`,
      { headers }
    );
    const shareRows = await shareRes.json();

    if (!Array.isArray(shareRows) || shareRows.length === 0) {
      return {
        statusCode: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'not_found' }),
      };
    }

    const share = shareRows[0];

    const isExpired = share.expires_at
      ? new Date(share.expires_at) < new Date()
      : false;

    // 2. Fetch list + items + owner profile in parallel
    const [listRes, ownerRes] = await Promise.all([
      fetch(
        `${base}/lists?id=eq.${share.list_id}&select=id,name,type,color,list_items(id,title,description,image_url,item_type,source_url,metadata)&limit=1`,
        { headers }
      ),
      fetch(
        `${base}/user_profiles?id=eq.${share.owner_id}&select=display_name,username&limit=1`,
        { headers }
      ),
    ]);

    const [listRows, ownerRows] = await Promise.all([listRes.json(), ownerRes.json()]);

    if (!Array.isArray(listRows) || listRows.length === 0) {
      return {
        statusCode: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'list_not_found' }),
      };
    }

    const list = listRows[0];
    const owner = ownerRows?.[0];

    const payload = {
      listId: list.id,
      listName: list.name,
      listType: list.type,
      listColor: list.color,
      ownerId: share.owner_id,
      ownerName: owner?.display_name || owner?.username || 'A Qulture user',
      isExpired,
      expiresAt: share.expires_at,
      items: (list.list_items || []).map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description || null,
        imageUrl: item.image_url || null,
        itemType: item.item_type,
        sourceUrl: item.source_url || null,
        location: item.metadata?.location || null,
        cuisine: item.metadata?.cuisine || null,
        priceRange: item.metadata?.priceRange || null,
        tags: item.metadata?.tags || null,
      })),
    };

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    console.error('[get-shared-list] error:', err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'internal_error' }),
    };
  }
};
