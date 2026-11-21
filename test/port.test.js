import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { load as loadHtml } from 'cheerio';

const withoutCurrentLink = (html) => { const $ = loadHtml(html); $('a[href$="002047258.xlsx"]').remove(); return $.html(); };
import { workbookLinks, parseWorkbook, FormatError, sanitize } from '../src/port.js';
import { run } from '../src/run.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));

test('workbook links are identified by label', () => {
    const html = fx('page.html').toString('utf8');
    assert.deepEqual(workbookLinks(html), {
        current: 'https://www.mlit.go.jp/kowan/content/002047258.xlsx',
        archive: 'https://www.mlit.go.jp/kowan/content/002047261.xlsx',
    });
    const noCurrent = withoutCurrentLink(html);
    assert.equal(workbookLinks(noCurrent).current, null);
});

test('current workbook: 7 rows x 3 flows, totals consistent', async () => {
    const rows = await parseWorkbook(fx('current.xlsx'));
    assert.equal(rows.length, 21);
    const total = rows.find((r) => r.portJa === '合計' && r.flow === 'total');
    assert.equal(total.weekStart, '2026-11-02');
    assert.equal(total.weekEnd, '2026-11-08');
    assert.equal(total.aggregatedOn, '2026-11-20');
    assert.equal(total.teu, 299583.5);
    const ports = rows.filter((r) => r.portJa !== '合計' && r.flow === 'total');
    assert.ok(Math.abs(ports.reduce((s, r) => s + r.teu, 0) - total.teu) < 1);
    const tokyo = rows.filter((r) => r.port === 'Tokyo');
    assert.ok(Math.abs(tokyo.find((r) => r.flow === 'export').teu + tokyo.find((r) => r.flow === 'import').teu - tokyo.find((r) => r.flow === 'total').teu) < 1);
});

test('archive workbook: one sheet per week', async () => {
    const rows = await parseWorkbook(fx('past.xlsx'));
    const weeks = new Set(rows.map((r) => r.weekStart));
    assert.ok(weeks.size >= 5);
    assert.equal(rows.length, weeks.size * 21);
});

test('unexpected layouts fail clearly', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fx('current.xlsx'));
    wb.worksheets[0].getCell('C5').value = '個数';
    const buf = await wb.xlsx.writeBuffer();
    await assert.rejects(parseWorkbook(buf), /unexpected header/);
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(fx('current.xlsx'));
    wb2.worksheets[0].getCell('B9').value = '千葉港';
    await assert.rejects(parseWorkbook(await wb2.xlsx.writeBuffer()), /unknown port/);
});

async function exec(input, state = new Map()) {
    const records = [];
    const lifecycle = [];
    const files = { 'https://www.mlit.go.jp/kowan/kowan_fr3_000045.html': fx('page.html'), 'https://www.mlit.go.jp/kowan/content/002047258.xlsx': fx('current.xlsx'), 'https://www.mlit.go.jp/kowan/content/002047261.xlsx': fx('past.xlsx') };
    await run({
        actor: {
            init: async () => {}, getInput: async () => input,
            openKeyValueStore: async () => ({ getValue: async (k) => structuredClone(state.get(k) ?? null), setValue: async (k, v) => { state.set(k, structuredClone(v)); } }),
            pushData: async (r) => records.push(...r), setValue: async () => {}, exit: async () => lifecycle.push('exit'), fail: async (m) => lifecycle.push('fail', m),
        },
        log: { info() {}, warning() {}, error() {} },
        fetchImpl: async (u) => (files[u] ? new Response(files[u]) : new Response('no', { status: 404 })),
        sleep: async () => {},
    });
    return { records, lifecycle };
}

test('run: filters, newest first, monitoring', async () => {
    const r = await exec({ ports: ['Yokohama'], flows: ['export'] });
    assert.deepEqual(r.lifecycle, ['exit']);
    assert.ok(r.records.every((x) => x.port === 'Yokohama' && x.flow === 'export'));
    assert.equal(r.records[0].weekStart, '2026-11-02');
    const state = new Map();
    const a = await exec({ onlyNew: true, includeArchive: false }, state);
    assert.equal(a.records.length, 21);
    const b = await exec({ onlyNew: true, includeArchive: false }, state);
    assert.equal(b.records.length, 0);
    assert.match((await exec({ ports: ['Chiba'] })).lifecycle[1], /Unknown port/);
});

test('sanitize', () => {
    const p = ['C:', 'Users', 'someone', 'x'].join('\\');
    assert.equal(sanitize(`ENOENT ${p}`), 'ENOENT <path>');
});

