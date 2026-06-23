import { createJob, getSettings, listJobs } from './database'
import { scrapeJobFromUrl } from './jobScraper'
import { fetchHtmlViaBrowser, isChallengePage } from './browserScraper'
import type { Job, ScanFilters, WorkType } from './types'

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

interface BoardConfig {
  name: string
  searchUrl: (keywords: string, location: string) => string
  useBrowser: boolean
}

const BOARDS: BoardConfig[] = [
  {
    name: 'LinkedIn',
    searchUrl: (k, l) => `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(k)}${l ? `&location=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'Indeed',
    searchUrl: (k, l) => `https://www.indeed.com/q-${encodeURIComponent(k)}-l-${encodeURIComponent(l || '')}-jobs.html`,
    useBrowser: true
  },
  {
    name: 'Glassdoor',
    searchUrl: (k, l) => `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(k)}${l ? `&locT=C&locId=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'Cryptocurrency Jobs',
    searchUrl: (k) => `https://cryptocurrencyjobs.co/?search=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'CryptoJobsList',
    searchUrl: (k) => `https://cryptojobslist.com/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'cryptojobs.com',
    searchUrl: (k) => `https://www.cryptojobs.com/jobs?query=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Crypto.jobs',
    searchUrl: (k) => `https://crypto.jobs/jobs?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Web3.career',
    searchUrl: () => `https://web3.career/`,
    useBrowser: false
  }
]

export interface ScanBoardResult {
  board: string
  found: number
  added: number
  skipped: number
  error?: string
}

export interface ScanResult {
  totalFound: number
  totalAdded: number
  totalSkipped: number
  boards: ScanBoardResult[]
  errors: string[]
}

function extractJsonLdListings(html: string, baseUrl: string): { url: string; title?: string; company?: string }[] {
  const results: { url: string; title?: string; company?: string }[] = []
  const seen = new Set<string>()
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      const items = parsed['@graph'] || (parsed['@type'] === 'ItemList' ? parsed.itemListElement : [parsed])
      for (const item of Array.isArray(items) ? items : [items]) {
        const data = item['@type'] === 'JobPosting' ? item : null
        if (!data) continue
        const jp = data
        const url = jp.url
        if (!url) continue
        const fullUrl = new URL(url, baseUrl).href
        if (seen.has(fullUrl)) continue
        seen.add(fullUrl)
        results.push({
          url: fullUrl,
          title: jp.title ? String(jp.title).trim() : undefined,
          company: jp.hiringOrganization
            ? typeof jp.hiringOrganization === 'string'
              ? jp.hiringOrganization
              : jp.hiringOrganization.name
            : undefined
        })
      }
    } catch {
      // skip malformed JSON-LD
    }
  }
  return results
}

function isNonListingPage(html: string, title: string | undefined): boolean {
  const lower = html.toLowerCase()
  const loginIndicators = [
    'sign in to see this job', 'sign in to apply', 'create an account to apply',
    'sign in with google', 'sign in with linkedin', 'sign in with email',
    'forgot your password', 'reset your password',
    'already have an account? sign in', 'dont have an account? sign up',
    'please sign in to continue'
  ]
  const matches = loginIndicators.filter(t => lower.includes(t)).length
  if (title) {
    const t = title.toLowerCase()
    if (t.includes('sign in') || t.includes('log in') || t.includes('log in') || t.includes('sign up')) return true
  }
  return matches >= 3
}

const NAV_PATHS = /^\/(privacy|terms(-of-service)?|cookie(-policy)?|legal\/?$|login|sign(in|up)|register\/?$|forgot(-password)?|logout|auth|help\/?$|contact\/?$|about\/?$|blog\/?$|faq\/?$|pricing\/?$|status\/?$|developers\/?$|security\/?$|trust\/?$|safety\/?$)/i

