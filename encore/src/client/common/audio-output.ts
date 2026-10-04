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

export interface OutputDevice {
  id: string;
  label: string;
}

/**
 * The speakers this computer has. Names only show once the app has been
 * allowed to listen for a microphone, so we ask once, quietly, and fall back
 * to "Output 1, 2…" if it's refused.
 */
export async function listOutputDevices(): Promise<OutputDevice[]> {
  const md = navigator.mediaDevices;
  if (!md?.enumerateDevices) return [];
  const read = async () => (await md.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
  let devices = await read();
  if (devices.length && devices.every((d) => !d.label) && md.getUserMedia) {
    try {
      (await md.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
      devices = await read();
    } catch {
      // No microphone, or it's blocked: the generic names will do.
    }
  }
  return devices.map((d, i) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'System default' : `Output ${i + 1}`) }));
}
