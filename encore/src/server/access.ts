// Who may run a show right now, and the promise that a show already running is
// never cut off.
//
// The license says what the plan allows (src/shared/license.ts). But a plan can run
// out at any moment: a trial ends at nine at night, a pass expires mid-song. When it
// does, the show that's running carries on, with its online link and alerts too, until
// the KJ starts a new list or the app is closed. Only then does the plan matter.
//
// So the show that had singers while the plan allowed it holds a "ticket". It's kept
// in memory only: a restart is the end of that show, as far as the plan is concerned.

import type { Access } from '../shared/license.ts';

export class ShowAccess {
  /** The show that had singers while shows were allowed, and the one that had them while Cloud was. */
  private showTicket: string | undefined;
  private cloudTicket: string | undefined;

  /** `plan` is what the license allows now, or undefined when licensing is switched off (everything is). */
  constructor(private plan: () => Access | undefined) {}

  /** Note what's running. Call it whenever the show may have changed, and before deciding anything. */
  observe(showId: string, singers: number): void {
    const plan = this.plan();
    if (!plan || singers === 0) return;
    if (plan.shows) this.showTicket = showId;
    if (plan.cloud) this.cloudTicket = showId;
  }

  /** Singers can join and the KJ can call them up. */
  showOpen(showId: string): boolean {
    const plan = this.plan();
    return !plan || plan.shows || this.showTicket === showId;
  }

  /** Encore Cloud (the online link and lock-screen alerts) is on for this show. */
  cloudOn(showId: string): boolean {
    const plan = this.plan();
    return !plan || plan.cloud || this.cloudTicket === showId;
  }
}
