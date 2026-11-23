// Vercel serverless function: GET /api/preview?url=<product link>
//
// Fetches a product page directly (instead of through a third party preview
// service) and pulls out the name, image and price. Works for most shops that
// publish standard product data, plus special handling for Amazon, Flipkart
// and Myntra. No npm packages are needed.
//
// Response: { ok, title, image, price, currency, finalUrl, blocked }

const TIMEOUT_MS = 7000;
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


const TEST_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preview tester</title>
<style>
 body{font-family:system-ui,sans-serif;margin:0;padding:1rem;background:#f6f5fb;color:#222}
 h1{font-size:1.2rem}
 textarea{width:100%;box-sizing:border-box;min-height:5rem;padding:.6rem;border:1px solid #ccc;border-radius:8px;font-size:.95rem}
 button{margin-top:.6rem;padding:.6rem 1.2rem;border:0;border-radius:8px;background:#5b4bd5;color:#fff;font-weight:600;font-size:.95rem}
 .card{margin-top:1rem;background:#fff;border:1px solid #ddd;border-radius:10px;padding:.8rem;display:none}
 .card img{max-width:120px;max-height:120px;border-radius:6px;display:block;margin-bottom:.5rem}
 pre{white-space:pre-wrap;word-break:break-word;font-size:.8rem;background:#f0f0f0;padding:.6rem;border-radius:6px}
</style></head><body>
<h1>Product preview tester</h1>
<p>Paste a product link or a share message, then tap Test.</p>
<textarea id="u" placeholder="https://www.flipkart.com/..."></textarea>
<button id="go">Test</button>
<div class="card" id="card"><img id="img" alt=""><div id="sum"></div><pre id="raw"></pre></div>
<script>
 document.getElementById('go').onclick = async () => {
   const v = document.getElementById('u').value.trim();
   if (!v) return;
   const card = document.getElementById('card'), sum = document.getElementById('sum');
   card.style.display = 'block'; sum.textContent = 'Testing, this can take up to 30 seconds…';
   document.getElementById('raw').textContent = ''; document.getElementById('img').style.display = 'none';
   try {
     const r = await fetch('/api/preview?url=' + encodeURIComponent(v));
     const d = await r.json();
     sum.innerHTML = '<b>Name:</b> ' + (d.title || '(none)') + '<br><b>Price:</b> ' + (d.price ? d.price + ' ' + (d.currency || '') : '(none)') + '<br><b>Source:</b> ' + (d.source || '-');
     if (d.image) { const i = document.getElementById('img'); i.src = d.image; i.style.display = 'block'; }
     document.getElementById('raw').textContent = JSON.stringify(d, null, 2);
   } catch (e) { sum.textContent = 'Request failed: ' + e; }
 };
</script></body></html>`;

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


// ---------- Title cleanup ----------

// Shops stuff their page titles with sales wording, for example
// "Amazon.in: Buy Lavie Tote Bag Online at Low Prices in India | Reviews".
// This keeps only the product name.
function cleanTitle(title) {
  if (!title) return null;
  let t = decodeEntities(String(title)).replace(/\s+/g, ' ').trim();
  t = t
    .replace(/^Amazon\.[a-z.]+\s*:\s*/i, '')
    .replace(/\s*:\s*Amazon\.[a-z.]+.*$/i, '')
    .replace(/\s*[|\-–]\s*(Buy\s.*)?(Online\s)?(at\s)?(Low|Best)\s+Prices?\s+in\s+India.*$/i, '')
    .replace(/\s+Online at (Low|Best) Prices? in India.*$/i, '')
    .replace(/\s*[|\-–]\s*(Flipkart|Myntra|Amazon|Nykaa|Ajio|Meesho|Tata\s?CLiQ)(\.com|\.in)?\s*$/i, '')
    .replace(/\s*\|\s*Reviews?\s*&\s*Ratings.*$/i, '')
    .replace(/\s+[-–|]\s+Buy\s.*$/i, '')     // Flipkart "X - Buy X Online at ..."
    .replace(/^Buy\s+/i, '')
    .replace(/\s+\d{6,}(?=\s|$)/g, '')         // product ids (Myntra)
    .replace(/\s+[-–]\s+[A-Za-z &]+\s+for\s+(Men|Women|Boys|Girls|Kids|Unisex)(\s+\d+)?\s*$/i, '')
    .replace(/\s+\d{6,}\s*$/, '')            // trailing product id (Myntra)
    .replace(/\s*[|\-–:]\s*$/, '')
    .trim();
  if (t.length > 110) t = t.slice(0, 110).replace(/\s+\S*$/, '') + '…';
  return t || null;
}

// Builds a readable name from the link itself, used when the shop blocks us.
// flipkart.com/puma-r22-sneakers-men/p/itm0f... -> "Puma R22 Sneakers Men"
function nameFromUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  const parts = u.pathname.split('/').map(p => decodeURIComponent(p)).filter(Boolean);
  const words = parts
    .filter(p => /[a-z]/i.test(p) && /[-_]/.test(p))
    .filter(p => !/^(dp|gp|p|buy|product|products|itm[0-9a-f]+)$/i.test(p));
  if (!words.length) return null;
  const best = words.sort((a, b) => b.length - a.length)[0];
  const name = best
    .replace(/[-_]+/g, ' ')
    .replace(/\b\d{6,}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
  return name.length >= 4 ? name : null;
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
    /<title>\s*(Site Maintenance|Access Denied|Just a moment\.\.\.|Attention Required|Robot Check|Are you a human)/i.test(html);

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
    title: blocked ? null : cleanTitle(title),
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

// Follows redirects one hop at a time (checking each address is public).
// Short share links like dl.flipkart.com/s/... or myntr.it/... answer with a
// plain redirect even when the shop itself blocks us, so this always recovers
// the real product address with its readable name in it.
async function resolveRedirects(target) {
  let current = target;
  for (let hop = 0; hop < 6; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const r = await fetch(current, { headers: BROWSER_HEADERS, redirect: 'manual', signal: controller.signal });
      const loc = r.headers && r.headers.get && r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        const next = new URL(loc, current).toString();
        if (!isSafeUrl(next)) return current;
        current = next;
        continue;
      }
      return current;
    } catch (_) {
      return current;
    } finally {
      clearTimeout(timer);
    }
  }
  return current;
}

async function fetchDirect(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(target, { headers: BROWSER_HEADERS, redirect: 'follow', signal: controller.signal });
    return { status: r.status, ok: r.ok, finalUrl: r.url || target, html: await readLimited(r) };
  } finally {
    clearTimeout(timer);
  }
}

// ScraperAPI fetches the page through its own rotating addresses. No country
// is requested: choosing India needs their Business plan, and asking for it on
// the free plan makes every request fail.
async function fetchViaScraper(target, render) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), render ? 40000 : 25000);
  try {
    const params = { api_key: process.env.SCRAPER_API_KEY, url: target };
    if (render) params.render = 'true';
    const r = await fetch(`https://api.scraperapi.com/?${new URLSearchParams(params).toString()}`, { signal: controller.signal });
    const html = await readLimited(r);
    if (!r.ok) {
      const reason = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      throw new Error(`HTTP ${r.status}${reason ? ': ' + reason : ''}`);
    }
    return { status: r.status, ok: true, finalUrl: target, html };
  } finally {
    clearTimeout(timer);
  }
}

// Everything after "url=" in the address, so a pasted link keeps its own
// "&" parts even when it was not encoded.
function rawUrlParam(req) {
  const full = String(req.url || '');
  const at = full.search(/[?&]url=/);
  if (at === -1) return (req.query && req.query.url) || '';
  let raw = full.slice(at + 5);
  try { raw = decodeURIComponent(raw.replace(/\+/g, '%20')); } catch (_) {}
  return raw;
}

// Accepts a bare link, a link without https://, or a whole share message
// such as "Check out this product on Flipkart https://dl.flipkart.com/s/..."
function extractLink(text) {
  if (!text) return null;
  const t = String(text).trim();
  const m = t.match(/https?:\/\/[^\s<>"']+/i);
  if (m) return m[0].replace(/[),.;!?]+$/, '');
  const bare = t.match(/(?:^|\s)((?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s<>"']*)/i);
  if (bare) return 'https://' + bare[1].replace(/[),.;!?]+$/, '');
  return null;
}

function readTargetUrl(req) {
  return extractLink(rawUrlParam(req)) || extractLink(req.query && req.query.url);
}

async function handler(req, res) {
  // Never cache: a shared cache could hand one product's details to a
  // different link. Every link is fetched fresh.
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');

  // Opening /api/preview with no link shows a small test page with a paste box.
  if (!rawUrlParam(req)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(TEST_PAGE);
    return;
  }

  const url = readTargetUrl(req);

  if (!url || !isSafeUrl(url)) {
    res.status(400).json({ ok: false, error: 'Give a valid public http(s) link in ?url=', received: rawUrlParam(req) });
    return;
  }

  // 0. Unwrap share links to the real product page first.
  const productUrl = await resolveRedirects(url);

  let data = { ok: false, blocked: false, title: null, image: null, price: null, currency: null, finalUrl: productUrl };
  let source = 'none';
  const errors = [];

  // 1. Direct fetch from Vercel (free, works for many shops).
  try {
    const page = await fetchDirect(productUrl);
    if (isSafeUrl(page.finalUrl)) {
      data = extract(page.html, page.finalUrl);
      data.status = page.status;
      if (!page.ok && !data.ok) data.blocked = true;
      source = 'direct';
    }
  } catch (err) {
    errors.push('direct: ' + (err.name === 'AbortError' ? 'timed out' : String(err.message || err)));
  }

  // 2. If the shop blocked us or hid the price, try ScraperAPI (only when a key is set).
  //    A plain request first; if that still has no price, one with page rendering.
  if (process.env.SCRAPER_API_KEY && (!data.ok || !data.price)) {
    for (const render of [false, true]) {
      try {
        const page = await fetchViaScraper(data.finalUrl || productUrl, render);
        const via = extract(page.html, data.finalUrl || productUrl);
        if (via.ok) {
          data = {
            ...via,
            title: via.title || data.title,
            image: via.image || data.image,
            price: via.price || data.price,
            currency: via.price ? via.currency : data.currency,
            status: page.status,
          };
          source = render ? 'scraperapi-render' : 'scraperapi';
        } else if (via.blocked) {
          errors.push(`scraperapi${render ? ' render' : ''}: the shop showed a block page`);
        }
        if (data.ok && data.price) break;
      } catch (err) {
        errors.push(`scraperapi${render ? ' render' : ''}: ` + (err.name === 'AbortError' ? 'timed out' : String(err.message || err)));
      }
    }
  }

  // 3. Never return an empty name: build one from the product address if needed.
  if (!data.title) data.title = nameFromUrl(data.finalUrl || productUrl) || nameFromUrl(url);

  data.source = source;
  data.scraperConfigured = Boolean(process.env.SCRAPER_API_KEY);
  if (errors.length) data.errors = errors;
  res.status(200).json(data);
}

module.exports = handler;
module.exports.extract = extract;
module.exports.isSafeUrl = isSafeUrl;
module.exports.extractLink = extractLink;
module.exports.readTargetUrl = readTargetUrl;
module.exports.cleanTitle = cleanTitle;
module.exports.nameFromUrl = nameFromUrl;
