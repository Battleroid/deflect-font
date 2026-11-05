import * as THREE from 'three';
import { HEX } from './palette.js';
import { Game } from './game.js';
import { Input } from './input.js';
import { makeDecals } from './decals.js';
import { flattenStatic } from './optimize.js';
import HUD from './hud.js';
import Audio from './audio.js';

/* Orthographic and looking down from behind, just enough tilt to see the sides of
 * a hull. Straight down would hide which way a tank is angled, and angling your
 * armour is the whole game. */
const VIEW = 64;                                   // world units visible vertically
const CAM_OFFSET = new THREE.Vector3(0, 70, 26);

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(HEX.void, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(HEX.void, 120, 210);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
camera.position.copy(CAM_OFFSET);
camera.lookAt(0, 0, 0);

/* Flat, directional light so the facets read without anything looking soft. */
scene.add(new THREE.AmbientLight(0xffffff, 0.72));
const key = new THREE.DirectionalLight(0xfff4dd, 0.85);
key.position.set(-40, 80, 30);
scene.add(key);
const rim = new THREE.DirectionalLight(0x9fc6ff, 0.25);
rim.position.set(50, 30, -40);
scene.add(rim);

const game = new Game(scene, camera);
game.build(7);

/* The arena is a few thousand little outlined meshes and none of it moves, so
 * bake it down before the first frame -- otherwise the draw-call count alone
 * costs about half the frame rate. */
console.info('arena merged:', flattenStatic(game.arena, ['floor']));

scene.add(makeDecals(game.arenaRadius));

const input = new Input(canvas);
HUD.init(document.getElementById('hud'));

// --- sizing ---------------------------------------------------------------

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  camera.left = (-VIEW * aspect) / 2;
  camera.right = (VIEW * aspect) / 2;
  camera.top = VIEW / 2;
  camera.bottom = -VIEW / 2;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// --- mouse to ground ------------------------------------------------------

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ndc = new THREE.Vector2();
const aimPoint = new THREE.Vector3();

function updateAim() {
  ndc.x = (input.mouse.x / window.innerWidth) * 2 - 1;
  ndc.y = -(input.mouse.y / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  if (!raycaster.ray.intersectPlane(groundPlane, aimPoint)) {
    aimPoint.set(game.player.x, 0, game.player.z + 20);
  }
}

// --- camera ---------------------------------------------------------------

const camTarget = new THREE.Vector3();
const camLook = new THREE.Vector3();

function updateCamera(dt) {
  const p = game.player;
  // lean the view a little toward where the player is aiming, so you see what you
  // are about to shoot rather than what is behind you
  const leadX = THREE.MathUtils.clamp((aimPoint.x - p.x) * 0.22, -14, 14);
  const leadZ = THREE.MathUtils.clamp((aimPoint.z - p.z) * 0.22, -14, 14);
  camTarget.set(p.x + leadX, 0, p.z + leadZ);
  camLook.lerp(camTarget, 1 - Math.pow(0.0015, dt));

  const shake = game.shakeAmount || 0;
  const sx = shake ? (Math.random() - 0.5) * shake * 2.2 : 0;
  const sz = shake ? (Math.random() - 0.5) * shake * 2.2 : 0;

  camera.position.set(camLook.x + CAM_OFFSET.x + sx, CAM_OFFSET.y, camLook.z + CAM_OFFSET.z + sz);
  camera.lookAt(camLook.x + sx, 0, camLook.z + sz);
}

// --- HUD cursor -----------------------------------------------------------

const barrelPoint = new THREE.Vector3();

function updateCursor() {
  const p = game.player;
  const dx = aimPoint.x - p.x, dz = aimPoint.z - p.z;
  const range = Math.max(Math.hypot(dx, dz), 6);
  // where the gun is actually pointing, at the same range as the cursor
  barrelPoint.set(p.x + Math.sin(p.turret) * range, 0.2, p.z + Math.cos(p.turret) * range);
  const s = game.project(barrelPoint);
  const want = Math.atan2(dx, dz);
  let diff = want - p.turret;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const aligned = Math.abs(diff) < 0.035;
  HUD.cursor(input.mouse.x, input.mouse.y, s ? s.x : input.mouse.x, s ? s.y : input.mouse.y, aligned);
}

// --- loop -----------------------------------------------------------------

let last = performance.now();
let paused = false;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);   // clamp so a tab-out never jumps
  last = now;

  if (input.consumeMute()) Audio.toggleMute();
  if (input.consumePause() && game.running) paused = !paused;

  if (!paused) {
    updateAim();

    if (game.running && game.state !== 'over') {
      const r = input.consumeRound();
      if (r !== null && game.player.selectRound(r)) Audio.play('select');

      if (input.consumeFire()) game.playerFire();
      else if (input.fireHeld && game.player.canFire()) game.playerFire();
      if (input.mgHeld) game.playerMG();

      const wasReady = game.player.reload >= 1;
      game.update(dt, input, aimPoint);
      if (!wasReady && game.player.reload >= 1) Audio.play('reloadDone', { gain: 0.5 });
    } else {
      game.update(dt, input, aimPoint);
    }

    updateCamera(dt);
    HUD.setStats(game.stats());
    HUD.update(dt);
    if (game.running) updateCursor();
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// --- start ----------------------------------------------------------------

const boot = document.getElementById('boot');
const startBtn = document.getElementById('start');

async function begin() {
  startBtn.disabled = true;
  // We are inside a click, which is the only moment a browser will let us start
  // audio; a context created here can still come up suspended, so resume it too.
  Audio.init();
  Audio.resume();
  await document.fonts.ready;
  boot.classList.add('gone');
  document.body.classList.add('playing');
  input.enabled = true;
  HUD.hideGameOver();
  game.playerGroup.visible = true;
  game.start();
  setTimeout(() => { boot.style.display = 'none'; }, 400);
}

startBtn.addEventListener('click', begin);

game.onRestart = () => {
  document.body.classList.add('playing');
  input.enabled = true;
  HUD.hideGameOver();
  game.playerGroup.visible = true;
  game.start();
};

// make the first paint show the arena rather than a black screen
updateAim();
updateCamera(0.016);

/* A handle for the console: lets the scene be re-rendered at an arbitrary buffer
 * size and grabbed, which is the only way to get a decent look at this when the
 * window is small. Harmless in play, and genuinely useful for debugging. */
window.__dbg = { THREE, renderer, scene, camera, game, input, HUD, Audio,
  shot(w = 1600, h = 950, name = 'shot') {
    const prev = new THREE.Vector2();
    renderer.getSize(prev);
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.left = (-VIEW * aspect) / 2; camera.right = (VIEW * aspect) / 2;
    camera.top = VIEW / 2; camera.bottom = -VIEW / 2;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    renderer.setSize(prev.x, prev.y, false);
    resize();
    return fetch(`/__shot/${name}.png`, {
      method: 'POST',
      body: Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0)),
    }).then((r) => r.text());
  },
};
