# 9Router Cloud Worker

Deploy your own Cloudflare Worker to access 9Router from anywhere.

## Setup

```bash
# 1. Login to Cloudflare
npm install -g wrangler
wrangler login

# 2. Install dependencies
cd app/cloud
npm install

# 3. Create KV & D1, then paste IDs into wrangler.toml
wrangler kv namespace create KV
wrangler d1 create proxy-db

# 4. Configure secrets
wrangler secret put API_KEY_SECRET
wrangler secret put FORWARD_AUTH_TOKEN

# 5. Init database & deploy
wrangler d1 execute proxy-db --remote --file=./migrations/0001_init.sql
npm run deploy
```

Copy your Worker URL → 9Router Dashboard → **Endpoint** → **Setup Cloud** → paste → **Save** → **Enable Cloud**.

`API_KEY_SECRET` must match the local 9Router instance. `/forward` and `/forward-raw` stay disabled until `FORWARD_AUTH_TOKEN` is configured, and callers must send it as `Authorization: Bearer <token>` or `x-9router-forward-token`.
