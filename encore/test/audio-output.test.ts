// Windows only gives out the speakers' names once a microphone has been allowed. Encore used to open one every time
// Settings opened, just to read them. Now it lists the speakers without asking for anything, and only opens a
// microphone, for a moment, when the KJ clicks "Show speaker names".

import { describe, expect, it } from 'vitest';
import { listOutputDevices, revealSpeakerNames } from '../src/client/common/audio-output.ts';

const device = (deviceId: string, label: string, kind: MediaDeviceKind = 'audiooutput') => ({ deviceId, label, kind }) as MediaDeviceInfo;

describe('listOutputDevices', () => {
  it('lists only the speakers, and never asks for the microphone', async () => {
    let asked = 0;
    const md = {
      enumerateDevices: async () => [device('default', 'Default - Speakers'), device('a', 'Realtek Speakers'), device('m', 'Yeti Microphone', 'audioinput'), device('c', 'Webcam', 'videoinput')],
      getUserMedia: async () => {
        asked++;
        throw new Error('the microphone must not be opened just to list the speakers');
      },
    };
    const found = await listOutputDevices(md);
    expect(asked).toBe(0);
    expect(found.devices.map((d) => d.label)).toEqual(['Default - Speakers', 'Realtek Speakers']);
    expect(found.namesHidden).toBe(false);
  });

  it('says when the names are hidden, and still gives every speaker a name to pick by', async () => {
    const md = { enumerateDevices: async () => [device('default', ''), device('a', ''), device('b', '')] };
    const found = await listOutputDevices(md);
    expect(found.namesHidden).toBe(true);
    expect(found.devices).toEqual([
      { id: 'default', label: 'System default' },
      { id: 'a', label: 'Output 2' },
      { id: 'b', label: 'Output 3' },
    ]);
  });

  it('has nothing to hide when there are no speakers', async () => {
    expect(await listOutputDevices({ enumerateDevices: async () => [device('m', '', 'audioinput')] })).toEqual({ devices: [], namesHidden: false });
  });

  it('copes with a browser that has no media devices', async () => {
    expect(await listOutputDevices(undefined)).toEqual({ devices: [], namesHidden: false });
    expect(await listOutputDevices({} as MediaDevices)).toEqual({ devices: [], namesHidden: false });
  });
});

describe('revealSpeakerNames', () => {
  it('opens a microphone for a moment, only audio, and closes it again', async () => {
    let constraints: MediaStreamConstraints | undefined;
    let stopped = 0;
    const md = {
      getUserMedia: async (c?: MediaStreamConstraints) => {
        constraints = c;
        return { getTracks: () => [{ stop: () => stopped++ }, { stop: () => stopped++ }] } as unknown as MediaStream;
      },
    };
    expect(await revealSpeakerNames(md)).toBe(true);
    expect(constraints).toEqual({ audio: true }); // never the camera
    expect(stopped).toBe(2); // nothing is left listening
  });

  it('returns false, without throwing, if the microphone is blocked or missing', async () => {
    const refused = { getUserMedia: async () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) };
    expect(await revealSpeakerNames(refused)).toBe(false);
    expect(await revealSpeakerNames(undefined)).toBe(false);
    expect(await revealSpeakerNames({} as MediaDevices)).toBe(false);
  });

  it('is what makes the names show up', async () => {
    let allowed = false;
    const md = {
      enumerateDevices: async () => [device('default', allowed ? 'Default - Speakers' : ''), device('a', allowed ? 'Realtek Speakers' : '')],
      getUserMedia: async () => {
        allowed = true;
        return { getTracks: () => [] } as unknown as MediaStream;
      },
    };
    expect((await listOutputDevices(md)).namesHidden).toBe(true);
    expect(await revealSpeakerNames(md)).toBe(true);
    const found = await listOutputDevices(md);
    expect(found.namesHidden).toBe(false);
    expect(found.devices.map((d) => d.label)).toEqual(['Default - Speakers', 'Realtek Speakers']);
  });
});