function extractJobUrls(html: string, baseUrl: string, boardName: string): { url: string; title?: string; company?: string }[] {
  const jsonLd = extractJsonLdListings(html, baseUrl)
  if (jsonLd.length > 0) return jsonLd

  const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]
  if (isNonListingPage(html, pageTitle)) return []

  const results: { url: string; title?: string; company?: string }[] = []
  const seen = new Set<string>()
  const base = new URL(baseUrl)
  const boardLower = boardName.toLowerCase()

  const anchorPattern = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[1].trim()
    const inner = match[2].replace(/<[^>]+>/g, '').trim()
    if (!href || href === '#' || href.startsWith('javascript:')) continue

    let fullUrl: string
    try {
      fullUrl = new URL(href, base).href
    } catch {
      continue
    }

    const lowerUrl = fullUrl.toLowerCase()
    if (seen.has(lowerUrl)) continue
    seen.add(lowerUrl)

    const knownBoardDomains = /linkedin\.com|indeed\.com|glassdoor\.com|cryptocurrencyjobs\.co|cryptojobslist\.com|cryptojobs\.com|crypto\.jobs|web3\.career/
    if (!knownBoardDomains.test(lowerUrl)) continue

    const pathname = new URL(fullUrl).pathname

    // Only filter URLs whose path is clearly navigation/non-job
    if (NAV_PATHS.test(pathname)) continue

    if (boardLower.includes('linkedin')) {
      if (!pathname.includes('/jobs/')) continue
    } else if (boardLower.includes('indeed')) {
      if (!pathname.includes('/viewjob') && !pathname.includes('/rc/')) continue
    } else if (boardLower.includes('glassdoor')) {
      if (!pathname.includes('/job/')) continue
    } else if (boardLower.includes('web3.career')) {
      if (pathname === '/' || pathname === '/index.html') continue
      const pathParts = pathname.split('/').filter(Boolean)
      if (pathParts.length < 1) continue
      if (inner.length < 3 || inner.length >= 300) continue
    } else {
      const pathMatch = /^\/(jobs?|careers?|positions?|opportunities?)/i.test(pathname) || pathname.includes('/job/')
      const hasJobKeywords = /job|career|position|opportunity|vacancy/i.test(pathname + ' ' + inner)
      if (!pathMatch && !hasJobKeywords) continue
    }

    if (inner.length > 2 && inner.length < 300) {
      results.push({ url: fullUrl, title: inner })
    }
  }

  return results
}

async function fetchPageHtml(url: string, useBrowser: boolean): Promise<string> {
  if (useBrowser) {
    try {
      return await fetchHtmlViaBrowser(url)
    } catch {
      throw new Error('Blocked by anti-bot protection (Cloudflare/Cloudfront).')
    }
  }
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    signal: AbortSignal.timeout(30000),
    redirect: 'follow'
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const html = await response.text()
  if (isChallengePage(html)) {
    try {
      return await fetchHtmlViaBrowser(url)
    } catch {
      throw new Error('HTTP ' + response.status + ' (blocked)')
    }
  }
  return html
}

const TECH_SKILLS = new Set([
  'python', 'javascript', 'typescript', 'java', 'go', 'golang', 'rust', 'c++', 'c#', 'ruby', 'swift', 'kotlin',
  'react', 'angular', 'vue', 'svelte', 'node', 'nodejs', 'express', 'django', 'flask', 'spring', 'rails',
  'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'k8s', 'terraform', 'ansible', 'jenkins', 'ci/cd',
  'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'kafka', 'rabbitmq',
  'graphql', 'rest', 'grpc', 'api', 'microservices',
  'machine learning', 'deep learning', 'ai', 'nlp', 'computer vision', 'data science',
  'blockchain', 'solidity', 'web3', 'ethereum', 'smart contract', 'defi',
  'linux', 'git', 'agile', 'scrum', 'jira', 'figma',
  'product management', 'project management', 'leadership', 'strategy',
  'finance', 'accounting', 'audit', 'compliance', 'risk management',
  'marketing', 'sales', 'business development', 'operations'
])

