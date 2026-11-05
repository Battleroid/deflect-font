import * as THREE from 'three';
import { ARMOUR, ROUNDS, resolveImpact, deflect } from './ballistics.js';
import { HEX } from './palette.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

/**
 * Bend a desired heading around anything solid in front of us.
 *
 * Deliberately not a pathfinder: a look-ahead point is tested against the
 * obstacle list and each thing it is inside nudges the heading to whichever side
 * that obstacle is NOT on. Cheap, works for every mover, and keeps the arena
 * feeling open as long as the map leaves real gaps.
 */
function avoidObstacles(ent, desired, world, lookahead, movers) {
  const ux = Math.sin(desired), uz = Math.cos(desired);
  let push = 0;

  const consider = (o, pad) => {
    const px = o.x - ent.x, pz = o.z - ent.z;

    // How far along our intended path we pass it, and how close we pass. Testing
    // the whole swept path rather than one point ahead matters: a single probe
    // steps straight over anything we are already alongside, which is exactly
    // when a hull gets hung up on a corner.
    const along = px * ux + pz * uz;
    if (along > lookahead) return;
    const t = Math.max(0, along);
    const cx = ent.x + ux * t, cz = ent.z + uz * t;
    const clearance = Math.hypot(o.x - cx, o.z - cz);
    const reach = o.radius + ent.radius + pad;
    if (clearance >= reach) return;

    // Near things and head-on things pull harder than distant glancing ones.
    const urgency = (1 - clearance / reach) * (1 - 0.6 * (t / lookahead));
    let side = wrapAngle(Math.atan2(px, pz) - desired);
    // dead ahead: commit to one side rather than dithering down the middle
    if (Math.abs(side) < 0.08) side = (ent._detourSide || 1) * 0.08;
    push += (side > 0 ? -1 : 1) * urgency;
  };

  for (const o of world.obstacles) if (o.solid) consider(o, 2.2);
  // Steer round each other too. Without this two hulls shove head-on in
  // moveTo's push-out, each undoing the other, and both sit there grinding.
  if (movers) for (const m of movers) if (m !== ent && !m.dead) consider(m, 1.6);

  return wrapAngle(desired + Math.max(-1.3, Math.min(1.3, push)) * 1.05);
}

/**
 * Notice when something has wedged itself and commit to a sidestep for a moment.
 * Avoidance alone can leave a mover grinding into a corner forever, because the
 * push that would free it is the same size as the push holding it there.
 */
/**
 * A heading that runs ALONG whatever is blocking us, on whichever side makes
 * more progress toward where we were trying to go.
 *
 * Offsetting from the player's bearing is not enough on its own: the bearing
 * keeps pointing through the obstacle, so a hull backs off, turns, and drives
 * straight back into the same corner. Following the tangent commits it to going
 * around.
 */
function skirtHeading(ent, desired, world, forceSign) {
  let best = null;
  for (const o of world.obstacles) {
    if (!o.solid) continue;
    const gap = Math.hypot(ent.x - o.x, ent.z - o.z) - o.radius - ent.radius;
    if (gap < 5 && (!best || gap < best.gap)) best = { o, gap };
  }
  if (!best) return null;                       // nothing left to skirt: we are clear
  const toObstacle = Math.atan2(best.o.x - ent.x, best.o.z - ent.z);
  let sign = forceSign;
  if (!sign) {
    const left = wrapAngle(wrapAngle(toObstacle + Math.PI / 2) - desired);
    const right = wrapAngle(wrapAngle(toObstacle - Math.PI / 2) - desired);
    sign = Math.abs(left) < Math.abs(right) ? 1 : -1;
  }
  ent._skirtSign = sign;
  // bias a little away from the obstacle so we peel off rather than grind along it
  return wrapAngle(toObstacle + sign * (Math.PI / 2 + 0.25));
}

