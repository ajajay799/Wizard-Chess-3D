// ============================================================================
// Gothic Cathedral Sound Management System (Web Audio API Procedural Engine)
// Synthesizes atmospheric cathedral wind, echoing stone footsteps, bronze
// clock/bell chimes, brazier fire crackle, and sculpted stone chess SFX.
// ============================================================================

export interface SoundManagerState {
  initialized: boolean;
  running: boolean;
  muted: boolean;
  volume: number; // 0 to 100
  presetLabel: string;
  activeLayers: {
    wind: boolean;
    footsteps: boolean;
    clockChime: boolean;
    brazierFire: boolean;
  };
  chimeCount: number;
  footstepCount: number;
}

export class CathedralSoundManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private reverbNode: ConvolverNode | null = null;
  private dryBus: GainNode | null = null;
  private wetBus: GainNode | null = null;
  private windGain: GainNode | null = null;
  private fireGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private initialized = false;
  private muted = false;
  private volume = 75; // 0 - 100%
  private previousUnmutedVolume = 75;

  private footstepTimer: ReturnType<typeof setTimeout> | null = null;
  private clockChimeTimer: ReturnType<typeof setTimeout> | null = null;
  private fireCrackleTimer: ReturnType<typeof setTimeout> | null = null;

  private chimeCount = 0;
  private footstepCount = 0;
  private lastCamFootstepMs = 0;
  private listeners: Set<(state: SoundManagerState) => void> = new Set();

  constructor() {
    try {
      const savedVol = localStorage.getItem('wizard_chess_volume');
      const savedMuted = localStorage.getItem('wizard_chess_muted');
      if (savedVol !== null) {
        const parsed = Number(savedVol);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 100) {
          this.volume = Math.round(parsed);
          if (this.volume > 0) this.previousUnmutedVolume = this.volume;
        }
      }
      if (savedMuted === 'true') {
        this.muted = true;
      }
    } catch {
      // Ignore storage access errors in restricted iframes
    }
  }

  public subscribe(listener: (state: SoundManagerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const state = this.getState();
    this.listeners.forEach((fn) => {
      try {
        fn(state);
      } catch {
        // Ignore listener errors
      }
    });
  }

  public getState(): SoundManagerState {
    const effectiveVol = this.muted ? 0 : this.volume;
    let presetLabel = 'Muted';
    if (!this.muted && effectiveVol > 0) {
      if (effectiveVol <= 35) presetLabel = 'Low';
      else if (effectiveVol <= 75) presetLabel = 'Medium';
      else presetLabel = 'High';
    }
    const isRunning = Boolean(
      this.initialized && this.ctx && this.ctx.state === 'running' && !this.muted && this.volume > 0
    );
    return {
      initialized: this.initialized,
      running: isRunning,
      muted: this.muted || this.volume === 0,
      volume: this.volume,
      presetLabel,
      activeLayers: {
        wind: isRunning,
        footsteps: isRunning,
        clockChime: isRunning,
        brazierFire: isRunning,
      },
      chimeCount: this.chimeCount,
      footstepCount: this.footstepCount,
    };
  }

  public ensureInitialized(playWelcomeChime = false): boolean {
    if (typeof window === 'undefined') return false;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return false;

    if (!this.ctx) {
      try {
        this.ctx = new AudioCtx();
        this.setupAudioGraph();
        this.initialized = true;
      } catch {
        return false;
      }
    }

    if (this.ctx && this.ctx.state === 'suspended' && !this.muted && this.volume > 0) {
      this.ctx.resume().then(() => {
        this.syncMasterGain();
        this.notify();
      }).catch(() => {});
    }

    this.syncMasterGain();
    this.startAmbientSchedulers();

    if (playWelcomeChime && !this.muted && this.volume > 0 && this.chimeCount === 0) {
      setTimeout(() => {
        if (!this.muted && this.volume > 0) {
          this.triggerClockChime(1);
        }
      }, 350);
    }

    this.notify();
    return true;
  }

  private setupAudioGraph(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    this.masterGain = ctx.createGain();
    const initialGain = this.muted ? 0 : (this.volume / 100) * 0.85;
    this.masterGain.gain.setValueAtTime(initialGain, ctx.currentTime);
    this.masterGain.connect(ctx.destination);

    // Dry and Cathedral Convolver Wet buses
    this.dryBus = ctx.createGain();
    this.dryBus.gain.setValueAtTime(0.65, ctx.currentTime);
    this.dryBus.connect(this.masterGain);

    this.wetBus = ctx.createGain();
    this.wetBus.gain.setValueAtTime(0.55, ctx.currentTime);
    this.reverbNode = ctx.createConvolver();
    this.reverbNode.buffer = this.createCathedralImpulseResponse(3.4, 2.4);
    this.wetBus.connect(this.reverbNode);
    this.reverbNode.connect(this.masterGain);

    // Shared 5-second seamless white/pink noise buffer
    this.noiseBuffer = this.createNoiseBuffer(5.0);

    // 1. Continuous Gothic Cathedral Wind Layer (Dual Bandpass + Slow LFOs)
    this.setupCathedralWindLayer();

    // 2. Continuous Sanctum Brazier Warm Ember Hum Layer
    this.setupBrazierFireLayer();
  }

  private createCathedralImpulseResponse(durationSec: number, decayRate: number): AudioBuffer {
    const ctx = this.ctx!;
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * durationSec);
    const impulse = ctx.createBuffer(2, length, sampleRate);

    // Early stone column reflection tap delays (in seconds)
    const earlyTaps = [0.021, 0.039, 0.063, 0.089, 0.118, 0.154, 0.197];

    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        const env = Math.pow(1 - t / durationSec, decayRate) * Math.exp(-t * 1.15);
        const white = Math.random() * 2 - 1;
        // Warm limestone high-frequency absorption filter
        lp = lp * 0.78 + white * 0.22;
        data[i] = lp * env * 0.48;
      }
      for (let k = 0; k < earlyTaps.length; k++) {
        const idx = Math.floor((earlyTaps[k] + ch * 0.004) * sampleRate);
        if (idx < length) {
          data[idx] += (ch === 0 ? 1 : -1) * (0.32 / (k + 1));
        }
      }
    }
    return impulse;
  }

  private createNoiseBuffer(durationSec: number): AudioBuffer {
    const ctx = this.ctx!;
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * durationSec);
    const buffer = ctx.createBuffer(2, length, sampleRate);

    for (let ch = 0; ch < 2; ch++) {
      const output = buffer.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        // Paul Kellet's pink noise filter for natural atmospheric texture
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        output[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.045;
        b6 = white * 0.115926;
      }
    }
    return buffer;
  }

  private setupCathedralWindLayer(): void {
    if (!this.ctx || !this.noiseBuffer || !this.dryBus || !this.wetBus) return;
    const ctx = this.ctx;

    this.windGain = ctx.createGain();
    this.windGain.gain.setValueAtTime(0.28, ctx.currentTime);
    this.windGain.connect(this.dryBus);
    this.windGain.connect(this.wetBus);

    // Stream A: Deep vault draft (140 Hz - 340 Hz)
    const srcA = ctx.createBufferSource();
    srcA.buffer = this.noiseBuffer;
    srcA.loop = true;

    const filterA = ctx.createBiquadFilter();
    filterA.type = 'bandpass';
    filterA.frequency.setValueAtTime(210, ctx.currentTime);
    filterA.Q.setValueAtTime(3.2, ctx.currentTime);

    const lfoA = ctx.createOscillator();
    lfoA.type = 'sine';
    lfoA.frequency.setValueAtTime(0.065, ctx.currentTime); // ~15s gust cycle
    const lfoGainA = ctx.createGain();
    lfoGainA.gain.setValueAtTime(85, ctx.currentTime);
    lfoA.connect(lfoGainA);
    lfoGainA.connect(filterA.frequency);

    const panA = ctx.createStereoPanner();
    panA.pan.setValueAtTime(-0.35, ctx.currentTime);

    srcA.connect(filterA);
    filterA.connect(panA);
    panA.connect(this.windGain);

    // Stream B: High clerestory window whistle (360 Hz - 680 Hz)
    const srcB = ctx.createBufferSource();
    srcB.buffer = this.noiseBuffer;
    srcB.loop = true;
    srcB.loopStart = 1.3;

    const filterB = ctx.createBiquadFilter();
    filterB.type = 'bandpass';
    filterB.frequency.setValueAtTime(460, ctx.currentTime);
    filterB.Q.setValueAtTime(5.4, ctx.currentTime);

    const lfoB = ctx.createOscillator();
    lfoB.type = 'sine';
    lfoB.frequency.setValueAtTime(0.11, ctx.currentTime); // ~9s breeze cycle
    const lfoGainB = ctx.createGain();
    lfoGainB.gain.setValueAtTime(140, ctx.currentTime);
    lfoB.connect(lfoGainB);
    lfoGainB.connect(filterB.frequency);

    const subGainB = ctx.createGain();
    subGainB.gain.setValueAtTime(0.42, ctx.currentTime);

    const panB = ctx.createStereoPanner();
    panB.pan.setValueAtTime(0.38, ctx.currentTime);

    srcB.connect(filterB);
    filterB.connect(subGainB);
    subGainB.connect(panB);
    panB.connect(this.windGain);

    srcA.start(0);
    lfoA.start(0);
    srcB.start(0);
    lfoB.start(0);
  }

  private setupBrazierFireLayer(): void {
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const ctx = this.ctx;

    this.fireGain = ctx.createGain();
    this.fireGain.gain.setValueAtTime(0.14, ctx.currentTime);
    this.fireGain.connect(this.dryBus);

    const fireSrc = ctx.createBufferSource();
    fireSrc.buffer = this.noiseBuffer;
    fireSrc.loop = true;
    fireSrc.loopStart = 0.6;

    const lowPass = ctx.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.setValueAtTime(145, ctx.currentTime);

    fireSrc.connect(lowPass);
    lowPass.connect(this.fireGain);
    fireSrc.start(0);
  }

  private startAmbientSchedulers(): void {
    if (!this.footstepTimer) {
      const scheduleNextWalk = () => {
        const delayMs = 9000 + Math.random() * 11000;
        this.footstepTimer = setTimeout(() => {
          this.footstepTimer = null;
          if (!this.muted && this.volume > 0 && this.ctx?.state === 'running') {
            this.triggerDistantFootstepWalk();
          }
          scheduleNextWalk();
        }, delayMs);
      };
      scheduleNextWalk();
    }

    if (!this.clockChimeTimer) {
      const scheduleNextChime = () => {
        const delayMs = 28000 + Math.random() * 22000;
        this.clockChimeTimer = setTimeout(() => {
          this.clockChimeTimer = null;
          if (!this.muted && this.volume > 0 && this.ctx?.state === 'running') {
            const strikes = Math.random() < 0.35 ? 2 : 1;
            this.triggerClockChime(strikes);
          }
          scheduleNextChime();
        }, delayMs);
      };
      scheduleNextChime();
    }

    if (!this.fireCrackleTimer) {
      const scheduleNextCrackle = () => {
        const delayMs = 1400 + Math.random() * 2600;
        this.fireCrackleTimer = setTimeout(() => {
          this.fireCrackleTimer = null;
          if (!this.muted && this.volume > 0 && this.ctx?.state === 'running') {
            this.playFireCracklePop();
          }
          scheduleNextCrackle();
        }, delayMs);
      };
      scheduleNextCrackle();
    }
  }

  private playFireCracklePop(): void {
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1800 + Math.random() * 1600, now);
    bp.Q.setValueAtTime(4.0, now);

    const env = ctx.createGain();
    const peak = 0.025 + Math.random() * 0.03;
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(peak, now + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);

    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(Math.random() < 0.5 ? -0.55 : 0.55, now);

    src.connect(bp);
    bp.connect(env);
    env.connect(pan);
    pan.connect(this.dryBus);

    const offset = Math.random() * 3.5;
    src.start(now, offset, 0.06);
  }

  // ==========================================================================
  // Echoing Cathedral Stone Footsteps
  // ==========================================================================
  public triggerFootstep(panPos = 0, intensity = 0.65, pitchScale = 1.0): void {
    if (this.muted || this.volume === 0) return;
    if (!this.ctx) this.ensureInitialized(false);
    if (!this.ctx || !this.dryBus || !this.wetBus || !this.noiseBuffer) return;

    const ctx = this.ctx;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    this.footstepCount += 1;

    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(Math.max(-0.9, Math.min(0.9, panPos)), now);

    const stepDry = ctx.createGain();
    stepDry.gain.setValueAtTime(0.28 * intensity, now);
    const stepWet = ctx.createGain();
    stepWet.gain.setValueAtTime(0.72 * intensity, now);

    panner.connect(stepDry);
    panner.connect(stepWet);
    stepDry.connect(this.dryBus);
    stepWet.connect(this.wetBus);

    // 1. Stone flagstone heel thud (low resonant impact)
    const heelOsc = ctx.createOscillator();
    heelOsc.type = 'triangle';
    const baseFreq = (92 + Math.random() * 18) * pitchScale;
    heelOsc.frequency.setValueAtTime(baseFreq * 1.35, now);
    heelOsc.frequency.exponentialRampToValueAtTime(baseFreq * 0.52, now + 0.095);

    const heelGain = ctx.createGain();
    heelGain.gain.setValueAtTime(0.001, now);
    heelGain.gain.linearRampToValueAtTime(0.22, now + 0.006);
    heelGain.gain.exponentialRampToValueAtTime(0.0008, now + 0.12);

    heelOsc.connect(heelGain);
    heelGain.connect(panner);
    heelOsc.start(now);
    heelOsc.stop(now + 0.13);

    // 2. Limestone sole grit & sole scrape transient
    const gritSrc = ctx.createBufferSource();
    gritSrc.buffer = this.noiseBuffer;

    const gritFilter = ctx.createBiquadFilter();
    gritFilter.type = 'bandpass';
    gritFilter.frequency.setValueAtTime((1150 + Math.random() * 420) * pitchScale, now);
    gritFilter.Q.setValueAtTime(2.6, now);

    const gritGain = ctx.createGain();
    gritGain.gain.setValueAtTime(0.0001, now);
    gritGain.gain.linearRampToValueAtTime(0.18, now + 0.008);
    gritGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.095);

    gritSrc.connect(gritFilter);
    gritFilter.connect(gritGain);
    gritGain.connect(panner);

    const offset = Math.random() * 3.0;
    gritSrc.start(now, offset, 0.11);
    this.notify();
  }

  public triggerDistantFootstepWalk(): void {
    if (this.muted || this.volume === 0) return;
    const steps = 4 + Math.floor(Math.random() * 3);
    const startPan = Math.random() < 0.5 ? -0.75 : 0.75;
    const dir = startPan < 0 ? 0.22 : -0.22;

    for (let i = 0; i < steps; i++) {
      const stepDelay = i * (640 + Math.random() * 90);
      setTimeout(() => {
        if (!this.muted && this.volume > 0) {
          const pan = startPan + dir * i;
          const pitch = i % 2 === 0 ? 0.96 : 1.04;
          this.triggerFootstep(pan, 0.42, pitch);
        }
      }, stepDelay);
    }
  }

  public maybePlayCameraFootstep(): void {
    if (this.muted || this.volume === 0) return;
    const nowMs = performance.now();
    if (nowMs - this.lastCamFootstepMs < 460) return;
    this.lastCamFootstepMs = nowMs;
    const pan = (Math.random() - 0.5) * 0.25;
    const pitch = 0.95 + Math.random() * 0.1;
    this.triggerFootstep(pan, 0.32, pitch);
  }

  // ==========================================================================
  // Gothic Cathedral Bronze Clock / Bell Tower Chime
  // ==========================================================================
  public triggerClockChime(strikes = 1, baseFreq = 220): void {
    if (this.muted || this.volume === 0) return;
    if (!this.ctx) this.ensureInitialized(false);
    if (!this.ctx || !this.dryBus || !this.wetBus) return;

    const ctx = this.ctx;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    for (let s = 0; s < strikes; s++) {
      const strikeOffsetSec = s * 2.35;
      this.scheduleSingleBellStrike(ctx.currentTime + strikeOffsetSec, baseFreq, 0.55);
    }
    this.chimeCount += strikes;
    this.notify();
  }

  private scheduleSingleBellStrike(startTime: number, fundamentalHz: number, level: number): void {
    if (!this.ctx || !this.dryBus || !this.wetBus) return;
    const ctx = this.ctx;

    const bellBus = ctx.createGain();
    bellBus.gain.setValueAtTime(level, startTime);

    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(0.18, startTime);

    bellBus.connect(pan);
    pan.connect(this.dryBus);
    pan.connect(this.wetBus);

    // Authentic Gothic bronze bell partials (Hum, Prime, Tierce, Quint, Nominal, Superquint, Octave)
    const partials = [
      { ratio: 0.5, amp: 0.36, decay: 5.4 },    // Hum tone (octave below)
      { ratio: 1.0, amp: 0.65, decay: 4.2 },    // Prime (fundamental)
      { ratio: 1.189, amp: 0.44, decay: 3.1 },  // Minor third tierce
      { ratio: 1.502, amp: 0.30, decay: 2.4 },  // Quint
      { ratio: 2.0, amp: 0.48, decay: 1.9 },    // Nominal
      { ratio: 2.514, amp: 0.20, decay: 1.25 }, // Upper third
      { ratio: 3.011, amp: 0.15, decay: 0.95 }, // Superquint
    ];

    for (const p of partials) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const freq = fundamentalHz * p.ratio;
      osc.frequency.setValueAtTime(freq, startTime);

      const pGain = ctx.createGain();
      const peakAmp = p.amp * 0.24;
      pGain.gain.setValueAtTime(0.0001, startTime);
      pGain.gain.linearRampToValueAtTime(peakAmp, startTime + 0.012);
      pGain.gain.exponentialRampToValueAtTime(0.0001, startTime + p.decay);

      osc.connect(pGain);
      pGain.connect(bellBus);

      osc.start(startTime);
      osc.stop(startTime + p.decay + 0.05);
    }
  }

  // ==========================================================================
  // Sculpted Stone Chess Piece & Combat Sound Effects
  // ==========================================================================
  public playPieceSelect(): void {
    if (this.muted || this.volume === 0) return;
    if (!this.ctx) this.ensureInitialized(false);
    if (!this.ctx || !this.dryBus || !this.wetBus) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(310, now);
    osc.frequency.exponentialRampToValueAtTime(145, now + 0.065);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.075);

    osc.connect(gain);
    gain.connect(this.dryBus);
    gain.connect(this.wetBus);

    osc.start(now);
    osc.stop(now + 0.08);
  }

  public playStoneSlide(durationSec = 0.72): void {
    if (this.muted || this.volume === 0) return;
    if (!this.ctx) this.ensureInitialized(false);
    if (!this.ctx || !this.dryBus || !this.wetBus || !this.noiseBuffer) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = Math.max(0.25, Math.min(2.2, durationSec));

    // Heavy stone pedestal grinding across marble board
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(280, now);
    bp.frequency.linearRampToValueAtTime(390, now + dur * 0.5);
    bp.frequency.linearRampToValueAtTime(220, now + dur);
    bp.Q.setValueAtTime(2.2, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.06);
    gain.gain.setValueAtTime(0.16, now + Math.max(0.07, dur - 0.08));
    gain.gain.exponentialRampToValueAtTime(0.0005, now + dur);

    src.connect(bp);
    bp.connect(gain);
    gain.connect(this.dryBus);
    gain.connect(this.wetBus);

    src.start(now, Math.random() * 2.0, dur + 0.05);

    // Final stone settle thud when piece lands on target square
    setTimeout(() => {
      if (!this.muted && this.volume > 0) {
        this.triggerFootstep(0, 0.55, 0.88);
      }
    }, Math.round(dur * 880));
  }

  public playWeaponStrike(): void {
    if (this.muted || this.volume === 0) return;
    if (!this.ctx) this.ensureInitialized(false);
    if (!this.ctx || !this.dryBus || !this.wetBus) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Stone-iron weapon clash transient
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(195, now);
    osc.frequency.exponentialRampToValueAtTime(58, now + 0.16);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1400, now);
    filter.frequency.exponentialRampToValueAtTime(240, now + 0.16);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.32, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.18);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.dryBus);
    gain.connect(this.wetBus);

    osc.start(now);
    osc.stop(now + 0.19);
  }

  public playStoneShatter(): void {
    if (this.muted || this.volume === 0) return;
    if (!this.ctx) this.ensureInitialized(false);
    if (!this.ctx || !this.dryBus || !this.wetBus || !this.noiseBuffer) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    // 1. Low stone monument fracture boom
    const subOsc = ctx.createOscillator();
    subOsc.type = 'triangle';
    subOsc.frequency.setValueAtTime(125, now);
    subOsc.frequency.exponentialRampToValueAtTime(36, now + 0.38);

    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.001, now);
    subGain.gain.linearRampToValueAtTime(0.42, now + 0.01);
    subGain.gain.exponentialRampToValueAtTime(0.0008, now + 0.42);

    subOsc.connect(subGain);
    subGain.connect(this.dryBus);
    subGain.connect(this.wetBus);
    subOsc.start(now);
    subOsc.stop(now + 0.44);

    // 2. Cascading limestone shard clatter
    for (let i = 0; i < 5; i++) {
      const delay = 0.03 + i * 0.055 + Math.random() * 0.025;
      const t = now + delay;
      const shardSrc = ctx.createBufferSource();
      shardSrc.buffer = this.noiseBuffer;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(900 + i * 320 + Math.random() * 250, t);
      bp.Q.setValueAtTime(3.5, t);

      const g = ctx.createGain();
      const amp = 0.22 * Math.pow(0.75, i);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(amp, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.11);

      shardSrc.connect(bp);
      bp.connect(g);
      g.connect(this.dryBus);
      g.connect(this.wetBus);
      shardSrc.start(t, Math.random() * 3.0, 0.12);
    }
  }

  public playCheckmateBell(): void {
    if (this.muted || this.volume === 0) return;
    if (!this.ctx) this.ensureInitialized(false);
    if (!this.ctx) return;
    // Deep solemn cathedral funeral toll in D3 (146.8 Hz)
    this.triggerClockChime(2, 146.83);
  }

  public playPieceLiftToTray(): void {
    if (this.muted || this.volume === 0) return;
    if (!this.ctx) this.ensureInitialized(false);
    if (!this.ctx || !this.dryBus || !this.wetBus || !this.noiseBuffer) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Ascending resonant stone levitation sweep as the captured piece is lifted off the board
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(240, now);
    bp.frequency.exponentialRampToValueAtTime(780, now + 0.45);
    bp.frequency.exponentialRampToValueAtTime(320, now + 1.05);
    bp.Q.setValueAtTime(3.8, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.16, now + 0.14);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + 1.08);

    src.connect(bp);
    bp.connect(gain);
    gain.connect(this.dryBus);
    gain.connect(this.wetBus);
    src.start(now, Math.random() * 2.0, 1.12);
  }

  public playTrayDeposit(): void {
    if (this.muted || this.volume === 0) return;
    if (!this.ctx) this.ensureInitialized(false);
    if (!this.ctx || !this.dryBus || !this.wetBus) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Marble tray lock-in thud + subtle golden harmonic
    this.triggerFootstep(0.35, 0.52, 1.18);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(528, now);
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.18);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0005, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.24);

    osc.connect(gain);
    gain.connect(this.dryBus);
    gain.connect(this.wetBus);
    osc.start(now);
    osc.stop(now + 0.26);
  }

  public playClockTick(isCritical = false): void {
    if (this.muted || this.volume === 0) return;
    if (!this.ctx) this.ensureInitialized(false);
    if (!this.ctx || !this.dryBus || !this.wetBus) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = isCritical ? 'triangle' : 'sine';
    const baseFreq = isCritical ? 880 : 620;
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.48, now + 0.038);

    const gain = ctx.createGain();
    const peak = isCritical ? 0.11 : 0.055;
    gain.gain.setValueAtTime(0.0005, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.045);

    osc.connect(gain);
    gain.connect(this.dryBus);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  // ==========================================================================
  // Volume & Mute Controls
  // ==========================================================================
  private syncMasterGain(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const targetGain = this.muted ? 0 : (this.volume / 100) * 0.85;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setTargetAtTime(targetGain, now, 0.04);
  }

  public setVolume(pct: number): number {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    this.volume = clamped;
    if (clamped > 0) {
      this.previousUnmutedVolume = clamped;
      if (this.muted) {
        this.muted = false;
      }
      this.ensureInitialized(false);
    } else {
      this.muted = true;
    }

    try {
      localStorage.setItem('wizard_chess_volume', String(this.volume));
      localStorage.setItem('wizard_chess_muted', String(this.muted));
    } catch {
      // Ignore storage errors
    }

    this.syncMasterGain();
    this.notify();
    return this.volume;
  }

  public getVolume(): number {
    return this.muted ? 0 : this.volume;
  }

  public isMuted(): boolean {
    return this.muted || this.volume === 0;
  }

  public toggleMute(): boolean {
    if (this.muted || this.volume === 0) {
      this.muted = false;
      if (this.volume === 0) {
        this.volume = this.previousUnmutedVolume > 0 ? this.previousUnmutedVolume : 75;
      }
      this.ensureInitialized(true);
    } else {
      this.muted = true;
    }

    try {
      localStorage.setItem('wizard_chess_volume', String(this.volume));
      localStorage.setItem('wizard_chess_muted', String(this.muted));
    } catch {
      // Ignore storage errors
    }

    this.syncMasterGain();
    this.notify();
    return this.muted;
  }
}

export const soundManager = new CathedralSoundManager();
