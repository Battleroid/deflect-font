import * as THREE from 'three';
import { HEX, OUTCOME } from './palette.js';
import { ROUNDS, resolveImpact, deflect, faceOf } from './ballistics.js';
import { PlayerTank, EnemyTank, Infantry, Shell, wrapAngle } from './entities.js';
import * as Models from './models.js';
import { Progression, XP_VALUE } from './progression.js';
import HUD from './hud.js';
import Audio from './audio.js';

/* 220 was sized for an arena filled out with scatter. With the clutter gone the
 * deliberate zones only reach about two thirds of the way out, which left a wide
 * band of bare floor and enemies spawning in the void. Smaller field, same
 * content: it reads as a place rather than a plain, and the fighting stays close. */
const ARENA = 170;
const ARENA_RADIUS = ARENA * 0.47;

/* Base chance a wrecked vehicle leaves a repair kit behind, before SALVAGE CREW. */
const REPAIR_DROP = 0.09;
const REPAIR_AMOUNT = 5;

/* Enemy value, used to budget a wave. Infantry are cheap and come in crowds. */
const COST = { light: 1, medium: 2, heavy: 4, infantry: 0.5 };

/* Coax hits needed to throw a track. The gun overheats at roughly 18 rounds, so a
 * heavy takes more than one burst -- you have to commit to it. */
const TRACK_HITS = { light: 11, medium: 18, heavy: 26 };

export class Game {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.fx = new Models.FxPool(scene);

    this.arenaRadius = ARENA_RADIUS;
    this.bounds = ARENA_RADIUS;        // square half-extent; set properly in build()
    this.prog = new Progression();
    this.obstacles = [];
    this.enemies = [];
    this.infantry = [];
    this.shells = [];
    this.crates = [];

    this.wave = 0;
    this.score = 0;
    this.kills = 0;
    this.time = 0;
    this.state = 'idle';            // idle | intermission | fighting | over
    this.stateTimer = 0;
    this.running = false;