function unstick(ent, desired, dt, intendedSpeed, world) {
  const moved = Math.hypot(ent.x - (ent._lx ?? ent.x), ent.z - (ent._lz ?? ent.z));
  ent._lx = ent.x; ent._lz = ent.z;

  if (ent._detour > 0) {
    ent._detour -= dt;
    // A short shove backwards to break contact, then run the tangent forwards.
    // Steering alone cannot free a wedged hull: the push holding it in place is
    // the same size as the push that would free it.
    ent.reversing = ent._detour > ent._detourLen - 0.35;
    // Re-read the tangent as we slide along, so a long obstacle gets followed
    // rather than left on a straight line that curves back into it.
    ent._skirtTick -= dt;
    if (ent._skirtTick <= 0) {
      ent._skirtTick = 0.25;
      const h = skirtHeading(ent, desired, world, ent._skirtSign);
      if (h === null) { ent._detour = 0; ent.reversing = false; return desired; }
      ent._detourHeading = h;
    }
    return ent._detourHeading;
  }
  ent.reversing = false;

  // Judge progress against what we MEANT to travel, not against current speed.
  // Measuring against current speed is circular -- a hull pinned to a wall has a
  // speed near zero, so "moved less than its speed" is false and it never
  // notices it is stuck.
  const want = Math.abs(intendedSpeed) * dt;
  if (want > 0.002 && moved < want * 0.35) {
    ent._jam = (ent._jam || 0) + dt;
    if (ent._jam > 0.4) {
      ent._jam = 0;
      /* Jamming again near where we last jammed means we are working along one
       * long obstacle -- a teeth belt or a hedgerow. Keep the same side and give
       * it progressively longer to run, so it commits to finding the gap instead
       * of peeling off, re-aiming at the player and driving back into the belt. */
      const nearLastJam = Math.hypot(ent.x - (ent._jamX ?? 1e9), ent.z - (ent._jamZ ?? 1e9)) < 12;
      ent._jamStreak = nearLastJam ? (ent._jamStreak || 0) + 1 : 1;
      ent._jamX = ent.x; ent._jamZ = ent.z;

      const h = skirtHeading(ent, desired, world, ent._jamStreak > 1 ? ent._skirtSign : 0);
      if (h !== null) {
        ent._detourLen = Math.min(1.4 * ent._jamStreak, 6);
        ent._detour = ent._detourLen;
        ent._skirtTick = 0.25;
        ent._detourHeading = h;
      }
    }
  } else {
    ent._jam = 0;
  }
  return desired;
}

/** Turn `from` toward `to` by at most `rate * dt`. Returns the new angle. */
function slew(from, to, rate, dt) {
  const d = wrapAngle(to - from);
  const step = rate * dt;
  if (Math.abs(d) <= step) return to;
  return wrapAngle(from + Math.sign(d) * step);
}

// ---------------------------------------------------------------------------

export class Vehicle {
  constructor(group, opts) {
    this.group = group;
    this.turretGroup = group.userData.turret || null;
    this.muzzle = group.userData.muzzle || null;
    this.hullDims = group.userData.hull || { length: 6, width: 3, height: 2 };

    this.x = opts.x || 0;
    this.z = opts.z || 0;
    this.heading = opts.heading || 0;
    this.turret = this.heading;
    this.speed = 0;

    this.maxHp = opts.hp;
    this.hp = opts.hp;
    this.armour = opts.armour;
    this.radius = opts.radius ?? Math.max(this.hullDims.length, this.hullDims.width) * 0.42;

    this.maxSpeed = opts.maxSpeed;
    this.accel = opts.accel ?? 14;
    this.turnRate = opts.turnRate;
    this.turretRate = opts.turretRate;

    this.dead = false;
    this.reload = 1;             // 0..1, 1 = ready
    this.reloadTime = opts.reloadTime ?? 2.5;
    this._bob = Math.random() * TAU;

    // Mobility kill. Enough machine-gun fire into a running gear will throw a
    // track, and a tank that cannot turn is a tank you can walk around.
    this.trackedFor = 0;
    this.trackHits = 0;
  }

