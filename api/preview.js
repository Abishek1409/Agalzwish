// Vercel serverless function: GET /api/preview?url=<product link>
//
// Fetches a product page directly (instead of through a third party preview
// service) and pulls out the name, image and price. Works for most shops that
// publish standard product data, plus special handling for Amazon, Flipkart
// and Myntra. No npm packages are needed.
//
// Response: { ok, title, image, price, currency, finalUrl, blocked }

const TIMEOUT_MS = 9000;
const MAX_BYTES = 3 * 1024 * 1024;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

// ---------- Safety: only fetch public web addresses ----------

function isSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^\[|:/.test(host)) return false; // IPv6 literals
  const ip = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

// ---------- Small helpers ----------

function decodeEntities(str) {
  if (str == null) return str;
  return String(str)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function toNumber(val) {
  if (val == null) return null;
  if (typeof val === 'number') return isFinite(val) && val > 0 ? val : null;
  const cleaned = String(val).replace(/[^0-9.]/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) && n > 0 ? n : null;
}

function absolutize(src, base) {
  if (!src) return null;
  try { return new URL(decodeEntities(src), base).toString(); } catch (_) { return null; }
}

function firstString(val) {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return firstString(val[0]);
  if (typeof val === 'object') return firstString(val.url || val.contentUrl || val['@id']);
  return null;
}

// Reads a JSON object that starts at the first "{" after `marker`.
function readJsonAfter(html, marker) {
  const at = html.indexOf(marker);
  if (at === -1) return null;
  const start = html.indexOf('{', at);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length && i < start + 2_000_000; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

// ---------- Generic extractors ----------

function readMetaTags(html) {
  const meta = {};
  const tagRe = /<meta\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const content = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
    if (key && content != null && meta[key.toLowerCase()] == null) {
      meta[key.toLowerCase()] = decodeEntities(content);
    }
  }
  return meta;
}

function findProductNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => findProductNodes(n, out)); return out; }
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.some(t => typeof t === 'string' && /product/i.test(t))) out.push(node);
  if (node['@graph']) findProductNodes(node['@graph'], out);
  return out;
}

function readJsonLd(html) {
  const result = {};
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let parsed;
    try { parsed = JSON.parse(m[1].trim()); } catch (_) { continue; }
    for (const p of findProductNodes(parsed)) {
      if (!result.title && p.name) result.title = decodeEntities(p.name);
      if (!result.image) result.image = firstString(p.image);
      const offers = Array.isArray(p.offers) ? p.offers : p.offers ? [p.offers] : [];
      for (const o of offers) {
        const price = toNumber(o.price ?? o.lowPrice ?? o.priceSpecification?.price);
        if (price && !result.price) {
          result.price = price;
          result.currency = o.priceCurrency || o.priceSpecification?.priceCurrency || null;
        }
      }
    }
  }
  return result;
}

// ---------- Shop specific extractors ----------

