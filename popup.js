// popup.js

const dot            = document.getElementById('dot');
const statusLabel    = document.getElementById('statusLabel');
const statusSub      = document.getElementById('statusSub');
const infoGrid       = document.getElementById('infoGrid');
const infoUrl        = document.getElementById('infoUrl');
const infoAffiliate  = document.getElementById('infoAffiliate');
const infoCaptured   = document.getElementById('infoCaptured');
const affiliateField = document.getElementById('affiliateField');
const affiliateInput = document.getElementById('affiliateInput');
const prog           = document.getElementById('prog');
const fill           = document.getElementById('fill');
const progMsg        = document.getElementById('progMsg');
const errBox         = document.getElementById('errBox');
const okBox          = document.getElementById('okBox');
const btnExport      = document.getElementById('btnExport');
const btnClear       = document.getElementById('btnClear');

const delaySlider = document.getElementById('delaySlider');
const delayVal    = document.getElementById('delayVal');

delaySlider.addEventListener('input', () => {
  delayVal.textContent = (delaySlider.value / 1000).toFixed(1) + 's';
});

let pollTimer = null;

// ── Init ───────────────────────────────────────────────────────────────────

init();

async function init() {
  const { session } = await msg({ type: 'GET_STATE' });
  renderSession(session);
}

function renderSession(session) {
  if (session?.graphqlUrl && session?.headers) {
    const hasAffiliate = !!session.affiliateId;

    dot.className = hasAffiliate ? 'dot ok' : 'dot warn';
    statusLabel.textContent = hasAffiliate
      ? 'Session captured ✓'
      : 'Partial — affiliate_id missing';

    statusSub.style.display = 'none';
    infoGrid.style.display = 'grid';

    infoUrl.textContent       = truncate(session.graphqlUrl, 45);
    infoAffiliate.textContent = session.affiliateId || '⚠ not captured yet';
    infoCaptured.textContent  = session.capturedAt ? timeAgo(session.capturedAt) : '—';

    if (hasAffiliate) {
      affiliateField.style.display = 'none';
      btnExport.disabled = false;
    } else {
      // Show manual input
      affiliateField.style.display = 'block';
      affiliateInput.addEventListener('input', () => {
        btnExport.disabled = !affiliateInput.value.trim();
      });
    }
  } else {
    dot.className = 'dot warn';
    statusLabel.textContent = 'No session captured';
    statusSub.style.display = 'block';
    infoGrid.style.display = 'none';
    affiliateField.style.display = 'none';
    btnExport.disabled = true;
  }
}

// ── Export ─────────────────────────────────────────────────────────────────

btnExport.addEventListener('click', async () => {
  const { session } = await msg({ type: 'GET_STATE' });
  const affiliateId = session?.affiliateId || affiliateInput.value.trim();

  if (!affiliateId) {
    showErr('Enter your affiliate_id first.');
    return;
  }

  clearAlerts();
  showProg(0, 'Starting…');
  btnExport.disabled = true;
  btnClear.disabled  = true;

  pollTimer = setInterval(pollProgress, 400);

  const res = await msg({ type: 'FETCH_LOGBOOK', affiliateId, delayMs: parseInt(delaySlider.value) });

  clearInterval(pollTimer);
  pollTimer = null;
  btnClear.disabled = false;

  if (res?.ok && res.payload) {
    showProg(100, 'Done!');
    setTimeout(() => hideProg(), 700);
    showOk(res.payload);
    downloadJson(res.payload);
  } else {
    hideProg();
    btnExport.disabled = false;
    showErr(res?.error || 'Unknown error.');
  }
});

// ── Clear ──────────────────────────────────────────────────────────────────

btnClear.addEventListener('click', async () => {
  await msg({ type: 'CLEAR_STATE' });
  clearAlerts();
  hideProg();
  renderSession(null);
});

// ── Progress polling ───────────────────────────────────────────────────────