const ROLE_INDICATORS = [
  'engineer', 'developer', 'architect', 'manager', 'director', 'lead', 'head', 'chief',
  'scientist', 'analyst', 'specialist', 'consultant', 'coordinator', 'administrator',
  'designer', 'researcher', 'associate', 'president', 'vp', 'vice president',
  'intern', 'fellow', 'principal', 'staff', 'senior', 'junior', 'mid-level', 'entry'
]

function extractTechnicalTerms(text: string): Set<string> {
  const terms = new Set<string>()
  const lower = text.toLowerCase()

  for (const skill of TECH_SKILLS) {
    if (lower.includes(skill)) terms.add(skill)
  }

  const words = lower.split(/[^a-z0-9+#.]+/)
  for (const w of words) {
    if (w.length > 3 && !/^(the|and|for|are|but|not|you|all|can|had|her|was|one|our|out|has|have|with|this|that|from|they|been|were|will|would|could|should|their|there|which|when|what|about|into|than|then|some)$/.test(w)) {
      terms.add(w)
    }
  }

  return terms
}

function extractRoleTitles(text: string): string[] {
  const roles: string[] = []
  const lines = text.split('\n')
  for (const line of lines) {
    const lower = line.toLowerCase().trim()
    const hasIndicator = ROLE_INDICATORS.some(r => lower.includes(r))
    if (hasIndicator && lower.length < 120) {
      roles.push(lower)
    }
  }
  return roles
}

const EDUCATION_ORDER: Record<string, number> = {
  'phd': 5, 'ph.d.': 5, 'doctorate': 5, 'doctoral': 5,
  'master': 4, "master's": 4, 'masters': 4, 'ma': 4, 'ms': 4, 'mba': 4, 'm.s.': 4, 'm.a.': 4,
  'bachelor': 3, "bachelor's": 3, 'bachelors': 3, 'ba': 3, 'bs': 3, 'b.s.': 3, 'b.a.': 3,
  'associate': 2, "associate's": 2, 'associates': 2, 'a.s.': 2, 'a.a.': 2
}

function extractEducationLevel(text: string): number {
  const lower = text.toLowerCase()
  let maxLevel = 0
  for (const [keyword, level] of Object.entries(EDUCATION_ORDER)) {
    if (lower.includes(keyword) && level > maxLevel) maxLevel = level
  }
  return maxLevel
}

function extractYearsExperience(text: string): number {
  const lower = text.toLowerCase()
  let maxYears = 0
  const patterns = [
    /(\d+)\+?\s*(?:years?|yrs?)\s*(?:of\s+)?experience/g,
    /(\d+)\s*[-–to]+\s*(\d+)\s*(?:years?|yrs?)/g
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(lower)) !== null) {
      const years = Math.max(...match.slice(1).filter(Boolean).map(Number))
      if (years > maxYears) maxYears = years
    }
  }
  return maxYears
}

