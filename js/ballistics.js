/* Rounds, armour and what happens when the two meet.
 *
 * This is the part the game is named after. A shell that arrives at a steep angle
 * does not simply do less damage -- it skips off and leaves nothing behind but a
 * blue RICOCHET and the knowledge that you should have flanked. The maths:
 *
 * A note on the angles, because they are easy to get wrong. `faceOf` splits the
 * bearing into front (within 50 degrees of the nose), rear, and side, and reports
 * obliquity against THAT face's normal. The construction caps obliquity at 50
 * degrees: a shot can never arrive more than 50 off any face normal, because past
 * that it is striking the next face closer to square. Ricochet thresholds must
 * therefore live below 50. They were originally written as 66-80, as though
 * obliquity ran to 90, which meant no shot in the game could ever ricochet --
 * the thresholds were unreachable and the whole mechanic was dead.
 *
 * The bounce zone is the corner between two faces, around 38-50 degrees, which is
 * also where it belongs physically: that is where a plate is most slanted to you.
 *
 *   1. Work out which face was struck, from the angle between the shell's travel
 *      and the target's facing. Front armour is several times rear armour.
 *   2. The more oblique the strike, the more steel the shell has to cross:
 *      effective = armour / cos(impact angle).
 *   3. Past a round's ricochet angle, a solid shot skips regardless of how much
 *      penetration it had. HEAT does not care -- it is a shaped charge, not a dart.
 *   4. Otherwise compare penetration against effective armour.
 */

export const ROUNDS = [
  {
    key: 'AP', name: 'AP', full: 'ARMOUR PIERCING',
    pen: 165, damage: 30, speed: 135, reload: 2.1,
    splash: 0, ricochetDeg: 35, canRicochet: true,
    tracerLen: 5.5, sound: 'fire.ap', start: 20, max: 60,
  },
  {
    key: 'HE', name: 'HE', full: 'HIGH EXPLOSIVE',
    pen: 45, damage: 20, speed: 90, reload: 2.5,
    splash: 7.5, splashDamage: 26, ricochetDeg: 44, canRicochet: true,
    tracerLen: 3.5, sound: 'fire.he', start: 14, max: 40,
  },
  {
    key: 'HEAT', name: 'HEAT', full: 'SHAPED CHARGE',
    pen: 240, damage: 38, speed: 100, reload: 3.0,
    splash: 3.0, splashDamage: 12, ricochetDeg: 999, canRicochet: false,
    tracerLen: 4.5, sound: 'fire.heat', start: 8, max: 24,
  },
  {
    key: 'CANISTER', name: 'CANISTER', full: 'ANTI-PERSONNEL',
    pen: 14, damage: 11, speed: 150, reload: 2.3,
    splash: 0, ricochetDeg: 30, canRicochet: true,
    pellets: 11, spreadDeg: 15, range: 34,
    tracerLen: 2.0, sound: 'fire.canister', start: 6, max: 18,
  },
];

export const ROUND_BY_KEY = Object.fromEntries(ROUNDS.map((r) => [r.key, r]));

/* Armour by face, in the same units as round penetration. Front is meant to be a
 * wall: the heavy's 240 front beats AP's 165 outright, so it has to be flanked or
 * met with HEAT. Rear is always soft. */
export const ARMOUR = {
  player: { front: 120, side: 70, rear: 45 },
  light:  { front: 60,  side: 35, rear: 25 },
  medium: { front: 130, side: 70, rear: 45 },
  heavy:  { front: 240, side: 120, rear: 70 },
};

const DEG = Math.PI / 180;
const EMPTY_MODS = Object.freeze({});

/** Which face of `target` a shell travelling along `dir` strikes.
 *  Returns { face, obliquity } with obliquity in radians: 0 is a square-on hit. */
