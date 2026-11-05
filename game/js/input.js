/* Keyboard and mouse. Keeps a snapshot the game reads once per frame, plus
 * edge-triggered flags the game consumes, so a click between two frames is never
 * swallowed. */

export class Input {
  constructor(target) {
    this.target = target;
    this.keys = new Set();
    this.mouse = { x: 0, y: 0 };      // CSS pixels
    this.fireHeld = false;
    this.mgHeld = false;
    this._firePressed = false;        // consumed by the game
    this._roundRequest = null;
    this._paused = false;
    this.enabled = false;
    this._bind();
  }

  _bind() {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code >= 'Digit1' && e.code <= 'Digit4') {
        this._roundRequest = Number(e.code.slice(5)) - 1;
      }
      if (e.code === 'KeyM') this._muteToggle = true;
      if (e.code === 'Escape' || e.code === 'KeyP') this._pauseToggle = true;
      // stop the page scrolling out from under the game
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) stop(e);
    });

    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.fireHeld = this.mgHeld = false; });

    const el = this.target;
    el.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
    el.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      stop(e);
      if (e.button === 0) { this.fireHeld = true; this._firePressed = true; }
      if (e.button === 2) this.mgHeld = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
      if (e.button === 2) this.mgHeld = false;
    });
    // right-click is the coax gun, so the context menu has to go
    el.addEventListener('contextmenu', stop);
  }

  /* Drive inputs, normalised. */
  get throttle() {
    return (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0)
         - (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
  }

  get steer() {
    return (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0)
         - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
  }

  get braking() { return this.keys.has('Space'); }

  consumeFire() { const v = this._firePressed; this._firePressed = false; return v; }
  consumeRound() { const v = this._roundRequest; this._roundRequest = null; return v; }
  consumeMute() { const v = this._muteToggle; this._muteToggle = false; return v; }
  consumePause() { const v = this._pauseToggle; this._pauseToggle = false; return v; }
}
