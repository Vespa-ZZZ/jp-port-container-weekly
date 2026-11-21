// Pure helpers for MLIT's weekly foreign-trade container statistics (外貿コンテナ数（週次）) at Japan's major ports.
// Page: https://www.mlit.go.jp/kowan/kowan_fr3_000045.html  Terms: https://www.mlit.go.jp/link.html (Public Data License 1.0)
import ExcelJS from 'exceljs';
import { load } from 'cheerio';

export const PAGE_URL = 'https://www.mlit.go.jp/kowan/kowan_fr3_000045.html';
export const SOURCE = 'Ministry of Land, Infrastructure, Transport and Tourism (MLIT), Japan — weekly foreign-trade container statistics';

export class FormatError extends Error {}

const FLOWS = { 合計: 'total', 輸出: 'export', 輸入: 'import' };
const METRICS = { コンテナ個数: 'teu', 前週比: 'vsPreviousWeekPct', 前月同週比: 'vsSameWeekLastMonthPct', 前年同週比: 'vsSameWeekLastYearPct' };
export const PORTS_EN = { 合計: 'Total (6 ports)', 東京港: 'Tokyo', 川崎港: 'Kawasaki', 横浜港: 'Yokohama', 名古屋港: 'Nagoya', 大阪港: 'Osaka', 神戸港: 'Kobe' };

/** XLSX links identified by their labels: the current weekly report and the archive of earlier weeks. */
export function workbookLinks(html) {
    const $ = load(html);
    // Each role is identified by its exact label; an ambiguous page fails instead of guessing.
    const current = new Set();
    const archive = new Set();
    $('a[href$=".xlsx"]').each((_, a) => {
        const url = new URL($(a).attr('href'), PAGE_URL);
        if (url.hostname !== 'www.mlit.go.jp') throw new FormatError(`Unexpected link host: ${url.href}`);
        const label = $(a).text().replace(/\s+/g, '');
        if (label === 'コンテナ貨物流動週報') current.add(url.href);
        else if (label === '過去に掲載したコンテナ貨物流動週報データ') archive.add(url.href);
    });
    if (current.size > 1 || archive.size > 1) throw new FormatError('Ambiguous workbook links on the MLIT page');
    const [cur] = current;
    const [arc] = archive;
    if (cur && cur === arc) throw new FormatError('The current and archive links point to the same file');
    return { current: cur ?? null, archive: arc ?? null };
}

const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);

/** Raw cell content: formula results are used directly; error cells are reported. */
const cellContent = (cell) => {
    const v = cell.value;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
        if (v.error) return { error: v.error };
        if ('result' in v) return v.result && typeof v.result === 'object' && v.result.error ? { error: v.result.error } : v.result;
        if (v.richText) return v.richText.map((t) => t.text).join('');
        if ('text' in v) return v.text;
        return { error: v.formula || v.sharedFormula ? 'formula without a cached result' : 'unsupported cell object' };
    }
    return v;
};
const cellValue = (cell) => {
    const v = cellContent(cell);
    return v && typeof v === 'object' && v.error ? null : v;
};

const dashDate = (s) => s.replace(/\//g, '-');
const validDate = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};

