// ─── STATE ──────────────────────────────────────────────────
const state = {
  patients: [],
  currentPatient: null,
  protocolKey: DEFAULT_PROTOCOL,
  ear: 'right',            // 'right' | 'left'
  binaural: false,
  selectedIndex: 0,        // selected DP-Gram point index (single-ear view)
  binSelected: { right: 0, left: 0 },
  started: false,
  seedBase: 1
};

// ─── SEEDED RNG (xorshift) ─────────────────────────────────
function seededRng(seed) {
  let s = seed >>> 0 || 1;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// ─── DOM REFS ───────────────────────────────────────────────
const els = {};
function cacheEls() {
  [
    'patient-select', 'protocol-select', 'ear-right-btn', 'ear-left-btn',
    'binaural-btn', 'share-btn', 'admin-btn', 'print-btn', 'start-btn',
    'single-view', 'binaural-view',
    'probe-canvas', 'response-canvas', 'dpgram-canvas',
    'summary-tbody',
    'bin-right-probe-canvas', 'bin-right-response-canvas', 'bin-right-dpgram-canvas',
    'bin-left-probe-canvas', 'bin-left-response-canvas', 'bin-left-dpgram-canvas',
    'tooltip', 'toast', 'print-summary'
  ].forEach(id => { els[id] = document.getElementById(id); });
}

// ─── PATIENT LOADING ────────────────────────────────────────
async function loadPatients() {
  try {
    const res = await fetch('./patients.json', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length) {
        state.patients = data;
        return;
      }
    }
  } catch (e) { /* fall through to defaults */ }
  state.patients = DEFAULT_PATIENTS;
}

function populatePatientSelect() {
  els['patient-select'].innerHTML = '';
  state.patients.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = p.name;
    els['patient-select'].appendChild(opt);
  });
}

function populateProtocolSelect() {
  els['protocol-select'].innerHTML = '';
  Object.keys(PROTOCOLS).forEach(key => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = PROTOCOLS[key].name;
    els['protocol-select'].appendChild(opt);
  });
}

function selectPatient(index) {
  state.currentPatient = state.patients[index];
  state.protocolKey = state.currentPatient.protocol || DEFAULT_PROTOCOL;
  els['protocol-select'].value = state.protocolKey;
  state.selectedIndex = 0;
  state.binSelected = { right: 0, left: 0 };
  state.started = false;
  els['start-btn'].textContent = 'START';
  els['start-btn'].classList.remove('running');
  renderAll();
}

// ─── NOISE FLOOR ────────────────────────────────────────────
// Physiological/instrument noise floor: roughly constant across frequency,
// rising at low frequencies. Independent of DP presence/absence.
function noiseFloorForFreq(f2, rng) {
  const base = -20 + 22 * Math.exp(-f2 / 1400); // ~+2 dB SPL at 500Hz, flattens to ~-20 by ~4-6kHz
  return base + (rng() - 0.5) * 4; // +/-2 dB jitter
}

// ─── DP POINT COMPUTATION ───────────────────────────────────
// Generates (or applies overrides to) the full data for one point.
function computePoint(patientId, ear, protoKey, idx, rawPoint) {
  const proto = PROTOCOLS[protoKey];
  const f2 = proto.points[idx];
  const f1 = Math.round(f2 / proto.f2f1Ratio);
  const rng = seededRng(hashStr(patientId + '|' + ear + '|' + protoKey + '|' + idx));

  const present = rawPoint ? !!rawPoint.present : false;

  let noise;
  if (rawPoint && typeof rawPoint.noise === 'number') {
    noise = rawPoint.noise;
  } else {
    noise = noiseFloorForFreq(f2, rng);
  }

  let level;
  if (rawPoint && typeof rawPoint.level === 'number') {
    level = rawPoint.level;
  } else if (present) {
    level = noise + 12 + rng() * 18; // clearly above noise & above -5 dB SPL rule
  } else {
    // absent: the DP level itself drops out, rather than the noise rising
    level = noise - (2 + rng() * 10); // level falls below (or barely above) the noise floor
  }

  let snr;
  if (rawPoint && typeof rawPoint.snr === 'number') {
    snr = rawPoint.snr;
  } else {
    snr = level - noise;
  }

  const l1 = (rawPoint && rawPoint.l1) || proto.l1;
  const l2 = (rawPoint && rawPoint.l2) || proto.l2;

  let reliability;
  if (rawPoint && typeof rawPoint.reliability === 'number') {
    reliability = rawPoint.reliability;
  } else {
    reliability = 98 + rng() * 2; // default 98-100, admin-overridable
  }

  return { f2, f1, l1, l2, level, snr, noise, present, reliability, rng };
}

