// background.js — service worker — GraphQL edition

// ── GraphQL queries ────────────────────────────────────────────────────────

const LIST_QUERY = `query logbook_logs($affiliate_id: Int!) {
  logbook_logs(
    where: {affiliate_id: {_eq: $affiliate_id}}
    order_by: {dive_date: desc}
  ) {
    id
    log_type
    log_course
    log_number
    dive_title
    dive_date
    dive_location
    status
  }
}`;

const DETAIL_QUERY = `query logbook_logs($affiliate_id: Int!, $id: Int!) {
  logbook_logs(
    where: {affiliate_id: {_eq: $affiliate_id}, _and: {id: {_eq: $id}}}
  ) {
    id
    log_type
    log_course
    log_number
    dive_type
    dive_title
    dive_date
    dive_location
    memsys_member_number
    status
    adventure_dive
    depth_times {
      max_depth
      bottom_time
      time_in
      time_out
    }
    skills {
      dive_skills
    }
    conditions {
      water_type
      body_of_water
      weather
      air_temp
      surface_water_temp
      bottom_water_temp
      visibility
      visibility_distance
      wave_condition
      current
      surge
    }
    equipment {
      suit_type
      weight
      weight_type
      additional_equipment
      cylinder_type
      cylinder_size
      gas_mixture
      oxygen
      nitrogen
      helium
      starting_pressure
      ending_pressure
    }
    experiences {
      feeling
      notes
      buddies
      dive_center
    }
  }
}`;

// ── Intercept request BODY to get affiliate_id + endpoint URL ─────────────

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== 'POST') return;
    const url = details.url;
    if (!url.includes('padi.com') && !url.includes('padiapp.com')) return;
    if (!details.requestBody?.raw) return;

    try {
      const raw = details.requestBody.raw[0]?.bytes;
      if (!raw) return;
      const text = new TextDecoder().decode(raw);
      const body = JSON.parse(text);

      // Only care about logbook queries
      if (!body?.query?.includes('logbook_logs')) return;

      const affiliateId =
        body?.variables?.affiliate_id ||
        body?.affiliate_id ||
        null;

      chrome.storage.local.get('capturedSession', (data) => {
        const session = data.capturedSession || {};
        session.graphqlUrl = url;
        if (affiliateId) session.affiliateId = String(affiliateId);
        session.capturedAt = Date.now();
        chrome.storage.local.set({ capturedSession: session });
      });

      console.log('[PADI Exporter] Intercepted logbook request, affiliate_id:', affiliateId);
    } catch (_) {}
  },
  { urls: ['https://*.padi.com/*', 'https://*.padiapp.com/*'] },
  ['requestBody']
);

// ── Intercept request HEADERS to get auth tokens ──────────────────────────

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.method !== 'POST') return;
    const url = details.url;
    if (!url.includes('padi.com') && !url.includes('padiapp.com')) return;

    // Quick check: does URL look like an API/GraphQL endpoint?
    if (
      !url.includes('graphql') &&
      !url.includes('hasura') &&
      !url.includes('/api/') &&
      !url.includes('/v1/') &&
      !url.includes('/v2/')
    ) return;

    const KEEP = new Set([
      'authorization', 'cookie', 'content-type',
      'x-hasura-role', 'x-hasura-user-id',
      'x-auth-token', 'x-api-key', 'x-access-token',
      'origin', 'referer',
    ]);

    const headers = {};
    for (const h of details.requestHeaders || []) {
      const name = h.name.toLowerCase();
      if (KEEP.has(name) || name.startsWith('x-padi') || name.startsWith('x-auth')) {
        headers[h.name] = h.value;
      }
    }

    if (Object.keys(headers).length === 0) return;

    chrome.storage.local.get('capturedSession', (data) => {
      const session = data.capturedSession || {};
      session.headers = headers;
      session.graphqlUrl = session.graphqlUrl || url;
      chrome.storage.local.set({ capturedSession: session });
    });

    console.log('[PADI Exporter] Captured auth headers');
  },
  { urls: ['https://*.padi.com/*', 'https://*.padiapp.com/*'] },
  ['requestHeaders', 'extraHeaders']
);

// ── Message handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get('capturedSession', (data) =>
      sendResponse({ ok: true, session: data.capturedSession || null })
    );
    return true;
  }

  if (msg.type === 'FETCH_LOGBOOK') {
    handleFetchLogbook(msg.affiliateId, sendResponse, msg.delayMs ?? 2000);
    return true;
  }

  if (msg.type === 'CLEAR_STATE') {
    chrome.storage.local.remove(['capturedSession', 'progress'], () =>
      sendResponse({ ok: true })
    );
    return true;
  }
});

// ── Core export logic ──────────────────────────────────────────────────────

async function handleFetchLogbook(overrideAffiliateId, sendResponse, delayMs = 2000) {
  const stored = await getStored('capturedSession');
  const session = stored.capturedSession;

  if (!session?.graphqlUrl || !session?.headers) {
    sendResponse({ ok: false, error: 'No session captured. Open PADI logbook first.' });
    return;
  }

  const affiliateId = overrideAffiliateId || session.affiliateId;
  if (!affiliateId) {
    sendResponse({
      ok: false,
      error: 'affiliate_id not captured. Click on any dive in the logbook to capture it.',
    });
    return;
  }

  const { graphqlUrl, headers } = session;

  const setProgress = (stage, current, total, message) =>
    chrome.storage.local.set({ progress: { stage, current, total, message } });

  try {
    // 1. Full dive list
    setProgress('list', 0, 1, 'Fetching dive list…');

    const listRes = await gql(graphqlUrl, headers, LIST_QUERY, {
      affiliate_id: parseInt(affiliateId),
    });

    const diveList = listRes?.data?.logbook_logs;
    if (!Array.isArray(diveList)) {
      throw new Error('Unexpected response shape from list query.');
    }
    if (diveList.length === 0) {
      throw new Error('No dives found. Check that affiliate_id is correct.');
    }

    setProgress('list', 1, 1, `Found ${diveList.length} dives. Fetching details…`);

    // 2. Details per dive
    const dives = [];
    for (let i = 0; i < diveList.length; i++) {
      const preview = diveList[i];
      setProgress(
        'details', i + 1, diveList.length,
        `Dive ${i + 1} / ${diveList.length} — ${preview.dive_title || preview.id}`
      );

      let detail = null;
      try {
        const detailRes = await gql(graphqlUrl, headers, DETAIL_QUERY, {
          affiliate_id: parseInt(affiliateId),
          id: parseInt(preview.id),
        });
        detail = detailRes?.data?.logbook_logs?.[0] ?? null;
      } catch (e) {
        console.warn(`[PADI Exporter] Detail fetch failed for dive ${preview.id}:`, e.message);
      }

      dives.push(detail);
      await sleep(delayMs);
    }

    setProgress('done', diveList.length, diveList.length, 'Done!');

    sendResponse({
      ok: true,
      payload: {
        exportedAt: new Date().toISOString(),
        affiliateId,
        totalDives: dives.length,
        dives,
      },
    });
  } catch (err) {
    console.error('[PADI Exporter]', err);
    setProgress('error', 0, 0, err.message);
    sendResponse({ ok: false, error: err.message });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function gql(url, headers, query, variables) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json?.errors?.length) throw new Error(json.errors[0]?.message || 'GraphQL error');
  return json;
}

function getStored(key) {
  return new Promise((r) => chrome.storage.local.get(key, r));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
