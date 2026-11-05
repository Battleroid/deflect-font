# DEFLECT

**[Play it](https://caseyweed.com/deflect-font/)**

A top-down tank survival game, and a working argument for the typeface: the HUD, the
damage counters, the RICOCHET indicators and the range markings painted on the ground
are all set in Deflect Stencil.

Static files, no build step. Open `index.html` from any web server:

```bash
python -m http.server 8173 --directory game
```

Published to the `gh-pages` branch by `sh tools/publish_pages.sh` from the repo root.

## Controls

| | |
|---|---|
| `W` `A` `S` `D` | drive the hull |
| mouse | traverse the turret — the crosshair is where you are looking, the circle is where the gun actually is |
| left click | fire the main gun |
| right click | coax machine gun (it overheats) |
| `1` `2` `3` `4` | AP / HE / HEAT / CANISTER |
| `space` | brake |
| `M` | mute |
| `Esc` or `P` | pause |

## How the shooting works

The turret traverses at a fixed rate, so the gun lags the cursor. That gap between the
crosshair and the circle is the game: you lead, you wait for them to meet, you fire.

Hits are resolved against the face you actually struck, at the angle you actually
struck it:

- **RICOCHET** — too oblique, and a solid shot skips off and keeps flying, still live.
  A bounced shell can kill something else.
- **NO PEN** — square enough to bite, not enough penetration to get through.
- **PENETRATION** — through, with damage scaled by how far you overmatched the plate.
- **AMMO RACK** — a lucky hit on a flank or rear, for well over double damage.

Front armour is several times rear armour. A heavy's 240mm frontal plate simply cannot
be beaten by AP's 165 from the front at any range — flank it, or load HEAT, which is a
shaped charge and ignores the angle entirely. Angling your own hull works the same way
in reverse, which is why the camera is tilted enough to show you which way you are
facing.

| Round | Pen | Damage | Notes |
|---|---|---|---|
| AP | 165 | 30 | Fast, flat, ricochets past 66° |
| HE | 45 | 20 | Splash; good against infantry and tracks |
| HEAT | 240 | 38 | Never ricochets; the answer to heavies |
| CANISTER | 14 | 11 × 11 | A cone of pellets; shreds infantry, useless on armour |

## Files

| | |
|---|---|
| `js/main.js` | bootstrap, camera, the frame loop |
| `js/game.js` | world, waves, shell casting, impact resolution |
| `js/entities.js` | player, enemy AI, infantry, shells |
| `js/ballistics.js` | rounds, armour, the penetration model |
| `js/models.js` | every mesh, and the procedural arena |
| `js/hud.js` `js/hud.css` | the overlay, crosshair and hit indicators |
| `js/audio.js` | procedural 8-bit sound, synthesised at runtime |
| `js/decals.js` | ground stencils rendered from the font |
| `js/palette.js` | the only colours anything is allowed to use |
| `js/input.js` | keyboard and mouse |

Three.js is pulled from a CDN via an import map; there is nothing to install and
nothing to compile.