  get tracked() { return this.trackedFor > 0; }

  /** Speed and steering multiplier: a thrown track halves both. */
  get mobility() { return this.trackedFor > 0 ? 0.38 : 1; }

  get position() { return new THREE.Vector3(this.x, 0, this.z); }

  /** Centre of mass, a little above the deck — where indicators and hits read best. */
  get hitPoint() { return new THREE.Vector3(this.x, this.hullDims.height * 0.7, this.z); }

  syncMesh(dt) {
    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.y = this.heading;
    if (this.turretGroup) this.turretGroup.rotation.y = wrapAngle(this.turret - this.heading);
    // a touch of roll while driving so the thing feels like it has weight
    if (dt) {
      this._bob += dt * (3 + Math.abs(this.speed) * 0.5);
      const amp = Math.min(Math.abs(this.speed) / Math.max(this.maxSpeed, 0.001), 1) * 0.022;
      this.group.rotation.z = Math.sin(this._bob) * amp;
      this.group.rotation.x = Math.cos(this._bob * 0.7) * amp * 0.6;
    }
  }

  /** Move with simple tank steering, then push out of anything solid. */
  drive(dt, throttle, steer, world) {
    if (this.trackedFor > 0) this.trackedFor -= dt;
    const mob = this.mobility;
    const target = throttle * this.maxSpeed * mob * (throttle < 0 ? 0.55 : 1);
    const a = this.accel * dt;
    if (this.speed < target) this.speed = Math.min(this.speed + a, target);
    else this.speed = Math.max(this.speed - a, target);
    if (throttle === 0) this.speed *= 1 - Math.min(dt * 2.6, 1);

    // Tanks steer better the faster they roll, but can neutral-steer slowly.
    //
    // Sign: a hull facing +Z has its right hand toward -X, and heading grows from
    // +Z toward +X, so turning right means heading DECREASES. steer is +1 for
    // right, hence the minus. Kept consistent in reverse too -- real tracks would
    // invert, but having D always mean "swing right" is what a player expects.
    //
    // The floor on the rolling bonus matters more than it looks. Tracks pivot in
    // place, and at 0.35 a stopped heavy turned at 0.3 rad/s -- ten seconds to
    // face about. Anything that snagged could never steer off, because stopping
    // was what took its steering away.
    const moving = Math.min(Math.abs(this.speed) / this.maxSpeed, 1);
    const rate = this.turnRate * mob * (0.62 + 0.38 * moving);
    this.heading = wrapAngle(this.heading - steer * rate * dt);

    const nx = this.x + Math.sin(this.heading) * this.speed * dt;
    const nz = this.z + Math.cos(this.heading) * this.speed * dt;
    this.moveTo(nx, nz, world);
  }

  moveTo(nx, nz, world) {
    // The arena is a square with a kerb, so clamp to a square. Clamping to a
    // circle (as this used to) stopped the hull several units short of the
    // visible wall along the axes and made the corners unreachable entirely --
    // an invisible barrier with floor painted beyond it.
    const b = world.bounds - this.radius;
    if (nx < -b || nx > b) { nx = Math.max(-b, Math.min(b, nx)); this.speed *= 0.4; }
    if (nz < -b || nz > b) { nz = Math.max(-b, Math.min(b, nz)); this.speed *= 0.4; }

    for (const o of world.obstacles) {
      if (!o.solid) continue;
      const dx = nx - o.x, dz = nz - o.z;
      const dist = Math.hypot(dx, dz);
      const min = o.radius + this.radius;
      if (dist < min && dist > 0.0001) {
        nx = o.x + (dx / dist) * min;
        nz = o.z + (dz / dist) * min;
        this.speed *= 0.86;
      }
    }

    // and out of other vehicles, so nothing ever stacks
    for (const v of world.allVehicles()) {
      if (v === this || v.dead) continue;
      const dx = nx - v.x, dz = nz - v.z;
      const dist = Math.hypot(dx, dz);
      const min = this.radius + v.radius;
      if (dist < min && dist > 0.0001) {
        const push = (min - dist) * 0.5;
        nx += (dx / dist) * push;
        nz += (dz / dist) * push;
        v.x -= (dx / dist) * push;
        v.z -= (dz / dist) * push;
      }
    }

    this.x = nx;
    this.z = nz;
  }

