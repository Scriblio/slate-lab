export function isPatched(xml: string): boolean;
export function patchManifest(xml: string): string;
export function findMakeAppx(env?: Record<string, string | undefined>): string;
export function readManifest(appx: string): string;
export function patchAppx(appx: string, makeappx?: string): boolean;
