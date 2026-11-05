/* DEFLECT -- the DOM overlay.
 *
 * Built once in init(), then only text / class / transform is touched. Nothing
 * here knows a colour: every fill, outline and weight lives in hud.css, which
 * reads the CSS vars from style.css (the same values as palette.js). The only
 * thing imported is OUTCOME, for the default indicator wording.
 */

import { OUTCOME } from './palette.js';

/* ---------------------------------------------------------------- constants */

const ROUNDS = ['AP', 'HE', 'HEAT', 'CANISTER'];
const HULL_SEGMENTS = 12;
const POPUP_POOL = 64;
const LOUD = { ricochet: 1, crit: 1 };
const UNLIMITED = 'UNL';

const LVUP_SLOTS = 3;         // cards the chooser can ever show
const PIP_MAX = 8;            // rank pips per card; above this we fall back to text
const TAKEN_ROWS = 10;        // rows in the "already taken" list
const RARITIES = ['common', 'rare', 'epic'];

/* ------------------------------------------------------------------- state */

let root = null;
let built = false;

const n = {};                 // every node we ever touch
const ammoRows = {};          // round id -> { row, count }
const hullSegs = [];

const prev = {};              // last value written, per field
let prevHullFilled = -1;

const popups = [];            // the pool
let popupCursor = 0;
const live = [];              // active members of the pool

let bannerLeft = 0;
let flashLeft = 0;
let onRestart = null;
let cursorShown = false;

/* the level-up chooser */
const lvupCards = [];         // one entry per slot: { card, rar, name, desc, pips, ... }
let lvupChoices = [];
let lvupOpen = false;
let lvupPicked = false;       // belt and braces: onPick fires exactly once
let onPick = null;

/* the taken-upgrade list */
const takenRows = [];
const takenCache = [];        // mirror of the last list we wrote, so no string churn

/* ------------------------------------------------------------- tiny helpers */

function mk(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function add(parent, child) { parent.appendChild(child); return child; }

/* write text only when it actually changed */
function txt(node, value) {
  const v = String(value);
  if (node.__t !== v) { node.__t = v; node.textContent = v; }
}

/* toggle a class only when it actually changed */
function flag(node, name, on) {
  const key = '__c_' + name;
  const want = !!on;
  if (node[key] !== want) { node[key] = want; node.classList.toggle(name, want); }
}

/* bar fills are a scaleX on the inner element -- no layout, no repaint storm */
function fill(node, amount) {
  const a = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  const q = Math.round(a * 1000) / 1000;
  if (node.__f !== q) { node.__f = q; node.style.transform = 'scaleX(' + q + ')'; }
}

function place(node, x, y, scale) {
  node.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) translate(-50%,-50%)' +
    (scale === undefined ? '' : ' scale(' + scale + ')');
}

function countText(v) {
  if (v === undefined || v === null) return '0';
  if (v === Infinity) return UNLIMITED;
  return String(v);
}

function clock(seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds)) return String(seconds || '0:00');
  const t = Math.max(0, Math.floor(seconds));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/* restart a CSS animation on a node */
