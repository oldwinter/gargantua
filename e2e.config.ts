import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

const app = {
  url: 'http://127.0.0.1:4173',
  command: {
    executable: 'npm',
    args: ['run', 'dev'],
    reuseExisting: true,
  },
};

export default {
  tests: ['e2e/**/*.e2e.ts'],
  assertionTimeout: 20_000,
  targets: [{ name: 'chromium', engine: web(), app }],
} satisfies E2EConfig;