export function faceOf(targetHeading, dirX, dirZ) {
  // the direction the shell came FROM, relative to where the target is looking
  const incoming = Math.atan2(-dirX, -dirZ);
  let rel = incoming - targetHeading;
  while (rel > Math.PI) rel -= Math.PI * 2;
  while (rel < -Math.PI) rel += Math.PI * 2;
  const a = Math.abs(rel);

  if (a < 50 * DEG) return { face: 'front', obliquity: a };
  if (a > 130 * DEG) return { face: 'rear', obliquity: Math.PI - a };
  // a side hit: square-on is 90 degrees off the target's nose
  return { face: 'side', obliquity: Math.abs(a - Math.PI / 2) };
}

/**
 * Resolve one shell against one armoured target.
 * @returns {{ outcome:'ricochet'|'nonpen'|'pen'|'crit', damage:number, face:string,
 *             effective:number, obliquity:number }}
 */
/**
 * @param mods optional upgrade effects:
 *   armourMul        thicker plate on the target
 *   penMul, dmgMul   a hotter round
 *   ricochetDegDelta lowers the angle at which shots skip off the TARGET
 *   noRicochet       this round never skips (APFSDS)
 */
export function resolveImpact(round, armour, targetHeading, dirX, dirZ, rng = Math.random,
                              mods = EMPTY_MODS) {
  const { face, obliquity } = faceOf(targetHeading, dirX, dirZ);
  const base = armour[face] * (mods.armourMul || 1);
  const pen = round.pen * (mods.penMul || 1);

  // Oblique strikes present more steel. Cap the multiplier so a glancing blow is
  // "impossible" rather than "infinitely thick", which would read as a bug.
  const cos = Math.max(Math.cos(obliquity), 0.2);
  const effective = base / cos;

  const skipAt = (round.ricochetDeg + (mods.ricochetDegDelta || 0)) * DEG;
  if (round.canRicochet && !mods.noRicochet && obliquity > skipAt) {
    // Enough overmatch still bites: a dart twice the armour's worth will not skip.
    if (pen < base * 2.0) {
      return { outcome: 'ricochet', damage: 0, face, effective, obliquity };
    }
  }

  const dmgBase = round.damage * (mods.dmgMul || 1);

  if (pen < effective) {
    // A near miss still rings the crew's bell a little; a clean stop does nothing.
    const shortfall = effective - pen;
    const spall = shortfall < effective * 0.12 ? Math.round(dmgBase * 0.2) : 0;
    return { outcome: 'nonpen', damage: spall, face, effective, obliquity };
  }

  // Through. Overmatch adds a little, and a rear hit can cook the ammunition off.
  const over = Math.min(pen / effective, 2.4);
  let damage = dmgBase * (0.75 + 0.35 * over);
  let outcome = 'pen';
  const critChance = face === 'rear' ? 0.22 : face === 'side' ? 0.1 : 0.03;
  if (rng() < critChance) {
    outcome = 'crit';
    damage *= 2.4;
  }
  return { outcome, damage: Math.round(damage), face, effective, obliquity };
}

/** Where a ricocheting shell goes: mirrored about the armour face, roughly. */
export function deflect(dirX, dirZ, targetHeading, face, rng = Math.random) {
  let nx, nz;
  if (face === 'front') { nx = Math.sin(targetHeading); nz = Math.cos(targetHeading); }
  else if (face === 'rear') { nx = -Math.sin(targetHeading); nz = -Math.cos(targetHeading); }
  else {
    const side = (dirX * Math.cos(targetHeading) - dirZ * Math.sin(targetHeading)) > 0 ? -1 : 1;
    nx = side * Math.cos(targetHeading);
    nz = -side * Math.sin(targetHeading);
  }
  const dot = dirX * nx + dirZ * nz;
  let rx = dirX - 2 * dot * nx;
  let rz = dirZ - 2 * dot * nz;
  // scatter it a bit so two identical bounces never look identical
  const jitter = (rng() - 0.5) * 0.5;
  const c = Math.cos(jitter), s = Math.sin(jitter);
  return { x: rx * c - rz * s, z: rx * s + rz * c, nx, nz };
}