function retrigger(node, cls) {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

/* ------------------------------------------------------------------- build */

function buildCorners() {
  /* top left -- wave */
  const tl = add(root, mk('div', 'hud-block hud-tl'));
  add(tl, mk('div', 'hud-key', 'WAVE'));
  n.wave = add(tl, mk('div', 'hud-big', '1'));
  n.enemies = add(tl, mk('div', 'hud-meta', '0 HOSTILES'));

  /* top right -- score */
  const tr = add(root, mk('div', 'hud-block hud-tr'));
  add(tr, mk('div', 'hud-key', 'SCORE'));
  n.score = add(tr, mk('div', 'hud-big', '0'));
  n.kills = add(tr, mk('div', 'hud-meta', '0 KILLS'));

  /* bottom left -- hull */
  const bl = add(root, mk('div', 'hud-block hud-bl'));
  n.hull = bl;
  add(bl, mk('div', 'hud-key', 'HULL INTEGRITY'));
  const row = add(bl, mk('div', 'hull-row'));
  const bar = add(row, mk('div', 'hull-bar'));
  for (let i = 0; i < HULL_SEGMENTS; i++) hullSegs.push(add(bar, mk('i', 'seg on')));
  n.hullNum = add(row, mk('div', 'hull-num', '100'));

  /* bottom right -- rounds, reload, mg heat */
  const br = add(root, mk('div', 'hud-block hud-br'));
  add(br, mk('div', 'hud-key', 'AMMUNITION'));
  const list = add(br, mk('div', 'ammo-list'));
  for (let i = 0; i < ROUNDS.length; i++) {
    const id = ROUNDS[i];
    const r = add(list, mk('div', 'ammo-row'));
    add(r, mk('b', 'ammo-k', String(i + 1)));
    add(r, mk('span', 'ammo-n', id));
    const c = add(r, mk('span', 'ammo-c', '0'));
    ammoRows[id] = { row: r, count: c };
  }

  const gauges = add(br, mk('div', 'gauges'));

  const g1 = add(gauges, mk('div', 'gauge'));
  n.reloadLab = add(g1, mk('div', 'gauge-lab', 'RELOAD'));
  n.reloadBar = add(g1, mk('div', 'bar'));
  n.reloadFill = add(n.reloadBar, mk('i', 'bar-fill'));

  const g2 = add(gauges, mk('div', 'gauge'));
  n.mgLab = add(g2, mk('div', 'gauge-lab', 'COAX MG'));
  n.mgBar = add(g2, mk('div', 'bar'));
  n.mgFill = add(n.mgBar, mk('i', 'bar-fill'));
}

function buildReticle() {
  n.xhair = add(root, mk('div', 'hud-xhair'));
  add(n.xhair, mk('i', 'tick t'));
  add(n.xhair, mk('i', 'tick r'));
  add(n.xhair, mk('i', 'tick b'));
  add(n.xhair, mk('i', 'tick l'));
  add(n.xhair, mk('i', 'pip'));

  n.barrel = add(root, mk('div', 'hud-barrel'));
}

function buildPopups() {
  n.popLayer = add(root, mk('div', 'hud-popups'));
  for (let i = 0; i < POPUP_POOL; i++) {
    const node = add(n.popLayer, mk('div', 'hud-popup'));
    popups.push({
      node: node, kind: '', t: 0, ttl: 0, x: 0, y: 0,
      vx: 0, vy: 0, base: 1, loud: false, busy: false,
    });
  }
}

function buildBannerFlash() {
  n.banner = add(root, mk('div', 'hud-banner'));
  n.bannerTitle = add(n.banner, mk('div', 'banner-title', ''));
  n.bannerSub = add(n.banner, mk('div', 'banner-sub', ''));

  n.flash = add(root, mk('div', 'hud-flash'));
  add(n.flash, mk('i', 'edge t'));
  add(n.flash, mk('i', 'edge r'));
  add(n.flash, mk('i', 'edge b'));
  add(n.flash, mk('i', 'edge l'));
}

function buildGameOver() {
  n.over = add(root, mk('div', 'hud-over hidden'));
  const panel = add(n.over, mk('div', 'over-panel'));
  add(panel, mk('div', 'over-kicker', 'HULL BREACHED'));
  add(panel, mk('div', 'over-title', 'DESTROYED'));

  const grid = add(panel, mk('div', 'over-grid'));
  n.overStats = {};
  const fields = [['wave', 'WAVE REACHED'], ['score', 'SCORE'], ['kills', 'KILLS'], ['time', 'TIME']];
  for (let i = 0; i < fields.length; i++) {
    const cell = add(grid, mk('div', 'over-cell'));
    add(cell, mk('div', 'over-lab', fields[i][1]));
    n.overStats[fields[i][0]] = add(cell, mk('div', 'over-val', '0'));
  }

  n.restart = add(panel, mk('button', 'over-btn', 'REDEPLOY'));
  n.restart.type = 'button';
  n.restart.addEventListener('click', function () {
    const fn = onRestart;
    if (typeof fn === 'function') fn();
  });
}

/* A slim strip pinned to the very top edge: the experience bar, with the level
 * numeral under it. Deliberately nowhere near the hull bar or the ammo panel. */
function buildXp() {
  const strip = add(root, mk('div', 'hud-xp'));
  n.xpTrack = add(strip, mk('div', 'xp-track'));
  n.xpFill = add(n.xpTrack, mk('i', 'xp-fill'));
  n.xpLevel = add(strip, mk('div', 'xp-level', 'LVL 1'));
}

/* Upgrades already taken -- a quiet column down the left flank. */
function buildTaken() {
  n.taken = add(root, mk('div', 'hud-taken empty'));
  add(n.taken, mk('div', 'taken-key', 'MODS'));
  const list = add(n.taken, mk('div', 'taken-list'));
  for (let i = 0; i < TAKEN_ROWS; i++) {
    const row = add(list, mk('div', 'taken-row off'));
    const name = add(row, mk('span', 'tk-n', ''));
    const mult = add(row, mk('b', 'tk-x', ''));
    takenRows.push({ row: row, name: name, mult: mult });
  }
}

function buildLevelUp() {
  n.lvup = add(root, mk('div', 'hud-lvup hidden'));
  add(n.lvup, mk('i', 'lvup-dim'));

  const panel = add(n.lvup, mk('div', 'lvup-panel'));
  add(panel, mk('div', 'lvup-kicker', 'FIELD PROMOTION'));
  n.lvupTitle = add(panel, mk('div', 'lvup-title', 'LEVEL 2'));

  const cards = add(panel, mk('div', 'lvup-cards'));
  for (let i = 0; i < LVUP_SLOTS; i++) {
    const card = add(cards, mk('button', 'lvup-card r-common'));
    card.type = 'button';
    add(card, mk('b', 'card-key', String(i + 1)));
    const rar = add(card, mk('div', 'card-rar', 'COMMON'));
    const name = add(card, mk('div', 'card-name', ''));
    const desc = add(card, mk('div', 'card-desc', ''));
    const rank = add(card, mk('div', 'card-rank'));
    const pipRow = add(rank, mk('div', 'card-pips'));
    const pips = [];
    for (let p = 0; p < PIP_MAX; p++) pips.push(add(pipRow, mk('i', 'pip')));
    const rankTxt = add(rank, mk('span', 'card-rank-t', ''));

    /* the index is baked in, so a click can never resolve to another card */
    card.addEventListener('click', function () { choose(i); });

    lvupCards.push({
      card: card, rar: rar, name: name, desc: desc,
      pipRow: pipRow, pips: pips, rankTxt: rankTxt,
    });
  }

  add(panel, mk('div', 'lvup-hint', 'CLICK OR PRESS 1 - 3'));
}

/* --------------------------------------------------------------------- API */

export const HUD = {

  init(rootEl) {
    root = rootEl || document.getElementById('hud');
    if (!root) return;
    if (built) { root.classList.add('hud-ready'); return; }

    root.textContent = '';
    buildCorners();
    buildXp();
    buildTaken();
    buildPopups();
    buildBannerFlash();
    buildReticle();
    buildGameOver();
    buildLevelUp();
    root.classList.add('hud-ready');
    built = true;
  },

  /* ---- per frame, must stay cheap: everything diffs before it writes ---- */
  setStats(s) {
    if (!built || !s) return;

    if (prev.wave !== s.wave) { prev.wave = s.wave; txt(n.wave, s.wave); }

    if (prev.enemiesLeft !== s.enemiesLeft) {
      prev.enemiesLeft = s.enemiesLeft;
      const e = s.enemiesLeft || 0;
      txt(n.enemies, e + (e === 1 ? ' HOSTILE' : ' HOSTILES'));
      flag(n.enemies, 'clear', e <= 0);
    }

    if (prev.score !== s.score) { prev.score = s.score; txt(n.score, s.score); }

    if (prev.kills !== s.kills) {
      prev.kills = s.kills;
      txt(n.kills, (s.kills || 0) + ' KILLS');
    }

    /* hull */
    const hpMax = s.hpMax > 0 ? s.hpMax : 1;
    const hp = s.hp > 0 ? s.hp : 0;
    if (prev.hp !== hp || prev.hpMax !== hpMax) {
      prev.hp = hp;
      prev.hpMax = hpMax;
      const ratio = hp / hpMax;
      txt(n.hullNum, Math.ceil(ratio * 100));
      flag(n.hull, 'low', ratio <= 0.34);
      flag(n.hull, 'critical', ratio <= 0.15);
      const filled = hp <= 0 ? 0 : Math.max(1, Math.ceil(ratio * HULL_SEGMENTS));
      if (filled !== prevHullFilled) {
        /* only the segments that actually changed get touched */
        const from = prevHullFilled < 0 ? 0 : Math.min(filled, prevHullFilled);
        const to = prevHullFilled < 0 ? HULL_SEGMENTS : Math.max(filled, prevHullFilled);
        for (let i = from; i < to; i++) flag(hullSegs[i], 'on', i < filled);
        prevHullFilled = filled;
      }
    }

    /* rounds */
    if (prev.round !== s.round) {
      prev.round = s.round;
      for (let i = 0; i < ROUNDS.length; i++) {
        const id = ROUNDS[i];
        flag(ammoRows[id].row, 'sel', id === s.round);
      }
    }

    const ammo = s.ammo;
    if (ammo) {
      for (let i = 0; i < ROUNDS.length; i++) {
        const id = ROUNDS[i];
        const v = ammo[id];
        const key = 'ammo_' + id;
        if (prev[key] !== v) {
          prev[key] = v;
          const cell = ammoRows[id].count;
          txt(cell, countText(v));
          flag(cell, 'unlimited', v === Infinity);
          flag(ammoRows[id].row, 'empty', v === 0);
        }
      }
    }

    /* reload */
    if (prev.reload !== s.reload) {
      prev.reload = s.reload;
      const r = typeof s.reload === 'number' ? s.reload : 1;
      fill(n.reloadFill, r);
      const ready = r >= 1;
      flag(n.reloadBar, 'ready', ready);
      txt(n.reloadLab, ready ? 'GUN READY' : 'RELOAD');
      flag(n.reloadLab, 'ready', ready);
    }

    /* experience + level */
    if (prev.level !== s.level) {
      prev.level = s.level;
      const lv = typeof s.level === 'number' && s.level > 0 ? Math.floor(s.level) : 1;
      txt(n.xpLevel, 'LVL ' + lv);
    }

    if (prev.xp !== s.xp || prev.xpNext !== s.xpNext) {
      prev.xp = s.xp;
      prev.xpNext = s.xpNext;
      const need = typeof s.xpNext === 'number' && s.xpNext > 0 ? s.xpNext : 0;
      const got = typeof s.xp === 'number' && s.xp > 0 ? s.xp : 0;
      const ratio = need > 0 ? got / need : 0;
      fill(n.xpFill, ratio);
      flag(n.xpTrack, 'brimming', ratio >= 1);
    }

    /* upgrades taken -- compared field by field, so no per-frame allocation */
    if (takenChanged(s.taken)) writeTaken(s.taken);

    /* mg heat */
    if (prev.mgHeat !== s.mgHeat || prev.mgOverheated !== s.mgOverheated) {
      prev.mgHeat = s.mgHeat;
      prev.mgOverheated = s.mgOverheated;
      const h = typeof s.mgHeat === 'number' ? s.mgHeat : 0;
      const over = !!s.mgOverheated;
      // Show the real heat even while overheated: pinning the bar at full hides
      // the cooldown, so the gun just feels broken instead of recovering.
      fill(n.mgFill, h);
      flag(n.mgBar, 'hot', h >= 0.65 && !over);
      flag(n.mgBar, 'over', over);
      flag(n.mgLab, 'over', over);
      txt(n.mgLab, over ? 'OVERHEATED' : 'COAX MG');
    }
  },

  /* ---- crosshair, plus where the gun really points ---- */
  cursor(x, y, barrelX, barrelY, aligned) {
    if (!built) return;
    if (!cursorShown) {
      cursorShown = true;
      n.xhair.classList.add('shown');
      n.barrel.classList.add('shown');
    }
    place(n.xhair, Math.round(x), Math.round(y));
    /* the circle snaps shut the instant the barrel catches up */
    place(n.barrel, Math.round(barrelX), Math.round(barrelY), aligned ? 0.52 : 1);
    flag(n.xhair, 'aligned', aligned);
    flag(n.barrel, 'aligned', aligned);
  },

  /* ---- floating hit indicators, straight out of the pool ---- */
  popup(x, y, text, kind, opts = {}) {
    if (!built) return;
    const k = OUTCOME[kind] ? kind : 'damage';
    const loud = !!LOUD[k];

    /* take the next free member; if everything is busy, recycle the oldest */
    let p = null;
    for (let i = 0; i < POPUP_POOL; i++) {
      const cand = popups[(popupCursor + i) % POPUP_POOL];
      if (!cand.busy) {
        p = cand;
        popupCursor = (popupCursor + i + 1) % POPUP_POOL;
        break;
      }
    }
    if (!p) {
      p = popups[popupCursor];
      popupCursor = (popupCursor + 1) % POPUP_POOL;
      const at = live.indexOf(p);
      if (at >= 0) live.splice(at, 1);
      release(p, true);
      p.busy = false;
    }

    const label = (text === undefined || text === null || text === '') ? OUTCOME[k].label : text;
    txt(p.node, String(label).toUpperCase());

    if (p.kind !== k) {
      p.node.className = 'hud-popup k-' + k + (loud ? ' loud' : '');
      p.kind = k;
    }

    p.busy = true;
    p.loud = loud;
    p.ttl = opts.life > 0 ? opts.life : (loud ? 1.15 : 0.85);
    p.t = 0;
    p.x = x;
    p.y = y;
    p.vx = opts.vx !== undefined ? opts.vx : (Math.random() - 0.5) * 34;
    p.vy = opts.vy !== undefined ? opts.vy : (loud ? -108 : -74);
    p.base = opts.scale > 0 ? opts.scale : 1;

    p.node.classList.add('live');
    render(p);
    live.push(p);
  },

  /* ---- big announcement, parked above the fight ---- */
  banner(title, sub, ms = 1800) {
    if (!built) return;
    txt(n.bannerTitle, String(title === undefined || title === null ? '' : title).toUpperCase());
    const subText = sub === undefined || sub === null ? '' : String(sub).toUpperCase();
    txt(n.bannerSub, subText);
    flag(n.bannerSub, 'empty', subText === '');
    bannerLeft = (typeof ms === 'number' ? ms : 1800) / 1000;
    retrigger(n.banner, 'live');
  },

  /* ---- brief flash along the screen edges ---- */
  flash(kind) {
    if (!built) return;
    n.flash.classList.remove('live', 'k-taken', 'k-kill');
    void n.flash.offsetWidth;
    n.flash.classList.add('live', kind === 'kill' ? 'k-kill' : 'k-taken');
    flashLeft = 0.34;
  },

  showGameOver(stats, restart) {
    if (!built) return;
    const s = stats || {};
    txt(n.overStats.wave, s.wave === undefined ? 0 : s.wave);
    txt(n.overStats.score, s.score === undefined ? 0 : s.score);
    txt(n.overStats.kills, s.kills === undefined ? 0 : s.kills);
    txt(n.overStats.time, clock(s.time));
    onRestart = restart;
    n.over.classList.remove('hidden');
    retrigger(n.over, 'live');
  },

  hideGameOver() {
    if (!built) return;
    onRestart = null;
    n.over.classList.add('hidden');
    n.over.classList.remove('live');
  },

  /* ---- the level-up chooser; the game stays paused while it is open ---- */
  showLevelUp(level, choices, cb) {
    if (!built) return;

    const list = [];
    if (choices && choices.length) {
      for (let i = 0; i < choices.length && i < LVUP_SLOTS; i++) {
        if (choices[i]) list.push(choices[i]);
      }
    }

    txt(n.lvupTitle, 'LEVEL ' + (level === undefined || level === null ? '' : level));

    for (let i = 0; i < LVUP_SLOTS; i++) writeCard(lvupCards[i], list[i]);
    flag(n.lvup, 'few', list.length > 0 && list.length < LVUP_SLOTS);

    lvupChoices = list;
    onPick = typeof cb === 'function' ? cb : null;
    lvupPicked = false;
    lvupOpen = true;

    n.lvup.classList.remove('hidden');
    retrigger(n.lvup, 'live');

    /* one handler, one registration -- removed again in hideLevelUp */
    window.removeEventListener('keydown', lvupKey, true);
    window.addEventListener('keydown', lvupKey, true);

    if (list.length) lvupCards[0].card.focus();
  },

  hideLevelUp() {
    if (!built) return;
    window.removeEventListener('keydown', lvupKey, true);
    lvupOpen = false;
    onPick = null;
    lvupChoices = [];
    /* hand the keyboard back to the game */
    const act = document.activeElement;
    if (act && n.lvup.contains(act) && typeof act.blur === 'function') act.blur();
    n.lvup.classList.add('hidden');
    n.lvup.classList.remove('live');
  },

  get levelUpOpen() { return lvupOpen; },

  /* ---- advance everything transient ---- */
  update(dt) {
    if (!built) return;
    let step = typeof dt === 'number' && dt > 0 ? dt : 0;
    if (step > 0.1) step = 0.1;           /* a tab-out must not teleport anything */

    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      p.t += step;
      if (p.t >= p.ttl) {
        release(p, false);
        live.splice(i, 1);
        continue;
      }
      p.x += p.vx * step;
      p.y += p.vy * step;
      p.vy *= 1 - Math.min(0.9, 2.1 * step);
      p.vx *= 1 - Math.min(0.9, 3.4 * step);
      render(p);
    }

    if (bannerLeft > 0) {
      bannerLeft -= step;
      if (bannerLeft <= 0) { bannerLeft = 0; n.banner.classList.remove('live'); }
    }

    if (flashLeft > 0) {
      flashLeft -= step;
      if (flashLeft <= 0) { flashLeft = 0; n.flash.classList.remove('live'); }
    }
  },

  clear() {
    if (!built) return;
    for (let i = live.length - 1; i >= 0; i--) release(live[i], true);
    live.length = 0;
    popupCursor = 0;

    bannerLeft = 0;
    flashLeft = 0;
    n.banner.classList.remove('live');
    n.flash.classList.remove('live', 'k-taken', 'k-kill');

    HUD.hideGameOver();
    HUD.hideLevelUp();

    takenCache.length = 0;
    writeTaken(null);

    for (const key in prev) delete prev[key];
    prevHullFilled = -1;
    for (let i = 0; i < HULL_SEGMENTS; i++) flag(hullSegs[i], 'on', true);
  },
};

