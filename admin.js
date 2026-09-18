// ─── STATE ──────────────────────────────────────────────────
const PIN = '1234'; // supervisor PIN — casual deterrent only, not real security
const STORAGE_KEY = 'dpoae-patients';

const astate = {
  patients: [],
  editingId: null
};

// ─── PIN GATE ───────────────────────────────────────────────
(function checkPin() {
  if (sessionStorage.getItem('dpoae-admin-auth') === 'ok') return showAdmin();
  const entered = prompt('Enter supervisor PIN:');
  if (entered === PIN) {
    sessionStorage.setItem('dpoae-admin-auth', 'ok');
    showAdmin();
  } else {
    document.getElementById('pin-gate-msg').style.display = 'block';
  }
})();

function showAdmin() {
  document.getElementById('admin-root').style.display = 'block';
  initAdmin();
}

// ─── PERSISTENCE ────────────────────────────────────────────
function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data.length) return data;
    }
  } catch (e) { /* ignore */ }
  return JSON.parse(JSON.stringify(DEFAULT_PATIENTS));
}

function saveToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(astate.patients));
}

function setStatus(msg) {
  document.getElementById('status-msg').textContent = msg;
  setTimeout(() => { document.getElementById('status-msg').textContent = ''; }, 3000);
}

// ─── RENDER PATIENT LIST ─────────────────────────────────────
function renderPatientList() {
  const list = document.getElementById('patient-list');
  list.innerHTML = '';
  astate.patients.forEach(p => {
    const row = document.createElement('div');
    row.className = 'patient-row' + (p.id === astate.editingId ? ' active' : '');
    row.innerHTML = '<span>' + p.name + '</span>';
    row.addEventListener('click', () => { astate.editingId = p.id; renderPatientList(); renderEditor(); });
    list.appendChild(row);
  });
}

// ─── EDITOR ──────────────────────────────────────────────────
function populateProtocolSelect() {
  const sel = document.getElementById('pt-protocol');
  sel.innerHTML = '';
  Object.keys(PROTOCOLS).forEach(key => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = PROTOCOLS[key].name;
    sel.appendChild(opt);
  });
}

function blankPatient() {
  return {
    id: 'case-' + Date.now(),
    name: 'New patient',
    protocol: DEFAULT_PROTOCOL,
    ears: { right: { points: [] }, left: { points: [] } }
  };
}

function getEditingPatient() {
  return astate.patients.find(p => p.id === astate.editingId) || null;
}

function ensurePointsLength(patient) {
  const proto = PROTOCOLS[patient.protocol];
  ['right', 'left'].forEach(ear => {
    const pts = patient.ears[ear].points;
    while (pts.length < proto.points.length) pts.push({ present: false });
    pts.length = proto.points.length;
  });
}

function renderEditor() {
  const patient = getEditingPatient();
  const container = document.getElementById('ears-container');
  if (!patient) {
    document.getElementById('pt-name').value = '';
    container.innerHTML = '';
    return;
  }
  ensurePointsLength(patient);
  document.getElementById('pt-name').value = patient.name;
  document.getElementById('pt-protocol').value = patient.protocol;

  const proto = PROTOCOLS[patient.protocol];
  container.innerHTML = '';
  ['right', 'left'].forEach(ear => {
    const block = document.createElement('div');
    block.className = 'ear-block';
    block.innerHTML = '<h3>' + ear.charAt(0).toUpperCase() + ear.slice(1) + ' ear</h3>';

    const table = document.createElement('table');
    table.className = 'pt-table';
    let thead = '<tr><th>f2 (Hz)</th><th>Present</th><th>Level override (dB SPL)</th><th>SNR override (dB)</th><th>Noise override (dB SPL)</th><th>Reliability override (%)</th></tr>';
    let rows = '';
    proto.points.forEach((f2, idx) => {
      const pt = patient.ears[ear].points[idx] || { present: false };
      rows += '<tr data-ear="' + ear + '" data-idx="' + idx + '">' +
        '<td>' + f2 + '</td>' +
        '<td><input type="checkbox" class="pt-present" ' + (pt.present ? 'checked' : '') + '></td>' +
        '<td><input type="number" class="pt-level" step="0.1" value="' + (pt.level ?? '') + '" placeholder="auto"></td>' +
        '<td><input type="number" class="pt-snr" step="0.1" value="' + (pt.snr ?? '') + '" placeholder="auto"></td>' +
        '<td><input type="number" class="pt-noise" step="0.1" value="' + (pt.noise ?? '') + '" placeholder="auto"></td>' +
        '<td><input type="number" class="pt-reliability" step="0.1" min="0" max="100" value="' + (pt.reliability ?? '') + '" placeholder="98-100"></td>' +
        '</tr>';
    });
    table.innerHTML = thead + rows;
    block.appendChild(table);
    container.appendChild(block);
  });
}

