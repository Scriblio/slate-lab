// Which speakers Encore plays through. A KJ's laptop often has the PA or
// mixer on a different output from its own speakers, so the venue screen can
// be pointed at one. Everything that makes sound there (song players, the
// pitch shifter's audio context, break music) registers here, and a change
// reaches all of them, now and for ones made later.

type Sinkable = { setSinkId?: (id: string) => Promise<void> };

let sink = '';
const targets = new Set<WeakRef<Sinkable>>();

async function apply(target: Sinkable): Promise<void> {
  try {
    await target.setSinkId?.(sink);
  } catch (err) {
    // The device was unplugged, or this browser can't switch: stay on the default.
    console.warn('Could not use the chosen audio output:', (err as Error).message);
  }
}

/** Send this media element (or audio context) to the chosen output, and keep it there if the choice changes. */
export function routeToOutput<T extends object>(target: T): T {
  targets.add(new WeakRef(target as Sinkable));
  if (sink) void apply(target as Sinkable);
  return target;
}

/** The chosen device's id, or '' for the system default. */
export function setOutputDevice(id: string | undefined): void {
  const next = id ?? '';
  if (next === sink) return;
  sink = next;
  for (const ref of targets) {
    const t = ref.deref();
    if (t) void apply(t);
    else targets.delete(ref);
  }
}

export function currentOutputDevice(): string {
  return sink;
}

// A speaker that was unplugged and comes back needs picking again.
if (typeof navigator !== 'undefined') {
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (!sink) return;
    for (const ref of targets) {
      const t = ref.deref();
      if (t) void apply(t);
      else targets.delete(ref);
    }
  });
}

/** Two short beeps through the given output (or the system default), so the KJ can hear which speakers it is. */
export async function playTestSound(deviceId: string): Promise<void> {
  const ctx = new AudioContext();
  try {
    if (deviceId) await (ctx as unknown as Sinkable).setSinkId?.(deviceId);
  } catch (err) {
    await ctx.close();
    throw new Error(`Couldn’t use that output: ${(err as Error).message}`);
  }
  const t0 = ctx.currentTime + 0.05;
  [440, 660].forEach((hz, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = hz;
    const at = t0 + i * 0.45;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.25, at + 0.04);
    gain.gain.linearRampToValueAtTime(0, at + 0.38);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.4);
  });
  setTimeout(() => void ctx.close(), 1500);
}

export interface OutputDevice {
  id: string;
  label: string;
}

export interface Speakers {
  devices: OutputDevice[];
  /** True when the names are hidden: the browser only gives them out once a microphone has been allowed. Each speaker is then just "Output 1, 2…". */
  namesHidden: boolean;
}

/** The speakers this computer has. This never asks for anything, so it never touches the microphone. */
export async function listOutputDevices(md: Pick<MediaDevices, 'enumerateDevices'> | undefined = navigator.mediaDevices): Promise<Speakers> {
  if (!md?.enumerateDevices) return { devices: [], namesHidden: false };
  const all = (await md.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
  return {
    devices: all.map((d, i) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'System default' : `Output ${i + 1}`) })),
    namesHidden: all.length > 0 && all.every((d) => !d.label),
  };
}

/**
 * Let the browser show the speakers' names. It only does that once a microphone has been allowed, so this
 * opens one and closes it again straight away. Nothing is listened to or recorded. It is only called when the
 * KJ clicks "Show speaker names" (and again by itself on later visits to Settings, because they said yes).
 * Returns false if there is no microphone or it is blocked.
 */
export async function revealSpeakerNames(md: Pick<MediaDevices, 'getUserMedia'> | undefined = navigator.mediaDevices): Promise<boolean> {
  if (!md?.getUserMedia) return false;
  try {
    (await md.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

// The KJ's yes to "Show speaker names", kept so Settings doesn't ask them again each time it opens.
const NAMES_KEY = 'encore-speaker-names';

export function speakerNamesWanted(): boolean {
  try {
    return localStorage.getItem(NAMES_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberSpeakerNames(on: boolean): void {
  try {
    if (on) localStorage.setItem(NAMES_KEY, '1');
    else localStorage.removeItem(NAMES_KEY);
  } catch {
    // No storage here: they just click the button again next time.
  }
}