    this._v = new THREE.Vector3();
    this._pending = [];             // spawns queued during a wave
  }

  // -- setup ---------------------------------------------------------------

  build(seed = 7) {
    this.arena = Models.createArena(ARENA, seed);
    this.scene.add(this.arena);

    /* Normalise whatever the arena handed us. `solid` stops a hull; `blocksFire` is
     * separate, because a tank can shoot over dragon's teeth and sandbags but not
     * through a blast wall -- which is what makes a low obstacle worth sitting
     * behind. Anything that does not declare a height is assumed tall. */
    /* The arena is a square with a kerb. Take the playable half-extent from it
     * rather than inventing a radius, or the hull stops short of the wall and
     * the corners become unreachable floor. */
    this.bounds = this.arena.userData.playable ?? ARENA_RADIUS;

    this.obstacles = (this.arena.userData.obstacles || []).map((o) => ({
      x: o.x, z: o.z, radius: o.radius,
      solid: o.solid !== false,
      blocksFire: o.blocksFire ?? (o.height === undefined ? o.solid !== false : o.height > 1.6),
      height: o.height,
    }));
    if (this.arena.userData.spawnRing) {
      this.spawnRing = Math.min(this.arena.userData.spawnRing, ARENA_RADIUS - 6);
    } else {
      this.spawnRing = ARENA_RADIUS - 10;
    }

    this.playerGroup = Models.createPlayerTank();
    this.scene.add(this.playerGroup);
    this.player = new PlayerTank(this.playerGroup);
  }

  start() {
    this.running = true;
    this.state = 'intermission';
    this.stateTimer = 2.4;
    this.wave = 0;
    this.score = 0;
    this.kills = 0;
    this.time = 0;
    this.player.hp = this.player.maxHp;
    this.player.x = 0; this.player.z = 0;
    this.player.heading = 0; this.player.turret = 0;
    this.player.speed = 0;
    this.player.reload = 1;
    this.player.mgHeat = 0;
    this.player.mgOverheated = false;
    this.prog.reset();
    this.player.base.maxHp = 100;
    this.player.maxHp = 100;
    this.player.hp = 100;
    this.player.applyUpgrades(this.prog.stats);
    this._refillAmmo();
    this.clearAll();
    HUD.hideLevelUp();
    HUD.clear();
    HUD.banner('STAND BY', 'WAVE 1 INBOUND', 2200);
    Audio.engineStart();
  }

  /** Top every rack back up, scaled by any EXTENDED RACKS ranks. */
  _refillAmmo() {
    const mul = this.prog.stats.ammoMul;
    for (const r of ROUNDS) {
      this.player.ammo[r.key] = Math.round(r.start * mul);
    }
  }

  clearAll() {
    for (const e of this.enemies) this.scene.remove(e.group);
    for (const i of this.infantry) this.scene.remove(i.group);
    for (const c of this.crates) this.scene.remove(c.group);
    this.enemies.length = 0;
    this.infantry.length = 0;
    this.shells.length = 0;
    this.crates.length = 0;
    this._pending.length = 0;
    this.fx.clear();
  }

  // -- the world interface the entities use --------------------------------

  *allVehicles() {
    yield this.player;
    for (const e of this.enemies) yield e;
  }

  hasLineOfFire(from, to) {
    const dx = to.x - from.x, dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) return true;
    const ux = dx / len, uz = dz / len;
    for (const o of this.obstacles) {
      if (!o.solid || !o.blocksFire) continue;
      const px = o.x - from.x, pz = o.z - from.z;
      const t = Math.max(0, Math.min(len, px * ux + pz * uz));
      const cx = from.x + ux * t, cz = from.z + uz * t;
      if (Math.hypot(o.x - cx, o.z - cz) < o.radius) return false;
    }
    return true;
  }

  // -- firing --------------------------------------------------------------

  playerFire() {
    const p = this.player;
    if (!p.canFire()) { Audio.play('denied', { gain: 0.5 }); return; }
    const round = p.round;
    p.ammo[round.key] -= 1;
    p.reload = 0;
    p.reloadTime = round.reload;

    const m = p.muzzleWorld();
    const dirX = Math.sin(p.turret), dirZ = Math.cos(p.turret);
    Audio.play(round.sound, { pan: this._panOf(p.x) });
    this._muzzle(m, dirX, dirZ, round.key === 'HE' ? 1.15 : 1);
    this.shake(round.key === 'HE' ? 0.5 : 0.36);

    // canister throws a cone of pellets; everything else is one shot, plus
    // whatever MULTI-ROUND has added, fanned just wide enough to read as several
    const extra = this.prog.stats.extraShells;
    const n = (round.pellets || 1) + extra;
    const fan = round.spreadDeg ? round.spreadDeg : (extra ? 3.4 : 0);
    for (let i = 0; i < n; i++) {
      const spread = fan
        ? (n === 1 ? 0 : (i / (n - 1) - 0.5) * 2) * fan * Math.PI / 180
          + (round.spreadDeg ? (Math.random() - 0.5) * 0.02 : 0)
        : 0;
      const a = p.turret + spread;
      this.shells.push(new Shell({
        x: m.x, y: m.y, z: m.z,
        dirX: Math.sin(a), dirZ: Math.cos(a),
        speed: round.speed * (0.94 + Math.random() * 0.12),
        round, from: p, friendly: true,
      }));
    }
    // recoil
    p.speed -= Math.cos(wrapAngle(p.turret - p.heading)) * 1.6;
  }

  playerMG() {
    const p = this.player;
    if (!p.fireMG()) {
      if (p.mgOverheated && Math.random() < 0.05) Audio.play('denied', { gain: 0.3 });
      return;
    }
    const m = p.muzzleWorld();
    const a = p.turret + (Math.random() - 0.5) * 0.045;
    Audio.play('mg', { gain: 0.5, pan: this._panOf(p.x) });
    this.shells.push(new Shell({
      x: m.x, y: m.y - 0.2, z: m.z,
      dirX: Math.sin(a), dirZ: Math.cos(a),
      speed: 190, life: 0.7,
      round: { key: 'MG', name: 'MG', pen: 18, damage: 4, canRicochet: true, ricochetDeg: 34, tracerLen: 2.4 },
      from: p, friendly: true, isMG: true,
    }));
  }

  enemyFire(enemy) {
    const m = enemy.muzzleWorld();
    const a = enemy.turret + (Math.random() - 0.5) * 0.035;
    Audio.play(enemy.variant === 'heavy' ? 'fire.he' : 'fire.ap',
               { gain: 0.45, pan: this._panOf(enemy.x) });
    this._muzzle(m, Math.sin(a), Math.cos(a), enemy.variant === 'heavy' ? 1.1 : 0.8);
    this.shells.push(new Shell({
      x: m.x, y: m.y, z: m.z,
      dirX: Math.sin(a), dirZ: Math.cos(a),
      speed: 95,
      round: {
        key: 'ENEMY', name: 'AP', pen: enemy.spec.pen, damage: enemy.spec.damage,
        canRicochet: true, ricochetDeg: 38, tracerLen: 4,
      },
      from: enemy, friendly: false,
    }));
  }

  infantryAttack(inf) {
    const m = new THREE.Vector3(inf.x, 1.0, inf.z);
    const a = Math.atan2(this.player.x - inf.x, this.player.z - inf.z);
    Audio.play('mg', { gain: 0.3, pan: this._panOf(inf.x) });
    this.shells.push(new Shell({
      x: m.x, y: m.y, z: m.z,
      dirX: Math.sin(a), dirZ: Math.cos(a),
      speed: 42, life: 1.4,
      round: {
        key: 'AT', name: 'AT', pen: 95, damage: 11,
        canRicochet: false, ricochetDeg: 999, tracerLen: 1.6, splash: 2.5, splashDamage: 6,
      },
      from: inf, friendly: false,
    }));
  }

  // -- shell flight --------------------------------------------------------

  /** Sweep the shell from its current spot to (nx,nz); resolve the first thing hit. */
  castShell(shell, nx, nz) {
    const ox = shell.x, oz = shell.z;
    const dx = nx - ox, dz = nz - oz;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return null;
    const ux = dx / len, uz = dz / len;

    let best = null;
    const consider = (ent, radius) => {
      const px = ent.x - ox, pz = ent.z - oz;
      const proj = px * ux + pz * uz;
      if (proj < -radius || proj > len + radius) return;
      const t = Math.max(0, Math.min(len, proj));
      const cx = ox + ux * t, cz = oz + uz * t;
      const d = Math.hypot(ent.x - cx, ent.z - cz);
      if (d > radius) return;
      const back = Math.sqrt(Math.max(0, radius * radius - d * d));
      const hitT = Math.max(0, t - back);
      if (!best || hitT < best.t) best = { t: hitT, ent, x: ox + ux * hitT, z: oz + uz * hitT };
    };

    if (shell.friendly) {
      for (const e of this.enemies) if (!e.dead) consider(e, e.radius);
      for (const i of this.infantry) if (!i.dead) consider(i, i.radius + 0.25);
    } else if (shell.from !== this.player) {
      consider(this.player, this.player.radius);
    }
    for (const o of this.obstacles) if (o.solid && o.blocksFire) consider(o, o.radius);

    if (!best) return null;
    this._impact(shell, best);
    return best;
  }

  _impact(shell, hit) {
    const ent = hit.ent;
    const point = new THREE.Vector3(hit.x, shell.y, hit.z);
    const pan = this._panOf(hit.x);

    // terrain
    if (!ent.hp && ent.radius !== undefined && ent.solid) {
      this.fx.spark(point, new THREE.Vector3(-shell.dirX, 0.4, -shell.dirZ), HEX.grey, 7);
      Audio.play('nonpen', { gain: 0.35, pan });
      shell.dead = true;
      if (shell.round.splash) this._splash(point, shell);
      return;
    }

    // soft targets: no armour, anything kills
    if (ent instanceof Infantry) {
      const dead = ent.takeDamage(shell.isMG ? 6 : 20);
      this.fx.spark(point, new THREE.Vector3(-shell.dirX, 0.6, -shell.dirZ), HEX.amber, 6);
      if (dead) this._killInfantry(ent, point);
      else this._popup(point, String(shell.isMG ? 6 : 20), 'damage');
      shell.dead = true;
      if (shell.round.splash) this._splash(point, shell);
      return;
    }

    /* The coax against armour. It will not defeat a plate -- that is what the main
     * gun is for -- but a sustained burst into running gear throws a track, and a
     * tank that cannot turn is a tank you can walk around and shoot in the back.
     * Light hulls also take a little chip damage from the side and rear. */
    if (shell.isMG && ent.armour) {
      shell.dead = true;
      const { face } = faceOf(ent.heading, shell.dirX, shell.dirZ);
      // Only a light hull is thin enough to care, and only away from its glacis.
      // Anything heavier takes no damage at all from the coax -- throwing its
      // track is the whole point, and the main gun still has to finish the job.
      const soft = face !== 'front';
      const chip = ent.variant === 'light' && soft ? 1 : 0;

      this.fx.spark(point, new THREE.Vector3(-shell.dirX, 0.35, -shell.dirZ), HEX.grey, 3);
      ent.trackHits = (ent.trackHits || 0) + (soft ? 1.35 : 1);
      const need = TRACK_HITS[ent.variant] || 20;
      if (!ent.tracked && ent.trackHits >= need) {
        ent.trackHits = 0;
        ent.trackedFor = 5.5;
        Audio.play('nonpen', { pan, gain: 0.7 });
        this.fx.spark(ent.hitPoint, new THREE.Vector3(0, 1, 0), HEX.amber, 14);
        this._popup(point, 'TRACKED', 'crit');
      }
      // EXPLOSIVE TIPS: every coax round becomes a tiny bomb
      const boom = this.prog.stats.mgExplode;
      if (boom > 0) {
        this.fx.spark(point, new THREE.Vector3(0, 1, 0), HEX.amber, 4);
        if (ent.takeDamage(boom)) { this._killVehicle(ent, point); return; }
      }
      if (chip > 0 && ent.takeDamage(chip)) this._killVehicle(ent, point);
      return;
    }

    const up = this.prog.stats;
    const mods = shell.friendly
      ? { penMul: up.penMul, dmgMul: up.dmgMul,
          noRicochet: up.apNoRicochet && shell.round.key === 'AP' }
      // being shot at: our own plate is thicker and slopes better
      : { armourMul: up.armourMul, ricochetDegDelta: up.ricochetDegDelta };
    const res = resolveImpact(shell.round, ent.armour, ent.heading,
                              shell.dirX, shell.dirZ, Math.random, mods);
    const scale = shell.damageScale || 1;
    const dmg = Math.round(res.damage * scale);

    if (res.outcome === 'ricochet') {
      Audio.play('ricochet', { pan });
      this._popup(point, OUTCOME.ricochet.label, 'ricochet');
      const d = deflect(shell.dirX, shell.dirZ, ent.heading, res.face);
      this.fx.spark(point, new THREE.Vector3(d.nx, 0.5, d.nz), HEX.blue, 12);
      shell.bounces += 1;
      if (shell.bounces > 2 || shell.isMG) { shell.dead = true; return; }
      // a bounced shot is still live, and still dangerous
      shell.dirX = d.x; shell.dirZ = d.z;
      shell.speed *= 0.72;
      shell.damageScale = scale * 0.6;
      shell.x = hit.x + d.x * (ent.radius + 0.4);
      shell.z = hit.z + d.z * (ent.radius + 0.4);
      return;
    }

    shell.dead = true;

    if (res.outcome === 'nonpen') {
      Audio.play('nonpen', { pan });
      this._popup(point, OUTCOME.nonpen.label, 'nonpen');
      this.fx.spark(point, new THREE.Vector3(-shell.dirX, 0.4, -shell.dirZ), HEX.grey, 8);
      if (dmg > 0 && ent.takeDamage(dmg)) this._killVehicle(ent, point);
    } else {
      const crit = res.outcome === 'crit';
      Audio.play('pen', { pan, gain: crit ? 1 : 0.8 });
      this.fx.spark(point, new THREE.Vector3(-shell.dirX, 0.5, -shell.dirZ),
                    crit ? HEX.amber : HEX.red, crit ? 20 : 12);
      if (ent === this.player) {
        this._playerHit(dmg, point, crit);
      } else {
        this._popup(point, crit ? `${OUTCOME.crit.label} ${dmg}` : String(dmg), crit ? 'crit' : 'pen');
        if (ent.takeDamage(dmg)) this._killVehicle(ent, point);
        else if (up.splitCount > 0 && shell.friendly && !shell.isSplinter) {
          this._split(point, shell, up.splitCount);
        }
      }
    }
    if (shell.round.splash) this._splash(point, shell);
  }

  /** SPLIT ON HIT: a penetration throws fragments back out at the neighbours. */
  _split(point, shell, count) {
    const base = Math.atan2(shell.dirX, shell.dirZ);
    for (let i = 0; i < count; i++) {
      const a = base + (i / count - 0.5) * 2.4 + (Math.random() - 0.5) * 0.3;
      this.shells.push(new Shell({
        x: point.x, y: point.y, z: point.z,
        dirX: Math.sin(a), dirZ: Math.cos(a),
        speed: 110, life: 0.55, friendly: true, from: shell.from, isSplinter: true,
        damageScale: 0.45,
        round: {
          key: 'FRAG', name: 'FRAG', pen: 70, damage: 10,
          canRicochet: false, ricochetDeg: 999, tracerLen: 2,
        },
      }));
    }
  }

  _splash(point, shell) {
    const r = shell.round.splash;
    const base = shell.round.splashDamage || shell.round.damage * 0.5;
    this.fx.explosion(point, r / 6);
    Audio.play('explosion', { gain: 0.5, pan: this._panOf(point.x) });
    const victims = shell.friendly
      ? [...this.enemies, ...this.infantry]
      : [this.player];
    for (const v of victims) {
      if (v.dead) continue;
      const d = Math.hypot(v.x - point.x, v.z - point.z);
      if (d > r) continue;
      const falloff = 1 - d / r;
      // splash goes over the top, where armour is thin, so it mostly ignores facing
      const dmg = Math.round(base * falloff * (v.armour ? 0.6 : 1.4));
      if (dmg <= 0) continue;
      if (v === this.player) this._playerHit(dmg, v.hitPoint, false);
      else if (v.takeDamage(dmg)) {
        if (v instanceof Infantry) this._killInfantry(v, v.hitPoint);
        else this._killVehicle(v, v.hitPoint);
      }
    }
  }

  _playerHit(dmg, point, crit) {
    const p = this.player;
    if (p.invuln > 0) return;
    p.invuln = 0.12;
    dmg = Math.max(1, Math.round(dmg * this.prog.stats.damageTakenMul));
    p.takeDamage(dmg);
    Audio.play('hitTaken', { gain: 0.8 });
    HUD.flash('taken');
    this._popup(point, `-${dmg}`, 'taken');
    this.shake(crit ? 1.1 : 0.7);
    if (p.hp <= 0) this.gameOver();
  }

  /** XP, and the occasional repair kit left in the wreckage. */
  _award(kind, ent) {
    this.prog.addXp(XP_VALUE[kind] || 5);
    if (kind === 'infantry') return;
    if (Math.random() < REPAIR_DROP * this.prog.stats.dropMul) {
      this._dropPickup(ent.x, ent.z, 'repair');
    }
  }

  _killVehicle(ent, point) {
    ent.dead = true;
    this.kills += 1;
    this.score += ent.score || 100;
    this._award(ent.variant, ent);
    const big = ent.variant === 'heavy';
    this.fx.explosion(ent.hitPoint, big ? 2.0 : 1.3);
    this.fx.scorch(ent.position, big ? 1.6 : 1.2);
    // a knocked-out hull should go on burning, not just vanish
    if (this.fx.wreckSmoke) this.fx.wreckSmoke(ent.position, big ? 1.5 : 1.1);
    Audio.play(big ? 'explosionBig' : 'explosion', { pan: this._panOf(ent.x) });
    this._popup(point, OUTCOME.kill.label, 'kill');
    HUD.flash('kill');
    this.shake(big ? 0.9 : 0.55);
  }

  _killInfantry(ent, point) {
    ent.dead = true;
    this.kills += 1;
    this.score += ent.score;
    this._award('infantry', ent);
    Audio.play('infantryDie', { gain: 0.6, pan: this._panOf(ent.x) });
    this.fx.spark(point, new THREE.Vector3(0, 1, 0), HEX.amber, 8);
  }

  _popup(worldPos, text, kind) {
    const s = this.project(worldPos);
    if (s) HUD.popup(s.x, s.y, text, kind);
  }

  /** Flash plus the smoke that drifts off the barrel behind it. */
  _muzzle(at, dirX, dirZ, scale = 1) {
    const dir = new THREE.Vector3(dirX, 0.06, dirZ);
    if (this.fx.muzzleFlash) this.fx.muzzleFlash(at, dir, scale);
    else this.fx.spark(at, dir, HEX.amber, 14);
    if (this.fx.barrelSmoke) this.fx.barrelSmoke(at, dir, scale);
  }

  _panOf(x) {
    return Math.max(-1, Math.min(1, (x - this.player.x) / 45));
  }

  project(v3) {
    this._v.copy(v3).project(this.camera);
    if (this._v.z > 1) return null;
    return {
      x: (this._v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-this._v.y * 0.5 + 0.5) * window.innerHeight,
    };
  }

  shake(amount) {
    this.shakeAmount = Math.min((this.shakeAmount || 0) + amount, 1.6);
  }

  // -- waves ---------------------------------------------------------------

  startWave() {
    this.wave += 1;
    const budget = 2.5 + this.wave * 2.3;
    const list = [];
    let spent = 0;

    // heavies only start showing up once the player has had a few waves
    const pool = [];
    pool.push('light', 'light', 'infantry', 'infantry');
    if (this.wave >= 2) pool.push('medium', 'infantry');
    if (this.wave >= 3) pool.push('medium', 'medium');
    if (this.wave >= 5) pool.push('heavy');
    if (this.wave >= 8) pool.push('heavy', 'medium');

    let guard = 0;
    while (spent < budget && guard++ < 200) {
      const kind = pool[Math.floor(Math.random() * pool.length)];
      if (spent + COST[kind] > budget + 0.6) continue;
      list.push(kind);
      spent += COST[kind];
    }
    // always at least something
    if (!list.length) list.push('light');

    // spawn in two or three clusters so they arrive as groups, not a ring
    const clusters = Math.min(3, 1 + Math.floor(this.wave / 3));
    const baseAngles = [];
    for (let i = 0; i < clusters; i++) baseAngles.push(Math.random() * Math.PI * 2);

    this._pending = list.map((kind, i) => ({
      kind,
      angle: baseAngles[i % clusters] + (Math.random() - 0.5) * 0.55,
      delay: (i % clusters) * 0.15 + Math.floor(i / clusters) * 0.42,
    }));

    this.waveTotal = list.length;
    Audio.play('waveStart');
    HUD.banner(`WAVE ${this.wave}`, this._waveSub(list), 1900);
  }

  _waveSub(list) {
    const n = (k) => list.filter((x) => x === k).length;
    const parts = [];
    if (n('heavy')) parts.push(`${n('heavy')} HEAVY`);
    if (n('medium')) parts.push(`${n('medium')} MEDIUM`);
    if (n('light')) parts.push(`${n('light')} LIGHT`);
    if (n('infantry')) parts.push(`${n('infantry')} INFANTRY`);
    return parts.join('  /  ');
  }

  _spawn(kind, angle) {
    const r = this.spawnRing;
    const x = Math.sin(angle) * r;
    const z = Math.cos(angle) * r;
    const heading = Math.atan2(-x, -z);
    if (kind === 'infantry') {
      const g = Models.createInfantry();
      this.scene.add(g);
      this.infantry.push(new Infantry(g, { x, z, heading }));
    } else {
      const g = Models.createEnemyTank(kind);
      this.scene.add(g);
      const e = new EnemyTank(g, kind, { x, z, heading });
      e.syncMesh(0);
      this.enemies.push(e);
    }
  }

  _dropCrate() {
    const a = Math.random() * Math.PI * 2;
    const r = 18 + Math.random() * (this.spawnRing - 30);
    this._dropPickup(Math.sin(a) * r, Math.cos(a) * r, 'supply');
  }

  _dropPickup(x, z, kind) {
    const g = Models.createSupplyCrate();
    if (kind === 'repair') g.scale.setScalar(0.62);   // a kit, not a pallet
    g.position.set(x, 0, z);
    this.scene.add(g);
    this.crates.push({ group: g, x, z, spin: Math.random() * 6, kind });
  }

  // -- the frame -----------------------------------------------------------

  update(dt, input, aimPoint) {
    // Effects and screen shake keep running after the player dies -- the loop still
    // calls us, and the death explosion has to finish playing out.
    if (!this.running) {
      this.fx.update(dt);
      if (this.shakeAmount) this.shakeAmount = Math.max(0, this.shakeAmount - dt * 2.6);
      return;
    }
    this.time += dt;

    if (this.state === 'fighting' || this.state === 'intermission') {
      this.player.update(dt, input, aimPoint, this);
      Audio.engineThrottle(Math.min(1, Math.abs(this.player.speed) / this.player.maxSpeed));
    }

    // queued spawns
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const s = this._pending[i];
      s.delay -= dt;
      if (s.delay <= 0) { this._spawn(s.kind, s.angle); this._pending.splice(i, 1); }
    }

    for (const e of this.enemies) if (!e.dead) e.update(dt, this);
    for (const i of this.infantry) if (!i.dead) i.update(dt, this);

    // shells
    for (const s of this.shells) {
      if (s.dead) continue;
      s.step(dt, this);
      if (!s.dead) {
        const len = s.round.tracerLen || 3;
        this.fx.tracer(
          new THREE.Vector3(s.x - s.dirX * len, s.y, s.z - s.dirZ * len),
          new THREE.Vector3(s.x, s.y, s.z),
          s.isMG ? HEX.amber : (s.friendly ? HEX.bone : HEX.redLight),
          0.07
        );
      }
    }

    // reap
    this._reap();

    // crates
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      c.spin += dt * 1.4;
      c.group.rotation.y = c.spin;
      c.group.position.y = 0.2 + Math.sin(c.spin * 1.6) * 0.12;
      if (Math.hypot(c.x - this.player.x, c.z - this.player.z) < this.player.radius + 1.8) {
        this.scene.remove(c.group);
        this.crates.splice(i, 1);
        this._collect(c.kind);
      }
    }

    this.fx.update(dt);
    this._advanceState(dt);
    if (this.shakeAmount) this.shakeAmount = Math.max(0, this.shakeAmount - dt * 2.6);
  }

  _reap() {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.dead) { this.scene.remove(e.group); Models.disposeGroup?.(e.group); this.enemies.splice(i, 1); }
    }
    for (let i = this.infantry.length - 1; i >= 0; i--) {
      const n = this.infantry[i];
      if (n.dead) { this.scene.remove(n.group); Models.disposeGroup?.(n.group); this.infantry.splice(i, 1); }
    }
    for (let i = this.shells.length - 1; i >= 0; i--) {
      if (this.shells[i].dead) this.shells.splice(i, 1);
    }
  }

  _collect(kind) {
    Audio.play('pickup');
    const p = this.player;
    if (kind === 'repair') {
      p.hp = Math.min(p.maxHp, p.hp + REPAIR_AMOUNT);
      this._popup(p.hitPoint, `+${REPAIR_AMOUNT}`, 'kill');
      return;
    }
    const mul = this.prog.stats.ammoMul;
    for (const r of ROUNDS) {
      p.ammo[r.key] = Math.min(Math.round(r.max * mul), p.ammo[r.key] + Math.ceil(r.start * 0.5));
    }
    p.hp = Math.min(p.maxHp, p.hp + 25);
    HUD.banner('RESUPPLY', 'AMMUNITION AND REPAIRS', 1200);
  }

  _advanceState(dt) {
    if (this.state === 'over') return;
    this.stateTimer -= dt;

    if (this.state === 'intermission') {
      if (this.stateTimer <= 0) { this.state = 'fighting'; this.startWave(); }
      return;
    }

    if (this.state === 'fighting') {
      const left = this.enemies.length + this.infantry.length + this._pending.length;
      if (left === 0) {
        this.score += 150 + this.wave * 60;
        Audio.play('waveClear');
        // racks topped up and a little welding done between waves, so running
        // dry or limping is a problem for this wave rather than for the run
        this._refillAmmo();
        const healed = Math.min(10, this.player.maxHp - this.player.hp);
        this.player.hp += healed;
        HUD.banner(`WAVE ${this.wave} CLEAR`,
                   `REARMED${healed > 0 ? `  /  +${healed} HULL` : ''}`, 1700);
        this.state = 'intermission';
        this.stateTimer = 4.2;
        if (this.wave % 2 === 0) { this._dropCrate(); this._dropCrate(); }
        else this._dropCrate();
      }
    }
  }

  gameOver() {
    if (this.state === 'over') return;
    this.state = 'over';
    this.running = false;
    Audio.engineStop();
    Audio.play('gameOver');
    this.fx.explosion(this.player.hitPoint, 2.6);
    this.fx.scorch(this.player.position, 2);
    this.playerGroup.visible = false;
    this.shake(1.6);
    HUD.showGameOver(
      { wave: this.wave, score: this.score, kills: this.kills, time: this.time },
      () => this.onRestart && this.onRestart()
    );
  }

  get enemiesLeft() {
    return this.enemies.length + this.infantry.length + this._pending.length;
  }

  stats() {
    const p = this.player;
    return {
      wave: this.wave, score: this.score, kills: this.kills,
      hp: Math.ceil(p.hp), hpMax: p.maxHp,
      round: p.round.key, ammo: p.ammo,
      reload: p.reload, mgHeat: p.mgHeat, mgOverheated: p.mgOverheated,
      enemiesLeft: this.enemiesLeft,
      xp: this.prog.xp, xpNext: this.prog.xpNext, level: this.prog.level,
      taken: this.prog.takenList(),
    };
  }

  /** Spend one pending level, if the modal is not already up. */
  offerLevelUp() {
    if (this.prog.pending <= 0 || HUD.levelUpOpen) return;
    const choices = this.prog.rollChoices(3);
    if (!choices.length) { this.prog.pending = 0; return; }
    Audio.play('waveClear', { gain: 0.6 });
    HUD.showLevelUp(this.prog.level, choices, (id) => {
      this.prog.take(id);
      this.player.applyUpgrades(this.prog.stats);
      Audio.play('select');
    });
  }
}
