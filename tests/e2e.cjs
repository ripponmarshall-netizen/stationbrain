// End-to-end tests for StationBrain. Run: npm test
// Spins up a static server for the repo root and drives the app in Chromium.
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (err) { results.push([false, name, err]); console.log(`  ✗ ${name}\n    ${String(err && err.stack || err).split('\n').slice(0, 4).join('\n    ')}`); }
}

(async () => {
  const server = await startServer();
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  async function newPage(opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...opts });
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
    await page.goto(`${BASE}/index.html`);
    return { ctx, page };
  }
  const logCount = page => page.evaluate(() => JSON.parse(localStorage.getItem('stationbrain_log') || '[]').length);
  const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  async function fillIncident(page, overrides = {}) {
    await page.click('[data-mode="incident"]');
    await page.click('[data-field="incidentType"][data-value="house_fire"]');
    await page.fill('#f_timeCall', overrides.timeCall || '14:30');
    await page.fill('#f_loc', overrides.loc || '12 King Street, Port Antonio');
    if (overrides.notes) await page.fill('#f_notes', overrides.notes);
  }

  console.log('Helpers');
  await test('duration handles same-day and overnight returns', async () => {
    const { ctx, page } = await newPage();
    const r = await page.evaluate(() => [duration('14:30', '15:45'), duration('23:30', '00:45'), duration('10:00', '10:20'), duration('', '10:00')]);
    assert.deepEqual(r[0], { mins: 75, nextDay: false, text: '1h 15m' });
    assert.deepEqual(r[1], { mins: 75, nextDay: true, text: '1h 15m' });
    assert.equal(r[2].text, '20 min');
    assert.equal(r[3], null);
    await ctx.close();
  });
  await test('html template escapes interpolations', async () => {
    const { ctx, page } = await newPage();
    const out = await page.evaluate(() => html`<p title="${'"x"'}">${'<b>&'}</p>`.s);
    assert.equal(out, '<p title="&quot;x&quot;">&lt;b&gt;&amp;</p>');
    await ctx.close();
  });

  console.log('Layout & theme');
  for (const scheme of ['light', 'dark']) {
    for (const width of [320, 390, 768]) {
      await test(`home renders cleanly (${scheme}, ${width}px)`, async () => {
        const { ctx, page } = await newPage({ colorScheme: scheme, viewport: { width, height: 800 } });
        assert.equal(await page.getAttribute('html', 'data-theme'), scheme);
        assert.equal(await page.locator('.nav-card').count(), 4);
        assert.ok(await noOverflow(page), 'horizontal overflow');
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });
    }
  }
  await test('manual theme toggle persists across reload and recolours the page', async () => {
    const { ctx, page } = await newPage({ colorScheme: 'light' });
    const bgBefore = await page.evaluate(() => getComputedStyle(document.querySelector('.shell')).backgroundColor);
    await page.click('#themeBtn');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    await page.reload();
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    const bgAfter = await page.evaluate(() => getComputedStyle(document.querySelector('.shell')).backgroundColor);
    assert.notEqual(bgBefore, bgAfter);
    const titleColor = await page.evaluate(() => getComputedStyle(document.querySelector('.nav-title')).color);
    assert.notEqual(titleColor, 'rgb(15, 23, 42)', 'title text still dark on dark background');
    await ctx.close();
  });

  console.log('Incident report');
  await test('required fields block generation and are highlighted', async () => {
    const { ctx, page } = await newPage();
    await page.click('[data-mode="incident"]');
    await page.click('[data-action="generate"]');
    assert.equal(await logCount(page), 0);
    for (const f of ['incidentType', 'timeCall', 'loc']) {
      assert.ok(await page.locator(`[data-wrap="${f}"].invalid`).isVisible(), `${f} not flagged`);
    }
    await page.fill('#f_loc', 'x');
    assert.equal(await page.locator('[data-wrap="loc"].invalid').count(), 0, 'error not cleared on input');
    await ctx.close();
  });
  await test('generates report, saves to log, copies text', async () => {
    const { ctx, page } = await newPage();
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await fillIncident(page, { notes: 'Line one\nLine two' });
    await page.fill('#f_timeLeaving', '23:30');
    await page.fill('#f_timeReturn', '00:45');
    assert.match(await page.textContent('[data-duration]'), /1h 15m \(returned next day\)/);
    await page.click('[data-action="generate"]');
    await page.waitForSelector('#report');
    assert.equal(await logCount(page), 1);
    assert.match(await page.textContent('.report-title'), /House Fire/);
    await page.click('[data-action="copy-report"]');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(clip, /REPORT TYPE: INCIDENT REPORT/);
    assert.match(clip, /Address: 12 King Street, Port Antonio/);
    assert.match(clip, /Time Return: 00:45 \(next day\)/);
    assert.match(clip, /Time Out of Station: 1h 15m/);
    assert.match(clip, /Line one\nLine two/);
    assert.ok(await noOverflow(page));
    assert.deepEqual(page.errors, []);
    await ctx.close();
  });
  await test('hostile input is escaped and survives an edit round-trip', async () => {
    const { ctx, page } = await newPage();
    const evil = `He said "hi" <img src=x onerror="document.title='XSS'">`;
    await fillIncident(page, { loc: evil, notes: '<script>document.title="XSS"</script>' });
    await page.click('[data-action="generate"]');
    await page.waitForSelector('#report');
    assert.notEqual(await page.title(), 'XSS');
    assert.equal(await page.locator('#report img').count(), 0);
    await page.click('[data-action="edit-report"]');
    assert.equal(await page.inputValue('#f_loc'), evil);
    await page.goto(`${BASE}/index.html?fresh`);
    await page.click('[data-view="log"]');
    await page.click('.list-item');
    await page.waitForSelector('#report');
    assert.notEqual(await page.title(), 'XSS');
    await ctx.close();
  });
  await test('editing a report updates it instead of duplicating', async () => {
    const { ctx, page } = await newPage();
    await fillIncident(page);
    await page.click('[data-action="generate"]');
    await page.waitForSelector('#report');
    await page.click('[data-action="edit-report"]');
    assert.ok(await page.locator('.banner').isVisible());
    assert.equal((await page.textContent('[data-action="generate"]')).trim(), 'Update Report');
    await page.fill('#f_loc', '99 Harbour Street');
    await page.click('[data-action="generate"]');
    await page.waitForSelector('#report');
    assert.equal(await logCount(page), 1);
    assert.match(await page.textContent('.report-sub'), /99 Harbour Street/);
    assert.match(await page.textContent('.report-meta'), /Updated/);
    await ctx.close();
  });
  await test('changing incident type keeps scroll position and swaps sections', async () => {
    const { ctx, page } = await newPage();
    await page.click('[data-mode="incident"]');
    const house = page.locator('section:has-text("House Fire Details")');
    const vehicle = page.locator('section:has-text("Vehicle Details")');
    assert.ok(!(await house.isVisible()) && !(await vehicle.isVisible()));
    await page.click('[data-field="incidentType"][data-value="house_fire"]');
    assert.ok(await house.isVisible());
    await page.evaluate(() => window.scrollTo(0, 400));
    // Click through the DOM so Playwright doesn't scroll the chip into view itself.
    await page.evaluate(() => document.querySelector('[data-field="incidentType"][data-value="mva"]').click());
    assert.ok(!(await house.isVisible()) && await vehicle.isVisible());
    assert.equal(await page.evaluate(() => window.scrollY), 400, 'page jumped');
    await ctx.close();
  });
  await test('numeric fields strip non-digits; Now button fills time', async () => {
    const { ctx, page } = await newPage();
    await page.click('[data-mode="incident"]');
    await page.fill('#f_menPresent', '4a');
    assert.equal(await page.inputValue('#f_menPresent'), '4');
    await page.fill('#f_distance', '2.5.1km');
    assert.equal(await page.inputValue('#f_distance'), '2.51');
    await page.click('[data-action="now"][data-field="timeCall"]');
    assert.match(await page.inputValue('#f_timeCall'), /^\d{2}:\d{2}$/);
    await ctx.close();
  });
  await test('insert-time stamps the narrative', async () => {
    const { ctx, page } = await newPage();
    await page.click('[data-mode="incident"]');
    await page.fill('#f_notes', 'Arrived on scene');
    await page.click('[data-action="stamp"][data-field="notes"]');
    assert.match(await page.inputValue('#f_notes'), /^Arrived on scene\n\[\d{2}:\d{2}\] $/);
    await ctx.close();
  });

  console.log('Drafts & navigation');
  await test('draft autosaves and survives a reload', async () => {
    const { ctx, page } = await newPage();
    await page.click('[data-mode="incident"]');
    await page.fill('#f_loc', 'Draft Street');
    await page.waitForTimeout(500);
    await page.reload();
    // Reload restores the view the user was on, with the draft intact.
    assert.equal(await page.inputValue('#f_loc'), 'Draft Street');
    await page.click('#backBtn');
    await page.waitForSelector('[data-mode="incident"]');
    assert.match(await page.textContent('[data-mode="incident"]'), /Draft/);
    await page.click('[data-mode="incident"]');
    assert.equal(await page.inputValue('#f_loc'), 'Draft Street');
    await ctx.close();
  });
  await test('opening and leaving an untouched form does not create a draft', async () => {
    const { ctx, page } = await newPage();
    await page.click('[data-mode="handover"]');
    await page.click('[data-action="home"]');
    await page.waitForSelector('[data-mode="handover"]');
    assert.doesNotMatch(await page.textContent('[data-mode="handover"]'), /Draft/);
    await ctx.close();
  });
  await test('browser back returns from form to home', async () => {
    const { ctx, page } = await newPage();
    await page.click('[data-mode="debriefing"]');
    await page.waitForSelector('#reportForm');
    await page.goBack();
    await page.waitForSelector('[data-mode="debriefing"]');
    await ctx.close();
  });
  await test('clear form resets fields after confirmation', async () => {
    const { ctx, page } = await newPage();
    await page.click('[data-mode="incident"]');
    await page.fill('#f_loc', 'Somewhere');
    await page.click('[data-action="clear-form"]');
    await page.click('#dialogOk');
    await page.waitForFunction(() => document.querySelector('#f_loc') && document.querySelector('#f_loc').value === '');
    await ctx.close();
  });

  console.log('Handover & debrief');
  await test('handover checklist: mark all, toggle off, report statuses', async () => {
    const { ctx, page } = await newPage();
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('[data-mode="handover"]');
    await page.click('[data-field="watch"][data-value="A"]');
    await page.click('[data-field="incomingWatch"][data-value="B"]');
    await page.click('[data-action="check-all"]');
    assert.match(await page.textContent('[data-check-progress]'), /8 of 8 done/);
    await page.click('[data-field="check_Forecast_Done"][data-value="yes"]'); // toggle off
    await page.click('[data-field="check_Unit_Checked"][data-value="no"]');
    assert.match(await page.textContent('[data-check-progress]'), /6 of 8 done · 1 marked No/);
    await page.fill('#f_issues', 'Unit 12 pump pressure low');
    await page.click('[data-action="generate"]');
    await page.waitForSelector('#report');
    assert.match(await page.textContent('.report-sub'), /Watch A → Watch B/);
    await page.click('[data-action="copy-report"]');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal((clip.match(/✅ DONE/g) || []).length, 6);
    assert.match(clip, /Unit Checked: ❌ NO/);
    assert.match(clip, /Forecast Done: ⚠️ NOT STATED/);
    assert.match(clip, /OUTSTANDING ISSUES & DEFECTS\n-+\nUnit 12 pump pressure low/);
    assert.ok(await noOverflow(page));
    await ctx.close();
  });
  await test('debrief omits empty optional sections', async () => {
    const { ctx, page } = await newPage();
    await page.click('[data-mode="debriefing"]');
    await page.fill('#f_notes', 'Good water supply');
    await page.fill('#f_actions', 'Service hose reel');
    await page.click('[data-action="generate"]');
    await page.waitForSelector('#report');
    const text = await page.textContent('#report');
    assert.match(text, /Action Items/);
    assert.doesNotMatch(text, /What Went Well/);
    await ctx.close();
  });

  console.log('Log, legacy data & backup');
  await test('legacy (v2.1) log entries still render and copy', async () => {
    const { ctx, page } = await newPage();
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => localStorage.setItem('stationbrain_log', JSON.stringify([
      { id: 1700000000000, mode: 'handover', narrative: 'Quiet shift', admin: { Watch: 'C', 'District Officer': 'Brown' }, checks: [{ label: 'Unit Checked', status: '✅ DONE' }, { label: 'Forecast Done', status: '❌ NO' }, { label: 'Checklist Signed', status: '⚠️ ?' }], classes: 'BA drill', activities: '', timestamp: '14 Nov 2023, 10:13 pm' },
      { id: 1690000000000, mode: 'incident', narrative: '<b>bold</b>', admin: { Classification: 'MVA', Location: 'Main Rd', Station: 'Buff Bay' }, checks: [], classes: '', activities: '', timestamp: '22 Jul 2023' }
    ])));
    await page.reload();
    await page.click('[data-view="log"]');
    assert.equal(await page.locator('.list-item').count(), 2);
    await page.click('.list-item >> nth=0');
    await page.waitForSelector('#report');
    assert.equal(await page.locator('[data-action="edit-report"]').count(), 0, 'legacy entries have no form to edit');
    assert.match(await page.textContent('#report'), /Quiet shift/);
    assert.equal(await page.locator('.status-yes').count(), 1);
    assert.equal(await page.locator('.status-no').count(), 1);
    assert.equal(await page.locator('.status-unset').count(), 1);
    await page.click('[data-action="copy-report"]');
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /District Officer: Brown/);
    await page.goBack();
    await page.click('.list-item >> nth=1');
    assert.match(await page.textContent('.report-title'), /^MVA$/);
    assert.equal(await page.locator('#report b').count(), 0);
    await ctx.close();
  });
  await test('log search and filter narrow the list', async () => {
    const { ctx, page } = await newPage();
    await fillIncident(page, { loc: 'Alpha Road' });
    await page.click('[data-action="generate"]');
    await page.waitForSelector('#report');
    await page.click('#backBtn');
    await page.click('[data-mode="debriefing"]');
    await page.fill('#f_notes', 'Bravo notes');
    await page.click('[data-action="generate"]');
    await page.waitForSelector('#report');
    await page.click('#backBtn');
    await page.click('[data-view="log"]');
    assert.equal(await page.locator('.list-item').count(), 2);
    await page.fill('#logSearch', 'alpha');
    assert.equal(await page.locator('.list-item').count(), 1);
    await page.fill('#logSearch', '');
    await page.click('[data-filter="debriefing"]');
    assert.equal(await page.locator('.list-item').count(), 1);
    assert.match(await page.textContent('.list-item'), /Debriefing/);
    await ctx.close();
  });
  await test('delete with undo restores the report', async () => {
    const { ctx, page } = await newPage();
    await fillIncident(page);
    await page.click('[data-action="generate"]');
    await page.waitForSelector('#report');
    await page.click('[data-action="delete-report"]');
    await page.waitForSelector('[data-mode="incident"]');
    assert.equal(await logCount(page), 0);
    await page.click('.toast-action');
    assert.equal(await logCount(page), 1);
    await ctx.close();
  });
  await test('export then import round-trips reports without duplicates', async () => {
    const { ctx, page } = await newPage();
    await fillIncident(page);
    await page.click('[data-action="generate"]');
    await page.waitForSelector('#report');
    await page.click('#backBtn');
    await page.click('[data-view="settings"]');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]')]);
    const file = await download.path();
    const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(backup.reports.length, 1);
    await page.setInputFiles('#importFile', file);
    await page.waitForSelector('.toast.show');
    assert.match(await page.textContent('.toast'), /Imported 0 reports · 1 skipped/);
    await page.evaluate(() => localStorage.setItem('stationbrain_log', '[]'));
    await page.setInputFiles('#importFile', file);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('stationbrain_log')).length === 1);
    await ctx.close();
  });
  await test('home station preference pre-fills new incident reports', async () => {
    const { ctx, page } = await newPage();
    await page.click('[data-view="settings"]');
    await page.selectOption('#prefStation', 'Morant Bay');
    await page.click('#backBtn');
    await page.click('[data-mode="incident"]');
    assert.equal(await page.inputValue('#f_respondingStation'), 'Morant Bay');
    await ctx.close();
  });

  console.log('Offline');
  await test('app shell works offline after first visit', async () => {
    const { ctx, page } = await newPage();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); // ensure the page is controlled
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('.nav-card');
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.btn, .nav-card')).borderRadius);
    assert.notEqual(bg, '0px', 'styles missing offline');
    await ctx.close();
  });

  await browser.close();
  server.close();
  const failed = results.filter(r => !r[0]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