function getEarPoints(patient, ear, protoKey) {
  const proto = PROTOCOLS[protoKey];
  const earData = (patient.ears && patient.ears[ear]) || { points: [] };
  return proto.points.map((f2, idx) => computePoint(patient.id, ear, protoKey, idx, earData.points[idx]));
}

// ─── SHARE LINK CODEC ─────────────────────────────────────────
// Compact patient JSON -> gzip (via the native CompressionStream, when
// available) -> base64url, packed into the URL hash so a case can be shared
// via a short-ish link like the other simulators (#case=<encoded>).
// Falls back to plain (uncompressed) base64 on browsers without
// CompressionStream/DecompressionStream support.
function bytesToBase64url(bytes) {
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(b64) {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Strip patient JSON down to only non-default fields to shrink the payload
// further before compression (omits present:false / undefined overrides).
function minifyPatientForShare(patient) {
  const mini = { id: patient.id, name: patient.name, protocol: patient.protocol, ears: {} };
  ['right', 'left'].forEach(ear => {
    const pts = (patient.ears && patient.ears[ear] && patient.ears[ear].points) || [];
    mini.ears[ear] = { points: pts.map(pt => {
      const out = {};
      if (pt.present) out.present = true;
      ['level', 'snr', 'noise', 'reliability', 'l1', 'l2'].forEach(k => {
        if (typeof pt[k] === 'number') out[k] = pt[k];
      });
      return out;
    }) };
  });
  return mini;
}

async function encodeCase(patient) {
  const json = JSON.stringify(minifyPatientForShare(patient));
  if (typeof CompressionStream !== 'undefined') {
    try {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const buf = await new Response(stream).arrayBuffer();
      return 'z' + bytesToBase64url(new Uint8Array(buf));
    } catch (e) { /* fall through to uncompressed */ }
  }
  return 'j' + bytesToBase64url(new TextEncoder().encode(json));
}

async function decodeCase(encoded) {
  const tag = encoded[0];
  const payload = encoded.slice(1);
  const bytes = base64urlToBytes(payload);
  if (tag === 'z') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    return JSON.parse(new TextDecoder().decode(buf));
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function buildShareUrl(patient) {
  const url = new URL(window.location.href);
  url.hash = 'case=' + await encodeCase(patient);
  return url.toString();
}

async function shareCurrentCase() {
  if (!state.currentPatient) return;
  const url = await buildShareUrl(state.currentPatient);
  try {
    await navigator.clipboard.writeText(url);
    showToast('Share link copied to clipboard (' + url.length + ' chars)');
  } catch (e) {
    showToast('Copy failed — link: ' + url, 4000);
  }
}

async function tryLoadSharedCase() {
  const match = /(?:^|[#&])case=([^&]+)/.exec(window.location.hash);
  if (!match) return false;
  try {
    const patient = await decodeCase(match[1]);
    if (!patient || !patient.ears) return false;
    if (!patient.id) patient.id = 'shared-' + Date.now();
    if (!patient.name) patient.name = 'Shared case';
    if (!patient.protocol) patient.protocol = DEFAULT_PROTOCOL;
    state.patients = [patient, ...state.patients];
    return true;
  } catch (e) {
    return false;
  }
}

// ─── CANVAS HELPERS ─────────────────────────────────────────
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width, 50);
  const h = Math.max(rect.height, 50);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function logScaleX(freq, minF, maxF, padLeft, plotW) {
  const t = (Math.log10(freq) - Math.log10(minF)) / (Math.log10(maxF) - Math.log10(minF));
  return padLeft + t * plotW;
}

function linScaleY(val, minV, maxV, padTop, plotH) {
  const t = (val - minV) / (maxV - minV);
  return padTop + (1 - t) * plotH;
}

// ─── PROBE CHECK CANVAS ──────────────────────────────────────
// Control points (kHz, dB SPL) tracing the reference Titan Suite probe-check
// curve: a sharp low-frequency insertion peak, a long gently-undulating
// plateau, a broad trough around 5.5-6kHz, then a recovery toward 8kHz.
const PROBE_CURVE_POINTS = [
  [0, 48], [0.12, 50], [0.3, 68], [0.45, 62], [0.6, 58], [0.8, 54],
  [1.0, 50], [1.3, 49], [1.6, 50], [2.0, 48], [2.3, 46], [2.6, 48],
  [3.0, 50], [3.3, 48], [3.6, 44], [3.9, 45], [4.2, 48], [4.5, 45],
  [4.8, 42], [5.1, 39], [5.4, 37], [5.7, 36], [6.0, 37], [6.3, 40],
  [6.6, 43], [6.9, 45], [7.2, 46], [7.5, 47], [7.8, 48], [8.0, 49]
];

function interpProbeCurve(f) {
  const pts = PROBE_CURVE_POINTS;
  if (f <= pts[0][0]) return pts[0][1];
  if (f >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [f0, v0] = pts[i], [f1, v1] = pts[i + 1];
    if (f >= f0 && f <= f1) {
      const t = (f - f0) / (f1 - f0);
      const smooth = t * t * (3 - 2 * t); // smoothstep for a curved feel
      return v0 + (v1 - v0) * smooth;
    }
  }
  return pts[pts.length - 1][1];
}

function drawProbeCheck(canvas, seedKey, color) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 34, padR = 10, padT = 22, padB = 20;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const minF = 0, maxF = 8, minY = 10, maxY = 80;

  ctx.strokeStyle = '#dbe3e7';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(padL, padT, plotW, plotH);
  ctx.stroke();

  ctx.fillStyle = '#556';
  ctx.font = '11px Arial';
  ctx.textAlign = 'left';
  ctx.fillText('dB SPL', padL, padT - 8);
  ctx.textAlign = 'right';
  ctx.fillText('kHz', w - padR, h - 4);

  for (let f = 0; f <= maxF; f++) {
    const x = padL + (f / maxF) * plotW;
    ctx.fillStyle = '#889';
    ctx.textAlign = 'center';
    ctx.fillText(String(f), x, h - 6);
  }
  [10, 20, 30, 40, 50, 60, 70, 80].forEach(v => {
    const y = linScaleY(v, minY, maxY, padT, plotH);
    ctx.fillStyle = '#889';
    ctx.textAlign = 'right';
    ctx.fillText(String(v), padL - 6, y + 3);
  });

  const rng = seededRng(hashStr(seedKey + '|probe'));
  const correlation = Math.round(98 + rng() * 2); // near-100%, well-seated probe
  ctx.fillStyle = '#333';
  ctx.font = 'bold 12px Arial';
  ctx.textAlign = 'right';
  ctx.fillText('Correlation ' + correlation + '%', w - padR, padT - 8);

  ctx.strokeStyle = color || '#e0842a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const n = 220;
  for (let i = 0; i <= n; i++) {
    const f = (i / n) * maxF;
    const x = padL + (i / n) * plotW;
    let val = interpProbeCurve(f) + (rng() - 0.5) * 1.4;
    val = Math.max(minY + 2, Math.min(maxY - 2, val));
    const y = linScaleY(val, minY, maxY, padT, plotH);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ─── RESPONSE (FFT) CANVAS ────────────────────────────────────
function drawResponse(canvas, point, seedKey, idx) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 34, padR = 10, padT = 22, padB = 20;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const centerKHz = point.f1 / 1000;
  const spanKHz = Math.max(0.6, centerKHz * 0.6);
  const minF = Math.max(0.05, centerKHz - spanKHz / 2);
  const maxF = centerKHz + spanKHz / 2;
  const minY = -30, maxY = 90;

  ctx.strokeStyle = '#dbe3e7';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(padL, padT, plotW, plotH);
  ctx.stroke();

  ctx.fillStyle = '#889';
  ctx.font = '11px Arial';
  ctx.textAlign = 'left';
  ctx.fillText('dB SPL', padL, padT - 8);
  ctx.textAlign = 'right';
  ctx.fillText('kHz', w - padR, h - 4);

  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const f = minF + (i / xTicks) * (maxF - minF);
    const x = padL + (i / xTicks) * plotW;
    ctx.fillStyle = '#889';
    ctx.textAlign = 'center';
    ctx.fillText(f.toFixed(2), x, h - 6);
  }
  [-30, -10, 10, 30, 50, 70, 90].forEach(v => {
    const y = linScaleY(v, minY, maxY, padT, plotH);
    ctx.fillStyle = '#889';
    ctx.textAlign = 'right';
    ctx.fillText(String(v), padL - 6, y + 3);
  });

  const fx = f => padL + ((f - minF) / (maxF - minF)) * plotW;
  const fy = v => linScaleY(v, minY, maxY, padT, plotH);

  // shaded level-tolerance boxes: L1/L2 dB SPL +/- 6dB, centered over F1/F2.
  // These indicate whether the delivered stimulus level is within tolerance,
  // not a frequency-selectivity window.
  const f1KHz = point.f1 / 1000, f2KHz = point.f2 / 1000;
  const bandW = spanKHz * 0.05;
  [[f1KHz, point.l1], [f2KHz, point.l2]].forEach(([fk, level]) => {
    if (fk >= minF && fk <= maxF) {
      const x1 = fx(Math.max(minF, fk - bandW));
      const x2 = fx(Math.min(maxF, fk + bandW));
      const yTop = fy(Math.min(maxY, level + 6));
      const yBot = fy(Math.max(minY, level - 6));
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(x1, yTop, x2 - x1, yBot - yTop);
    }
  });

  // Build a single jagged FFT-style trace: a noisy baseline with narrow
  // mountain-peak spikes rising out of it at the DP, F1 and F2 bins —
  // mimicking real spectral bins rather than separate detached lines.
  // Spike frequencies are inserted as exact knot points (rather than relying
  // on a uniform grid to happen to land on them) so each peak reaches its
  // true target amplitude precisely.
  const rng = seededRng(hashStr(seedKey + '|resp|' + idx));
  const n = 260;
  const noiseFloor = point.noise;
  const dpKHz = (2 * point.f1 - point.f2) / 1000;
  const spikes = [
    { f: dpKHz, amp: point.level },
    { f: f1KHz, amp: point.l1 },
    { f: f2KHz, amp: point.l2 }
  ].filter(s => s.f >= minF && s.f <= maxF);

  const spikeHalfWidth = (maxF - minF) * 0.012; // narrow triangular base, in kHz

  // base grid, skipping samples that fall inside any spike's base width
  const freqs = [];
  for (let i = 0; i <= n; i++) {
    const f = minF + (i / n) * (maxF - minF);
    if (!spikes.some(s => Math.abs(f - s.f) < spikeHalfWidth)) freqs.push(f);
  }
  // exact spike knot points: shoulder - peak - shoulder
  spikes.forEach(s => {
    freqs.push(s.f - spikeHalfWidth, s.f, s.f + spikeHalfWidth);
  });
  freqs.sort((a, b) => a - b);

  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1;
  ctx.beginPath();
  freqs.forEach((f, i) => {
    const spike = spikes.find(s => f === s.f);
    const val = spike ? spike.amp : Math.max(minY + 1, noiseFloor + (rng() - 0.5) * 9);
    const x = fx(f);
    const y = fy(val);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // highlight the DP peak tip in a distinct color, like the test-tone marker
  // in the reference screenshot
  if (dpKHz >= minF && dpKHz <= maxF) {
    const x = fx(dpKHz);
    ctx.strokeStyle = '#1f6fa8';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(x, fy(noiseFloor));
    ctx.lineTo(x, fy(point.level));
    ctx.stroke();
  }
}

// ─── DP-GRAM CANVAS ────────────────────────────────────────
const dpgramLayout = {}; // canvasId -> { points: [{x,y,data}], geom }

function drawDpGram(canvas, points, selectedIdx, layoutKey, ear) {
  const accent = ear === 'left' ? '#2f6fa8' : '#c0392b';
  const accentDark = ear === 'left' ? '#16324a' : '#7a2015';
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 40, padR = 16, padT = 20, padB = 26;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const minY = -40, maxY = 40;
  const freqs = points.map(p => p.f2);
  const minF = freqs[0] * 0.9, maxF = freqs[freqs.length - 1] * 1.15;

  ctx.strokeStyle = '#e6ebee';
  ctx.lineWidth = 1;
  [-40, -30, -20, -10, 0, 10, 20, 30, 40].forEach(v => {
    const y = linScaleY(v, minY, maxY, padT, plotH);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    ctx.fillStyle = '#889';
    ctx.font = '11px Arial';
    ctx.textAlign = 'right';
    ctx.fillText(String(v), padL - 8, y + 3);
  });

  ctx.strokeStyle = '#c7d0d5';
  ctx.beginPath(); ctx.rect(padL, padT, plotW, plotH); ctx.stroke();

  ctx.fillStyle = '#556';
  ctx.textAlign = 'left';
  ctx.fillText('dB SPL', padL, padT - 6);

  freqs.forEach(f => {
    const x = logScaleX(f, minF, maxF, padL, plotW);
    ctx.fillStyle = '#889';
    ctx.textAlign = 'center';
    const label = f >= 1000 ? (f / 1000).toString() : f.toString();
    ctx.fillText(label, x, h - 8);
  });
  ctx.fillStyle = '#556';
  ctx.textAlign = 'right';
  ctx.fillText('kHz', padL + plotW, h - 8);

  // -5 dB SPL presence reference line (no pass/fail marker, just the raw reference)
  const refY = linScaleY(-5, minY, maxY, padT, plotH);
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#8a8a8a';
  ctx.beginPath(); ctx.moveTo(padL, refY); ctx.lineTo(padL + plotW, refY); ctx.stroke();
  ctx.setLineDash([]);

  // shaded noise floor band
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = logScaleX(p.f2, minF, maxF, padL, plotW);
    const y = linScaleY(p.noise, minY, maxY, padT, plotH);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  const lastX = logScaleX(points[points.length - 1].f2, minF, maxF, padL, plotW);
  ctx.lineTo(lastX, padT + plotH);
  ctx.lineTo(logScaleX(points[0].f2, minF, maxF, padL, plotW), padT + plotH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(120,120,120,0.18)';
  ctx.fill();

  // DP line + points
  const coords = points.map(p => ({
    x: logScaleX(p.f2, minF, maxF, padL, plotW),
    y: linScaleY(p.level, minY, maxY, padT, plotH),
    data: p
  }));

  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  coords.forEach((c, i) => { if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y); });
  ctx.stroke();

  coords.forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(c.x, c.y, i === selectedIdx ? 6 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = i === selectedIdx ? accentDark : accent;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  dpgramLayout[layoutKey] = { coords, canvas };
}

function hitTestDpGram(layoutKey, clientX, clientY) {
  const layout = dpgramLayout[layoutKey];
  if (!layout) return -1;
  const rect = layout.canvas.getBoundingClientRect();
  const x = clientX - rect.left, y = clientY - rect.top;
  let best = -1, bestDist = 12;
  layout.coords.forEach((c, i) => {
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

// ─── SUMMARY TABLE ──────────────────────────────────────────
function renderSummaryTable(points, selectedIdx) {
  const tbody = els['summary-tbody'];
  tbody.innerHTML = '';
  points.forEach((p, i) => {
    const tr = document.createElement('tr');
    if (i === selectedIdx) tr.classList.add('selected-row');
    tr.innerHTML =
      '<td>' + p.f2 + '</td>' +
      '<td>' + p.level.toFixed(1) + '</td>' +
      '<td>' + p.snr.toFixed(1) + '</td>' +
      '<td>' + p.l1 + '</td>' +
      '<td>' + p.l2 + '</td>' +
      '<td>' + p.reliability.toFixed(1) + '</td>';
    tr.addEventListener('click', () => { state.selectedIndex = i; renderSingleView(); });
    tbody.appendChild(tr);
  });
}

// ─── TOOLTIP ─────────────────────────────────────────────────
function showTooltip(clientX, clientY, point) {
  const tt = els['tooltip'];
  const dpFreq = 2 * point.f1 - point.f2;
  tt.innerHTML =
    '<table>' +
    row('DP frequency', dpFreq + ' Hz') +
    row('DP SNR', point.snr.toFixed(1) + ' dB') +
    row('DP level', point.level.toFixed(1) + ' dB SPL') +
    row('Residual noise', point.noise.toFixed(1) + ' dB SPL') +
    row('Frequency 1', point.f1 + ' Hz') +
    row('Level 1', point.l1 + ' dB SPL') +
    row('Frequency 2', point.f2 + ' Hz') +
    row('Level 2', point.l2 + ' dB SPL') +
    row('DP reliability', point.reliability.toFixed(1) + ' %') +
    '</table>';
  tt.style.display = 'block';
  const pad = 14;
  let x = clientX + pad, y = clientY + pad;
  const rect = tt.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight) y = clientY - rect.height - pad;
  tt.style.left = x + 'px';
  tt.style.top = y + 'px';

  function row(label, val) {
    return '<tr><td class="tt-label">' + label + '</td><td class="tt-val">' + val + '</td></tr>';
  }
}
function hideTooltip() { els['tooltip'].style.display = 'none'; }

// ─── RENDER ORCHESTRATION ────────────────────────────────────
function renderSingleView() {
  if (!state.currentPatient) return;
  const points = getEarPoints(state.currentPatient, state.ear, state.protocolKey);
  if (state.selectedIndex >= points.length) state.selectedIndex = 0;
  const seedKey = state.currentPatient.id + '|' + state.ear;

  drawProbeCheck(els['probe-canvas'], seedKey, '#e0842a');
  drawResponse(els['response-canvas'], points[state.selectedIndex], seedKey, state.selectedIndex);
  drawDpGram(els['dpgram-canvas'], points, state.selectedIndex, 'single', state.ear);
  renderSummaryTable(points, state.selectedIndex);
}

function renderBinauralView() {
  if (!state.currentPatient) return;
  ['right', 'left'].forEach(ear => {
    const points = getEarPoints(state.currentPatient, ear, state.protocolKey);
    if (state.binSelected[ear] >= points.length) state.binSelected[ear] = 0;
    const idx = state.binSelected[ear];
    const seedKey = state.currentPatient.id + '|' + ear;
    drawProbeCheck(els['bin-' + ear + '-probe-canvas'], seedKey, ear === 'left' ? '#2f6fa8' : '#c0392b');
    drawResponse(els['bin-' + ear + '-response-canvas'], points[idx], seedKey, idx);
    drawDpGram(els['bin-' + ear + '-dpgram-canvas'], points, idx, 'bin-' + ear, ear);
  });
}

function renderAll() {
  if (state.binaural) renderBinauralView(); else renderSingleView();
}

// ─── VIEW / MODE SWITCHING ───────────────────────────────────
function setEar(ear) {
  state.ear = ear;
  els['ear-right-btn'].classList.toggle('active', ear === 'right');
  els['ear-left-btn'].classList.toggle('active', ear === 'left');
  renderSingleView();
}

function setBinaural(on) {
  state.binaural = on;
  els['binaural-btn'].classList.toggle('active', on);
  els['single-view'].style.display = on ? 'none' : 'flex';
  els['binaural-view'].style.display = on ? 'flex' : 'none';
  renderAll();
}

// ─── TOAST ───────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, duration) {
  const t = els['toast'];
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, duration || 2200);
}

// ─── PRINT SUMMARY ───────────────────────────────────────────
function printSummary() {
  if (!state.currentPatient) return;
  const proto = PROTOCOLS[state.protocolKey];
  let html = '<h2>DPOAE Summary — ' + state.currentPatient.name + '</h2>';
  html += '<p>Protocol: ' + proto.name + ' | L1/L2: ' + proto.l1 + '/' + proto.l2 + ' dB SPL | f2/f1: ' + proto.f2f1Ratio + '</p>';
  ['right', 'left'].forEach(ear => {
    const points = getEarPoints(state.currentPatient, ear, state.protocolKey);
    html += '<h3>' + ear.charAt(0).toUpperCase() + ear.slice(1) + ' ear</h3>';
    html += '<table border="1" cellpadding="4" style="border-collapse:collapse;"><tr><th>f2 (Hz)</th><th>Level (dB SPL)</th><th>SNR (dB)</th><th>Noise (dB SPL)</th></tr>';
    points.forEach(p => {
      html += '<tr><td>' + p.f2 + '</td><td>' + p.level.toFixed(1) + '</td><td>' + p.snr.toFixed(1) + '</td><td>' + p.noise.toFixed(1) + '</td></tr>';
    });
    html += '</table>';
  });
  els['print-summary'].innerHTML = html;
  const oldTitle = document.title;
  document.title = 'dpoae-sim ' + state.currentPatient.name;
  window.print();
  document.title = oldTitle;
}

// ─── EVENTS ──────────────────────────────────────────────────
function attachEvents() {
  els['patient-select'].addEventListener('change', e => selectPatient(Number(e.target.value)));
  els['protocol-select'].addEventListener('change', e => {
    state.protocolKey = e.target.value;
    state.selectedIndex = 0;
    state.binSelected = { right: 0, left: 0 };
    renderAll();
  });
  els['ear-right-btn'].addEventListener('click', () => setEar('right'));
  els['ear-left-btn'].addEventListener('click', () => setEar('left'));
  els['binaural-btn'].addEventListener('click', () => setBinaural(!state.binaural));
  els['share-btn'].addEventListener('click', shareCurrentCase);
  els['admin-btn'].addEventListener('click', () => { window.location.href = 'admin.html'; });
  els['print-btn'].addEventListener('click', printSummary);
  els['start-btn'].addEventListener('click', () => {
    state.started = !state.started;
    els['start-btn'].textContent = state.started ? 'PAUSE' : 'START';
    els['start-btn'].classList.toggle('running', state.started);
    state.seedBase = Date.now();
    renderAll();
    showToast(state.started ? 'Test running' : 'Test paused');
  });

  els['dpgram-canvas'].addEventListener('click', e => {
    const idx = hitTestDpGram('single', e.clientX, e.clientY);
    if (idx >= 0) { state.selectedIndex = idx; renderSingleView(); }
  });

  ['right', 'left'].forEach(ear => {
    const canvas = els['bin-' + ear + '-dpgram-canvas'];
    canvas.addEventListener('mousemove', e => {
      const idx = hitTestDpGram('bin-' + ear, e.clientX, e.clientY);
      if (idx >= 0) {
        const points = getEarPoints(state.currentPatient, ear, state.protocolKey);
        showTooltip(e.clientX, e.clientY, points[idx]);
      } else {
        hideTooltip();
      }
    });
    canvas.addEventListener('mouseleave', hideTooltip);
    canvas.addEventListener('click', e => {
      const idx = hitTestDpGram('bin-' + ear, e.clientX, e.clientY);
      if (idx >= 0) { state.binSelected[ear] = idx; renderBinauralView(); }
    });
  });

  window.addEventListener('resize', () => renderAll());
}

// ─── INIT ────────────────────────────────────────────────────
(async function init() {
  cacheEls();
  await loadPatients();
  const sharedLoaded = await tryLoadSharedCase();
  populatePatientSelect();
  populateProtocolSelect();
  attachEvents();
  selectPatient(0);
  if (sharedLoaded) showToast('Loaded shared case: ' + state.currentPatient.name);
})();
