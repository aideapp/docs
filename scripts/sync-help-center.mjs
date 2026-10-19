#!/usr/bin/env node
// Generates the documentation pages and their navigation groups from the Aide help center.
//
//   node scripts/sync-help-center.mjs <help-center-dir> [--openapi <openapi.json>]
//
// The script owns only what it lists in scripts/help-center-manifest.json: the generated pages,
// the navigation groups named after help-center collections, and api-reference/openapi.json.
// Everything else in docs.json and the repo is left alone.

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS_JSON = join(ROOT, 'docs.json')
const MANIFEST = join(ROOT, 'scripts', 'help-center-manifest.json')
const OPENAPI_TARGET = 'api-reference/openapi.json'
const DOCS_TAB = 'Documentation'

const COLLECTIONS = [
  'Getting started',
  'Aide AI Agent',
  'Aide Chat',
  'Channels',
  'Aide Helpdesk',
  'Automation',
  'Knowledge',
  'Shopify',
  'Integrations',
  'Copilot',
  'Analytics',
  'Billing',
  'Developers',
  'Account',
]

// Articles listed here open their collection, in this order; the rest follow alphabetically.
const LEADS = [
  'what-is-aide',
  'create-workspace',
  'ai-agent-setup',
  'test-agent',
  'install-widget',
  'connect-helpdesk',
  'connect-shopify',
  'topics',
  'scenarios',
  'knowledge-sources',
  'copilot',
  'analytics',
  'plans-pricing',
  'api-keys-webhooks',
  'teammates-roles',
]

function fail(message) {
  console.error(`sync-help-center: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { source: undefined, openapi: undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--openapi') args.openapi = argv[++i]
    else if (argv[i].startsWith('--')) fail(`unknown option ${argv[i]}`)
    else args.source = argv[i]
  }
  if (!args.source) {
    fail('usage: node scripts/sync-help-center.mjs <help-center-dir> [--openapi <openapi.json>]')
  }
  return args
}

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

async function loadArticles(dir) {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.md')).sort()
  if (files.length === 0) fail(`no .md files in ${dir}`)
  const articles = []
  for (const file of files) {
    const text = (await readFile(join(dir, file), 'utf8')).replace(/\r\n?/g, '\n')
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
    if (!match) fail(`${file} has no front matter`)
    const meta = new Map(
      match[1].split('\n').map((line) => {
        const at = line.indexOf(':')
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
      })
    )
    const id = meta.get('id')
    const title = meta.get('title')
    const collection = meta.get('collection')
    if (!id || !title || !collection) fail(`${file} needs id, title and collection`)
    if (!/^[a-z0-9-]+$/.test(id)) fail(`${file}: id "${id}" is not a URL slug`)
    articles.push({ id, title, collection, body: match[2].trim() })
  }
  const seen = new Map()
  for (const article of articles) {
    if (seen.has(article.id)) fail(`duplicate id ${article.id}`)
    seen.set(article.id, article)
  }
  return articles
}

function collectionOrder(articles) {
  const known = COLLECTIONS.filter((name) => articles.some((a) => a.collection === name))
  const unknown = [...new Set(articles.map((a) => a.collection))]
    .filter((name) => !COLLECTIONS.includes(name))
    .sort((a, b) => a.localeCompare(b))
  for (const name of unknown) console.warn(`sync-help-center: unknown collection "${name}", listed last`)
  return [...known, ...unknown]
}

function articleOrder(a, b) {
  const rank = (article) => {
    const at = LEADS.indexOf(article.id)
    return at === -1 ? LEADS.length : at
  }
  return rank(a) - rank(b) || a.title.localeCompare(b.title, 'en')
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Splits a line into prose and inline-code segments; a code span closes on a backtick run of the
// same length (CommonMark), and an unmatched run is prose.
function inlineSegments(line) {
  const segments = []
  let prose = ''
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`') {
      prose += line[i++]
      continue
    }
    let run = 0
    while (line[i + run] === '`') run++
    const fence = '`'.repeat(run)
    let close = line.indexOf(fence, i + run)
    while (close !== -1 && (line[close + run] === '`' || line[close - 1] === '`')) {
      close = line.indexOf(fence, close + 1)
    }
    if (close === -1) {
      prose += fence
      i += run
      continue
    }
    if (prose) segments.push({ code: false, text: prose })
    prose = ''
    segments.push({ code: true, text: line.slice(i, close + run) })
    i = close + run
  }
  if (prose) segments.push({ code: false, text: prose })
  return segments
}

function makeConverter(articles, pathOf) {
  const byTitle = [...articles].sort((a, b) => b.title.length - a.title.length)
  const titlePattern = new RegExp(
    `["\u201C](${byTitle.map((a) => escapeRegExp(a.title)).join('|')})["\u201D]`,
    'g'
  )
  const pathByTitle = new Map(articles.map((a) => [a.title, pathOf(a)]))

  const prose = (text, self) =>
    text
      .replace(/</g, '&lt;')
      .replace(/[{}]/g, (brace) => `\\${brace}`)
      .replace(titlePattern, (quoted, title) =>
        title === self.title ? quoted : `[${title}](${pathByTitle.get(title)})`
      )

  const line = (text, self) => {
    const converted = inlineSegments(text)
      .map((segment) => (segment.code ? segment.text : prose(segment.text, self)))
      .join('')
    return converted.replace(/^(\s*)(import|export)(\s)/, '$1&#x200B;$2$3')
  }

  return function convert(article) {
    const out = []
    const lines = article.body.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const fence = /^\s*(`{3,}|~{3,})/.exec(lines[i])
      if (fence) {
        const closing = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`)
        out.push(lines[i])
        while (++i < lines.length) {
          out.push(lines[i])
          if (closing.test(lines[i])) break
        }
        continue
      }
      out.push(line(lines[i], article))
    }
    return out.join('\n')
  }
}