/* --------------------------------------------------------------- internals */

/* ---- the chooser ---- */

function writeCard(slot, c) {
  if (!slot) return;
  flag(slot.card, 'hidden', !c);
  slot.card.disabled = !c;
  if (!c) return;

  const rarity = RARITIES.indexOf(c.rarity) >= 0 ? c.rarity : 'common';
  for (let i = 0; i < RARITIES.length; i++) {
    flag(slot.card, 'r-' + RARITIES[i], RARITIES[i] === rarity);
  }

  txt(slot.rar, rarity);
  txt(slot.name, String(c.name === undefined || c.name === null ? '' : c.name));
  txt(slot.desc, String(c.desc === undefined || c.desc === null ? '' : c.desc));

  const lv = typeof c.level === 'number' && c.level > 0 ? Math.floor(c.level) : 1;
  const max = c.maxLevel;
  const capped = typeof max === 'number' && isFinite(max) && max > 0;

  if (capped && max <= PIP_MAX) {
    flag(slot.pipRow, 'off', false);
    for (let p = 0; p < PIP_MAX; p++) {
      flag(slot.pips[p], 'used', p < max);
      flag(slot.pips[p], 'on', p < lv);
    }
    txt(slot.rankTxt, lv + ' / ' + max);
  } else {
    /* too many ranks to draw, or no ceiling at all: just say it */
    flag(slot.pipRow, 'off', true);
    txt(slot.rankTxt, capped ? lv + ' / ' + max : 'RANK ' + lv);
  }
  flag(slot.card, 'maxed', capped && lv >= max);
}