async function pollProgress() {
  const data = await new Promise((r) => chrome.storage.local.get('progress', r));
  const p = data?.progress;
  if (!p) return;

  const pct =
    p.stage === 'list'    ? 5 :
    p.stage === 'details' ? 5 + Math.round((p.current / (p.total || 1)) * 90) :
    p.stage === 'done'    ? 100 : 0;

  showProg(pct, p.message);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function showProg(pct, text) {
  prog.classList.add('on');
  fill.style.width = pct + '%';
  progMsg.textContent = text;
}
function hideProg() { prog.classList.remove('on'); }

function showErr(text) {
  errBox.textContent = '⚠ ' + text;
  errBox.classList.add('on');
}
function showOk(payload) {
  okBox.innerHTML =
    `✓ Exported <strong>${payload.totalDives} dives</strong> — ` +
    `<strong>${fmtBytes(JSON.stringify(payload).length)}</strong>. File download started.`;
  okBox.classList.add('on');
}
function clearAlerts() {
  errBox.classList.remove('on');
  okBox.classList.remove('on');
}

function downloadJson(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: `padi-logbook-${new Date().toISOString().slice(0,10)}.json`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function msg(payload) {
  return new Promise((r) => chrome.runtime.sendMessage(payload, r));
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function fmtBytes(n) {
  if (n < 1024)        return n + ' B';
  if (n < 1024 * 1024) return (n/1024).toFixed(1) + ' KB';
  return (n / (1024*1024)).toFixed(2) + ' MB';
}

// ── CSV Export ─────────────────────────────────────────────────────────────

const btnExportCsv = document.getElementById('btnExportCsv');

// Enable/disable alongside main export button
const _origRenderSession = renderSession;
// Patch: keep btnExportCsv in sync with btnExport enabled state
const observer = new MutationObserver(() => {
  btnExportCsv.disabled = btnExport.disabled;
});
observer.observe(btnExport, { attributes: true, attributeFilter: ['disabled'] });

btnExportCsv.addEventListener('click', async () => {
  const { session } = await msg({ type: 'GET_STATE' });
  const affiliateId = session?.affiliateId || affiliateInput.value.trim();

  if (!affiliateId) {
    showErr('Enter your affiliate_id first.');
    return;
  }

  clearAlerts();
  showProg(0, 'Starting…');
  btnExport.disabled    = true;
  btnExportCsv.disabled = true;
  btnClear.disabled     = true;

  pollTimer = setInterval(pollProgress, 400);

  const res = await msg({ type: 'FETCH_LOGBOOK', affiliateId, delayMs: parseInt(delaySlider.value) });

  clearInterval(pollTimer);
  pollTimer = null;
  btnClear.disabled = false;

  if (res?.ok && res.payload) {
    showProg(100, 'Done!');
    setTimeout(() => hideProg(), 700);
    showOk(res.payload);
    downloadCsv(res.payload);
  } else {
    hideProg();
    btnExport.disabled    = false;
    btnExportCsv.disabled = false;
    showErr(res?.error || 'Unknown error.');
  }
});

// ── JSON → Subsurface CSV converter ───────────────────────────────────────

const FEELING_TO_RATING = { Amazing: 5, Good: 4, Average: 3, Poor: 2 };

const CSV_FIELDS = [
  'Dive #', 'Date', 'Time', 'Location', 'Duration', 'Max Depth',
  'Air Temp', 'Water Temp', 'Suit', 'Weight',
  'Cylinder size', 'Start Pressure', 'End Pressure', 'O2%',
  'Rating', 'Buddy', 'Dive center', 'Notes',
];

function firstVal(arr, key, def = '') {
  if (Array.isArray(arr) && arr.length > 0) {
    const v = arr[0][key];
    return v != null ? v : def;
  }
  return def;
}

function clean(s) {
  return s ? s.trim().replace(/\s+/g, ' ') : '';
}

function convertToCsv(payload) {
  const dives = payload.dives;
  const total = dives.length;

  // Build rows with reverse-numbered dive numbers
  const rows = dives.map((d, i) => {
    const dt    = d.depth_times   || [{}];
    const cond  = d.conditions    || [{}];
    const equip = d.equipment     || [{}];
    const exp   = d.experiences   || [{}];

    const dateStr    = (d.dive_date || '').slice(0, 10);
    const bottomTime = firstVal(dt, 'bottom_time', 0);
    const rawTime    = firstVal(dt, 'time_in', null);
    const feeling    = firstVal(exp, 'feeling', '');

    return {
      'Dive #':         total - i,
      '_date':          dateStr,
      '_time_known':    rawTime ? rawTime.slice(0, 5) : null,
      'Date':           dateStr,
      'Time':           null, // filled below
      'Location':       d.dive_location || '',
      'Duration':       `${Math.floor(bottomTime)}:00`,
      'Max Depth':      firstVal(dt,   'max_depth', ''),
      'Air Temp':       firstVal(cond, 'air_temp', ''),
      'Water Temp':     firstVal(cond, 'bottom_water_temp') || firstVal(cond, 'surface_water_temp', ''),
      'Suit':           firstVal(equip, 'suit_type', ''),
      'Weight':         firstVal(equip, 'weight', ''),
      'Cylinder size':  firstVal(equip, 'cylinder_size', ''),
      'Start Pressure': firstVal(equip, 'starting_pressure', ''),
      'End Pressure':   firstVal(equip, 'ending_pressure', ''),
      'O2%':            firstVal(equip, 'oxygen', 21),
      'Rating':         FEELING_TO_RATING[feeling] || '',
      'Buddy':          firstVal(exp, 'buddies', ''),
      'Dive center':    firstVal(exp, 'dive_center', ''),
      'Notes':          clean(firstVal(exp, 'notes', '')),
    };
  });

  // Sort chronologically
  rows.sort((a, b) => a['Dive #'] - b['Dive #']);

  // Assign times per day
  const dateCounter = {};
  for (const r of rows) {
    const date = r['_date'];
    const idx  = dateCounter[date] ?? 0;
    r['Time']  = r['_time_known'] || `${String(idx * 2).padStart(2, '0')}:00`;
    dateCounter[date] = idx + 1;
    delete r['_date'];
    delete r['_time_known'];
  }

  // Serialize to CSV
  const escape = (v) => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [
    CSV_FIELDS.join(','),
    ...rows.map(r => CSV_FIELDS.map(f => escape(r[f])).join(',')),
  ];

  return lines.join('\r\n');
}

function downloadCsv(payload) {
  const csv  = convertToCsv(payload);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: `padi-logbook-subsurface-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
