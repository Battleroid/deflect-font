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
function avoidObstacles(ent, desired, world, lookahead) {
  const ux = Math.sin(desired), uz = Math.cos(desired);
  let push = 0;
  for (const o of world.obstacles) {
    if (!o.solid) continue;
    const px = o.x - ent.x, pz = o.z - ent.z;

    // How far along our intended path we pass it, and how close we pass. Testing
    // the whole swept path rather than one point ahead matters: a single probe
    // steps straight over anything we are already alongside, which is exactly
    // when a hull gets hung up on a corner.
    const along = px * ux + pz * uz;
    if (along > lookahead) continue;
    const t = Math.max(0, along);
    const cx = ent.x + ux * t, cz = ent.z + uz * t;
    const clearance = Math.hypot(o.x - cx, o.z - cz);
    const reach = o.radius + ent.radius + 2.2;
    if (clearance >= reach) continue;

    // Near things and head-on things pull harder than distant glancing ones.
    const urgency = (1 - clearance / reach) * (1 - 0.6 * (t / lookahead));
    let side = wrapAngle(Math.atan2(px, pz) - desired);
    // dead ahead: commit to one side rather than dithering down the middle
    if (Math.abs(side) < 0.08) side = (ent._detourSide || 1) * 0.08;
    push += (side > 0 ? -1 : 1) * urgency;
  }
  return wrapAngle(desired + Math.max(-1.3, Math.min(1.3, push)) * 1.05);
}

/**
 * Notice when something has wedged itself and commit to a sidestep for a moment.
 * Avoidance alone can leave a mover grinding into a corner forever, because the
 * push that would free it is the same size as the push holding it there.
 */
function unstick(ent, desired, dt, wanted) {
  const moved = Math.hypot(ent.x - (ent._lx ?? ent.x), ent.z - (ent._lz ?? ent.z));
  ent._lx = ent.x; ent._lz = ent.z;
  if (ent._detour > 0) {
    ent._detour -= dt;
    return wrapAngle(desired + ent._detourSide * 1.15);
  }
  if (wanted && moved < Math.abs(ent.speed) * dt * 0.3) {
    ent._jam = (ent._jam || 0) + dt;
    if (ent._jam > 0.35) {
      ent._jam = 0;
      ent._detour = 0.7 + Math.random() * 0.5;
      ent._detourSide = Math.random() < 0.5 ? -1 : 1;
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
    const moving = Math.min(Math.abs(this.speed) / this.maxSpeed, 1);
    const rate = this.turnRate * mob * (0.35 + 0.65 * moving);
    this.heading = wrapAngle(this.heading - steer * rate * dt);

    const nx = this.x + Math.sin(this.heading) * this.speed * dt;
    const nz = this.z + Math.cos(this.heading) * this.speed * dt;
    this.moveTo(nx, nz, world);
  }

  moveTo(nx, nz, world) {
    const r = world.arenaRadius - this.radius;
    const d = Math.hypot(nx, nz);
    if (d > r) { nx = (nx / d) * r; nz = (nz / d) * r; this.speed *= 0.4; }

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
  }

  get round() { return ROUNDS[this.roundIndex]; }

  selectRound(i) {
    if (i < 0 || i >= ROUNDS.length || i === this.roundIndex) return false;
    this.roundIndex = i;
    // swapping mid-load costs you the partial load, which makes the choice matter
    this.reload = Math.min(this.reload, 0.35);
    this.reloadTime = this.round.reload;
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
    if (this.mgCooldown > 0) this.mgCooldown -= dt;
    if (this.mgOverheated) {
      this.mgHeat -= dt * 0.5;        // ~2s locked out, long enough to sting
      if (this.mgHeat <= 0) { this.mgHeat = 0; this.mgOverheated = false; }
    } else if (!input.mgHeld) {
      this.mgHeat = Math.max(0, this.mgHeat - dt * 0.42);
    }
    this.syncMesh(dt);
  }

  fireMG(dt) {
    if (this.mgOverheated || this.mgCooldown > 0) return false;
    this.mgHeat += 0.055;
    this.mgCooldown = 0.075;
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
  heavy:  { hp: 160, armour: ARMOUR.heavy,  maxSpeed: 7.5, turnRate: 0.9, turretRate: 0.85,
            reloadTime: 4.0, pen: 200, damage: 24, range: 48, prefer: 34, score: 400 },
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
      // heavies plant themselves and trade; lights circle and harass
      if (dist > this.spec.range) this.state = 'advance';
      else if (dist < this.spec.prefer * 0.55) this.state = 'back';
      else this.state = this.variant === 'heavy' ? 'hold' : 'circle';
    }

    let desired = toPlayer;
    let throttle = 0;
    if (this.state === 'advance') { throttle = 1; desired = toPlayer; }
    else if (this.state === 'back') { throttle = -1; desired = toPlayer; }
    else if (this.state === 'circle') {
      throttle = 1;
      desired = toPlayer + this.flankOffset * 1.15;   // arc around rather than charge
    } else {
      throttle = 0;
      // angle the hull so the player gets a sloped plate, not a flat one
      desired = toPlayer + 0.55 * this.flankSign;
    }

    desired = this._avoid(desired, world, dt);

    // negated to match drive()'s convention: +steer swings the nose right
    const err = wrapAngle(desired - this.heading);
    const steer = Math.abs(err) < 0.05 ? 0 : -Math.sign(err);
    // don't drive at full tilt while swinging the hull round
    if (Math.abs(err) > 1.2) throttle *= 0.35;
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
  _avoid(desired, world, dt) {
    // keep off the arena wall first -- it overrides everything else
    if (Math.hypot(this.x, this.z) > world.arenaRadius - 10) {
      const inward = Math.atan2(-this.x, -this.z);
      return wrapAngle(desired + wrapAngle(inward - desired) * 0.5);
    }
    const ahead = this.radius + 5 + Math.abs(this.speed) * 0.4;
    return unstick(this, avoidObstacles(this, desired, world, ahead), dt, true);
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
    want = unstick(this, avoidObstacles(this, want, world, this.radius + 5), dt, this.speed > 0);
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
    const r = world.arenaRadius - this.radius;
    const ed = Math.hypot(nx, nz);
    if (ed > r) { nx = (nx / ed) * r; nz = (nz / ed) * r; }
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

    if (Math.hypot(this.x, this.z) > world.arenaRadius) this.dead = true;
  }
}

export { wrapAngle, slew, DEG };
