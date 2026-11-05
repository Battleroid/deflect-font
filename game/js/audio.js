// DEFLECT - sound engine. Everything synthesised at runtime with Web Audio.
// Target feel: 1983 arcade cabinet. Square/pulse waves, hard envelopes, noise bursts.
// No samples, no network, no libs.

let ctx = null;
let master = null;      // final gain (volume * !muted)
let comp = null;        // light master compressor so stacked shots don't clip
let noiseBuf = null;    // one shared noise buffer, built once
let volume = 0.8;
let muted = false;
let engine = null;      // { osc, sub, lfoGain, gain, filter } or null
let rateMul = 1;        // pitch multiplier for the sound currently being scheduled

const CLAMP = (v, a, b) => (v < a ? a : v > b ? b : v);
const rnd = (a, b) => a + Math.random() * (b - a);

/* ---------- plumbing ---------- */

function buildNoise() {
  // 1s of white noise, reused by every burst via playbackRate/offset variation.
  const len = ctx.sampleRate | 0;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// Everything terminates here. `pan` costs one node and is skipped when unused
// or unsupported (old Safari has no StereoPannerNode).
function out(pan) {
  if (!pan || !ctx.createStereoPanner) return master;
  const p = ctx.createStereoPanner();
  p.pan.value = CLAMP(pan, -1, 1);
  p.connect(master);
  stopLater(p, 4);
  return p;
}

// Nodes are fire-and-forget; disconnect on a timer so they can be GC'd.
function stopLater(node, after) {
  setTimeout(() => { try { node.disconnect(); } catch (e) {} }, after * 1000);
}

function osc(type, freq, dest, t, dur, peak, opts = {}) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq * rateMul, t);
  if (opts.to) {
    // exponentialRamp reads as a musical sweep; linear sounds synthetic/flat.
    o.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to * rateMul), t + (opts.sweep || dur));
  }
  if (opts.detune) o.detune.value = opts.detune;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + (opts.attack || 0.004));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + dur + 0.02);
  o.onended = () => { try { o.disconnect(); g.disconnect(); } catch (e) {} };
  return o;
}

function noise(dest, t, dur, peak, opts = {}) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  s.playbackRate.value = (opts.rate || 1) * rateMul;
  // Random offset into the shared buffer so repeated bursts aren't identical.
  const g = ctx.createGain();
  let node = s;
  if (opts.filter) {
    const f = ctx.createBiquadFilter();
    f.type = opts.filter;
    f.frequency.setValueAtTime((opts.freq || 1000) * rateMul, t);
    if (opts.freqTo) f.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqTo * rateMul), t + dur);
    f.Q.value = opts.q == null ? 1 : opts.q;
    node.connect(f);
    node = f;
  }
  g.gain.setValueAtTime(peak, t);
  if (opts.attack) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + opts.attack);
  }
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  node.connect(g).connect(dest);
  s.start(t, rnd(0, 0.8), dur + 0.02);
  s.onended = () => { try { s.disconnect(); g.disconnect(); } catch (e) {} };
  return s;
}

// Short melodic phrase helper for fanfares / UI.
function notes(dest, t, list, type, peak, len) {
  for (const n of list) {
    osc(type, n[0], dest, t + n[1], n[2] || len, peak, n[3] || {});
  }
}

/* ---------- the sounds ---------- */

