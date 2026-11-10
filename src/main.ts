import { Actor, log } from 'apify';

interface Input {
    locations?: string[];
    categories?: string[];
    rankingType?: 'POPULAR' | 'TRENDING_RISE' | 'TRENDING_STEADY';
    limit?: number;
    date?: string;
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
    result: Record<string, unknown>;
    success?: boolean;
    errors?: unknown[];
    messages?: unknown[];
}

const RADAR_BASE = 'https://api.cloudflare.com/client/v4/radar/ranking/top';
// Cloudflare caps per-country rankings at 100; fetch the max so every category surfaces at least its top domain.
const FETCH_SIZE = 100;
const SERIES_NAME = 'main';
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
const limit = Math.max(1, input.limit ?? 1);
const date = input.date?.trim() || undefined;

// "GLOBAL" (case-insensitive) in the locations list means "no location filter"; everything else is passed as an ISO-2 code.
const locList: (string | undefined)[] = [];
const seen = new Set<string>();
for (const raw of input.locations ?? []) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    locList.push(key === 'GLOBAL' ? undefined : value);
}

const categoryFilter = new Set(
    (input.categories ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean),
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchTop(opts: { location?: string }): Promise<RadarTopItem[]> {
    const params = new URLSearchParams();
    params.set('rankingType', rankingType);
    params.set('limit', String(FETCH_SIZE));
    params.set('name', SERIES_NAME);
    if (opts.location) params.append('location', opts.location);
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

        if (json.success === false) {
            log.warning('Cloudflare API returned success=false', { errors: json.errors, opts });
            return [];
        }

        const result = json.result ?? {};
        const series = result[SERIES_NAME];
        if (Array.isArray(series)) return series as RadarTopItem[];

        // Fallback: any array-valued key in result (defensive against name-key drift).
        for (const value of Object.values(result)) {
            if (Array.isArray(value)) return value as RadarTopItem[];
        }

        log.warning('No series array in Cloudflare response', {
            resultKeys: Object.keys(result),
            bodyPreview: JSON.stringify(json).slice(0, 400),
            opts,
        });
        return [];
    }

    throw new Error('Exhausted retries after repeated 429 responses from Cloudflare Radar');
}

if (locList.length === 0) {
    throw new Error('Nothing to fetch: `locations` is empty. Add country codes or `GLOBAL`.');
}

log.info(
    `Plan: ${locList.length} location(s), fetching top ${FETCH_SIZE} each, grouping by category client-side`,
    { rankingType, limit, date, filter: [...categoryFilter] },
);

for (const location of locList) {
    try {
        const items = await fetchTop({ location });
        log.info(`Fetched ${items.length} items for ${location ?? 'GLOBAL'}`);

        // Group each item under every category it belongs to; keep original rank for ordering.
        const byCategory = new Map<string, RadarTopItem[]>();
        for (const item of items) {
            for (const cat of item.categories ?? []) {
                if (!cat?.name) continue;
                const bucket = byCategory.get(cat.name) ?? [];
                bucket.push(item);
                byCategory.set(cat.name, bucket);
            }
        }

        const categoryNames =
            categoryFilter.size > 0
                ? [...byCategory.keys()].filter((name) => categoryFilter.has(name.toLowerCase()))
                : [...byCategory.keys()].sort();

        if (categoryFilter.size > 0 && categoryNames.length === 0) {
            log.warning(
                `No categories matched the filter for ${location ?? 'GLOBAL'}. Available categories in this slice:`,
                { available: [...byCategory.keys()].sort() },
            );
        }

        for (const categoryName of categoryNames) {
            const ranked = (byCategory.get(categoryName) ?? [])
                .slice()
                .sort((a, b) => a.rank - b.rank)
                .slice(0, limit);

            for (const [i, item] of ranked.entries()) {
                await Actor.pushData({
                    location: location ?? 'GLOBAL',
                    category: categoryName,
                    rank: i + 1,
                    overallRank: item.rank,
                    domain: item.domain,
                    pctRankChange: item.pctRankChange ?? 0,
                    categories: item.categories ?? [],
                    rankingType,
                    date: date ?? null,
                });
                state.itemsPushed++;
            }
        }
    } catch (err) {
        log.exception(err as Error, 'Failed to fetch for location', { location });
    }
    await sleep(RATE_DELAY_MS);
}

log.info(`Done. Pushed ${state.itemsPushed} items across ${state.requests} API requests.`);

await Actor.exit();
