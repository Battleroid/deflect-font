/* Experience, levels and the upgrade draft.
 *
 * Vampire Survivors' loop, in a tank: kills feed a bar, the bar fills fast at
 * first, and every level stops the game to offer three cards. The interesting
 * part is not the numbers on any one card but that a run bends in a direction --
 * a brawler that rams and machine-guns, a sniper that never misses a flank.
 *
 * Every upgrade resolves into the flat `stats` object at the bottom. Nothing
 * elsewhere in the game reads the upgrade list; it only reads `stats`.
 */

export const RARITY = {
  common: { weight: 72, label: 'COMMON' },
  rare:   { weight: 23, label: 'RARE' },
  epic:   { weight: 5,  label: 'EPIC' },
};

/* `apply` mutates the stat block; `n` is how many ranks are held. */
export const UPGRADES = [
  // ---- common: the dials -------------------------------------------------
  { id: 'autoloader', name: 'AUTOLOADER', rarity: 'common', max: 5,
    desc: (n) => `RELOAD ${n * 12}% FASTER`,
    apply: (s, n) => { s.reloadMul *= Math.pow(0.88, n); } },

  { id: 'turretdrive', name: 'TURRET DRIVE', rarity: 'common', max: 5,
    desc: (n) => `TRAVERSE ${n * 16}% FASTER`,
    apply: (s, n) => { s.traverseMul *= 1 + 0.16 * n; } },

  { id: 'powerpack', name: 'POWERPACK', rarity: 'common', max: 5,
    desc: (n) => `HULL SPEED ${n * 11}% FASTER`,
    apply: (s, n) => { s.speedMul *= 1 + 0.11 * n; s.turnMul *= 1 + 0.06 * n; } },

  { id: 'coolant', name: 'COOLANT', rarity: 'common', max: 4,
    desc: (n) => `COAX COOLS ${n * 30}% FASTER`,
    apply: (s, n) => { s.coolMul *= 1 + 0.3 * n; s.heatMul *= Math.pow(0.92, n); } },

  { id: 'rammer', name: 'RAMMER', rarity: 'common', max: 4,
    desc: (n) => `COAX FIRES ${n * 16}% FASTER`,
    apply: (s, n) => { s.mgRateMul *= 1 + 0.16 * n; } },

  { id: 'plating', name: 'HULL PLATING', rarity: 'common', max: 5,
    desc: (n) => `+${n * 20} MAX HULL`,
    apply: (s, n) => { s.maxHpAdd += 20 * n; } },

  { id: 'applique', name: 'APPLIQUE ARMOUR', rarity: 'common', max: 5,
    desc: (n) => `ARMOUR ${n * 11}% THICKER`,
    apply: (s, n) => { s.armourMul *= 1 + 0.11 * n; } },

  { id: 'hivel', name: 'HIGH VELOCITY', rarity: 'common', max: 5,
    desc: (n) => `PENETRATION +${n * 10}%`,
    apply: (s, n) => { s.penMul *= 1 + 0.1 * n; } },

  { id: 'filler', name: 'HE FILLER', rarity: 'common', max: 5,
    desc: (n) => `SHELL DAMAGE +${n * 12}%`,
    apply: (s, n) => { s.dmgMul *= 1 + 0.12 * n; } },

  { id: 'sloped', name: 'ANGLED PLATES', rarity: 'common', max: 4,
    desc: (n) => `INCOMING SHOTS DEFLECT ${n * 7}° EASIER`,
    apply: (s, n) => { s.ricochetDegDelta -= 7 * n; } },

  // ---- rare: the toys ----------------------------------------------------
  { id: 'multishot', name: 'MULTI-ROUND', rarity: 'rare', max: 2,
    desc: (n) => `FIRE ${n} EXTRA SHELL${n > 1 ? 'S' : ''}`,
    apply: (s, n) => { s.extraShells += n; } },

  { id: 'split', name: 'SPLIT ON HIT', rarity: 'rare', max: 2,
    desc: (n) => `PENETRATIONS THROW ${n * 2} FRAGMENTS`,
    apply: (s, n) => { s.splitCount += 2 * n; } },

  { id: 'tracer', name: 'EXPLOSIVE TIPS', rarity: 'rare', max: 2,
    desc: (n) => `COAX ROUNDS EXPLODE (${n * 3} DMG)`,
    apply: (s, n) => { s.mgExplode += 3 * n; } },

  { id: 'racks', name: 'EXTENDED RACKS', rarity: 'rare', max: 3,
    desc: (n) => `+${n * 40}% AMMUNITION`,
    apply: (s, n) => { s.ammoMul *= 1 + 0.4 * n; } },

  { id: 'salvage', name: 'SALVAGE CREW', rarity: 'rare', max: 3,
    desc: (n) => `WRECKS DROP REPAIRS ${n === 1 ? 'MORE' : `${n}X MORE`} OFTEN`,
    apply: (s, n) => { s.dropMul *= 1 + 0.9 * n; } },

  // ---- epic: the run-definers -------------------------------------------
  { id: 'apfsds', name: 'APFSDS', rarity: 'epic', max: 1,
    desc: () => 'AP NEVER RICOCHETS. PEN +25%',
    apply: (s) => { s.apNoRicochet = true; s.penMul *= 1.25; } },

  { id: 'revolver', name: 'REVOLVER BREECH', rarity: 'epic', max: 1,
    desc: () => 'RELOAD 35% FASTER',
    apply: (s) => { s.reloadMul *= 0.65; } },

  { id: 'spall', name: 'SPALL LINER', rarity: 'epic', max: 1,
    desc: () => 'TAKE 25% LESS DAMAGE',
    apply: (s) => { s.damageTakenMul *= 0.75; } },
];

const BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

/** What a kill is worth. */
export const XP_VALUE = { infantry: 3, light: 10, medium: 20, heavy: 42 };

function baseStats() {
  return {
    reloadMul: 1, traverseMul: 1, speedMul: 1, turnMul: 1,
    coolMul: 1, heatMul: 1, mgRateMul: 1,
    maxHpAdd: 0, armourMul: 1, damageTakenMul: 1, ricochetDegDelta: 0,
    penMul: 1, dmgMul: 1, ammoMul: 1, dropMul: 1,
    extraShells: 0, splitCount: 0, mgExplode: 0, apNoRicochet: false,
  };
}

export class Progression {
  constructor() { this.reset(); }

  reset() {
    this.level = 1;
    this.xp = 0;
    this.taken = new Map();
    this.pending = 0;              // levels earned but not yet spent
    this.stats = baseStats();
    this.xpNext = this._need(1);
  }

  /* Fast early, slower later: the first few cards should arrive inside the
   * first couple of waves, or the run never gets going. */
  _need(level) {
    return Math.round(14 + level * 9 + Math.pow(level, 1.6) * 2.6);
  }

  /** Returns how many levels were gained. */
  addXp(n) {
    this.xp += n;
    let gained = 0;
    while (this.xp >= this.xpNext) {
      this.xp -= this.xpNext;
      this.level += 1;
      this.xpNext = this._need(this.level);
      this.pending += 1;
      gained += 1;
    }
    return gained;
  }

  rankOf(id) { return this.taken.get(id) || 0; }

  available() {
    return UPGRADES.filter((u) => this.rankOf(u.id) < u.max);
  }

  /** Draw `count` distinct cards, weighted by rarity. */
  rollChoices(count = 3, rng = Math.random) {
    const pool = this.available();
    const picks = [];
    const used = new Set();
    while (picks.length < count && used.size < pool.length) {
      const candidates = pool.filter((u) => !used.has(u.id));
      const total = candidates.reduce((t, u) => t + RARITY[u.rarity].weight, 0);
      let r = rng() * total;
      let chosen = candidates[candidates.length - 1];
      for (const u of candidates) {
        r -= RARITY[u.rarity].weight;
        if (r <= 0) { chosen = u; break; }
      }
      used.add(chosen.id);
      const next = this.rankOf(chosen.id) + 1;
      picks.push({
        id: chosen.id, name: chosen.name, rarity: chosen.rarity,
        desc: chosen.desc(next), level: next, maxLevel: chosen.max,
      });
    }
    return picks;
  }

  take(id) {
    const u = BY_ID[id];
    if (!u) return false;
    const next = Math.min(this.rankOf(id) + 1, u.max);
    this.taken.set(id, next);
    this.pending = Math.max(0, this.pending - 1);
    this._recompute();
    return true;
  }

  _recompute() {
    const s = baseStats();
    for (const [id, n] of this.taken) BY_ID[id]?.apply(s, n);
    this.stats = s;
  }

  /** For the HUD's "already taken" strip. */
  takenList() {
    return [...this.taken].map(([id, n]) => ({ name: BY_ID[id].name, level: n }));
  }
}