  aimAt(x, z, dt) {
    const want = Math.atan2(x - this.x, z - this.z);
    this.turret = slew(this.turret, want, this.turretRate, dt);
    return Math.abs(wrapAngle(want - this.turret));
  }

  muzzleWorld() {
    if (this.muzzle) {
      // Three only refreshes world matrices at render time, so without this the
      // muzzle would report where the turret was pointing on the PREVIOUS frame.
      // The shell's direction comes from this.turret, which is current, so the
      // two would disagree and every shot would leave the barrel off to one side.
      this.syncMesh(0);
      this.group.updateMatrixWorld(true);
      const v = new THREE.Vector3();
      this.muzzle.getWorldPosition(v);
      return v;
    }
    const d = this.hullDims.length * 0.6;
    return new THREE.Vector3(this.x + Math.sin(this.turret) * d, 1.4, this.z + Math.cos(this.turret) * d);
  }

  tickReload(dt) {
    if (this.reload < 1) this.reload = Math.min(1, this.reload + dt / this.reloadTime);
  }

  takeDamage(n) {
    this.hp -= n;
    if (this.hp <= 0) { this.hp = 0; this.dead = true; }
    return this.dead;
  }
}

// ---------------------------------------------------------------------------

export class PlayerTank extends Vehicle {
  constructor(group) {
    super(group, {
      hp: 100, armour: ARMOUR.player, maxSpeed: 15, accel: 16,
      turnRate: 1.9, turretRate: 2.1, reloadTime: ROUNDS[0].reload,
    });
    this.roundIndex = 0;
    this.ammo = {};
    for (const r of ROUNDS) this.ammo[r.key] = r.start;
    this.mgHeat = 0;
    this.mgOverheated = false;
    this.mgCooldown = 0;
    this.invuln = 0;
    this.kills = 0;

    /* Upgrades scale off these, never off the current values, so re-applying is
     * idempotent and ranks never compound on themselves. */
    this.base = { maxSpeed: 15, turnRate: 1.9, turretRate: 2.1, maxHp: 100 };
    this.up = null;
  }

  get round() { return ROUNDS[this.roundIndex]; }

  /** Recompute everything the upgrade tree touches. Safe to call repeatedly. */
  applyUpgrades(s) {
    this.up = s;
    this.maxSpeed = this.base.maxSpeed * s.speedMul;
    this.turnRate = this.base.turnRate * s.turnMul;
    this.turretRate = this.base.turretRate * s.traverseMul;
    const nextMax = this.base.maxHp + s.maxHpAdd;
    const gained = nextMax - this.maxHp;
    this.maxHp = nextMax;
    if (gained > 0) this.hp = Math.min(this.maxHp, this.hp + gained);  // new plate is whole
    this.reloadTime = this.round.reload * s.reloadMul;
  }

  selectRound(i) {
    if (i < 0 || i >= ROUNDS.length || i === this.roundIndex) return false;
    this.roundIndex = i;
    // swapping mid-load costs you the partial load, which makes the choice matter
    this.reload = Math.min(this.reload, 0.35);
    this.reloadTime = this.round.reload * (this.up ? this.up.reloadMul : 1);
    return true;
  }

  canFire() { return this.reload >= 1 && this.ammo[this.round.key] > 0; }

