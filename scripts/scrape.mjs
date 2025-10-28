import { chromium } from 'playwright';
import { create } from 'xmlbuilder2';
import { parse } from 'node-html-parser';
import sanitizeHtml from 'sanitize-html';
import fs from 'fs';
import path from 'path';

// Optional: fetch fallback for environments where global fetch is missing
let _fetch = globalThis.fetch;
if (typeof _fetch !== 'function') {
  try {
    const nodeFetch = await import('node-fetch');
    _fetch = nodeFetch.default;
  } catch (e) {
    console.warn('[warn] fetch is not available and node-fetch failed to load:', e?.message);
  }
}

const BASE = 'https://www.oaktreecapital.com';
const LIST_URL = `${BASE}/insights`;
const OUTPUT_DIR = 'docs';
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'feed.xml');
const SELF_URL = 'https://tomdhyang-byte.github.io/oaktree-memo-rss/feed.xml';

// Lazy load pdf-parse only if needed
async function pdfParseBuffer(buf) {
  const m = await import('pdf-parse');
  const pdfParse = m.default || m;
  return pdfParse(buf);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function absolutize(url) {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return BASE + url;
  return url;
}

/* ---------- helpers: dates, pdf, cleaning ---------- */
function parseDateOrNull(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toUTCString();
}

function tryExtractFallbackDateFromText(text) {
  if (!text) return null;
  const m = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\b/i);
  if (!m) return null;
  const d = new Date(m[0]);
  return isNaN(d.getTime()) ? null : d.toUTCString();
}

function extractDate(dom, htmlText) {
  const meta =
    dom.querySelector('time[datetime]')?.getAttribute('datetime') ||
    dom.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ||
    dom.querySelector('meta[name="date"]')?.getAttribute('content') ||
    null;

  return (
    parseDateOrNull(meta) ||
    tryExtractFallbackDateFromText(dom.text) ||
    tryExtractFallbackDateFromText(htmlText) ||
    null
  );
}

// javascript:openPDF('Title','https://...pdf?...') -> extract true URL
function extractPdfFromJsHref(href) {
  if (!href) return null;
  const m = href.match(/openPDF\((?:'|")(.*?)(?:'|"),\s*(?:'|")(https?:[^'"]+?\.pdf[^'"]*)(?:'|")\)/i);
  return m && m[2] ? m[2] : null;
}

// normalize anchors: fix openPDF & absolutize & standard attrs
function normalizeAnchors(root) {
  root.querySelectorAll('a').forEach(a => {
    const raw = a.getAttribute('href') || a.getAttribute('data-href') || a.getAttribute('data-file');
    let href = raw || '';
    if (href.startsWith('javascript:openPDF')) {
      const pdf = extractPdfFromJsHref(href);
      href = pdf || '';
    }
    href = absolutize(href);
    if (!href) a.removeAttribute('href'); else a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
}

// remove boilerplate blocks by text cues
function stripBoilerplate(root) {
  const killIfMatch = (selector, patterns) => {
    root.querySelectorAll(selector).forEach(el => {
      const t = (el.text || el.rawText || '').toLowerCase();
      if (patterns.some(p => t.includes(p))) el.remove();
    });
  };
  killIfMatch('*', [
    'related content', 'share', 'load more',
    'pdf translations', 'subscribe', 'archived memos'
  ]);
}

// extra safety: also cleanse remaining "javascript:openPDF(...)" in final HTML string
function fixOpenPDFInHTML(html) {
  if (!html) return html;
  // href="javascript:openPDF('...','URL.pdf?...')"
  html = html.replace(
    /href\s*=\s*"(?:javascript:)?openPDF\([^,]+,\s*'(https?:[^'"]+?\.pdf[^'"]*)'\)"/gi,
    'href="$1"'
  );
  html = html.replace(
    /href\s*=\s*'(?:javascript:)?openPDF\([^,]+,\s*"(https?:[^'"]+?\.pdf[^'"]*)"\)'/gi,
    "href=\"$1\""
  );
  return html;
}

