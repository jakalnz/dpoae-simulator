// ─── PROTOCOLS ─────────────────────────────────────────────
// Each protocol defines the f2 test frequencies (Hz), the f2/f1 ratio,
// and the default stimulus levels (L1/L2, dB SPL).
const PROTOCOLS = {
  'dp1_6': {
    name: 'DP 1 - 6 kHz',
    points: [1000, 1500, 2000, 3000, 4000, 6000],
    f2f1Ratio: 1.22,
    l1: 65,
    l2: 55
  },
  'dp0_5_10': {
    name: 'DP 0.5 - 10 kHz (12 freq...)',
    points: [500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000],
    f2f1Ratio: 1.22,
    l1: 65,
    l2: 55
  }
};

const DEFAULT_PROTOCOL = 'dp1_6';

// ─── DEFAULT PATIENTS ──────────────────────────────────────
// points: array aligned to PROTOCOLS[protocol].points, each entry:
//   { present: bool, level, snr, noise } — level/snr/noise are optional
//   manual overrides; when omitted app.js generates plausible values.
const DEFAULT_PATIENTS = [
  {
    id: 'normal-both',
    name: 'Sample Normal (both ears)',
    protocol: 'dp1_6',
    ears: {
      right: { points: [
        { present: true }, { present: true }, { present: true },
        { present: true }, { present: true }, { present: true }
      ] },
      left: { points: [
        { present: true }, { present: true }, { present: true },
        { present: true }, { present: true }, { present: true }
      ] }
    }
  },
  {
    id: 'absent-both',
    name: 'Sample Absent (both ears)',
    protocol: 'dp1_6',
    ears: {
      right: { points: [
        { present: false }, { present: false }, { present: false },
        { present: false }, { present: false }, { present: false }
      ] },
      left: { points: [
        { present: false }, { present: false }, { present: false },
        { present: false }, { present: false }, { present: false }
      ] }
    }
  },
  {
    id: 'notch-right',
    name: 'Sample High-Frequency Notch (right ear)',
    protocol: 'dp1_6',
    ears: {
      right: { points: [
        { present: true }, { present: true }, { present: true },
        { present: false }, { present: false }, { present: true }
      ] },
      left: { points: [
        { present: true }, { present: true }, { present: true },
        { present: true }, { present: true }, { present: true }
      ] }
    }
  },
  {
    id: 'wideband-mixed',
    name: 'Sample Wideband Mixed (0.5-10kHz)',
    protocol: 'dp0_5_10',
    ears: {
      right: { points: [
        { present: true }, { present: true }, { present: true }, { present: true },
        { present: true }, { present: true }, { present: true }, { present: false },
        { present: false }, { present: false }, { present: false }, { present: false },
        { present: false }
      ] },
      left: { points: [
        { present: true }, { present: true }, { present: true }, { present: true },
        { present: true }, { present: true }, { present: true }, { present: true },
        { present: true }, { present: true }, { present: false }, { present: false },
        { present: false }
      ] }
    }
  }
];
