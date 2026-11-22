(() => {
  "use strict";

  const SCRIPT_DIR = (document.currentScript && document.currentScript.src ? document.currentScript.src : "").replace(/[^/]*$/, "");
  const A = window.SIDEWINDER_ASSETS;

  // --- Analytics (Google Analytics 4): how far people get, where they die, what they buy ---
  // Put the property's Measurement ID here ("G-XXXXXXXXXX"). While it is empty nothing is loaded or sent.
  // It is also skipped when the game is opened straight from disk, so playing your own copy is never counted.
  const GA_ID = "G-C206274WSE";
  if (GA_ID && location.protocol.startsWith("http")) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", GA_ID);
    const tag = document.createElement("script");
    tag.async = true;
    tag.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
    document.head.appendChild(tag);
  }
  if (window.gtag) {
    const note = document.getElementById("statsNote");
    if (note) note.hidden = false; // say so on the page whenever it is switched on
  }
  const track = (name, params = {}) => {
    if (window.gtag) window.gtag("event", name, params);
  };
  if (!A) {
    throw new Error("SIDEWINDER_ASSETS bundle missing. Run build_port.py first.");
  }

  const BASE_W = 416; // world pixels across the screen on level 1: one lane's width (the Amiga showed a 320-wide window)
  let ZOOM = 1; // how far the camera has pulled back: it shows ZOOM times as much of the world each way (see applyZoom())
  let VIEW_W = BASE_W;
  const UI_W = 320; // title, menu and message boxes are laid out 320 wide and centred
  const UI_H = 200;
  const UI_OX = (BASE_W - UI_W) / 2;
  const UI_OY = () => Math.floor((VIEW_H - UI_H) / 2);
  const BASE_SHIELDS = 2;
  const RAPID_DROP_EVERY = 20; // every Nth destroyed enemy leaves a rapid-fire pick-up
  const RAPID_DROP_TICKS = 400; // 8 s of rapid fire per pick-up
  const SHIELD_HIT_INVULN = 55; // ticks of safety after a shield absorbs a hit
  const SHIELD_DROP_EVERY = 36; // every Nth destroyed enemy leaves a shield pick-up
  const SHOT_SPEED = 8.5;
  const BOMB_COOLDOWN = 75; // 1.5 s at 50 Hz
  const BOMB_FUSE = 26; // ticks from release to detonation
  const BOMB_SPEED = 2.7; // px per tick, straight ahead
  const BOMB_RADIUS = 46; // blast circle ~3 jet lengths across
  const BOMB_DAMAGE = 6;
  let VIEW_H = 200; // world pixels of playfield shown top to bottom; grows to fill a taller window (see layout())
  // The playfield is seen from a camera tipped forward: the far (top) edge is drawn at PERSP_TOP of the size of
  // the near (bottom) edge. Game logic stays flat; only drawing goes through project().
  const PERSP_TOP = 0.8;
  let TILT = 1; // 1 = the usual tipped-forward camera, 0 = flat (the formation stage draws what flies flat against the sky)
  let PERSP_A = (1 - PERSP_TOP) / VIEW_H;
  let PERSP_C = PERSP_TOP; // chosen so the visible depth is still exactly VIEW_H world pixels
  function setTilt(t) {
    TILT = t;
    PERSP_A = ((1 - PERSP_TOP) / VIEW_H) * t;
    PERSP_C = 1 - (1 - PERSP_TOP) * t;
  }
  // The horizon view (the formation stage and the boss behind it): the ground gets a camera of its own that drops
  // low until the land runs away to a horizon HORIZON of the way up the screen, with open sky above it, while
  // everything that flies is drawn flat against that sky.
  const HORIZON = 0.45;
  let GROUND_VIEW = false; // true while drawing things that sit on the ground
  function groundCam() {
    const w = state.wave;
    const A0 = (1 - PERSP_TOP) / VIEW_H;
    if (!w) return { A: PERSP_A, C: PERSP_C, e: 0 };
    const e = w.flat * w.flat * (3 - 2 * w.flat);
    return { A: A0 + (1 / (HORIZON * VIEW_H) - A0) * e, C: PERSP_TOP + (1.4 - PERSP_TOP) * e, e };
  }
  const HUD_H = 16; // the status strip: one slim line
  const MAP_COLS = 26;
  const MAP_ROWS = 228;
  const MAP_W = MAP_COLS * 16; // 416
  const MAP_H = MAP_ROWS * 16; // 3648
  // The world is three lanes wide. The middle lane is the level as shipped; the outer two are the same level
  // mirrored left to right (so the ground joins up at the seams), each with its own set of enemies.
  const LANES = 3; // lanes laid side by side: mirrored, original, mirrored
  const WORLD_W = 1248; // the board is all three
  const WIDE_OFF = (MAP_W * LANES - WORLD_W) / 2; // what is trimmed off each side (the generated worlds are three lanes wide too)
  const laneMirrored = (lane) => lane !== 1;
  const START_SCROLL_Y = 3616; // 0x0e20 from fn_00010e20
  const END_SCROLL_Y = 192; // 0x00c0 from fn_000134f4 / fn_00010e20
  const PAL_TICK_MS = 1000 / 50; // PAL Amiga 50 Hz vertical blank

  const DIFFICULTY_NAMES = {
    1: "Beginner",
    2: "Novice",
    3: "Pilot",
    4: "Ace",
    5: "Master",
  };

  // Optional HD sprite redraws (port/assets_hd.js). When present the screen is drawn at HD.scale x the
  // Amiga resolution; all game logic, positions and collisions stay in original 320x200 pixel units.
  const HD = window.SIDEWINDER_HD || null;
  const RENDER_SCALE = HD ? HD.scale : 1;
  const hdImages = {};
  // Optional smoothed level backgrounds and crater decals (port/assets_hd_maps.js), drawn at HDM.scale x.
  const HDM = window.SIDEWINDER_HD_MAPS || null;
  const MAP_SCALE = HDM ? HDM.scale : 1;
  const hdMapImages = {};
  const hdRubbleImages = {};

  const canvas = document.getElementById("screen");
  const ctx = canvas.getContext("2d");

  // The picture fills the window. Its width is always VIEW_W world pixels; a taller window shows more of the
  // level ahead (between 200 and 330 rows) rather than leaving bars above and below.
  function layout() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const total = Math.max(200 + HUD_H, Math.min(330 + HUD_H, Math.round((BASE_W * h) / w)));
    // the canvas keeps its size in pixels; pulling the camera back just fits more world into it
    VIEW_W = Math.round(BASE_W * ZOOM);
    VIEW_H = Math.round((total - HUD_H) * ZOOM);
    setTilt(TILT);
    if (canvas.width !== BASE_W * RENDER_SCALE) canvas.width = BASE_W * RENDER_SCALE;
    if (canvas.height !== total * RENDER_SCALE) canvas.height = total * RENDER_SCALE;
  }
  layout();
  const relayout = () => {
    layout();
    if (state.loaded) render(); // resizing wipes the canvas, so repaint straight away
  };
  window.addEventListener("resize", relayout);
  document.addEventListener("fullscreenchange", relayout);

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  }

  const ui = {
    levelSelect: document.getElementById("levelSelect"),
    diffSelect: document.getElementById("diffSelect"),
    trainerBtn: document.getElementById("trainerBtn"),
    sfxBtn: document.getElementById("sfxBtn"),
    bgmBtn: document.getElementById("bgmBtn"),
    joyBadge: document.getElementById("joyBadge"),
    pauseBtn: document.getElementById("pauseBtn"),
    restartBtn: document.getElementById("restartBtn"),
    fullBtn: document.getElementById("fullBtn"),
  };

  // --- Decode assets (Images, Tilemaps, AudioBuffers) ---
  const images = {};
  const tileImages = {};
  const maps = {};

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (err) => reject(err);
      img.src = src;
    });
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  // Background sound for each scene. Each one is synthesised (filtered noise plus a drone) unless a recording is
  // dropped in next to game.js as ambient/<name>.mp3 (level1.mp3 ... level6.mp3, cave.mp3), which then plays instead.
  //   noise: [filter type, Hz, Q, level]   drone: [waveform, Hz, level]   lfo: [Hz, depth as a fraction of the filter Hz]
  const AMBIENCE = {
    level1: { noise: ["lowpass", 420, 0.7, 0.5], drone: ["sine", 55, 0.1], lfo: [0.13, 0.5] }, // harbour wash
    level2: { noise: ["bandpass", 120, 5, 0.6], drone: ["sawtooth", 50, 0.035], lfo: [0.4, 0.15] }, // reactor hum
    level3: { noise: ["bandpass", 900, 1.6, 0.3], drone: ["sine", 73, 0.05], lfo: [0.09, 0.7] }, // desert wind
    level4: { noise: ["bandpass", 2100, 12, 0.35], drone: ["triangle", 41, 0.12], lfo: [0.3, 0.25] }, // foundry ring
    level5: { noise: ["lowpass", 210, 2, 0.7], drone: ["sine", 46, 0.14], lfo: [1.1, 0.6] }, // something breathing
    level6: { noise: ["bandpass", 320, 8, 0.5], drone: ["square", 69, 0.025], lfo: [5.5, 0.2] }, // hive buzz
    cave: { noise: ["lowpass", 260, 3, 0.55], drone: ["sine", 36, 0.16], lfo: [0.07, 0.4] }, // deep and close
    // second loop
    level7: { noise: ["lowpass", 600, 0.6, 0.45], drone: ["sine", 62, 0.08], lfo: [0.1, 0.6] }, // open country wind
    level8: { noise: ["lowpass", 340, 0.9, 0.7], drone: ["sine", 44, 0.1], lfo: [0.16, 0.7] }, // heavy swell
    level9: { noise: ["bandpass", 180, 3, 0.5], drone: ["sawtooth", 58, 0.03], lfo: [0.25, 0.3] }, // city rumble
    level10: { noise: ["bandpass", 3200, 14, 0.12], drone: ["sine", 33, 0.2], lfo: [0.05, 0.3] }, // near silence, a hull tone
    level11: { noise: ["bandpass", 1400, 18, 0.14], drone: ["triangle", 49, 0.14], lfo: [0.08, 0.2] }, // radio hiss
    level12: { noise: ["lowpass", 150, 4, 0.9], drone: ["sawtooth", 38, 0.05], lfo: [0.7, 0.5] }, // the ground growling
  };

  // engine loop for each scene: [sample, pitch, level]
  const ENGINE_LOOPS = {
    level1: ["ship_loop_1", 1, 0.3],
    level2: ["ship_loop_2", 1, 0.25],
    level3: ["ship_loop_3", 1, 0.25],
    level4: ["ship_loop_4", 1, 0.4],
    level5: ["ship_loop_5", 1, 0.4],
    level6: ["ship_loop_1", 0.8, 0.3],
    cave: ["ship_loop_4", 0.7, 0.4],
    level7: ["ship_loop_2", 1.15, 0.25],
    level8: ["ship_loop_3", 0.85, 0.25],
    level9: ["ship_loop_5", 1.1, 0.35],
    level10: ["ship_loop_1", 0.65, 0.25],
    level11: ["ship_loop_2", 0.75, 0.25],
    level12: ["ship_loop_4", 0.9, 0.4],
  };

  class SoundEngine {
    constructor() {
      this.ctx = null;
      this.buffers = {};
      this.sfxEnabled = true;
      this.bgmEnabled = false;
      this.channelBusyUntil = [0, 0, 0, 0];
      this.bgmStep = 0;
      this.bgmAccum = 0;
      this.lastPlayed = {};
      this.ambKey = null;
      this.ambNodes = null;
      this.ambFiles = {}; // name -> Audio element, or false once we know there is no recording
    }

    // Switch the background sound (null = silence). Cross-fades over about a second.
    ambient(key) {
      if (key === this.ambKey) return;
      if (key && (!this.ctx || this.ctx.state !== "running" || this.decoding > 0)) return; // not ready to make sound yet; try again next frame
      this.ambKey = key;
      const old = this.ambNodes;
      this.ambNodes = null;
      if (old) {
        if (old.audio) {
          old.audio.pause();
        } else {
          const t = this.ctx.currentTime;
          old.out.gain.setTargetAtTime(0, t, 0.3);
          for (const n of old.sources) n.stop(t + 1.5);
        }
      }
      if (!key) return;
      if (this.ambFiles[key] === undefined) {
        // look for a recording once; until it proves playable the synthesised bed is used
        const audio = new Audio(SCRIPT_DIR + "ambient/" + key + ".mp3");
        audio.loop = true;
        audio.volume = 0.4;
        this.ambFiles[key] = false;
        audio.addEventListener("canplaythrough", () => {
          this.ambFiles[key] = audio;
          if (this.ambKey === key) {
            this.ambKey = null;
            this.ambient(key);
          }
        }, { once: true });
        audio.load();
      }
      if (this.ambFiles[key]) {
        const audio = this.ambFiles[key];
        audio.currentTime = 0;
        audio.play().catch(() => {});
        this.ambNodes = { audio };
        return;
      }
      const spec = AMBIENCE[key];
      if (!spec) return;
      const ctxA = this.ctx;
      const t = ctxA.currentTime;
      if (!this.noiseBuf) {
        this.noiseBuf = ctxA.createBuffer(1, ctxA.sampleRate * 3, ctxA.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      const out = ctxA.createGain();
      out.gain.value = 0;
      out.gain.setTargetAtTime(0.6, t, 0.5);
      out.connect(this.master);
      const noise = ctxA.createBufferSource();
      noise.buffer = this.noiseBuf;
      noise.loop = true;
      const filt = ctxA.createBiquadFilter();
      filt.type = spec.noise[0];
      filt.frequency.value = spec.noise[1];
      filt.Q.value = spec.noise[2];
      const ng = ctxA.createGain();
      ng.gain.value = spec.noise[3];
      noise.connect(filt);
      filt.connect(ng);
      ng.connect(out);
      const lfo = ctxA.createOscillator();
      lfo.frequency.value = spec.lfo[0];
      const lg = ctxA.createGain();
      lg.gain.value = spec.noise[1] * spec.lfo[1];
      lfo.connect(lg);
      lg.connect(filt.frequency);
      const sources = [noise, lfo];
      for (const detune of [-6, 7]) {
        const osc = ctxA.createOscillator();
        osc.type = spec.drone[0];
        osc.frequency.value = spec.drone[1];
        osc.detune.value = detune;
        const dg = ctxA.createGain();
        dg.gain.value = spec.drone[2];
        osc.connect(dg);
        dg.connect(out);
        sources.push(osc);
      }
      // the ship's own engine note runs over the scene's bed: a different recorded loop on every level
      const eng = ENGINE_LOOPS[key];
      if (eng && this.buffers[eng[0]]) {
        const loop = ctxA.createBufferSource();
        loop.buffer = this.buffers[eng[0]];
        loop.loop = true;
        loop.playbackRate.value = eng[1];
        const eg = ctxA.createGain();
        eg.gain.value = eng[2] * 1.6;
        loop.connect(eg);
        eg.connect(out);
        sources.push(loop);
      }
      for (const n of sources) n.start(t);
      this.ambNodes = { out, sources };
    }

    ensureContext() {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        this.ctx = new AudioCtx();
        // everything goes through a limiter, so a lot can sound at once at a healthy level without clipping
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        const limiter = this.ctx.createDynamicsCompressor();
        limiter.threshold.value = -14;
        limiter.knee.value = 10;
        limiter.ratio.value = 6;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.15;
        this.master.connect(limiter);
        limiter.connect(this.ctx.destination);
        this.voices = [];
        this.decodeAll();
      }
      if (this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }

    decodeAll() {
      if (!this.ctx) return;
      // the Amiga's own samples plus the added ones (port/assets_sfx2.js, built from assets/sfx_new)
      const all = { ...A.sfx, ...(window.SIDEWINDER_SFX2 || {}) };
      this.decoding = Object.keys(all).length;
      for (const [name, b64] of Object.entries(all)) {
        const bytes = b64ToBytes(b64.slice(b64.indexOf(",") + 1)).buffer;
        this.ctx.decodeAudioData(
          bytes,
          (buf) => {
            this.buffers[name] = buf;
            this.decoding--;
          },
          () => {
            this.decoding--;
          }
        );
      }
    }

    // maxDur (seconds) cuts the sample short with a quick fade, for sounds that repeat constantly
    // rate re-pitches the sample; gapKey + minGap stop the same sound stacking up when a whole formation triggers it
    play(name, volumeScale = 1.0, maxDur = 0, rate = 1, gapKey = null, minGap = 0) {
      if (!this.sfxEnabled) return;
      if (gapKey) {
        const t = performance.now();
        if (t - (this.lastPlayed[gapKey] || -1e9) < minGap) return;
        this.lastPlayed[gapKey] = t;
      }
      const ctxA = this.ensureContext();
      if (!ctxA) return;
      const buf = this.buffers[name];
      if (!buf) return;
      const added = !A.sfxMeta[name]; // the recorded sounds play at full level; the Amiga ones keep their own mix
      const meta = A.sfxMeta[name] || { period: 370, volume: 64 };
      const now = ctxA.currentTime;
      const src = ctxA.createBufferSource();
      src.buffer = buf;
      // Scale pitch accurately relative to PAL period 370 (~9586 Hz base WAV)
      src.playbackRate.value = Math.max(0.3, Math.min(3.0, Math.max(0.5, Math.min(2.0, 370 / (meta.period || 370))) * rate));
      const gain = ctxA.createGain();
      const level = Math.min(1.5, ((meta.volume || 40) / 64) * (added ? 1 : 1.3) * volumeScale);
      gain.gain.value = level;
      src.connect(gain);
      gain.connect(this.master);
      src.start(now);
      // up to 48 sounds at once; past that the oldest is faded out to make room
      const voice = { src, gain };
      this.voices.push(voice);
      src.onended = () => {
        const i = this.voices.indexOf(voice);
        if (i >= 0) this.voices.splice(i, 1);
      };
      if (this.voices.length > 48) {
        const old = this.voices.shift();
        old.gain.gain.cancelScheduledValues(now);
        old.gain.gain.setTargetAtTime(0, now, 0.01);
        old.src.stop(now + 0.06);
      }
      if (maxDur > 0) {
        gain.gain.setValueAtTime(level, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + maxDur);
        src.stop(now + maxDur + 0.01);
      }
    }

    // the added sample if it has loaded, otherwise the Amiga one
    pick(name, fallback) {
      return this.buffers[name] ? name : fallback;
    }

    // The jet's cannon: three short laser takes in rotation so it never sounds like one sample on repeat,
    // a snappier one under rapid fire, a heavier one for super shots and lance rounds. All cut very short.
    shot(heavy, rapid) {
      this.shotN = ((this.shotN || 0) + 1) % 3;
      const wob = 0.94 + Math.random() * 0.12;
      if (heavy) this.play(this.pick("laser_big", "shot2"), 0.5, 0.3, wob);
      else if (rapid) this.play(this.pick("laser_fast", "shot1"), 0.3, 0.12, wob);
      else this.play(this.pick(["laser_short_a", "laser_short_b", "laser_short_c"][this.shotN], "shot1"), 0.3, 0.16, wob);
    }

    tickBgm(dtSec, playing) {
      if (!this.bgmEnabled || !playing || !this.ctx || this.ctx.state !== "running") return;
      this.bgmAccum += dtSec;
      const stepDur = 0.14;
      if (this.bgmAccum < stepDur) return;
      this.bgmAccum -= stepDur;

      const bassNotes = [55, 55, 65.41, 55, 73.42, 55, 82.41, 73.42, 49, 49, 55, 49, 65.41, 61.74, 55, 49];
      const leadNotes = [220, 0, 329.63, 293.66, 261.63, 0, 220, 329.63, 196, 0, 246.94, 293.66, 329.63, 293.66, 261.63, 220];
      const i = this.bgmStep % bassNotes.length;
      this.bgmStep++;

      const now = this.ctx.currentTime;
      this.synthTone(bassNotes[i], "sawtooth", now, 0.12, 0.08);
      if (leadNotes[i] > 0 && (this.bgmStep & 1) === 1) {
        this.synthTone(leadNotes[i], "square", now, 0.1, 0.045);
      }
    }

    // Interface sounds. These are synthesised rather than samples, so the very first press (which is what wakes
    // the audio up, before any sample has been decoded) is heard too.
    ui(kind) {
      if (!this.sfxEnabled) return;
      const c = this.ensureContext();
      if (!c) return;
      const t = c.currentTime + 0.01;
      const seq = {
        move: [[660, 0, 0.05]],
        toggle: [[784, 0, 0.05], [1047, 0.04, 0.05]],
        select: [[523, 0, 0.07], [784, 0.07, 0.11]],
        back: [[494, 0, 0.06], [330, 0.06, 0.11]],
        start: [[330, 0, 0.08], [494, 0.08, 0.08], [659, 0.16, 0.08], [988, 0.24, 0.1], [1319, 0.34, 0.3]],
      }[kind];
      for (const [f, at, len] of seq || []) {
        this.synthTone(f, "square", t + at, len, 0.09);
        this.synthTone(f * 2, "triangle", t + at, len, 0.06);
        this.synthTone(f / 2, "sine", t + at, len * 1.3, 0.1);
      }
    }

    synthTone(freq, type, t, dur, vol) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.01);
    }
  }

  const sound = new SoundEngine();

  // Every kind of thing has its own voice, made from the game's own samples at different pitches and lengths:
  //   see  = heard once as it comes on screen      [sample, volume, seconds, pitch]
  //   fire = its shot                              [sample, pitch]
  //   die  = pitch of its explosion (bigger things are lower)
  const VOICES = {
    enemy1: { see: ["twi", 0.5, 0.25, 1.0], fire: ["shot5", 1.3], die: 1.5 },
    enemy2: { see: ["twi", 0.55, 0.29, 0.7], fire: ["shot5", 1.0], die: 1.2 },
    enemy3: { see: ["twi", 0.5, 0.2, 1.45], fire: ["shot5", 1.6], die: 1.7 },
    enemy4: { see: ["fighter", 0.6, 0.3, 1.5], fire: ["shot4", 1.4], die: 1.4 },
    enemy5: { see: ["fighter", 0.7, 0.45, 0.8], fire: ["shot4", 1.0], die: 1.1 },
    spinner: { see: ["spin_a", 0.35, 0.6, 1.0], fire: ["shot5", 1.9], die: 1.9 },
    hover: { see: ["spin_b", 0.5, 0.7, 0.8], fire: ["shot4", 0.8], die: 1.0 },
    combine: { see: ["back4", 0.9, 0.6, 1.0], fire: ["shot3", 1.2], die: 0.8 },
    walker1: { see: ["back4", 0.9, 0.4, 1.5], fire: ["shot3", 1.5], die: 1.0 },
    turret1: { see: ["shot4", 0.3, 0.2, 0.5], fire: ["shot3", 0.9], die: 0.9 },
    trapdoor: { see: ["shot4", 0.3, 0.2, 0.4], fire: ["shot4", 0.7], die: 0.9 },
    trapdoor3: { see: ["shot4", 0.3, 0.2, 0.45], fire: ["shot4", 0.75], die: 0.95 },
    trapdoor4: { see: ["shot4", 0.3, 0.2, 0.35], fire: ["shot4", 0.6], die: 0.85 },
    ventlid: { see: ["hum2", 0.4, 0.4, 0.55], fire: ["shot5", 0.7], die: 0.9 },
    jello: { see: ["twi", 0.6, 0.29, 0.45], fire: ["shot5", 0.55], die: 0.7 },
    eye: { see: ["twi", 0.6, 0.29, 0.55], fire: ["shot3", 1.8], die: 1.3 },
    mouthl: { see: ["back4", 1.0, 0.5, 0.6], fire: ["shot3", 0.6], die: 0.6 },
    tower1: { see: ["hum2", 0.5, 0.5, 2.2], fire: ["shot5", 2.2], die: 0.7 },
    bolt: { see: ["hum2", 0.45, 0.4, 2.8], fire: ["shot5", 2.4], die: 2.0 },
    icons: { see: ["icon", 0.3, 0.2, 1.8] },
  };

  // Offscreen map terrain canvas (supports permanent rubble crater stamping like fn_0001230c)
  const mapCanvas = document.createElement("canvas");
  mapCanvas.width = MAP_W * MAP_SCALE;
  mapCanvas.height = MAP_H * MAP_SCALE;
  const mapCtx = mapCanvas.getContext("2d");
  mapCtx.imageSmoothingEnabled = false;


  // --- Real-time 3D ground (WebGL) -------------------------------------------------------------------
  // For levels that ship height/material data (port/assets_hd_fx.js) the ground is lit per pixel on the GPU instead of
  // being blitted: relief from the recovered height map, wet highlights, slime, breathing flesh, glowing pits.
  // Layout is untouched: the shader samples the very same map canvas the 2D path draws (only the visible
  // strip is sent to the GPU each frame, so craters stamped into the map show up with no extra work).
  const hdFxImages = {};
  const FX_PAD_TOP = 12; // extra map rows sent above / below the view, for parallax and shadow look-ups
  const FX_PAD_BOTTOM = 28;
  const FX_PAD_X = 16;
  const stripW = () => Math.ceil(VIEW_W / PERSP_TOP) + 2 * FX_PAD_X; // world pixels across the far edge of the view, plus padding
  // The part of the world around the view, flattened from the lane map each frame: lanes side by side (outer
  // ones mirrored) with the craters blasted so far drawn on top.
  const strip = document.createElement("canvas");
  const stripCtx = strip.getContext("2d");
  const stripAt = { x: 0, y: 0 }; // world position of the strip's top-left corner
  const fx = { canvas: null, gl: null, prog: null, uni: {}, texAlb: null, texAux: null, active: false, failed: false };

  const FX_VERT = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() { vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FX_FRAG = `
    precision highp float;
    uniform sampler2D uAlb, uAux;
    uniform vec2 uMap, uView, uStrip, uStripX;   // uStrip = world y of the albedo strip's top row, and its height; uStripX = same for x
    uniform vec4 uFold;                     // horizon view: the box of loaded map (x0, x1, y0, y1) the ground repeats from
    float fold(float v, float a, float b) { float r = b - a; float t = mod(v - a, 2.0 * r); return a + (t > r ? 2.0 * r - t : t); }
    uniform float uT, uBottom, uPA, uPC;    // uBottom = world y at the bottom edge of the screen
    uniform float uCam, uWorld, uAuxW, uAuxOff;      // uAuxW = world width the aux texture covers (one lane, or the whole world)             // world x at the centre of the screen; width of the whole world
    uniform vec3 uP;
    // per-level look
    uniform float uOrganic, uSlime, uSlimeOnMetal, uRelief, uSpec, uSpecPow, uSat, uGlow, uWarp, uPar, uGrunge, uRain, uCity, uSpace, uLava;
    uniform vec3 uSlimeCol, uVoidA, uVoidB, uFog;
    varying vec2 vUv;

    float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
    }
    float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }

    // aux texture: r = height, g = 0.5 neutral / up = water / down = metal, b = void
    vec4 material(vec2 mp) {
      float wx = mp.x + uAuxOff;                                               // board x -> x across the three lanes
      float lx = uMap.x - abs(mod(wx - uMap.x, 2.0 * uMap.x) - uMap.x);       // -> x within its (mirrored) lane
      if (uAuxW > uMap.x + 1.0) lx = wx;                                    // wide levels: no lanes, one continuous map
      vec3 a = texture2D(uAux, vec2(lx / uAuxW, mp.y / uMap.y)).rgb;
      return vec4(a.r, clamp((a.g - 0.5) * 2.0, 0.0, 1.0), clamp((0.5 - a.g) * 2.0, 0.0, 1.0), a.b);  // height, water, metal, void
    }
    vec3 albedo(vec2 mp) { return texture2D(uAlb, vec2((mp.x - uStripX.x) / uStripX.y, (mp.y - uStrip.x) / uStrip.y)).rgb; }

    // ooze / standing oil: slow crawling blobs that settle in the low ground
    float slime(vec2 mp, float h) {
      float n = fbm(mp * 0.030 + vec2(0.0, -uT * 0.035)) + 0.35 * fbm(mp * 0.11 + vec2(uT * 0.05, 0.0));
      float a = 1.0 - 0.28 * uSlime;
      return smoothstep(a, a + 0.14, n + (0.5 - h) * 0.9) * step(0.01, uSlime);
    }

    float height(vec2 mp) {
      vec4 m = material(mp);
      float soft = (1.0 - m.z) * (1.0 - m.w) * (1.0 - m.y) * uOrganic;        // living ground only
      float h = m.x;
      h += soft * 0.030 * sin(uT * 1.7 + fbm(mp * 0.018) * 10.0);             // slow breathing swell
      h += soft * 0.020 * (fbm(mp * 0.55 + vec2(0.0, uT * 0.12)) - 0.5);      // crawling wrinkles
      h += soft * 0.010 * (noise(mp * 2.6) - 0.5);                            // pores
      float solid = (1.0 - m.w) * (1.0 - m.y) * mix(1.0 - m.z, 1.0, uSlimeOnMetal);
      float g = slime(mp, m.x) * solid;
      float liquid = 0.56 + 0.006 * sin(mp.x * 0.9 + uT * 2.3) * sin(mp.y * 0.8 - uT * 1.9);
      return mix(h, max(h, liquid), g);
    }

    // far below: a lit sprawl that scrolls at half the speed of the ground (seen through pits, water and past the map edge)
    vec3 deepLayer(vec2 mp) {
      if (uSpace > 0.5) {
        // open space: a faint nebula and two depths of stars, hardly moving as the ground goes by
        vec2 s = vec2(mp.x, mp.y - 0.85 * uBottom);
        vec3 sky = uVoidA * pow(fbm(s * 0.012), 3.0) * 0.5 + uVoidB * pow(fbm(s * 0.009 + 9.0), 4.0) * 0.6;
        for (int i = 0; i < 2; i++) {
          float cell = i == 0 ? 7.0 : 15.0;
          vec2 sq = vec2(mp.x, mp.y - (i == 0 ? 0.85 : 0.7) * uBottom) / cell;
          vec2 id = floor(sq), f = fract(sq);
          float r = hash(id + float(i) * 17.0);
          vec2 at = 0.2 + 0.6 * vec2(hash(id + 1.3), hash(id + 2.1));
          float tw = 0.7 + 0.3 * sin(uT * (1.0 + r * 4.0) + r * 50.0);
          sky += mix(vec3(0.7, 0.85, 1.0), vec3(1.0, 0.9, 0.75), hash(id + 5.0)) * step(0.80, r) * smoothstep(i == 0 ? 0.16 : 0.11, 0.0, length(f - at)) * tw * (i == 0 ? 0.8 : 1.5);
        }
        return sky;
      }
      vec2 q = vec2(mp.x, mp.y - 0.5 * uBottom);
      vec2 sw = q * 0.05 + vec2(sin(uT * 0.4), cos(uT * 0.33)) * 0.6;
      float deep = fbm(sw + fbm(sw * 1.7 + uT * 0.15) * 2.0);
      vec3 col = uVoidA * pow(deep, 3.0) * 1.2 + uVoidB * pow(1.0 - deep, 4.0) * 0.4;
      vec2 id = floor(q / 5.0), f = fract(q / 5.0);
      float r = hash(id);
      float lamp = step(0.84, r) * smoothstep(0.42, 0.05, length(f - 0.5)) * (0.6 + 0.4 * sin(uT * (2.0 + r * 5.0) + r * 40.0));
      float street = smoothstep(0.10, 0.0, min(f.x, f.y)) * step(0.5, hash(floor(q / 20.0))) * 0.22;
      vec3 neon = mix(uVoidA, uVoidB, hash(id + 3.7));
      return mix(col, col * 0.35 + neon * (lamp * 1.6 + street), uCity);
    }

    void main() {
      // screen pixel -> point on the tilted ground plane
      vec2 scr = vUv * uView;
      float u = uView.y - scr.y;
      float sc = max(0.004, 1.0 - uPA * u);
      vec2 mp0 = vec2(uCam + (scr.x - uView.x * 0.5) / sc, uBottom - uPC * u / sc);
      if (uFold.y > uFold.x) mp0 = vec2(fold(mp0.x, uFold.x, uFold.y), fold(mp0.y, uFold.z, uFold.w));
      mp0 += uWarp * vec2(sin(mp0.y * 0.11 + uT * 1.3), cos(mp0.x * 0.09 + uT * 1.1));

      // parallax: walk the view ray down through the height field, so raised things lean and low things sink
      vec2 off = vec2((mp0.x - uCam) / uMap.x * 0.7, 1.0) * uPar;
      float rh = 0.86;
      vec2 mp = mp0 + off * (rh - 0.5);
      float stepH = 0.86 / 16.0, prevGap = 0.4;
      for (int i = 0; i < 16; i++) {
        float gap = rh - material(mp).x;
        if (gap <= 0.0) {
          rh += stepH * gap / (gap - prevGap);     // slide back to where the ray actually met the surface
          mp = mp0 + off * (rh - 0.5);
          break;
        }
        prevGap = gap;
        rh -= stepH;
        mp = mp0 + off * (rh - 0.5);
      }
      float outside = step(mp.x, 0.0) + step(uWorld, mp.x);

      vec4 m = material(mp);
      float water = m.y, metal = m.z, pit = m.w;
      float solid = (1.0 - water) * (1.0 - pit);

      // base colour from the map, sharpened
      vec3 c0 = albedo(mp);
      vec3 blur = (albedo(mp + vec2(0.3, 0)) + albedo(mp - vec2(0.3, 0)) + albedo(mp + vec2(0, 0.3)) + albedo(mp - vec2(0, 0.3))) * 0.25;
      vec3 alb = clamp(c0 + (c0 - blur) * 1.6, 0.0, 1.0);
      float cmax = max(c0.r, max(c0.g, c0.b)), cmin = min(c0.r, min(c0.g, c0.b));
      float emis = smoothstep(0.78, 0.95, (cmax - cmin) / max(cmax, 0.001)) * smoothstep(0.80, 1.0, cmax) * solid;   // lamps

      // grime: stains, rust runs down the metal, dirt packed into everything
      float dirt = 0.6 * fbm(mp * 0.045) + 0.4 * fbm(mp * 0.37);
      float stain = smoothstep(0.30, 0.72, dirt);
      float rust = smoothstep(0.50, 0.78, fbm(vec2(mp.x * 0.85, mp.y * 0.07))) * metal * uGrunge;
      float scratch = smoothstep(0.90, 1.0, noise(vec2(mp.x * 0.35 + mp.y * 1.9, mp.y * 0.05) * 2.0)) * uGrunge;
      alb *= mix(1.0, mix(0.62, 1.08, stain), uGrunge * (1.0 - emis));
      alb = mix(alb, vec3(0.34, 0.15, 0.05) * (0.5 + dot(alb, vec3(0.6))), rust * 0.65);

      // surface normal from the height field
      float e = 0.35;
      float hx = height(mp + vec2(e, 0)) - height(mp - vec2(e, 0));
      float hy = height(mp + vec2(0, e)) - height(mp - vec2(0, e));
      float relief = mix(uRelief, uRelief * 0.6, metal);
      vec3 n = normalize(vec3(-hx * relief / e, -hy * relief / e, 1.0));
      float h = height(mp);

      float redness = smoothstep(0.10, 0.22, c0.r - max(c0.g, c0.b) * 1.25);
      float bare = mix(1.0 - emis, redness, step(0.5, uOrganic));
      float g = slime(mp, m.x) * solid * mix(1.0 - metal, 1.0, uSlimeOnMetal) * bare;

      // cast shadow: walk from the surface toward the key light and see if the ground rises above the ray
      vec3 V = vec3(0.0, 0.0, 1.0);
      vec3 L = normalize(vec3(-0.55, -0.62, 0.50));
      float sh = 0.0;
      for (int i = 1; i <= 6; i++) {
        float d = float(i) * 1.3;
        sh = max(sh, material(mp + L.xy / length(L.xy) * d).x - (m.x + d * 0.62 / uPar));
      }
      float lit = 1.0 - 0.75 * smoothstep(0.0, 0.05, sh);

      // two-tone street lighting: cold key from the upper left, magenta spill from the right
      vec3 L2 = normalize(vec3(0.75, 0.30, 0.42));
      vec3 keyCol = vec3(0.72, 0.92, 1.0), fillCol = vec3(1.0, 0.22, 0.75);
      float dif = max(dot(n, L), 0.0) * lit;
      float dif2 = max(dot(n, L2), 0.0);
      float spec = pow(max(dot(n, normalize(L + V)), 0.0), mix(uSpecPow, 90.0, g)) * lit * (1.0 - rust);
      float spec2 = pow(max(dot(n, normalize(L2 + V)), 0.0), mix(uSpecPow, 90.0, g) * 0.6) * (1.0 - rust);
      float rim = pow(1.0 - max(n.z, 0.0), 2.0);

      float lum = dot(alb, vec3(0.3, 0.59, 0.11));
      vec3 fl = mix(vec3(lum), alb, uSat);
      float occ = clamp(0.45 + (h - 0.5) * 2.6, 0.15, 1.15);
      float pulse = 0.5 + 0.5 * sin(uT * 3.2 - mp.y * 0.045 + fbm(mp * 0.03) * 6.0);
      vec3 light = (0.20 + 1.0 * dif) * keyCol + 0.18 * dif2 * fillCol;
      vec3 colS = fl * light * occ + (keyCol * spec + fillCol * spec2 * 0.4) * uSpec + scratch * spec * 0.6;
      colS += uOrganic * (fl * vec3(1.0, 0.25, 0.2) * rim * 0.35 + vec3(0.9, 0.12, 0.10) * smoothstep(0.52, 0.66, h) * pulse * 0.16);

      // lamps throb, and their glow bleeds onto whatever is next to them
      float throb = 0.55 + 0.45 * sin(uT * 5.0 + floor(mp.x / 16.0) * 1.7 + floor(mp.y / 16.0) * 2.3);
      throb = mix(throb, 0.80 + 0.20 * sin(uT * 1.4 + fbm(mp * 0.03) * 9.0), uLava);   // molten ground swells slowly instead of blinking
      vec3 halo = vec3(0.0);
      for (int i = 0; i < 8; i++) {
        float ang = float(i) * 0.7854;
        vec3 c = albedo(mp + vec2(cos(ang), sin(ang)) * (i - (i / 2) * 2 == 0 ? 2.5 : 5.0));
        float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
        halo += c * smoothstep(0.78, 0.95, (mx - mn) / max(mx, 0.001)) * smoothstep(0.80, 1.0, mx);
      }
      vec3 glow = (alb * emis * 1.2 + halo * 0.16) * uGlow * throb;

      // ooze / oil: translucent over the ground, mirror-wet, picks up both lights
      vec3 goo = mix(fl * 0.45, uSlimeCol, 0.65) * light + ((uSlimeCol * 0.4 + 0.6) * keyCol * spec + fillCol * spec2) * 1.5;
      colS = mix(colS, goo, g * 0.85) + glow * solid;

      // metal: hard and cold, streaked
      float streak = 0.5 + 0.5 * sin((n.x * 3.0 + n.y * 2.0) * 6.0 + mp.y * 0.02);
      vec3 colM = alb * light * mix(1.0, occ, 0.6) + (keyCol * spec + fillCol * spec2 * 0.45) * 0.9 + keyCol * streak * 0.04 + scratch * spec;
      colM = mix(colM, goo, g * 0.85) + glow;

      // water: black harbour water with the sprawl's light smeared across it
      vec2 wp = mp * 0.10;
      float w1 = fbm(wp + vec2(uT * 0.22, uT * 0.09)), w2 = fbm(wp * 1.9 - vec2(uT * 0.18, -uT * 0.14));
      vec3 wn = normalize(vec3((w1 - 0.5) * 1.8, (w2 - 0.5) * 1.8, 1.0));
      float wsp = pow(max(dot(wn, normalize(L + V)), 0.0), 140.0);
      float wsp2 = pow(max(dot(wn, normalize(L2 + V)), 0.0), 60.0);
      float shade = 0.55 + 0.45 * smoothstep(0.62, 0.95, c0.b);
      vec3 colW = mix(vec3(0.0, 0.015, 0.06), vec3(0.0, 0.12, 0.34), w1) * shade * (0.6 + 0.5 * max(dot(wn, L), 0.0))
                + deepLayer(mp + wn.xy * 14.0) * 0.55 * shade
                + keyCol * wsp * 1.1 + fillCol * wsp2 * 0.45;
      float shore = smoothstep(0.05, 0.45, water) * (1.0 - smoothstep(0.55, 0.95, water));
      colW += vec3(0.55, 0.75, 0.8) * shore * (0.25 + 0.25 * sin(uT * 2.0 + w1 * 12.0));

      vec3 colV = deepLayer(mp);
      vec3 col = mix(mix(mix(colS, colM, metal), colW, water), colV, pit);

      // the jet carries a warm light that rakes across the ground
      vec3 np = mix(n, wn, water);
      vec3 toP = vec3(uP.xy - mp, 26.0);
      float att = 0.7 * uP.z / (1.0 + dot(toP.xy, toP.xy) / 2200.0);
      vec3 Lp = normalize(toP);
      float difP = max(dot(np, Lp), 0.0) * att;
      float specP = pow(max(dot(np, normalize(Lp + V)), 0.0), 36.0) * att;
      col += (mix(alb, vec3(0.1, 0.3, 0.6), water) * vec3(1.0, 0.72, 0.45) * difP * 0.9 + vec3(1.0, 0.8, 0.55) * specP * 0.7) * (1.0 - pit);

      // past the edge of the map there is only the drop
      col = mix(col, deepLayer(mp0) * 0.6, clamp(outside, 0.0, 1.0));

      // distance haze, drifting smog that slides over the ground faster than it scrolls, rain
      float far = u / uView.y;
      col = mix(col, uFog, smoothstep(0.45, 1.05, far) * 0.6);
      float smog = fbm(vec2(scr.x * 0.011 + uT * 0.02, (scr.y - uBottom * 1.35) * 0.011));
      col = mix(col, uFog * 1.6 + 0.02, smoothstep(0.50, 0.85, smog) * 0.26);
      float rain = smoothstep(0.93, 1.0, noise(vec2(scr.x * 1.9 + scr.y * 0.22, scr.y * 0.035 - uT * 9.0)));
      col += keyCol * rain * 0.10 * uRain;

      vec2 vg = vUv - 0.5;
      col *= 1.0 - dot(vg, vg) * 0.55;
      col = pow(max(col, 0.0), vec3(0.88)) * 1.22;
      gl_FragColor = vec4(col, 1.0);
    }`;

  // One look per level. organic = living ground (breathes, bleeds); slime = how much ooze or standing oil;
  // onMetal = it may creep over machinery; warp = wobble in map pixels; par = parallax depth in map pixels;
  // grunge = grime and rust; rain 0..1; city = lit sprawl far below (0 = organic churn instead);
  // voidA/voidB = the two neon colours down there; fog = distance haze colour.
  const FX_STYLE = {
    1: { organic: 0, slime: 0.5, slimeCol: [0.02, 0.03, 0.04], onMetal: 1, relief: 6, spec: 1.0, specPow: 60, sat: 0.95, glow: 1.3, warp: 0, par: 18, grunge: 1, rain: 0.8, city: 1, voidA: [1.0, 0.1, 0.7], voidB: [0.0, 0.8, 1.0], fog: [0.02, 0.06, 0.12] },
    2: { organic: 0.3, slime: 0.5, slimeCol: [0.03, 0.04, 0.03], onMetal: 1, relief: 7, spec: 0.7, specPow: 40, sat: 1.0, glow: 1.3, warp: 0.2, par: 16, grunge: 1, rain: 0.6, city: 1, voidA: [1.0, 0.1, 0.7], voidB: [0.0, 0.8, 1.0], fog: [0.05, 0.07, 0.08] },
    3: { organic: 0, slime: 0.6, slimeCol: [0.05, 0.03, 0.02], onMetal: 0, relief: 9, spec: 0.55, specPow: 28, sat: 1.0, glow: 1.6, warp: 0.4, par: 20, grunge: 1, rain: 0, city: 1, voidA: [1.0, 0.35, 0.0], voidB: [1.0, 0.1, 0.5], fog: [0.14, 0.07, 0.02] },
    4: { organic: 0, slime: 0.5, slimeCol: [0.1, 1.0, 0.5], onMetal: 0, relief: 6, spec: 1.1, specPow: 80, sat: 1.15, glow: 1.8, warp: 0, par: 18, grunge: 0.8, rain: 0.5, city: 1, voidA: [1.0, 0.1, 0.8], voidB: [0.0, 0.7, 1.0], fog: [0.08, 0.0, 0.12] },
    5: { organic: 1, slime: 1.0, slimeCol: [0.42, 0.78, 0.10], onMetal: 0, relief: 9, spec: 0.85, specPow: 42, sat: 1.25, glow: 0.6, warp: 0.3, par: 20, grunge: 0.7, rain: 0, city: 0, voidA: [0.55, 0.02, 0.10], voidB: [0.25, 0.0, 0.35], fog: [0.10, 0.01, 0.02] },
    6: { organic: 1, slime: 1.0, slimeCol: [0.42, 0.78, 0.10], onMetal: 0, relief: 9, spec: 0.85, specPow: 42, sat: 1.25, glow: 0.6, warp: 0.3, par: 20, grunge: 0.7, rain: 0, city: 0, voidA: [0.55, 0.02, 0.10], voidB: [0.25, 0.0, 0.35], fog: [0.10, 0.01, 0.02] },
    // second loop: generated planet terrain (hd_sprites/build_planet.py)
    7: { organic: 0, slime: 0.25, slimeCol: [0.02, 0.03, 0.04], onMetal: 0, relief: 7, spec: 0.8, specPow: 50, sat: 1.1, glow: 1.7, warp: 0, par: 26, grunge: 0.55, rain: 0.5, city: 1, voidA: [1.0, 0.1, 0.7], voidB: [0.0, 0.8, 1.0], fog: [0.03, 0.06, 0.12] },
    8: { organic: 0, slime: 0, slimeCol: [0.02, 0.03, 0.04], onMetal: 0, relief: 7, spec: 0.9, specPow: 60, sat: 1.1, glow: 1.7, warp: 0, par: 24, grunge: 0.5, rain: 0.9, city: 1, voidA: [0.0, 0.5, 0.7], voidB: [0.0, 0.2, 0.6], fog: [0.02, 0.07, 0.14] },
    9: { organic: 0, slime: 0.4, slimeCol: [0.02, 0.03, 0.04], onMetal: 0, relief: 7, spec: 1.0, specPow: 60, sat: 1.1, glow: 2.0, warp: 0, par: 30, grunge: 0.9, rain: 0.9, city: 1, voidA: [1.0, 0.1, 0.7], voidB: [0.0, 0.8, 1.0], fog: [0.05, 0.02, 0.10] },
    10: { organic: 0, slime: 0, slimeCol: [0, 0, 0], onMetal: 0, relief: 7, spec: 1.1, specPow: 70, sat: 1.1, glow: 1.6, warp: 0, par: 22, grunge: 0.3, rain: 0, city: 0, space: 1, voidA: [0.5, 0.1, 0.7], voidB: [0.0, 0.3, 0.8], fog: [0.0, 0.0, 0.01] },
    11: { organic: 0, slime: 0, slimeCol: [0, 0, 0], onMetal: 0, relief: 10, spec: 0.35, specPow: 30, sat: 0.8, glow: 1.6, warp: 0, par: 24, grunge: 0.25, rain: 0, city: 0, space: 1, voidA: [0.2, 0.1, 0.4], voidB: [0.0, 0.2, 0.5], fog: [0.0, 0.0, 0.0] },
    12: { organic: 0, slime: 0, slimeCol: [0, 0, 0], onMetal: 0, relief: 9, spec: 0.7, specPow: 40, sat: 1.15, glow: 2.2, warp: 0, par: 26, grunge: 0.8, rain: 0, city: 0, lava: 1, voidA: [1.0, 0.3, 0.0], voidB: [0.6, 0.0, 0.0], fog: [0.16, 0.04, 0.0] },
  };

  function fxInit() {
    if (fx.gl || fx.failed) return Boolean(fx.gl);
    try {
      fx.canvas = document.createElement("canvas");
      fx.canvas.width = BASE_W * RENDER_SCALE;
      fx.canvas.height = Math.round((VIEW_H / ZOOM) * RENDER_SCALE);
      const gl = fx.canvas.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: false });
      if (!gl) throw new Error("WebGL unavailable");
      if (gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT).precision === 0) throw new Error("no highp");
      const mk = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, mk(gl.VERTEX_SHADER, FX_VERT));
      gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FX_FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      for (const name of ["uAlb", "uAux", "uMap", "uView", "uStrip", "uStripX", "uCam", "uWorld", "uAuxW", "uAuxOff", "uSpace", "uLava", "uT", "uBottom", "uPA", "uPC", "uFold", "uP", "uOrganic", "uSlime",
        "uSlimeOnMetal", "uRelief", "uSpec", "uSpecPow", "uSat", "uGlow", "uWarp", "uPar", "uGrunge", "uRain", "uCity",
        "uSlimeCol", "uVoidA", "uVoidB", "uFog"]) fx.uni[name] = gl.getUniformLocation(prog, name);
      const mkTex = (unit) => {
        const t = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      fx.texAlb = mkTex(0);
      fx.texAux = mkTex(1);
      gl.uniform1i(fx.uni.uAlb, 0);
      gl.uniform1i(fx.uni.uAux, 1);
      fx.gl = gl;
      fx.prog = prog;
    } catch (err) {
      console.warn("3D ground disabled:", err);
      fx.failed = true;
      fx.gl = null;
    }
    return Boolean(fx.gl);
  }

  // Called after the level map has been drawn into mapCanvas
  function fxBeginLevel(lvl, auxImage) {
    fx.active = false;
    const aux = auxImage || hdFxImages[lvl];
    if (!aux || !fxInit()) return;
    const gl = fx.gl;
    if (Math.max(aux.width, aux.height) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fx.texAux);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, aux);
    const st = FX_STYLE[lvl] || FX_STYLE[((lvl - 1) % 6) + 1];
    const u = fx.uni;
    gl.uniform1f(u.uOrganic, st.organic);
    gl.uniform1f(u.uSlime, st.slime);
    gl.uniform1f(u.uSlimeOnMetal, st.onMetal);
    gl.uniform1f(u.uRelief, st.relief);
    gl.uniform1f(u.uSpec, st.spec);
    gl.uniform1f(u.uSpecPow, st.specPow);
    gl.uniform1f(u.uSat, st.sat);
    gl.uniform1f(u.uGlow, st.glow);
    gl.uniform1f(u.uWarp, st.warp);
    gl.uniform3fv(u.uSlimeCol, st.slimeCol);
    gl.uniform3fv(u.uVoidA, st.voidA);
    gl.uniform3fv(u.uVoidB, st.voidB);
    gl.uniform3fv(u.uFog, st.fog);
    gl.uniform1f(u.uPar, st.par);
    gl.uniform1f(u.uGrunge, st.grunge);
    gl.uniform1f(u.uRain, st.rain);
    gl.uniform1f(u.uCity, st.city);
    gl.uniform1f(u.uSpace, st.space || 0);
    gl.uniform1f(u.uLava, st.lava || 0);
    gl.uniform1f(u.uPC, PERSP_C);
    fx.active = gl.getError() === gl.NO_ERROR;
  }

  // Flatten the world around the view into the strip canvas (lanes, then craters)
  function buildStrip() {
    const sw = stripW() * MAP_SCALE;
    const sh = (VIEW_H + FX_PAD_TOP + FX_PAD_BOTTOM) * MAP_SCALE;
    if (strip.width !== sw || strip.height !== sh) {
      strip.width = sw;
      strip.height = sh;
    }
    const x0 = Math.floor(state.scrollX + VIEW_W / 2 - stripW() / 2);
    const y0 = Math.round(state.scrollY) - VIEW_H - FX_PAD_TOP;
    stripAt.x = x0;
    stripAt.y = y0;
    stripCtx.setTransform(1, 0, 0, 1, 0, 0);
    stripCtx.fillStyle = "#000";
    stripCtx.fillRect(0, 0, sw, sh);
    const lw = MAP_W * MAP_SCALE;
    for (let lane = 0; lane < LANES; lane++) {
      const left = lane * MAP_W - WIDE_OFF - x0;
      if (left >= stripW() || left + MAP_W <= 0) continue;
      if (state.wideMaps) {
        // a wide level: each lane has its own picture and nothing is mirrored
        const img = state.wideMaps[lane];
        const sy = Math.max(0, y0 * MAP_SCALE);
        const hh = Math.min(img.height, y0 * MAP_SCALE + sh) - sy;
        stripCtx.setTransform(1, 0, 0, 1, left * MAP_SCALE, 0);
        if (hh > 0) stripCtx.drawImage(img, 0, sy, lw, hh, 0, sy - y0 * MAP_SCALE, lw, hh);
        continue;
      }
      if (laneMirrored(lane)) stripCtx.setTransform(-1, 0, 0, 1, (left + MAP_W) * MAP_SCALE, 0);
      else stripCtx.setTransform(1, 0, 0, 1, left * MAP_SCALE, 0);
      stripCtx.drawImage(mapCanvas, 0, y0 * MAP_SCALE, lw, sh, 0, 0, lw, sh);
    }
    for (const r of state.rubble) {
      if (r.x + r.w <= x0 || r.x >= x0 + stripW() || r.y + r.h <= y0 || r.y >= y0 + sh / MAP_SCALE) continue;
      const dx = (r.x - x0) * MAP_SCALE;
      const dy = (r.y - y0) * MAP_SCALE;
      const dw = r.w * MAP_SCALE;
      if (r.mir) stripCtx.setTransform(-1, 0, 0, 1, dx + dw, dy);
      else stripCtx.setTransform(1, 0, 0, 1, dx, dy);
      stripCtx.drawImage(r.img, r.sx, r.sy, r.sw, r.sh, 0, 0, dw, r.h * MAP_SCALE);
    }
    stripCtx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function fxDraw() {
    if (!fx.active) return false;
    const gl = fx.gl;
    const p = state.player;
    const fxH = Math.round((VIEW_H / ZOOM) * RENDER_SCALE);
    if (fx.canvas.height !== fxH) fx.canvas.height = fxH;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fx.texAlb);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, strip);
    gl.viewport(0, 0, fx.canvas.width, fx.canvas.height);
    gl.uniform2f(fx.uni.uMap, MAP_W, MAP_H);
    gl.uniform2f(fx.uni.uView, VIEW_W, VIEW_H);
    gl.uniform2f(fx.uni.uStrip, stripAt.y, VIEW_H + FX_PAD_TOP + FX_PAD_BOTTOM);
    gl.uniform2f(fx.uni.uStripX, stripAt.x, stripW());
    gl.uniform1f(fx.uni.uCam, state.scrollX + VIEW_W / 2);
    gl.uniform1f(fx.uni.uWorld, WORLD_W);
    gl.uniform1f(fx.uni.uAuxW, state.wideMaps ? MAP_W * 3 : MAP_W);
    gl.uniform1f(fx.uni.uAuxOff, WIDE_OFF);
    const gc = groundCam();
    gl.uniform1f(fx.uni.uPA, gc.A);
    gl.uniform1f(fx.uni.uPC, gc.C);
    if (state.wave) {
      const sh = VIEW_H + FX_PAD_TOP + FX_PAD_BOTTOM;
      gl.uniform4f(fx.uni.uFold, Math.max(0, stripAt.x) + 1, Math.min(WORLD_W, stripAt.x + stripW()) - 1, Math.max(0, stripAt.y) + 1, Math.min(MAP_H, stripAt.y + sh) - 1);
    } else gl.uniform4f(fx.uni.uFold, 0, 0, 0, 0);
    gl.uniform1f(fx.uni.uBottom, Math.round(state.scrollY));
    gl.uniform1f(fx.uni.uT, state.frameTick / 50);
    gl.uniform3f(fx.uni.uP, p.x, p.y, p.alive ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    ctx.drawImage(fx.canvas, 0, 0, VIEW_W, VIEW_H);
    return true;
  }

  // --- Helpers ---
  function bcdToInt(bcd) {
    // Convert hexadecimal-digit BCD representation (e.g. 0x0800 -> 800, 0x9000 -> 9000)
    let val = 0;
    let mul = 1;
    let v = bcd >>> 0;
    while (v > 0) {
      const d = v & 0xf;
      val += Math.min(d, 9) * mul;
      mul *= 10;
      v >>>= 4;
    }
    return val || 100;
  }

  function aniKey(name) {
    if (!name) return null;
    const low = name.toLowerCase();
    return low.endsWith(".ani") ? low.slice(0, -4) : low;
  }

  function getAnim(key) {
    return key ? A.anims[key] || null : null;
  }

  function getFrame(key, idx) {
    const anim = getAnim(key);
    if (!anim || !anim.frames || anim.frames.length === 0) return null;
    const i = ((idx % anim.frames.length) + anim.frames.length) % anim.frames.length;
    return anim.frames[i];
  }

  // World position -> screen position and size on the tilted playfield
  function project(wx, wy) {
    const w = state.scrollY - wy; // world pixels ahead of the bottom edge
    let A = PERSP_A, C = PERSP_C;
    if (GROUND_VIEW) ({ A, C } = groundCam());
    const u = w / (C + A * w);
    const s = 1 - A * u;
    return { x: VIEW_W / 2 + (wx - state.scrollX - VIEW_W / 2) * s, y: VIEW_H - u, s };
  }

  function drawSprite(targetCtx, key, frameIdx, worldX, worldY, camX, camY, flash = false, mir = false) {
    const img = images[key];
    const fr = getFrame(key, frameIdx);
    if (!img || !fr) return;
    const pr = project(worldX, worldY);
    if (pr.x + fr.width < -16 || pr.x - fr.width > VIEW_W + 16 || pr.y + fr.height < -16 || pr.y - fr.height > VIEW_H + 16) {
      return;
    }
    const hdImg = targetCtx === ctx ? hdImages[key] : null;
    const draw = () => {
      targetCtx.save();
      targetCtx.translate(pr.x, pr.y);
      targetCtx.scale(mir ? -pr.s : pr.s, pr.s);
      if (hdImg) {
        const frames = HD.sprites[key].frames;
        const h = frames[((frameIdx % frames.length) + frames.length) % frames.length];
        const k = HD.scale;
        targetCtx.imageSmoothingEnabled = true;
        targetCtx.drawImage(hdImg, h[0], h[1], h[2], h[3], -h[4] / k, -h[5] / k, h[2] / k, h[3] / k);
        targetCtx.imageSmoothingEnabled = false;
      } else {
        targetCtx.drawImage(img, fr.strip_x, fr.strip_y, fr.width, fr.height, -fr.hot_x, -fr.hot_y, fr.width, fr.height);
      }
      targetCtx.restore();
    };
    if (flash) {
      targetCtx.save();
      targetCtx.filter = "brightness(2.2) contrast(1.4)";
      draw();
      targetCtx.restore();
    } else {
      draw();
    }
  }

  // Sprites that exist only in the HD set (no Amiga original). Returns false when HD art is absent.
  function drawHdOnly(key, worldX, worldY, camX, camY, zoom = 1) {
    const img = hdImages[key];
    if (!img) return false;
    const h = HD.sprites[key].frames[0];
    const pr = project(worldX, worldY);
    const k = HD.scale / (zoom * pr.s);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, h[0], h[1], h[2], h[3], pr.x - h[4] / k, pr.y - h[5] / k, h[2] / k, h[3] / k);
    ctx.imageSmoothingEnabled = false;
    return true;
  }

  // Leave a crater where something on the ground was destroyed. Craters are kept as a list and drawn over the
  // ground each frame (the lane map itself is shared by all three lanes, so it is never painted on).
  function stampRubble(lvl, ent) {
    if (ent.rubbleFrame < 0) return;
    const key = `rubble${lvl}`;
    const img = images[key];
    const fr = getFrame(key, ent.rubbleFrame);
    if (!img || !fr) return;
    const r = { img, sx: fr.strip_x, sy: fr.strip_y, sw: fr.width, sh: fr.height, w: fr.width, h: fr.height, mir: ent.mir };
    const hdImg = hdRubbleImages[key];
    if (hdImg) {
      const frames = HDM.rubble[key].frames;
      const h = frames[((ent.rubbleFrame % frames.length) + frames.length) % frames.length];
      Object.assign(r, { img: hdImg, sx: h[0], sy: h[1], sw: h[2], sh: h[3], w: h[2] / MAP_SCALE, h: h[3] / MAP_SCALE });
    }
    r.x = ent.mir ? Math.round(ent.x - ent.rubbleDx + fr.hot_x) - r.w : Math.round(ent.x + ent.rubbleDx - fr.hot_x);
    r.y = Math.round(ent.y + ent.rubbleDy - fr.hot_y);
    state.rubble.push(r);
  }

  function renderLevelMap(lvl) {
    const tileSetNum = lvl >= 6 ? "5" : String(lvl);
    const tileImg = tileImages[tileSetNum];
    const grid = maps[String(lvl)];
    if (hdMapImages[lvl]) {
      mapCtx.drawImage(hdMapImages[lvl], 0, 0);
      return;
    }
    mapCtx.setTransform(MAP_SCALE, 0, 0, MAP_SCALE, 0, 0);
    mapCtx.fillStyle = "#000";
    mapCtx.fillRect(0, 0, MAP_W, MAP_H);
    for (let r = 0; r < MAP_ROWS; r++) {
      const rowOff = r * MAP_COLS;
      for (let c = 0; c < MAP_COLS; c++) {
        const t = grid[rowOff + c];
        const sx = (t & 15) * 16;
        const sy = (t >> 4) * 16;
        mapCtx.drawImage(tileImg, sx, sy, 16, 16, c * 16, r * 16, 16, 16);
      }
    }
    mapCtx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function aabbOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  // --- Game State ---
  const state = {
    screen: "title", // title | menu | playing | stage_clear | game_over
    paused: false,
    loaded: false,
    difficulty: 3,
    selectedLevel: 1,
    level: 1,
    loopCount: 0, // 0 = first pass, >= 1 unlocks flags_hi & 1 extra aggressors (fn_00010408)
    trainer: false,
    score: 0,
    hiScore: 15000,
    nextExtraLifeScore: 100000,
    lives: 3,
    shields: BASE_SHIELDS,
    credits: 0,
    upgrades: {},
    dealerDone: false,
    dealerSel: 0,
    dealerWait: 0,
    wideMaps: null, // the three lane pictures of a wide (second-loop) level, else null
    cave: { x: 0, y: 0, placed: false, taken: false }, // this level's bonus-round cave mouth
    bonus: null,
    dealerMsg: "",
    shieldFlash: 0,
    kills: 0,
    bombCooldown: 0,
    frameTick: 0,
    stateTimer: 0,

    scrollY: START_SCROLL_Y,
    scrollX: 0,

    player: {
      x: WORLD_W / 2,
      y: START_SCROLL_Y - 46,
      bank: 0, // -2..+2
      cooldown: 0,
      missileCooldown: 0,
      invuln: 90,
      respawnTimer: 0,
      alive: true,
    },
    powerups: {
      rapid: 0, // +0xf8 (+1000)
      freeze: 0, // +0xfa (+350)
      shield: 0, // +0xfc (+500)
      superShot: 0, // +0xfe (+500)
    },

    spawnQueue: [],
    spawnCursor: 0,
    entities: [],
    playerBullets: [],
    bombs: [],
    pickups: [],
    rubble: [],
    enemyBullets: [],
    explosions: [],
    popups: [],
    sparks: [],
    side: null, // the side-scrolling level in progress (even levels), else null
    boss: null,
    novaFlash: 0,
    wave: null, // the formation stage, while it is on
    waveDone: false,
    dropFill: { nova: 0, shield: 0, rapid: 0 },
    swap: null, // the camera swinging between a top-down level and a side-on one
    seaMask: null, // where the water is, on the Deep Water map (else null)
    seaT: 0,
    dive: null, // the drop into the bonus cave, while it plays
    flyerPool: [],
    reinfT: 0,
    destroyedPairIds: new Set(),
  };

  // --- Input Handling (Keyboard + Pointer + HTML5 Joystick/Gamepad) ---
  const keys = new Set();
  const justPressed = new Set();

  const gpState = {
    connected: false,
    name: "",
    activeIndex: -1,
    mx: 0,
    my: 0,
    aimX: 0, // right stick, unit vector (0,0 when centred)
    aimY: 0,
    bombHeld: false,
    fireHeld: false,
    prev: {
      up: false,
      down: false,
      left: false,
      right: false,
      fire: false,
      start: false,
      pause: false,
      trainer: false,
    },
    edge: {
      up: false,
      down: false,
      left: false,
      right: false,
      start: false,
      pause: false,
      trainer: false,
    },
  };

  function updateJoyBadge() {
    if (!ui.joyBadge) return;
    if (gpState.connected) {
      const shortName = gpState.name ? gpState.name.slice(0, 22) : "Connected";
      ui.joyBadge.textContent = `Joystick: ${shortName}`;
      ui.joyBadge.classList.add("active");
    } else {
      ui.joyBadge.textContent = "Joystick: Press button";
      ui.joyBadge.classList.remove("active");
    }
  }

  function pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let chosen = null;
    if (gpState.activeIndex >= 0 && pads[gpState.activeIndex] && pads[gpState.activeIndex].connected) {
      chosen = pads[gpState.activeIndex];
    } else {
      for (let i = 0; i < pads.length; i++) {
        if (pads[i] && pads[i].connected) {
          chosen = pads[i];
          gpState.activeIndex = i;
          break;
        }
      }
    }

    if (!chosen) {
      if (gpState.connected) {
        gpState.connected = false;
        gpState.name = "";
        gpState.activeIndex = -1;
        updateJoyBadge();
      }
      gpState.mx = 0;
      gpState.my = 0;
      gpState.aimX = 0;
      gpState.aimY = 0;
      gpState.bombHeld = false;
      gpState.fireHeld = false;
      for (const k of Object.keys(gpState.edge)) gpState.edge[k] = false;
      for (const k of Object.keys(gpState.prev)) gpState.prev[k] = false;
      return;
    }

    if (!gpState.connected || gpState.name !== chosen.id) {
      gpState.connected = true;
      gpState.name = chosen.id || "Connected";
      updateJoyBadge();
    }

    const dead = 0.18;
    const ax0 = chosen.axes && chosen.axes.length > 0 ? chosen.axes[0] : 0;
    const ax1 = chosen.axes && chosen.axes.length > 1 ? chosen.axes[1] : 0;
    const btns = chosen.buttons || [];
    const btnDown = (idx) => Boolean(btns[idx] && (btns[idx].pressed || btns[idx].value > 0.5));

    const dUp = btnDown(12) || ax1 < -dead;
    const dDown = btnDown(13) || ax1 > dead;
    const dLeft = btnDown(14) || ax0 < -dead;
    const dRight = btnDown(15) || ax0 > dead;

    let mx = Math.abs(ax0) > dead ? ax0 : 0;
    let my = Math.abs(ax1) > dead ? ax1 : 0;
    if (btnDown(14)) mx = -1;
    else if (btnDown(15)) mx = 1;
    if (btnDown(12)) my = -1;
    else if (btnDown(13)) my = 1;
    gpState.mx = Math.max(-1, Math.min(1, mx));
    gpState.my = Math.max(-1, Math.min(1, my));

    // Right stick aims the cannons (twin-stick); both triggers drop bombs.
    const ax2 = chosen.axes && chosen.axes.length > 2 ? chosen.axes[2] : 0;
    const ax3 = chosen.axes && chosen.axes.length > 3 ? chosen.axes[3] : 0;
    const aimMag = Math.hypot(ax2, ax3);
    if (aimMag > 0.35) {
      gpState.aimX = ax2 / aimMag;
      gpState.aimY = ax3 / aimMag;
    } else {
      gpState.aimX = 0;
      gpState.aimY = 0;
    }

    const fireNow = btnDown(0) || btnDown(1) || btnDown(2) || btnDown(5);
    const bombNow = btnDown(6) || btnDown(7);
    const pauseNow = btnDown(9);
    const trainerNow = btnDown(3) || btnDown(8);
    const startNow = fireNow || bombNow || pauseNow;

    gpState.fireHeld = fireNow;
    gpState.bombHeld = bombNow;
    if (startNow) sound.ensureContext();

    gpState.edge.up = dUp && !gpState.prev.up;
    gpState.edge.down = dDown && !gpState.prev.down;
    gpState.edge.left = dLeft && !gpState.prev.left;
    gpState.edge.right = dRight && !gpState.prev.right;
    gpState.edge.start = startNow && !gpState.prev.start;
    gpState.edge.pause = pauseNow && !gpState.prev.pause;
    gpState.edge.trainer = trainerNow && !gpState.prev.trainer;

    gpState.prev.up = dUp;
    gpState.prev.down = dDown;
    gpState.prev.left = dLeft;
    gpState.prev.right = dRight;
    gpState.prev.fire = fireNow;
    gpState.prev.start = startNow;
    gpState.prev.pause = pauseNow;
    gpState.prev.trainer = trainerNow;
  }

  window.addEventListener("gamepadconnected", (e) => {
    gpState.activeIndex = e.gamepad.index;
    gpState.connected = true;
    gpState.name = e.gamepad.id || "Connected";
    updateJoyBadge();
  });

  window.addEventListener("gamepaddisconnected", (e) => {
    if (e.gamepad.index === gpState.activeIndex) {
      gpState.activeIndex = -1;
      gpState.connected = false;
      gpState.name = "";
      updateJoyBadge();
    }
  });

  window.addEventListener("keydown", (e) => {
    const code = e.code;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(code)) {
      e.preventDefault();
    }
    if (code === "KeyF" && !e.repeat && !e.metaKey && !e.ctrlKey) {
      sound.ui("toggle");
      toggleFullscreen();
    }
    if (!keys.has(code)) justPressed.add(code);
    keys.add(code);
    sound.ensureContext();
  });

  window.addEventListener("keyup", (e) => {
    keys.delete(e.code);
  });

  canvas.addEventListener("pointerdown", () => {
    canvas.focus();
    sound.ensureContext();
    justPressed.add("Space");
  });

  function consumeAction(code) {
    if (justPressed.has(code)) {
      justPressed.delete(code);
      return true;
    }
    return false;
  }

  function anyStartPressed() {
    if (gpState.edge.start) {
      gpState.edge.start = false;
      return true;
    }
    for (const k of ["Space", "Enter", "KeyZ", "NumpadEnter"]) {
      if (justPressed.has(k)) {
        justPressed.delete(k);
        return true;
      }
    }
    return false;
  }

  // --- UI Buttons ---
  ["7 - Landfall", "8 - Skyline Run", "9 - Deep Water", "10 - Open Sea", "11 - Neon Sprawl", "12 - Foundry Run", "13 - Ascent", "14 - Orbit Run", "15 - The Moon", "16 - Hive Run", "17 - Cinder Throne", "18 - Lava Run"].forEach((name) => {
    const opt = document.createElement("option");
    opt.value = String(parseInt(name, 10));
    opt.textContent = name;
    ui.levelSelect.appendChild(opt);
  });
  ui.levelSelect.addEventListener("change", () => {
    sound.ui("toggle");
    state.selectedLevel = parseInt(ui.levelSelect.value, 10);
  });
  ui.diffSelect.addEventListener("change", () => {
    sound.ui("toggle");
    state.difficulty = parseInt(ui.diffSelect.value, 10);
  });
  ui.trainerBtn.addEventListener("click", () => {
    sound.ui("toggle");
    state.trainer = !state.trainer;
    ui.trainerBtn.textContent = `Trainer: ${state.trainer ? "ON" : "OFF"}`;
    ui.trainerBtn.classList.toggle("active", state.trainer);
  });
  ui.sfxBtn.addEventListener("click", () => {
    sound.sfxEnabled = !sound.sfxEnabled;
    ui.sfxBtn.textContent = `SFX: ${sound.sfxEnabled ? "ON" : "OFF"}`;
    ui.sfxBtn.classList.toggle("active", sound.sfxEnabled);
    sound.ui("toggle"); // heard when switching sound on
  });
  ui.bgmBtn.addEventListener("click", () => {
    sound.ui("toggle");
    sound.ensureContext();
    sound.bgmEnabled = !sound.bgmEnabled;
    ui.bgmBtn.textContent = `Synth BGM: ${sound.bgmEnabled ? "ON" : "OFF"}`;
    ui.bgmBtn.classList.toggle("active", sound.bgmEnabled);
  });
  ui.pauseBtn.addEventListener("click", () => {
    sound.ui("toggle");
    if (state.screen === "playing" || state.screen === "side") {
      state.paused = !state.paused;
      ui.pauseBtn.textContent = state.paused ? "Resume" : "Pause";
    }
  });
  if (ui.fullBtn) {
    ui.fullBtn.addEventListener("click", () => {
      sound.ui("toggle");
      toggleFullscreen();
      ui.fullBtn.blur();
    });
  }
  ui.restartBtn.addEventListener("click", () => {
    sound.ui("back");
    state.screen = "title";
    state.paused = false;
    ui.pauseBtn.textContent = "Pause";
  });

  // --- Ship upgrades, bought from the black-market arms dealer half way through each level ---
  // from = first level the dealer stocks it; prices = cost of each successive grade
  const UPGRADES = [
    { id: "engine", name: "AFTERBURNERS", from: 1, prices: [400, 800, 1400, 2400, 3800], desc: "Fly 12% faster per grade" },
    { id: "cannon", name: "CANNONS", from: 1, prices: [500, 1000, 1800, 3000, 4600], desc: "Faster fire and harder-hitting rounds, turn about" },
    { id: "tail", name: "TAIL GUN", from: 1, prices: [700, 1900], desc: "Fires behind you; second grade fires a pair" },
    { id: "bomb", name: "BOMB RACK", from: 1, prices: [600, 1200, 2200, 3600], desc: "Bombs re-arm sooner and blast wider" },
    { id: "spread", name: "SPREAD SHOT", from: 2, prices: [900, 1600, 2800], desc: "Two more angled shots per grade" },
    { id: "salvage", name: "SALVAGE RIG", from: 2, prices: [800, 1600, 2800], desc: "25% more credits from every kill, per grade" },
    { id: "shield", name: "SHIELD CELL", from: 3, prices: [1000, 1800, 3000, 4500], desc: "One more shield per grade" },
    { id: "drone", name: "WINGMAN DRONES", from: 3, prices: [1500, 2600, 4000], desc: "A drone flies alongside and fires with you, per grade" },
    { id: "missile", name: "SEEKER MISSILES", from: 4, prices: [1200, 2000, 3400], desc: "Homing missiles; more, then faster" },
    { id: "laser", name: "LANCE ROUNDS", from: 5, prices: [1800, 3600], desc: "Shots punch through; second grade hits harder" },
    { id: "nova", name: "NOVA BOMB", from: 1, prices: [900, 900, 900], desc: "Clears the whole screen. Carry three (N / L1 / Y)" },
    { id: "life", name: "SPARE SHIP", from: 1, prices: [2000, 3500, 5500, 8000], desc: "One more ship in reserve. Dearer each time" },
  ];
  const CANNON_RATE = [1, 1.25, 1.25, 1.5, 1.5, 1.8];
  const CANNON_DMG = [1, 1, 2, 2, 3, 3];
  const DRONE_AT = [[-22, 8], [22, 8], [0, 21]]; // where each wingman sits, relative to the jet (nose up)
  const up = (id) => state.upgrades[id] || 0;
  const maxShields = () => BASE_SHIELDS + up("shield");
  const bombCooldown = () => [BOMB_COOLDOWN, 55, 40, 32, 26][up("bomb")];
  // First time round there are the six original levels (1 to 6). After that each loop is twelve levels (7 to 18,
  // 19 to 30, ...): the six generated worlds flown top-down on the odd ones, a side-scroller after each on the even ones.
  const shownLevel = () => (state.loopCount === 0 ? state.level : 6 + (state.loopCount - 1) * 12 + state.level);
  // The camera pulls back a little every level, so later levels show more of the board (title and menu stay close)
  function applyZoom(inLevel = state.screen !== "title" && state.screen !== "menu" && state.screen !== "loading") {
    const side = shownLevel() % 2 === 0; // the side-on levels are pulled back a quarter further still, for more sky to work in
    const TITLE_ZOOM = 2; // the title and briefing show their scene at the size the side-on levels are played at
    const want = !inLevel ? TITLE_ZOOM : Math.min(side ? 2.4 : 1.9, 1.55 * (1 + 0.02 * (shownLevel() - 1)) * (side ? 1.25 : 1)) ; // level 1 already shows half as much again as the original view
    if (want !== ZOOM) {
      ZOOM = want;
      layout();
    }
  }
  // the cannon's colour steps round the wheel each level: yellow on level 1, then green, cyan, blue, violet, red...
  const laserColor = () => `hsl(${(52 + (shownLevel() - 1) * 47) % 360},100%,62%)`;
  // Enemies toughen as the levels go by. On level 1 everything is as it was; by level 6 most things take one more
  // hit, by level 12 two more, by level 17 nearly three. The fraction is settled per enemy, so it creeps in.
  const toughness = (seed) => {
    const r = Math.sin(seed * 12.9898) * 43758.5453;
    return Math.floor((shownLevel() - 1) * 0.18 + (r - Math.floor(r)));
  };
  // Levels 1 to 4 pay out as they always have. From level 5 on everything that is given away is a quarter
  // leaner: pick-ups dropped by enemies, pick-ups placed in the levels, and credits.
  const lean = () => (shownLevel() >= 5 ? 0.75 : 1);
  // Power-ups are a further quarter scarcer on every level after the first: 0.75 on levels 2 to 4, and
  // 0.75 of the already lean rate from level 5 on. Credits are not touched by this.
  const scarce = () => lean() * (shownLevel() >= 2 ? 0.75 : 1);
  // Which pick-up (if any) this enemy kill leaves. Each kind fills up by 1/N per kill (less after level one).
  function nextDrop() {
    const d = state.dropFill;
    d.nova += scarce() / NOVA_DROP_EVERY;
    d.shield += scarce() / SHIELD_DROP_EVERY;
    d.rapid += scarce() / RAPID_DROP_EVERY;
    for (const kind of ["nova", "shield", "rapid"]) {
      if (d[kind] >= 1) {
        d[kind] -= 1;
        return kind;
      }
    }
    return null;
  }
  const levelsInLoop = (loop) => (loop === 0 ? 6 : 12);
  const baseLevel = (lvl = state.level, loop = state.loopCount) => (loop === 0 ? lvl : ((Math.ceil(lvl / 2) - 1) % 6) + 1); // which original level's enemies and art to fall back on
  const worldFor = (lvl, loop) => (loop > 0 && lvl % 2 === 1 ? 7 + (lvl - 1) / 2 : 0); // generated world 7..12, or 0
  const sideTheme = () => (state.loopCount === 0 ? state.level : [2, 8, 4, 10, 6, 12][(state.level / 2 - 1) % 6]);

  function openDealer() {
    state.screen = "dealer";
    state.dealerDone = true;
    state.dealerSel = 0;
    state.dealerMsg = "WHAT'LL IT BE, PILOT?";
    state.dealerWait = 35; // a beat before it takes input, so a held fire button does not buy something
    state.enemyBullets = [];
    sound.play("icon", 0.8, 0, 0.6);
  }

  function stepDealer() {
    if (state.dealerWait > 0) {
      state.dealerWait--;
      justPressed.clear();
      gpState.edge.start = false;
      return;
    }
    const rows = UPGRADES.length + 1; // last row leaves
    if (consumeAction("ArrowUp") || consumeAction("KeyW") || gpState.edge.up) {
      state.dealerSel = (state.dealerSel + rows - 1) % rows;
      sound.play("bump", 0.5, 0, 1.4);
    }
    if (consumeAction("ArrowDown") || consumeAction("KeyS") || gpState.edge.down) {
      state.dealerSel = (state.dealerSel + 1) % rows;
      sound.play("bump", 0.5, 0, 1.4);
    }
    const leave = consumeAction("Escape") || gpState.edge.pause;
    const pick = !leave && anyStartPressed();
    if (leave || (pick && state.dealerSel === UPGRADES.length)) {
      state.screen = state.side ? "side" : "playing";
      state.player.invuln = Math.max(state.player.invuln, 90);
      justPressed.clear();
      sound.play("fighter", 0.7);
      return;
    }
    if (!pick) return;
    const item = UPGRADES[state.dealerSel];
    const grade = up(item.id);
    if (shownLevel() < item.from) {
      state.dealerMsg = `NOT IN YET. TRY ME ON LEVEL ${item.from}.`;
      sound.play("bump", 0.8, 0, 0.5);
    } else if (grade >= item.prices.length) {
      state.dealerMsg = "THAT'S AS GOOD AS IT GETS.";
      sound.play("bump", 0.8, 0, 0.5);
    } else if (state.credits < item.prices[grade]) {
      state.dealerMsg = "COME BACK WITH MORE CREDITS.";
      sound.play("bump", 0.8, 0, 0.5);
    } else {
      state.credits -= item.prices[grade];
      state.upgrades[item.id] = grade + 1;
      if (item.id === "life") state.lives = Math.min(9, state.lives + 1);
      if (item.id === "shield") state.shields = maxShields();
      state.dealerMsg = "PLEASURE DOING BUSINESS.";
      track("upgrade_bought", { item: item.id, grade: grade + 1, level: shownLevel() });
      sound.play(sound.pick("bonus_b", "icon"), 1.2, 0.8, 1.25);
    }
  }

  // --- Bonus round: a cave mouth opens in the ground once a level; fly into it and the game turns side-on ---
  const DIVE_LEN = 64; // ticks of the drop into the cave mouth
  const BONUS_AT = 0.72; // how far up the level the cave mouth sits
  const BONUS_LEN = 1300; // ticks (26 s)
  const BONUS_SPEED = 2.2; // cave pixels scrolled per tick
  const caveNoise = (x) => Math.sin(x * 0.011) * 0.5 + Math.sin(x * 0.027 + 1.7) * 0.3 + Math.sin(x * 0.061 + 4.1) * 0.2;
  // Nearly flat floor and roof with the odd low swell: down here it is your height that counts, not dodging rock
  function caveBump(x, phase) {
    const period = 300;
    const k = Math.floor((x + phase) / period);
    const cx = k * period + period / 2 - phase;
    const on = Math.sin(k * 12.9898 + phase) * 43758.5453;
    if (on - Math.floor(on) < 0.35) return 0;
    const d = (x - cx) / 46;
    return Math.exp(-d * d) * VIEW_H * 0.08;
  }
  const caveRoof = (x) => 16 + 3 * caveNoise(x + 900) + caveBump(x, 0);
  const caveFloor = (x) => VIEW_H - 18 + 3 * caveNoise(x) - caveBump(x, 150);

  function enterBonus() {
    const b = { t: 0, px: 60, py: VIEW_H / 2, gems: [], pods: [], shots: [], got: 0, cooldown: 0, chain: 0, done: 0 };
    const end = BONUS_LEN * BONUS_SPEED;
    // Gems come in level runs at five heights. Every stretch offers two runs at once, one easy and near the
    // middle and one rich and tight against the roof or floor, and the next stretch moves them, so you are
    // always choosing a height and climbing or diving to reach it. Runs get shorter and richer further in.
    const band = (x, i) => {
      const lo = caveRoof(x) + 13;
      const hi = caveFloor(x) - 13;
      return lo + ((hi - lo) * i) / 4;
    };
    let n = 0;
    for (let gx = 380; gx < end - 90; gx += 170, n++) {
      const depth = gx / end; // 0 at the mouth, 1 at the far end
      const rich = n % 2 ? 0 : 4; // roof, then floor, alternately
      const easy = 1 + ((n * 2) % 3); // one of the three middle heights
      const len = Math.round(8 - 3 * depth);
      for (let i = 0; i < len; i++) {
        const x = gx + i * 15;
        b.gems.push({ x, y: band(x, easy), val: 10 });
        b.gems.push({ x, y: band(x, rich), val: Math.round(25 + 25 * depth), rich: true });
      }
      // a glow pod drifts at a third height between runs: line up with it and shoot
      const px = gx + 135;
      b.pods.push({ x: px, y: band(px, (easy + 2) % 5) });
    }
    // Three power-ups exist only down here: a magnet that draws gems in, a doubler for everything collected after
    // it, and an overdrive you carry back up (super shots and rapid fire when you surface).
    b.ups = [["magnet", 0.16, 2], ["double", 0.42, 1], ["over", 0.7, 3]].map(([kind, at, i]) => ({ kind, x: end * at, y: band(end * at, i) }));
    b.mult = 1;
    b.magnet = false;
    b.over = false;
    b.msg = "";
    b.msgT = 0;
    state.bonus = b;
    state.cave.taken = true;
    state.screen = "bonus";
    state.enemyBullets = [];
    sound.play(sound.pick("bonus_a", "hum2"), 0.7);
  }

  function stepBonus() {
    const b = state.bonus;
    if (b.done > 0) {
      // tally, then back up to the surface
      if (--b.done === 0) {
        if (b.over) {
          state.powerups.superShot += 1000;
          state.powerups.rapid += 1000;
        }
        b.got = Math.round(b.got * lean());
        state.credits += b.got;
        track("bonus_round", { level: shownLevel(), credits: b.got });
        state.screen = "playing";
        state.player.invuln = Math.max(state.player.invuln, 100);
        state.popups.push({ x: state.player.x, y: state.player.y - 18, text: `BONUS +${b.got} CR`, ttl: 70 });
        justPressed.clear();
        sound.play("fighter", 0.7);
      }
      return;
    }
    b.t++;
    if (b.t >= BONUS_LEN) {
      b.done = 55; // a short tally, then straight back up
      sound.play(sound.pick("bonus_b", "icon"), 1.3);
      return;
    }
    const scroll = b.t * BONUS_SPEED;
    const engine = 1 + 0.12 * up("engine");
    let mx = gpState.mx;
    let my = gpState.my;
    if (keys.has("ArrowLeft") || keys.has("KeyA")) mx -= 1;
    if (keys.has("ArrowRight") || keys.has("KeyD")) mx += 1;
    if (keys.has("ArrowUp") || keys.has("KeyW")) my -= 1;
    if (keys.has("ArrowDown") || keys.has("KeyS")) my += 1;
    b.px = Math.max(16, Math.min(VIEW_W - 60, b.px + Math.max(-1, Math.min(1, mx)) * 2.6 * engine));
    b.py += Math.max(-1, Math.min(1, my)) * 2.4 * engine;
    // rock just nudges you off it: no damage down here
    const wx = scroll + b.px;
    const top = caveRoof(wx) + 9;
    const bot = caveFloor(wx) - 9;
    if (b.py < top || b.py > bot) sound.play("bump", 0.4, 0, 0.6, "rock", 200);
    b.py = Math.max(top, Math.min(bot, b.py));

    if (b.cooldown > 0) b.cooldown--;
    const firing = keys.has("Space") || keys.has("KeyZ") || keys.has("Enter") || gpState.fireHeld || gpState.aimX !== 0 || gpState.aimY !== 0;
    if (firing && b.cooldown <= 0) {
      b.cooldown += 16 / 3;
      b.shots.push({ x: wx + 14, y: b.py });
      sound.shot(false, false);
    }
    for (const sh of b.shots) {
      sh.x += SHOT_SPEED + BONUS_SPEED;
      if (sh.x > scroll + VIEW_W + 10 || sh.y < caveRoof(sh.x) || sh.y > caveFloor(sh.x)) sh.dead = true;
      for (const pod of b.pods) {
        if (pod.dead || Math.abs(pod.x - sh.x) > 10 || Math.abs(pod.y - sh.y) > 10) continue;
        pod.dead = true;
        sh.dead = true;
        b.got += 60;
        sound.play(sound.pick("spin_b", "expl2"), 0.6, 0.35, 1.4);
      }
    }
    b.shots = b.shots.filter((sh) => !sh.dead);
    b.pods = b.pods.filter((pod) => !pod.dead && pod.x > scroll - 20);
    if (b.chain > 0) b.chain -= 0.02;
    if (b.msgT > 0) b.msgT--;
    for (const u of b.ups) {
      if (u.dead || Math.abs(u.x - wx) > 20 || Math.abs(u.y - b.py) > 18) continue;
      u.dead = true;
      if (u.kind === "magnet") b.magnet = true;
      else if (u.kind === "double") b.mult = 2;
      else b.over = true;
      b.msg = u.kind === "magnet" ? "GEM MAGNET" : u.kind === "double" ? "DOUBLE CREDITS" : "OVERDRIVE: YOURS WHEN YOU SURFACE";
      b.msgT = 110;
      sound.play(sound.pick("bonus_a", "icon"), 1.0, 0, 1.2);
    }
    for (const gem of b.gems) {
      // gems close to the jet are always drawn to it; the magnet pick-up makes that reach much further
      const reach = b.magnet ? 150 : 46;
      const gd = Math.hypot(gem.x - wx, gem.y - b.py);
      if (!gem.dead && gd < reach) {
        const pull = b.magnet ? 0.14 : 0.22 * (1 - gd / reach) + 0.04;
        gem.x += (wx - gem.x) * pull;
        gem.y += (b.py - gem.y) * pull;
      }
      if (gem.x < scroll - 10) gem.dead = true;
      else if (Math.abs(gem.x - wx) < 15 && Math.abs(gem.y - b.py) < 13) {
        gem.dead = true;
        b.got += gem.val * b.mult;
        b.chain = Math.min(12, b.chain + 1);
        sound.play("icon", 0.5, 0.12, 1 + b.chain * 0.08, "gem", 30); // pitch climbs while you keep the string going
      }
    }
    b.gems = b.gems.filter((gem) => !gem.dead);
  }

  // The jet, drawn at the origin with its nose toward the top. Every upgrade bolts something visible onto it and
  // the whole airframe grows a little with each one, so a fully kitted ship is a fifth bigger and bristling. Its hit box grows with it.
  const shipScale = () => Math.min(1.2, 1 + 0.012 * power());
  function drawShip(pose) {
    const T = state.frameTick;
    const metal = "#475569";
    const edge = "#94a3b8";
    const tri = (pts, fill, stroke) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
    };
    ctx.save();
    const sk = shipScale() * (state.dive ? Math.max(0.05, 1 - state.dive.t / (DIVE_LEN * 0.6)) : 1); // it shrinks away down the hole
    ctx.scale(sk, sk);
    // afterburners: longer flames, then more of them
    const eng = up("engine");
    for (const x of eng >= 3 ? [-5, 0, 5] : eng === 2 ? [-3.5, 3.5] : eng === 1 ? [0] : []) {
      const len = 6 + 3.5 * eng + 2.5 * Math.sin(T * 0.9 + x);
      tri([[x - 2.2, 12], [x + 2.2, 12], [x, 12 + len]], "rgba(251,146,60,0.85)");
      tri([[x - 1.1, 12], [x + 1.1, 12], [x, 12 + len * 0.6]], eng >= 3 ? "#bae6fd" : "#fef08a");
    }
    // spread shot: extra swept wing panels
    for (let g = 1; g <= up("spread"); g++) {
      const w = 13 + g * 5;
      for (const sd of [-1, 1]) tri([[sd * 7, -1], [sd * w, 8], [sd * w, 11], [sd * 7, 7]], metal, "#22d3ee");
    }
    // bomb rack: pods under the belly
    for (let g = 1; g <= up("bomb"); g++) {
      for (const sd of [-1, 1]) {
        ctx.fillStyle = "#1e293b";
        ctx.beginPath();
        ctx.ellipse(sd * (3.5 + g * 2.5), 5, 2, 4.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#f87171";
        ctx.fillRect(sd * (3.5 + g * 2.5) - 1, 1, 2, 1.2);
      }
    }
    // seeker missiles on wing rails
    for (let g = 1; g <= up("missile"); g++) {
      for (const sd of [-1, 1]) {
        const x = sd * (5 + g * 5);
        ctx.fillStyle = "#e2e8f0";
        ctx.fillRect(x - 1, -3, 2, 9);
        ctx.fillStyle = "#ef4444";
        ctx.fillRect(x - 1, -5, 2, 2);
      }
    }
    // tail gun
    for (let i = 0; i < up("drone"); i++) {
      const [ox, oy] = DRONE_AT[i];
      ctx.fillStyle = metal;
      ctx.beginPath();
      ctx.arc(ox, oy, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#22d3ee";
      ctx.fillRect(ox - 0.6, oy - 6, 1.2, 4);
      ctx.fillStyle = `rgba(251,146,60,${0.6 + 0.4 * Math.sin(T * 0.7 + i)})`;
      ctx.fillRect(ox - 0.8, oy + 3, 1.6, 3);
    }
    if (up("tail")) {
      ctx.fillStyle = edge;
      if (up("tail") >= 2) {
        ctx.fillRect(-2.6, 9, 1.6, 8);
        ctx.fillRect(1, 9, 1.6, 8);
      } else ctx.fillRect(-1, 9, 2, 8);
      ctx.fillStyle = metal;
      ctx.beginPath();
      ctx.arc(0, 10, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    drawFlat("player", pose, 0, 0);
    // cannons: gun pods on the wings, then longer barrels, then twin barrels
    const can = up("cannon");
    if (can) {
      for (const sd of [-1, 1]) {
        ctx.fillStyle = metal;
        ctx.fillRect(sd * 9 - 2, -4, 4, 10);
        ctx.fillStyle = edge;
        for (const bx of can >= 3 ? [-1.6, 0.6] : [-0.5]) ctx.fillRect(sd * 9 + bx, -5 - 3 * can, 1, 3 * can + 2);
        ctx.fillStyle = "#fbbf24";
        ctx.fillRect(sd * 9 - 2, 3, 4, 1);
      }
    }
    // shield cells: armour chevrons over the hull, lit
    for (let g = 1; g <= up("shield"); g++) {
      ctx.strokeStyle = `rgba(34,211,238,${0.6 + 0.3 * Math.sin(T * 0.15 + g)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-5 - g, -1 + g * 4);
      ctx.lineTo(0, -6 + g * 4);
      ctx.lineTo(5 + g, -1 + g * 4);
      ctx.stroke();
    }
    // lance rounds: a long emitter on the nose
    if (up("laser")) {
      ctx.fillStyle = "#67e8f9";
      ctx.fillRect(-0.7, -24, 1.4, 11);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(-0.3, -24, 0.6, 11);
    }
    ctx.restore();
  }

  // The jet seen from the side (side-scroller, cave, title): nose to the right. Every upgrade shows here too.
  function drawJetSideways(x, y, dir = 1, pitch = 0) {
    const T = state.frameTick;
    const sk = shipScale() * (state.dive ? Math.max(0.05, 1 - state.dive.t / (DIVE_LEN * 0.6)) : 1);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir * sk * 0.85, sk * 0.85);
    ctx.rotate(pitch);
    ctx.lineJoin = "round";
    const shape = (pts, fill, stroke = "#f1f5f9") => {
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 0.45;
        ctx.stroke();
      }
    };
    // afterburners
    const eng = up("engine");
    const flames = eng >= 4 ? [-2.2, 0.4, 3] : eng >= 2 ? [-1.4, 1.8] : [0.3];
    for (const fy of flames) {
      const len = 5 + 3.2 * eng + 2.5 * Math.sin(T * 0.9 + fy * 3);
      shape([[-16, fy - 1.3], [-16, fy + 1.3], [-16 - len, fy]], "rgba(251,146,60,0.85)", null);
      shape([[-16, fy - 0.7], [-16, fy + 0.7], [-16 - len * 0.55, fy]], eng >= 3 ? "#bae6fd" : "#fef08a", null);
    }
    // wingman drones, holding station
    for (let i = 0; i < up("drone"); i++) {
      const [ox, oy] = [[-6, -15], [-6, 15], [-26, 0]][i];
      ctx.fillStyle = "#475569";
      ctx.beginPath();
      ctx.ellipse(ox, oy, 4.5, 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#22d3ee";
      ctx.fillRect(ox + 3, oy - 0.5, 3.5, 1);
      ctx.fillStyle = `rgba(251,146,60,${0.6 + 0.4 * Math.sin(T * 0.7 + i)})`;
      ctx.fillRect(ox - 7.5, oy - 0.6, 3, 1.2);
    }
    // tail gun
    if (up("tail")) {
      ctx.fillStyle = "#94a3b8";
      ctx.fillRect(-23, -3.6, 8, 1.1);
      if (up("tail") >= 2) ctx.fillRect(-23, -1.6, 8, 1.1);
    }
    // tail fin, fuselage, wing, canopy
    shape([[-15, -3], [-12, -11.5], [-7.5, -11.5], [-4, -3.6]], "#64748b");
    const hull = ctx.createLinearGradient(0, -5, 0, 5);
    hull.addColorStop(0, "#cbd5e1");
    hull.addColorStop(0.5, "#8494a8");
    hull.addColorStop(1, "#334155");
    shape([[19, 1.2], [9, -3.2], [-9, -4.2], [-16, -2.6], [-16, 3.2], [7, 4.2]], hull);
    shape([[-9, 0.6], [8, 1.6], [-3, 4.4], [-12, 3.4]], "#475569", "#94a3b8");
    shape([[10, -2.6], [4, -5.6], [-1, -5.2], [-2, -3.6]], "#0e7490", "#67e8f9");
    for (let g = 1; g <= up("spread"); g++) shape([[2 - g * 4, -4], [5 - g * 4, -4], [3 - g * 4, -8 - g]], "#475569", "#22d3ee"); // extra fins
    // cannons under the nose
    const can = up("cannon");
    if (can) {
      ctx.fillStyle = "#475569";
      ctx.fillRect(3, 3.6, 8, 2.4);
      ctx.fillStyle = "#e2e8f0";
      ctx.fillRect(10, 4, 4 + 2.2 * can, 0.9);
      if (can >= 3) ctx.fillRect(10, 5.3, 4 + 2.2 * can, 0.9);
    }
    // missiles, then rocket pods, slung under the wing
    for (let g = 1; g <= up("missile"); g++) {
      ctx.fillStyle = "#e2e8f0";
      ctx.fillRect(-11 + g * 4.5, 5 + (g % 2), 7, 1.4);
      ctx.fillStyle = "#ef4444";
      ctx.fillRect(-4.5 + g * 4.5, 5 + (g % 2), 1.6, 1.4);
    }
    for (let g = 1; g <= up("bomb"); g++) {
      ctx.fillStyle = "#1e293b";
      ctx.beginPath();
      ctx.ellipse(-12 + g * 3.2, 7.2, 3.4, 1.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f87171";
      ctx.fillRect(-9.6 + g * 3.2, 6.7, 1.2, 1);
    }
    // shield cells glow along the spine; the lance emitter runs out ahead of the nose
    for (let g = 1; g <= up("shield"); g++) {
      ctx.strokeStyle = `rgba(34,211,238,${0.6 + 0.3 * Math.sin(T * 0.15 + g)})`;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(8 - g * 5, -4.6);
      ctx.lineTo(5 - g * 5, -6.4);
      ctx.lineTo(2 - g * 5, -4.8);
      ctx.stroke();
    }
    if (up("laser")) {
      ctx.fillStyle = "#67e8f9";
      ctx.fillRect(18, 0.6, 10, 1.2);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(18, 1, 10, 0.4);
    }
    ctx.restore();
  }

  function renderBonus() {
    const b = state.bonus;
    const scroll = b.t * BONUS_SPEED;
    const T = state.frameTick;
    const sky = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    sky.addColorStop(0, "#05030d");
    sky.addColorStop(0.5, "#140a26");
    sky.addColorStop(1, "#04060f");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // far wall: slow-moving rock teeth and a scatter of dim lights
    for (const [par, col, amp] of [[0.25, "#1b1033", 26], [0.5, "#24123f", 16]]) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      for (let x = 0; x <= VIEW_W; x += 4) ctx.lineTo(x, 34 + amp * (1 + caveNoise((x + scroll * par) * 2.3 + par * 500)));
      ctx.lineTo(VIEW_W, 0);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, VIEW_H);
      for (let x = 0; x <= VIEW_W; x += 4) ctx.lineTo(x, VIEW_H - 34 - amp * (1 + caveNoise((x + scroll * par) * 2.1 + par * 900)));
      ctx.lineTo(VIEW_W, VIEW_H);
      ctx.fill();
    }
    for (let i = 0; i < 40; i++) {
      const lx = ((i * 97.3 - scroll * 0.35) % (VIEW_W + 40) + VIEW_W + 40) % (VIEW_W + 40) - 20;
      const ly = 30 + ((i * 53.7) % (VIEW_H - 60));
      ctx.fillStyle = i % 3 ? "rgba(34,211,238,0.35)" : "rgba(225,29,143,0.4)";
      ctx.fillRect(lx, ly, 1.5, 1.5);
    }
    // near rock, roof and floor, with a neon lip
    for (const [fn, edge, colour, rim] of [[caveRoof, 0, "#0b0714", "#e11d8f"], [caveFloor, VIEW_H, "#0a0a16", "#22d3ee"]]) {
      ctx.beginPath();
      ctx.moveTo(0, edge);
      for (let x = 0; x <= VIEW_W; x += 3) ctx.lineTo(x, fn(scroll + x));
      ctx.lineTo(VIEW_W, edge);
      ctx.closePath();
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.beginPath();
      for (let x = 0; x <= VIEW_W; x += 3) ctx.lineTo(x, fn(scroll + x));
      ctx.strokeStyle = rim;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.strokeStyle = rim === "#e11d8f" ? "rgba(225,29,143,0.25)" : "rgba(34,211,238,0.25)";
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    for (const pod of b.pods) {
      const x = pod.x - scroll;
      if (x < -10 || x > VIEW_W + 10) continue;
      const r = 5 + Math.sin(T * 0.2 + pod.x) * 0.8;
      ctx.fillStyle = "rgba(240,171,252,0.3)";
      ctx.beginPath();
      ctx.arc(x, pod.y, r + 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f0abfc";
      ctx.beginPath();
      ctx.arc(x, pod.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const gem of b.gems) {
      const x = gem.x - scroll;
      if (x < -10 || x > VIEW_W + 10) continue;
      const w = 3.5 * Math.abs(Math.cos(T * 0.12 + gem.x * 0.05)) + 0.8;
      ctx.fillStyle = gem.rich ? "#fbbf24" : "#a3e635";
      ctx.beginPath();
      ctx.moveTo(x, gem.y - 5);
      ctx.lineTo(x + w, gem.y);
      ctx.lineTo(x, gem.y + 5);
      ctx.lineTo(x - w, gem.y);
      ctx.fill();
      ctx.fillStyle = "#ecfccb";
      ctx.fillRect(x - 0.5, gem.y - 2, 1, 4);
    }
    for (const u of b.ups) {
      const x = u.x - scroll;
      if (u.dead || x < -14 || x > VIEW_W + 14) continue;
      const col = u.kind === "magnet" ? "#f87171" : u.kind === "double" ? "#fbbf24" : "#67e8f9";
      ctx.save();
      ctx.translate(x, u.y + Math.sin(T * 0.1 + u.x) * 2);
      ctx.rotate(T * 0.04);
      ctx.beginPath();
      for (let i = 0; i < 6; i++) ctx.lineTo(Math.cos((i * Math.PI) / 3) * 9, Math.sin((i * Math.PI) / 3) * 9);
      ctx.closePath();
      ctx.fillStyle = "rgba(2,6,23,0.85)";
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.rotate(-T * 0.04);
      ctx.fillStyle = col;
      ctx.font = "bold 8px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(u.kind === "magnet" ? "M" : u.kind === "double" ? "x2" : "OD", 0, 0.5);
      ctx.restore();
    }
    for (const sh of b.shots) {
      ctx.fillStyle = laserColor();
      ctx.fillRect(sh.x - scroll - 5, sh.y - 1, 9, 2);
    }
    drawJetSideways(b.px, b.py);
    if (b.msgT > 0) {
      ctx.font = "bold 10px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = `rgba(240,171,252,${Math.min(1, b.msgT / 30)})`;
      ctx.fillText(b.msg, VIEW_W / 2, 26);
      ctx.textAlign = "left";
    }
    ctx.font = "bold 9px monospace";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#a3e635";
    ctx.fillText(`BONUS ${b.got} CR`, 6, 6);
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(VIEW_W - 86, 8, 80, 3);
    ctx.fillStyle = "#f0abfc";
    ctx.fillRect(VIEW_W - 86, 8, 80 * (1 - b.t / BONUS_LEN), 3);
    if (b.done > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(VIEW_W / 2 - 90, VIEW_H / 2 - 20, 180, 40);
      ctx.textAlign = "center";
      ctx.fillStyle = "#f0abfc";
      ctx.font = "bold 12px monospace";
      ctx.fillText("BONUS ROUND OVER", VIEW_W / 2, VIEW_H / 2 - 13);
      ctx.fillStyle = "#a3e635";
      ctx.font = "bold 10px monospace";
      ctx.fillText(`+${b.got} CREDITS`, VIEW_W / 2, VIEW_H / 2 + 4);
      ctx.textAlign = "left";
    }
  }

  // --- Power: the more the ship has been upgraded, the more comes at it and the wilder things blow up ---
  const power = () => UPGRADES.reduce((n, item) => n + (item.id === "nova" || item.id === "life" || item.id === "salvage" ? 0 : up(item.id)), 0);
  const NOVA_MAX = 3;
  const NOVA_DROP_EVERY = 80; // every Nth destroyed enemy leaves a nova bomb

  // Sparks and shock rings thrown by explosions. At no upgrades they are a few orange embers; each upgrade adds
  // more of them, in a wider spread of colours.
  function burst(x, y, size = 1, pwOver = null) {
    const pw = pwOver === null ? power() : pwOver;
    const n = Math.min(70, Math.round((4 + pw * 2.4) * size));
    const base = Math.random() * 360;
    const range = Math.min(360, 20 + pw * 28);
    for (let i = 0; i < n && state.sparks.length < 700; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.6 + Math.random() * 2.3) * (1 + pw * 0.05) * Math.sqrt(size);
      const life = 16 + Math.random() * (14 + pw * 2);
      state.sparks.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life,
        hue: pw === 0 ? 22 + Math.random() * 26 : base + (Math.random() - 0.5) * range,
        size: 1 + Math.random() * (1 + pw * 0.09),
      });
    }
    if (pw >= 3) state.sparks.push({ ring: true, x, y, r: 3, grow: 1.1 + 0.05 * pw, life: 16 + pw, max: 16 + pw, hue: base + 150 });
    if (pw >= 8) state.sparks.push({ ring: true, x, y, r: 1, grow: 0.7 + 0.03 * pw, life: 22 + pw, max: 22 + pw, hue: base + 290 });
  }

  function stepSparks() {
    for (const sp of state.sparks) {
      sp.life--;
      if (sp.ring) {
        sp.r += sp.grow;
        continue;
      }
      sp.x += sp.vx;
      sp.y += sp.vy;
      sp.vx *= 0.95;
      sp.vy *= 0.95;
    }
    state.sparks = state.sparks.filter((sp) => sp.life > 0);
  }

  // map(x, y) -> { x, y, s } turns a spark's position into screen pixels (the tilted ground, or the side view)
  function drawSparks(map) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const sp of state.sparks) {
      const p = map(sp.x, sp.y);
      const a = sp.life / sp.max;
      if (sp.ring) {
        ctx.strokeStyle = `hsla(${sp.hue},100%,65%,${a * 0.8})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.arc(p.x, p.y, sp.r * p.s, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }
      // a thin bright streak along the way it is flying, with a hot point at its head
      const q = map(sp.x - sp.vx * 3.5, sp.y - sp.vy * 3.5);
      ctx.strokeStyle = `hsla(${sp.hue},100%,${58 + 25 * a}%,${a})`;
      ctx.lineWidth = Math.max(0.5, sp.size * p.s * 0.45);
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.fillStyle = `hsla(${sp.hue},100%,90%,${a})`;
      ctx.fillRect(p.x - 0.5, p.y - 0.5, 1, 1);
    }
    ctx.restore();
  }

  // Readouts shared by both views: credits, nova bombs held
  function drawStock() {
    ctx.save();
    ctx.scale(ZOOM, ZOOM);
    ctx.font = "bold 9px monospace";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillText(`CR ${state.credits}`, 7, 7);
    ctx.fillStyle = "#a3e635";
    ctx.fillText(`CR ${state.credits}`, 6, 6);
    for (let i = 0; i < up("nova"); i++) {
      ctx.fillStyle = "#f0abfc";
      ctx.beginPath();
      ctx.arc(10 + i * 10, 22, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillRect(9 + i * 10, 21, 2, 2);
    }
    ctx.restore();
  }

  let prevNovaBtn = false;
  function novaPressed() {
    const pad = navigator.getGamepads ? navigator.getGamepads()[gpState.activeIndex] : null;
    const down = Boolean(pad && pad.buttons && ((pad.buttons[4] && pad.buttons[4].pressed) || (pad.buttons[3] && pad.buttons[3].pressed)));
    const edge = down && !prevNovaBtn;
    prevNovaBtn = down;
    return consumeAction("KeyN") || edge;
  }

  // --- Bosses: one waits at the end of every level. The same boss logic runs in both views: it thinks in
  // "lat" (across the player's path) and "depth" (distance from the far edge toward the player). ---
  const BOSSES = {
    1: { name: "HARBOUR WARDEN", shape: 0, hull: "#334155", trim: "#22d3ee", core: "#f0abfc" },
    2: { name: "TRENCH WYRM", shape: 1, hull: "#1f3a34", trim: "#a3e635", core: "#fbbf24" },
    3: { name: "DUNE CRAWLER", shape: 2, hull: "#57412a", trim: "#fb923c", core: "#fde047" },
    4: { name: "FOUNDRY CORE", shape: 3, hull: "#3b2a55", trim: "#e11d8f", core: "#67e8f9" },
    5: { name: "THE MAW", shape: 4, hull: "#5a1326", trim: "#f87171", core: "#a3e635" },
    6: { name: "HIVE QUEEN", shape: 5, hull: "#3f1d4a", trim: "#a3e635", core: "#f87171" },
    7: { name: "LANDFALL DREADNOUGHT", shape: 0, hull: "#3f4a2a", trim: "#fbbf24", core: "#22d3ee" },
    8: { name: "LEVIATHAN", shape: 1, hull: "#123a52", trim: "#67e8f9", core: "#f0abfc" },
    9: { name: "SKYLINE TYRANT", shape: 5, hull: "#1e1b3a", trim: "#e11d8f", core: "#22d3ee" },
    10: { name: "ORBITAL BASTION", shape: 3, hull: "#2a3344", trim: "#22d3ee", core: "#fbbf24" },
    11: { name: "MOON SPIDER", shape: 2, hull: "#4b5563", trim: "#e2e8f0", core: "#f87171" },
    12: { name: "CINDER KING", shape: 4, hull: "#3a1206", trim: "#fb923c", core: "#fde047" },
  };
  const BOSS_HALF_LAT = 56;
  const BOSS_HALF_DEPTH = 28;

  function makeBoss() {
    const lvl = shownLevel();
    const hp = Math.round((140 + 60 * lvl) * (0.8 + 0.1 * state.difficulty) * (1 + 0.04 * power()));
    sound.play("hum2", 1.0, 0, 0.5);
    sound.play(sound.pick("spin_b", "hum2"), 0.9, 0, 0.45);
    return {
      lvl, look: BOSSES[worldFor(state.level, state.loopCount) || (state.side ? sideTheme() : baseLevel())], hp, max: hp, t: 0, lat: 0, depth: -80, flash: 0, dying: 0, gone: false, pods: [[-40, 2], [40, 2]],
      side: Math.random() < 0.5 ? 1 : -1, // side-scroller: which edge of the screen it holds (it changes over as it is worn down)
      ph: Math.random() * 6.28, // where across the screen it comes in
      rage: 0, leaving: false,
    };
  }
  const bossSX = (b) => (b.side < 0 ? b.depth : VIEW_W - b.depth); // side view: its screen x

  // env: { W, plat, pdepth, fire(lat, depth, vlat, vdepth), minion(), swap (it may change sides), lunge (how deep it can dive) }
  // It gets harder as it is worn down (three stages), and bosses on later levels are tougher, quicker and busier.
  function stepBoss(b, env) {
    if (b.gone) return;
    b.t++;
    if (b.flash > 0) b.flash--;
    if (b.lurk) {
      // waiting behind the formation: it hangs there and does nothing until the wall is shot away
      b.lat = env.W / 2 + Math.sin(b.t * 0.02) * 24;
      b.depth += (b.lurk - b.depth) * 0.04;
      return;
    }
    if (b.dying > 0) {
      if (--b.dying === 0) b.gone = true;
      return;
    }
    const k = 1 + 0.07 * b.lvl + (state.difficulty - 3) * 0.1;
    const rage = b.hp < b.max * 0.33 ? 2 : b.hp < b.max * 0.66 ? 1 : 0;
    if (rage > b.rage) {
      // each time it is knocked into its next stage it pulls out, and (side-on) comes back in from the other edge
      b.rage = rage;
      b.leaving = true;
      sound.play(sound.pick("spin_a", "hum2"), 0.8, 0, 0.6);
    }
    if (b.leaving) {
      b.depth += (-120 - b.depth) * 0.07;
      if (b.depth < -95) {
        b.leaving = false;
        if (env.swap) b.side = -b.side;
        b.ph = Math.random() * 6.28;
      }
      return;
    }
    // it also dives at you now and then, deeper and more often in its later stages and on later levels
    const period = Math.max(170, 420 - 60 * rage - 8 * b.lvl);
    const lunging = (b.lvl >= 3 || rage > 0) && b.t > 200 && b.t % period < 60;
    const want = lunging ? env.lunge : 58 + 8 * Math.sin(b.t * 0.05);
    b.depth += (want - b.depth) * (lunging ? 0.05 : 0.04);
    b.lat = env.W / 2 + Math.sin(b.t * 0.017 * (1 + 0.3 * rage) + b.ph) * Math.max(10, env.W / 2 - 64);
    if (b.t < 90 || !state.player.alive) return;
    const speed = 2.5 + 0.035 * b.lvl + 0.2 * rage;
    const every = (n) => b.t % Math.max(8, Math.round(n / k)) === 0;
    if (every(64 - 14 * rage)) {
      for (const [px, py] of b.pods) {
        const a = Math.atan2(env.pdepth - (b.depth + py), env.plat - (b.lat + px));
        for (const sp of rage >= 2 ? [-0.22, 0, 0.22] : [0]) env.fire(b.lat + px, b.depth + py + 8, Math.cos(a + sp) * speed, Math.sin(a + sp) * speed);
      }
    }
    if (every(230 - 30 * rage)) {
      const n = 12 + 3 * rage + Math.min(10, b.lvl >> 1);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + b.t;
        env.fire(b.lat, b.depth, Math.cos(a) * (speed - 0.5), Math.sin(a) * (speed - 0.5));
      }
    }
    if (rage >= 1 && b.t % 300 < 70 + 20 * rage && b.t % (rage >= 2 ? 4 : 6) === 0) {
      const a = Math.PI / 2 + Math.sin(b.t * 0.09) * 0.9;
      env.fire(b.lat, b.depth + 20, Math.cos(a) * (speed + 0.3), Math.sin(a) * (speed + 0.3));
    }
    if (every(420 - 80 * rage)) env.minion();
  }

  function hurtBoss(b, dmg) {
    if (b.dying || b.gone || b.lurk) return;
    b.hp -= dmg;
    b.flash = 3;
    sound.play("bump", 0.4, 0, 0.8, "bosshit", 50);
    if (b.hp <= 0) {
      b.hp = 0;
      b.dying = 110;
      track("boss_defeated", { level: b.lvl });
      addScore(5000 + 1000 * b.lvl);
      state.credits += Math.round((400 + 100 * b.lvl) * lean());
      sound.play(sound.pick("explosion_c", "expl2"), 1.4, 0, 0.6);
    }
  }

  // Drawn with its guns toward +y; rot turns it for the side view
  function drawBoss(b, cx, cy, sc, rot) {
    const L = b.look;
    const T = state.frameTick;
    if (b.dying && ((T >> 1) & 1)) return;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.scale(sc, sc);
    ctx.lineJoin = "round";
    ctx.fillStyle = b.flash > 0 ? "#ffffff" : L.hull;
    ctx.strokeStyle = L.trim;
    ctx.lineWidth = 0.8;
    ctx.shadowColor = L.trim;
    ctx.shadowBlur = 10;
    const poly = (pts) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    };
    const disc = (x, y, r) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };
    if (L.shape === 0) {
      poly([[-60, -20], [-24, -30], [24, -30], [60, -20], [46, 6], [18, 14], [0, 32], [-18, 14], [-46, 6]]);
      poly([[-24, -30], [-12, -8], [12, -8], [24, -30]]);
    } else if (L.shape === 1) {
      for (const [x, r] of [[-42, 20], [42, 20], [0, 27]]) disc(x, 0, r);
      ctx.fillRect(-42, -5, 84, 10);
    } else if (L.shape === 2) {
      poly([[-34, -28], [34, -28], [52, 0], [34, 28], [-34, 28], [-52, 0]]);
      for (const s of [-1, 1]) {
        poly([[s * 52, -22], [s * 62, -22], [s * 62, 22], [s * 52, 22]]);
        for (let i = -2; i <= 2; i++) ctx.strokeRect(s * 57 - 5, i * 9 - 3 + ((T >> 2) % 3), 10, 0.5);
      }
    } else if (L.shape === 3) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + T * 0.01;
        poly([[Math.cos(a) * 20, Math.sin(a) * 11], [Math.cos(a - 0.2) * 58, Math.sin(a - 0.2) * 29], [Math.cos(a + 0.2) * 58, Math.sin(a + 0.2) * 29]]);
      }
      ctx.beginPath();
      ctx.ellipse(0, 0, 54, 27, 0, 0, Math.PI * 2);
      ctx.lineWidth = 7;
      ctx.strokeStyle = b.flash > 0 ? "#ffffff" : L.hull;
      ctx.stroke();
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = L.trim;
      ctx.stroke();
    } else if (L.shape === 4) {
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const a = (i / 40) * Math.PI * 2;
        const r = 1 + 0.12 * Math.sin(a * 5 + T * 0.08) + 0.06 * Math.sin(a * 9 - T * 0.05);
        ctx.lineTo(Math.cos(a) * 56 * r, Math.sin(a) * 28 * r);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      for (let i = -3; i <= 3; i++) poly([[i * 12 - 4, 20], [i * 12 + 4, 20], [i * 12, 31 + 3 * Math.sin(T * 0.2 + i)]]);
    } else {
      poly([[-56, 6], [-56, -14], [-40, -2], [-28, -30], [-14, -4], [0, -32], [14, -4], [28, -30], [40, -2], [56, -14], [56, 6], [30, 24], [-30, 24]]);
    }
    for (const [px, py] of b.pods) {
      ctx.fillStyle = b.flash > 0 ? "#ffffff" : "#0f172a";
      disc(px, py, 8);
      ctx.fillStyle = L.trim;
      ctx.fillRect(px - 1.5, py, 3, 13);
    }
    const pulse = 9 + 2.5 * Math.sin(T * 0.18);
    const grad = ctx.createRadialGradient(0, 0, 1, 0, 0, pulse + 5);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.4, L.core);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, pulse + 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawBossBar(b, y) {
    ctx.font = "bold 8px monospace";
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    ctx.fillStyle = "#f87171";
    ctx.fillText(b.look.name, VIEW_W / 2, y);
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(VIEW_W / 2 - 81, y + 9, 162, 5);
    ctx.fillStyle = b.hp < b.max * 0.33 ? "#f87171" : b.hp < b.max * 0.66 ? "#fbbf24" : "#a3e635";
    ctx.fillRect(VIEW_W / 2 - 80, y + 10, 160 * (b.hp / b.max), 3);
  }

  // More enemies as the ship grows stronger: extra flyers drop in from ahead (top-down levels)
  function reinforce(count) {
    const pool = state.flyerPool;
    if (!pool || !pool.length) return;
    const viewTop = state.scrollY - VIEW_H;
    for (let i = 0; i < count; i++) {
      const rec = pool[(Math.random() * pool.length) | 0];
      const x = Math.max(30, Math.min(WORLD_W - 30, state.player.x + (Math.random() - 0.5) * 320));
      const ent = promote(makeEntity({ ...rec, x, y: viewTop - 30 - i * 22, mir: false, index: 100000 + state.frameTick + i }));
      ent.flagsLo |= 0x40;
      state.entities.push(ent);
    }
  }

  // Nova bomb: everything on the screen goes at once
  function fireNova() {
    if (up("nova") <= 0) return false;
    state.upgrades.nova--;
    state.novaFlash = 26;
    sound.play(sound.pick("explosion_c", "expl2"), 1.5, 0, 0.5);
    sound.play(sound.pick("laser_big", "shot3"), 1.0, 0, 0.4);
    return true;
  }

  function novaTopDown() {
    if (!fireNova()) return;
    const viewTop = state.scrollY - VIEW_H;
    for (const ent of state.entities) {
      if (!ent.alive || ent.isIcon || (ent.flagsHi & 0x10) !== 0) continue;
      const box = getEntityHitbox(ent);
      if (box.x + box.w < state.scrollX - 60 || box.x > state.scrollX + VIEW_W + 60 || box.y + box.h < viewTop - 10 || box.y > state.scrollY + 10) continue;
      killEntity(ent);
    }
    state.enemyBullets = [];
    if (state.boss) hurtBoss(state.boss, 60);
  }

  // --- The water world: sea creatures, drawn as glowing line art rather than sprites ---
  // side = seen from the side (ocean side-scroller); otherwise from above (the Deep Water map).
  // dir: 1 facing right / -1 left. air: a shark out of the water.
  function drawSea(kind, x, y, T, flash, side, dir = 1, air = true, rot = 0) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1.6, 1.6); // big enough to read with the camera pulled well back
    ctx.lineJoin = "round";
    ctx.lineWidth = 0.5;
    const body = (fill, stroke) => {
      ctx.fillStyle = flash ? "#ffffff" : fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.shadowColor = stroke;
      ctx.shadowBlur = 6;
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    if (kind === "jelly") {
      const pulse = 1 + 0.14 * Math.sin(T * 0.16 + x * 0.05);
      if (side) {
        ctx.beginPath();
        ctx.ellipse(0, 0, 8 * pulse, 7 / pulse, 0, Math.PI, 0);
        ctx.closePath();
        body("rgba(190,60,220,0.55)", "#f0abfc");
        ctx.strokeStyle = "#67e8f9";
        for (let i = -2; i <= 2; i++) {
          ctx.beginPath();
          ctx.moveTo(i * 3, 0);
          for (let k = 1; k <= 4; k++) ctx.lineTo(i * 3 + 1.6 * Math.sin(T * 0.2 + k + i), k * 3.2);
          ctx.stroke();
        }
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, 7 * pulse, 0, Math.PI * 2);
        body("rgba(190,60,220,0.5)", "#f0abfc");
        ctx.strokeStyle = "#67e8f9";
        ctx.beginPath();
        ctx.arc(0, 0, 3.2 / pulse, 0, Math.PI * 2);
        ctx.stroke();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + T * 0.02;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * 7, Math.sin(a) * 7);
          ctx.lineTo(Math.cos(a + 0.3) * (11 + 2 * Math.sin(T * 0.2 + i)), Math.sin(a + 0.3) * (11 + 2 * Math.sin(T * 0.2 + i)));
          ctx.stroke();
        }
      }
    } else if (kind === "shark") {
      if (side) {
        ctx.scale(dir, 1);
        ctx.rotate(rot * dir);
        if (!air) {
          // under the surface: just the fin cutting the water, and a ripple
          ctx.beginPath();
          ctx.moveTo(-5, -5);
          ctx.lineTo(3, -5);
          ctx.lineTo(-3, -14);
          ctx.closePath();
          body("#475569", "#cbd5e1");
          ctx.strokeStyle = "rgba(186,230,253,0.7)";
          ctx.beginPath();
          ctx.moveTo(-12, -5);
          ctx.lineTo(10, -5);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(14, 0);
          ctx.quadraticCurveTo(4, -6, -9, -2);
          ctx.lineTo(-15, -7);
          ctx.lineTo(-13, 0);
          ctx.lineTo(-15, 6);
          ctx.lineTo(-9, 2);
          ctx.quadraticCurveTo(4, 6, 14, 0);
          body("#64748b", "#e2e8f0");
          ctx.beginPath();
          ctx.moveTo(-2, -4);
          ctx.lineTo(3, -4.5);
          ctx.lineTo(-3, -11);
          ctx.closePath();
          body("#475569", "#e2e8f0");
          ctx.fillStyle = "#f87171";
          ctx.fillRect(8, -1.5, 1.5, 1.5);
          ctx.strokeStyle = "#ffffff";
          ctx.beginPath();
          ctx.moveTo(8, 2);
          ctx.lineTo(13, 0.6);
          ctx.stroke();
        }
      } else {
        ctx.rotate(rot);
        ctx.beginPath();
        ctx.ellipse(0, 0, 4, 13, 0, 0, Math.PI * 2);
        body("rgba(51,65,85,0.75)", "rgba(148,163,184,0.8)");
        ctx.beginPath();
        ctx.moveTo(-1.5, -3);
        ctx.lineTo(1.5, -3);
        ctx.lineTo(0, 4);
        ctx.closePath();
        body("#94a3b8", "#f1f5f9");
        ctx.strokeStyle = "rgba(186,230,253,0.6)";
        ctx.beginPath();
        ctx.moveTo(-4, 12);
        ctx.lineTo(0, 18 + 2 * Math.sin(T * 0.4));
        ctx.lineTo(4, 12);
        ctx.stroke();
      }
    } else if (kind === "squid") {
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.quadraticCurveTo(9, -4, 6, 4);
      ctx.lineTo(-6, 4);
      ctx.quadraticCurveTo(-9, -4, 0, -12);
      body("rgba(220,70,90,0.7)", "#fb7185");
      ctx.strokeStyle = "#fda4af";
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 2.4, 4);
        for (let k = 1; k <= 4; k++) ctx.lineTo(i * 2.6 + 2 * Math.sin(T * 0.25 + k * 0.9 + i), 4 + k * 3);
        ctx.stroke();
      }
      ctx.fillStyle = "#fef08a";
      ctx.fillRect(-3.5, -1, 2, 2);
      ctx.fillRect(1.5, -1, 2, 2);
    } else if (kind === "buoy") {
      ctx.beginPath();
      ctx.rect(-6, -4, 12, 9);
      body("#b45309", "#fbbf24");
      ctx.strokeStyle = "#e2e8f0";
      ctx.beginPath();
      ctx.moveTo(0, -4);
      ctx.lineTo(0, -13);
      ctx.stroke();
      ctx.fillStyle = (T >> 3) & 1 ? "#ef4444" : "#7f1d1d";
      ctx.fillRect(-1.2, -15, 2.4, 2.4);
    } else if (kind === "boat") {
      if (side) {
        ctx.scale(dir, 1);
        ctx.beginPath();
        ctx.moveTo(-15, -2);
        ctx.lineTo(16, -2);
        ctx.lineTo(11, 5);
        ctx.lineTo(-12, 5);
        ctx.closePath();
        body("#334155", "#22d3ee");
        ctx.beginPath();
        ctx.rect(-6, -8, 9, 6);
        body("#475569", "#e2e8f0");
        ctx.fillStyle = "#e2e8f0";
        ctx.fillRect(4, -5, 9, 1.4);
      } else {
        ctx.rotate(rot);
        ctx.beginPath();
        ctx.moveTo(0, -17);
        ctx.quadraticCurveTo(7, -8, 6, 14);
        ctx.lineTo(-6, 14);
        ctx.quadraticCurveTo(-7, -8, 0, -17);
        body("#334155", "#22d3ee");
        ctx.beginPath();
        ctx.rect(-3.5, -2, 7, 9);
        body("#475569", "#e2e8f0");
        ctx.beginPath();
        ctx.arc(0, -8, 2.6, 0, Math.PI * 2);
        body("#0f172a", "#fbbf24");
      }
    } else {
      // submarine, awash
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.ellipse(0, 0, 6, 20, 0, 0, Math.PI * 2);
      body("rgba(15,23,42,0.85)", "#38bdf8");
      ctx.beginPath();
      ctx.rect(-3, -6, 6, 10);
      body("#1e293b", "#7dd3fc");
      ctx.fillStyle = (T >> 3) & 1 ? "#ef4444" : "#7f1d1d";
      ctx.fillRect(-1, -3, 2, 2);
    }
    ctx.restore();
  }

  // Deep Water (the ocean map flown top-down): sea life comes up out of the water as you cross it
  function isWater(x, y) {
    const m = state.seaMask;
    if (!m) return false;
    const mx = Math.floor(((x + WIDE_OFF) / (MAP_W * 3)) * m.w);
    const my = Math.floor((y / MAP_H) * m.h);
    if (mx < 0 || my < 0 || mx >= m.w || my >= m.h) return false;
    return m.d[(my * m.w + mx) * 4 + 1] > 190; // the height data's green channel is high over water
  }

  function spawnSea() {
    if (--state.seaT > 0 || state.boss) return;
    state.seaT = Math.max(24, 78 - 3 * power());
    const viewTop = state.scrollY - VIEW_H;
    const tmpl = state.spawnQueue[0];
    if (!tmpl) return;
    for (let tries = 0; tries < 8; tries++) {
      const x = Math.max(24, Math.min(WORLD_W - 24, state.scrollX + Math.random() * VIEW_W));
      const y = viewTop - 14;
      if (!isWater(x, y) || !isWater(x, y + 30)) continue;
      const r = Math.random();
      const kind = r < 0.34 ? "jelly" : r < 0.62 ? "shark" : r < 0.84 ? "boat" : "sub";
      const spec = { jelly: [1, 150, 22, 22, true], shark: [2, 250, 14, 38, false], boat: [4, 400, 20, 48, true], sub: [6, 600, 20, 60, true] }[kind];
      const ent = makeEntity({ ...tmpl, x, y, path_ops: null, ai_fn: null, death_fn: null, hp: spec[0], rubble_frame: -1, mir: false, index: 200000 + state.frameTick });
      spec[0] += toughness(state.frameTick);
      Object.assign(ent, {
        aniKey: "sea", sea: kind, hp: spec[0], maxHp: spec[0], scoreVal: spec[1], w: spec[2], h: spec[3], frame: 0, pathOps: null, aiFn: null, deathFn: null,
        flagsHi: 0, flagsLo: spec[4] ? 0x40 : 0, isIcon: false, staticWall: false, staticTarget: false, rubbleFrame: -1, aiDir: Math.random() < 0.5 ? 1 : -1, seaT: 0, rot: 0,
      });
      state.entities.push(ent);
      if (kind === "jelly") {
        // jellyfish come in a little bloom
        for (const [ox, oy] of [[-16, -12], [15, -18]]) {
          if (!isWater(x + ox, y + oy)) continue;
          const e2 = { ...ent, x: x + ox, y: y + oy, id: ent.id + 1 + ox, aiTimer: 60 + Math.random() * 60 };
          state.entities.push(e2);
        }
      }
      return;
    }
  }

  function stepSeaEnt(ent) {
    const p = state.player;
    ent.seaT++;
    let nx = ent.x;
    let ny = ent.y;
    if (ent.sea === "boat") {
      nx += ent.aiDir * 0.5;
      ent.rot = ent.aiDir * Math.PI * 0.5;
      if (!isWater(nx + ent.aiDir * 18, ny) || nx < 24 || nx > WORLD_W - 24) {
        ent.aiDir = -ent.aiDir;
        nx = ent.x;
      }
    } else if (ent.sea === "jelly") {
      ny += 0.25;
      nx += Math.sin(ent.seaT * 0.05 + ent.id) * 0.3;
    } else if (ent.sea === "shark") {
      // it circles in, then rushes you
      const dx = p.x - ent.x;
      const dy = p.y - ent.y;
      const d = Math.hypot(dx, dy) || 1;
      const rush = d < 150 && ent.seaT % 160 < 70;
      const sp = rush ? 3.0 : 1.0;
      nx += (dx / d) * sp + (rush ? 0 : Math.cos(ent.seaT * 0.05) * 0.8);
      ny += (dy / d) * sp * (rush ? 1 : 0.5) + 0.3;
      ent.rot = Math.atan2(dx, -dy);
    } else if (ent.seaT > 320) {
      ent.alive = false; // the sub slips back under
      return;
    }
    if (isWater(nx, ny)) {
      ent.x = nx;
      ent.y = ny;
    }
  }

  // --- Side-scrolling levels (every even level): free flight both ways over a wrap-around landscape ---
  const SIDE_W = 3000;
  const SIDE_THEMES = {
    2: { sky: ["#05080f", "#0b1a24", "#04080c"], far: "towers", farCol: "#0c2230", midCol: "#123040", ground: "#0a1218", rim: "#22d3ee", lamp: ["#22d3ee", "#fbbf24"], amp: 16, foes: ["enemy1", "enemy4"] },
    4: { sky: ["#020308", "#0a0618", "#030208"], stars: true, far: "girders", farCol: "#1a1030", midCol: "#261640", ground: "#141024", rim: "#e11d8f", lamp: ["#e11d8f", "#67e8f9"], amp: 20, blocks: true, foes: ["enemy4", "enemy5"] },
    6: { sky: ["#12020a", "#2a0612", "#0a0204"], far: "spires", farCol: "#3a0a1c", midCol: "#4a1024", ground: "#1a060c", rim: "#a3e635", lamp: ["#a3e635", "#f87171"], amp: 28, liquid: "rgba(101,163,13,0.55)", foes: ["enemy1", "enemy2"] },
    8: { sky: ["#06203a", "#0b3d5c", "#041826"], far: "peaks", farCol: "#0a2a3a", midCol: "#0c3346", ground: "#0c1c22", rim: "#67e8f9", lamp: ["#67e8f9", "#fbbf24"], amp: 26, liquid: "rgba(10,70,130,0.6)", sea: 0.8, foes: ["enemy3", "enemy1"] }, // sea = the waterline, as a fraction of the screen height: open sea with islands, and sea creatures instead of machines
    10: { sky: ["#000004", "#04061a", "#000208"], stars: true, planet: true, far: "girders", farCol: "#141c2c", midCol: "#1c2638", ground: "#1a2230", rim: "#22d3ee", lamp: ["#22d3ee", "#f0abfc"], amp: 14, blocks: true, foes: ["enemy5", "enemy4"] },
    12: { sky: ["#1a0502", "#3a0c04", "#0a0201"], far: "cones", farCol: "#2a0a06", midCol: "#3a1008", ground: "#0e0606", rim: "#fb923c", lamp: ["#fb923c", "#fde047"], amp: 30, liquid: "rgba(249,115,22,0.8)", foes: ["enemy2", "enemy3"] },
  };
  const wrapD = (d) => ((((d + SIDE_W / 2) % SIDE_W) + SIDE_W) % SIDE_W) - SIDE_W / 2;
  const rnd = (i, seed) => {
    const v = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };

  function sideRock(s, x) {
    if (s.theme.blocks) x = Math.floor(x / 28) * 28;
    const a = (x / SIDE_W) * Math.PI * 2;
    let h = 0.5 + 0.25 * Math.sin(a * 3 + s.phase) + 0.15 * Math.sin(a * 7 + 1.7 * s.phase) + 0.1 * Math.sin(a * 17 + 4.1) + 0.06 * Math.sin(a * 41 + 2);
    if (s.theme.blocks) h = Math.floor(h * 5) / 5;
    return VIEW_H - 12 - (s.theme.sea ? VIEW_H * 0.36 : s.theme.amp) * h;
  }
  const seaLevel = (s, x) => VIEW_H * s.theme.sea + 2 * Math.sin(x * 0.045 + state.frameTick * 0.07);
  // what the jet cannot fly below: the ground, or on the open sea the water's surface (islands stand up out of it)
  function sideGround(s, x) {
    const r = sideRock(s, x);
    return s.theme.sea ? Math.min(r, seaLevel(s, x)) : r;
  }

  function mkFoe(s, kind, x) {
    const lvl = s.lvl;
    const f = { kind, x: ((x % SIDE_W) + SIDE_W) % SIDE_W, y: 0, vx: 0, vy: 0, t: 0, flash: 0, fire: 40 + Math.random() * 60, ph: Math.random() * 6 };
    if (kind === "drone") Object.assign(f, { key: s.theme.foes[(Math.random() * 2) | 0], hp: 1 + (lvl > 6 ? 1 : 0), score: 150, y0: 34 + Math.random() * (VIEW_H - 120), amp: 10 + Math.random() * 26, spd: 1.2 + Math.random() * 1.0 + lvl * 0.03 });
    else if (kind === "seeker") Object.assign(f, { key: "spinner", hp: 1, score: 200, y: 30 + Math.random() * (VIEW_H - 100) });
    else if (kind === "hover") Object.assign(f, { key: "hover", hp: 4, score: 400, y0: 40 + Math.random() * (VIEW_H - 130), side: Math.random() < 0.5 ? -1 : 1 });
    else if (kind === "turret") Object.assign(f, { key: "turret1", hp: 3, score: 300, ground: true });
    else Object.assign(f, { key: "walker1", hp: 3, score: 350, ground: true, x0: f.x, dir: 1 });
    f.hp += toughness(f.x + f.ph * 100);
    if (Math.random() < eliteChance()) {
      f.elite = true;
      f.hp = f.hp * 3 + 2;
      f.score *= 3;
    }
    f.maxHp = f.hp;
    if (f.y0) f.y = f.y0;
    if (s.theme.sea) f.sea = { drone: "jelly", seeker: "shark", hover: "squid", turret: "buoy", walker: "boat" }[kind];
    // hit box from the sprite itself (flyers are drawn turned on their side)
    const fr0 = getFrame(f.key, 0);
    const turned = !f.ground && kind !== "seeker";
    f.hw = Math.max(5, (fr0 ? (turned ? fr0.height : fr0.width) : 18) * 0.4);
    f.hh = Math.max(5, (fr0 ? (turned ? fr0.width : fr0.height) : 18) * 0.4);
    if (f.sea) [f.hw, f.hh] = { jelly: [12, 12], shark: [20, 9], squid: [12, 17], buoy: [10, 12], boat: [23, 9] }[f.sea];
    return f;
  }

  function startSide() {
    const lvl = shownLevel();
    const s = {
      lvl, theme: SIDE_THEMES[sideTheme()] || SIDE_THEMES[2], phase: lvl * 1.37,
      x: 300, y: VIEW_H / 2, vx: 0, vy: 0, face: 1, turn: 1, lead: 1, cam: 0, camV: 0, t: 0, viewH: VIEW_H,
      foes: [], shots: [], eshots: [], bombs: [], picks: [], booms: [],
      kills: 0, total: 0, reserve: Math.min(70, 16 + 2 * lvl + 3 * power()), spawnT: 80, boss: null, warn: 0, cooldown: 0, mcool: 0, // reserve = flyers still to arrive
    };
    const guns = Math.round((9 + lvl) * 0.83);
    for (let i = 0; i < guns; i++) s.foes.push(mkFoe(s, "turret", 700 + ((i + Math.random() * 0.6) * (SIDE_W - 800)) / guns));
    for (let i = 0; i < 4 + (lvl >> 1); i++) s.foes.push(mkFoe(s, "walker", 900 + Math.random() * (SIDE_W - 1100)));
    s.total = s.foes.length + s.reserve; // the boss only comes once every one of these is destroyed
    s.cam = s.x - VIEW_W * 0.3;
    state.side = s;
    state.sparks = [];
    state.screen = "side";
  }

  function sideBoom(s, x, y, size = 1) {
    s.booms.push({ x, y, frame: 4, size });
    burst(x, y, size);
  }

  function sideKill(s, f) {
    f.dead = true;
    addScore(f.score);
    state.kills++;
    if (!s.boss) s.kills++;
    state.credits += Math.round(Math.max(5, f.score / 20) * (1 + 0.25 * up("salvage")) * lean());
    sideBoom(s, f.x, f.y, f.hp > 2 ? 1.4 : 1);
    const kind = nextDrop();
    if (kind) s.picks.push({ kind, x: f.x, y: Math.min(f.y, sideGround(s, f.x) - 20), age: 0 });
    sound.play(sound.pick(f.score >= 300 ? "explosion_b" : "explosion_a", "expl2"), 0.7, 0.4, 0.9 + Math.random() * 0.3, "sdie", 50);
  }

  function sideHurtPlayer(s) {
    const p = state.player;
    const was = p.alive;
    damagePlayer();
    state.explosions = [];
    state.popups = [];
    if (was && !p.alive) sideBoom(s, s.x, s.y, 2);
  }

  function sideBlast(s, x, y, radius) {
    sideBoom(s, x, y, 1.8);
    sound.play(sound.pick("explosion_b", "expl2"), 1.0, 0, 0.7);
    for (const f of s.foes) {
      if (f.dead || Math.hypot(wrapD(f.x - x), f.y - y) > radius) continue;
      f.hp -= BOMB_DAMAGE;
      f.flash = 6;
      if (f.hp <= 0) sideKill(s, f);
    }
    for (const eb of s.eshots) if (Math.hypot(wrapD(eb.x - x), eb.y - y) <= radius) eb.dead = true;
    const b = s.boss;
    if (b && Math.hypot(wrapD(x - s.cam) - bossSX(b), y - b.lat) < radius + 30) hurtBoss(b, BOMB_DAMAGE * 2);
  }

  function stepSide() {
    const s = state.side;
    const p = state.player;
    const lvl = s.lvl;
    const pw = power();
    const hk = shipScale();
    s.t++;
    if (state.powerups.rapid > 0) state.powerups.rapid--;
    if (state.powerups.shield > 0) state.powerups.shield--;
    if (state.powerups.superShot > 0) state.powerups.superShot--;
    if (state.shieldFlash > 0) state.shieldFlash--;
    if (state.bombCooldown > 0) state.bombCooldown--;
    if (state.novaFlash > 0) state.novaFlash--;

    // Half way through the target count the arms dealer flags you down
    if (!state.dealerDone && s.kills >= s.total / 2) {
      openDealer();
      return;
    }
    const b = s.boss;
    if (b && b.gone) {
      addScore(2500 * state.level);
      state.credits += Math.round(200 * shownLevel() * lean());
      sound.play("icon", 1.0);
      track("level_complete", { level: shownLevel(), score: state.score, upgrades: power() });
      state.screen = "stage_clear";
      state.stateTimer = 150;
      return;
    }

    const ground = (x) => sideGround(s, x);
    const diffBoost = 1 + (state.difficulty - 3) * 0.14;
    const efire = (x, y, speed, spread = 0) => {
      const a = Math.atan2(s.y - y, wrapD(s.x - x)) + spread;
      s.eshots.push({ x, y, vx: Math.cos(a) * speed * diffBoost, vy: Math.sin(a) * speed * diffBoost, age: 0 });
      sound.play("shot5", 0.25, 0.12, 1.0, "sfire", 70);
    };

    // the jet
    if (!p.alive) {
      p.respawnTimer--;
      s.vx *= 0.9;
      if (p.respawnTimer <= 0 && (state.lives > 0 || state.trainer)) {
        p.alive = true;
        p.invuln = 120;
        s.y = VIEW_H * 0.4;
        state.shields = maxShields();
      }
    } else {
      if (p.invuln > 0) p.invuln--;
      const engine = 1 + 0.12 * up("engine");
      let mx = gpState.mx;
      let my = gpState.my;
      if (keys.has("ArrowLeft") || keys.has("KeyA")) mx -= 1;
      if (keys.has("ArrowRight") || keys.has("KeyD")) mx += 1;
      if (keys.has("ArrowUp") || keys.has("KeyW")) my -= 1;
      if (keys.has("ArrowDown") || keys.has("KeyS")) my += 1;
      mx = Math.max(-1, Math.min(1, mx));
      my = Math.max(-1, Math.min(1, my));
      // Momentum: the jet swings round as soon as you push the other way, but its thrust is then working against
      // the way it is already going, so it slows, stops and only then builds speed back. Let go and it coasts.
      if (Math.abs(mx) > 0.3) s.face = mx > 0 ? 1 : -1;
      s.vx = Math.max(-5.4 * engine, Math.min(5.4 * engine, (s.vx + mx * 0.15 * engine) * 0.985));
      s.vy = (s.vy + my * 0.55 * engine) * 0.84;
      s.y += s.vy;
      const floor = ground(s.x) - 9;
      if (s.y > floor) sound.play("bump", 0.4, 0, 0.6, "rock", 200);
      if (s.y > floor || s.y < 22) s.vy = 0;
      s.y = Math.max(22, Math.min(floor, s.y));

      const aiming = gpState.aimX !== 0 || gpState.aimY !== 0;
      const firing = keys.has("Space") || keys.has("KeyZ") || keys.has("Enter") || gpState.fireHeld || aiming;
      if (s.cooldown > 0) s.cooldown--;
      if (s.mcool > 0) s.mcool--;
      if (firing && s.cooldown <= 0) {
        const superOn = state.powerups.superShot > 0;
        const cannon = up("cannon");
        s.cooldown += (state.powerups.rapid > 0 ? 2 : 16 / 3) / CANNON_RATE[cannon];
        const dx = aiming ? gpState.aimX : s.face;
        const dy = aiming ? gpState.aimY : 0;
        const pierce = superOn || up("laser") > 0;
        const dmg = CANNON_DMG[cannon] + (superOn ? 1 : 0) + (up("laser") >= 2 ? 1 : 0);
        const shoot = (ax, ay, off = 0) => s.shots.push({ x: s.x + ax * 12 - ay * off, y: s.y + ay * 12 + ax * off, vx: ax * SHOT_SPEED + s.vx, vy: ay * SHOT_SPEED, pierce, dmg, life: 70 });
        shoot(dx, dy, 3);
        shoot(dx, dy, -3);
        for (let i = 1; i <= up("spread"); i++) {
          for (const side of [-1, 1]) {
            const a = side * i * 0.2;
            shoot(dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a));
          }
        }
        if (up("tail") >= 2) {
          for (const a of [-0.22, 0.22]) shoot(-(dx * Math.cos(a) - dy * Math.sin(a)), -(dx * Math.sin(a) + dy * Math.cos(a)));
        } else if (up("tail")) shoot(-dx, -dy);
        for (let i = 0; i < up("drone"); i++) shoot(dx, dy, [15, -15, 24][i] * hk);
        if (up("missile") && s.mcool <= 0) {
          s.mcool = [38, 38, 22, 14][up("missile")];
          for (const side of up("missile") >= 2 ? [-1, 1] : [s.t & 1 ? 1 : -1]) s.shots.push({ x: s.x, y: s.y + 8 * side, vx: s.face * 3 + s.vx, vy: side * 2.2, homing: true, life: 120, pierce: false, dmg: 4 });
          sound.play(sound.pick("laser_big", "shot3"), 0.9, 0.35, 0.7, "missile", 60);
        }
        sound.shot(superOn || up("laser") > 0, state.powerups.rapid > 0);
      }
      if ((gpState.bombHeld || keys.has("KeyB")) && state.bombCooldown <= 0) {
        state.bombCooldown = bombCooldown();
        s.bombs.push({ x: s.x + s.face * 10, y: s.y + 5, dir: s.face, vx: s.vx + s.face * 3, t: 0 });
        sound.play("shot4", 0.6, 0.27, 0.5);
      }
      if (novaPressed() && fireNova()) {
        for (const f of s.foes) {
          if (!f.dead && Math.abs(wrapD(f.x - s.cam) - VIEW_W / 2) < VIEW_W / 2 + 20) sideKill(s, f);
        }
        s.eshots = [];
        if (b) hurtBoss(b, 60);
      }
    }
    s.x = (((s.x + s.vx) % SIDE_W) + SIDE_W) % SIDE_W;
    s.turn += (s.face - s.turn) * 0.16; // how far round the jet has swung, -1..1
    s.lead += (s.face - s.lead) * 0.035; // the view eases across to give room ahead, rather than snapping over
    const camWant = s.x - VIEW_W * (0.5 - 0.2 * s.lead) + (b ? 0 : s.vx * 5);
    s.camV = wrapD(camWant - s.cam) * 0.07;
    s.cam = (((s.cam + s.camV) % SIDE_W) + SIDE_W) % SIDE_W;
    const sx = (x) => wrapD(x - s.cam); // world x -> screen x
    const onScreen = (x) => sx(x) > -16 && sx(x) < VIEW_W + 16;

    // more of them as the level number and your firepower climb
    if (!b && !s.warn) {
      const fliers = s.foes.reduce((n, f) => n + (f.ground ? 0 : 1), 0);
      if (--s.spawnT <= 0 && s.reserve > 0 && fliers < 5 + lvl * 0.5 + pw * 0.9) {
        s.reserve--;
        s.spawnT = Math.max(12, 64 - lvl * 2 - pw * 3.5);
        const r = Math.random();
        const side = Math.random() < 0.65 ? s.face : -s.face;
        s.foes.push(mkFoe(s, r < 0.55 ? "drone" : r < 0.82 ? "seeker" : "hover", s.x + side * (VIEW_W * 0.8 + Math.random() * 220)));
      }
      if (s.reserve <= 0 && s.foes.length === 0) {
        s.warn = 130;
        sound.play("hum2", 1.0, 0, 0.7);
      }
    } else if (s.warn > 0 && --s.warn === 0) {
      s.boss = makeBoss();
    }

    for (const f of s.foes) {
      f.t++;
      if (f.flash > 0) f.flash--;
      const dx = wrapD(s.x - f.x);
      const dy = s.y - f.y;
      const vis = onScreen(f.x);
      if (f.kind === "drone") {
        if (!f.vx || Math.abs(dx) > 700) f.vx = Math.sign(dx || 1) * f.spd;
        f.x += f.vx;
        f.y = f.y0 + Math.sin(f.t * 0.05 + f.ph) * f.amp;
        if (vis && --f.fire <= 0) {
          f.fire = Math.max(45, 120 - lvl * 4) + Math.random() * 40;
          efire(f.x, f.y, 2.2);
        }
      } else if (f.sea === "shark") {
        // it hunts just under the surface, fin showing, then leaps at you and falls back in
        const surf = seaLevel(s, f.x) + 6;
        if (!f.air) {
          f.y = surf;
          if (!f.vx) f.vx = Math.sign(dx || 1) * 2.2;
          if (Math.abs(dx) > 260) f.vx = Math.sign(dx) * 2.2;
          if (sideRock(s, f.x + f.vx * 6) < surf) f.vx = -f.vx; // an island in the way
          f.x += f.vx;
          if (f.wait > 0) f.wait--;
          else if (Math.abs(dx) < 120 && dy < -10) {
            f.air = true;
            f.vy = -Math.max(3, Math.min(8.5, Math.sqrt(2 * 0.16 * (surf - s.y + 14))));
            f.vx = Math.sign(dx || 1) * (1.6 + Math.abs(dx) / 60);
            sound.play("shot4", 0.5, 0.2, 1.6, "splash", 120);
          }
        } else {
          f.vy += 0.16;
          f.x += f.vx;
          f.y += f.vy;
          if (f.y >= surf && f.vy > 0) {
            f.air = false;
            f.wait = 55;
            burst(f.x, surf - 6, 0.5);
          }
        }
      } else if (f.kind === "seeker") {
        const top = 2.2 + lvl * 0.05;
        f.vx = Math.max(-top, Math.min(top, f.vx + Math.sign(dx) * 0.07));
        f.vy = Math.max(-top, Math.min(top, f.vy + Math.sign(dy) * 0.06));
        f.x += f.vx;
        f.y += f.vy;
      } else if (f.kind === "hover") {
        f.x += Math.max(-2.4, Math.min(2.4, wrapD(s.x + f.side * 150 - f.x) * 0.03));
        f.y += (f.y0 + Math.sin(f.t * 0.04 + f.ph) * 18 - f.y) * 0.05;
        if (vis && --f.fire <= 0) {
          f.fire = Math.max(60, 130 - lvl * 4);
          for (const sp of [-0.25, 0, 0.25]) efire(f.x, f.y, 2.3, sp);
        }
      } else if (f.kind === "turret") {
        f.y = ground(f.x) - 6;
        if (vis && --f.fire <= 0) {
          f.fire = Math.max(50, 115 - lvl * 4) + Math.random() * 30;
          efire(f.x, f.y - 4, 2.3);
        }
      } else {
        f.x += f.dir * 0.6;
        if (f.sea && sideRock(s, f.x + f.dir * 20) < seaLevel(s, f.x)) f.dir = -f.dir; // boats keep to the water
        if (Math.abs(wrapD(f.x - f.x0)) > 90) f.dir = -Math.sign(wrapD(f.x - f.x0));
        f.y = ground(f.x) - 9;
        if (vis && --f.fire <= 0) {
          f.fire = Math.max(55, 110 - lvl * 4) + Math.random() * 30;
          efire(f.x, f.y - 4, 2.4);
        }
      }
      f.x = ((f.x % SIDE_W) + SIDE_W) % SIDE_W;
      if (!f.ground && f.sea !== "shark") f.y = Math.max(20, Math.min(ground(f.x) - 12, f.y));
      if (p.alive && Math.abs(dx) < f.hw + 6 * hk && Math.abs(dy) < f.hh + 3 * hk) {
        sideHurtPlayer(s);
        if (f.hp <= 2) sideKill(s, f);
      }
    }

    // the boss, seen from the side: it holds the right of the screen
    if (b) {
      stepBoss(b, {
        W: VIEW_H,
        plat: s.y,
        pdepth: b.side < 0 ? sx(s.x) : VIEW_W - sx(s.x),
        fire: (lat, depth, vlat, vdepth) => s.eshots.push({ x: s.cam + (b.side < 0 ? depth : VIEW_W - depth), y: lat, vx: -vdepth * b.side + s.camV, vy: vlat, age: 0 }),
        minion: () => s.foes.push(mkFoe(s, Math.random() < 0.5 ? "seeker" : "drone", s.cam + (b.side < 0 ? -30 : VIEW_W + 30))),
        swap: true,
        lunge: VIEW_W * 0.3,
      });
      const bx = bossSX(b);
      if (b.dying && b.dying % 6 === 0) sideBoom(s, s.cam + bx + (Math.random() - 0.5) * 50, b.lat + (Math.random() - 0.5) * 100, 1.6);
      if (!b.dying && p.alive && Math.abs(sx(s.x) - bx) < BOSS_HALF_DEPTH + 6 && Math.abs(s.y - b.lat) < BOSS_HALF_LAT + 6) sideHurtPlayer(s);
    }

    for (const sh of s.shots) {
      if (sh.homing) {
        let tx = null;
        let ty = 0;
        let best = 1e9;
        for (const f of s.foes) {
          if (f.dead || !onScreen(f.x)) continue;
          const d = Math.hypot(wrapD(f.x - sh.x), f.y - sh.y);
          if (d < best) {
            best = d;
            tx = wrapD(f.x - sh.x);
            ty = f.y - sh.y;
          }
        }
        if (tx === null && b && !b.dying) {
          tx = bossSX(b) - sx(sh.x);
          ty = b.lat - sh.y;
        }
        let ang = Math.atan2(sh.vy, sh.vx);
        if (tx !== null) {
          const diff = Math.atan2(ty, tx) - ang;
          ang += Math.max(-0.2, Math.min(0.2, Math.atan2(Math.sin(diff), Math.cos(diff))));
        }
        const spd = Math.min(7, Math.hypot(sh.vx, sh.vy) + 0.25);
        sh.vx = Math.cos(ang) * spd;
        sh.vy = Math.sin(ang) * spd;
      }
      sh.x += sh.vx;
      sh.y += sh.vy;
      if (--sh.life <= 0 || sh.y < 0 || sh.y > ground(sh.x) || sx(sh.x) < -30 || sx(sh.x) > VIEW_W + 30) {
        sh.dead = true;
        continue;
      }
      for (const eb of s.eshots) {
        if (eb.dead || Math.abs(wrapD(eb.x - sh.x)) > 7 || Math.abs(eb.y - sh.y) > 6) continue;
        eb.dead = true;
        addScore(10);
        if (!sh.pierce) sh.dead = true;
        break;
      }
      if (sh.dead) continue;
      for (const f of s.foes) {
        if (f.dead || Math.abs(wrapD(f.x - sh.x)) > f.hw + 2 || Math.abs(f.y - sh.y) > f.hh + 2) continue;
        f.hp -= sh.dmg;
        f.flash = 4;
        if (!sh.pierce) sh.dead = true;
        if (f.hp <= 0) sideKill(s, f);
        else sound.play("bump", 0.45, 0, 1.2, "hit", 40);
        if (sh.dead) break;
      }
      if (!sh.dead && b && !b.dying && Math.abs(sx(sh.x) - bossSX(b)) < BOSS_HALF_DEPTH && Math.abs(sh.y - b.lat) < BOSS_HALF_LAT) {
        hurtBoss(b, sh.dmg);
        burst(sh.x, sh.y, 0.25);
        sh.dead = true;
      }
    }
    // the bomb button fires rockets here: straight out ahead, building speed, bursting on whatever they meet
    for (const bm of s.bombs) {
      bm.t++;
      bm.vx += bm.dir * 0.45;
      bm.x += bm.vx;
      let hit = bm.y >= ground(bm.x) - 2 || bm.t > 55 || Math.abs(sx(bm.x) - VIEW_W / 2) > VIEW_W / 2 + 40;
      for (const f of s.foes) if (!f.dead && Math.abs(wrapD(f.x - bm.x)) < f.hw + 3 && Math.abs(f.y - bm.y) < f.hh + 3) hit = true;
      if (b && !b.dying && Math.abs(sx(bm.x) - bossSX(b)) < BOSS_HALF_DEPTH && Math.abs(bm.y - b.lat) < BOSS_HALF_LAT) hit = true;
      if (hit) {
        bm.dead = true;
        sideBlast(s, bm.x, bm.y, BOMB_RADIUS + 10 * up("bomb"));
      }
    }
    for (const eb of s.eshots) {
      if (eb.dead) continue;
      eb.x += eb.vx;
      eb.y += eb.vy;
      eb.age++;
      if (eb.age > 260 || eb.y < -10 || eb.y > VIEW_H + 10 || Math.abs(sx(eb.x) - VIEW_W / 2) > VIEW_W) eb.dead = true;
      else if (p.alive && Math.abs(wrapD(eb.x - s.x)) < 7 * hk && Math.abs(eb.y - s.y) < 3.5 * hk) {
        eb.dead = true;
        sideHurtPlayer(s);
      }
    }
    for (const pk of s.picks) {
      pk.age++;
      if (pk.age > 900) pk.dead = true;
      else if (p.alive && Math.abs(wrapD(pk.x - s.x)) < 14 && Math.abs(pk.y - s.y) < 14) {
        pk.dead = true;
        addScore(250);
        sound.play("icon", 1.0, 0, 1.4);
        if (pk.kind === "rapid") state.powerups.rapid += RAPID_DROP_TICKS;
        else if (pk.kind === "nova") state.upgrades.nova = Math.min(NOVA_MAX, up("nova") + 1);
        else if (state.shields < maxShields()) state.shields++;
      }
    }
    for (const bo of s.booms) bo.frame += 0.5;
    s.foes = s.foes.filter((f) => !f.dead);
    s.shots = s.shots.filter((x) => !x.dead);
    s.eshots = s.eshots.filter((x) => !x.dead);
    s.bombs = s.bombs.filter((x) => !x.dead);
    s.picks = s.picks.filter((x) => !x.dead);
    s.booms = s.booms.filter((x) => x.frame < 24);
    stepSparks();
  }

  const hexA = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

  // Glow: the picture so far is shrunk and laid back over itself, twice, so everything bright bleeds light
  const bloomCv = [document.createElement("canvas"), document.createElement("canvas")];
  function bloom(strength, wholeCanvas = false) {
    const w = canvas.width;
    const h = wholeCanvas ? canvas.height : Math.round((VIEW_H / ZOOM) * RENDER_SCALE);
    bloomCv.forEach((c, i) => {
      const cw = Math.ceil(w / (i ? 14 : 4));
      const ch = Math.ceil(h / (i ? 14 : 4));
      if (c.width !== cw || c.height !== ch) {
        c.width = cw;
        c.height = ch;
      }
      const x = c.getContext("2d");
      x.imageSmoothingEnabled = true;
      x.globalCompositeOperation = "copy";
      if (i) x.drawImage(bloomCv[0], 0, 0, cw, ch);
      else x.drawImage(canvas, 0, 0, w, h, 0, 0, cw, ch);
    });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = strength;
    ctx.drawImage(bloomCv[0], 0, 0, w, h);
    ctx.globalAlpha = strength * 0.9;
    ctx.drawImage(bloomCv[1], 0, 0, w, h);
    ctx.restore();
    ctx.imageSmoothingEnabled = false;
  }

  // A sprite drawn flat (no ground perspective), turned to face the way it is flying
  function drawFlat(key, frameIdx, x, y, rot = 0, flash = false, zoom = 1) {
    const img = images[key];
    const fr = getFrame(key, frameIdx);
    if (!img || !fr) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(zoom, zoom);
    if (flash) ctx.filter = "brightness(2.2) contrast(1.4)";
    const hdImg = hdImages[key];
    if (hdImg) {
      const frames = HD.sprites[key].frames;
      const h = frames[((frameIdx % frames.length) + frames.length) % frames.length];
      const k = HD.scale;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(hdImg, h[0], h[1], h[2], h[3], -h[4] / k, -h[5] / k, h[2] / k, h[3] / k);
      ctx.imageSmoothingEnabled = false;
    } else {
      ctx.drawImage(img, fr.strip_x, fr.strip_y, fr.width, fr.height, -fr.hot_x, -fr.hot_y, fr.width, fr.height);
    }
    ctx.restore();
  }

  // demo = the title screen's backdrop: the same scene with no scanner or counters
  function renderSide(s = state.side, demo = false) {
    const th = s.theme;
    const T = state.frameTick;
    const p = state.player;
    const sx = (x) => wrapD(x - s.cam);
    const sky = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    sky.addColorStop(0, th.sky[0]);
    sky.addColorStop(0.6, th.sky[1]);
    sky.addColorStop(1, th.sky[2]);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    if (th.stars) {
      for (let i = 0; i < 90; i++) {
        const x = (((rnd(i, 1) * VIEW_W * 2 - s.cam * 0.05) % VIEW_W) + VIEW_W) % VIEW_W;
        ctx.fillStyle = `rgba(255,255,255,${0.3 + 0.6 * rnd(i, 3) * (0.7 + 0.3 * Math.sin(T * 0.1 + i))})`;
        ctx.fillRect(x, rnd(i, 2) * VIEW_H * 0.85, 1, 1);
      }
    }
    if (th.planet) {
      const g = ctx.createRadialGradient(VIEW_W / 2, VIEW_H + 560, 560, VIEW_W / 2, VIEW_H + 560, 640);
      g.addColorStop(0, "#0b3a6e");
      g.addColorStop(0.75, "#1d6fb8");
      g.addColorStop(0.93, "#7dd3fc");
      g.addColorStop(1, "rgba(125,211,252,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(VIEW_W / 2, VIEW_H + 560, 640, 0, Math.PI * 2);
      ctx.fill();
    }
    // a lit grid running away to the horizon gives the scene its depth
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 0.5;
    const hz = VIEW_H * 0.46;
    const gb = VIEW_H - 8;
    for (let i = 1; i <= 16; i++) {
      const t = ((i + ((T * 0.02) % 1)) / 16) ** 2;
      ctx.strokeStyle = hexA(th.rim, 0.05 + 0.3 * t);
      ctx.beginPath();
      ctx.moveTo(0, hz + (gb - hz) * t);
      ctx.lineTo(VIEW_W, hz + (gb - hz) * t);
      ctx.stroke();
    }
    const goff = (((s.cam * 0.5) % 44) + 44) % 44;
    ctx.strokeStyle = hexA(th.lamp[1], 0.2);
    for (let k = -30; k <= 30; k++) {
      const gx = k * 44 - goff;
      ctx.beginPath();
      ctx.moveTo(VIEW_W / 2 + gx * 0.22, hz);
      ctx.lineTo(VIEW_W / 2 + gx * 3.4, gb);
      ctx.stroke();
    }
    ctx.restore();
    // two layers of distant scenery, each sliding at its own speed
    for (const [par, col, gap, tall, seed] of [[0.25, th.farCol, 30, 1, 11], [0.5, th.midCol, 30, 0.7, 23]]) {
      const count = Math.round((SIDE_W * par) / gap);
      const off = (((s.cam * par) % (count * gap)) + count * gap) % (count * gap);
      const base = VIEW_H - 10 - th.amp * 0.6;
      // shaded from lit tops down into the dark, and edged with a fine bright line
      const fillG = ctx.createLinearGradient(0, base - 0.5 * VIEW_H, 0, base + 30);
      fillG.addColorStop(0, col);
      fillG.addColorStop(1, "#000000");
      ctx.fillStyle = fillG;
      ctx.strokeStyle = hexA(th.lamp[par < 0.4 ? 0 : 1], par < 0.4 ? 0.35 : 0.6);
      ctx.lineWidth = 0.5;
      for (let c = Math.floor(off / gap) - 1; c <= Math.floor((off + VIEW_W) / gap) + 1; c++) {
        const i = ((c % count) + count) % count;
        const x = c * gap - off;
        const r1 = rnd(i, seed);
        const r2 = rnd(i, seed + 1);
        const h = (24 + r1 * 0.5 * VIEW_H) * tall;
        if (th.far === "towers") {
          if (r2 < 0.75) {
            ctx.fillRect(x, base - h, gap * (0.5 + 0.4 * r2), h + 40);
            ctx.strokeRect(x, base - h, gap * (0.5 + 0.4 * r2), h + 40);
            ctx.fillStyle = th.lamp[i % 2];
            for (let w = 0; w < 4; w++) if (rnd(i * 7 + w, seed) > 0.5) ctx.fillRect(x + 3 + (w % 2) * 6, base - h + 6 + w * 9, 2, 2);
            ctx.fillStyle = fillG;
          }
        } else if (th.far === "peaks" || th.far === "cones") {
          const cone = th.far === "cones";
          ctx.beginPath();
          ctx.moveTo(x - gap * 1.2, base + 40);
          ctx.lineTo(x + gap * (cone ? 0.3 : 0.5), base - h);
          if (cone) ctx.lineTo(x + gap * 0.7, base - h);
          ctx.lineTo(x + gap * 2.2, base + 40);
          ctx.fill();
          ctx.stroke();
          if (cone && r2 > 0.6) {
            ctx.fillStyle = `rgba(251,146,60,${0.5 + 0.3 * Math.sin(T * 0.07 + i)})`;
            ctx.fillRect(x + gap * 0.3, base - h - 2, gap * 0.4, 3);
            ctx.fillStyle = fillG;
          }
        } else if (th.far === "spires") {
          ctx.beginPath();
          ctx.moveTo(x, base + 40);
          ctx.quadraticCurveTo(x + gap * 0.3, base - h * 0.4, x + gap * (0.3 + 0.5 * r2), base - h * 1.2);
          ctx.quadraticCurveTo(x + gap * 0.6, base - h * 0.3, x + gap * 0.9, base + 40);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillRect(x, base - h, 3, h + 40);
          ctx.fillRect(x, base - h * (0.4 + 0.5 * r2), gap, 2.5);
          if (r2 > 0.6) ctx.fillRect(x + 6, base - h * 0.4 - 14, gap * 0.6, 12);
          if (r2 < 0.2) {
            ctx.fillStyle = th.lamp[i % 2];
            ctx.fillRect(x, base - h - 2, 3, 2);
            ctx.fillStyle = fillG;
          }
        }
      }
    }
    // the ground you fly over, with a lit edge and lamps along it
    ctx.beginPath();
    ctx.moveTo(0, VIEW_H);
    for (let x = 0; x <= VIEW_W + 3; x += 3) ctx.lineTo(x, sideRock(s, s.cam + x));
    ctx.lineTo(VIEW_W, VIEW_H);
    ctx.closePath();
    ctx.fillStyle = th.ground;
    ctx.fill();
    if (th.sea) {
      // the sea itself: lit at the surface, dark below, with the islands standing in it
      const wg = ctx.createLinearGradient(0, VIEW_H * th.sea, 0, VIEW_H);
      wg.addColorStop(0, "rgba(34,150,220,0.75)");
      wg.addColorStop(0.25, "rgba(10,70,130,0.7)");
      wg.addColorStop(1, "rgba(2,16,40,0.85)");
      ctx.fillStyle = wg;
      ctx.beginPath();
      ctx.moveTo(0, VIEW_H);
      for (let x = 0; x <= VIEW_W + 3; x += 3) ctx.lineTo(x, seaLevel(s, s.cam + x));
      ctx.lineTo(VIEW_W, VIEW_H);
      ctx.fill();
    }
    ctx.beginPath();
    for (let x = 0; x <= VIEW_W + 3; x += 3) ctx.lineTo(x, sideGround(s, s.cam + x));
    ctx.strokeStyle = th.rim;
    ctx.lineWidth = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    for (let wx = Math.floor(s.cam / 60) * 60; wx < s.cam + VIEW_W + 60; wx += 60) {
      const i = Math.round((((wx % SIDE_W) + SIDE_W) % SIDE_W) / 60);
      if (rnd(i, 5) < 0.45) continue;
      ctx.fillStyle = th.lamp[i % 2];
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(T * 0.12 + i);
      ctx.fillRect(wx - s.cam - 1, sideGround(s, wx) + 3, 2, 2);
      ctx.globalAlpha = 1;
    }
    if (th.liquid && !th.sea) {
      ctx.fillStyle = th.liquid;
      ctx.beginPath();
      ctx.moveTo(0, VIEW_H);
      for (let x = 0; x <= VIEW_W + 6; x += 6) ctx.lineTo(x, VIEW_H - 15 + 1.5 * Math.sin((s.cam + x) * 0.05 + T * 0.08));
      ctx.lineTo(VIEW_W, VIEW_H);
      ctx.fill();
    }

    for (const f of s.foes) {
      const x = sx(f.x);
      if (x < -30 || x > VIEW_W + 30) continue;
      const rot = f.ground ? 0 : f.kind === "seeker" ? 0 : (f.vx || wrapD(s.x - f.x)) > 0 ? -Math.PI / 2 : Math.PI / 2;
      const fr = f.kind === "seeker" || f.kind === "walker" ? (f.t >> 2) : f.kind === "turret" ? Math.max(0, Math.min(4, Math.round(wrapD(s.x - f.x) / 60 + 2))) : 0;
      if (f.sea) drawSea(f.sea, x, f.y, T + f.ph * 10, f.flash > 0, true, f.kind === "walker" ? f.dir : (f.vx || wrapD(s.x - f.x)) > 0 ? 1 : -1, Boolean(f.air), f.air ? Math.atan2(f.vy, Math.abs(f.vx)) : 0);
      else drawFlat(f.key, fr, x, f.y, rot, f.flash > 0);
      if (f.elite) drawEliteMark(x, f.y, 1, f.hp, f.maxHp, T + f.ph * 10);
    }
    for (const pk of s.picks) {
      const x = sx(pk.x);
      const pulse = 1 + 0.15 * Math.sin(pk.age * 0.25);
      ctx.fillStyle = pk.kind === "nova" ? "#f0abfc" : pk.kind === "rapid" ? "#38bdf8" : "#22d3ee";
      ctx.beginPath();
      ctx.arc(x, pk.y, 6 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#020617";
      ctx.font = "bold 8px monospace";
      ctx.textBaseline = "top";
      ctx.fillText(pk.kind === "nova" ? "N" : pk.kind === "rapid" ? "R" : "S", x - 2.5, pk.y - 4);
    }
    for (const sh of s.shots) {
      ctx.save();
      ctx.translate(sx(sh.x), sh.y);
      ctx.rotate(Math.atan2(sh.vy, sh.vx - s.vx * (sh.homing ? 0 : 1)));
      ctx.fillStyle = sh.homing ? "#e2e8f0" : state.powerups.superShot > 0 ? "#ff6600" : laserColor();
      ctx.fillRect(-5, -1, 9, 2);
      ctx.restore();
    }
    for (const bm of s.bombs) {
      const rx = sx(bm.x);
      ctx.fillStyle = `rgba(251,146,60,${0.6 + 0.3 * Math.sin(bm.t)})`;
      ctx.fillRect(rx - bm.dir * 13, bm.y - 1, bm.dir * 8, 2);
      ctx.fillStyle = "#e2e8f0";
      ctx.fillRect(rx - bm.dir * 5, bm.y - 1.5, bm.dir * 9, 3);
      ctx.fillStyle = "#ef4444";
      ctx.fillRect(rx + bm.dir * 4, bm.y - 1.5, bm.dir * 3, 3);
    }
    for (const eb of s.eshots) drawFlat("shot", (eb.age >> 1) & 3, sx(eb.x), eb.y);
    if (s.boss) drawBoss(s.boss, bossSX(s.boss), s.boss.lat, 1, s.boss.side < 0 ? -Math.PI / 2 : Math.PI / 2);
    if (demo || (p.alive && !(p.invuln > 0 && ((T >> 1) & 1)))) {
      const tn = s.turn === undefined ? s.face : s.turn;
      drawJetSideways(sx(s.x), s.y, Math.abs(tn) < 0.18 ? (tn < 0 ? -0.18 : 0.18) : tn, Math.max(-0.35, Math.min(0.35, (s.vy || 0) * 0.07)));
      if (state.shieldFlash > 0) {
        ctx.strokeStyle = `rgba(34, 211, 238, ${Math.min(1, state.shieldFlash / 12)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx(s.x), s.y, 17 + (24 - state.shieldFlash) * 0.25, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    for (const bo of s.booms) drawFlat("explosion", Math.floor(bo.frame), sx(bo.x), bo.y, 0, false, bo.size);
    drawSparks((x, y) => ({ x: sx(x), y, s: 1 }));
    bloom(0.34, demo);
    if (demo) return;

    // scanner: the whole wrap-around world, with what is in it
    const rw = 150;
    const rx = (VIEW_W - rw) / 2;
    ctx.fillStyle = "rgba(2,6,23,0.7)";
    ctx.fillRect(rx, 4, rw, 12);
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 1;
    ctx.strokeRect(rx + 0.5, 4.5, rw - 1, 11);
    const dot = (x, y, col) => {
      ctx.fillStyle = col;
      ctx.fillRect(rx + rw / 2 + (wrapD(x - s.x) / SIDE_W) * rw - 0.5, 5 + (y / VIEW_H) * 10, 1.5, 1.5);
    };
    for (const f of s.foes) dot(f.x, f.y, f.ground ? "#fb923c" : "#f87171");
    for (const pk of s.picks) dot(pk.x, pk.y, "#f0abfc");
    dot(s.x, s.y, "#ffffff");
    ctx.font = "bold 8px monospace";
    ctx.textBaseline = "top";
    ctx.textAlign = "right";
    ctx.fillStyle = "#e2e8f0";
    if (!s.boss) ctx.fillText(`${s.foes.length + s.reserve} TARGETS LEFT`, VIEW_W - 6, 6);
    ctx.textAlign = "left";
    if (s.boss && !s.boss.gone) drawBossBar(s.boss, 20);
    if (s.warn > 0 && ((T >> 3) & 1)) {
      ctx.textAlign = "center";
      ctx.font = "bold 12px monospace";
      ctx.fillStyle = "#f87171";
      ctx.fillText("WARNING // SOMETHING BIG INBOUND", VIEW_W / 2, VIEW_H / 2 - 30);
      ctx.textAlign = "left";
    }
  }

  // --- Title screen: a live scene from the game instead of a picture. It flies the jet through each side-on
  // world in turn, guns going, with that world's boss in view. ---
  const SUBTITLE = "BLACK MARKET SKIES";
  const DEMO_LEN = 520; // ticks per world
  let demo = null;
  function stepDemo() {
    if (!demo) demo = { n: 0, s: null };
    if (!demo.s || demo.s.t >= DEMO_LEN || demo.viewH !== VIEW_H) {
      const key = [8, 12, 10, 2, 6, 4][demo.n++ % 6];
      const s = {
        lvl: key, theme: SIDE_THEMES[key], phase: key * 1.37, x: 300, y: VIEW_H / 2, vx: 2.4, face: 1, cam: 0, camV: 0, t: 0,
        foes: [], shots: [], eshots: [], bombs: [], picks: [], booms: [], kills: 0, quota: 1, warn: 0,
        boss: { lvl: key, look: BOSSES[key], hp: 1, max: 1, t: 0, lat: VIEW_H / 2, depth: 62, flash: 0, dying: 0, gone: false, pods: [[-40, 2], [40, 2]] },
      };
      for (let i = 0; i < 5; i++) {
        const f = mkFoe(s, i % 3 === 2 ? "hover" : "drone", 0);
        f.y0 = VIEW_H * (0.5 + 0.3 * Math.random());
        f.ox = (130 + i * 38 + Math.random() * 30) * (VIEW_W / BASE_W);
        f.vx = -1;
        s.foes.push(f);
      }
      demo.s = s;
      demo.viewH = VIEW_H;
      state.sparks = [];
    }
    const s = demo.s;
    s.t++;
    s.x = (s.x + 2.4) % SIDE_W;
    s.cam = (s.x - VIEW_W * 0.24 + SIDE_W) % SIDE_W;
    s.y = VIEW_H * 0.66 + Math.sin(s.t * 0.03) * VIEW_H * 0.13; // everything keeps below the name
    const b = s.boss;
    b.lat = VIEW_H * 0.68 + Math.sin(s.t * 0.021) * VIEW_H * 0.1;
    if (b.flash > 0) b.flash--;
    for (const f of s.foes) {
      f.t++;
      f.x = (s.x + f.ox + Math.sin(s.t * 0.02 + f.ph) * 30 + SIDE_W) % SIDE_W;
      f.y = Math.min(sideGround(s, f.x) - 14, f.y0 + Math.sin(s.t * 0.05 + f.ph) * 18);
    }
    if (s.t % 5 === 0) s.shots.push({ x: s.x + 14, y: s.y + (s.t % 10 ? 3 : -3), vx: SHOT_SPEED + 2.4, vy: 0, life: 44 });
    for (const sh of s.shots) {
      sh.x += sh.vx;
      sh.life--;
      for (const f of s.foes) {
        if (Math.abs(wrapD(f.x - sh.x)) > 10 || Math.abs(f.y - sh.y) > 10) continue;
        s.booms.push({ x: f.x, y: f.y, frame: 4, size: 1 });
        burst(f.x, f.y, 1, 10);
        f.ox = (250 + Math.random() * 90) * (VIEW_W / BASE_W);
        f.y0 = VIEW_H * (0.5 + 0.3 * Math.random());
        sh.life = 0;
        break;
      }
      if (sh.life > 0 && wrapD(sh.x - s.cam) > VIEW_W - b.depth - 22 && Math.abs(sh.y - b.lat) < BOSS_HALF_LAT) {
        if (Math.random() < 0.25) b.flash = 2;
        burst(sh.x, sh.y, 0.3, 10);
        sh.life = 0;
      }
    }
    for (const bo of s.booms) bo.frame += 0.5;
    s.shots = s.shots.filter((sh) => sh.life > 0);
    s.booms = s.booms.filter((bo) => bo.frame < 24);
    stepSparks();
  }

  function drawDemo(dim) {
    if (!demo || !demo.s) stepDemo();
    const s = demo.s;
    renderSide(s, true);
    ctx.fillStyle = s.theme.ground;
    ctx.fillRect(0, VIEW_H, VIEW_W, HUD_H * ZOOM);
    const fade = s.t < 25 ? 1 - s.t / 25 : s.t > DEMO_LEN - 25 ? (s.t - (DEMO_LEN - 25)) / 25 : 0;
    ctx.fillStyle = `rgba(2,4,10,${Math.max(dim, fade)})`;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H + HUD_H * ZOOM);
  }

  function renderTitle() {
    drawDemo(0);
    // the name and prompts keep their size on screen; only the scene behind is at game scale
    ctx.save();
    ctx.scale(ZOOM, ZOOM);
    const total = (VIEW_H + HUD_H * ZOOM) / ZOOM;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.translate(BASE_W / 2, total * 0.2);
    ctx.transform(1, 0, -0.18, 1, 0, 0);
    ctx.font = "italic 900 46px 'Arial Black', Impact, sans-serif";
    const k = Math.min(1, 350 / ctx.measureText("SIDEWINDER").width);
    ctx.scale(k, k);
    ctx.lineJoin = "round";
    ctx.shadowColor = "#e11d8f";
    ctx.shadowBlur = 30 + 10 * Math.sin(state.frameTick * 0.08);
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#e11d8f";
    ctx.strokeText("SIDEWINDER", 0, 0);
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#1e1b4b";
    const g = ctx.createLinearGradient(0, -20, 0, 20);
    g.addColorStop(0, "#f0abfc");
    g.addColorStop(0.48, "#ffffff");
    g.addColorStop(0.52, "#a5f3fc");
    g.addColorStop(1, "#0891b2");
    ctx.fillStyle = g;
    ctx.fillText("SIDEWINDER", 0, 0);
    ctx.strokeText("SIDEWINDER", 0, 0);
    ctx.restore();

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const sy = total * 0.2 + 30;
    ctx.font = "bold 12px monospace";
    const sub = SUBTITLE.split("").join(" ");
    const sw = ctx.measureText(sub).width;
    ctx.fillStyle = "rgba(2,4,10,0.55)";
    ctx.fillRect(BASE_W / 2 - sw / 2 - 26, sy - 3, sw + 52, 17);
    ctx.fillStyle = "#fbbf24";
    ctx.fillText(sub, BASE_W / 2, sy);
    ctx.fillRect(BASE_W / 2 - sw / 2 - 22, sy + 5, 14, 1);
    ctx.fillRect(BASE_W / 2 + sw / 2 + 8, sy + 5, 14, 1);
    ctx.font = "bold 8px monospace";
    ctx.fillStyle = "rgba(2,4,10,0.55)";
    ctx.fillRect(0, total - 66, BASE_W, 34);
    if (((state.frameTick >> 4) & 1) === 0) {
      ctx.fillStyle = "#fbbf24";
      ctx.font = "bold 10px monospace";
      ctx.fillText("PRESS SPACE / ENTER TO LAUNCH", BASE_W / 2, total - 60);
    }
    if (!document.fullscreenElement) {
      ctx.fillStyle = "#22d3ee";
      ctx.font = "bold 9px monospace";
      ctx.fillText("PRESS  F  FOR FULL SCREEN", BASE_W / 2, total - 46);
    }
    ctx.textAlign = "left";    ctx.restore();
  }

  // --- Elites: some enemies are a real fight. They glow, show a health bar, take several times the hits, always
  // shoot back, and pay three times the score. There are more of them the further you get. ---
  const eliteChance = () => Math.min(0.3, 0.06 + 0.015 * shownLevel());
  function promote(ent, force = false) {
    if (!ent.aniKey || ent.isIcon || ent.sea || (ent.flagsHi & 0x10) !== 0 || ent.hp >= 100) return ent;
    if (!force && rnd(ent.id * 1.7 + ent.y, 53 + shownLevel()) >= eliteChance()) return ent;
    ent.elite = true;
    ent.hp = ent.hp * 3 + 2;
    ent.maxHp = ent.hp;
    ent.scoreVal *= 3;
    ent.flagsLo |= 0x40;
    return ent;
  }
  function drawEliteMark(x, y, sc, hp, maxHp, T) {
    ctx.strokeStyle = `rgba(240,171,252,${0.55 + 0.35 * Math.sin(T * 0.25)})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(x, y, (13 + Math.sin(T * 0.2)) * sc, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x - 8 * sc, y - 17 * sc, 16 * sc, 2);
    ctx.fillStyle = "#f0abfc";
    ctx.fillRect(x - 8 * sc, y - 17 * sc, 16 * sc * Math.max(0, hp / maxHp), 2);
  }

  // --- Formation stage: at the end of each top-down level the scroll stops and the camera drops to the horizon
  // view: land running away to the horizon, open sky above it. A squadron flies in and forms up in ranks in that
  // sky, a wall of ships with the boss waiting behind it. They hold formation, swaying, and peel off in ones and
  // twos to dive at you. Shoot the wall away and the boss comes through it; beat the boss and the camera lifts
  // back to the usual view and you fly on. ---
  function startWave() {
    const pool = state.flyerPool;
    state.waveDone = true;
    if (!pool || !pool.length) return;
    const lvl = shownLevel();
    const cols = Math.min(10, 6 + (lvl >> 1));
    const rows = Math.min(5, 3 + (lvl >> 2));
    const viewTop = state.scrollY - VIEW_H;
    const camX = Math.max(0, Math.min(WORLD_W - VIEW_W, state.player.x - VIEW_W / 2));
    const kinds = [...new Map(pool.map((r) => [(r.ani_name || "").toLowerCase(), r])).values()]; // one of each kind this level has
    const w = { t: 0, phase: "in", camX, cx: camX + VIEW_W / 2, top: viewTop, ents: [], diveT: 120, total: 0, flat: 0 };
    for (let r = 0; r < rows; r++) {
      const rec = kinds[(r + lvl) % kinds.length]; // each rank is one kind of flyer
      for (let c = 0; c < cols; c++) {
        const ent = makeEntity({ ...rec, x: w.cx, y: viewTop - 40, path_ops: null, ai_fn: null, death_fn: null, rubble_frame: -1, mir: false, index: 300000 + r * 100 + c });
        ent.pathOps = null;
        ent.flagsLo &= ~0x40;
        ent.rubbleFrame = -1;
        if (r === 0) promote(ent, true); // the front rank are elites
        ent.form = { sx: (c - (cols - 1) / 2) * 34, sy: 34 + r * 26, delay: (r * cols + c) * 4, from: c % 2 ? 1 : -1, dive: null };
        w.ents.push(ent);
        state.entities.push(ent);
      }
    }
    w.total = w.ents.length;
    state.wave = w;
    state.boss = makeBoss();
    state.boss.lurk = 34 + ((rows - 1) * 26) / 2; // how deep into the screen it waits: the middle of the ranks
    state.boss.depth = -80;
    state.popups.push({ x: state.player.x - 30, y: state.player.y - 40, text: "FORMATION INBOUND", ttl: 90 });
    sound.play(sound.pick("spin_b", "hum2"), 0.9, 0, 0.7);
  }

  function stepWave(frozen) {
    const w = state.wave;
    const p = state.player;
    w.t++;
    w.ents = w.ents.filter((e) => e.alive);
    if (w.phase === "out") {
      // the camera tips forward again and the level moves on
      w.flat = Math.max(0, w.flat - 0.03);
      setTilt(1 - w.flat);
      if (w.flat <= 0) state.wave = null;
      return;
    }
    w.flat = Math.min(1, w.flat + 0.02);
    setTilt(1 - w.flat);
    if (w.phase === "boss") {
      // the horizon view holds for the boss fight
      if (!state.boss || state.boss.gone) w.phase = "out";
      return;
    }
    if (!w.ents.length) {
      const bonus = Math.round(15 * w.total * lean());
      state.credits += bonus;
      addScore(100 * w.total);
      state.popups.push({ x: p.x - 36, y: p.y - 30, text: `FORMATION CLEARED +${bonus} CR`, ttl: 110 });
      sound.play(sound.pick("bonus_b", "icon"), 0.9, 0, 1.2);
      if (state.boss && state.boss.lurk) {
        state.boss.lurk = 0;
        state.boss.t = 0;
        w.phase = "boss";
      } else w.phase = "out";
      return;
    }
    if (frozen) return;
    const lvl = shownLevel();
    const sway = Math.sin(w.t * 0.025) * Math.min(60, VIEW_W * 0.12);
    // now and then one or two peel off and dive
    if (--w.diveT <= 0 && w.t > 150) {
      w.diveT = Math.max(40, 130 - lvl * 5);
      const ready = w.ents.filter((e) => !e.form.dive && w.t > e.form.delay + 70);
      for (let n = 0; n < (lvl >= 6 ? 2 : 1) && ready.length; n++) {
        const e = ready.splice((Math.random() * ready.length) | 0, 1)[0];
        e.form.dive = { t: 0, x0: e.x, y0: e.y, tx: p.x, side: Math.random() < 0.5 ? 1 : -1 };
      }
    }
    for (const e of w.ents) {
      const f = e.form;
      const hx = w.cx + f.sx + sway; // its place in the ranks
      const hy = w.top + f.sy;
      const k = Math.min(1, Math.max(0, (w.t - f.delay) / 70));
      if (f.dive) {
        // a swooping loop down past you and off the bottom, then back in over the top to its place
        const d = f.dive;
        d.t++;
        const q = d.t / 150;
        if (q < 1) {
          e.x = d.x0 + (d.tx - d.x0) * q + Math.sin(q * Math.PI * 2) * 70 * d.side;
          e.y = d.y0 + (w.top + VIEW_H + 50 - d.y0) * q * q; // just off the bottom, not far enough to be lost
          if (state.player.alive && (d.t === 40 || d.t === 70 || (e.elite && d.t === 55))) fireEnemyBullet(e.x, e.y, 2.6, 0, e);
        } else {
          const b = Math.min(1, (d.t - 150) / 50);
          e.x = hx;
          e.y = w.top - 40 + (hy - (w.top - 40)) * b;
          if (b >= 1) f.dive = null;
        }
      } else if (k < 1) {
        // flying in: a wide curve from its side of the screen to its place
        const ease = k * k * (3 - 2 * k);
        e.x = hx + f.from * (VIEW_W * 0.6) * (1 - ease) * Math.cos(k * Math.PI * 0.5);
        e.y = hy - 60 * (1 - ease) + Math.sin(k * Math.PI) * 50;
      } else {
        e.x = hx;
        e.y = hy + Math.sin(w.t * 0.06 + f.sx) * 2;
        // ranks in place take the odd shot of their own on the later levels
        if (lvl >= 4 && state.player.alive && Math.random() < 0.0009 * lvl) fireEnemyBullet(e.x, e.y, 2.2, 0, e);
      }
      if ((state.frameTick & 3) === 0) e.frame++;
    }
  }

  // --- Entity Spawning & Management ---
  function startNewGame(startLevel = state.selectedLevel) {
    state.swap = null;
    sound.ui("start");
    state.runStart = performance.now();
    track("game_start", { level: startLevel, difficulty: state.difficulty, trainer: state.trainer ? 1 : 0 });
    state.score = 0;
    state.nextExtraLifeScore = 100000;
    state.lives = 3;
    state.credits = 0;
    state.upgrades = { nova: 1 };
    state.shields = maxShields();
    state.kills = 0;
    state.dropFill = { nova: 0, shield: 0, rapid: 0 };
    // levels 7 to 18 are the second time round; a generated world has to be fetched before it can start
    const loop = startLevel > 6 ? 1 : 0;
    const lvl = startLevel > 6 ? startLevel - 6 : startLevel;
    state.loopCount = loop;
    state.level = lvl;
    ui.levelSelect.value = String(startLevel);
    const world = worldFor(lvl, loop);
    if (world && !(world in wideLevels)) {
      state.screen = "loading";
      loadWide(world).then(() => beginLevel(lvl));
      return;
    }
    beginLevel(lvl);
  }

  // Where the camera wants to be: centred on the jet, stopping at the edges of the world
  function cameraTargetX() {
    return Math.max(0, Math.min(WORLD_W - VIEW_W, state.player.x - VIEW_W / 2));
  }

  // A level object record placed in one of the lanes. Outer lanes are mirrored: positions, patrol limits and
  // flight paths flip left to right, and the sprite is drawn flipped.
  function laneRecord(rec, lane) {
    const mir = laneMirrored(lane);
    const ox = lane * MAP_W - WIDE_OFF;
    const tx = (x) => (mir ? ox + MAP_W - x : ox + x);
    const r = { ...rec, mir, index: rec.index + lane * 10000 };
    const isBox = !aniKey(rec.ani_name);
    r.x = isBox && mir ? tx(rec.x) - (rec.hitbox_w || 16) : tx(rec.x);
    const ai = rec.ai_fn || "";
    const death = rec.death_fn || "";
    if (ai.endsWith("_patrol_x")) {
      r.param_2a = tx(rec.param_2a);
      r.param_2c = tx(rec.param_2c);
    } else {
      if (ai.endsWith("_bolt_l") || ai.endsWith("_bolt_r")) r.param_2a = tx(rec.param_2a);
      if (ai.includes("_bolt_") || death.includes("_kill_pair_")) r.param_2c = rec.param_2c + lane * 100000; // pair ids stay per lane
    }
    if (mir && rec.path_ops && rec.path_ops.length) {
      r.path_ops = rec.path_ops.map((op) => (op.op === "step" ? { ...op, dx: -op.dx } : op));
    }
    return r;
  }

  // Second-loop levels (7 to 12) are big, so each sits in its own file (levels2/levelN.js next to game.js) and is
  // fetched when the player gets there. Only one is held at a time. null = there is no such level.
  const wideLevels = {};
  const wideLoading = {};
  function loadWide(n) {
    if (n in wideLevels) return Promise.resolve(wideLevels[n]);
    if (!wideLoading[n]) {
      wideLoading[n] = new Promise((resolve) => {
        const tag = document.createElement("script");
        tag.src = `${SCRIPT_DIR}levels2/level${n}.js`;
        tag.onerror = () => resolve(null);
        tag.onload = () => {
          const d = (window.SIDEWINDER_LEVELS2 || {})[`level${n}`];
          tag.remove();
          if (!d) return resolve(null);
          delete window.SIDEWINDER_LEVELS2[`level${n}`];
          Promise.all([...d.maps, d.aux].map(loadImage)).then(
            (imgs) => resolve({ maps: imgs.slice(0, 3), aux: imgs[3], records: d.records }),
            () => resolve(null));
        };
        document.head.appendChild(tag);
      }).then((w) => {
        for (const k of Object.keys(wideLevels)) delete wideLevels[k];
        wideLevels[n] = w;
        delete wideLoading[n];
        return w;
      });
    }
    return wideLoading[n];
  }

  function beginLevel(lvl) {
    state.level = lvl;
    state.dive = null;
    state.wave = null;
    state.waveDone = false;
    setTilt(1);
    applyZoom(true);
    track("level_start", { level: shownLevel(), score: state.score });
    state.side = null;
    state.boss = null;
    state.sparks = [];
    state.novaFlash = 0;
    state.reinfT = 300;
    const base = baseLevel(lvl);
    ui.levelSelect.value = String(shownLevel() <= 18 ? shownLevel() : base);
    // Second time round, a level with new terrain (7 to 12, built by hd_sprites/build_planet.py) replaces the
    // original. Those are one continuous world: three lane-wide pictures, nothing mirrored, objects placed in world x.
    const second = worldFor(lvl, state.loopCount);
    const L2 = second ? wideLevels[second] : null;
    const wide = Boolean(L2);
    state.wideMaps = wide ? L2.maps : null;
    if (!wide) renderLevelMap(base);
    fxBeginLevel(wide ? second : base, wide ? L2.aux : null);
    state.seaMask = null;
    if (wide && second === 8) {
      // read where the water is from the map's height data, so sea life only appears in the sea
      const mc = document.createElement("canvas");
      mc.width = 156;
      mc.height = 456;
      const mx = mc.getContext("2d", { willReadFrequently: true });
      mx.drawImage(L2.aux, 0, 0, mc.width, mc.height);
      state.seaMask = { w: mc.width, h: mc.height, d: mx.getImageData(0, 0, mc.width, mc.height).data };
      state.seaT = 120;
    }
    state.spawnQueue = [];
    if (wide) {
      for (const r of L2.records) {
        const x = r.x - WIDE_OFF;
        if (x < 16 || x > WORLD_W - 16) continue; // outside the part of the world the game uses
        const sweep = (r.ai_fn || "").endsWith("_patrol_x");
        state.spawnQueue.push({ ...r, x, mir: false, param_2a: sweep ? Math.max(20, r.param_2a - WIDE_OFF) : r.param_2a, param_2c: sweep ? Math.min(WORLD_W - 20, r.param_2c - WIDE_OFF) : r.param_2c });
      }
    } else {
      const lvlData = A.objects[`level${base}`];
      for (let lane = 0; lane < LANES; lane++) {
        for (const r of lvlData.records) {
          const lr = laneRecord(r, lane);
          const ai = r.ai_fn || "";
          if (aniKey(r.ani_name)) {
            if (lr.x < 8 || lr.x > WORLD_W - 8) continue; // in the part of an outer lane that is trimmed off
            if (WIDE_OFF > 0 && lane !== 1 && (ai.includes("_bolt_") || ai.includes("_tower_"))) continue; // barrier pairs would be cut in half out there
          } else if (lr.x + (r.hitbox_w || 16) <= 0 || lr.x >= WORLD_W) continue;
          state.spawnQueue.push(lr);
        }
      }
    }
    state.spawnQueue.sort((a, b) => b.y - a.y || a.index - b.index);
    state.flyerPool = state.spawnQueue.filter((r) => r.path_ops && r.path_ops.length && /^(enemy|spinner|hover)/i.test(r.ani_name || ""));
    state.spawnCursor = 0;
    state.entities = [];
    state.playerBullets = [];
    state.bombs = [];
    state.pickups = [];
    state.dealerDone = false;
    state.cave = { x: 0, y: END_SCROLL_Y + (START_SCROLL_Y - END_SCROLL_Y) * (1 - BONUS_AT) - VIEW_H, placed: false, taken: false };
    state.rubble = [];
    state.bombCooldown = 0;
    state.shieldFlash = 0;
    state.enemyBullets = [];
    state.explosions = [];
    state.popups = [];
    state.destroyedPairIds.clear();

    state.scrollY = START_SCROLL_Y;
    state.player.x = WORLD_W / 2; // the middle of the board: the unmirrored lane's runway on the original levels
    state.player.y = state.scrollY - 46;
    state.player.bank = 0;
    state.player.cooldown = 0;
    state.player.invuln = 110;
    state.player.respawnTimer = 0;
    state.player.alive = true;
    state.scrollX = cameraTargetX();

    state.powerups.rapid = 0;
    state.powerups.freeze = 0;
    state.powerups.shield = 0;
    state.powerups.superShot = 0;
    state.paused = false;
    ui.pauseBtn.textContent = "Pause";
    state.screen = "playing";
    sound.play("fighter", 0.7);
    if (shownLevel() % 2 === 0) startSide(); // every other level is flown side-on
  }

  function makeEntity(rec) {
    const key = aniKey(rec.ani_name);
    const fr = getFrame(key, rec.frame);
    const isIcon = key === "icons";
    let w = rec.hitbox_w || (fr ? fr.width : 16);
    let h = rec.hitbox_h || (fr ? fr.height : 16);
    // Scale HP slightly with difficulty 1..5 on multi-HP targets
    let hp = rec.hp;
    if ((rec.flags_hi & 0x10) === 0 && !isIcon && hp > 1 && hp < 100) {
      hp = Math.max(1, hp + Math.floor((state.difficulty - 3) / 2));
    }
    if (key && !isIcon && (rec.flags_hi & 0x10) === 0 && hp < 100) hp += toughness(rec.index * 7.13 + rec.y);
    return {
      rec,
      id: rec.index,
      mir: Boolean(rec.mir),
      aniKey: key,
      x: rec.x,
      y: rec.y,
      w,
      h,
      frame: rec.frame || 0,
      flagsHi: rec.flags_hi,
      flagsLo: rec.flags_lo,
      aiFn: rec.ai_fn || null,
      deathFn: rec.death_fn || null,
      hp,
      maxHp: hp,
      flash: 0,
      scoreVal: bcdToInt(rec.score_bcd),
      rubbleDx: rec.rubble_dx,
      rubbleDy: rec.rubble_dy,
      rubbleFrame: rec.rubble_frame,
      soundFlags: rec.sound_flags,
      // Path VM state
      pathOps: rec.path_ops && rec.path_ops.length ? rec.path_ops : null,
      pc: 0,
      loopCnt: rec.param_26 || 0,
      delay: rec.delay_28 || 0,
      param2a: rec.param_2a,
      param2c: rec.param_2c,
      aiDir: 1,
      aiTimer: 20 + (rec.index % 35),
      doorOpen: 0,
      isIcon,
      staticWall: key === null && (rec.flags_hi & 0x10) !== 0 && rec.hp >= 100,
      staticTarget: key === null && !(rec.flags_hi & 0x10),
      alive: true,
    };
  }

  function spawnDueEntities() {
    const viewTop = state.scrollY - VIEW_H;
    const threshold = viewTop - 48;
    while (state.spawnCursor < state.spawnQueue.length) {
      const rec = state.spawnQueue[state.spawnCursor];
      // Launch/finish static boundary boxes (h=210) or pathed/aerial units check y against threshold
      const h = rec.hitbox_h || 20;
      const triggerY = rec.path_ops && rec.path_ops.length ? rec.y : rec.y + h;
      if (triggerY < threshold) break;
      state.spawnCursor++;
      const ent = promote(makeEntity(rec));
      // after level one some of the pick-ups placed in the level are left out (always the same ones)
      if (ent.isIcon && rnd(rec.index, 31) >= scarce()) continue;
      // In loopCount >= 1, entities with flags_hi & 1 also fire (fn_00010408 line 378)
      if (state.loopCount > 0 && (ent.flagsHi & 1)) {
        ent.flagsLo |= 0x40;
      }
      state.entities.push(ent);
    }
  }

  function stepPathVM(ent) {
    const ops = ent.pathOps;
    if (!ops || ent.pc >= ops.length) return;
    let safety = 0;
    while (ent.pc < ops.length && safety < 8) {
      safety++;
      const op = ops[ent.pc];
      if (op.op === "end") {
        ent.alive = false;
        return;
      }
      if (op.op === "loop") {
        if (ent.loopCnt <= 0) ent.loopCnt = op.count;
        ent.loopCnt--;
        if (ent.loopCnt > 0) {
          ent.pc = Math.max(0, ent.pc - op.rewind);
          // Executed rewind — next frame will run target step
          continue;
        }
        // Loop finished: fall through to next instruction!
        ent.pc++;
        continue;
      }
      if (op.op === "step") {
        ent.frame = op.frame;
        if (op.alt) ent.flagsLo |= 0x10;
        else ent.flagsLo &= ~0x10;
        ent.x += op.dx;
        ent.y += op.dy;
        ent.pc++;
        return;
      }
      ent.pc++;
    }
  }

  function fireEnemyBullet(ex, ey, speed = 2.6, spreadAngle = 0, ent = null) {
    // Only what is on screen shoots: nothing fires in from the lanes you cannot see
    if (Math.abs(ex - (state.scrollX + VIEW_W / 2)) > VIEW_W / 2 + 24) return;
    const fv = (ent && VOICES[ent.aniKey] && VOICES[ent.aniKey].fire) || ["shot5", 1.0];
    // enemy guns use the recorded lasers pitched well down, each kind at its own pitch
    state.efireN = ((state.efireN || 0) + 1) % 3;
    sound.play(sound.pick("laser_short_" + "abc"[state.efireN], fv[0]), 0.2, 0.22, 0.45 + 0.25 * fv[1], "fire:" + fv[0] + fv[1], 35);
    const px = state.player.x;
    const py = state.player.y;
    const ang = Math.atan2(py - ey, px - ex) + spreadAngle;
    const diffBoost = 1 + (state.difficulty - 3) * 0.14;
    const spd = speed * diffBoost;
    state.enemyBullets.push({
      x: ex,
      y: ey,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd,
      frame: 0,
      age: 0,
    });
  }

  function stepAI(ent) {
    const ai = ent.aiFn;
    if (!ai) {
      // Standard pathed or static enemy shooter check (fn_000131a6)
      if (!ent.isIcon && (ent.flagsLo & 0x40) !== 0 && state.player.alive) {
        ent.aiTimer--;
        if (ent.aiTimer <= 0) {
          const interval = Math.max(38, 125 - state.difficulty * 14 - state.level * 5);
          ent.aiTimer = interval + (Math.random() * 45) | 0;
          if (ent.y >= state.scrollY - VIEW_H && ent.y <= state.scrollY) {
            fireEnemyBullet(ent.x, ent.y, 2.2, 0, ent);
          }
        }
      }
      return;
    }

    if (ai.endsWith("_turret_aim")) {
      const dx = (state.player.x - ent.x) * (ent.mir ? -1 : 1);
      const dy = state.player.y - ent.y;
      // 5 turret frames aiming roughly -2..+2 horizontally
      const a = Math.atan2(dx, Math.max(12, Math.abs(dy)));
      ent.frame = Math.max(0, Math.min(4, Math.round((a + 1.1) * 1.8)));
      ent.aiTimer--;
      if (ent.aiTimer <= 0 && state.player.alive) {
        ent.aiTimer = Math.max(40, 105 - state.difficulty * 12);
        if (ent.y >= state.scrollY - VIEW_H && ent.y <= state.scrollY - 8) {
          fireEnemyBullet(ent.x, ent.y, 2.4, 0, ent);
        }
      }
    } else if (ai.endsWith("_trapdoor") || ai.endsWith("_trapdoor4")) {
      const maxFr = (getAnim(ent.aniKey)?.frames.length || 6) - 1;
      ent.aiTimer--;
      if (ent.aiTimer <= 0) {
        ent.doorOpen = ent.doorOpen ? 0 : 1;
        if (ent.doorOpen && onScreen(ent)) sound.play("shot4", 0.3, 0.2, 0.45, "door", 120);
        ent.aiTimer = ent.doorOpen ? 50 : Math.max(40, 95 - state.difficulty * 8);
      }
      if (ent.doorOpen && ent.frame < maxFr && (state.frameTick & 3) === 0) {
        ent.frame++;
        if (ent.frame === maxFr && state.player.alive) {
          fireEnemyBullet(ent.x, ent.y, 2.3, 0, ent);
        }
      } else if (!ent.doorOpen && ent.frame > 0 && (state.frameTick & 3) === 0) {
        ent.frame--;
      }
    } else if (ai.endsWith("_patrol_x")) {
      const minX = Math.min(ent.param2a, ent.param2c);
      const maxX = Math.max(ent.param2a, ent.param2c);
      ent.x += ent.aiDir * 1.4;
      if (ent.x <= minX) {
        ent.x = minX;
        ent.aiDir = 1;
      } else if (ent.x >= maxX) {
        ent.x = maxX;
        ent.aiDir = -1;
      }
      const nfr = getAnim(ent.aniKey)?.frames.length || 8;
      ent.frame = (ent.frame + (ent.aiDir > 0 ? 1 : nfr - 1)) % nfr;
      ent.aiTimer--;
      if (ent.aiTimer <= 0 && state.player.alive) {
        ent.aiTimer = Math.max(45, 95 - state.difficulty * 10);
        fireEnemyBullet(ent.x, ent.y, 2.4, 0, ent);
      }
    } else if (ai.endsWith("_walker_y")) {
      const minY = Math.min(ent.param2a, ent.param2c);
      const maxY = Math.max(ent.param2a, ent.param2c);
      ent.y += ent.aiDir * 1.1;
      if (ent.y <= minY) {
        ent.y = minY;
        ent.aiDir = 1;
      } else if (ent.y >= maxY) {
        ent.y = maxY;
        ent.aiDir = -1;
      }
      if ((state.frameTick & 3) === 0) {
        const nfr = getAnim(ent.aniKey)?.frames.length || 12;
        ent.frame = (ent.frame + 1) % nfr;
      }
      ent.aiTimer--;
      if (ent.aiTimer <= 0 && state.player.alive) {
        ent.aiTimer = Math.max(45, 90 - state.difficulty * 10);
        fireEnemyBullet(ent.x, ent.y, 2.5, 0, ent);
      }
    } else if (ai.endsWith("_tower_l") || ai.endsWith("_tower_r")) {
      if ((state.frameTick & 7) === 0) {
        ent.frame = (ent.frame + 1) % 3;
      }
    } else if (ai.endsWith("_bolt_l") || ai.endsWith("_bolt_r")) {
      // If linked Tower pair was destroyed, despawn bolt barrier!
      if (state.destroyedPairIds.has(ent.param2c)) {
        ent.alive = false;
        return;
      }
      // Sweep between Tower X and param_2a X
      const leftX = Math.min(ent.rec.x, ent.param2a);
      const rightX = Math.max(ent.rec.x, ent.param2a);
      ent.x += ent.aiDir * 2.2;
      if (ent.x <= leftX) {
        ent.x = leftX;
        ent.aiDir = 1;
      } else if (ent.x >= rightX) {
        ent.x = rightX;
        ent.aiDir = -1;
      }
      if ((state.frameTick & 1) === 0) {
        ent.frame = (ent.frame + 1) % 7;
      }
      ent.aiTimer--;
      if (ent.aiTimer <= 0 && state.player.alive) {
        ent.aiTimer = Math.max(32, 75 - state.difficulty * 8);
        fireEnemyBullet(ent.x, ent.y, 2.8, 0, ent);
      }
    } else if (ai.endsWith("_ventlid") || ai.endsWith("_jello") || ai.endsWith("_eye") || ai.endsWith("_mouth")) {
      if ((state.frameTick & 3) === 0) {
        const nfr = getAnim(ent.aniKey)?.frames.length || 4;
        ent.frame = (ent.frame + 1) % nfr;
      }
      ent.aiTimer--;
      if (ent.aiTimer <= 0 && state.player.alive) {
        ent.aiTimer = Math.max(38, 92 - state.difficulty * 10);
        fireEnemyBullet(ent.x, ent.y, 2.6, 0, ent);
      }
    }
  }

  function addScore(pts) {
    state.score += pts;
    if (state.score > state.hiScore) state.hiScore = state.score;
    // Authentic 50,000 extra-life rule in fn_00011094 (Trainer patch nop'd addq.w #1)
    if (state.score >= state.nextExtraLifeScore) {
      if (!state.trainer) {
        state.lives = Math.min(9, state.lives + 1);
      }
      state.nextExtraLifeScore *= 2; // a free ship at 100,000, then 200,000, 400,000...: each one takes twice the score of the last
      sound.play(sound.pick("bonus_b", "icon"), 0.9, 0, 1.3);
      state.popups.push({ x: state.player.x, y: state.player.y - 16, text: "1UP!", ttl: 55 });
    }
  }

  function killEntity(ent) {
    ent.alive = false;
    addScore(ent.scoreVal);
    // Only real enemies count toward pick-up drops: not the destructible parts of the ground, and not enemy
    // fire shot out of the air (that never comes through here at all).
    const enemy = Boolean(ent.aniKey);
    if (enemy) state.kills++;
    state.credits += Math.round(Math.max(5, ent.scoreVal / 20) * (1 + 0.25 * up("salvage")) * lean());
    const dropKind = enemy ? nextDrop() : null;
    if (dropKind) {
      const box = getEntityHitbox(ent);
      state.pickups.push({
        kind: dropKind,
        x: Math.max(20, Math.min(WORLD_W - 20, box.x + box.w / 2)),
        y: box.y + box.h / 2,
        age: 0,
      });
    }
    if (ent.deathFn && (ent.deathFn.endsWith("_kill_pair_l") || ent.deathFn.endsWith("_kill_pair_r"))) {
      state.destroyedPairIds.add(ent.param2c);
      // Award linked bolt destruction bonus when tower drops
      for (const other of state.entities) {
        if (other.alive && other.param2c === ent.param2c && other.aniKey === "bolt") {
          other.alive = false;
          state.explosions.push({ x: other.x, y: other.y, frame: 5, speed: 0.5 });
        }
      }
    }
    if (ent.rubbleFrame >= 0) {
      stampRubble(baseLevel(), ent);
    }
    state.explosions.push({ x: ent.x, y: ent.y, frame: 4, speed: 0.55 });
    burst(ent.x, ent.y, ent.maxHp >= 6 ? 2 : ent.maxHp >= 3 ? 1.4 : 1);
    if (ent.scoreVal >= 1000) {
      state.popups.push({ x: ent.x, y: ent.y - 10, text: String(ent.scoreVal), ttl: 40 });
    }
    // Explosion sized to the thing: a short crack for the small fry, the full blast for the heavy ones
    const dv = (VOICES[ent.aniKey] && VOICES[ent.aniKey].die) || 1.0;
    const dr = 0.75 + 0.25 * dv; // keep each kind's own pitch, but not as extreme on the recorded explosions
    const jit = 0.92 + Math.random() * 0.16;
    if (ent.maxHp >= 6) {
      sound.play(sound.pick("explosion_c", "expl2"), 0.9, 0, dr * 0.9 * jit);
      sound.play("expl2", 0.8, 0, 0.5); // a low thump under the big ones
    } else if (ent.maxHp >= 3) sound.play(sound.pick("explosion_b", "expl2"), 0.6, 1.4, dr * jit, "die:" + ent.aniKey, 20);
    else sound.play(sound.pick("explosion_a", "expl2"), 0.5, 0.9, dr * jit, "die:" + ent.aniKey, 20);
  }

  function applyPowerup(ent) {
    ent.alive = false;
    sound.play("icon", 1.0);
    sound.play(sound.pick("bonus_a", "icon"), 0.7, 0.7, 1.25);
    addScore(ent.scoreVal);
    let label = "POWER";
    if ((ent.flagsLo & 0x80) !== 0) {
      state.powerups.rapid += 1000;
      label = "RAPID FIRE";
    } else if ((ent.flagsHi & 0x02) !== 0) {
      state.powerups.freeze += 350;
      label = "ENEMIES FROZEN";
    } else if ((ent.flagsHi & 0x04) !== 0) {
      state.powerups.shield += 500;
      state.shields = maxShields();
      label = "SHIELD";
    } else {
      state.powerups.superShot += 500;
      label = "SUPER SHOT";
    }
    state.popups.push({ x: ent.x, y: ent.y - 14, text: label, ttl: 55 });
  }

  function damagePlayer() {
    if (!state.player.alive || state.player.invuln > 0 || state.powerups.shield > 0) return;
    if (state.shields > 0) {
      // A shield absorbs the hit: no life lost, a moment of safety to fly clear.
      state.shields--;
      state.shieldFlash = 24;
      state.player.invuln = SHIELD_HIT_INVULN;
      sound.play("bump", 1.0);
      sound.play("shot3", 0.7, 0.35, state.shields > 0 ? 0.6 : 0.4);
      state.popups.push({
        x: state.player.x,
        y: state.player.y - 18,
        text: state.shields > 0 ? "SHIELD HIT" : "SHIELDS DOWN",
        ttl: 45,
      });
      return;
    }
    state.explosions.push({ x: state.player.x, y: state.player.y, frame: 6, speed: 0.45 });
    sound.play(sound.pick("explosion_c", "expl2"), 1.3, 0, 0.8);
    if (!state.trainer) {
      state.lives--;
    }
    state.player.alive = false;
    state.player.respawnTimer = 65;
    state.powerups.rapid = Math.floor(state.powerups.rapid * 0.5);
    state.powerups.superShot = 0;
    track("player_death", { level: shownLevel(), ships_left: Math.max(0, state.lives) });
    if (state.lives <= 0 && !state.trainer) {
      track("game_over", { level: shownLevel(), score: state.score, kills: state.kills, upgrades: power(), seconds: Math.round((performance.now() - (state.runStart || 0)) / 1000) });
      state.screen = "game_over";
      state.stateTimer = 180;
    }
  }

  function detonateBomb(x, y) {
    state.explosions.push({ x, y, frame: 15, speed: 0.4 });
    sound.play(sound.pick("explosion_b", "expl2"), 1.0, 0, 0.7);
    const radius = BOMB_RADIUS + 10 * up("bomb");
    const r2 = radius * radius;
    for (const ent of state.entities) {
      if (!ent.alive || ent.isIcon || (ent.flagsHi & 0x10) !== 0) continue;
      const box = getEntityHitbox(ent);
      const cx = Math.max(box.x, Math.min(x, box.x + box.w));
      const cy = Math.max(box.y, Math.min(y, box.y + box.h));
      if ((cx - x) * (cx - x) + (cy - y) * (cy - y) > r2) continue;
      ent.hp -= BOMB_DAMAGE;
      ent.flash = 6;
      if (ent.hp <= 0) killEntity(ent);
    }
    for (const eb of state.enemyBullets) {
      if ((eb.x - x) * (eb.x - x) + (eb.y - y) * (eb.y - y) <= r2) eb.dead = true;
    }
    burst(x, y, 1.6);
    const bs = state.boss;
    if (bs && Math.hypot(x - (state.scrollX + bs.lat), y - (state.scrollY - VIEW_H + bs.depth)) < radius + 30) hurtBoss(bs, BOMB_DAMAGE * 2);
  }

  function onScreen(ent) {
    return Math.abs(ent.x - (state.scrollX + VIEW_W / 2)) < VIEW_W / 2 + 8 && ent.y > state.scrollY - VIEW_H - 4 && ent.y < state.scrollY + 4;
  }

  function getEntityHitbox(ent) {
    if (ent.aniKey === null) {
      // Static canyon wall / structure box in [x .. x+w, y-h .. y]
      return { x: ent.x, y: ent.y - ent.h, w: ent.w, h: ent.h };
    }
    const fr = getFrame(ent.aniKey, ent.frame);
    const w = fr ? fr.width : ent.w;
    const h = fr ? fr.height : ent.h;
    const hx = fr ? fr.hot_x : Math.floor(w / 2);
    const hy = fr ? fr.hot_y : Math.floor(h / 2);
    return { x: ent.mir ? ent.x - (w - hx) : ent.x - hx, y: ent.y - hy, w, h };
  }

  // --- Main Simulation Step (50 Hz Amiga tick) ---
  function stepGame() {
    state.frameTick++;
    pollGamepad();
    if (state.swap) {
      // the level waits while the camera swings round
      if (++state.swap.t >= SWAP_LEN) state.swap = null;
      return;
    }

    if (consumeAction("KeyP") || gpState.edge.pause) {
      if (state.screen === "playing" || state.screen === "side") sound.ui("toggle");
      if (state.screen === "playing" || state.screen === "side") {
        state.paused = !state.paused;
        ui.pauseBtn.textContent = state.paused ? "Resume" : "Pause";
      }
    }

    if (state.screen === "title") {
      stepDemo();
      if (anyStartPressed()) {
        state.screen = "menu";
        sound.ui("select");
      }
      return;
    }

    if (state.screen === "loading") {
      stepDemo();
      return;
    }

    if (state.screen === "menu") {
      stepDemo();
      if (consumeAction("ArrowUp") || consumeAction("KeyW") || gpState.edge.up) {
        state.difficulty = Math.max(1, state.difficulty - 1);
        ui.diffSelect.value = String(state.difficulty);
        sound.ui("move");
      }
      if (consumeAction("ArrowDown") || consumeAction("KeyS") || gpState.edge.down) {
        state.difficulty = Math.min(5, state.difficulty + 1);
        ui.diffSelect.value = String(state.difficulty);
        sound.ui("move");
      }
      if (consumeAction("ArrowLeft") || consumeAction("KeyA") || gpState.edge.left) {
        state.selectedLevel = Math.max(1, state.selectedLevel - 1);
        ui.levelSelect.value = String(state.selectedLevel);
        sound.ui("move");
      }
      if (consumeAction("ArrowRight") || consumeAction("KeyD") || gpState.edge.right) {
        state.selectedLevel = Math.min(18, state.selectedLevel + 1);
        ui.levelSelect.value = String(state.selectedLevel);
        sound.ui("move");
      }
      for (let d = 1; d <= 5; d++) {
        if (consumeAction(`Digit${d}`) || consumeAction(`Numpad${d}`)) {
          state.difficulty = d;
          ui.diffSelect.value = String(d);
          startNewGame(state.selectedLevel);
          return;
        }
      }
      if (consumeAction("KeyT") || gpState.edge.trainer) {
        ui.trainerBtn.click();
      }
      if (anyStartPressed()) {
        startNewGame(state.selectedLevel);
      }
      return;
    }

    if (state.screen === "stage_clear") {
      state.stateTimer--;
      // the next level; second time round it is a new world that has to be fetched first
      const last = state.level >= levelsInLoop(state.loopCount);
      const next = last ? 1 : state.level + 1;
      const loop = state.loopCount + (last ? 1 : 0);
      const world = worldFor(next, loop); // side-scroller levels need no map
      const waiting = world > 0 && !(world in wideLevels);
      if (waiting) loadWide(world);
      if (state.stateTimer <= 0 || anyStartPressed()) {
        if (waiting) {
          state.stateTimer = 0;
          return;
        }
        snapshotView();
        state.loopCount = loop;
        beginLevel(next);
        state.swap = { t: 0, toSide: Boolean(state.side) };
        sound.play(sound.pick("spin_a", "hum2"), 0.8, 0, state.side ? 0.7 : 0.9);
      }
      return;
    }

    if (state.screen === "game_over") {
      state.stateTimer--;
      if (anyStartPressed() || (state.stateTimer <= 0 && keys.size > 0)) {
        sound.ui("back");
        state.screen = "menu";
      }
      return;
    }

    if (state.screen === "dealer") {
      stepDealer();
      return;
    }

    if (state.screen === "dive") {
      const d = state.dive;
      d.t++;
      state.player.x += (d.x - state.player.x) * 0.2;
      state.player.y += (d.y - state.player.y) * 0.2;
      if (d.t >= DIVE_LEN) {
        state.dive = null;
        enterBonus();
      }
      return;
    }

    if (state.screen === "bonus") {
      stepBonus();
      return;
    }

    if (state.screen === "side") {
      if (!state.paused) stepSide();
      return;
    }

    if (state.screen !== "playing" || state.paused) return;

    // Half way up the level the arms dealer flags you down
    if (!state.dealerDone && state.scrollY <= (START_SCROLL_Y + END_SCROLL_Y) / 2) {
      openDealer();
      return;
    }

    // Powerup timers
    if (state.powerups.rapid > 0) state.powerups.rapid--;
    if (state.powerups.freeze > 0) state.powerups.freeze--;
    if (state.powerups.shield > 0) state.powerups.shield--;
    if (state.powerups.superShot > 0) state.powerups.superShot--;
    if (state.shieldFlash > 0) state.shieldFlash--;
    if (state.bombCooldown > 0) state.bombCooldown--;
    if (state.novaFlash > 0) state.novaFlash--;

    // Vertical scroll (fn_000134f4): 1px per 50Hz frame
    // The boss meets you in the open, just before the walled run-in at the end of the original levels comes into
    // view (those walls reach down to y = 194); the generated worlds have no run-in, so there it is at the very end.
    const bossAt = state.wideMaps ? END_SCROLL_Y : 194 + VIEW_H + 24;
    if (!state.waveDone && !state.boss && state.scrollY <= bossAt) startWave();
    if (state.wave) {
      // the scroll holds until the formation is dealt with
    } else if (!state.boss && state.scrollY <= bossAt) {
      state.boss = makeBoss();
    } else if (state.boss && !state.boss.gone) {
      // the scroll holds while the boss is alive
    } else if (state.scrollY > END_SCROLL_Y) {
      // the level scrolls by itself, 1px per 50 Hz tick, carrying the jet with it
      state.scrollY -= 1;
      state.player.y -= 1;
    } else {
      // Stage complete!
      addScore(2500 * state.level);
      state.credits += Math.round(200 * shownLevel() * lean());
      sound.play(sound.pick("bonus_b", "icon"), 1.0);
      track("level_complete", { level: shownLevel(), score: state.score, upgrades: power() });
      state.screen = "stage_clear";
      state.stateTimer = 150;
      return;
    }

    const viewTop = state.scrollY - VIEW_H;
    const viewBottom = state.scrollY;

    // Player controls (fn_000106ec)
    const p = state.player;
    if (!p.alive) {
      p.respawnTimer--;
      if (p.respawnTimer <= 0 && (state.lives > 0 || state.trainer)) {
        p.alive = true;
        p.y = state.scrollY - 36;
        p.invuln = 120;
        p.bank = 0;
        state.shields = maxShields();
      }
    } else {
      if (p.invuln > 0) p.invuln--;
      const engine = 1 + 0.12 * up("engine");
      const spdX = (state.powerups.rapid > 0 ? 3.2 : 2.6) * engine;
      const spdY = (state.powerups.rapid > 0 ? 2.8 : 2.2) * engine;
      let mx = gpState.mx;
      let my = gpState.my;
      if (keys.has("ArrowLeft") || keys.has("KeyA")) mx -= 1;
      if (keys.has("ArrowRight") || keys.has("KeyD")) mx += 1;
      if (keys.has("ArrowUp") || keys.has("KeyW")) my -= 1;
      if (keys.has("ArrowDown") || keys.has("KeyS")) my += 1;
      mx = Math.max(-1, Math.min(1, mx));
      my = Math.max(-1, Math.min(1, my));

      p.x = Math.max(14, Math.min(WORLD_W - 24, p.x + mx * spdX));
      if (state.wave) p.x = Math.max(state.wave.camX + 14, Math.min(state.wave.camX + VIEW_W - 14, p.x)); // the view is fixed for the formation stage
      p.y = Math.max(viewTop + 14, Math.min(viewBottom - 16, p.y + my * spdY));

      if (mx < -0.15) p.bank = Math.max(-2, p.bank - 0.35);
      else if (mx > 0.15) p.bank = Math.min(2, p.bank + 0.35);
      else p.bank *= 0.72;

      // Player fire (fn_000108e6)
      if (p.cooldown > 0) p.cooldown--;
      const aiming = gpState.aimX !== 0 || gpState.aimY !== 0;
      const firing = keys.has("Space") || keys.has("KeyZ") || keys.has("Enter") || gpState.fireHeld || aiming;
      if (p.missileCooldown > 0) p.missileCooldown--;
      if (firing && p.cooldown <= 0) {
        const superOn = state.powerups.superShot > 0;
        const cannon = up("cannon");
        // 50% faster than the original 8 / 3 ticks; the fraction carries over so the rate is exact
        p.cooldown += (state.powerups.rapid > 0 ? 2 : 16 / 3) / CANNON_RATE[cannon];
        // Right stick aims the twin cannons anywhere; otherwise they fire straight ahead.
        const dx = aiming ? gpState.aimX : 0;
        const dy = aiming ? gpState.aimY : -1;
        const pierce = superOn || up("laser") > 0;
        const dmg = CANNON_DMG[cannon] + (superOn ? 1 : 0) + (up("laser") >= 2 ? 1 : 0);
        const shoot = (ox, oy, ax, ay) => {
          state.playerBullets.push({ x: p.x + ox, y: p.y + oy, vx: ax * SHOT_SPEED, vy: ay * SHOT_SPEED, pierce, dmg });
        };
        for (const side of [-1, 1]) shoot(dx * 12 - dy * 6 * side, dy * 12 + dx * 6 * side, dx, dy);
        for (let i = 1; i <= up("spread"); i++) {
          for (const side of [-1, 1]) {
            const a = side * i * 0.24;
            const ax = dx * Math.cos(a) - dy * Math.sin(a);
            const ay = dx * Math.sin(a) + dy * Math.cos(a);
            shoot(ax * 10, ay * 10, ax, ay);
          }
        }
        if (up("tail") >= 2) {
          for (const a of [-0.22, 0.22]) shoot(-dx * 12, -dy * 12, -(dx * Math.cos(a) - dy * Math.sin(a)), -(dx * Math.sin(a) + dy * Math.cos(a)));
        } else if (up("tail")) shoot(-dx * 12, -dy * 12, -dx, -dy);
        for (let i = 0; i < up("drone"); i++) shoot(DRONE_AT[i][0] * shipScale(), DRONE_AT[i][1] * shipScale(), dx, dy);
        if (up("missile") && p.missileCooldown <= 0) {
          p.missileCooldown = [38, 38, 22, 14][up("missile")];
          for (const side of up("missile") >= 2 ? [-1, 1] : [state.frameTick & 1 ? 1 : -1]) {
            state.playerBullets.push({ x: p.x + 9 * side, y: p.y, vx: side * 2.5, vy: -3, homing: true, life: 120, pierce: false, dmg: 4 });
          }
          sound.play(sound.pick("laser_big", "shot3"), 0.9, 0.35, 0.7, "missile", 60);
        }
        sound.shot(superOn || up("laser") > 0, state.powerups.rapid > 0);
      }

      // Bombs (either trigger, or B on the keyboard)
      if ((gpState.bombHeld || keys.has("KeyB")) && state.bombCooldown <= 0) {
        state.bombCooldown = bombCooldown();
        state.bombs.push({ x: p.x, y: p.y - 8, t: 0 });
        sound.play("shot4", 0.6, 0.27, 0.5);
      }
    }

    // The camera follows the jet sideways across the three lanes
    state.scrollX += ((state.wave ? state.wave.camX : cameraTargetX()) - state.scrollX) * 0.12;
    state.rubble = state.rubble.filter((r) => r.y < viewBottom + 64);

    // The cave mouth opens ahead of you, off to one side, as its part of the level scrolls in; fly into it for the bonus round
    const cave = state.cave;
    if (!cave.placed && cave.y > viewTop - 30) {
      cave.placed = true;
      const side = p.x > state.scrollX + VIEW_W / 2 ? -1 : 1;
      cave.x = Math.max(60, Math.min(WORLD_W - 60, p.x + side * 90));
    }
    if (cave.placed && !cave.taken && p.alive && Math.abs(p.x - cave.x) < 17 && Math.abs(p.y - cave.y) < 12) {
      // the view leans in over the hole, then pitches forward and drops down it
      cave.taken = true;
      state.dive = { t: 0, x: cave.x, y: cave.y };
      state.screen = "dive";
      state.enemyBullets = [];
      sound.play(sound.pick("spin_a", "hum2"), 0.9, 0, 0.5);
      sound.play(sound.pick("laser_big", "shot3"), 0.6, 0, 0.35);
      return;
    }

    // Spawn and update entities
    spawnDueEntities();
    const frozen = state.powerups.freeze > 0;
    if (state.seaMask && !frozen && !state.wave) spawnSea();
    if (state.wave) stepWave(frozen);

    for (const ent of state.entities) {
      if (!ent.alive) continue;
      if (ent.flash > 0) ent.flash--;
      // the freeze pick-up stops every enemy, its shots and the boss dead for as long as it lasts
      if (!frozen) {
        stepPathVM(ent);
        if (!ent.alive) continue;
        stepAI(ent);
        if (ent.sea) stepSeaEnt(ent);
        if (!ent.alive) continue;
      }
      // Its voice, the first time it is actually on screen
      if (!ent.heard && ent.aniKey && onScreen(ent)) {
        ent.heard = true;
        const v = VOICES[ent.aniKey] && VOICES[ent.aniKey].see;
        if (v) sound.play(v[0], v[1], v[2], v[3], "see:" + ent.aniKey, 180);
      }
      // Culling once scrolled well below bottom edge
      const box = getEntityHitbox(ent);
      if (box.y > viewBottom + 96) {
        ent.alive = false;
      }
    }

    // The boss, or (before it shows) extra flyers that come in thicker the more the ship is upgraded
    const boss = state.boss;
    if (boss && frozen) {
      if (boss.flash > 0) boss.flash--;
    } else if (boss) {
      stepBoss(boss, {
        W: VIEW_W,
        plat: p.x - state.scrollX,
        pdepth: p.y - viewTop,
        fire: (lat, depth, vlat, vdepth) => state.enemyBullets.push({ x: state.scrollX + lat, y: viewTop + depth, vx: vlat, vy: vdepth, frame: 0, age: 0 }),
        minion: () => reinforce(2),
        swap: false,
        lunge: VIEW_H * 0.4,
      });
    } else if (!frozen && !state.wave && power() > 0 && state.scrollY > END_SCROLL_Y + VIEW_H + 240 && --state.reinfT <= 0) {
      state.reinfT = Math.max(45, 320 - power() * 22);
      reinforce(1 + Math.floor(power() / 3));
    }
    const bossX = boss ? state.scrollX + boss.lat : 0;
    const bossY = boss ? viewTop + boss.depth : 0;
    const bossLive = boss && !boss.dying && !boss.gone && !boss.lurk;
    if (boss && boss.dying && boss.dying % 6 === 0) {
      const ex = bossX + (Math.random() - 0.5) * 100;
      const ey = bossY + (Math.random() - 0.5) * 50;
      state.explosions.push({ x: ex, y: ey, frame: 4, speed: 0.5 });
      burst(ex, ey, 1.6);
      sound.play(sound.pick("explosion_b", "expl2"), 0.8, 0, 0.7 + Math.random() * 0.5);
    }
    if (bossLive && p.alive && Math.abs(p.x - bossX) < BOSS_HALF_LAT + 6 && Math.abs(p.y - bossY) < BOSS_HALF_DEPTH + 8) damagePlayer();
    if (p.alive && novaPressed()) novaTopDown();

    // Player Bullets vs Entities (fn_00010a18)
    for (const b of state.playerBullets) {
      if (b.homing) {
        // Seekers bend toward the nearest thing on screen that can be destroyed
        if (--b.life <= 0) b.dead = true;
        let best = null;
        let bestD = 1e9;
        for (const ent of state.entities) {
          if (!ent.alive || ent.isIcon || (ent.flagsHi & 0x10) !== 0 || !onScreen(ent)) continue;
          const d = (ent.x - b.x) * (ent.x - b.x) + (ent.y - b.y) * (ent.y - b.y);
          if (d < bestD) {
            bestD = d;
            best = ent;
          }
        }
        if (!best && bossLive) best = { x: bossX, y: bossY };
        let ang = Math.atan2(b.vy, b.vx);
        if (best) {
          let diff = Math.atan2(best.y - b.y, best.x - b.x) - ang;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));
          ang += Math.max(-0.2, Math.min(0.2, diff));
        }
        const spd = Math.min(6.5, Math.hypot(b.vx, b.vy) + 0.25);
        b.vx = Math.cos(ang) * spd;
        b.vy = Math.sin(ang) * spd;
      }
      b.x += b.vx;
      b.y += b.vy;
      if (b.y < viewTop - 24 || b.y > viewBottom + 24 || b.x < state.scrollX - 80 || b.x > state.scrollX + VIEW_W + 80) {
        b.dead = true;
        continue;
      }
      // Shots knock incoming enemy fire out of the air (super shots plough on through)
      for (const eb of state.enemyBullets) {
        if (eb.dead || Math.abs(eb.x - b.x) > 6 || Math.abs(eb.y - b.y) > 8) continue;
        eb.dead = true;
        state.explosions.push({ x: eb.x, y: eb.y, frame: 4, speed: 0.5, end: 7 });
        addScore(10);
        sound.play("bump", 0.45, 0, 2.2, "tink", 40);
        if (!b.pierce) b.dead = true;
        break;
      }
      if (b.dead) continue;
      // Straight-ahead shots keep the original tall hit box; aimed shots use a square one.
      const bw = b.vx === 0 ? 6 : 8;
      const bh = b.vx === 0 ? 12 : 8;
      const bx = b.x - bw / 2;
      const by = b.y - bh / 2;
      for (const ent of state.entities) {
        if (!ent.alive || ent.isIcon) continue;
        // Hidden entities not shootable unless visible/open
        const box = getEntityHitbox(ent);
        // sprites are hit on their body, not on the empty corners of their frame
        const ins = ent.aniKey ? 0.12 : 0;
        if (!aabbOverlap(bx, by, bw, bh, box.x + box.w * ins, box.y + box.h * ins, box.w * (1 - 2 * ins), box.h * (1 - 2 * ins))) continue;

        if ((ent.flagsHi & 0x10) !== 0 && !b.pierce) {
          // Indestructible wall/armor stops regular shot
          b.dead = true;
          sound.play("bump", 0.25, 0, 0.5, "clank", 90);
          break;
        }
        ent.hp -= b.dmg;
        ent.flash = 4;
        if (b.homing) state.explosions.push({ x: b.x, y: b.y, frame: 4, speed: 0.5, end: 9 });
        if (!b.pierce) b.dead = true;
        if (ent.hp <= 0) {
          killEntity(ent);
        } else {
          sound.play("bump", 0.45, 0, ent.staticTarget ? 0.7 : 1.2, "hit", 40);
        }
        if (b.dead) break;
      }
      if (!b.dead && bossLive && Math.abs(b.x - bossX) < BOSS_HALF_LAT && Math.abs(b.y - bossY) < BOSS_HALF_DEPTH) {
        hurtBoss(boss, b.dmg);
        burst(b.x, b.y, 0.25);
        b.dead = true;
      }
    }
    state.playerBullets = state.playerBullets.filter((b) => !b.dead);

    // Bombs fly a short way ahead, then burst
    for (const bm of state.bombs) {
      bm.t++;
      bm.y -= BOMB_SPEED;
      if (bm.t >= BOMB_FUSE) {
        bm.dead = true;
        detonateBomb(bm.x, bm.y);
      }
    }
    state.bombs = state.bombs.filter((bm) => !bm.dead);

    // Shield pick-ups stay where they dropped; fly over one to collect it
    for (const pk of state.pickups) {
      pk.age++;
      if (pk.y > viewBottom + 16) {
        pk.dead = true;
      } else if (p.alive && Math.abs(pk.x - p.x) < 14 && Math.abs(pk.y - p.y) < 15) {
        pk.dead = true;
        if (pk.kind === "nova") {
          state.upgrades.nova = Math.min(NOVA_MAX, up("nova") + 1);
          addScore(250);
          sound.play(sound.pick("bonus_a", "icon"), 0.9, 0.6, 1.2);
          state.popups.push({ x: pk.x, y: pk.y - 14, text: "NOVA BOMB", ttl: 55 });
          continue;
        }
        if (pk.kind === "rapid") {
          state.powerups.rapid += RAPID_DROP_TICKS;
          addScore(250);
          sound.play(sound.pick("bonus_a", "icon"), 0.8, 0.5, 1.5);
          state.popups.push({ x: pk.x, y: pk.y - 14, text: "RAPID FIRE", ttl: 55 });
          continue;
        }
        const gained = state.shields < maxShields();
        if (gained) state.shields++;
        addScore(250);
        sound.play(sound.pick("bonus_a", "icon"), 0.8, 0.5, gained ? 1.0 : 0.8);
        state.popups.push({ x: pk.x, y: pk.y - 14, text: gained ? "SHIELD +1" : "SHIELDS FULL", ttl: 55 });
      }
    }
    state.pickups = state.pickups.filter((pk) => !pk.dead);

    // Enemy Bullets vs Player
    for (const eb of state.enemyBullets) {
      if (eb.dead) continue;
      if (!frozen) {
        eb.x += eb.vx;
        eb.y += eb.vy;
      }
      eb.age++;
      if ((eb.age & 1) === 0) eb.frame = (eb.frame + 1) & 3;
      if (eb.x < -16 || eb.x > WORLD_W + 16 || eb.y < viewTop - 24 || eb.y > viewBottom + 24) {
        eb.dead = true;
        continue;
      }
      if (p.alive && aabbOverlap(eb.x - 2, eb.y - 2, 5, 5, p.x - 5 * shipScale(), p.y - 8 * shipScale(), 10 * shipScale(), 16 * shipScale())) {
        eb.dead = true;
        damagePlayer();
      }
    }
    state.enemyBullets = state.enemyBullets.filter((eb) => !eb.dead);

    // Player vs Entities / Powerups (fn_00010bb4)
    if (p.alive) {
      const hk = shipScale(); // the fuselage, at the size it is drawn
      const px = p.x - 6 * hk;
      const py = p.y - 9 * hk;
      const pw = 12 * hk;
      const ph = 17 * hk;
      for (const ent of state.entities) {
        if (!ent.alive) continue;
        const box = getEntityHitbox(ent);
        const ins = ent.aniKey && !ent.isIcon ? 0.15 : 0;
        if (!aabbOverlap(px, py, pw, ph, box.x + box.w * ins, box.y + box.h * ins, box.w * (1 - 2 * ins), box.h * (1 - 2 * ins))) continue;
        if (ent.isIcon) {
          applyPowerup(ent);
        } else if (ent.staticWall) {
          // Push/clamp out of canyon launch walls or damage on deep overlap
          damagePlayer();
        } else {
          damagePlayer();
          if ((ent.flagsHi & 0x10) === 0 && ent.hp <= 2) {
            killEntity(ent);
          }
        }
      }
    }

    state.entities = state.entities.filter((e) => e.alive);

    // Explosions
    for (const ex of state.explosions) {
      ex.frame += ex.speed;
      if (ex.frame >= (ex.end || 24)) ex.dead = true;
    }
    state.explosions = state.explosions.filter((e) => !e.dead);
    stepSparks();

    // Score/Powerup popups
    for (const pop of state.popups) {
      pop.y -= 0.4;
      pop.ttl--;
    }
    state.popups = state.popups.filter((pop) => pop.ttl > 0);
  }

  // --- Rendering ---
  function drawHud() {
    // one slim line, the same size on screen however far out the camera is
    const HY = VIEW_H / ZOOM;
    ctx.save();
    ctx.scale(ZOOM, ZOOM);
    ctx.fillStyle = "#090d16";
    ctx.fillRect(0, HY, BASE_W, HUD_H);
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(0, HY, BASE_W, 1);
    ctx.font = "bold 8px monospace";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    const y = HY + 5;
    const pair = (x, label, value, col) => {
      ctx.fillStyle = "#64748b";
      ctx.fillText(label, x, y);
      ctx.fillStyle = col;
      ctx.fillText(value, x + label.length * 4.85 + 3, y);
    };
    pair(6, "SC", String(state.score).padStart(7, "0"), "#f8fafc");
    pair(62, "HI", String(state.hiScore).padStart(7, "0"), "#fbbf24");
    pair(118, "STG", String(shownLevel()), "#38bdf8");
    pair(152, "SHIPS", state.trainer ? "INF" : String(Math.max(0, state.lives)), state.trainer ? "#a855f7" : "#4ade80");
    // shields: one pip per hit you can still absorb
    const pitch = Math.min(8, 42 / maxShields());
    for (let i = 0; i < maxShields(); i++) {
      ctx.fillStyle = i < state.shields ? "#22d3ee" : "#1e293b";
      ctx.fillRect(202 + i * pitch, y + 1, pitch - 2, 6);
    }
    // power-ups running, each with a bar that drains
    const bars = [
      ["RPD", state.powerups.rapid, 1000, "#38bdf8"],
      ["FRZ", state.powerups.freeze, 350, "#60a5fa"],
      ["SHD", state.powerups.shield, 500, "#4ade80"],
      ["SUP", state.powerups.superShot, 500, "#f97316"],
    ];
    let bx = 252;
    for (const [lbl, val, cap, col] of bars) {
      ctx.fillStyle = val > 0 ? col : "#334155";
      ctx.fillText(lbl, bx, y - 1);
      if (val > 0) ctx.fillRect(bx, y + 8, Math.min(15, Math.ceil((val / cap) * 15)), 1.5);
      bx += 23;
    }
    // bomb: the bar refills while the next one arms
    ctx.fillStyle = state.bombCooldown > 0 ? "#334155" : "#f87171";
    ctx.fillText("BOMB", 352, y);
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(376, y + 2, 26, 4);
    ctx.fillStyle = "#f87171";
    ctx.fillRect(376, y + 2, Math.round((1 - state.bombCooldown / bombCooldown()) * 26), 4);
    ctx.restore();
  }

  // The sky above the horizon and the haze the land fades into, for the horizon view
  function drawHorizon() {
    const gc = groundCam();
    const yh = VIEW_H - 1 / gc.A; // screen y of the horizon
    if (!state.wave || yh <= -VIEW_H * 0.25) return;
    const st = FX_STYLE[worldFor(state.level, state.loopCount) || baseLevel()] || FX_STYLE[1];
    const rgb = (c, k, a = 1) => `rgba(${Math.min(255, c[0] * k) | 0},${Math.min(255, c[1] * k) | 0},${Math.min(255, c[2] * k) | 0},${a})`;
    const T = state.frameTick;
    // land running out into haze
    const hz = VIEW_H * 0.2;
    const haze = ctx.createLinearGradient(0, yh, 0, yh + hz);
    haze.addColorStop(0, rgb(st.fog, 900));
    haze.addColorStop(0.35, rgb(st.fog, 700, 0.6));
    haze.addColorStop(1, rgb(st.fog, 700, 0));
    ctx.fillStyle = haze;
    ctx.fillRect(0, yh, VIEW_W, hz);
    if (yh <= 0) return;
    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, yh);
    sky.addColorStop(0, "#020108");
    sky.addColorStop(0.55, rgb(st.fog, 260));
    sky.addColorStop(0.9, rgb(st.voidB, 90));
    sky.addColorStop(1, rgb(st.voidA, 200));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, VIEW_W, yh + 0.5);
    // stars, thinning out toward the horizon
    for (let i = 0; i < 90; i++) {
      const hx = Math.sin(i * 127.1) * 43758.5453, hy = Math.sin(i * 311.7) * 43758.5453;
      const fy = hy - Math.floor(hy);
      const x = (hx - Math.floor(hx)) * VIEW_W, y = fy * fy * yh * 0.92;
      const tw = 0.45 + 0.4 * Math.sin(T * 0.05 + i * 1.7);
      ctx.fillStyle = `rgba(255,255,255,${tw * (1 - fy * 0.7)})`;
      ctx.fillRect(x, y, i % 7 === 0 ? 1.5 : 0.8, i % 7 === 0 ? 1.5 : 0.8);
    }
    // a low sun sitting on the horizon, and the bright line of the horizon itself
    const sx = VIEW_W * 0.68, sr = VIEW_H * 0.11;
    const sun = ctx.createRadialGradient(sx, yh, 0, sx, yh, sr * 3);
    sun.addColorStop(0, rgb(st.voidA, 255, 0.9));
    sun.addColorStop(0.3, rgb(st.voidA, 255, 0.35));
    sun.addColorStop(1, rgb(st.voidA, 255, 0));
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_W, yh);
    ctx.clip();
    ctx.fillStyle = sun;
    ctx.fillRect(sx - sr * 3, yh - sr * 3, sr * 6, sr * 3);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.arc(sx, yh + sr * 0.25, sr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = rgb(st.voidB, 255, 0.7);
    ctx.fillRect(0, yh - 0.5, VIEW_W, 1);
  }

  function renderScene() {
    ctx.setTransform(RENDER_SCALE / ZOOM, 0, 0, RENDER_SCALE / ZOOM, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, VIEW_W, VIEW_H + HUD_H * ZOOM);

    if (!state.loaded) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "11px monospace";
      ctx.fillText("Decoding Amiga assets...", 78, 98);
      return;
    }

    if (state.screen === "title") {
      renderTitle();
      return;
    }

    if (state.screen === "loading") {
      drawDemo(0.78);
      ctx.fillStyle = "#fbbf24";
      ctx.font = "bold 12px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.save();
      ctx.scale(ZOOM, ZOOM);
      ctx.fillText("LOADING WORLD...", BASE_W / 2, (VIEW_H / ZOOM + HUD_H) / 2);
      ctx.restore();
      ctx.textAlign = "left";
      return;
    }

    if (state.screen === "menu") {
      drawDemo(0.78);
      ctx.save();
      ctx.scale(ZOOM, ZOOM);
      ctx.translate(UI_OX, Math.floor((VIEW_H / ZOOM + HUD_H - UI_H) / 2));
      ctx.textBaseline = "top";
      ctx.fillStyle = "#fbbf24";
      ctx.font = "bold 12px monospace";
      ctx.fillText("SIDEWINDER FLIGHT BRIEFING", 60, 18);

      ctx.font = "10px monospace";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText("PLEASE SELECT DIFFICULTY (UP/DOWN or 1-5):", 24, 42);

      for (let d = 1; d <= 5; d++) {
        const sel = d === state.difficulty;
        ctx.fillStyle = sel ? "#38bdf8" : "#cbd5e1";
        ctx.fillText(`${sel ? ">" : " "} ${d} - ${DIFFICULTY_NAMES[d]}`, 44, 46 + d * 15);
      }

      ctx.fillStyle = "#94a3b8";
      ctx.fillText(`STAGE (LEFT/RIGHT):  < LEVEL ${state.selectedLevel} >`, 24, 142);
      ctx.fillStyle = state.trainer ? "#c084fc" : "#cbd5e1";
      ctx.fillText(`TRAINER PATCH (T):   ${state.trainer ? "ON (Infinite Lives)" : "OFF (3 Lives)"}`, 24, 158);

      ctx.fillStyle = "#fbbf24";
      ctx.fillStyle = document.fullscreenElement ? "#4ade80" : "#22d3ee";
      ctx.fillText(`FULL SCREEN (F):     ${document.fullscreenElement ? "ON" : "OFF - press F"}`, 24, 172);
      ctx.fillStyle = "#fbbf24";
      ctx.fillText("PRESS SPACE / ENTER TO START MISSION", 46, 188);
      ctx.restore();
      return;
    }

    if (state.screen === "bonus") {
      renderBonus();
      drawHud();
      return;
    }

    if (state.side) {
      renderSide();
    } else {
    ctx.save();
    const dive = state.screen === "dive" ? state.dive : null;
    let fall = 0;
    if (dive) {
      // First third: the camera leans in over the hole at an angle. Then it tips forward and falls: the ground
      // rushes up, stretching toward us and twisting, until the mouth swallows the screen.
      const e = Math.min(1, dive.t / DIVE_LEN);
      const lean = Math.min(1, e / 0.32);
      fall = e < 0.32 ? 0 : (e - 0.32) / 0.68;
      const f3 = fall * fall * fall;
      const pc = project(dive.x, dive.y);
      const pull = 0.45 * Math.sin((lean * Math.PI) / 2) + 0.55 * fall;
      ctx.translate(pc.x + (VIEW_W / 2 - pc.x) * pull, pc.y + (VIEW_H * 0.55 - pc.y) * pull);
      ctx.rotate(0.13 * Math.sin((lean * Math.PI) / 2) - 0.6 * f3);
      const k = (1 + 0.3 * lean) * (1 + 13 * f3); // enough extra size while leaning that no edge of the board shows
      ctx.scale(k, k * (1 + 0.35 * lean + 1.4 * fall * fall));
      ctx.translate(-pc.x, -pc.y);
    }
    // Playfield viewport
    const camX = Math.round(state.scrollX);
    const camY = Math.round(state.scrollY - VIEW_H);
    buildStrip();
    if (!fxDraw()) {
      // No GPU: draw the same tilted ground one screen row at a time from the flattened strip
      for (let ys = 0; ys < VIEW_H; ys++) {
        const u = VIEW_H - ys - 0.5;
        const gcam = groundCam();
        const sc = 1 - gcam.A * u;
        if (sc < 0.05) continue;
        const wy = state.scrollY - (gcam.C * u) / sc;
        const cx = state.scrollX + VIEW_W / 2;
        const half = VIEW_W / 2 / sc;
        const x0 = Math.max(0, cx - half);
        const x1 = Math.min(WORLD_W, cx + half);
        if (wy < 0 || wy >= MAP_H || x1 <= x0) continue;
        ctx.drawImage(strip, (x0 - stripAt.x) * MAP_SCALE, Math.floor((wy - stripAt.y) * MAP_SCALE), (x1 - x0) * MAP_SCALE, Math.max(1, MAP_SCALE / sc),
          VIEW_W / 2 + (x0 - cx) * sc, ys, (x1 - x0) * sc, 1.02);
      }
    }

    drawHorizon();

    // Cave mouth for the bonus round: a lit hole in the ground
    if (state.cave.placed && !state.cave.taken) {
      const pc = project(state.cave.x, state.cave.y);
      if (pc.y > -30 && pc.y < VIEW_H + 30) {
        const glow = 0.5 + 0.5 * Math.sin(state.frameTick * 0.15);
        ctx.fillStyle = `rgba(225,29,143,${0.18 + 0.15 * glow})`;
        ctx.beginPath();
        ctx.ellipse(pc.x, pc.y, 27 * pc.s, 16 * pc.s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#000";
        ctx.beginPath();
        ctx.ellipse(pc.x, pc.y, 20 * pc.s, 11 * pc.s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = glow > 0.5 ? "#f0abfc" : "#22d3ee";
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = "#1a0b2e";
        ctx.beginPath();
        ctx.ellipse(pc.x, pc.y + 3 * pc.s, 13 * pc.s, 6 * pc.s, 0, 0, Math.PI * 2);
        ctx.fill();
        if ((state.frameTick >> 4) & 1) {
          ctx.font = "bold 8px monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = "#f0abfc";
          ctx.fillText("BONUS", pc.x, pc.y - 24 * pc.s);
          ctx.textAlign = "left";
        }
      }
    }

    // Draw ground/priority entities first, then aerial entities
    GROUND_VIEW = !!state.wave; // in the horizon view what stands on the ground recedes with it
    for (const ent of state.entities) {
      if (ent.aniKey && (ent.flagsLo & 0x08) === 0) {
        drawSprite(ctx, ent.aniKey, ent.frame, ent.x, ent.y, camX, camY, ent.flash > 0, ent.mir);
      }
    }
    GROUND_VIEW = false;
    if (state.boss && state.boss.lurk) {
      // the boss waits behind the wall of ships
      const pl = project(state.scrollX + state.boss.lat, state.scrollY - VIEW_H + state.boss.depth);
      ctx.globalAlpha = 0.55;
      drawBoss(state.boss, pl.x, pl.y, pl.s, 0);
      ctx.globalAlpha = 1;
    }
    for (const ent of state.entities) {
      if (ent.aniKey && (ent.flagsLo & 0x08) !== 0) {
        drawSprite(ctx, ent.aniKey, ent.frame, ent.x, ent.y, camX, camY, ent.flash > 0, ent.mir);
      }
    }

    for (const ent of state.entities) {
      if (!ent.sea) continue;
      const ps = project(ent.x, ent.y);
      if (ps.y < -30 || ps.y > VIEW_H + 30) continue;
      ctx.save();
      ctx.translate(ps.x, ps.y);
      ctx.scale(ps.s, ps.s);
      drawSea(ent.sea, 0, 0, state.frameTick + ent.id, ent.flash > 0, false, 1, true, ent.rot || 0);
      ctx.restore();
    }
    for (const ent of state.entities) {
      if (!ent.elite || !ent.alive) continue;
      const pe = project(ent.x, ent.y);
      if (pe.y > -20 && pe.y < VIEW_H + 20) drawEliteMark(pe.x, pe.y, pe.s, ent.hp, ent.maxHp, state.frameTick + ent.id);
    }
    if (state.boss && !state.boss.gone && !state.boss.lurk) {
      const pbs = project(state.scrollX + state.boss.lat, state.scrollY - VIEW_H + state.boss.depth);
      drawBoss(state.boss, pbs.x, pbs.y, pbs.s, 0);
    }

    // Player bullets
    for (const b of state.playerBullets) {
      const pb = project(b.x, b.y);
      ctx.save();
      ctx.translate(pb.x, pb.y);
      ctx.scale(pb.s, pb.s);
      ctx.rotate(Math.atan2(b.vx, -b.vy));
      if (b.homing) {
        ctx.fillStyle = "rgba(251, 146, 60, 0.6)";
        ctx.fillRect(-1, 3, 2, 7);
        ctx.fillStyle = "#e2e8f0";
        ctx.fillRect(-1.5, -4, 3, 7);
        ctx.restore();
        continue;
      }
      ctx.fillStyle = state.powerups.superShot > 0 ? "#ff6600" : laserColor();
      ctx.fillRect(b.pierce ? -1.5 : -1, -5, b.pierce ? 3 : 2, b.pierce ? 12 : 9);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(-0.5, -4, 1, 6);
      ctx.restore();
    }

    // Shield pick-ups (gentle pulse so they read as collectable)
    for (const pk of state.pickups) {
      const pulse = 1 + 0.08 * Math.sin(pk.age * 0.25);
      if (pk.kind === "rapid") {
        drawSprite(ctx, "icons", pk.age >> 2, pk.x + 6, pk.y + 6, camX, camY);
        continue;
      }
      if (pk.kind === "nova") {
        const pn = project(pk.x, pk.y);
        ctx.fillStyle = "rgba(240,171,252,0.35)";
        ctx.beginPath();
        ctx.arc(pn.x, pn.y, 9 * pulse * pn.s, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#f0abfc";
        ctx.beginPath();
        ctx.arc(pn.x, pn.y, 6 * pulse * pn.s, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#020617";
        ctx.font = "bold 8px monospace";
        ctx.fillText("N", pn.x - 2.5, pn.y - 4);
        continue;
      }
      if (!drawHdOnly("shieldpick", pk.x, pk.y, camX, camY, pulse)) {
        const pp = project(pk.x, pk.y);
        ctx.fillStyle = "#22d3ee";
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, 6 * pulse * pp.s, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#083344";
        ctx.font = "bold 8px monospace";
        ctx.fillText("S", pp.x - 2.5, pp.y - 4);
      }
    }

    // Bombs shrink as they fall away toward the ground
    for (const bm of state.bombs) {
      const k = 1 - 0.45 * (bm.t / BOMB_FUSE);
      if (!drawHdOnly("bomb", bm.x, bm.y, camX, camY, k)) {
        const pm = project(bm.x, bm.y);
        ctx.fillStyle = "#1f2937";
        ctx.fillRect(pm.x - 2 * k, pm.y - 5 * k, 4 * k, 10 * k);
      }
    }

    // Enemy bullets (shot.ani)
    for (const eb of state.enemyBullets) {
      drawSprite(ctx, "shot", eb.frame, eb.x, eb.y, camX, camY);
    }

    // Player Fighter (5 banking hardware sprite frames from player_strip.png)
    const p = state.player;
    const pp = project(p.x, p.y);
    if (p.alive) {
      const blinkHide = p.invuln > 0 && ((state.frameTick >> 1) & 1) === 1;
      if (!blinkHide) {
        const pose = Math.max(0, Math.min(4, Math.round(p.bank + 2)));
        ctx.save();
        ctx.translate(pp.x, pp.y);
        ctx.scale(pp.s, pp.s);
        drawShip(pose);
        ctx.restore();
      }
      if (state.shieldFlash > 0) {
        ctx.strokeStyle = `rgba(34, 211, 238, ${Math.min(1, state.shieldFlash / 12)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, (17 + (24 - state.shieldFlash) * 0.25) * pp.s, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (state.powerups.shield > 0) {
        ctx.strokeStyle = ((state.frameTick >> 1) & 1) ? "#4ade80" : "#bbf7d0";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, 15 * pp.s, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Explosions (explosion.ani)
    for (const ex of state.explosions) {
      drawSprite(ctx, "explosion", Math.floor(ex.frame), ex.x, ex.y, camX, camY);
    }

    drawSparks(project);

    // Popups
    ctx.font = "bold 8px monospace";
    for (const pop of state.popups) {
      const po = project(pop.x, pop.y);
      ctx.fillStyle = "#fbbf24";
      ctx.fillText(pop.text, Math.round(po.x) - 10, Math.round(po.y));
    }

    // Stage progress gauge on right margin
    const pct = Math.max(0, Math.min(1, (START_SCROLL_Y - state.scrollY) / (START_SCROLL_Y - END_SCROLL_Y)));
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(VIEW_W - 5, 10, 3, VIEW_H - 20);
    ctx.fillStyle = "#38bdf8";
    ctx.fillRect(VIEW_W - 5, 10 + Math.round((1 - pct) * (VIEW_H - 20)), 3, 4);

    ctx.restore();
    if (dive && fall > 0) {
      // wind streaks, the dark closing in, and a flash as we go through
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = 0.4 + 0.6 * fall;
      for (let i = 0; i < 60; i++) {
        ctx.strokeStyle = `hsla(${(i * 47 + dive.t * 9) % 360},100%,65%,${0.25 + 0.6 * fall})`;
        const a = i * 2.399 + dive.t * 0.05;
        const r0 = (40 + ((i * 37 + dive.t * 14) % 160)) * (0.6 + fall);
        ctx.beginPath();
        ctx.moveTo(VIEW_W / 2 + Math.cos(a) * r0, VIEW_H * 0.55 + Math.sin(a) * r0);
        ctx.lineTo(VIEW_W / 2 + Math.cos(a) * r0 * (1.25 + fall), VIEW_H * 0.55 + Math.sin(a) * r0 * (1.25 + fall));
        ctx.stroke();
      }
      ctx.restore();
      bloom(0.5 * (1 - fall * fall));
      ctx.fillStyle = `rgba(0,0,0,${Math.min(1, fall * fall * 1.15)})`;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      if (fall > 0.9) {
        ctx.fillStyle = `rgba(240,171,252,${(fall - 0.9) * 6})`;
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      }
    }
    if (state.boss && !state.boss.gone && !state.boss.lurk) drawBossBar(state.boss, 6);
    }

    drawStock();
    if (state.novaFlash > 0) {
      ctx.fillStyle = `rgba(255,240,255,${(state.novaFlash / 26) * 0.85})`;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }

    ctx.save();
    ctx.scale(ZOOM, ZOOM); // message boxes stay the same size on screen however far out the camera is
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.translate(UI_OX, Math.floor((VIEW_H / ZOOM - UI_H) / 2));
    if (state.screen === "dealer") {
      ctx.fillStyle = "rgba(4,6,12,0.9)";
      ctx.fillRect(10, 3, 300, 194);
      ctx.strokeStyle = "#e11d8f";
      ctx.lineWidth = 1;
      ctx.strokeRect(10.5, 3.5, 299, 193);
      ctx.strokeStyle = "#22d3ee";
      ctx.strokeRect(12.5, 5.5, 295, 189);
      ctx.fillStyle = "#f0abfc";
      ctx.font = "bold 11px monospace";
      ctx.fillText("BLACK MARKET // ARMS DEALER", 22, 10);
      ctx.font = "bold 9px monospace";
      ctx.fillStyle = "#a3e635";
      ctx.fillText(`CREDITS ${state.credits}`, 22, 24);
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(`"${state.dealerMsg}"`, 110, 24);
      UPGRADES.forEach((item, i) => {
        const y = 37 + i * 10;
        const sel = i === state.dealerSel;
        const grade = up(item.id);
        const locked = shownLevel() < item.from;
        const maxed = grade >= item.prices.length;
        if (sel) {
          ctx.fillStyle = "rgba(34,211,238,0.14)";
          ctx.fillRect(18, y - 1, 284, 10);
        }
        ctx.fillStyle = locked ? "#475569" : sel ? "#22d3ee" : "#e2e8f0";
        ctx.fillText(`${sel ? ">" : " "} ${item.name}`, 20, y);
        for (let g = 0; g < item.prices.length; g++) {
          ctx.fillStyle = g < grade ? "#a3e635" : "#334155";
          ctx.fillRect(150 + g * 9, y + 1, 7, 6);
        }
        ctx.fillStyle = locked ? "#475569" : maxed ? "#a3e635" : state.credits >= item.prices[grade] ? "#fbbf24" : "#f87171";
        ctx.fillText(locked ? `FROM LEVEL ${item.from}` : maxed ? "MAXED" : `${item.prices[grade]} CR`, 200, y);
      });
      const leaveY = 37 + UPGRADES.length * 10 + 2;
      const leaveSel = state.dealerSel === UPGRADES.length;
      if (leaveSel) {
        ctx.fillStyle = "rgba(34,211,238,0.14)";
        ctx.fillRect(18, leaveY - 1, 284, 10);
      }
      ctx.fillStyle = leaveSel ? "#22d3ee" : "#e2e8f0";
      ctx.fillText(`${leaveSel ? ">" : " "} BACK TO THE FIGHT`, 20, leaveY);
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(leaveSel ? "Take off again" : UPGRADES[state.dealerSel].desc, 22, 172);
      ctx.fillStyle = "#64748b";
      ctx.fillText("UP/DOWN CHOOSE   FIRE BUY   ESC/START LEAVE", 22, 184);
    } else if (state.paused) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(96, 86, 128, 28);
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 12px monospace";
      ctx.fillText("PAUSED", 136, 95);
    } else if (state.screen === "stage_clear") {
      ctx.fillStyle = "rgba(0,0,0,0.72)";
      ctx.fillRect(58, 76, 204, 48);
      ctx.fillStyle = "#4ade80";
      ctx.font = "bold 12px monospace";
      ctx.fillText(`LEVEL ${shownLevel()} COMPLETE!`, 88, 86);
      ctx.fillStyle = "#fbbf24";
      ctx.font = "10px monospace";
      ctx.fillText(`STAGE BONUS: +${2500 * state.level}`, 92, 104);
      if (state.stateTimer <= 0) ctx.fillText("LOADING NEXT WORLD...", 98, 116);
    } else if (state.screen === "game_over") {
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(72, 78, 176, 44);
      ctx.fillStyle = "#f87171";
      ctx.font = "bold 14px monospace";
      ctx.fillText("GAME OVER", 118, 88);
      ctx.fillStyle = "#cbd5e1";
      ctx.font = "9px monospace";
      ctx.fillText("PRESS SPACE FOR MENU", 98, 107);
    }
    ctx.restore();

    drawHud();
  }

  // Between a top-down level and a side-on one the camera swings round in one move: the old view tips away until
  // it is edge-on, and the new one swings up from edge-on, so it reads as dropping down beside the ground (or
  // climbing back above it) rather than a cut.
  const SWAP_LEN = 60; // ticks
  const swapCv = [document.createElement("canvas"), document.createElement("canvas")];
  function snapshotView() {
    const c = swapCv[0];
    c.width = canvas.width;
    c.height = canvas.height;
    c.getContext("2d").drawImage(canvas, 0, 0);
  }

  function render() {
    const sw = state.swap;
    if (!sw || !state.loaded) {
      renderScene();
      return;
    }
    const e = Math.min(1, sw.t / SWAP_LEN);
    const W = canvas.width;
    const H = canvas.height;
    let src = swapCv[0];
    if (e >= 0.5) {
      renderScene();
      const c = swapCv[1];
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
      }
      const cx = c.getContext("2d");
      cx.globalCompositeOperation = "copy";
      cx.drawImage(canvas, 0, 0);
      src = c;
    }
    const k = e < 0.5 ? e / 0.5 : (1 - e) / 0.5;
    const tip = k * k * (3 - 2 * k); // 0 flat .. 1 edge-on .. 0 flat
    const dir = (sw.toSide ? 1 : -1) * (e < 0.5 ? 1 : -1);
    const hinge = H * (sw.toSide ? 0.7 : 0.3);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.translate(W / 2, hinge);
    ctx.rotate(dir * 0.2 * tip);
    ctx.transform(1, 0, dir * 0.4 * tip, 1, 0, 0);
    ctx.scale(1 + 1.1 * tip, Math.max(0.015, Math.cos((tip * Math.PI) / 2)));
    ctx.drawImage(src, -W / 2, -hinge);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 46; i++) {
      const yy = rnd(i, 3) * H;
      const xx = ((rnd(i, 7) * W + sw.t * (40 + 60 * rnd(i, 9)) * (sw.toSide ? 1 : -1)) % W + W) % W;
      ctx.strokeStyle = `hsla(${(i * 37 + sw.t * 6) % 360},100%,65%,${0.55 * tip})`;
      ctx.beginPath();
      ctx.moveTo(xx, yy);
      ctx.lineTo(xx - (60 + 240 * tip) * (sw.toSide ? 1 : -1), yy);
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(190,235,255,${Math.max(0, tip - 0.8) * 2})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    ctx.imageSmoothingEnabled = false;
  }

  // --- Bootstrap Assets & 50 Hz Fixed-Timestep Loop ---
  async function init() {
    const loads = [];
    loads.push(loadImage(A.titlePng).then((img) => { images.__title = img; }));
    for (const [k, src] of Object.entries(A.tiles)) {
      loads.push(loadImage(src).then((img) => { tileImages[k] = img; }));
    }
    for (const [k, src] of Object.entries(A.sprites)) {
      loads.push(loadImage(src).then((img) => { images[k] = img; }));
    }
    if (HDM) {
      for (const [k, src] of Object.entries(HDM.maps)) {
        loads.push(loadImage(src).then((img) => { hdMapImages[k] = img; }));
      }
      for (const [k, src] of Object.entries(window.SIDEWINDER_HD_FX || {})) {
        loads.push(loadImage(src).then((img) => { hdFxImages[k] = img; }));
      }
      for (const [k, spr] of Object.entries(HDM.rubble)) {
        loads.push(loadImage(spr.src).then((img) => { hdRubbleImages[k] = img; }));
      }
    }
    if (HD && HD.title) {
      loads.push(loadImage(HD.title).then((img) => { images.__titleHd = img; }));
    }
    if (HD) {
      for (const [k, spr] of Object.entries(HD.sprites)) {
        loads.push(loadImage(spr.src).then((img) => { hdImages[k] = img; }));
      }
    }
    for (const [k, b64] of Object.entries(A.maps)) {
      maps[k] = b64ToBytes(b64);
    }
    await Promise.all(loads);
    state.loaded = true;

    let last = performance.now();
    let accum = 0;
    let wasFlying = false;
    function frame(now) {
      const dt = Math.min(100, now - last);
      last = now;
      accum += dt;
      applyZoom();
      while (accum >= PAL_TICK_MS) {
        accum -= PAL_TICK_MS;
        stepGame();
        sound.tickBgm(PAL_TICK_MS / 1000, state.screen === "playing" && !state.paused);
      }
      render();
      // the page's buttons and hints sit over the picture, and get out of the way while you fly
      // each scene has its own background sound; it follows the SFX switch
      const inLevel = state.screen === "playing" || state.screen === "side" || state.screen === "dive" || state.screen === "dealer" || state.screen === "stage_clear";
      sound.ambient(!sound.sfxEnabled || state.paused ? null : state.screen === "bonus" ? "cave" : inLevel ? `level${worldFor(state.level, state.loopCount) || (state.side ? sideTheme() : baseLevel())}` : null);
      const flying = ((state.screen === "playing" || state.screen === "side") && !state.paused) || state.screen === "dive" || state.screen === "dealer" || state.screen === "bonus";
      if (flying !== wasFlying) {
        wasFlying = flying;
        document.body.classList.toggle("playing", flying);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  init().catch((err) => {
    console.error("Failed to initialize SideWinder assets:", err);
  });
})();