// light HTML string cleanup for obvious blocks that sometimes slip through
function stripBoilerplateInHTML(html) {
  if (!html) return html;
  // remove "PDF Translations ... </ul>" block
  html = html.replace(/PDF\s+Translations[\s\S]*?<ul>[\s\S]*?<\/ul>/gi, '');
  // remove "Related Content ... (until next h2 or end)"
  html = html.replace(/<h2[^>]*>\s*Related\s+Content[\s\S]*/gi, '');
  // remove "Share ... Load More ..." sections
  html = html.replace(/<ul>[\s\S]*?(twitter|linkedin|facebook)[\s\S]*?<\/ul>/gi, '');
  html = html.replace(/Load More/gi, '');
  html = html.replace(/Subscribe/gi, '');
  html = html.replace(/Archived Memos/gi, '');
  return html;
}
/* --------------------------------------------------- */

async function getMemoLinks(page) {
  console.log('[info] navigating to list:', LIST_URL);
  await page.goto(LIST_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  const links = await page.evaluate(() => {
    const as = Array.from(document.querySelectorAll('a[href*="/insights/memo/"]'));
    return Array.from(new Set(as.map(a => a.href).filter(Boolean)));
  });
  const filtered = links.filter(u => (/\/insights\/memo\/.+/.test(u)));
  console.log('[info] memo links found:', filtered.length);
  return filtered;
}

function pickContentRoot(dom) {
  const candidates = [
    '.c-richtext', '.o-content', '.article__body', 'article', 'main', '.content', '.c-article'
  ];
  for (const sel of candidates) {
    const el = dom.querySelector(sel);
    if (el && el.text?.trim()?.length > 400) return el;
  }
  const ps = dom.querySelectorAll('p').slice(0, 6).map(p => p.toString()).join('\n');
  return parse(`<div>${ps}</div>`);
}

function sanitizeHTML(html) {
  return sanitizeHtml(html, {
    allowedTags: [
      'p','br','strong','em','b','i','u','blockquote',
      'ul','ol','li','h2','h3','h4','a','img','hr','code','pre'
    ],
    allowedAttributes: {
      'a': ['href','name','target','rel'],
      'img': ['src','alt','title','width','height']
    },
    transformTags: {
      'a': sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' })
    }
  });
}

function findPdfUrl(dom) {
  // direct links
  let el = dom.querySelector('a[href$=".pdf"], a[href*=".pdf?"], a[data-file$=".pdf"], a[data-href$=".pdf"]');
  if (el) {
    const href = el.getAttribute('href') || el.getAttribute('data-file') || el.getAttribute('data-href');
    if (href) {
      if (href.startsWith('javascript:openPDF')) {
        const pdf = extractPdfFromJsHref(href);
        if (pdf) return absolutize(pdf);
      }
      return absolutize(href);
    }
  }
  // javascript:openPDF on any clickable
  const any = dom.querySelector('a[href^="javascript:openPDF"], a[onclick*="openPDF"], button[onclick*="openPDF"]');
  const candidate = any?.getAttribute('href') || any?.getAttribute('onclick');
  if (candidate) {
    const pdf = extractPdfFromJsHref(candidate);
    if (pdf) return absolutize(pdf);
  }
  // link tag
  const linkAlt = dom.querySelector('link[type="application/pdf"]')?.getAttribute('href');
  if (linkAlt) return absolutize(linkAlt);
  return null;
}

async function fetchPDFtoHTML(url) {
  if (!_fetch) return null;
  try {
    console.log('[info] fetching pdf:', url);
    const res = await _fetch(url);
    if (!res.ok) {
      console.warn('[warn] pdf fetch failed status:', res.status);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const pdf = await pdfParseBuffer(buf);
    const paras = pdf.text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
    const html = paras.map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('\n');
    return `<div class="pdf-fulltext">${html}</div>`;
  } catch (e) {
    console.error('[error] PDF parse failed:', e?.message);
    return null;
  }
}

async function extractArticle(page, url) {
  console.log('[info] scraping:', url);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const html = await page.content();
  const dom = parse(html);

  const title = dom.querySelector('h1')?.text?.trim()
            || dom.querySelector('meta[property="og:title"]')?.getAttribute('content')
            || '';

  // robust pubDate (meta -> text in DOM -> text in HTML -> now)
let pubDate = extractDate(dom, html) || new Date().toUTCString();
if (!pubDate || String(pubDate).toLowerCase().includes('invalid')) {
  pubDate = new Date().toUTCString();
}

  // get PDF url
  let pdf = findPdfUrl(dom);

  // pick + clean root
  const root = pickContentRoot(dom);
  normalizeAnchors(root);
  stripBoilerplate(root);

  const firstP = root.querySelector('p')?.text?.trim() || '';
  const short = firstP.length > 240 ? firstP.slice(0, 237) + '...' : firstP;

  let fullHTML = sanitizeHTML(root.toString());

  // fallback to PDF fulltext when HTML still too short
  const plainLen = fullHTML.replace(/<[^>]+>/g, '').trim().length;
  if (plainLen < 600 && pdf) {
    const pdfHTML = await fetchPDFtoHTML(pdf);
    if (pdfHTML) fullHTML = sanitizeHTML(pdfHTML);
  }

  // extra sweep on final HTML string
  fullHTML = stripBoilerplateInHTML(fullHTML);
  fullHTML = fixOpenPDFInHTML(fullHTML);

  // ensure enclosure uses true PDF URL
  let enclosure = null;
  if (pdf) {
    if (pdf.startsWith('javascript:openPDF')) {
      const fixed = extractPdfFromJsHref(pdf);
      enclosure = fixed ? absolutize(fixed) : null;
    } else {
      enclosure = pdf;
    }
  }

  // also append a clear PDF link if available
  if (enclosure) {
    fullHTML += `<p><a href="${enclosure}" target="_blank" rel="noopener">Download PDF</a></p>`;
  }

  return { title, link: url, pubDate, description: short, fullHTML, enclosure };
}

function buildRSS(items) {
  const feed = {
    rss: {
      '@version': '2.0',
      '@xmlns:atom': 'http://www.w3.org/2005/Atom',
      '@xmlns:content': 'http://purl.org/rss/1.0/modules/content/',
      channel: {
        title: 'Oaktree Howard Marks Memos (Full-Text via PDF, Unofficial)',
        link: `${BASE}/insights/memo/`,
        description: 'Automatic full-text RSS for Howard Marks memos. Personal use only.',
        language: 'en',
        lastBuildDate: new Date().toUTCString(),
        'atom:link': { '@href': SELF_URL, '@rel': 'self', '@type': 'application/rss+xml' },
        item: items.map(it => ({
          title: it.title,
          link: it.link,
          guid: it.link,
          pubDate: (!it.pubDate || String(it.pubDate).toLowerCase().includes('invalid'))
            ? new Date().toUTCString()
            : it.pubDate,

          description: it.description ? `<![CDATA[${it.description.replace(/]]>/g, ']]]]><![CDATA[>')}]]>` : undefined,
          'content:encoded': `<![CDATA[${it.fullHTML.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`,
          enclosure: it.enclosure ? { '@url': it.enclosure, '@type': 'application/pdf' } : undefined
        }))
      }
    }
  };
  return create(feed).end({ prettyPrint: true });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let memoLinks = [];
  try {
    memoLinks = await getMemoLinks(page);
  } catch (e) {
    console.error('[error] failed to load list page:', e?.message);
  }

  const cap = 40;
  const toFetch = memoLinks.slice(0, cap);

  const items = [];
  for (const url of toFetch) {
    try {
      const item = await extractArticle(page, url);
      if (item.title) items.push(item);
      await sleep(250);
    } catch (e) {
      console.error('[error] failed on item:', url, e?.message);
    }
  }

  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, buildRSS(items), 'utf8');
  console.log('[info] RSS written to', OUTPUT_FILE);

  await browser.close();
}

main().catch(err => { console.error('[fatal]', err?.message); process.exit(1); });