const SOUNDS = {
  // Gun: a transient click (square, very short) for the crack, a sine thump for
  // the muzzle pressure, and a filtered noise blast for the blast wave.
  'fire.ap'(d, t, g) {
    osc('square', 820, d, t, 0.07, 0.5 * g, { to: 90, sweep: 0.06, attack: 0.001 });
    osc('sine', 150, d, t, 0.22, 0.75 * g, { to: 40, attack: 0.002 });
    noise(d, t, 0.14, 0.5 * g, { filter: 'lowpass', freq: 3800, freqTo: 400 });
  },
  'fire.he'(d, t, g) {
    osc('square', 560, d, t, 0.09, 0.42 * g, { to: 70, sweep: 0.08, attack: 0.001 });
    osc('sine', 105, d, t, 0.34, 0.85 * g, { to: 30, attack: 0.003 });
    noise(d, t, 0.26, 0.55 * g, { filter: 'lowpass', freq: 2200, freqTo: 220 });
  },
  'fire.heat'(d, t, g) {
    // Metallic/zippy: pulse-ish sawtooth crack plus a bandpassed hiss that
    // sweeps up, which is what sells "shaped charge jet" over "big bang".
    osc('sawtooth', 1400, d, t, 0.08, 0.4 * g, { to: 180, sweep: 0.07, attack: 0.001 });
    osc('square', 2600, d, t, 0.05, 0.18 * g, { to: 900, attack: 0.001 });
    osc('sine', 135, d, t, 0.18, 0.6 * g, { to: 45 });
    noise(d, t, 0.18, 0.4 * g, { filter: 'bandpass', freq: 1200, freqTo: 4200, q: 2 });
  },
  'fire.canister'(d, t, g) {
    // Shotgun: almost all noise, wide open filter, no tonal pitch to speak of.
    noise(d, t, 0.3, 0.8 * g, { filter: 'highpass', freq: 500, freqTo: 1600 });
    noise(d, t, 0.1, 0.5 * g, { filter: 'lowpass', freq: 5000, freqTo: 900 });
    osc('square', 300, d, t, 0.06, 0.3 * g, { to: 60, attack: 0.001 });
  },

  // Coax MG: one tick only. Two cheap nodes, randomised pitch/length so a
  // 10/sec burst sounds like a gun rather than a looping buzz.
  mg(d, t, g) {
    const dur = rnd(0.035, 0.06);
    noise(d, t, dur, 0.3 * g, { filter: 'bandpass', freq: rnd(1400, 2600), q: 1.2 });
    osc('square', rnd(260, 400), d, t, dur * 0.8, 0.22 * g, { to: 110, attack: 0.001 });
  },

  // RICOCHET - signature sound. The read comes from three things together:
  // (1) an UPWARD pitch sweep (downward = impact, upward = deflection/escape),
  // (2) a very hard attack, and (3) a high-Q resonant tail that rings on after
  // the body has died, which is the "spang" of steel.
  ricochet(d, t, g) {
    const base = rnd(900, 1300);
    osc('square', base, d, t, 0.1, 0.4 * g, { to: base * 3.2, sweep: 0.08, attack: 0.001 });
    osc('square', base * 1.5, d, t, 0.07, 0.2 * g, { to: base * 4.1, sweep: 0.06, attack: 0.001 });
    noise(d, t, 0.05, 0.35 * g, { filter: 'highpass', freq: 2000 });
    // Ring-out: inharmonic pair beating against each other = metal, not a bell.
    const ringF = base * 2.6;
    osc('triangle', ringF, d, t + 0.02, 0.5, 0.18 * g, { attack: 0.005 });
    osc('triangle', ringF * 1.47, d, t + 0.02, 0.42, 0.12 * g, { attack: 0.005 });
  },

  // Non-penetration: same impact energy, but everything above ~400Hz removed
  // and NO ring tail. The absence of the ring is what makes it read as "dead".
  nonpen(d, t, g) {
    osc('sine', 120, d, t, 0.16, 0.7 * g, { to: 55, attack: 0.003 });
    noise(d, t, 0.1, 0.45 * g, { filter: 'lowpass', freq: 400, freqTo: 120 });
    osc('triangle', 70, d, t, 0.1, 0.3 * g);
  },

  // Penetration: bright crack through the plate, then a crunchy burst of
  // spalling behind it.
  pen(d, t, g) {
    osc('square', 1800, d, t, 0.045, 0.35 * g, { to: 300, attack: 0.0005 });
    osc('sine', 180, d, t, 0.12, 0.5 * g, { to: 60 });
    noise(d, t + 0.02, 0.16, 0.45 * g, { filter: 'bandpass', freq: 2400, freqTo: 700, q: 0.8 });
  },

  explosion(d, t, g) {
    noise(d, t, 0.55, 0.85 * g, { filter: 'lowpass', freq: 2600, freqTo: 180, attack: 0.006 });
    osc('sine', 170, d, t, 0.5, 0.8 * g, { to: 28, attack: 0.004 });
    osc('square', 110, d, t, 0.14, 0.3 * g, { to: 35, attack: 0.001 });
  },
  explosionBig(d, t, g) {
    noise(d, t, 1.1, 0.95 * g, { filter: 'lowpass', freq: 2000, freqTo: 90, attack: 0.012 });
    osc('sine', 120, d, t, 1.0, 0.9 * g, { to: 20, attack: 0.008 });
    osc('sawtooth', 70, d, t, 0.45, 0.3 * g, { to: 22 });
    // Second, later thump = the ammo rack going up after the initial hit.
    osc('sine', 90, d, t + 0.18, 0.7, 0.55 * g, { to: 18, attack: 0.01 });
  },

  infantryDie(d, t, g) {
    osc('square', 640, d, t, 0.07, 0.25 * g, { to: 180, attack: 0.001 });
    noise(d, t + 0.05, 0.1, 0.2 * g, { filter: 'bandpass', freq: 900, freqTo: 300 });
  },

  // Player hit: low body-blow plus a tritone-ish pair. Dissonance is the alarm;
  // it cuts through the rest of the mix without needing to be loud.
  hitTaken(d, t, g) {
    osc('sine', 140, d, t, 0.3, 0.8 * g, { to: 45, attack: 0.002 });
    noise(d, t, 0.14, 0.4 * g, { filter: 'lowpass', freq: 1400, freqTo: 200 });
    osc('square', 330, d, t + 0.02, 0.3, 0.2 * g);
    osc('square', 466, d, t + 0.02, 0.3, 0.2 * g);
  },

  // Breech closing: two clicks, second higher = "ready", a rising gesture.
  reloadDone(d, t, g) {
    osc('square', 420, d, t, 0.045, 0.3 * g, { attack: 0.001 });
    noise(d, t, 0.03, 0.2 * g, { filter: 'highpass', freq: 3000 });
    osc('square', 700, d, t + 0.085, 0.07, 0.3 * g, { attack: 0.001 });
    noise(d, t + 0.085, 0.03, 0.2 * g, { filter: 'highpass', freq: 4000 });
  },

  select(d, t, g) {
    osc('square', 1100, d, t, 0.06, 0.25 * g, { to: 1600, sweep: 0.05, attack: 0.001 });
  },
  denied(d, t, g) {
    // Detuned low squares beating = buzz, cheaper than any real distortion.
    osc('square', 150, d, t, 0.14, 0.3 * g);
    osc('square', 150, d, t, 0.14, 0.3 * g, { detune: 35 });
  },

  waveStart(d, t, g) {
    // Martial rising fifth-ish: G - C - E, short and stabbed.
    notes(d, t, [[392, 0], [523, 0.13], [659, 0.26, 0.3]], 'square', 0.26 * g, 0.12);
    osc('sine', 98, d, t, 0.5, 0.35 * g);
  },
  waveClear(d, t, g) {
    // C - E - G - C resolve, brighter pulse timbre.
    notes(d, t, [[523, 0], [659, 0.1], [784, 0.2], [1047, 0.3, 0.38]], 'square', 0.24 * g, 0.1);
  },
  gameOver(d, t, g) {
    // Descending and slowing: each step is longer and lower, which is what
    // makes it read as "winding down / defeated" rather than just sad.
    const seq = [[440, 0, 0.26], [370, 0.26, 0.3], [294, 0.6, 0.36], [196, 1.0, 0.55]];
    for (const [f, o, dur] of seq) {
      osc('square', f, d, t + o, dur, 0.28 * g, { attack: 0.006 });
      osc('triangle', f / 2, d, t + o, dur, 0.18 * g, { attack: 0.006 });
    }
  },
  pickup(d, t, g) {
    notes(d, t, [[523, 0], [659, 0.055], [784, 0.11], [1047, 0.165, 0.2]], 'square', 0.22 * g, 0.07);
  },
};

