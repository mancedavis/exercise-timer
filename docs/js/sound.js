// Short beep cues via Web Audio. Created/resumed from a tap (iOS requires it).
// Any failure is swallowed: sound must never stop the timer.
export const CUES = {
  hold_start: [[880, 120]],
  hold_end: [[587, 220]],
  complete: [[659, 160], [784, 160], [1047, 360]],
};

export class Sound {
  /** @param makeContext () => AudioContext-like, or null when unsupported */
  constructor(makeContext, enabled = true) {
    this.makeContext = makeContext;
    this.enabled = enabled;
    this.ctx = null;
    this.active = new Set();   // oscillators scheduled or sounding
  }

  /** Call from a user action (Start, Resume, sound toggle). */
  unlock() {
    if (!this.enabled || !this.makeContext) return;
    try {
      if (!this.ctx) this.ctx = this.makeContext();
      if (this.ctx && this.ctx.state !== 'running' && this.ctx.resume) {
        const p = this.ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
    } catch { this.ctx = null; }
  }

  play(cue) {
    if (!this.enabled || !this.ctx || !CUES[cue]) return;
    try {
      let t = this.ctx.currentTime + 0.01;
      for (const [freq, ms] of CUES[cue]) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.frequency.value = freq;
        const dur = ms / 1000;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.onended = () => this.active.delete(osc);
        osc.start(t);
        osc.stop(t + dur + 0.02);
        this.active.add(osc);
        t += dur + 0.03;
      }
    } catch { /* no audio */ }
  }

  /** Stop everything queued or sounding (pause, stop, leaving the page). */
  cancel() {
    for (const osc of this.active) {
      try { osc.onended = null; osc.stop(0); osc.disconnect(); } catch { /* already stopped */ }
    }
    this.active.clear();
  }
}

export const browserAudio = () => {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  return AC ? () => new AC() : null;
};