  update(dt, input, aimPoint, world) {
    this.invuln = Math.max(0, this.invuln - dt);
    this.drive(dt, input.throttle, input.steer, world);
    if (input.braking) this.speed *= 1 - Math.min(dt * 5, 1);
    this.aimAt(aimPoint.x, aimPoint.z, dt);
    this.tickReload(dt);

    // coax machine gun heat
    const cool = this.up ? this.up.coolMul : 1;
    if (this.mgCooldown > 0) this.mgCooldown -= dt;
    if (this.mgOverheated) {
      this.mgHeat -= dt * 0.5 * cool;   // ~2s locked out, long enough to sting
      if (this.mgHeat <= 0) { this.mgHeat = 0; this.mgOverheated = false; }
    } else if (!input.mgHeld) {
      this.mgHeat = Math.max(0, this.mgHeat - dt * 0.42 * cool);
    }
    this.syncMesh(dt);
  }

  fireMG() {
    if (this.mgOverheated || this.mgCooldown > 0) return false;
    this.mgHeat += 0.055 * (this.up ? this.up.heatMul : 1);
    this.mgCooldown = 0.075 / (this.up ? this.up.mgRateMul : 1);
    if (this.mgHeat >= 1) { this.mgHeat = 1; this.mgOverheated = true; }
    return true;
  }
}

// ---------------------------------------------------------------------------

const ENEMY_SPEC = {
  light:  { hp: 45,  armour: ARMOUR.light,  maxSpeed: 17, turnRate: 2.2, turretRate: 1.7,
            reloadTime: 1.9, pen: 70,  damage: 9,  range: 32, prefer: 22, score: 100 },
  medium: { hp: 85,  armour: ARMOUR.medium, maxSpeed: 12, turnRate: 1.5, turretRate: 1.3,
            reloadTime: 2.8, pen: 130, damage: 15, range: 42, prefer: 30, score: 200 },
  heavy:  { hp: 160, armour: ARMOUR.heavy,  maxSpeed: 8.5, turnRate: 1.15, turretRate: 0.85,
            reloadTime: 4.0, pen: 200, damage: 24, range: 48, prefer: 26, score: 400 },
};

export class EnemyTank extends Vehicle {
  constructor(group, variant, opts) {
    const s = ENEMY_SPEC[variant];
    super(group, {
      ...opts, hp: s.hp, armour: s.armour, maxSpeed: s.maxSpeed,
      turnRate: s.turnRate, turretRate: s.turretRate, reloadTime: s.reloadTime,
    });
    this.variant = variant;
    this.spec = s;
    this.score = s.score;
    this.state = 'advance';
    this.stateTime = 0;
    // each tank picks a side to work around, so a group fans out instead of queueing
    this.flankSign = Math.random() < 0.5 ? -1 : 1;
    this.flankOffset = (0.5 + Math.random() * 0.5) * this.flankSign;
    this.think = Math.random() * 0.4;
    this.reload = Math.random();
  }