function plainText(markdown) {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function describe(article) {
  const paragraph = []
  for (const line of article.body.split('\n')) {
    const blank = line.trim() === ''
    const block = /^(#{1,6}\s|```|~~~|\||\s*[-*+]\s|\s*\d+[.)]\s)/.test(line)
    if (paragraph.length && (blank || block)) break
    if (!blank && !block) paragraph.push(line.trim())
  }
  if (!paragraph.length) fail(`${article.id} has no opening paragraph for its description`)
  return firstSentence(plainText(paragraph.join(' ')))
}

function firstSentence(text) {
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') quoted = !quoted
    else if (char === '\u201C') quoted = true
    else if (char === '\u201D') quoted = false
    else if (!quoted && /[.!?]/.test(char) && /^(\s+["'\u201C(]?[A-Z0-9]|$)/.test(text.slice(i + 1))) {
      return text.slice(0, i + 1)
    }
  }
  return text
}

const yamlString = (text) => JSON.stringify(text)

function renderPage(article, body) {
  return [
    '---',
    `title: ${yamlString(article.title)}`,
    `description: ${yamlString(describe(article))}`,
    '---',
    '',
    `{/* Generated from the Aide help center article "${article.id}" by scripts/sync-help-center.mjs. Edit the article and re-sync instead of editing this file. */}`,
    '',
    body,
    '',
  ].join('\n')
}

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback
  return JSON.parse(await readFile(path, 'utf8'))
}

async function removeEmptyDirs(paths) {
  const dirs = [...new Set(paths.map((path) => dirname(join(ROOT, path))))]
  for (const dir of dirs) {
    if (dir === ROOT || !existsSync(dir)) continue
    if ((await readdir(dir)).length === 0) await rmdir(dir)
  }
}

function updateNavigation(docs, previousGroups, groups) {
  const tabs = docs.navigation?.tabs
  if (!Array.isArray(tabs)) fail('docs.json has no navigation.tabs')
  const owned = new Set(previousGroups)
  let target = tabs.find((tab) => (tab.groups ?? []).some((group) => owned.has(group.group)))
  target ??= tabs.find((tab) => tab.tab === DOCS_TAB)
  if (!target) fail(`docs.json has no "${DOCS_TAB}" tab`)

  for (const tab of tabs) {
    if (!tab.groups) continue
    const clash = tab.groups.find(
      (group) => !owned.has(group.group) && groups.some((g) => g.group === group.group)
    )
    if (clash) fail(`docs.json group "${clash.group}" is not generated; rename or remove it first`)
  }

  target.groups ??= []
  const at = target.groups.findIndex((group) => owned.has(group.group))
  for (const tab of tabs) {
    if (tab.groups) tab.groups = tab.groups.filter((group) => !owned.has(group.group))
  }
  target.groups.splice(at === -1 ? target.groups.length : at, 0, ...groups)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const source = resolve(args.source)
  const articles = await loadArticles(source)
  const collections = collectionOrder(articles)
  const slugs = new Map(collections.map((name) => [name, slugify(name)]))
  const pathOf = (article) => `/${slugs.get(article.collection)}/${article.id}`
  const convert = makeConverter(articles, pathOf)

  const manifest = await readJson(MANIFEST, { pages: [], groups: [], apiSpec: null })

  for (const page of manifest.pages) await rm(join(ROOT, `${page}.mdx`), { force: true })
  await removeEmptyDirs(manifest.pages.map((page) => `${page}.mdx`))

  const pages = []
  const groups = []
  for (const collection of collections) {
    const members = articles.filter((a) => a.collection === collection).sort(articleOrder)
    const groupPages = []
    for (const article of members) {
      const page = pathOf(article).slice(1)
      const file = join(ROOT, `${page}.mdx`)
      if (existsSync(file)) fail(`${page}.mdx exists and was not generated; move it first`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, renderPage(article, convert(article)))
      groupPages.push(page)
      pages.push(page)
    }
    groups.push({ group: collection, pages: groupPages })
  }

  const docs = await readJson(DOCS_JSON, null)
  if (!docs) fail('docs.json not found')
  updateNavigation(docs, manifest.groups, groups)
  await writeFile(DOCS_JSON, `${JSON.stringify(docs, null, 2)}\n`)

  let apiSpec = manifest.apiSpec ?? null
  if (args.openapi) {
    const spec = JSON.parse(await readFile(resolve(args.openapi), 'utf8'))
    if (!spec.openapi || !spec.paths) fail(`${args.openapi} is not an OpenAPI document`)
    await mkdir(dirname(join(ROOT, OPENAPI_TARGET)), { recursive: true })
    await writeFile(join(ROOT, OPENAPI_TARGET), `${JSON.stringify(spec, null, 2)}\n`)
    apiSpec = OPENAPI_TARGET
  }

  // No top-level "openapi" key here: Mintlify treats any JSON file with one as an OpenAPI spec.
  await writeFile(MANIFEST, `${JSON.stringify({ pages, groups: collections, apiSpec }, null, 2)}\n`)

  const titles = new Map(articles.map((a) => [a.title.toLowerCase(), a.title]))
  for (const article of articles) {
    for (const [, quoted] of article.body.matchAll(/"([^"\n]{12,120})"/g)) {
      const title = titles.get(quoted.toLowerCase())
      if (title && title !== quoted) {
        console.warn(`sync-help-center: ${article.id} quotes "${quoted}", not linked (title is "${title}")`)
      }
    }
  }
  console.log(
    `sync-help-center: ${pages.length} pages in ${collections.length} groups` +
      (args.openapi ? `, OpenAPI copied to ${OPENAPI_TARGET}` : '')
  )
}

await main()
