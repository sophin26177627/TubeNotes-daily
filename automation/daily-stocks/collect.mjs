// Step 1 of the daily routine: find new videos on the configured channels, skip ones already
// summarized, and download their transcripts into out/<date>/.
//
// Usage: node collect.mjs [--days N] [--only ID,ID] [--dry-run]
//   --days N    look back N days instead of config.lookbackDays
//   --only IDs  only process these video IDs (for manual tests / reruns)
//   --dry-run   list the videos that would be processed, without fetching transcripts

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config, OUT_DIR, youtube, fetchTranscript, rpc, taipeiDate } from './lib.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const lookbackDays = Number(option('--days')) || config.lookbackDays
const onlyIds = option('--only')?.split(',')
// The look-back window is wider than the gap between runs (weekends, a failed run) so nothing is
// missed; already summarized videos are filtered out below. notBefore stops backfilling videos
// from before the automation started.
const since = Math.max(
  Date.now() - lookbackDays * 864e5,
  config.notBefore ? new Date(`${config.notBefore}T00:00:00+08:00`).getTime() : 0,
)

// PT1H2M3S -> seconds
const parseDuration = (iso) => {
  const m = iso?.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  if (!m) return 0
  const [, d, h, min, s] = m.map(part => Number(part || 0))
  return d * 86400 + h * 3600 + min * 60 + s
}

async function recentUploads(channelId) {
  const playlistId = 'UU' + channelId.slice(2) // the channel's "all uploads" playlist
  const videos = []
  let pageToken
  for (let page = 0; page < 20; page++) {
    const data = await youtube('playlistItems', { part: 'snippet,contentDetails', playlistId, maxResults: '50', pageToken })
    let reachedOld = false
    for (const item of data.items) {
      const publishedAt = item.contentDetails.videoPublishedAt || item.snippet.publishedAt
      if (new Date(publishedAt).getTime() < since) { reachedOld = true; continue }
      videos.push({ videoId: item.contentDetails.videoId, title: item.snippet.title, publishedAt })
    }
    pageToken = data.nextPageToken
    if (reachedOld || !pageToken) break
  }
  return videos
}

async function videoDetails(ids) {
  const details = new Map()
  for (let i = 0; i < ids.length; i += 50) {
    const data = await youtube('videos', { part: 'contentDetails,snippet', id: ids.slice(i, i + 50).join(',') })
    for (const v of data.items) {
      details.set(v.id, { seconds: parseDuration(v.contentDetails.duration), live: v.snippet.liveBroadcastContent })
    }
  }
  return details
}

const candidates = []
for (const channel of config.channels) {
  // The episode key is the part of the title the pattern matches (e.g. "【錢線百分百】20261008完整版(上集)",
  // "EP264"), so stray prefixes or a reworded re-upload still count as the same episode
  let videos = await recentUploads(channel.channelId)
  const pattern = channel.titlePattern && new RegExp(channel.titlePattern)
  const episodeKey = (title) =>
    (pattern ? title.match(pattern)[0] : title).replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').toUpperCase()
  if (pattern) videos = videos.filter(v => pattern.test(v.title))

  // Drop Shorts, upcoming premieres and live streams still in progress
  const details = await videoDetails(videos.map(v => v.videoId))
  videos = videos.filter(v => {
    const d = details.get(v.videoId)
    return d && d.live === 'none' && d.seconds >= (channel.minDurationSeconds || 60)
  })

  // Some episodes are uploaded twice; keep the earliest upload. Already summarized uploads are still in
  // the list at this point, so a later re-upload of a summarized episode is dropped too.
  videos.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
  const seenEpisodes = new Set()
  videos = videos.filter(v => {
    const key = episodeKey(v.title)
    return !seenEpisodes.has(key) && seenEpisodes.add(key)
  })

  for (const v of videos) {
    candidates.push({
      ...v,
      channelKey: channel.key,
      channelName: channel.name,
      url: `https://www.youtube.com/watch?v=${v.videoId}`,
    })
  }
}

const processed = new Set(candidates.length ? await rpc('daily_stocks_processed', { p_video_ids: candidates.map(v => v.videoId) }) : [])
const pending = candidates.filter(v => !processed.has(v.videoId) && (!onlyIds || onlyIds.includes(v.videoId)))

if (pending.length === 0) {
  console.log('NO_NEW_VIDEOS')
  process.exit(0)
}

if (flag('--dry-run')) {
  for (const v of pending) console.log(`${v.channelName} | ${v.publishedAt} | ${v.videoId} | ${v.title}`)
  process.exit(0)
}

const date = taipeiDate()
const dir = path.join(OUT_DIR, date)
mkdirSync(path.join(dir, 'transcripts'), { recursive: true })

const videos = []
const skipped = []
for (const v of pending) {
  try {
    const text = await fetchTranscript(v.url)
    if (!text) { skipped.push({ ...v, reason: 'no captions' }); continue }
    const transcriptFile = `transcripts/${v.videoId}.txt`
    writeFileSync(path.join(dir, transcriptFile), text)
    videos.push({ ...v, transcriptFile, transcriptChars: text.length })
  } catch (err) {
    skipped.push({ ...v, reason: err.message })
  }
}

writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ date, videos, skipped }, null, 2))

console.log(`OUTPUT_DIR ${path.relative(process.cwd(), dir) || '.'}`)
for (const v of videos) console.log(`OK      ${v.channelName} | ${v.title} (${v.transcriptChars} chars)`)
for (const v of skipped) console.log(`SKIPPED ${v.channelName} | ${v.title} | ${v.reason}`)
if (videos.length === 0) console.log('NO_TRANSCRIPTS')
