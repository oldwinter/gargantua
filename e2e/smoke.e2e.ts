import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('renderer opens', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('heading', 'GARGANTUA')).toBeVisible();
});