function choose(i) {
  if (!lvupOpen || lvupPicked) return;
  const c = lvupChoices[i];
  if (!c) return;
  const fn = onPick;
  lvupPicked = true;            // hideLevelUp clears onPick, this guards the rest
  HUD.hideLevelUp();
  if (typeof fn === 'function') fn(c.id);
}

/* Captured, so 1/2/3 cannot also switch the round underneath. */
function lvupKey(e) {
  if (!lvupOpen) return;
  let i = -1;
  if (e.key === '1' || e.code === 'Digit1' || e.code === 'Numpad1') i = 0;
  else if (e.key === '2' || e.code === 'Digit2' || e.code === 'Numpad2') i = 1;
  else if (e.key === '3' || e.code === 'Digit3' || e.code === 'Numpad3') i = 2;
  if (i < 0 || !lvupChoices[i]) return;
  e.preventDefault();
  e.stopPropagation();
  if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
  choose(i);
}

/* ---- the taken list ---- */

function takenChanged(list) {
  const len = list && list.length ? list.length : 0;
  if (len !== takenCache.length) return true;
  for (let i = 0; i < len; i++) {
    const a = takenCache[i];
    const b = list[i];
    if (!a || !b || a.name !== b.name || a.level !== b.level) return true;
  }
  return false;
}

