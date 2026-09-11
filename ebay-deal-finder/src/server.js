// Serves the deal viewer and the JSON behind it. Binds to every interface by
// default so the same page opens on your phone over the local network.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createDealServer({ store, config, onScanRequest = null }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = await readFile(join(WEB_DIR, 'app.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && path === '/api/deals') {
        json(res, 200, {
          deals: store.deals(),
          dismissed: store.dismissed(),
          lastScanAt: store.data.lastScanAt ?? null,
          rules: {
            minInvestment: config.valuation.minInvestment,
            minDiscount: config.valuation.minDiscount,
            minFeedbackPercentage: config.risk.minFeedbackPercentage,
            desktopRamOnly: config.filters.desktopRamOnly,
            types: config.search.types,
          },
          stats: store.stats(),
        });
        return;
      }

      if (req.method === 'POST' && path === '/api/dismiss') {
        const { id, dismissed } = JSON.parse((await readBody(req)) || '{}');
        if (!id) return json(res, 400, { error: 'id is required' });
        store.setDismissed(id, Boolean(dismissed));
        await store.save();
        return json(res, 200, { ok: true, dismissed: store.dismissed() });
      }

      // Exported file for viewing the same deals somewhere else.
      if (req.method === 'GET' && path === '/api/export') {
        const payload = JSON.stringify({ lastScanAt: store.data.lastScanAt ?? null, deals: store.deals() }, null, 2);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="deals.json"',
        });
        res.end(payload);
        return;
      }

      if (req.method === 'POST' && path === '/api/scan' && onScanRequest) {
        const result = await onScanRequest();
        return json(res, 200, { ok: true, found: result?.deals?.length ?? 0 });
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });
}

// The address to type into a phone on the same Wi-Fi.
export function lanAddresses(port) {
  const urls = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) urls.push(`http://${address.address}:${port}`);
    }
  }
  return urls;
}
