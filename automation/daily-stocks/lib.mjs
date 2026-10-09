import { execFile } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DIR = path.dirname(fileURLToPath(import.meta.url))
export const OUT_DIR = path.join(DIR, 'out')
export const config = JSON.parse(readFileSync(path.join(DIR, 'config.json'), 'utf8'))

// Local runs read keys from .env.local. In the cloud routine the keys are NOT in the
// environment: the network proxy injects them as request headers, so these stay empty.
const loadEnvFile = (file) => {
  if (!existsSync(file)) return {}
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(line => line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.replace(/^["']|["']$/g, '')])
  )
}
const env = { ...loadEnvFile(path.join(DIR, '.env.local')), ...process.env }
const optionalHeader = (name, value) => (value ? { [name]: value } : {})

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// A minimal fetch() replacement built on curl. In the cloud routine the API keys are added by the
// sandbox's network proxy, and Node's fetch ignores the HTTPS_PROXY setting (and the proxy's CA
// certificate), so its requests reach the APIs without the keys. curl honors both.
function http(url, { method = 'GET', headers = {}, body } = {}) {
  const args = ['-sS', '-X', method, '--max-time', '120', '-w', '\n%{http_code}']
  for (const [name, value] of Object.entries(headers)) args.push('-H', `${name}: ${value}`)
  if (body != null) args.push('--data-binary', '@-')
  args.push(String(url))
  return new Promise((resolve, reject) => {
    const child = execFile('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`curl ${method} ${new URL(url).host}: ${stderr.trim() || err.message}`))
      const split = stdout.lastIndexOf('\n')
      const text = stdout.slice(0, split)
      const status = Number(stdout.slice(split + 1))
      resolve({ status, ok: status >= 200 && status < 300, text: async () => text, json: async () => JSON.parse(text) })
    })
    if (body != null) child.stdin.end(body)
  })
}

// YYYY-MM-DD in Taiwan time
export const taipeiDate = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(date)

export async function youtube(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`)
  for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, value)
  const res = await http(url, { headers: optionalHeader('X-Goog-Api-Key', env.YOUTUBE_API_KEY) })
  if (!res.ok) throw new Error(`YouTube API ${endpoint} ${res.status}: ${await res.text()}`)
  return res.json()
}

// Existing captions only (mode=native): 1 credit each, never the 2-credits-per-minute AI transcription.
// Returns the transcript text, or null when the video has no captions.
export async function fetchTranscript(videoUrl) {
  const headers = optionalHeader('x-api-key', env.SUPADATA_API_KEY)
  const url = new URL('https://api.supadata.ai/v1/transcript')
  url.searchParams.set('url', videoUrl)
  url.searchParams.set('text', 'true')
  url.searchParams.set('mode', 'native')
  // Without a language Supadata may return YouTube's auto-translated English track
  url.searchParams.set('lang', config.transcriptLang || 'zh')

  const res = await http(url, { headers })
  if (res.status === 206) return null
  if (res.status === 202) {
    // Long videos are processed as a job
    const { jobId } = await res.json()
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(5000)
      const job = await (await http(`https://api.supadata.ai/v1/transcript/${jobId}`, { headers })).json()
      if (job.status === 'completed') return job.content
      if (job.status === 'failed') throw new Error(`Supadata job failed: ${JSON.stringify(job.error)}`)
    }
    throw new Error(`Supadata job ${jobId} timed out`)
  }
  if (!res.ok) throw new Error(`Supadata ${res.status}: ${await res.text()}`)
  return (await res.json()).content
}

// Credits used this billing period, e.g. { usedCredits: 8, maxCredits: 100 }. Costs no credits.
export async function supadataUsage() {
  const res = await http('https://api.supadata.ai/v1/me', { headers: optionalHeader('x-api-key', env.SUPADATA_API_KEY) })
  if (!res.ok) throw new Error(`Supadata /me ${res.status}: ${await res.text()}`)
  return res.json()
}

// Calls a TubeNotes database function, authenticated by the ingest token header
export async function rpc(fn, args) {
  const res = await http(`${config.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      'Content-Type': 'application/json',
      ...optionalHeader('x-ingest-token', env.INGEST_TOKEN),
    },
    body: JSON.stringify(args),
  })
  if (!res.ok) throw new Error(`Supabase ${fn} ${res.status}: ${await res.text()}`)
  return res.json()
}