test('duplicate columns/ports, blanks, booleans and percent formats are handled strictly', async () => {
    const load = async () => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(fx('current.xlsx')); return wb; };
    let wb = await load();
    wb.worksheets[0].getCell('D5').value = 'コンテナ個数';
    await assert.rejects(parseWorkbook(await wb.xlsx.writeBuffer()), /duplicate column/);
    wb = await load();
    wb.worksheets[0].getCell('B9').value = '東京港';
    await assert.rejects(parseWorkbook(await wb.xlsx.writeBuffer()), /duplicate port/);
    wb = await load();
    wb.worksheets[0].getCell('C8').value = '   ';
    let rows = await parseWorkbook(await wb.xlsx.writeBuffer());
    assert.equal(rows.find((r) => r.port === 'Tokyo' && r.flow === 'total').teu, null);
    wb = await load();
    wb.worksheets[0].getCell('C8').value = false;
    await assert.rejects(parseWorkbook(await wb.xlsx.writeBuffer()), /unexpected value/);
    wb = await load();
    const d8 = wb.worksheets[0].getCell('D8');
    d8.value = 0.9357177643; d8.numFmt = '0.00%';
    rows = await parseWorkbook(await wb.xlsx.writeBuffer());
    assert.ok(Math.abs(rows.find((r) => r.port === 'Tokyo' && r.flow === 'total').vsPreviousWeekPct - 93.57177643) < 1e-6);
});

test('monitoring: rows dropped by the spending limit are not marked as seen; missing current link fails', async () => {
    const state = new Map();
    const files = { 'https://www.mlit.go.jp/kowan/kowan_fr3_000045.html': fx('page.html'), 'https://www.mlit.go.jp/kowan/content/002047258.xlsx': fx('current.xlsx'), 'https://www.mlit.go.jp/kowan/content/002047261.xlsx': fx('past.xlsx') };
    const mk = (pushImpl, input, filesMap = files) => {
        const lifecycle = [];
        return run({
            actor: {
                init: async () => {}, getInput: async () => input,
                openKeyValueStore: async () => ({ getValue: async (k) => structuredClone(state.get(k) ?? null), setValue: async (k, v) => { state.set(k, structuredClone(v)); } }),
                pushData: pushImpl, setValue: async () => {}, exit: async () => lifecycle.push('exit'), fail: async (m) => lifecycle.push('fail', m),
            },
            log: { info() {}, warning() {}, error() {} },
            fetchImpl: async (u) => (filesMap[u] ? new Response(filesMap[u]) : new Response('no', { status: 404 })),
            sleep: async () => {},
        }).then(() => lifecycle);
    };
    await mk(async () => ({ eventChargeLimitReached: true, chargedCount: 1 }), { onlyNew: true, includeArchive: false });
    assert.equal(Object.keys(state.get('rows-default')).length, 1);
    const stored = [];
    await mk(async (r) => { stored.push(...r); }, { onlyNew: true, includeArchive: false });
    assert.equal(stored.length, 20);
    const html = withoutCurrentLink(fx('page.html').toString('utf8'));
    const lifecycle = await mk(async () => {}, { includeArchive: false }, { ...files, 'https://www.mlit.go.jp/kowan/kowan_fr3_000045.html': Buffer.from(html) });
    assert.match(lifecycle[1], /current weekly report link/);
});

test('round 3: own-key lookups, error cells, quoted % formats, exact link labels', async () => {
    const load = async () => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(fx('current.xlsx')); return wb; };
    let wb = await load();
    wb.worksheets[0].getCell('B9').value = 'constructor';
    await assert.rejects(parseWorkbook(await wb.xlsx.writeBuffer()), /unknown port/);
    wb = await load();
    wb.worksheets[0].getCell('D8').value = { formula: '1/0', result: { error: '#DIV/0!' } };
    await assert.rejects(parseWorkbook(await wb.xlsx.writeBuffer()), /cell error/);
    wb = await load();
    wb.worksheets[0].getCell('D8').value = 0;
    let rows = await parseWorkbook(await wb.xlsx.writeBuffer());
    assert.equal(rows.find((r) => r.port === 'Tokyo' && r.flow === 'total').vsPreviousWeekPct, 0);
    wb = await load();
    wb.worksheets[0].getCell('D8').numFmt = '0.00"%"';
    rows = await parseWorkbook(await wb.xlsx.writeBuffer());
    assert.ok(Math.abs(rows.find((r) => r.port === 'Tokyo' && r.flow === 'total').vsPreviousWeekPct - 93.57177643) < 1e-6);
    wb = await load();
    wb.worksheets[0].getCell('C8').numFmt = '0.00%';
    await assert.rejects(parseWorkbook(await wb.xlsx.writeBuffer()), /TEU value with a percent format/);
    const $ = loadHtml(fx('page.html').toString('utf8'));
    $('a[href$="002047258.xlsx"]').text('コンテナ貨物流動週報について');
    assert.equal(workbookLinks($.html()).current, null);
});
