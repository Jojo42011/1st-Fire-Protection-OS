/* Ask the Operator - the particle orb.
   A fibonacci-sphere point cloud with layered sine-noise ridges, depth shading and additive
   bloom: cool blue-violet at the crown running to magenta and hot orange-gold along the lower
   arc. Ridges live in brightness and dot size, so the silhouette stays round.

   Interaction: drag to spin (with inertia), pointer parallax, click to pulse.
   `state` (idle | listening | thinking | speaking) drives energy. Renders no data. */
(function () {
  const TAU = Math.PI * 2;

  const RAMP = [
    [0.00, [86, 132, 255]],
    [0.16, [70, 86, 214]],
    [0.34, [104, 58, 178]],
    [0.52, [162, 44, 152]],
    [0.68, [224, 45, 98]],
    [0.84, [255, 92, 60]],
    [1.00, [255, 176, 58]]
  ];
  function ramp(t) {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    for (let i = 1; i < RAMP.length; i++) {
      if (t <= RAMP[i][0]) {
        const a = RAMP[i - 1], b = RAMP[i], k = (t - a[0]) / (b[0] - a[0]);
        return [
          Math.round(a[1][0] + (b[1][0] - a[1][0]) * k),
          Math.round(a[1][1] + (b[1][1] - a[1][1]) * k),
          Math.round(a[1][2] + (b[1][2] - a[1][2]) * k)
        ];
      }
    }
    return RAMP[RAMP.length - 1][1];
  }

  class AiOrb extends HTMLElement {
    connectedCallback() {
      if (this._built) { this._start(); return; }
      this._built = true;
      this.style.display = 'block';
      this.style.position = 'relative';
      this.style.aspectRatio = '1 / 1';
      this.style.flex = 'none';

      this._canvas = document.createElement('canvas');
      this._canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:grab';
      this.appendChild(this._canvas);
      this._ctx = this._canvas.getContext('2d');

      const N = Number(this.getAttribute('points')) || 4200;
      this._pts = [];
      for (let i = 0; i < N; i++) {
        const y = 1 - (i / (N - 1)) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const th = i * 2.39996323;
        this._pts.push([Math.cos(th) * r, y, Math.sin(th) * r, Math.random()]);
      }

      this._rot = 0.4; this._vel = 0.0022; this._tilt = 0.22;
      this._t = 0; this._energy = 1; this._pulse = 0; this._frames = 0;
      this._px = 0; this._py = 0; this._tpx = 0; this._tpy = 0;
      this._drag = null;
      this._reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      this.addEventListener('pointerdown', e => {
        this._drag = { x: e.clientX, rot: this._rot, t: performance.now(), last: e.clientX };
        this._canvas.style.cursor = 'grabbing';
        try { this.setPointerCapture(e.pointerId); } catch (_) {}
      });
      this.addEventListener('pointermove', e => {
        const b = this.getBoundingClientRect();
        this._tpx = ((e.clientX - b.left) / b.width - 0.5) * 2;
        this._tpy = ((e.clientY - b.top) / b.height - 0.5) * 2;
        if (this._drag) {
          const d = this._drag;
          this._rot = d.rot + (e.clientX - d.x) * 0.008;
          const now = performance.now();
          if (now > d.t + 8) { this._vel = ((e.clientX - d.last) * 0.008) / ((now - d.t) / 16.7); d.t = now; d.last = e.clientX; }
        }
      });
      const end = () => { this._drag = null; this._canvas.style.cursor = 'grab'; };
      this.addEventListener('pointerup', end);
      this.addEventListener('pointercancel', end);
      this.addEventListener('pointerleave', () => { this._tpx = 0; this._tpy = 0; end(); });
      this.addEventListener('click', () => { this._pulse = 1; });

      this._loop = this._loop.bind(this);
      this._rafTick = () => {
        if (this._timer) {                                 // vsync is back: drop the timer, resync dt
          this._win().clearInterval(this._timer);
          this._timer = null;
          this._last = (this._win().performance || performance).now();
        }
        this._loop();
        this._raf = this._win().requestAnimationFrame(this._rafTick);
      };
      this._start();
    }

    disconnectedCallback() { this._stop(); }

    _win() { return (this.ownerDocument && this.ownerDocument.defaultView) || window; }

    _start() {
      const win = this._win();
      this._stop();
      this._raf = win.requestAnimationFrame(this._rafTick);
      this._watch = win.setTimeout(() => {
        const doc = this.ownerDocument;
        const hidden = doc && doc.visibilityState === 'hidden';
        if (!hidden && (this._frames || 0) < 4) this._timer = win.setInterval(this._loop, 1000 / 60);
      }, 400);
    }

    _stop() {
      const win = this._win();
      if (this._raf) win.cancelAnimationFrame(this._raf);
      if (this._timer) win.clearInterval(this._timer);
      if (this._watch) win.clearTimeout(this._watch);
      this._raf = this._timer = this._watch = null;
    }

    _targetEnergy() {
      const s = this.getAttribute('state') || 'idle';
      return s === 'speaking' ? 1.9 : s === 'thinking' ? 1.5 : s === 'listening' ? 1.25 : 1;
    }

    _loop() {
      const cv = this._canvas, ctx = this._ctx;
      const box = this.getBoundingClientRect();
      const w = Math.round(box.width) || cv.clientWidth;
      const h = Math.round(box.height) || cv.clientHeight;
      if (!w || !h) return;

      // one draw per frame, whichever clock woke us (prevents double-draw flicker)
      const now = (this._win().performance || performance).now();
      if (now - (this._last || 0) < 9) return;
      const dt = Math.min(2.5, (now - (this._last || now - 16.7)) / 16.7);
      this._last = now;
      this._frames++;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
        cv.style.width = w + 'px'; cv.style.height = h + 'px';
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      this._t += dt / 60;
      this._energy += (this._targetEnergy() - this._energy) * 0.05 * dt;
      this._pulse *= Math.pow(0.94, dt);
      this._px += (this._tpx - this._px) * 0.07 * dt;
      this._py += (this._tpy - this._py) * 0.07 * dt;
      if (!this._drag) {
        this._vel += (0.0022 - this._vel) * 0.02 * dt;
        if (!this._reduced) this._rot += this._vel * dt * (0.7 + this._energy * 0.5);
      }

      const cx = w / 2 + this._px * 10;
      const cy = h / 2 + this._py * 8;
      const R = Math.min(w, h) * 0.36;
      const tilt = this._tilt + this._py * 0.12;
      const cosR = Math.cos(this._rot), sinR = Math.sin(this._rot);
      const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
      const t = this._t, E = this._energy + this._pulse * 0.8;

      ctx.globalCompositeOperation = 'lighter';

      for (let i = 0; i < this._pts.length; i++) {
        const p = this._pts[i];
        const n =
          Math.sin(p[0] * 3.1 + t * 0.7) * 0.5 +
          Math.sin(p[1] * 4.3 - t * 0.9) * 0.34 +
          Math.sin(p[2] * 5.7 + t * 0.5) * 0.22 +
          Math.sin((p[0] + p[2]) * 8.2 - t * 1.3) * 0.12;
        const ridge = Math.pow(Math.abs(n), 1.6);
        const disp = 1 + (0.022 + 0.045 * (E - 1)) * n + 0.028 * ridge * E + this._pulse * 0.04;

        const x0 = p[0] * disp, y0 = p[1] * disp, z0 = p[2] * disp;
        const x = x0 * cosR + z0 * sinR;
        const zr = -x0 * sinR + z0 * cosR;
        const y = y0 * cosT - zr * sinT;
        const z = y0 * sinT + zr * cosT;

        const depth = (z + 1) / 2;
        const lat = (y0 + 1) / 2;                  // screen space: 0 top, 1 bottom
        const heat = lat + ridge * 0.3;            // hot along the lower arc
        const c = ramp(heat);

        const rim = Math.pow(Math.abs(y0), 2.2);
        const alpha = (0.08 + depth * 0.5) * (0.5 + rim * 0.85) * (0.5 + 1.05 * ridge * E) * (0.8 + p[3] * 0.4);
        const size = (0.5 + depth * 1.15) * (0.8 + ridge * 1.15 * E);

        ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + Math.min(1, alpha).toFixed(3) + ')';
        ctx.fillRect(cx + x * R - size / 2, cy + y * R - size / 2, size, size);
      }

      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.9);
      g.addColorStop(0, 'rgba(70,90,190,' + (0.12 + this._pulse * 0.1).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.9, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';

    }
  }

  if (!customElements.get('ai-orb')) customElements.define('ai-orb', AiOrb);
})();
