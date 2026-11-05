/* The whole game's colour scheme. Six working colours and an ink outline: flat
 * fills, hard edges, no gradients anywhere. Everything -- meshes, HUD, indicators
 * -- reads from here so nothing drifts.
 *
 * HEX is for three.js (numbers), CSS is the same values as strings. */

export const HEX = {
  /* The environment lives in four steps of one olive-drab ramp, spaced widely
   * enough to read against each other at a glance but all kept well below the
   * units: bone and red must stay the brightest things on screen. */
  void:      0x0d0d0a,   // beyond the arena, and the clear colour
  char:      0x100e09,   // burnt earth: crater floors, shadow, hollows
  ground:    0x1b1a12,   // the arena floor
  grid:      0x332f20,   // floor grid, berms, mud, hedgerows
  edge:      0x514a36,   // concrete: walls, teeth, kerbs, the boundary

  bone:      0xe9e4d2,   // the player
  boneDim:   0xb6b1a0,

  red:       0xd6412a,   // enemy armour
  redLight:  0xe8714a,   // light tank
  redDark:   0x8c2a1a,   // heavy tank

  amber:     0xf2c230,   // UI, infantry, muzzle flash
  amberDim:  0xa8861b,

  blue:      0x5bc8e8,   // deflection
  grey:      0x8a8578,   // failed penetration

  ink:       0x080806,   // every outline
  white:     0xfffdf5,
};

const css = (v) => '#' + v.toString(16).padStart(6, '0');

export const CSS = Object.fromEntries(
  Object.entries(HEX).map(([k, v]) => [k, css(v)])
);

/* What each hit outcome looks like, shared by the indicators and the sparks. */
export const OUTCOME = {
  ricochet: { hex: HEX.blue,  css: CSS.blue,  label: 'RICOCHET' },
  nonpen:   { hex: HEX.grey,  css: CSS.grey,  label: 'NO PEN' },
  pen:      { hex: HEX.red,   css: CSS.red,   label: 'PENETRATION' },
  crit:     { hex: HEX.amber, css: CSS.amber, label: 'AMMO RACK' },
  kill:     { hex: HEX.amber, css: CSS.amber, label: 'KILL' },
  damage:   { hex: HEX.bone,  css: CSS.bone,  label: '' },
  taken:    { hex: HEX.red,   css: CSS.red,   label: '' },
};