function checkEducationRequirement(jobDesc: string, cvEduLevel: number): { meets: boolean; reason?: string } {
  const lower = jobDesc.toLowerCase()
  let requiredLevel = 0
  let requirementText = ''
  for (const [keyword, level] of Object.entries(EDUCATION_ORDER)) {
    const re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s']?(?:degree|'?s)?\\b`, 'i')
    if (re.test(lower)) {
      const context = lower.slice(Math.max(0, lower.search(re) - 30), lower.search(re) + 40)
      if (/(?:required|must|need|necessary|preferred|minimum|should have|seeking|looking for|need|require)/i.test(context)) {
        if (level > requiredLevel) {
          requiredLevel = level
          requirementText = keyword
        }
      }
    }
  }
  if (requiredLevel > 0 && cvEduLevel < requiredLevel) {
    return { meets: false, reason: `Requires ${requirementText} degree (user edu level ${cvEduLevel} < ${requiredLevel})` }
  }
  return { meets: true }
}

function checkExperienceRequirement(jobDesc: string, cvYears: number): { meets: boolean; reason?: string } {
  const lower = jobDesc.toLowerCase()
  const minReqPats = [
    /(\d+)\+?\s*(?:years?|yrs?)\s*(?:of\s+)?(?:professional\s+)?experience/i,
    /minimum\s+of\s+(\d+)\s*(?:years?|yrs?)/i,
    /at\s+least\s+(\d+)\s*(?:years?|yrs?)/i,
    /(\d+)\s*[-–]+\s*\d+\s*(?:years?|yrs?)\s*(?:of\s+)?experience/i
  ]
  for (const pat of minReqPats) {
    const m = lower.match(pat)
    if (m) {
      const req = parseInt(m[1], 10)
      if (req > cvYears) {
        return { meets: false, reason: `Requires ${req}+ years experience (user has ${cvYears})` }
      }
    }
  }
  return { meets: true }
}

function scoreCompatibility(jobTitle: string, jobDesc: string | null, baseCv: string): number {
  if (!baseCv) return 0.5

  const cvLower = baseCv.toLowerCase()
  const descText = (jobTitle + ' ' + (jobDesc || '')).toLowerCase()

  const cvSkills = extractTechnicalTerms(cvLower)
  const jobSkills = extractTechnicalTerms(descText)

  if (cvSkills.size === 0) return 0.3

  let intersect = 0
  for (const s of jobSkills) {
    if (cvSkills.has(s)) intersect++
  }

  const skillScore = cvSkills.size > 0 ? intersect / Math.min(jobSkills.size, cvSkills.size) : 0

  const cvRoles = extractRoleTitles(cvLower)
  const jobTitleLower = jobTitle.toLowerCase()
  let roleScore = 0
  for (const role of cvRoles) {
    const roleWords = role.split(/[^a-z0-9]+/).filter(w => w.length > 2)
    const titleWords = jobTitleLower.split(/[^a-z0-9]+/).filter(w => w.length > 2)
    const matchCount = roleWords.filter(rw => titleWords.some(tw => tw === rw || tw.includes(rw) || rw.includes(tw))).length
    if (matchCount >= Math.min(2, roleWords.length / 2)) {
      roleScore = 1
      break
    }
  }

  const hasRelevantKeywords = /engineer|developer|architect|manager|analyst|scientist|designer|consultant|intern/i.test(jobTitleLower)
  const keywordBonus = hasRelevantKeywords ? 0.15 : 0

  const score = skillScore * 0.6 + roleScore * 0.3 + keywordBonus
  return Math.min(score, 1)
}

function matchesWorkType(text: string, workType: WorkType): boolean {
  if (workType === 'any') return true
  const lower = text.toLowerCase()
  const isRemote = /remote|work from home|wfh|100% remote|fully remote|remote.first|distributed team|anywhere/.test(lower)
  const isHybrid = /hybrid|flexible|mix of remote|remote.office|in.office.and.remote/.test(lower) && !isRemote
  const isInOffice = /on.?site|in.?office|in.person|office.based|at our (headquarters|office|location)/.test(lower)
  if (workType === 'remote') return isRemote
  if (workType === 'hybrid') return isHybrid
  if (workType === 'in_office') return isInOffice || (!isRemote && !isHybrid)
  return true
}

async function fetchAndScore(url: string, baseCv: string, existingUrls: Set<string>, workType: WorkType): Promise<{ action: 'added' | 'skipped' | 'incompatible' | 'error'; job?: Job; reason?: string }> {
  if (existingUrls.has(url)) return { action: 'skipped', reason: 'Already in database' }

  await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000))

  let input: { title: string; company: string; location?: string; url?: string; description?: string; salary_range?: string; source?: string; notes?: string }
  try {
    input = await scrapeJobFromUrl(url)
  } catch (err) {
    return { action: 'error', reason: `Scrape failed: ${err instanceof Error ? err.message : 'Unknown'}` }
  }

  if (!input.title || !input.company || !input.description) {
    return { action: 'error', reason: 'Missing required fields' }
  }

  if (!matchesWorkType(input.title + ' ' + input.description, workType)) {
    return { action: 'incompatible', reason: `Work type filter: ${workType}` }
  }

  const desc = input.description || ''
  const cvEduLevel = extractEducationLevel(baseCv)
  const cvYears = extractYearsExperience(baseCv)

  if (cvEduLevel > 0) {
    const eduCheck = checkEducationRequirement(desc, cvEduLevel)
    if (!eduCheck.meets) {
      return { action: 'incompatible', reason: eduCheck.reason }
    }
  }

  if (cvYears > 0) {
    const expCheck = checkExperienceRequirement(desc, cvYears)
    if (!expCheck.meets) {
      return { action: 'incompatible', reason: expCheck.reason }
    }
  }

  const score = scoreCompatibility(input.title, input.description, baseCv)
  if (score < 0.08) {
    return { action: 'incompatible', reason: `Score ${score.toFixed(2)} < 0.08` }
  }

  try {
    const job = createJob(input)
    return { action: 'added', job }
  } catch (err) {
    return { action: 'error', reason: `Create failed: ${err instanceof Error ? err.message : 'Unknown'}` }
  }
}

export async function scanAllBoards(filters?: ScanFilters, onProgress?: (msg: string) => void): Promise<ScanResult> {
  const settings = getSettings()
  const keywords = (filters?.keywords || settings.job_search_keywords || '').trim()
  const location = (filters?.location || settings.job_search_location || '').trim()
  const workType = filters?.workType || 'any'
  const baseCv = settings.base_cv || ''

  const existingJobs = listJobs()
  const existingUrls = new Set(existingJobs.map(j => j.url).filter(Boolean) as string[])
  const seenUrls = new Set<string>()

  const result: ScanResult = { totalFound: 0, totalAdded: 0, totalSkipped: 0, boards: [], errors: [] }
  const progress = onProgress || ((_: string) => {})

  for (const board of BOARDS) {
    const br: ScanBoardResult = { board: board.name, found: 0, added: 0, skipped: 0 }
    try {
      progress(`Scanning ${board.name}...`)
      const searchUrl = board.searchUrl(keywords, location)
      const html = await fetchPageHtml(searchUrl, board.useBrowser)

      progress(`Parsing listings from ${board.name}...`)
      let listings = extractJobUrls(html, searchUrl, board.name)
      br.found = listings.length

      listings = listings.filter(l => {
        if (seenUrls.has(l.url)) return false
        seenUrls.add(l.url)
        if (existingUrls.has(l.url)) {
          br.skipped++
          return false
        }
        return true
      })

      const CONCURRENCY = 3
      const batches: typeof listings[] = []
      for (let i = 0; i < listings.length; i += CONCURRENCY) {
        batches.push(listings.slice(i, i + CONCURRENCY))
      }

      for (const batch of batches) {
        const results = await Promise.allSettled(
          batch.map(async (l) => {
            progress(`Scraping ${board.name} — ${l.company || l.title || l.url}`)
            return fetchAndScore(l.url, baseCv, existingUrls, workType)
          })
        )
        for (const r of results) {
          if (r.status === 'fulfilled') {
            if (r.value.action === 'added') {
              br.added++
              result.totalAdded++
              if (r.value.job) {
                progress(`✓ Added ${r.value.job.company} — ${r.value.job.title}`)
              }
            } else if (r.value.action === 'skipped' || r.value.action === 'incompatible') {
              br.skipped++
              result.totalSkipped++
            }
          } else {
            br.skipped++
          }
        }
      }

      result.totalFound += br.found
    } catch (err) {
      br.error = err instanceof Error ? err.message : 'Unknown error'
      result.errors.push(`${board.name}: ${br.error}`)
    }
    result.boards.push(br)
  }

  return result
}