function writeTaken(list) {
  const len = list && list.length ? list.length : 0;
  const shown = len < TAKEN_ROWS ? len : TAKEN_ROWS;

  for (let i = 0; i < TAKEN_ROWS; i++) {
    const row = takenRows[i];
    const item = i < shown ? list[i] : null;
    flag(row.row, 'off', !item);
    if (!item) continue;
    txt(row.name, String(item.name === undefined || item.name === null ? '' : item.name));
    const lv = typeof item.level === 'number' && item.level > 1 ? Math.floor(item.level) : 1;
    txt(row.mult, 'x' + lv);
    flag(row.mult, 'single', lv <= 1);
  }

  flag(n.taken, 'empty', len === 0);

  takenCache.length = len;
  for (let i = 0; i < len; i++) takenCache[i] = { name: list[i].name, level: list[i].level };
}

function render(p) {
  const t = p.t / p.ttl;
  let s;
  if (p.loud) {
    /* a hard punch in, then it settles -- ricochets and ammo racks shout */
    s = t < 0.11 ? 0.55 + (t / 0.11) * 0.95 : 1.5 - ((t - 0.11) / 0.89) * 0.5;
  } else {
    s = t < 0.08 ? 0.72 + (t / 0.08) * 0.28 : 1;
  }
  s *= p.base;
  p.node.style.transform = 'translate3d(' + p.x.toFixed(1) + 'px,' + p.y.toFixed(1) +
    'px,0) translate(-50%,-50%) scale(' + s.toFixed(3) + ')';
  const hold = p.loud ? 0.68 : 0.55;
  p.node.style.opacity = t < hold ? '1' : (1 - (t - hold) / (1 - hold)).toFixed(3);
}

function release(p, offscreen) {
  p.busy = false;
  p.t = 0;
  p.node.classList.remove('live');
  p.node.style.opacity = '0';
  if (offscreen) p.node.style.transform = 'translate3d(-9999px,-9999px,0)';
}

export default HUD;
