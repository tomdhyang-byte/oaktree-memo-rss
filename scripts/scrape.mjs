
import { chromium } from 'playwright';
import { create } from 'xmlbuilder2';
import dayjs from 'dayjs';
import { parse } from 'node-html-parser';
import sanitizeHtml from 'sanitize-html';
import fs from 'fs';
import path from 'path';

const BASE = 'https://www.oaktreecapital.com';
const LIST_URL = `${BASE}/insights`;
const OUTPUT_DIR = 'docs';
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'feed.xml');

// Your public Pages feed URL (used for <atom:link> self reference)
const SELF_URL = 'https://tomdhyang-byte.github.io/oaktree-memo-rss/feed.xml';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function absolutize(url) {
  if (!url) return url;
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return BASE + url;
  return url;
}

async function getMemoLinks(page) {
  await page.goto(LIST_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  const links = await page.evaluate(() => {
    const as = Array.from(document.querySelectorAll('a[href*="/insights/memo/"]'));
    return Array.from(new Set(as.map(a => a.href).filter(Boolean)));
  });
  return links.filter(u => (/\/insights\/memo\/.+/.test(u)));
}

function extractDate(dom) {
  const t = dom.querySelector('time[datetime]')?.getAttribute('datetime')
        || dom.querySelector('meta[property="article:published_time"]')?.getAttribute('content')
        || dom.querySelector('meta[name="date"]')?.getAttribute('content')
        || null;
  return t ? new Date(t).toUTCString() : new Date().toUTCString();
}

function pickContentRoot(dom) {
  const candidates = [
    '.c-richtext', '.o-content', '.article__body', 'article',
    'main', '.content', '.c-article'
  ];
  for (const sel of candidates) {
    const el = dom.querySelector(sel);
    if (el && el.text?.trim()?.length > 200) return el;
  }
  const ps = dom.querySelectorAll('p').slice(0, 10).map(p => p.toString()).join('\n');
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
      'a': sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
      'img': (tagName, attribs) => {
        return { tagName, attribs: { ...attribs, src: attribs.src ? attribs.src : '' } };
      }
    }
  });
}

async function extractArticle(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const html = await page.content();
  const dom = parse(html);

  const title = dom.querySelector('h1')?.text?.trim()
            || dom.querySelector('meta[property="og:title"]')?.getAttribute('content')
            || '';
  const pubDate = extractDate(dom);

  let pdf = dom.querySelector('a[href$=".pdf"], a[href*=".pdf?"]')?.getAttribute('href') || null;
  pdf = absolutize(pdf);

  const root = pickContentRoot(dom);

  root.querySelectorAll('a').forEach(a => a.setAttribute('href', absolutize(a.getAttribute('href'))));
  root.querySelectorAll('img').forEach(img => img.setAttribute('src', absolutize(img.getAttribute('src'))));

  const firstP = root.querySelector('p')?.text?.trim() || '';
  const short = firstP.length > 240 ? firstP.slice(0, 237) + '...' : firstP;

  const fullHTML = sanitizeHTML(root.toString());

  return {
    title,
    link: url,
    pubDate,
    description: short,
    fullHTML,
    enclosure: pdf
  };
}

function buildRSS(items) {
  const feed = {
    rss: {
      '@version': '2.0',
      '@xmlns:atom': 'http://www.w3.org/2005/Atom',
      '@xmlns:content': 'http://purl.org/rss/1.0/modules/content/',
      channel: {
        title: 'Oaktree Howard Marks Memos (Full‑Text, Unofficial)',
        link: `${BASE}/insights/memo/`,
        description: 'Automatic full‑text RSS for Howard Marks memos from Oaktree Capital. Personal use only.',
        language: 'en',
        lastBuildDate: new Date().toUTCString(),
        'atom:link': {
          '@href': SELF_URL,
          '@rel': 'self',
          '@type': 'application/rss+xml'
        },
        item: items.map(it => ({
          title: it.title,
          link: it.link,
          guid: it.link,
          pubDate: it.pubDate,
          description: it.description ? `<![CDATA[${it.description.replace(/]]>/g, ']]]]><![CDATA[>')}]]>` : undefined,
          'content:encoded': `<![CDATA[${it.fullHTML.replace(/]]>/g, ']]]]><![CDATA[>')}${it.enclosure ? `<p><a href="${it.enclosure}" target="_blank" rel="noopener">Download PDF</a></p>` : ''}]]>`,
          enclosure: it.enclosure ? { '@url': it.enclosure, '@type': 'application/pdf' } : undefined
        }))
      }
    }
  };
  return create(feed).end({ prettyPrint: true });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Fetching memo links from', LIST_URL);
  const memoLinks = await getMemoLinks(page);

  const cap = 40;
  const toFetch = memoLinks.slice(0, cap);

  const items = [];
  for (const url of toFetch) {
    try {
      console.log('Scraping', url);
      const item = await extractArticle(page, url);
      if (item.title) items.push(item);
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      console.error('Failed on', url, e);
    }
  }

  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const xml = buildRSS(items);
  fs.writeFileSync(OUTPUT_FILE, xml, 'utf8');
  console.log('RSS written to', OUTPUT_FILE);

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
