import { Actor, log } from 'apify';

interface Input {
    locations?: string[];
    categories?: string[];
    rankingType?: 'POPULAR' | 'TRENDING_RISE' | 'TRENDING_STEADY';
    limit?: number;
    date?: string;
    includeGlobal?: boolean;
}

interface RadarCategory {
    id: number;
    name: string;
    superCategoryId?: number;
}

interface RadarTopItem {
    domain: string;
    rank: number;
    pctRankChange?: number;
    categories?: RadarCategory[];
}

interface RadarTopResponse {
    result: {
        top_0: RadarTopItem[];
        meta?: unknown;
    };
    success: boolean;
    errors?: unknown[];
    messages?: unknown[];
}

const RADAR_BASE = 'https://api.cloudflare.com/client/v4/radar/ranking/top';
// 1,200 req / 5 min = 4 req/sec. 350 ms spacing stays under ~2.8 req/sec with headroom.
const RATE_DELAY_MS = 350;

await Actor.init();

const state = { itemsPushed: 0, requests: 0 };

Actor.on('aborting', async () => {
    log.warning('Aborting — persisting state', state);
    await Actor.setValue('STATE', state);
    await Actor.exit();
});

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
    throw new Error(
        'CLOUDFLARE_API_TOKEN is not set. Add it as an Actor secret on the Apify platform, or export it in your shell before `apify run`.',
    );
}

const input = (await Actor.getInput<Input>()) ?? {};
const rankingType = input.rankingType ?? 'POPULAR';
const limit = input.limit ?? 1;
const date = input.date?.trim() || undefined;
const includeGlobal = input.includeGlobal ?? true;
const locations = (input.locations ?? []).map((s) => s.trim()).filter(Boolean);
let categories = (input.categories ?? []).map((s) => s.trim()).filter(Boolean);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchTop(opts: { location?: string; category?: string }): Promise<RadarTopItem[]> {
    const params = new URLSearchParams();
    params.set('rankingType', rankingType);
    params.set('limit', String(limit));
    if (opts.location) params.append('location', opts.location);
    if (opts.category) params.append('domainCategory', opts.category);
    if (date) params.append('date', date);

    const url = `${RADAR_BASE}?${params.toString()}`;

    for (let attempt = 0; attempt < 5; attempt++) {
        state.requests++;
        const res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
            },
        });

        if (res.status === 429) {
            const retry = Number(res.headers.get('retry-after') ?? '10');
            log.warning(`Rate limited by Cloudflare, sleeping ${retry}s`, opts);
            await sleep(retry * 1000);
            continue;
        }

        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Radar API ${res.status}: ${body.slice(0, 300)}`);
        }

        const json = (await res.json()) as RadarTopResponse;
        return json.result?.top_0 ?? [];
    }

    throw new Error('Exhausted retries after repeated 429 responses from Cloudflare Radar');
}

if (categories.length === 0) {
    log.info('No categories supplied — discovering via warm-up call');
    const warmup = await fetchTop({});
    const seen = new Set<string>();
    for (const item of warmup) {
        for (const cat of item.categories ?? []) {
            if (cat?.name) seen.add(cat.name);
        }
    }
    categories = [...seen].sort();
    log.info(`Discovered ${categories.length} categories`, { categories });
    await sleep(RATE_DELAY_MS);
}

const locList: (string | undefined)[] = includeGlobal ? [undefined, ...locations] : [...locations];
if (locList.length === 0) {
    throw new Error('Nothing to fetch: both `locations` is empty and `includeGlobal` is false.');
}
const catList: (string | undefined)[] = categories.length > 0 ? categories : [undefined];

log.info(
    `Plan: ${locList.length} locations × ${catList.length} categories = ${locList.length * catList.length} API calls`,
    { rankingType, limit, date },
);

for (const location of locList) {
    for (const category of catList) {
        try {
            const rows = await fetchTop({ location, category });
            for (const row of rows) {
                await Actor.pushData({
                    location: location ?? 'GLOBAL',
                    category: category ?? null,
                    rank: row.rank,
                    domain: row.domain,
                    pctRankChange: row.pctRankChange ?? 0,
                    categories: row.categories ?? [],
                    rankingType,
                    date: date ?? null,
                });
                state.itemsPushed++;
            }
        } catch (err) {
            log.exception(err as Error, 'Failed to fetch top domains', { location, category });
        }
        await sleep(RATE_DELAY_MS);
    }
}

log.info(`Done. Pushed ${state.itemsPushed} items across ${state.requests} API requests.`);

await Actor.exit();
