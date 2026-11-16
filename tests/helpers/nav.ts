import type { Page } from '@playwright/test';

// A module lists the screens of one group at a time, the way the handover's own menu does, so a
// screen in another group needs that group opened first. A group that is already open is left
// alone: clicking its heading would close it again. Works for any module with a screen tree.
export async function openScreen(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true });
  const heads = page.locator('.module-group-head');
  // The menu appears once the module's master data has loaded.
  await heads.first().waitFor({ state: 'visible', timeout: 20000 });
  if (await tab.count()) {
    await tab.first().click();
    return;
  }
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < (await heads.count()); i++) {
      const head = heads.nth(i);
      if ((await head.getAttribute('aria-expanded')) === 'true') continue;
      await head.click();
      try {
        await tab.first().waitFor({ state: 'visible', timeout: 5000 });
      } catch {
        continue;
      }
      await tab.first().click();
      return;
    }
  }
  throw Error(`The open module has no screen called "${name}".`);
}