function readAmazon(html) {
  const r = {};
  const title = html.match(/<span[^>]*id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i);
  if (title) r.title = decodeEntities(title[1].replace(/\s+/g, ' '));

  const hires = html.match(/data-old-hires=["']([^"']+)["']/i);
  const landing = html.match(/id=["']landingImage["'][^>]*\bsrc=["']([^"']+)["']/i) ||
                  html.match(/\bsrc=["']([^"']+)["'][^>]*id=["']landingImage["']/i);
  const dyn = html.match(/data-a-dynamic-image=["']\{&quot;([^&]+)&quot;/i) ||
              html.match(/data-a-dynamic-image='\{"([^"]+)"/i);
  r.image = (hires && hires[1]) || (dyn && dyn[1]) || (landing && landing[1]) || null;

  // Price: the "price to pay" block first, then the JSON Amazon embeds for variants.
  const core = html.search(/id=["'](corePriceDisplay_desktop_feature_div|corePrice_feature_div|apex_desktop)["']/i);
  if (core !== -1) {
    const slice = html.slice(core, core + 6000);
    const off = slice.match(/class=["']a-offscreen["'][^>]*>\s*([^<]+)</i);
    if (off) r.price = toNumber(off[1]);
    if (!r.price) {
      const whole = slice.match(/class=["']a-price-whole["'][^>]*>([\d,]+)/i);
      if (whole) r.price = toNumber(whole[1]);
    }
  }
  if (!r.price) {
    const pa = html.match(/"priceAmount"\s*:\s*([\d.]+)/);
    if (pa) r.price = toNumber(pa[1]);
  }
  if (r.price) r.currency = 'INR';
  return r;
}

function fillMyntraImage(src) {
  if (!src) return null;
  return src
    .replace(/\(\$height\)/g, '720')
    .replace(/\(\$width\)/g, '540')
    .replace(/\(\$qualityPercentage\)/g, '90')
    .replace(/^http:/, 'https:');
}

function readMyntra(html) {
  const r = {};
  const myx = readJsonAfter(html, 'window.__myx');
  const pdp = myx && (myx.pdpData || myx.pdp?.pdpData);
  if (pdp) {
    if (pdp.name) r.title = decodeEntities(pdp.name);
    const price = toNumber(pdp.price?.discounted) || toNumber(pdp.price?.mrp) || toNumber(pdp.mrp);
    if (price) { r.price = price; r.currency = 'INR'; }
    const img =
      pdp.media?.albums?.[0]?.images?.[0]?.secureSrc ||
      pdp.media?.albums?.[0]?.images?.[0]?.imageURL ||
      pdp.media?.albums?.[0]?.images?.[0]?.src;
    if (img) r.image = fillMyntraImage(img);
  }
  return r;
}

function readFlipkart(html) {
  const r = {};
  const state = readJsonAfter(html, 'window.__INITIAL_STATE__');
  if (state) {
    // The state tree changes often, so search it for the first selling price.
    const seen = new Set();
    const stack = [state];
    while (stack.length && !r.price) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (node.finalPrice && toNumber(node.finalPrice.value ?? node.finalPrice.decimalValue)) {
        r.price = toNumber(node.finalPrice.value ?? node.finalPrice.decimalValue);
      } else if (node.sellingPrice && toNumber(node.sellingPrice.value)) {
        r.price = toNumber(node.sellingPrice.value);
      }
      for (const k in node) if (node[k] && typeof node[k] === 'object') stack.push(node[k]);
    }
    if (r.price) r.currency = 'INR';
  }
  return r;
}

// ---------- Main extraction (exported for tests) ----------

function extract(html, finalUrl) {
  let host = '';
  try { host = new URL(finalUrl).hostname.toLowerCase(); } catch (_) {}

  const blocked =
    /api-services-support@amazon\.com|\/errors\/validateCaptcha|Enter the characters you see below/i.test(html) ||
    /<title>\s*(Access Denied|Just a moment\.\.\.|Attention Required)/i.test(html);

  const meta = readMetaTags(html);
  const ld = readJsonLd(html);
  let shop = {};
  if (/(^|\.)amazon\./.test(host) || /(^|\.)amzn\./.test(host)) shop = readAmazon(html);
  else if (/(^|\.)myntra\.com$/.test(host)) shop = readMyntra(html);
  else if (/(^|\.)flipkart\.com$/.test(host)) shop = readFlipkart(html);

  const pageTitle = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];

  const title =
    shop.title || ld.title || meta['og:title'] || meta['twitter:title'] ||
    (pageTitle ? decodeEntities(pageTitle.replace(/\s+/g, ' ')) : null);

  const image = absolutize(
    shop.image || ld.image || meta['og:image'] || meta['og:image:secure_url'] || meta['twitter:image'] || meta['image'],
    finalUrl
  );

  const metaPrice = toNumber(meta['product:price:amount'] || meta['og:price:amount'] || meta['price']);
  const price = shop.price || ld.price || metaPrice || null;
  const currency =
    (shop.price && shop.currency) || (ld.price && ld.currency) ||
    meta['product:price:currency'] || meta['og:price:currency'] || meta['pricecurrency'] ||
    (price ? 'INR' : null);

  return {
    ok: !blocked && Boolean(title || image || price),
    blocked,
    title: blocked ? null : title || null,
    image: blocked ? null : image || null,
    price: blocked ? null : price,
    currency: blocked ? null : currency,
    finalUrl,
  };
}

// ---------- HTTP handler ----------

async function readLimited(res) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return (await res.text()).slice(0, MAX_BYTES);
  const chunks = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try { reader.cancel(); } catch (_) {}
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

async function handler(req, res) {
  const url = (req.query && req.query.url) || new URL(req.url, 'http://x').searchParams.get('url');

  if (!url || !isSafeUrl(url)) {
    res.status(400).json({ ok: false, error: 'Give a valid public http(s) link in ?url=' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: controller.signal });
    const finalUrl = upstream.url || url;
    if (!isSafeUrl(finalUrl)) {
      res.status(400).json({ ok: false, error: 'The link redirected somewhere that is not allowed.' });
      return;
    }
    const html = await readLimited(upstream);
    const data = extract(html, finalUrl);
    if (!upstream.ok && !data.ok) data.blocked = data.blocked || upstream.status === 403 || upstream.status === 503;
    data.status = upstream.status;

    // Cache good results at the edge for an hour so repeated links are instant.
    res.setHeader('Cache-Control', data.ok ? 's-maxage=3600, stale-while-revalidate=86400' : 'no-store');
    res.status(200).json(data);
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: false, error: err.name === 'AbortError' ? 'The shop took too long to answer.' : String(err.message || err) });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = handler;
module.exports.extract = extract;
module.exports.isSafeUrl = isSafeUrl;