  update(dt, world) {
    const p = world.player;
    const dx = p.x - this.x, dz = p.z - this.z;
    const dist = Math.hypot(dx, dz);
    const toPlayer = Math.atan2(dx, dz);

    this.stateTime += dt;
    this.think -= dt;
    if (this.think <= 0) {
      this.think = 0.35 + Math.random() * 0.4;
      /* Anchor on the standoff we actually want, not on maximum gun range.
       * Anchoring on range parked heavies at 45-odd units where they sat in open
       * ground doing nothing, which reads as broken AI rather than as tactics.
       * Also require a clear shot: no point holding station behind a wall. */
      const band = this.spec.prefer;
      const next =
        (!world.hasLineOfFire(this, p) || dist > band * 1.2) ? 'advance'
          : dist < band * 0.6 ? 'back'
            : this.variant === 'heavy' ? 'hold' : 'circle';
      if (next !== this.state) { this.state = next; this.stateTime = 0; }
    }
    // and never stand still indefinitely
    if (this.state === 'hold' && this.stateTime > 3.5) { this.state = 'advance'; this.stateTime = 0; }

    let desired = toPlayer;
    let throttle = 0;
    if (this.state === 'advance') throttle = 1;
    else if (this.state === 'back') throttle = -1;
    else if (this.state === 'circle') {
      throttle = 1;
      desired = toPlayer + this.flankOffset * 1.15;   // arc around rather than charge
    } else {
      // Angle the hull so the player gets a sloped plate, not a flat one.
      // 45 degrees, not 30: past the 35-degree ricochet threshold, so holding
      // at an angle actually bounces AP instead of merely looking like it might.
      desired = toPlayer + 0.78 * this.flankSign;
    }

    desired = this._avoid(desired, world, dt, throttle * this.maxSpeed);
    if (this.reversing) throttle = -1;

    // negated to match drive()'s convention: +steer swings the nose right
    const err = wrapAngle(desired - this.heading);
    const steer = Math.abs(err) < 0.05 ? 0 : -Math.sign(err);
    // ease off while swinging the hull round, but never enough to stall the turn
    if (Math.abs(err) > 1.2 && !this.reversing) throttle *= 0.6;
    this.drive(dt, throttle, steer, world);

    // aim with a little lead, and a little error so it is not a laser
    const lead = Math.min(dist / 120, 0.6);
    const aimX = p.x + Math.sin(p.heading) * p.speed * lead;
    const aimZ = p.z + Math.cos(p.heading) * p.speed * lead;
    const off = this.aimAt(aimX, aimZ, dt);

    this.tickReload(dt);
    if (this.reload >= 1 && off < 0.05 && dist < this.spec.range * 1.15 && world.hasLineOfFire(this, p)) {
      this.reload = 0;
      world.enemyFire(this);
    }

    this.syncMesh(dt);
  }

  /** Nudge the desired heading away from anything solid directly ahead. */
  _avoid(desired, world, dt, intendedSpeed) {
    // bend away from the arena wall first, then round everything else
    if (Math.max(Math.abs(this.x), Math.abs(this.z)) > world.bounds - 12) {
      const inward = Math.atan2(-this.x, -this.z);
      desired = wrapAngle(desired + wrapAngle(inward - desired) * 0.5);
    }
    const ahead = this.radius + 5 + Math.abs(this.speed) * 0.4;
    const clear = avoidObstacles(this, desired, world, ahead, world.allVehicles());
    return unstick(this, clear, dt, intendedSpeed, world);
  }
}

// ---------------------------------------------------------------------------

export class Infantry {
  constructor(group, opts) {
    this.group = group;
    this.x = opts.x; this.z = opts.z;
    this.heading = opts.heading || 0;
    this.hp = 12;
    this.maxHp = 12;
    this.radius = 0.75;
    this.maxSpeed = 7.4 + Math.random() * 1.6;
    this.speed = 0;
    this.dead = false;
    this.score = 25;
    this.cooldown = 1 + Math.random() * 2;
    this.hullDims = group.userData.hull || { length: 1, width: 1, height: 1.8 };
    this.bob = Math.random() * TAU;
    this.armour = null;        // no armour: anything that touches them kills them

    /* Each man picks a bearing to come in on, measured round from the player's
     * BACK, so a squad envelops instead of forming an orderly queue in front of
     * the gun. Spread them over most of the rear arc and let a couple swing wide. */
    this.flankBias = (Math.random() * 2 - 1) * 1.5;
    this.orbit = 10 + Math.random() * 4;
    this.recommit = 0;
  }

  get position() { return new THREE.Vector3(this.x, 0, this.z); }
  get hitPoint() { return new THREE.Vector3(this.x, 1.1, this.z); }

