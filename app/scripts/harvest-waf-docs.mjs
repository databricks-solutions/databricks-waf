#!/usr/bin/env node
// Harvest the structure of the Well-Architected Framework best-practices pages.
//
// This exists twice over. Once to seed the catalogue with real titles and real
// source anchors, because a control claiming `provenance: waf-docs` and carrying
// a `source_anchor` must actually correspond to published guidance — inventing
// titles from memory and asserting they are the framework would be precisely the
// dishonesty the provenance field exists to prevent.
//
// And once as the input to drift detection, since knowing what the docs say
// today is the only way to notice that they changed.
//
// Output is a normalised JSON structure: pillars -> principles -> best practices.

import { writeFileSync } from 'node:fs';
import { argv } from 'node:process';

export const PILLARS = [
  { code: 'DG', id: 'data-and-ai-governance', slug: 'data-governance', title: 'Data and AI governance' },
  {
    code: 'IU',
    id: 'interoperability-and-usability',
    slug: 'interoperability-and-usability',
    title: 'Interoperability and usability',
  },
  { code: 'OE', id: 'operational-excellence', slug: 'operational-excellence', title: 'Operational excellence' },
  {
    code: 'SCP',
    id: 'security-compliance-and-privacy',
    slug: 'security-compliance-and-privacy',
    title: 'Security, compliance, and privacy',
  },
  { code: 'REL', id: 'reliability', slug: 'reliability', title: 'Reliability' },
  { code: 'PE', id: 'performance-efficiency', slug: 'performance-efficiency', title: 'Performance efficiency' },
  { code: 'CO', id: 'cost-optimization', slug: 'cost-optimization', title: 'Cost optimization' },
];

const BASE = 'https://docs.databricks.com/aws/en/lakehouse-architecture';

export function pageUrl(slug) {
  return `${BASE}/${slug}/best-practices`;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '...')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–');
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<sup[\s\S]*?<\/sup>/g, '')
      // Docusaurus appends a "Direct link to ..." hash-link anchor inside every
      // heading. Its label text and the zero-width space it carries would
      // otherwise end up in the harvested title and break exact-match drift
      // detection on every single control.
      .replace(/<a\b[^>]*hash-link[^>]*>[\s\S]*?<\/a>/gi, '')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Attribute values on these pages are unquoted (id=some-slug), so a
// quotes-only pattern silently matches nothing and every anchor comes back null.
function attrValue(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

// Headings that are page furniture rather than framework content.
const FURNITURE = /^(in this article|feedback|additional resources?|next steps?|related articles?|see also)$/i;

// The docs render principles as <h2> and the best practices under them as <h3>,
// each with an id attribute we can anchor to. Parsing headings rather than the
// whole DOM keeps this resilient to styling changes, which are frequent, while
// still failing loudly on structural ones, which are what we care about.
export function extractHeadings(html) {
  const out = [];
  const re = /<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const level = Number(m[1]);
    const attrs = m[2] ?? '';
    const text = stripTags(m[3]);
    if (!text) continue;
    if (FURNITURE.test(text)) continue;
    out.push({ level, id: attrValue(attrs, 'id'), text });
  }
  return out;
}

export function toStructure(pillar, html) {
  const headings = extractHeadings(html);
  const principles = [];
  let current = null;
  let principleIndex = 0;

  for (const h of headings) {
    if (h.level === 2) {
      principleIndex += 1;
      current = {
        id: `${pillar.code}-${String(principleIndex).padStart(2, '0')}`,
        anchor: h.id,
        title: h.text,
        source_anchor: `${pageUrl(pillar.slug)}${h.id ? `#${h.id}` : ''}`,
        best_practices: [],
      };
      principles.push(current);
    } else if (h.level === 3 && current) {
      current.best_practices.push({
        id: `${current.id}-${String(current.best_practices.length + 1).padStart(2, '0')}`,
        anchor: h.id,
        title: h.text,
        source_anchor: `${pageUrl(pillar.slug)}${h.id ? `#${h.id}` : ''}`,
      });
    }
  }
  return principles;
}

export async function harvest({ fetchImpl = fetch } = {}) {
  const pillars = [];
  for (const pillar of PILLARS) {
    const url = pageUrl(pillar.slug);
    const res = await fetchImpl(url, {
      headers: { 'user-agent': 'databricks-waf-assessment/catalogue-harvest' },
    });
    if (!res.ok) {
      throw new Error(`${url} returned ${res.status}. The documentation URL may have moved.`);
    }
    const html = await res.text();
    const principles = toStructure(pillar, html);
    if (principles.length === 0) {
      throw new Error(
        `${url} yielded no principles. The page structure has probably changed and this parser needs updating.`
      );
    }
    pillars.push({ ...pillar, page: url, principles });
  }
  return { harvested_at: new Date().toISOString(), pillars };
}

function summarise(data) {
  let principles = 0;
  let practices = 0;
  for (const p of data.pillars) {
    principles += p.principles.length;
    for (const pr of p.principles) practices += pr.best_practices.length;
  }
  return { pillars: data.pillars.length, principles, practices };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? argv[outIdx + 1] : 'harvest.json';
  const data = await harvest();
  writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
  const s = summarise(data);
  console.log(`Harvested ${s.pillars} pillars, ${s.principles} principles, ${s.practices} best practices -> ${out}`);
  for (const p of data.pillars) {
    const n = p.principles.reduce((a, pr) => a + pr.best_practices.length, 0);
    console.log(
      `  ${p.code.padEnd(4)} ${String(p.principles.length).padStart(2)} principles  ${String(n).padStart(3)} practices  ${p.title}`
    );
  }
}