function readEditorIntoPatient() {
  const patient = getEditingPatient();
  if (!patient) return;
  patient.name = document.getElementById('pt-name').value || 'Unnamed patient';
  const newProtocol = document.getElementById('pt-protocol').value;
  if (newProtocol !== patient.protocol) {
    patient.protocol = newProtocol;
    ensurePointsLength(patient);
    renderEditor();
    return; // re-render triggers fresh read on next save
  }

  document.querySelectorAll('#ears-container tr[data-ear]').forEach(tr => {
    const ear = tr.getAttribute('data-ear');
    const idx = Number(tr.getAttribute('data-idx'));
    const present = tr.querySelector('.pt-present').checked;
    const level = tr.querySelector('.pt-level').value;
    const snr = tr.querySelector('.pt-snr').value;
    const noise = tr.querySelector('.pt-noise').value;
    const reliability = tr.querySelector('.pt-reliability').value;
    const pt = { present };
    if (level !== '') pt.level = parseFloat(level);
    if (snr !== '') pt.snr = parseFloat(snr);
    if (noise !== '') pt.noise = parseFloat(noise);
    if (reliability !== '') pt.reliability = parseFloat(reliability);
    patient.ears[ear].points[idx] = pt;
  });
}

// ─── CRUD ────────────────────────────────────────────────────
function newPatient() {
  const p = blankPatient();
  ensurePointsLength(p);
  astate.patients.push(p);
  astate.editingId = p.id;
  renderPatientList();
  renderEditor();
}

function savePatient() {
  readEditorIntoPatient();
  saveToStorage();
  renderPatientList();
  setStatus('Saved.');
}

function deletePatient() {
  if (!astate.editingId) return;
  if (!confirm('Delete this patient?')) return;
  astate.patients = astate.patients.filter(p => p.id !== astate.editingId);
  astate.editingId = astate.patients.length ? astate.patients[0].id : null;
  saveToStorage();
  renderPatientList();
  renderEditor();
  setStatus('Deleted.');
}

// ─── EXPORT / IMPORT ─────────────────────────────────────────
function exportPatients() {
  const blob = new Blob([JSON.stringify(astate.patients, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'patients.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setStatus('Exported patients.json — commit this file to the repo root to distribute it.');
}

function importPatients(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data)) throw new Error('not an array');
      astate.patients = data;
      astate.editingId = data.length ? data[0].id : null;
      saveToStorage();
      renderPatientList();
      renderEditor();
      setStatus('Imported ' + data.length + ' patients.');
    } catch (e) {
      setStatus('Import failed: invalid JSON.');
    }
  };
  reader.readAsText(file);
}

// ─── INIT ────────────────────────────────────────────────────
function initAdmin() {
  astate.patients = loadFromStorage();
  astate.editingId = astate.patients.length ? astate.patients[0].id : null;
  populateProtocolSelect();
  renderPatientList();
  renderEditor();

  document.getElementById('new-patient-btn').addEventListener('click', newPatient);
  document.getElementById('save-btn').addEventListener('click', savePatient);
  document.getElementById('delete-btn').addEventListener('click', deletePatient);
  document.getElementById('export-btn').addEventListener('click', exportPatients);
  document.getElementById('pt-protocol').addEventListener('change', () => {
    readEditorIntoPatient();
  });

  const importBtn = document.getElementById('import-btn');
  const importFile = document.getElementById('import-file');
  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', e => {
    if (e.target.files[0]) importPatients(e.target.files[0]);
  });
}