  update(dt, world) {
    const p = world.player;
    const dx = p.x - this.x, dz = p.z - this.z;
    const dist = Math.hypot(dx, dz);
    const toPlayer = Math.atan2(dx, dz);

    /* Make for a spot on a ring around the player, on our chosen bearing off his
     * back, rather than straight at him. Once we are on the ring, close and throw.
     * Re-reading the player's heading periodically means that turning to face a
     * man sends him round the side rather than making him stand still. */
    this.recommit -= dt;
    if (this.recommit <= 0) {
      this.recommit = 0.8 + Math.random() * 0.7;
      this.aimBearing = p.heading + Math.PI + this.flankBias;
    }
    let want;
    if (dist > this.orbit + 2) {
      const tx = p.x + Math.sin(this.aimBearing) * this.orbit;
      const tz = p.z + Math.cos(this.aimBearing) * this.orbit;
      want = Math.atan2(tx - this.x, tz - this.z);
      this.speed = this.maxSpeed;
    } else if (dist > 8) {
      want = toPlayer;
      this.speed = this.maxSpeed * 0.85;
    } else {
      want = toPlayer;
      this.speed = 0;
    }
    want = unstick(this, avoidObstacles(this, want, world, this.radius + 5), dt, this.speed, world);
    if (this.reversing) this.speed = -this.maxSpeed * 0.6;
    this.heading = slew(this.heading, want, 4.5, dt);

    let nx = this.x + Math.sin(this.heading) * this.speed * dt;
    let nz = this.z + Math.cos(this.heading) * this.speed * dt;
    for (const o of world.obstacles) {
      if (!o.solid) continue;
      const ox = nx - o.x, oz = nz - o.z;
      const d = Math.hypot(ox, oz);
      const min = o.radius + this.radius;
      if (d < min && d > 0.0001) { nx = o.x + (ox / d) * min; nz = o.z + (oz / d) * min; }
    }
    const b = world.bounds - this.radius;
    nx = Math.max(-b, Math.min(b, nx));
    nz = Math.max(-b, Math.min(b, nz));
    this.x = nx; this.z = nz;

    this.cooldown -= dt;
    if (dist < 13 && this.cooldown <= 0 && world.hasLineOfFire(this, p)) {
      this.cooldown = 2.4 + Math.random();
      world.infantryAttack(this);
    }

    this.bob += dt * (6 + this.speed);
    this.group.position.set(this.x, Math.abs(Math.sin(this.bob)) * 0.16 * (this.speed > 0 ? 1 : 0), this.z);
    this.group.rotation.y = this.heading;
  }

  takeDamage(n) {
    this.hp -= n;
    if (this.hp <= 0) { this.hp = 0; this.dead = true; }
    return this.dead;
  }
}

// ---------------------------------------------------------------------------

export class Shell {
  constructor(opts) {
    Object.assign(this, opts);     // x, z, y, dirX, dirZ, speed, round, from, damageScale
    this.life = opts.life ?? 3.2;
    this.dead = false;
    this.bounces = 0;
    this.travelled = 0;
    this.damageScale = opts.damageScale ?? 1;
    this.prev = new THREE.Vector3(this.x, this.y, this.z);
  }

  step(dt, world) {
    this.life -= dt;
    if (this.life <= 0) { this.dead = true; return; }

    const dist = this.speed * dt;
    this.prev.set(this.x, this.y, this.z);
    const nx = this.x + this.dirX * dist;
    const nz = this.z + this.dirZ * dist;
    this.travelled += dist;

    // canister pellets run out of steam quickly
    if (this.round.range && this.travelled > this.round.range) { this.dead = true; return; }

    const hit = world.castShell(this, nx, nz);
    if (hit) { this.x = hit.x; this.z = hit.z; } else { this.x = nx; this.z = nz; }

    if (Math.abs(this.x) > world.bounds || Math.abs(this.z) > world.bounds) this.dead = true;
  }
}

export { wrapAngle, slew, DEG };
