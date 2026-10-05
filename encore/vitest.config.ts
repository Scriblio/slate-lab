import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Every test that starts the app runs without the license check, as `npm run demo` does. The tests of
    // licensing itself ask for it, with an option on createApp, which wins over this.
    env: { ENCORE_LICENSE: 'off' },
  },
});
