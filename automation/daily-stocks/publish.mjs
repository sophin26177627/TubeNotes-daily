// Step 3 of the daily routine: save out/<date>/note.json as one note in the 每日股市 folder
// and mark the videos in the manifest as processed.
//
// Usage: node publish.mjs [YYYY-MM-DD]   (defaults to today in Taiwan time)

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { OUT_DIR, config, rpc, supadataUsage, taipeiDate } from './lib.mjs'

const date = process.argv[2] || taipeiDate()
const dir = path.join(OUT_DIR, date)
const read = (file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8'))

if (!existsSync(path.join(dir, 'note.json'))) {
  console.error(`Missing ${path.join(dir, 'note.json')}`)
  process.exit(1)
}
const manifest = read('manifest.json')
const note = read('note.json')

// Every summarized video must be linked in the note
const missing = manifest.videos.filter(v => !note.contentHtml?.includes(v.videoId))
if (!note.contentHtml || note.contentHtml.length < 200 || missing.length) {
  console.error('note.json is incomplete.')
  for (const v of missing) console.error(`  missing link for: ${v.title}`)
  process.exit(1)
}

const weekday = '日一二三四五六'[new Date(`${date}T12:00:00+08:00`).getUTCDay()]
const title = `每日股市整理 ${date.replaceAll('-', '/')}（${weekday}）`

// The note's link (and card thumbnail) points at the main 錢線百分百 episode when there is one
const main = manifest.videos.find(v => /完整版\s*[(（](上集|全集)[)）]/.test(v.title)) || manifest.videos[0]

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// Next monthly reset of the Supadata free credits, as MM/DD
const nextReset = () => {
  const [y, m, d] = date.split('-').map(Number)
  const day = config.supadataResetDay || 1
  const reset = new Date(Date.UTC(y, d < day ? m - 1 : m, day))
  return `${String(reset.getUTCMonth() + 1).padStart(2, '0')}/${String(day).padStart(2, '0')}`
}

// Footer added by code, not by the summarizer: videos left for the next run, and credit usage
let footer = ''
if (manifest.skipped?.length) {
  footer += '<h4>未整理的影片（下次執行會再試）</h4><ul>'
  for (const v of manifest.skipped) {
    footer += `<li>${escapeHtml(v.channelName)}｜${escapeHtml(v.title)}（${escapeHtml(v.reason)}）</li>`
  }
  footer += '</ul>'
}
try {
  const { usedCredits, maxCredits } = await supadataUsage()
  footer += `<p><em>Supadata: ${usedCredits}/${maxCredits}, reset on ${nextReset()}</em></p>`
} catch (err) {
  console.error(`Could not read Supadata usage: ${err.message}`)
  footer += '<p><em>Supadata: usage unavailable</em></p>'
}

const uniq = (list) => [...new Set((list || []).map(s => String(s).trim()).filter(Boolean))]

const noteId = await rpc('daily_stocks_publish', {
  p_title: title,
  p_content: note.contentHtml + footer,
  p_url: main.url,
  p_keywords: uniq(note.keywords).slice(0, 40),
  p_hashtags: uniq(note.hashtags).map(h => h.replace(/^[#＃]+/, '')),
  p_videos: manifest.videos.map(v => ({ video_id: v.videoId, channel: v.channelName, title: v.title })),
})

console.log(`PUBLISHED ${title} (note ${noteId})`)
