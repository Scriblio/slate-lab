// A short two-note chime for "you're up", made with Web Audio so there's no
// file to load. Browsers only allow sound after the person has touched the
// page, so the first tap anywhere unlocks it.

let ctx: AudioContext | null = null;

export function unlockChime(): void {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
    }
    void ctx.resume?.();
  } catch {
    // no sound on this device
  }
}

export function chime(): void {
  if (!ctx || ctx.state !== 'running') return;
  const start = ctx.currentTime;
  [880, 1320].forEach((freq, i) => {
    const t = start + i * 0.18;
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.connect(gain).connect(ctx!.destination);
    osc.start(t);
    osc.stop(t + 0.45);
  });
}