/* ---------- public API ---------- */

export const Audio = {
  init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    if (ctx.createDynamicsCompressor) {
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 6;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;
      master.connect(comp).connect(ctx.destination);
    } else {
      master.connect(ctx.destination);
    }
    noiseBuf = buildNoise();
  },

  resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  },

  get ready() {
    return !!ctx && ctx.state === 'running';
  },

  setMuted(m) {
    muted = !!m;
    if (master) master.gain.value = muted ? 0 : volume;
  },
  toggleMute() {
    Audio.setMuted(!muted);
    return muted;
  },
  setVolume(v) {
    volume = CLAMP(Number(v) || 0, 0, 1);
    if (master) master.gain.value = muted ? 0 : volume;
  },

  // Never throws: unknown names and a missing context are silent no-ops, because
  // this is called from gameplay code at ~10Hz and must not be a failure point.
  play(name, opts = {}) {
    if (!ctx || muted) return;
    const fn = SOUNDS[name];
    if (!fn) return;
    try {
      const dest = out(opts.pan);
      const t = ctx.currentTime + 0.001;
      const g = opts.gain == null ? 1 : CLAMP(opts.gain, 0, 4);
      // `rate` is a pitch multiplier applied inside osc()/noise() via rateMul.
      // All scheduling below is synchronous, so a module-level flag is safe and
      // avoids threading an extra argument through every sound definition.
      rateMul = opts.rate ? CLAMP(opts.rate, 0.25, 4) : 1;
      try { fn(dest, t, g); } finally { rateMul = 1; }
    } catch (e) { /* audio must never break the game loop */ }
  },

  engineStart() {
    if (!ctx || engine) return;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    // Kept dark and quiet so it sits under the gun and never masks it.
    f.frequency.value = 500;
    f.Q.value = 2;
    f.connect(g).connect(master);

    // Square at ~48Hz for the chug, plus a detuned saw for grit. Two oscillators
    // only; throttle just ramps their params, never allocates.
    const o1 = ctx.createOscillator();
    o1.type = 'square';
    o1.frequency.value = 48;
    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth';
    o2.frequency.value = 48 * 1.5;
    o2.detune.value = 18;
    const o2g = ctx.createGain();
    o2g.gain.value = 0.35;
    o1.connect(f);
    o2.connect(o2g).connect(f);
    o1.start();
    o2.start();
    g.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.25);
    engine = { o1, o2, o2g, g, f };
  },

  engineThrottle(t01) {
    if (!engine || !ctx) return;
    const t = CLAMP(Number(t01) || 0, 0, 1);
    const now = ctx.currentTime;
    const k = 0.08; // short ramp = responsive but no zipper noise
    const base = 44 + t * 52;            // idle chug up to a labouring roar
    engine.o1.frequency.setTargetAtTime(base, now, k);
    engine.o2.frequency.setTargetAtTime(base * 1.5, now, k);
    engine.f.frequency.setTargetAtTime(380 + t * 900, now, k);
    engine.g.gain.setTargetAtTime(0.075 + t * 0.085, now, k);
  },

  engineStop() {
    if (!engine || !ctx) return;
    const e = engine;
    engine = null;
    const now = ctx.currentTime;
    e.g.gain.cancelScheduledValues(now);
    e.g.gain.setTargetAtTime(0.0001, now, 0.12);
    e.o1.stop(now + 0.6);
    e.o2.stop(now + 0.6);
    e.o2.onended = () => {
      try { e.o1.disconnect(); e.o2.disconnect(); e.o2g.disconnect(); e.f.disconnect(); e.g.disconnect(); } catch (err) {}
    };
  },
};

export default Audio;
