# Cloudflare Radar – Top Domains

Fetches the most popular (or trending) domains per country and per category from the **official [Cloudflare Radar API](https://developers.cloudflare.com/radar/)** and writes them to an Apify dataset.

Perfect for competitive research, market sizing, and keeping a weekly snapshot of who dominates the web in each country × industry.

## What you get

For every (location, category) pair the Actor queries, it pushes a dataset row with:

| Field | Description |
|---|---|
| `location` | ISO-2 country code, or `GLOBAL` |
| `category` | Cloudflare Radar category name, or `null` |
| `rank` | Position in the returned top list (1 = top) |
| `domain` | Domain name |
| `pctRankChange` | Percentage rank change vs the previous period |
| `categories` | All Cloudflare categories the domain belongs to |
| `rankingType` | `POPULAR`, `TRENDING_RISE`, or `TRENDING_STEADY` |
| `date` | Date used for the query, or `null` for the most recent available |

## How to run

### 1. Get a Cloudflare API token (free)

1. Sign in to your Cloudflare account (a free account is enough).
2. Go to **My Profile → API Tokens → Create Token → Create Custom Token**.
3. Grant the permission **Account → Radar → Read**.
4. Copy the token.

### 2. Set it as an environment variable

**On the Apify platform** – no input field: the token is read from an environment variable that is already wired up in `.actor/actor.json`:

```json
"environmentVariables": {
  "CLOUDFLARE_API_TOKEN": "@CLOUDFLARE_API_TOKEN"
}
```

The `@` prefix tells Apify to read the value from an **Actor secret** with the same name. Add it once via `apify secrets add CLOUDFLARE_API_TOKEN <your-token>` (or in Apify Console → Account → Integrations → Secrets) and every run picks it up automatically. The token is never shown in input fields or logs.

**Locally** – set the env var in your shell before `apify run`:

```bash
# Linux / macOS
export CLOUDFLARE_API_TOKEN=<your-token>
apify run

# PowerShell
$env:CLOUDFLARE_API_TOKEN = "<your-token>"
apify run
```

### 3. Configure input

| Input | Default | Notes |
|---|---|---|
| `locations` | `GLOBAL` + 10 major countries | ISO-2 codes and/or the literal `GLOBAL` for the un-filtered worldwide ranking. |
| `categories` | *(all present)* | Cloudflare Radar category names to keep in the output. Empty = emit every category found. |
| `rankingType` | `POPULAR` | Also `TRENDING_RISE` or `TRENDING_STEADY`. |
| `limit` | `1` | Top N per (location, category) pair. |
| `date` | *(latest)* | Optional — rankings refresh daily, last 24 h. |

## How it works

The Actor calls `GET https://api.cloudflare.com/client/v4/radar/ranking/top` for every (location, category) combination with an authenticated Bearer token. Requests are spaced ~350 ms apart to stay well under Cloudflare's global ceiling of **1,200 requests per 5 minutes per token**; 429 responses are respected via the `retry-after` header.

## Limitations

- **Per-country rankings cap at ~top 100.** Cloudflare's larger bucket datasets (200 → 1,000,000) are global only, no country or category filter.
- **Data freshness.** Rankings refresh daily and cover the last 24 h.
- **License.** Cloudflare Radar data is published under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). Attribution to Cloudflare is required and the data is **for non-commercial use only** unless you arrange separate commercial terms with Cloudflare.

## Cost

Beyond the usual Apify compute cost, the Actor itself charges nothing extra — the Cloudflare Radar API is free on every Cloudflare plan.

## References

- [Cloudflare Radar](https://radar.cloudflare.com/)
- [Radar API — ranking/top](https://developers.cloudflare.com/api/resources/radar/subresources/ranking/methods/top/)
- [Radar — domain ranking datasets](https://developers.cloudflare.com/radar/investigate/domain-ranking-datasets/)
- [Cloudflare API rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/)
