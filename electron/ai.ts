import { getSettings, listApiModels, getDocument, updateDocument, updateDocumentVerification } from './database'
import type { ApiModelConfig, Job, TailorRequest, TailorResult, VerificationResult } from './types'
import { createDocument, getJob } from './database'

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitError'
  }
}

interface CallAIResult {
  content: string | null
  modelUsed: string | null
  rateLimited: boolean
  errors: string[]
}

/**
 * Try all configured AI models.
 * - Returns content + modelUsed on first success.
 * - If all fail and at least one returned 429, throws RateLimitError.
 * - If all fail for other reasons, throws Error with collected error messages.
 */
async function callAI(
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.7,
  timeoutMs = 20000
): Promise<CallAIResult> {
  const models: ApiModelConfig[] = listApiModels()
  if (models.length === 0) throw new Error('No AI models configured. Add one in Settings.')

  let content: string | null = null
  let modelUsed: string | null = null
  let rateLimited = false
  const errors: string[] = []

  for (const model of models) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (model.api_key) headers['Authorization'] = `Bearer ${model.api_key}`
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), timeoutMs)
      const response = await fetch(`${model.base_url}/chat/completions`, {
        method: 'POST',
        headers,
        signal: abort.signal,
        body: JSON.stringify({
          model: model.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature
        })
      })
      clearTimeout(timer)
      if (response.ok) {
        const data = (await response.json()) as { choices: { message: { content: string } }[] }
        content = data.choices[0]?.message?.content ?? null
        if (content) {
          modelUsed = model.name || model.model
          break
        }
        errors.push(`${model.name}: empty response`)
      } else if (response.status === 429) {
        rateLimited = true
        errors.push(`${model.name}: rate limited (429)`)
      } else {
        const errText = await response.text().catch(() => '')
        errors.push(`${model.name}: HTTP ${response.status}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      errors.push(`${model.name}: ${msg.includes('aborted') ? 'timeout' : msg}`)
    }
  }

  if (!content && rateLimited) {
    throw new RateLimitError(`All AI models failed (rate limited):\n${errors.join('\n')}`)
  }
  if (!content) {
    throw new Error(`All AI models failed:\n${errors.join('\n')}`)
  }

  return { content, modelUsed, rateLimited: false, errors: [] }
}

export async function tailorDocument(request: TailorRequest): Promise<TailorResult> {
  const settings = getSettings()
  const job = getJob(request.job_id)
  if (!job) throw new Error('Job not found')

  const baseContent =
    request.base_content ||
    settings.base_cv ||
    'No base CV provided. Add your base CV in Settings.'

  const systemPrompt =
    request.document_type === 'cv'
      ? `You are an expert career coach. Tailor the candidate's CV for the specific job posting using the EXACT Harvard template format below.

SECTIONS IN ORDER:
1. Contact Info — name, email, phone, address
2. Education — School name (tab) Location, Degree (tab) Dates, Relevant Coursework, Study Abroad, High School
3. Experience — Organization (tab) Location, Position Title (tab) Dates, then bullet points
4. Leadership & Activities — Organization (tab) Location, Role (tab) Dates, then bullet points
5. Skills & Interests — Technical:, Language:, Laboratory:, Interests:

FORMATTING RULES:
- Section headers on their own line, centered, bold
- Use a TAB character between bold left text (school/org/title) and right-aligned location/dates
- Each bullet point on its own line, starting with an action verb
- Write experience bullet points in the XYZ format:
  "Accomplished [X] as measured by [Y], by doing [Z]."
- Do NOT use asterisks or markdown formatting
- Keep factual accuracy — only reorganize and emphasize relevant experience
- Output plain text only`
      : `You are an expert career coach. Write a compelling, personalized cover letter for this job.
Keep it concise (3-4 paragraphs), professional, and specific to the role. Output plain text only.`

  const userPrompt = `Job Title: ${job.title}
Company: ${job.company}
Location: ${job.location ?? 'Not specified'}

Job Description:
${job.description ?? 'No description provided.'}

Candidate Name: ${settings.user_name || 'Candidate'}
Candidate Email: ${settings.user_email || ''}

Base CV / Background:
${baseContent}

${request.document_type === 'cover_letter' ? 'Write a tailored cover letter.' : 'Tailor this CV for the role.'}`

  let content: string
  let modelUsed: string | null = null
  try {
    const result = await callAI(systemPrompt, userPrompt, 0.7)
    content = result.content!
    modelUsed = result.modelUsed
  } catch (err) {
    if (err instanceof RateLimitError) throw err
    // Non-rate-limit failure: fall back to base CV / template
    content = generateFallbackDocument(job, request.document_type, baseContent, settings)
  }

  const doc = createDocument(
    request.document_type,
    `${request.document_type === 'cv' ? 'CV' : 'Cover Letter'} — ${job.company}`,
    content,
    job.id,
    false,
    modelUsed || undefined
  )

  return { content, document_id: doc.id }
}

function generateFallbackDocument(
  job: Job,
  type: 'cv' | 'cover_letter',
  baseCv: string,
  settings: { user_name: string; user_email: string }
): string {
  if (type === 'cover_letter') {
    return `Dear Hiring Manager,

I am writing to express my strong interest in the ${job.title} position at ${job.company}.

Based on my background and the requirements outlined in your posting, I believe I would be a strong fit for this role. My experience aligns well with what you're looking for, and I'm excited about the opportunity to contribute to your team.

${job.description ? `I was particularly drawn to this role because of: ${job.description.slice(0, 200)}...` : ''}

I would welcome the opportunity to discuss how my skills and experience can benefit ${job.company}. Thank you for considering my application.

Best regards,
${settings.user_name || 'Your Name'}
${settings.user_email || ''}`
  }

  return baseCv
}

export async function generateFollowUpMessage(
  company: string,
  jobTitle: string,
  daysSinceApplied: number
): Promise<string> {
  const settings = getSettings()

  if (!settings.openai_api_key) {
    return `Hi,

I wanted to follow up on my application for the ${jobTitle} position at ${company}, which I submitted ${daysSinceApplied} days ago. I remain very interested in this opportunity and would appreciate any update on the hiring process.

Thank you for your time.

Best regards,
${settings.user_name || 'Your Name'}`
  }

  const response = await fetch(`${settings.openai_base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openai_api_key}`
    },
    body: JSON.stringify({
      model: settings.openai_model,
      messages: [
        {
          role: 'system',
          content:
            'Write a brief, professional follow-up email for a job application. Plain text only, no subject line.'
        },
        {
          role: 'user',
          content: `Company: ${company}\nRole: ${jobTitle}\nDays since applied: ${daysSinceApplied}\nCandidate: ${settings.user_name}`
        }
      ],
      temperature: 0.7
    })
  })

  if (!response.ok) {
    throw new Error(`AI request failed: ${response.status}`)
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[]
  }
  return data.choices[0]?.message?.content ?? ''
}

const SECTION_HEADERS = new Set([
  'professional summary', 'summary', 'profile',
  'core competencies', 'competencies', 'skills', 'qualifications', 'technical skills',
  'professional experience', 'experience', 'work history', 'work experience',
  'education',
  'certifications', 'languages', 'interests', 'skills & interests', 'skills and interests',
  'projects', 'project experience',
  'leadership & activities', 'leadership and activities', 'activities', 'leadership',
  'publications', 'honors & awards', 'honors and awards', 'awards',
  'additional information', 'additional'
])

function isSectionHeader(line: string): string | null {
  const cleaned = line.toLowerCase().trim().replace(/[*_]/g, '')
  if (SECTION_HEADERS.has(cleaned)) return cleaned
  if (/^[a-z\s&]+$/.test(cleaned)) {
    const stripped = cleaned.replace(/[^a-z\s&]/g, '').trim()
    if (SECTION_HEADERS.has(stripped)) return stripped
  }
  return null
}

const NO_REGENERATE = new Set(['education'])
const NO_BULLET_SECTIONS = new Set(['skills & interests', 'skills and interests', 'skills', 'interests', 'certifications', 'languages', 'additional information', 'additional'])

interface Section {
  header: string
  name: string
  bodyLines: string[]
  startIdx: number
  endIdx: number
}

function parseSections(content: string): Section[] {
  const lines = content.split('\n')
  const sections: Section[] = []
  let currentHeader: string | null = null
  let currentName: string | null = null
  let currentStart = 0

  for (let i = 0; i < lines.length; i++) {
    const name = isSectionHeader(lines[i])
    if (name) {
      if (currentName !== null) {
        sections.push({
          header: lines[currentStart],
          name: currentName,
          bodyLines: lines.slice(currentStart + 1, i),
          startIdx: currentStart,
          endIdx: i
        })
      }
      currentHeader = lines[i]
      currentName = name
      currentStart = i
    }
  }

  if (currentName !== null) {
    sections.push({
      header: lines[currentStart],
      name: currentName,
      bodyLines: lines.slice(currentStart + 1),
      startIdx: currentStart,
      endIdx: lines.length
    })
  }

  return sections
}

export async function verifyDocumentContent(
  jobId: number,
  documentId: number,
  docType: 'cv' | 'cover_letter'
): Promise<VerificationResult> {
  const job = getJob(jobId)
  if (!job) throw new Error('Job not found')
  const doc = getDocument(documentId)
  if (!doc) throw new Error('Document not found')

  const systemPrompt = `You are a strict career-document reviewer. Evaluate the ${docType === 'cv' ? 'CV/resume' : 'cover letter'} against the target job posting.

Rate the document 0-100 on these criteria:
- Relevance: Does the content directly address the job requirements?
- Keywords: Are key terms from the job description present?
- Specificity: Is it tailored to this specific role (not generic)?
- Formatting: Is the structure clean and professional?
- Accuracy: Are there any hallucinations or claims not supported by the base CV?

Output ONLY a JSON object with no markdown:
{"score": <0-100>, "passed": <true if score >= 70>, "feedback": "<2-3 sentence critique listing specific issues and the most important improvement>"}`

  const userPrompt = `Job Title: ${job.title}
Company: ${job.company}

Job Description:
${job.description || 'No description provided.'}

${docType === 'cv' ? 'CV' : 'Cover Letter'} Content:
${doc.content}

Evaluate how well this document is tailored for this specific job.`

  let result: VerificationResult = { score: 0, passed: false, feedback: 'Verification failed — no AI model responded.' }

  try {
    const aiResult = await callAI(systemPrompt, userPrompt, 0.3)
    if (aiResult.content) {
      const parsed = JSON.parse(aiResult.content.replace(/```json|```/g, '').trim()) as VerificationResult
      result = {
        score: Math.max(0, Math.min(100, parsed.score)),
        passed: !!parsed.passed,
        feedback: parsed.feedback || ''
      }
    }
  } catch (err) {
    if (err instanceof RateLimitError) throw err
    // Non-rate-limit: keep default result (score 0)
  }

  updateDocumentVerification(documentId, result.score, result.feedback)
  return result
}

export async function regenerateSection(
  documentId: number,
  sectionName: string,
  jobId: number,
  extraContext?: string
): Promise<string> {
  const job = getJob(jobId)
  if (!job) throw new Error('Job not found')

  const doc = getDocument(documentId)
  if (!doc) throw new Error('Document not found')

  const sectionNameLower = sectionName.toLowerCase().trim()
  if (NO_REGENERATE.has(sectionNameLower)) {
    throw new Error(`Cannot regenerate the "${sectionName}" section.`)
  }

  const sections = parseSections(doc.content)
  const section = sections.find((s) => s.name === sectionNameLower)
  if (!section) throw new Error(`Section "${sectionName}" not found in the document.`)

  const sectionContent = section.bodyLines.join('\n').trim()
  if (!sectionContent) throw new Error(`Section "${sectionName}" is empty.`)

  const systemPrompt = `You are an expert career coach regenerating a single section of a Harvard-format CV.

The section header is "${section.header}". Preserve the exact same header — do not output it.

Formatting rules:
${NO_BULLET_SECTIONS.has(sectionNameLower)
  ? '- Each line is a label: comma-separated values (no bullets)'
  : `- Entries use TAB between organization/school name (left) and location (right)
- Role/Title on next line with TAB between title (left) and dates (right)
- Bullet points in XYZ format: "Accomplished [X] as measured by [Y], by doing [Z]."
- Each bullet starts with an action verb`
}

Rewrite the section content to better match the target job. Keep only relevant entries. Output ONLY the section body — no header line, no markdown.`

  const userPrompt = `Job Title: ${job.title}
Company: ${job.company}
Job Description:
${job.description || 'No description provided.'}

Full CV:
${doc.content}

Current "${sectionName}" section content:
${sectionContent}
${extraContext && extraContext.trim() ? `\nAdditional context from the user (follow these instructions when rewriting):\n${extraContext.trim()}\n` : ''}
Rewrite only this section's body.`

  const result = await callAI(systemPrompt, userPrompt, 0.7)
  let newBody = result.content!

  const resultLines = [...doc.content.split('\n')]
  resultLines.splice(section.startIdx + 1, section.endIdx - section.startIdx - 1, ...newBody.trim().split('\n'))
  const updatedContent = resultLines.join('\n')

  updateDocument(documentId, doc.title, updatedContent)

  return updatedContent
}