/** True when the number format really multiplies by 100 (a % outside quotes and not escaped). */
const isPercentFormat = (fmt) => /%/.test(String(fmt ?? '').replace(/"[^"]*"/g, '').replace(/\\%/g, ''));

/**
 * Number from a cell: empty / blank / "-" -> null, real zero -> 0. Percent-formatted cells (a real % scale) are
 * converted to percent for ratio columns and rejected for TEU columns. Error cells and other types fail.
 */
function numberCell(cell, where, isRatio) {
    const v = cellContent(cell);
    if (v === null || v === undefined) return null;
    if (typeof v === 'object' && v.error) throw new FormatError(`${where}: cell error ${v.error}`);
    if (typeof v === 'number') {
        if (!isPercentFormat(cell.numFmt)) return v;
        if (!isRatio) throw new FormatError(`${where}: TEU value with a percent format`);
        return v * 100;
    }
    if (typeof v === 'string') {
        const s = v.trim();
        if (s === '' || s === '-' || s === '－') return null;
        if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    }
    throw new FormatError(`${where}: unexpected value ${JSON.stringify(v)}`);
}

/** Parse one worksheet (one week). */
export function parseSheet(ws) {
    const text = (r, c) => {
        const v = cellValue(ws.getRow(r).getCell(c));
        return v === null || v === undefined ? '' : String(v).trim();
    };
    const title = text(1, 1);
    if (!/コンテナ数（週次）/.test(title)) throw new FormatError(`Sheet "${ws.name}": unexpected title "${title}"`);
    const aggregatedOn = /集計実施日[:：]\s*(\d{4}\/\d{2}\/\d{2})/.exec(text(2, 1))?.[1];
    const period = /^(\d{4}\/\d{2}\/\d{2})-(\d{4}\/\d{2}\/\d{2})$/.exec(text(3, 3));
    if (!period) throw new FormatError(`Sheet "${ws.name}": week period not found in C3`);
    const weekStart = dashDate(period[1]);
    const weekEnd = dashDate(period[2]);
    const span = (Date.parse(`${weekEnd}T00:00:00Z`) - Date.parse(`${weekStart}T00:00:00Z`)) / 864e5;
    if (!validDate(weekStart) || !validDate(weekEnd) || span !== 6) throw new FormatError(`Sheet "${ws.name}": invalid week ${weekStart}..${weekEnd}`);

    // Columns 3..14: each flow x metric combination must appear exactly once.
    const columns = [];
    const seenCombos = new Set();
    for (let c = 3; c <= 14; c++) {
        const flow = own(FLOWS, text(4, c));
        const metric = own(METRICS, text(5, c));
        if (!flow || !metric) throw new FormatError(`Sheet "${ws.name}": unexpected header at column ${c} ("${text(4, c)}" / "${text(5, c)}")`);
        if (text(3, c) !== text(3, 3)) throw new FormatError(`Sheet "${ws.name}": inconsistent week in column ${c}`);
        const combo = `${flow}/${metric}`;
        if (seenCombos.has(combo)) throw new FormatError(`Sheet "${ws.name}": duplicate column ${combo} at column ${c}`);
        seenCombos.add(combo);
        columns.push({ c, flow, metric });
    }
    const rows = [];
    const seenPorts = new Set();
    for (let r = 7; r <= ws.rowCount; r++) {
        const portJa = text(r, 2);
        if (!portJa) continue;
        if (!own(PORTS_EN, portJa)) throw new FormatError(`Sheet "${ws.name}": unknown port "${portJa}" in row ${r}`);
        if (seenPorts.has(portJa)) throw new FormatError(`Sheet "${ws.name}": duplicate port "${portJa}" in row ${r}`);
        seenPorts.add(portJa);
        const byFlow = {};
        for (const { c, flow, metric } of columns) {
            (byFlow[flow] ??= {})[metric] = numberCell(ws.getRow(r).getCell(c), `Sheet "${ws.name}" row ${r} column ${c}`, metric !== 'teu');
        }
        for (const [flow, m] of Object.entries(byFlow)) {
            rows.push({
                weekStart, weekEnd, aggregatedOn: aggregatedOn ? dashDate(aggregatedOn) : null,
                port: PORTS_EN[portJa], portJa, flow,
                teu: m.teu, vsPreviousWeekPct: m.vsPreviousWeekPct, vsSameWeekLastMonthPct: m.vsSameWeekLastMonthPct, vsSameWeekLastYearPct: m.vsSameWeekLastYearPct,
            });
        }
    }
    if (seenPorts.size !== Object.keys(PORTS_EN).length) {
        throw new FormatError(`Sheet "${ws.name}": expected ports ${Object.keys(PORTS_EN).join(', ')}, got ${[...seenPorts].join(', ')}`);
    }
    return rows;
}

/** Parse a workbook buffer (one or more weekly sheets). */
export async function parseWorkbook(buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    if (!wb.worksheets.length) throw new FormatError('Workbook has no sheets');
    return wb.worksheets.flatMap(parseSheet);
}

export function sanitize(message) {
    return String(message)
        .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"`)]*/g, '<path>')
        .replace(/\/(?:home|Users|root|tmp|var|usr)\/[^\s'"`)]*/g, '<path>');
}
