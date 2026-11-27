import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { pushDataWithinLimit } from './charging.js';
import { PAGE_URL, PORTS_EN, SOURCE, parseWorkbook, sanitize, workbookLinks } from './port.js';

const USER_AGENT = 'jp-port-container-weekly-actor/1.0';
const MAX_WAIT_MS = 120000;

class InputError extends Error {}

function retryAfterMs(res) {
    const h = res.headers.get('retry-after');
    if (!h) return 0;
    if (/^\d+$/.test(h)) return Number(h) * 1000;
    const t = Date.parse(h);
    return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
}

function makeFetcher({ fetchImpl, sleep, log }) {
    let first = true;
    return async (url, kind) => {
        let wait = 0;
        for (let attempt = 0; attempt <= 3; attempt++) {
            if (!first) await sleep(Math.max(wait, attempt === 0 ? 2000 : 2000 * 2 ** attempt));
            first = false;
            let res;
            let body;
            try {
                res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000), redirect: 'error' });
                if (res.ok) body = kind === 'text' ? await res.text() : Buffer.from(await res.arrayBuffer());
            } catch (err) {
                if (attempt === 3) throw new Error(`Network error for ${url}: ${err.message}`);
                log.warning(`Network error for ${url}, retrying`);
                wait = 0;
                continue;
            }
            if (res.ok) return body;
            if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status} for ${url}`);
            if (attempt === 3) throw new Error(`HTTP ${res.status} for ${url} after retries`);
            wait = retryAfterMs(res);
            if (wait > MAX_WAIT_MS) throw new Error(`HTTP ${res.status}; asked to wait ${Math.round(wait / 1000)} s — try again later`);
            log.warning(`HTTP ${res.status} for ${url}, retrying`);
        }
        throw new Error(`Request failed: ${url}`);
    };
}

export async function run({ actor, log, fetchImpl = fetch, sleep = delay }) {
    await actor.init();
    try {
        const input = (await actor.getInput()) ?? {};
        const includeArchive = input.includeArchive ?? true;
        const onlyNewRaw = input.onlyNew ?? false;
        for (const [k, v] of [['includeArchive', includeArchive], ['onlyNew', onlyNewRaw]]) if (typeof v !== 'boolean') throw new InputError(`${k} must be true or false.`);
        for (const k of ['ports', 'flows']) if (input[k] !== undefined && !Array.isArray(input[k])) throw new InputError(`${k} must be a list.`);
        const ports = (input.ports ?? []).map(String);
        const bad = ports.filter((p) => !Object.values(PORTS_EN).includes(p));
        if (bad.length) throw new InputError(`Unknown port(s): ${bad.join(', ')}. Allowed: ${Object.values(PORTS_EN).join(', ')}`);
        const flows = input.flows ?? [];
        if (flows.some((f) => !['total', 'export', 'import'].includes(f))) throw new InputError('flows may contain total, export, import.');
        const onlyNew = onlyNewRaw;
        const stateKey = input.stateKey || 'default';
        if (!/^[a-zA-Z0-9_-]{1,50}$/.test(stateKey)) throw new InputError('stateKey may only contain letters, digits, "-" and "_" (max 50).');

        const get = makeFetcher({ fetchImpl, sleep, log });
        const { current, archive } = workbookLinks(await get(PAGE_URL, 'text'));
        if (!current) throw new Error('The current weekly report link was not found on the MLIT page.');
        if (includeArchive && !archive) throw new Error('The archive link (past weeks) was not found on the MLIT page; run with includeArchive = false.');
        const files = includeArchive ? [current, archive] : [current];
        const byKey = new Map();
        for (const url of files) {
            for (const row of await parseWorkbook(await get(url, 'binary'))) {
                // The same week can appear in both files; the current file (read first) wins.
                const key = `${row.weekStart}|${row.portJa}|${row.flow}`;
                if (!byKey.has(key)) byKey.set(key, { ...row, sourceUrl: url });
            }
        }
        let rows = [...byKey.values()]
            .filter((r) => (!ports.length || ports.includes(r.port)) && (!flows.length || flows.includes(r.flow)))
            .sort((a, b) => b.weekStart.localeCompare(a.weekStart) || a.portJa.localeCompare(b.portJa) || a.flow.localeCompare(b.flow));

        // Monitoring: (week, port, flow) -> hash of values; new and revised rows are output once.
        const store = onlyNew ? await actor.openKeyValueStore('jp-port-container-weekly-state') : null;
        const state = onlyNew ? ((await store.getValue(`rows-${stateKey}`)) ?? {}) : {};
        const out = [];
        const pendingState = [];
        for (const r of rows) {
            let changeType = null;
            if (onlyNew) {
                const key = `${r.weekStart}|${r.portJa}|${r.flow}`;
                const h = createHash('sha1').update(JSON.stringify([r.teu, r.vsPreviousWeekPct, r.vsSameWeekLastMonthPct, r.vsSameWeekLastYearPct])).digest('hex').slice(0, 16);
                if (!(key in state)) changeType = 'new';
                else if (state[key] !== h) changeType = 'revision';
                else continue;
                pendingState.push([key, h]);
            }
            out.push({ ...r, ...(changeType ? { changeType } : {}), unit: 'TEU', source: SOURCE });
        }
        // With pay-per-event pricing pushData can store fewer items when the user's spending limit is reached;
        // only stored rows count as output (and as seen in monitoring mode).
        let stored = 0;
        if (out.length) {
            const res = await pushDataWithinLimit(actor, out);
            stored = res?.eventChargeLimitReached && Number.isInteger(res.chargedCount) ? Math.min(res.chargedCount, out.length) : out.length;
            if (stored < out.length) log.warning(`Spending limit reached: ${out.length - stored} rows were not saved and will be returned by the next run.`);
        }
        if (onlyNew) {
            for (const [key, h] of pendingState.slice(0, stored)) state[key] = h;
            await store.setValue(`rows-${stateKey}`, state);
        }
        rows = null;
        await actor.setValue('RUN_SUMMARY', {
            files: files.length, pushed: stored, notSaved: out.length - stored,
            ...(stored < out.length && { stopReason: 'spendingLimit' }),
        });
        log.info(`Done. Pushed ${stored} rows from ${files.length} file(s).`);
        await actor.exit();
    } catch (err) {
        const msg = sanitize(err.message);
        log.error(err instanceof InputError ? `Invalid input: ${msg}` : msg);
        await actor.fail(msg);
    }
}
