
import { chromium } from 'playwright';
import { create } from 'xmlbuilder2';
import dayjs from 'dayjs';
import { parse } from 'node-html-parser';
import fs from 'fs';
import path from 'path';

const BASE = 'https://www.oaktreecapital.com';
const LIST_URL = `${BASE}/insights`;
const OUTPUT_DIR = 'docs';
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'feed.xml');

// Helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getMemoLinks(page) {
  await page.goto(LIST_URL, { waitUntil: 'networkidle' });
  // 秋刀魚級等待：確保 SPA 內容已經渲染
  await page.waitForTimeout(2000);

  // 抓所有 a[href*="/insights/memo/"]
  const links = await page.evaluate(() => {
    const as = Array.from(document.querySelectorAll('a[href*="/insights/memo/"]'));
    const urls = as.map(a => a.href).filter(Boolean);
    return Array.from(new Set(urls));
  });
  return links;
}

async function extractArticle(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const html = await page.content();
  const dom = parse(html);

  // 標題
  let title = dom.querySelector('h1')?.text?.trim() || dom.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';

  // 發佈日期：可能出現在 <time datetime="..."> 或 meta
  let pubDate = dom.querySelector('time[datetime]')?.getAttribute('datetime')
    || dom.querySelector('meta[property="article:published_time"]')?.getAttribute('content')
    || dom.querySelector('meta[name="date"]')?.getAttribute('content')
    || null;

  // 內文主要容器：嘗試幾個常見 class
  const candidates = [
    'article', '.content', '.c-article', '.c-richtext', '.o-content', 'main'
  ];
  let articleRoot = null;
  for (const sel of candidates) {
    const el = dom.querySelector(sel);
    if (el && el.text.trim().length > 200) { articleRoot = el; break; }
  }
  if (!articleRoot) {
    // fallback: 全文搜尋 p
    const paragraphs = dom.querySelectorAll('p').slice(0, 6).map(p => p.text.trim());
    articleRoot = { innerText: paragraphs.join('\n\n') };
  }

  // 摘要：取前 3~5 個段落
  let paragraphs = [];
  try {
    paragraphs = (articleRoot.querySelectorAll?.('p') || [])
      .map(p => p.text?.trim())
      .filter(Boolean)
      .slice(0, 5);
  } catch {
    paragraphs = (articleRoot.innerText || '').split('\n').slice(0, 5);
  }
  const description = paragraphs.join('\n\n');

  // PDF 連結：抓第一個 .pdf
  let pdf = null;
  const pdfA = dom.querySelector('a[href$=".pdf"], a[href*=".pdf?"]');
  if (pdfA) {
    const href = pdfA.getAttribute('href');
    pdf = href?.startsWith('http') ? href : (BASE + href);
  }

  return {
    title,
    link: url,
    pubDate: pubDate ? new Date(pubDate).toUTCString() : new Date().toUTCString(),
    description,
    enclosure: pdf
  };
}

function buildRSS(items) {
  const feed = {
    rss: {
      '@version': '2.0',
      '@xmlns:atom': 'http://www.w3.org/2005/Atom',
      channel: {
        title: "Oaktree Howard Marks Memos (Unofficial)",
        link: `${BASE}/insights/memo/`,
        description: "Auto-generated RSS feed for Howard Marks memos from Oaktree Capital.",
        language: "en",
        lastBuildDate: new Date().toUTCString(),
        'atom:link': {
          '@href': 'REPLACE_WITH_YOUR_PAGES_URL/feed.xml',
          '@rel': 'self',
          '@type': 'application/rss+xml'
        },
        item: items.map(it => ({
          title: it.title,
          link: it.link,
          guid: it.link,
          pubDate: it.pubDate,
          description: it.description ? `<![CDATA[${it.description.replace(/]]>/g, ']]]]><![CDATA[>')}]]>` : undefined,
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
  const links = await getMemoLinks(page);
  // 只保留 /insights/memo/ 的 unique 連結，且排除沒有 slug 的目錄頁
  const memoLinks = Array.from(new Set(links)).filter(u => /\/insights\/memo\/.+/.test(u));

  console.log('Found memo links:', memoLinks.length);
  // 可在此限制最大抓取數量（例如最近 40 篇）
  const cap = 40;
  const toFetch = memoLinks.slice(0, cap);

  const items = [];
  for (const url of toFetch) {
    try {
      console.log('Scraping', url);
      const item = await extractArticle(page, url);
      if (item.title) items.push(item);
      await sleep(300); // 禮貌性等待
    } catch (e) {
      console.error('Failed on', url, e);
    }
  }

  // 依日期排序（新到舊）
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
