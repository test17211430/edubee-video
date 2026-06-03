import Groq from 'groq-sdk';
import { GenerationRequest, ParsedScript } from '../types';
import { parseRawScript, type FrameRow, type ScriptData } from './wordGenerator';

let groqClients: Groq[] = [];
let activeGroqClientIndex = 0;
let refineGroqClients: Groq[] = [];
let activeRefineGroqClientIndex = 0;

export type RefineField =
  | 'audioCues'
  | 'frameType'
  | 'header'
  | 'bodyText'
  | 'visualInstructions'
  | 'imagePrompts';

export interface RefineScope {
  frameIndexes?: number[];
  fields?: RefineField[];
  preserveAudioCues?: boolean;
}

const REFINE_FIELD_ORDER: RefineField[] = [
  'audioCues',
  'frameType',
  'header',
  'bodyText',
  'visualInstructions',
  'imagePrompts',
];

export function getConnectedRefineFields(fields: RefineField[] = []): RefineField[] {
  const connected = new Set(fields);
  const add = (...values: RefineField[]) => values.forEach(value => connected.add(value));

  if (connected.has('audioCues')) add('bodyText', 'visualInstructions');
  if (connected.has('header')) add('bodyText', 'visualInstructions');
  if (connected.has('bodyText')) add('visualInstructions');

  return REFINE_FIELD_ORDER.filter(field => connected.has(field));
}

function parseGroqApiKeys(apiKeys: string | string[]): string[] {
  const values = Array.isArray(apiKeys)
    ? apiKeys
    : apiKeys.split(/[\s,;]+/);
  const unique = new Set<string>();
  values
    .map(key => key.trim())
    .filter(Boolean)
    .forEach(key => unique.add(key));
  return Array.from(unique);
}

export function initializeGroq(apiKeys: string | string[], refineApiKeys: string | string[] = []): void {
  const keys = parseGroqApiKeys(apiKeys).filter(key => key.startsWith('gsk_'));
  const refineKeys = parseGroqApiKeys(refineApiKeys).filter(key => key.startsWith('gsk_'));
  groqClients = keys.map(apiKey => new Groq({ apiKey, dangerouslyAllowBrowser: true }));
  refineGroqClients = refineKeys.map(apiKey => new Groq({ apiKey, dangerouslyAllowBrowser: true }));
  activeGroqClientIndex = 0;
  activeRefineGroqClientIndex = 0;
}
export function isGroqInitialized(): boolean {
  return groqClients.length > 0;
}

export function getGroqKeyCount(): number {
  return groqClients.length;
}

export function getRefineGroqKeyCount(): number {
  return refineGroqClients.length;
}

function setActiveGroqClient(index: number): void {
  activeGroqClientIndex = index;
}

function setActiveRefineGroqClient(index: number): void {
  activeRefineGroqClientIndex = index;
}

export function extractTeacherName(raw: string): string {
  const match = raw.match(/\bmy\s+name\s+is\b/i);
  if (!match || typeof match.index !== 'number') return '';

  const afterPhrase = raw
    .slice(match.index + match[0].length, match.index + match[0].length + 120)
    .replace(/^[\s.:\-–—,;()[\]{}'"“”‘’]+/, '');
  const stopIndex = afterPhrase.search(/(?:\r?\n|[.!?;]|,|\bi\s+am\b|\byour\s+teacher\b|\btoday\b)/i);
  const candidateText = (stopIndex >= 0 ? afterPhrase.slice(0, stopIndex) : afterPhrase)
    .replace(/[.…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const nameMatch = candidateText.match(/^((?:Mr|Ms|Mrs|Dr|Prof)\.?\s+)?([A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){0,3})/);
  if (!nameMatch) return '';

  const name = `${nameMatch[1] || ''}${nameMatch[2] || ''}`
    .replace(/[.,;:]+$/g, '')
    .trim();
  const lower = name.toLowerCase();
  if (!name || /\b(your|teacher|biology|today|learners|subject|class)\b/i.test(lower)) return '';
  return name;
}

function extractDurationMinutes(duration: string): number {
  const numbers = duration.match(/\d+/g)?.map(Number).filter(Number.isFinite) || [];
  if (numbers.length === 0) return 5;
  if (duration.includes('+')) return numbers[0];
  if (numbers.length > 1) return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  return numbers[0];
}

function audioWordTarget(duration: string): { minimum: number; target: number } {
  const minutes = extractDurationMinutes(duration);
  return {
    minimum: Math.round(minutes * 110),
    target: Math.round(minutes * 125),
  };
}

function compactPromptText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (normalized.length <= maxChars) return normalized;

  const marker = '\n\n[Content shortened to stay within Groq request limits. Use the retained beginning, middle, and ending sections as source coverage.]\n\n';
  const available = Math.max(1000, maxChars - marker.length);
  const headChars = Math.floor(available * 0.55);
  const middleChars = Math.floor(available * 0.2);
  const tailChars = available - headChars - middleChars;
  const middleStart = Math.max(headChars, Math.floor(normalized.length / 2 - middleChars / 2));

  return [
    normalized.slice(0, headChars),
    marker,
    normalized.slice(middleStart, middleStart + middleChars),
    marker,
    normalized.slice(-tailChars),
  ].join('').trim();
}

function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function groqCompletionBudget(prompt: string, desired: number, minimum: number): number {
  const promptTokens = estimatePromptTokens(prompt);
  const safeRequestLimit = 14200;
  const available = Math.max(1200, safeRequestLimit - promptTokens);
  if (available < minimum) return available;
  return Math.min(desired, available);
}

function generationSourceBudget(duration: string): { sourceChars: number; sampleChars: number; completionTokens: number; minimumTokens: number } {
  const minutes = extractDurationMinutes(duration);
  if (minutes <= 3) {
    return { sourceChars: 9500, sampleChars: 3000, completionTokens: 7200, minimumTokens: 5600 };
  }
  if (minutes <= 6) {
    return { sourceChars: 10200, sampleChars: 3200, completionTokens: 8800, minimumTokens: 6800 };
  }
  if (minutes <= 12) {
    return { sourceChars: 9400, sampleChars: 2800, completionTokens: 9800, minimumTokens: 7600 };
  }
  return { sourceChars: 8200, sampleChars: 2400, completionTokens: 10500, minimumTokens: 8200 };
}

// Frame data returned by AI as JSON
interface AIFrame {
  audio: unknown;       // numbered audio cue lines; model may return string or array
  frame: string;        // Title Screen / Wide / Wide with Image / Summary
  header?: string;      // Null Screen Header text (Title Case)
  body?: unknown;       // Body Text lines (0-20 words each)
  visual?: unknown;     // Visual/Animation Instructions
}

interface AIOutput {
  curiosityQuestion: string;
  previousTopic: string;
  todayIntro: string;
  frames: AIFrame[];
  summaryAudio: unknown;
  summaryLabels: unknown;
  nextTopic: string;
  thankYou: string;
}

interface ExactAudioFrameOutput {
  screenNumber?: number | string;
  frame?: string;
  header?: string;
  body?: unknown;
  visual?: unknown;
}

interface ExactAudioOutput {
  frames?: ExactAudioFrameOutput[];
}

interface ExactAudioFrame {
  audio: string;
  frame: string;
  header: string;
  body: string[];
  visual: string[];
  pending?: boolean;
}

export async function generateScript(
  request: GenerationRequest,
  sampleScripts: ParsedScript[],
  onStream?: (chunk: string) => void
): Promise<string> {
  if (!isGroqInitialized()) throw new Error('Groq client not initialized.');
  if (request.preserveAudioCues) {
    return generateExactAudioScript(request, sampleScripts, onStream);
  }

  const sampleRaw = sampleScripts.length > 0 ? sampleScripts[0].rawText : '';
  const teacher = extractTeacherName(request.bookContent) || request.teacherName?.trim() || '[Teacher Name]';
  const preserveAudioCues = false;
  const promptBudget = generationSourceBudget(request.duration);
  const bookTrimmed = compactPromptText(request.bookContent, promptBudget.sourceChars);
  const sampleReference = compactPromptText(sampleRaw, promptBudget.sampleChars);
  const durMin = extractDurationMinutes(request.duration);
  const teachingFrames = Math.max(3, Math.round(durMin * 1.5));
  const audioTarget = audioWordTarget(request.duration);
  const audioModeRules = preserveAudioCues
    ? `- EXACT AUDIO MODE: The uploaded source content is an already-recorded teacher narration/script. Every Audio Cues line in the final script must be copied word-for-word from the source content.
- Do not paraphrase, rewrite, shorten, polish, correct grammar, add examples, add transitions, or add teacher names inside Audio Cues.
- Split the exact narration into the JSON audio fields in the same order as the source. Use contiguous source excerpts. Do not rearrange source sentences.
- Do not add greetings, previous-topic lines, today's-topic lines, summary lines, or "Thank you!" unless those exact words are present in the source content.
- Build the Frame, Header, Body Text, Visual/Animation Instructions, and Summary Labels around those exact Audio Cues.
- DURATION NOTE: The source narration controls the spoken length. Do not expand Audio Cues to satisfy the selected duration when exact audio mode is enabled.`
    : `- DURATION LOCK: The final Audio Cues must actually fit a ${request.duration} video, not a shorter 2-3 minute script. Across curiosityQuestion, todayIntro, all frame.audio items, and summaryAudio, write at least ${audioTarget.minimum} spoken words and target about ${audioTarget.target} spoken words.
- For a ${request.duration} script, do not finish with short Audio Cues. Expand explanations, examples, transitions, and teacher narration until the Audio Cues meet the duration lock.
- AUDIO CUES LENGTH: Each frame.audio point MUST be 45-75 words (3-5 full sentences). Write like a real teacher speaking — define the idea, explain why it matters, give an example or analogy, and connect it to the source content. Do not write short 5-15 word audio points.
- AUDIO DETAIL RULE: Each teaching frame should usually have 1-2 numbered audio cues, and the total narration for a teaching frame should usually be 80-140 words when the source content supports it.`;

  const prompt = `You generate educational video content. Return ONLY valid JSON, nothing else.

Generate content for a ${request.duration} PicEd educational video.

Topic: ${request.topic}
Subject: ${request.subject}
Chapter: ${request.chapter || 'N/A'}
Teacher: ${teacher}
Audience: ${request.targetAudience}
Objective: ${request.learningObjective || 'Understand ' + request.topic}

${preserveAudioCues ? 'EXACT RECORDED AUDIO SCRIPT TO PRESERVE WORD-FOR-WORD:' : 'SOURCE CONTENT TO COVER FULLY:'}
${bookTrimmed}

PICED SAMPLE SCRIPT REFERENCE (learn structure, frame rhythm, body-text style, and summary style from this sample; do not copy its topic content unless it is relevant to the requested topic):
${sampleReference || 'No sample text available.'}

Return this exact JSON structure:
{
  "curiosityQuestion": "${preserveAudioCues ? 'Exact opening narration excerpt from the source, copied word-for-word, or empty if none' : 'An engaging 2-3 sentence question to hook students, like: Have you ever wondered how...? What do you think...?'}",
  "previousTopic": "${preserveAudioCues ? 'Exact previous/review narration excerpt from the source, copied word-for-word, or empty if none' : 'Name of a related topic students learned before this one'}",
  "todayIntro": "${preserveAudioCues ? 'Exact today-introduction narration excerpt from the source, copied word-for-word, or empty if none' : "One sentence: In today's session, we are going to learn about..."}",
  "frames": [
    {
      "audio": ["${preserveAudioCues ? 'Exact word-for-word narration excerpt from the source for this frame' : 'Detailed teacher narration for one concept in 3-5 full conversational sentences, with definition, example, cause/effect, and source-content link.'}", "${preserveAudioCues ? 'Optional next exact source excerpt for this same frame' : 'Optional second detailed narration point when the frame needs another concept.'}"],
      "frame": "Wide with Image",
      "header": "Sub-topic Name in Title Case",
      "body": ["10-18 word on-screen sentence covering one spoken idea clearly", "Another 10-18 word point with a useful fact, example, step, or outcome", "Third detailed point when the audio explains another important idea"],
      "visual": ["Detailed editor instruction: show OST plus image/animation and describe exactly what changes on screen", "Optional next visual instruction"]
    }
  ],
  "summaryAudio": ["${preserveAudioCues ? 'Exact summary or closing narration excerpt from the source, copied word-for-word, or empty if none' : 'Today we learned that...'}", "${preserveAudioCues ? 'Optional next exact closing excerpt from the source' : 'We also discovered...'}", "${preserveAudioCues ? 'Optional final exact closing excerpt from the source' : 'Remember that...'}"],
  "summaryLabels": ["Key term 1", "Key term 2"],
  "nextTopic": "Name of the next related topic",
  "thankYou": "${preserveAudioCues ? 'Exact closing words from the source if present, otherwise empty string' : 'Thank you!'}"
}

IMPORTANT:
- Generate exactly ${teachingFrames} objects in the "frames" array to fill ${request.duration}.
${audioModeRules}
- BODY TEXT COVERAGE RULE: frame.body must cover the important facts explained in frame.audio. Use 4-6 useful body items when the audio contains multiple concepts, steps, materials, definitions, examples, formulas, equations, or outcomes. Each body item should usually be 10-18 words and must stay under 20 words unless it is a formula or equation.
- BODY TEXT COMPLETENESS RULE: For every teaching frame, create a complete Body Text section, not only a topic label. If the audio explains definition, properties, examples, causes, observations, results, or uses, include those ideas as separate learner-facing points.
- BODY TEXT FINAL-PASS RULE: Before returning JSON, check each frame.body. If any teaching frame has fewer than 3 body items, average body item length below 8 words, or only labels, rewrite that body section with richer 10-18 word points grounded in frame.audio.
- BODY TEXT DETAIL RULE: Do not use tiny labels as Body Text when the audio has richer information. Avoid 1-5 word body labels unless they are formulas/equations; convert the key audio ideas into complete, useful on-screen points. If a short term is needed, pair it with a short explanatory point.
- BODY TEXT ALIGNMENT RULE: Body Text must be derived from the same frame.audio only. Do not add facts, benefits, examples, causes, organisms, places, or outcomes that are not spoken in that frame's Audio Cues.
- BODY TEXT NO-COPY RULE: Do not paste a whole Audio Cue sentence into Body Text. Convert the narration into concise 0-20 word on-screen points, labels, formulas, or equations that match the audio.
- BODY TEXT FORMAT RULE: JSON body items must contain only learner-facing text. Never include PicEd labels, frame names, "Wide with Image", "Null Screen Header", "Body Text", or visual instruction text inside a body item.
${preserveAudioCues ? '- EXACT AUDIO BODY RULE: Because Audio Cues are locked to recorded narration, Body Text and Visual/Animation Instructions must be built only from those exact locked words and direct labels from them. Do not enrich Body Text with outside facts.' : ''}
- VISUAL RULE: frame.visual must follow the first-generated script style: concise editor actions such as "Show a diagram of the key concept", "Illustrate the main process", "Highlight the important label", or "Display the needed items." Do not switch refine output into vague OST/image-number wording. When a slide has Body Text, create at least one Visual/Animation Instruction for each Body Text point.
- NO IMAGE SECTION RULE: Do not generate Image Suggestions, Image N, image URLs, SEARCH:, PROMPT:, URL:, or AI Image Prompt text in the script JSON or script output. Visual/Animation Instructions may describe what should be shown, but the final script must not contain image-link or image-generation-prompt sections.
- SCRIPT DETAIL PRIORITY: Since image links and image-generation prompts are not included in the generated script, use that saved space for richer Audio Cues, Body Text, and Visual/Animation Instructions.
- Cover ALL important source content thoroughly with explanations. Do not stop after the first few concepts.
- AGE-GROUP RULE: Use the Audience value above exactly and adapt wording, examples, and visual style to that age group. If the source content contains a grade/age clue, respect it over the sample script's audience.
- DETAIL RULE: The script should be educationally complete, not only formatted. Audio Cues, Body Text, and Visual/Animation Instructions must all be detailed enough for an editor and teacher to use directly.
- Use the PicEd sample reference to match structure: Video Details, Notes, frame types, Body Text, Visual/Animation Instructions, and summary style.
- TEACHER NAME RULE: Use only "${teacher}" as the teacher name. Do not copy any teacher name from the PicEd sample reference.
- FORMAT LOCK: Keep the PicEd wording, labels, tabular structure, editor-note wording, font names, font sizes, colours, bullet style, and frame-type names exactly as in the provided sample. Do not rename sections or invent new section labels.
${preserveAudioCues ? '- EXACT OPENING RULE: curiosityQuestion may be short, long, or empty depending only on the exact source narration. Do not create a new hook.' : '- The curiosityQuestion must also be 2-3 full sentences (30-50 words).'}
${preserveAudioCues ? '- ENDING RULE: End inside the Summary frame like the sample script, but do not add "Thank you!" unless those exact words are in the source narration.' : '- ENDING RULE: End inside the Summary frame like the sample script. The final summary audio cue should be "Thank you!" Do not create a separate thank-you or outro teaching frame.'}

Return ONLY the JSON. No markdown, no backticks, no commentary.`;
  const maxCompletionTokens = groqCompletionBudget(
    prompt,
    promptBudget.completionTokens,
    promptBudget.minimumTokens
  );

  let rawResponse = '';

  try {
    if (onStream) onStream('Generating script content...');
    rawResponse = await requestGroqText(
      prompt,
      maxCompletionTokens,
      0.4,
      'Groq request is too large for this source content. Please use shorter source content or split it into smaller parts.'
    );
    if (onStream) onStream('Formatting generated script...');

    // Parse JSON from response
    const jsonStr = rawResponse.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const ai: AIOutput = JSON.parse(jsonStr);

    // Assemble into the EXACT PicEd format
    const script = await finalizeScript(assembleScript(ai, {
      subject: request.subject,
      chapter: request.chapter || '',
      topic: request.topic,
      videoTitle: request.topic,
      teacher,
      learningObjective: request.learningObjective || 'Understand ' + request.topic,
      audience: request.targetAudience,
      preserveAudioCues,
    }), { enrichImages: false });

    if (onStream) onStream(script);
    return script;
  } catch (error) {
    console.error('Generation error:', error);
    // If JSON parse fails, return raw response
    if (rawResponse) return finalizeScript(rawResponse, { enrichImages: false });
    throw error;
  }
}

function isExactAudioScreenDivider(line: string): boolean {
  const compact = line.trim().replace(/\s+/g, '');
  if (!compact) return false;
  return /^[-_=—–─━]{4,}$/.test(compact);
}

function exactAudioLineIsSourceHeading(line: string, request: GenerationRequest): boolean {
  const clean = line.replace(/\s+/g, ' ').replace(/[|:]+$/g, '').trim();
  if (!clean || wordCount(clean) > 10 || /[.?!]$/.test(clean)) return false;
  const comparable = normalizeComparable(clean);
  const candidates = [
    request.topic,
    request.chapter || '',
    request.subject,
    `Topic ${request.topic}`,
    `Chapter ${request.chapter || ''}`,
  ]
    .map(value => normalizeComparable(value))
    .filter(Boolean);
  return candidates.some(candidate => comparable === candidate || comparable === `topic ${candidate}`);
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripExactAudioSourceHeadingPrefix(line: string, request: GenerationRequest): string {
  const clean = line.replace(/\s+/g, ' ').trim();
  const headings = [request.topic, request.chapter || '', `Topic ${request.topic}`, `Chapter ${request.chapter || ''}`]
    .map(value => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const heading of headings) {
    const pattern = new RegExp(`^${escapeRegExpLiteral(heading)}\\s+(?=(?:why|what|how|when|where|in\\b|hello\\b|soil\\b|the\\b|today\\b|now\\b|we\\b))`, 'i');
    const stripped = clean.replace(pattern, '').trim();
    if (stripped && stripped !== clean) return stripped;
  }

  return clean;
}

function exactAudioLinesFromSource(source: string, request: GenerationRequest): string[] {
  const lines = source.replace(/\r/g, '').split('\n');
  const hasScreenDividers = lines.some(isExactAudioScreenDivider);
  const cleanBlock = (block: string) => block
    .replace(/\t+/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*[-–—]\s*\d{1,2}:\d{2}(?::\d{2})?\s*[-–—]\s*cut\s+the\s+clip\b/gi, '')
    .replace(/\bcut\s+the\s+clip\b/gi, '')
    .split('\n')
    .map(line => line.trim())
    .map(line => stripExactAudioSourceHeadingPrefix(line, request))
    .filter(line => !/^(Frame-by-Frame Script|Audio Cues|Frame|Visualization Comments\s*\/\s*Text on Screen)$/i.test(line))
    .filter(line => !/^\d{1,2}:\d{2}(?::\d{2})?\s*[-–—]\s*\d{1,2}:\d{2}(?::\d{2})?$/i.test(line))
    .filter(line => !exactAudioLineIsSourceHeading(line, request))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (hasScreenDividers) {
    const screens: string[] = [];
    let current: string[] = [];

    const flush = () => {
      const screen = cleanBlock(current.join('\n'));
      if (screen) screens.push(screen);
      current = [];
    };

    for (const line of lines) {
      if (isExactAudioScreenDivider(line)) {
        flush();
      } else {
        current.push(line);
      }
    }
    flush();

    return screens;
  }

  return lines
    .map(cleanBlock)
    .filter(Boolean)
    .filter(line => !exactAudioLineIsSourceHeading(line, request));
}

function exactAudioBatches(lines: string[], maxChars = 2600, maxLines = 3): Array<Array<{ screenNumber: number; audio: string }>> {
  const batches: Array<Array<{ screenNumber: number; audio: string }>> = [];
  let current: Array<{ screenNumber: number; audio: string }> = [];
  let currentChars = 0;

  lines.forEach((audio, index) => {
    const item = { screenNumber: index + 1, audio };
    const itemChars = audio.length + 160;
    if (current.length > 0 && (current.length >= maxLines || currentChars + itemChars > maxChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += itemChars;
  });

  if (current.length > 0) batches.push(current);
  return batches;
}

function exactAudioSingleScreenBatches(lines: string[]): Array<Array<{ screenNumber: number; audio: string }>> {
  return lines.map((audio, index) => [{ screenNumber: index + 1, audio }]);
}

function normalizeExactFrameType(value?: string): string {
  const frame = (value || '').trim().toLowerCase();
  if (frame === 'title screen') return 'Title Screen';
  if (frame === 'summary') return 'Summary';
  if (frame === 'null') return 'Null';
  if (frame === 'wide') return 'Wide';
  if (frame === 'intro screen') return 'Intro Screen';
  if (frame === 'outro screen') return 'Outro Screen';
  return 'Wide with Image';
}

function exactAudioLooksTitleOnly(audio: string, fallbackTopic: string): boolean {
  const clean = audio.replace(/\s+/g, ' ').trim();
  if (!clean || wordCount(clean) > 12 || /[.?!]$/.test(clean)) return false;
  const comparable = normalizeComparable(clean);
  return comparable === normalizeComparable(fallbackTopic) ||
    (!/\b(is|are|has|have|do|does|can|will|grow|learn|focus|support|contain|contains)\b/i.test(clean) && wordCount(clean) <= 8);
}

function exactAudioLooksTeacherOnly(audio: string): boolean {
  return /\b(hello learners|my name is|your teacher|thank you)\b/i.test(audio) && wordCount(audio) < 35;
}

function exactAudioShouldSkipBody(audio: string): boolean {
  const clean = audio.replace(/\s+/g, ' ').trim();
  if (!clean) return true;
  const words = wordCount(clean);
  const sentenceCount = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.length || 1;
  if (/\b(hello learners|my name is|your teacher|thank you)\b/i.test(clean) && words < 80) return true;
  if (/^(in this session|in today'?s lesson|today'?s lesson|today we are going|today,?\s+we are going|now we are going|we are going|we will|let us|let's)\b/i.test(clean) && words <= 28) return true;
  if (/^(why|what|how|when|where)\b/i.test(clean) && clean.includes('?') && words <= 28) return true;
  if (words <= 8 && sentenceCount <= 1 && !/\b(is|are|has|have|include|includes|contain|contains|require|requires|retain|retains|support|supports|grow|grows)\b/i.test(clean)) return true;
  return false;
}

function exactHeaderFromAudio(audio: string, fallbackTopic: string): string {
  const compact = audio.replace(/\s+/g, ' ').trim();
  if (/\b(?:sand|sandy) soil\b/i.test(compact) && /\bclay soil\b/i.test(compact)) {
    return 'Sandy and Clay Soil Properties';
  }
  if (/\bclay soil\b/i.test(compact) && /\bloam soil\b/i.test(compact)) {
    return 'Clay and Loam Soil Properties';
  }
  if (/\bloam soil\b/i.test(compact) || /\bmedium or average sized particles\b|\bsoft and crumbly\b|\bbest soil for agriculture\b/i.test(compact)) {
    return 'Loam Soil Properties';
  }
  if (/\b(?:sand|sandy) soil\b/i.test(compact) && /\b(aeration|fertility|capillarity|nutrient|groundnuts|cassava)\b/i.test(compact)) {
    return 'Sandy Soil Properties';
  }
  if (/\bclay soil\b/i.test(compact) && /\b(texture|particle|smooth|sticky|water retention|aeration|fertility)\b/i.test(compact)) {
    return 'Clay Soil Properties';
  }

  const leadingQuestion = audio.match(/^\s*((?:why|how|when|where)\b[^?]{3,90}\?)/i);
  if (leadingQuestion) {
    return sentenceCase(leadingQuestion[1]).replace(/\s+/g, ' ').trim();
  }

  const whatIsMatch = audio.match(/^\s*(what\s+is\s+[^?]{2,60}\?)/i);
  if (whatIsMatch) {
    return sentenceCase(whatIsMatch[1]).replace(/\s+/g, ' ').trim();
  }

  const questionMatch = audio.match(/\bwhat\s+are\s+(.+?)\?/i);
  if (questionMatch) {
    return sentenceCase(stripLeadingArticle(questionMatch[1])).replace(/[.!?]+$/g, '').trim();
  }

  const focusMatch = audio.match(/\b(?:in this session|today|now|let us|let's)[^.?!]{0,80}\b(?:focus on|learn about|look at|discuss)\s+(.+?)(?:[.?!]|$)/i);
  if (focusMatch) {
    return sentenceCase(stripLeadingArticle(focusMatch[1])).replace(/[.!?]+$/g, '').trim();
  }

  const bodyPoints = conciseBodyPointsFromAudio([audio]);
  const source = bodyPoints[0] || cleanLockedAudioBodyCandidate(audio) || fallbackTopic;
  const words = source.split(/\s+/).filter(Boolean).slice(0, 6);
  const header = words.join(' ').replace(/[.!?]+$/g, '').trim();
  return header || fallbackTopic;
}

function visualInstructionGroundedInAudio(instruction: string, audio: string): boolean {
  if (/\b(?:simple|clean)?\s*(?:image|diagram|visual)\b/i.test(instruction) && wordCount(instruction) <= 5) {
    return false;
  }
  const genericOnly = meaningfulTokens(instruction).length <= 2;
  if (genericOnly) return exactAudioLooksTeacherOnly(audio) && /\b(teacher|speaker)\b/i.test(instruction);
  return bodyPointGroundedInAudio(instruction, audio);
}

function sentenceSummaryPoint(sentence: string, audioText: string): string {
  const clean = cleanLockedAudioBodyCandidate(sentence);
  if (!clean || isNarrationOnlyBodyCandidate(clean)) return '';

  const compact = clean.replace(/\s+/g, ' ');
  const fullAudio = audioText.replace(/\s+/g, ' ');
  const choose = (condition: boolean, point: string) => condition ? point : '';

  return (
    choose(/\bsoil\b.*natural.*(?:earth'?s?\s+crust|earth'?s?\s+surface|surface)/i.test(compact),
      "Soil is a natural material covering the earth's crust or surface") ||
    choose(/\bmixture\b.*minerals?.*organic matter/i.test(compact),
      'Soil is made from minerals and organic matter') ||
    choose(/45\s*%.*minerals?.*50\s*%.*voids?.*5\s*%.*organic/i.test(compact),
      'Soil contains 45% minerals, 50% voids, and 5% organic matter') ||
    choose(/organic matter.*(?:living|decayed).*plant.*animal.*(?:remains|remain)/i.test(compact),
      'Organic matter includes living and decayed plant and animal remains that form humus') ||
    choose(/\bfunctions? of soil\b/i.test(compact) && /anchor|anchoring|roots?/i.test(fullAudio),
      'Soil supports plants by holding and anchoring their roots firmly') ||
    choose(/holds? and anchors?.*roots?|anchors?.*plant roots?/i.test(compact),
      'Soil holds and anchors plant roots so plants grow firmly') ||
    choose(/stores? and supplies?.*(water|air|nutrients)/i.test(compact),
      'Soil stores and supplies water, air, and nutrients to plants') ||
    choose(/\bhabitat\b/i.test(compact) && /\b(earthworms?|bacteria|fungi|organisms?)\b/i.test(compact),
      'Soil provides habitat for organisms such as earthworms, bacteria, and fungi') ||
    choose(/\brecycling\b|\bdead plant and animal remains\b/i.test(compact),
      'Dead plant and animal remains decay and recycle nutrients into soil') ||
    choose(/\bhuman activities\b/i.test(compact) && /\bconstruction|pottery\b/i.test(compact),
      'Soil supports human activities such as construction and pottery') ||
    choose(/\bsandy soil\b/i.test(fullAudio) && /construction/i.test(compact),
      'Sandy soil is useful in construction and consists of weathered particles') ||
    choose(/\bsandy soil\b|characteristics of sand soil|particle size/i.test(compact) && /large|coarse|gritty/i.test(compact),
      'Sandy soil has large coarse particles with a gritty texture') ||
    choose(/loose and light|does not stick together/i.test(compact),
      'Sandy soil feels loose and light but does not stick together') ||
    choose(/drains?.*quickly|low water retention|holds very little water/i.test(compact),
      'Sandy soil drains quickly and retains very little water') ||
    choose(/large air spaces|well aerated/i.test(compact),
      'Large air spaces make sandy soil well aerated') ||
    choose(/low nutrient|less fertile|washed away|leached/i.test(compact),
      'Sandy soil has low nutrients because they wash to deeper layers') ||
    choose(/capillarity|rise through/i.test(compact) && /low|doesn'?t have water|dry/i.test(compact),
      'Sandy soil has low capillarity and remains mostly dry') ||
    choose(/groundnuts|cassava|little water/i.test(compact),
      'Sandy soil suits crops like groundnuts and cassava that need little water') ||
    choose(/clay soil.*fine|fine particle size|less than 0\.002/i.test(compact),
      'Clay soil has very fine particles smaller than 0.002 millimetres') ||
    choose(/smooth and sticky/i.test(compact),
      'Clay soil feels smooth and sticky when wet') ||
    choose(/medium or average sized particles|particles are balanced/i.test(compact),
      'Particle size is medium, average, and balanced') ||
    choose(/soft and crumbly|slightly smooth|not sticky/i.test(compact),
      'Texture is soft, crumbly, slightly smooth, and not sticky') ||
    choose(/average or moderate water retention|drains excess water/i.test(compact),
      'Moderate water retention drains excess water and supports growth') ||
    choose(/average-sized particles.*average air spaces|proper oxygen supply/i.test(compact),
      'Average air spaces supply oxygen to plant roots') ||
    choose(/very fertile|humus|good nutrient retention/i.test(compact),
      'Humus makes the soil fertile and helps retain nutrients') ||
    choose(/easy to cultivate|suitable for most crops|best soil for agriculture/i.test(compact),
      'Easy workability makes it suitable for most crops') ||
    (rephraseLockedAudioBodyPoint(clean, audioText) || safeCompleteBodyPoint(clean))
  );
}

function sameAudioSummaryBodyPoints(audio: string, proposed?: unknown): string[] {
  const audioText = cleanList([audio]).join(' ');
  if (exactAudioShouldSkipBody(audioText)) return [];

  const points: string[] = [];
  const used = new Set<string>();
  const add = (condition: boolean, point: string) => {
    if (!condition) return;
    const clean = cleanBodyClause(point);
    const key = bodyPointKey(clean);
    if (!key || used.has(key) || wordCount(clean) > 20 || isWeakSummaryBodyPoint(clean, audioText)) return;
    if (!bodyPointStrictlyMatchesAudio(clean, audioText)) return;
    if (points.some(existing => bodyPointsSimilar(existing, clean))) return;
    points.push(sentenceCase(clean));
    used.add(key);
  };

  const compact = audioText.replace(/\s+/g, ' ');
  const orderedSentencePoints = audioText
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentenceSummaryPoint(sentence, audioText))
    .map(point => cleanBodyClause(point))
    .filter(point => wordCount(point) >= 7 && wordCount(point) <= 20)
    .filter(point => bodyPointStrictlyMatchesAudio(point, audioText));
  orderedSentencePoints.forEach(point => add(true, point));

  normalizeBodyPoints(proposed)
    .map(point => cleanBodyClause(point))
    .filter(point => wordCount(point) >= 7 && wordCount(point) <= 20)
    .forEach(point => add(bodyPointStrictlyMatchesAudio(point, audioText), point));

  if (points.length < 3) {
    seededLockedAudioBodyPoints(compact)
      .filter(point => bodyPointStrictlyMatchesAudio(point, audioText))
      .forEach(point => add(true, point));
  }

  return points.slice(0, targetSummaryPointCount(audioText));
}

function visualLabelFromBodyPoint(point: string): string {
  const clean = sentenceCase(cleanBodyClause(point)).replace(/[.!?]+$/g, '').trim();
  if (!clean) return '';
  const beforeReason = clean.split(/\b(?:because|so|therefore|when|with|and)\b/i)[0]?.trim() || clean;
  const words = beforeReason.split(/\s+/).filter(Boolean);
  const label = words.length > 7 ? words.slice(0, 7).join(' ') : beforeReason;
  return label.replace(/[,:;]+$/g, '').trim();
}

function visualSubjectFromBodyPoint(point: string): string {
  const clean = sentenceCase(cleanBodyClause(point)).replace(/[.!?]+$/g, '').trim();
  const lower = clean.toLowerCase();
  const concept = visualLabelFromBodyPoint(point);

  if (/\b(root|roots|anchor|anchoring|firmly)\b/.test(lower)) return 'plant roots gripping soil particles';
  if (/\b(water|air|nutrient|nutrients|absorb|absorption|osmosis|diffusion|transport)\b/.test(lower)) {
    return 'roots absorbing water, air, and nutrients from soil';
  }
  if (/\b(earthworm|earthworms|bacteria|fungi|organism|organisms|habitat)\b/.test(lower)) {
    return 'earthworms, bacteria, and fungi living inside soil';
  }
  if (/\b(decay|decompose|decomposition|dead|remain|remains|humus|recycle|recycling)\b/.test(lower)) {
    return 'dead remains decomposing into humus and nutrients';
  }
  if (/\b(construction|pottery|human activit|uses|use)\b/.test(lower)) {
    return 'soil uses such as construction and pottery';
  }
  if (/\b(sandy|sand)\b/.test(lower)) return 'large sandy soil particles with wide air spaces';
  if (/\b(clay)\b/.test(lower)) return 'fine clay particles holding water closely';
  if (/\b(loam)\b/.test(lower)) return 'balanced loam mixture of sand, silt, and clay';
  if (/\b(formula|equation|=|→|\+)\b/.test(lower)) return 'the equation components arranged left to right';
  if (/\b(compare|comparison|different|difference|versus)\b/.test(lower)) return `a side-by-side comparison for ${concept}`;

  return concept ? `a labelled visual of ${concept.toLowerCase()}` : 'a labelled visual of the narrated concept';
}

function visualInstructionForBodyPoint(point: string, index: number): string {
  const concept = visualLabelFromBodyPoint(point);
  const subject = visualSubjectFromBodyPoint(point);
  if (!concept) return '';
  if (/[=→+]/.test(point)) {
    return `Display the equation on screen and highlight ${concept}.`;
  }
  if (index === 0) return `Show a diagram of ${subject} and highlight ${concept}.`;
  if (index % 5 === 1) return `Illustrate ${subject}, with ${concept} labelled clearly.`;
  if (index % 5 === 2) return `Highlight ${concept} on the same visual as the narration explains it.`;
  if (index % 5 === 3) return `Display ${subject} and animate the change related to ${concept}.`;
  return `Show a simple visual of ${subject}, then call out ${concept}.`;
}

function isSampleStyleVisualInstruction(instruction: string): boolean {
  return /^(Show|Illustrate|Highlight|Display|Depict|Visualize|Animate|Label|Add|Emphasize|Bring teacher|Below the above image)/i.test(instruction.trim());
}

function hasEditorUsefulVisualDetail(instruction: string): boolean {
  const clean = instruction.trim();
  if (/^Bring teacher|^Show teacher speaking/i.test(clean)) return true;
  if (/^Show\s+(?:OST|header)\s+and\s+image\b/i.test(clean)) return false;
  const hasEditorAction = /\b(show|illustrate|highlight|display|depict|visualize|animate|label|callout|emphasize)\b/i.test(clean);
  const hasConcreteSubject = /\b(diagram|picture|image|visual|formula|chart|graph|materials?|setup|soil|roots?|water|oxygen|carbon dioxide|nitrogen|sample|mixture|bubbles?|experiment|seed|nutrients?|organisms?)\b/i.test(clean);
  return hasEditorAction && hasConcreteSubject && wordCount(clean) >= 5;
}

function normalizeSampleStyleVisualInstruction(instruction: string, bodyPoint: string | undefined, index: number): string {
  const clean = stripFormattingLeak(instruction)
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  if (!bodyPoint) return clean;
  if (isSampleStyleVisualInstruction(clean) && hasEditorUsefulVisualDetail(clean)) return clean;
  return visualInstructionForBodyPoint(bodyPoint, index);
}

function completeVisualInstructionsForBody(existing: string[], _audio: string, body: string[]): string[] {
  const output: string[] = [];
  const used = new Set<string>();
  const add = (instruction: string, bodyIndex: number) => {
    const clean = normalizeSampleStyleVisualInstruction(instruction, body[bodyIndex], bodyIndex);
    const key = normalizeComparable(clean);
    if (!clean || used.has(key)) return;
    output.push(clean);
    used.add(key);
  };

  existing.forEach((instruction, index) => add(instruction, index));
  if (body.length === 0) return output;

  for (let index = output.length; index < body.length; index += 1) {
    add(visualInstructionForBodyPoint(body[index], index), index);
  }

  return output;
}

function deterministicExactVisual(audio: string, body: string[]): string[] {
  if (exactAudioLooksTeacherOnly(audio)) return ['Show teacher speaking on screen.'];
  const concept = body[0] || exactHeaderFromAudio(audio, 'Key concept');
  const visuals = body.length > 0 ? [] : [`Show a simple diagram of ${concept.toLowerCase()} and highlight the key idea.`];
  return completeVisualInstructionsForBody(visuals, audio, body);
}

function sanitizeExactAudioFrame(
  output: ExactAudioFrameOutput | undefined,
  audio: string,
  request: GenerationRequest
): ExactAudioFrame {
  const proposedFrame = normalizeExactFrameType(output?.frame || (exactAudioLooksTeacherOnly(audio) ? 'Wide' : 'Wide with Image'));
  const frame = proposedFrame === 'Title Screen' && !exactAudioLooksTitleOnly(audio, request.topic)
    ? (exactAudioLooksTeacherOnly(audio) ? 'Wide' : 'Wide with Image')
    : proposedFrame;
  const header = exactHeaderFromAudio(audio, request.topic) ||
    String(output?.header || request.topic).replace(/\s+/g, ' ').trim();
  const body = sameAudioSummaryBodyPoints(audio, output?.body);
  const proposedVisual = cleanList(output?.visual)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(line => visualInstructionGroundedInAudio(line, audio));
  const visual = completeVisualInstructionsForBody(
    proposedVisual.length > 0 ? proposedVisual : deterministicExactVisual(audio, body),
    audio,
    body
  );

  return {
    audio,
    frame,
    header,
    body,
    visual,
  };
}

function buildExactAudioBatchPrompt(
  batch: Array<{ screenNumber: number; audio: string }>,
  request: GenerationRequest,
  sampleReference: string,
  totalScreens: number,
  allAudioLines: string[]
): string {
  const contextSnippet = (text: string) => {
    if (!text) return 'none';
    return compactPromptText(text.replace(/\s+/g, ' '), 260);
  };
  const batchText = batch.map(item => `SCREEN ${item.screenNumber} EXACT AUDIO CUE:
${item.audio}`).join('\n\n---\n\n');
  const context = batch.map(item => {
    const previous = contextSnippet(allAudioLines[item.screenNumber - 2] || '');
    const next = contextSnippet(allAudioLines[item.screenNumber] || '');
    return `Screen ${item.screenNumber}: previous audio = ${previous}; next audio = ${next}`;
  }).join('\n');

  return `You are building PicEd script screen fields around locked recorded narration.
Return ONLY valid JSON. Do not return markdown or explanations.

Topic: ${request.topic}
Subject: ${request.subject}
Chapter: ${request.chapter || 'N/A'}
Audience: ${request.targetAudience}
Total screens: ${totalScreens}
PicEd format: Audio Cues | Frame | Visualization Comments / Text on Screen.
${sampleReference ? `Sample style notes:\n${sampleReference}` : ''}

CRITICAL LOCK:
- Each provided section is already one screen's Audio Cue. Sections may contain multiple lines or numbered points.
- Do not rewrite, shorten, expand, correct, paraphrase, split, merge, renumber, or add to any Audio Cue.
- You are NOT writing Audio Cues. Only create Frame, Header, Body Text, and Visual/Animation Instructions for each listed screen.
- Body Text and Visual/Animation Instructions must be based only on that same screen's exact Audio Cue.
- Do not add outside facts, benefits, organisms, examples, places, causes, outcomes, or claims that are not spoken in the exact Audio Cue.
- Never use previous-screen or next-screen neighbor context as Body Text for the current screen.
- Body Text must be a rephrased point-wise summary of the same Audio Cue: key definitions, functions, examples, comparisons, steps, or results from that row only.
- Body Text order must follow the Audio Cue order. The first key idea spoken should appear before later examples, properties, or outcomes.
- Do not paste whole Audio Cue sentences into Body Text. Rephrase and compress each idea into learner-facing points.
- Each Body Text item must be 0-20 words. For rich teaching audio, create 4-6 useful PPT-style body items. For short content audio, create 2-4 useful items. Use 0 items only for teacher-only, greeting-only, title-only, or transition-only lines.
- Body Text must be detailed, rephrased from the narration, and classroom-ready. Do not return tiny labels like "Three types of soil" when the audio contains more detail.
- For each rich teaching audio cue, Body Text should cover the definition plus the key function, comparison, result, or example mentioned in that same audio cue.
- Before returning JSON, check every body array. If a teaching screen has fewer than 3 body items or mostly 1-5 word labels, rewrite it with 3-6 grounded points.
- Never place frame names or section labels such as "Wide with Image", "Null Screen Header", or "Body Text" inside body items.
- Visual instructions must directly show, label, or animate only what the exact Audio Cue says. Avoid generic instructions like "Simple image" when the audio contains visualizable details.
- Visual/Animation Instructions must keep the first-generated script style: concise editor actions like "Show a diagram of...", "Illustrate...", "Highlight...", "Display...", or "Animate...". Do not switch refine or exact-audio output into vague "Show OST and image 2" wording.
- Choose the most appropriate PicEd frame type: Title Screen, Wide, Wide with Image, Null, or Summary.
- Return one JSON frame object for every listed screen number.

NEIGHBOR CONTEXT ONLY (do not copy this as content):
${context}

Return JSON: {"frames":[{"screenNumber":1,"frame":"Wide with Image","header":"Short title","body":["0-20 word point"],"visual":["direct visual instruction"]}]}

LOCKED AUDIO SECTIONS FOR THIS BATCH:
${batchText}`;
}

function buildExactAudioRepairPrompt(
  item: { screenNumber: number; audio: string },
  request: GenerationRequest,
  totalScreens: number
): string {
  return `Return ONLY valid JSON. No markdown. No explanation.

Create PicEd screen fields for this one locked Audio Cue.
Do not rewrite the Audio Cue. Body Text must be a rephrased, ordered point-wise summary of this same Audio Cue only.
Use 0 Body Text items only for greeting, teacher intro, title, transition, or thank-you audio.
For teaching audio, create 3-6 Body Text points, each under 20 words, matching the spoken sequence.

Topic: ${request.topic}
Subject: ${request.subject}
Screen: ${item.screenNumber} of ${totalScreens}

Return exactly this JSON shape:
{"frames":[{"screenNumber":${item.screenNumber},"frame":"Wide with Image","header":"Short header","body":["point under 20 words"],"visual":["specific visual instruction"]}]}

LOCKED AUDIO CUE:
${item.audio}`;
}

function parseExactAudioBatchResponse(
  raw: string,
  batch: Array<{ screenNumber: number; audio: string }>,
  request: GenerationRequest,
  allowFallback = true
): Map<number, ExactAudioFrame> {
  const frames = new Map<number, ExactAudioFrame>();
  const jsonText = extractFirstJsonObject(raw);

  try {
    const parsed = JSON.parse(jsonText) as ExactAudioOutput;
    const byScreen = new Map<number, ExactAudioFrameOutput>();
    for (const frame of Array.isArray(parsed.frames) ? parsed.frames : []) {
      const screenNumber = Number(frame.screenNumber);
      if (Number.isFinite(screenNumber)) byScreen.set(screenNumber, frame);
    }
    for (const item of batch) {
      const output = byScreen.get(item.screenNumber);
      if (output || allowFallback) {
        frames.set(item.screenNumber, sanitizeExactAudioFrame(output, item.audio, request));
      }
    }
  } catch {
    if (allowFallback) {
      for (const item of batch) {
        frames.set(item.screenNumber, sanitizeExactAudioFrame(undefined, item.audio, request));
      }
    }
  }

  return frames;
}

function exactFrameQualityFailure(frame: ExactAudioFrame, screenNumber: number): string | null {
  const audioText = cleanList([frame.audio]).join(' ');
  if (!audioText) return `Screen ${screenNumber} has no locked audio.`;
  if (!frame.frame) return `Screen ${screenNumber} has no frame type.`;
  if (!frame.header && !exactAudioLooksTeacherOnly(audioText)) return `Screen ${screenNumber} has no usable screen header.`;
  if (exactAudioShouldSkipBody(audioText)) return null;

  const audioWords = wordCount(audioText);
  const minimumBodyItems = audioWords >= 120 ? 5 : audioWords >= 80 ? 4 : audioWords >= 45 ? 3 : 2;
  if (frame.body.length < minimumBodyItems) {
    return `Screen ${screenNumber} Body Text is too short for its audio cue.`;
  }

  const audioSentences = audioText
    .split(/(?<=[.!?])\s+/)
    .map(sentence => cleanBodyClause(sentence).toLowerCase())
    .filter(Boolean);

  for (const point of frame.body) {
    const clean = cleanBodyClause(point);
    const words = wordCount(clean);
    if (!clean) return `Screen ${screenNumber} has an empty Body Text point.`;
    if (words > 20) return `Screen ${screenNumber} has Body Text over 20 words.`;
    if (audioWords >= 45 && words < 6) return `Screen ${screenNumber} has label-like Body Text instead of a summary.`;
    if (isIncompleteBodyPoint(clean)) return `Screen ${screenNumber} has incomplete Body Text.`;
    if (!bodyPointStrictlyMatchesAudio(clean, audioText)) {
      return `Screen ${screenNumber} Body Text is not grounded in the same audio cue.`;
    }
    if (words >= 8 && audioSentences.includes(clean.toLowerCase())) {
      return `Screen ${screenNumber} Body Text copies a full audio sentence.`;
    }
  }

  for (let i = 0; i < frame.body.length; i += 1) {
    for (let j = i + 1; j < frame.body.length; j += 1) {
      if (bodyPointsSimilar(frame.body[i], frame.body[j])) {
        return `Screen ${screenNumber} has repeated Body Text points.`;
      }
    }
  }

  if (frame.visual.length === 0) return `Screen ${screenNumber} has no visual instructions.`;
  return null;
}

function validatedSameAudioFrame(
  audio: string,
  request: GenerationRequest,
  screenNumber: number
): ExactAudioFrame | null {
  const frame = sanitizeExactAudioFrame(undefined, audio, request);
  return exactFrameQualityFailure(frame, screenNumber) ? null : frame;
}

function pendingExactAudioFrame(audio: string): ExactAudioFrame {
  return {
    audio,
    frame: 'Wide with Image',
    header: '',
    body: [],
    visual: [],
    pending: true,
  };
}

function exactFrameVisualization(frame: ExactAudioFrame): string {
  if (frame.pending) {
    return [
      'Null Screen Header:',
      '',
      'Body Text:',
      '',
      'Visual/Animation Instructions:',
    ].join('\n');
  }

  const lines: string[] = [];

  if (frame.frame === 'Title Screen') {
    lines.push('Title Text:', frame.header);
  } else if (frame.header && !exactAudioLooksTeacherOnly(frame.audio)) {
    lines.push('Null Screen Header:', frame.header);
  }

  if (frame.body.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Body Text:');
    frame.body.forEach((point, index) => lines.push(`${index + 1}. ${point}`));
  }

  if (frame.visual.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Visual/Animation Instructions:');
    frame.visual.forEach((instruction, index) => lines.push(`${index + 1}. ${instruction}`));
  }

  if (lines.length === 0) {
    lines.push('Audio/Animation Cues:', '1. Keep focus on the speaker for this recorded narration.');
  }

  return lines.join('\n').trim();
}

function assembleExactAudioScript(request: GenerationRequest, frames: ExactAudioFrame[], statusNote = ''): string {
  const T = '\t';
  const cell = (value: string) => value.replace(/\t+/g, ' ').replace(/<<<ROW>>>/g, '').trim();
  const rows = frames.map(frame =>
    `${cell(frame.audio)}${T}${cell(frame.frame)}${T}${cell(exactFrameVisualization(frame))}`
  );

  return [
    'Video Script',
    `${request.topic} | ${request.targetAudience.split('(')[0].trim()} ${request.subject}`,
    'Video Details',
    `Subject${T}${request.subject}`,
    `Chapter${T}${request.chapter || ''}`,
    `Topic${T}${request.topic}`,
    `Video Title${T}${request.topic}`,
    `Alpha Channel Link${T}`,
    `Learning Objective${T}${request.learningObjective || 'Understand ' + request.topic}`,
    `Number of MCQ${T}`,
    'Notes to Video Editor',
    'FONT AND COLOURS:',
    '• Video Title name – Font: Noto Sans – 36 – Bold - Italics | Subject – 28 – Noto Sans – No Bold',
    '• Noto Sans Medium for content, Bold for headings, Italic for important words',
    '• Title: Dark Grey (#303030) | Body text: Light Grey (#474747) | Important words: Blue (#3E7BBF)',
    '• Font size – Title: 50 | Body text: 35 | All text left-aligned',
    ...(statusNote ? ['', 'GENERATION STATUS:', `• ${statusNote}`] : []),
    '',
    'FRAME TYPES:',
    '• Intro Screen – PicEd Logo and bg music',
    '• Title Screen – Video Title name and Subject',
    '• Wide – Only teacher visible in centre of frame',
    '• Wide with Image – Teacher with image and text',
    '• Null – Only screen visible',
    '• Summary – Teacher with image on LHS',
    '• Outro Screen – PicEd Logo and bg music',
    'Frame-by-Frame Script',
    `Audio Cues${T}Frame${T}Visualization Comments / Text on Screen`,
    rows.join('\n<<<ROW>>>\n'),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function exactAudioFramesWithPlaceholders(audioLines: string[], frameMap: Map<number, ExactAudioFrame>): ExactAudioFrame[] {
  return audioLines.map((audio, index) => frameMap.get(index + 1) || pendingExactAudioFrame(audio));
}

async function finalizeExactAudioScaffold(
  request: GenerationRequest,
  audioLines: string[],
  frameMap: Map<number, ExactAudioFrame>,
  statusNote: string,
  onStream?: (chunk: string) => void
): Promise<string> {
  const script = await finalizeScript(
    assembleExactAudioScript(request, exactAudioFramesWithPlaceholders(audioLines, frameMap), statusNote),
    { enrichImages: false }
  );
  if (onStream) onStream(script);
  return script;
}

function fillValidatedSameAudioFrames(
  audioLines: string[],
  request: GenerationRequest,
  frameMap: Map<number, ExactAudioFrame>,
  startScreen = 1
): number {
  let filled = 0;
  for (let index = Math.max(0, startScreen - 1); index < audioLines.length; index += 1) {
    const screenNumber = index + 1;
    if (frameMap.has(screenNumber)) continue;
    const frame = validatedSameAudioFrame(audioLines[index], request, screenNumber);
    if (!frame) continue;
    frameMap.set(screenNumber, frame);
    filled += 1;
  }
  return filled;
}

async function generateExactAudioScript(
  request: GenerationRequest,
  sampleScripts: ParsedScript[],
  onStream?: (chunk: string) => void
): Promise<string> {
  const audioLines = exactAudioLinesFromSource(request.bookContent, request);
  if (audioLines.length === 0) {
    throw new Error('Please provide audio cues separated by screen divider lines, or one audio cue per line, when Keep Audio Cues Exact is enabled.');
  }

  const sampleRaw = sampleScripts.length > 0 ? sampleScripts[0].rawText : '';
  const sampleReference = compactPromptText(sampleRaw, 900);
  const frameMap = new Map<number, ExactAudioFrame>();
  const strictFrameByFrame = request.strictFrameByFrame !== false;
  const batches = strictFrameByFrame
    ? exactAudioSingleScreenBatches(audioLines)
    : exactAudioBatches(audioLines);

  for (const batch of batches) {
    const firstScreen = batch[0]?.screenNumber || frameMap.size + 1;
    if (onStream) {
      onStream(strictFrameByFrame
        ? `Building and checking screen ${firstScreen}/${audioLines.length}...`
        : `Building screens from exact audio sections... (${frameMap.size}/${audioLines.length})`);
    }
    const prompt = buildExactAudioBatchPrompt(batch, request, sampleReference, audioLines.length, audioLines);
    let response = '';
    try {
      response = await requestGroqText(
        prompt,
        groqCompletionBudget(prompt, strictFrameByFrame ? 2200 : 3000, strictFrameByFrame ? 1200 : 1400),
        0.2,
        'Groq request is too large for these exact audio lines. Please split very long audio sections into smaller screen sections.'
      );
    } catch (error) {
      if (isRateLimitError(error)) {
        const locallyFilled = fillValidatedSameAudioFrames(audioLines, request, frameMap, firstScreen);
        return finalizeExactAudioScaffold(
          request,
          audioLines,
          frameMap,
          `Groq token/rate limit reached while generating screen ${firstScreen} of ${audioLines.length}. Filled ${locallyFilled} validated same-audio screen(s) without changing Audio Cues; add another API key or retry after reset to fill any blank Visualization/Text cells.`,
          onStream
        );
      }
      throw error;
    }
    const parsedFrames = parseExactAudioBatchResponse(response, batch, request, !strictFrameByFrame);

    for (const item of batch) {
      let frame = parsedFrames.get(item.screenNumber);
      if (!frame && strictFrameByFrame) {
        if (onStream) onStream(`Retrying screen ${item.screenNumber}/${audioLines.length} with stricter JSON format...`);
        const repairPrompt = buildExactAudioRepairPrompt(item, request, audioLines.length);
        try {
          const retryResponse = await requestGroqText(
            repairPrompt,
            groqCompletionBudget(repairPrompt, 1800, 1000),
            0.1,
            'Groq request is too large for this exact audio line. Please split this audio cue into a smaller screen section.'
          );
          frame = parseExactAudioBatchResponse(retryResponse, [item], request, false).get(item.screenNumber)
            || validatedSameAudioFrame(item.audio, request, item.screenNumber)
            || undefined;
        } catch (error) {
          if (isRateLimitError(error)) {
            frame = validatedSameAudioFrame(item.audio, request, item.screenNumber) || undefined;
            const locallyFilled = fillValidatedSameAudioFrames(audioLines, request, frameMap, item.screenNumber);
            if (frame) frameMap.set(item.screenNumber, frame);
            return finalizeExactAudioScaffold(
              request,
              audioLines,
              frameMap,
              `Groq token/rate limit reached while retrying screen ${item.screenNumber} of ${audioLines.length}. Filled ${locallyFilled} validated same-audio screen(s) without changing Audio Cues; add another API key or retry after reset to fill any blank Visualization/Text cells.`,
              onStream
            );
          } else {
            throw error;
          }
        }
      }

      if (!frame) {
        const reason = `Screen ${item.screenNumber} did not return a valid JSON frame.`;
        if (strictFrameByFrame) {
          return finalizeExactAudioScaffold(
            request,
            audioLines,
            frameMap,
            `Safe generation stopped at screen ${item.screenNumber} of ${audioLines.length}. ${reason} Audio Cue rows remain aligned; regenerate the blank Visualization/Text cells from this screen onward.`,
            onStream
          );
        }
        frameMap.set(item.screenNumber, sanitizeExactAudioFrame(undefined, item.audio, request));
        continue;
      }

      let failure = strictFrameByFrame ? exactFrameQualityFailure(frame, item.screenNumber) : null;
      if (failure && strictFrameByFrame) {
        const sameAudioFrame = validatedSameAudioFrame(item.audio, request, item.screenNumber);
        if (sameAudioFrame) {
          frame = sameAudioFrame;
          failure = null;
        }
      }
      if (failure) {
        return finalizeExactAudioScaffold(
          request,
          audioLines,
          frameMap,
          `Safe generation stopped at screen ${item.screenNumber} of ${audioLines.length}. ${failure} Audio Cue rows remain aligned; regenerate the blank Visualization/Text cells from this screen onward.`,
          onStream
        );
      }

      frameMap.set(item.screenNumber, frame);
    }
  }

  const frames = strictFrameByFrame
    ? exactAudioFramesWithPlaceholders(audioLines, frameMap)
    : audioLines.map((audio, index) =>
        frameMap.get(index + 1) || sanitizeExactAudioFrame(undefined, audio, request)
      );
  const script = await finalizeScript(assembleExactAudioScript(request, frames), { enrichImages: false });
  if (onStream) onStream(script);
  return script;
}

// ── Assemble the script in EXACT PicEd format ────────────────────
function cleanList(values?: unknown): string[] {
  const list = Array.isArray(values)
    ? values
    : typeof values === 'string'
      ? values.split(/\n+/)
      : [];

  return list
    .map(value => String(value || '').replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);
}

function cleanBodyClause(value: string): string {
  return stripFormattingLeak(value)
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*[-–—]\s*\d{1,2}:\d{2}(?::\d{2})?\s*[-–—]\s*(?:cut|trim|delete|remove)\s+(?:the\s+)?(?:clip|video|part|scene)?\b[\s:;,.–—-]*/ig, ' ')
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/^\s*(?:to summarize|in summary|remember that|today we learned that|we also discovered that|this means that),?\s*/i, '')
    .replace(/^\s*(?:and|but|while|whereas|so|however|therefore|in\s+as\s+much|again)\b\s*,?\s*/i, '')
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitCompleteBodyPoint(point: string, maxWords = 20): string[] {
  const clean = cleanBodyClause(point);
  if (!clean) return [];
  if (wordCount(clean) <= maxWords) return [clean];

  const sentenceUnits = clean
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
    ?.map(cleanBodyClause)
    .filter(Boolean) || [clean];

  const output: string[] = [];
  for (const sentence of sentenceUnits) {
    if (wordCount(sentence) <= maxWords) {
      output.push(sentence);
      continue;
    }

    const clauses = sentence
      .split(/(?:;\s+|,\s+(?:while|whereas|but|and|so|which|that)\s+)/i)
      .map(cleanBodyClause)
      .filter(clause => wordCount(clause) >= 4);

    if (clauses.length > 1) {
      clauses.forEach(clause => output.push(clause));
    } else {
      output.push(sentence);
    }
  }

  return output.length > 0 ? output : [clean];
}

function normalizeBodyPoints(points?: unknown): string[] {
  return cleanList(points)
    .flatMap(point => splitCompleteBodyPoint(point))
    .map(point => point.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function formatBodyText(points?: unknown): string {
  const bodyPoints = normalizeBodyPoints(points);
  return bodyPoints.map((point, index) => `${index + 1}. ${point}`).join('\n');
}

const FRAME_TYPE_PATTERN = String.raw`(?:Title Screen|Wide with Image|Wide|Null|Summary|Intro Screen|Outro Screen)`;
const VISUAL_SECTION_PATTERN = String.raw`(?:Null Screen Header|Title Text|Body Text|Visual\/Animation Instructions|Audio\/Animation Cues|Image Suggestions?)`;

function stripFormattingLeak(value: string): string {
  let text = value.replace(/\t+/g, ' ').trim();
  const inlineBoundary = new RegExp(`\\b${FRAME_TYPE_PATTERN}\\s+${VISUAL_SECTION_PATTERN}\\s*:?`, 'i');
  const boundaryMatch = text.match(inlineBoundary);
  if (boundaryMatch && typeof boundaryMatch.index === 'number') {
    text = boundaryMatch.index === 0 ? '' : text.slice(0, boundaryMatch.index).trim();
  }

  return text
    .replace(/\b(?:Frame-by-Frame Script|Audio Cues\s+Frame\s+Visualization Comments\s*\/\s*Text on Screen)\b.*$/i, '')
    .trim();
}

function isFrameOrTableBoundaryLine(value: string): boolean {
  const trimmed = value.replace(/\t+/g, ' ').trim();
  if (!trimmed) return false;
  if (/^<<<ROW>>>$/i.test(trimmed)) return true;
  if (/^Frame-by-Frame Script$/i.test(trimmed)) return true;
  if (/^Audio Cues\s+Frame\s+Visualization Comments\s*\/\s*Text on Screen$/i.test(trimmed)) return true;
  return new RegExp(`^${FRAME_TYPE_PATTERN}(?:\\s+${VISUAL_SECTION_PATTERN}\\s*:?)?$`, 'i').test(trimmed);
}

function isVisualizationBoundaryLine(value: string): boolean {
  const trimmed = value.replace(/\t+/g, ' ').trim();
  if (!trimmed) return false;
  if (isFrameOrTableBoundaryLine(trimmed)) return true;
  return new RegExp(`^(?:${VISUAL_SECTION_PATTERN}|📌\\s*Image Suggestions?|Image\\s*\\d*\\s*:|AI Image Prompt\\s*\\d*\\s*:|GIF\\s*\\d*\\s*:)`, 'i').test(trimmed);
}

function audioDerivedBodyPoints(audio?: unknown): string[] {
  const audioText = cleanList(audio).join(' ');
  if (!audioText.trim()) return [];

  const sentences = audioText
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(sentence => {
      if (wordCount(sentence) < 7) return false;
      return !/^(hello learners|hello|thank you|today we learned|now we are going|in today's session)/i.test(sentence);
    });

  const derived = sentences
    .flatMap(sentence => splitCompleteBodyPoint(sentence, 20))
    .map(point => rephraseLockedAudioBodyPoint(point.replace(/[.!?]+$/g, '').trim(), audioText) || point)
    .map(point => cleanBodyClause(point))
    .filter(point => wordCount(point) >= 7 && wordCount(point) <= 20)
    .filter(point => !isWeakSummaryBodyPoint(point, audioText));
  const output: string[] = [];
  const used = new Set<string>();
  const addPoint = (point: string) => {
    const key = bodyPointKey(point);
    if (!key || used.has(key)) return;
    output.push(point);
    used.add(key);
  };

  seededLockedAudioBodyPoints(audioText).forEach(addPoint);
  derived.forEach(addPoint);
  return output.slice(0, targetSummaryPointCount(audioText));
}

function hasEnoughBodyDetail(points: string[], audio?: unknown): boolean {
  if (points.length === 0) return false;
  const audioPointCount = audioDerivedBodyPoints(audio).length;
  const audioWords = wordCount(cleanList(audio).join(' '));
  const targetCount = Math.min(targetSummaryPointCount(cleanList(audio).join(' ')), Math.max(3, audioPointCount));
  const averageWords = points.reduce((sum, point) => sum + wordCount(point), 0) / points.length;
  const bodyWords = points.reduce((sum, point) => sum + wordCount(point), 0);
  const tinyPointCount = points.filter(point => wordCount(point) < 9 && !/[=+\-*/^]/.test(point)).length;

  if (audioWords > 0 && bodyWords > Math.max(12, Math.floor(audioWords * 0.65))) return false;
  return points.length >= targetCount && averageWords >= 12 && tinyPointCount === 0;
}

function expandedBodyPointFromAudio(point: string, audioText: string): string {
  const clean = sentenceCase(cleanBodyClause(point));
  if (!clean || wordCount(clean) >= 12 || /[=+\-*/^]/.test(clean)) return clean;

  const compactAudio = audioText.replace(/\s+/g, ' ');
  const lowerPoint = clean.toLowerCase();
  const candidates: string[] = [];
  const add = (condition: boolean, value: string) => {
    if (condition) candidates.push(value);
  };

  add(/soil aeration|air spaces|air in soil/i.test(lowerPoint),
    'Soil aeration shows the amount of air spaces in a soil sample');
  add(/air.*support|soil life|bacteria|fungi|earthworms/i.test(`${lowerPoint} ${compactAudio}`) && /air|oxygen|respiration/i.test(`${lowerPoint} ${compactAudio}`),
    'Air in soil supports bacteria, fungi, and earthworms that require oxygen for respiration');
  add(/plant roots?.*oxygen|aerobic respiration/i.test(`${lowerPoint} ${compactAudio}`),
    'Plant roots require oxygen to carry out aerobic respiration in the soil');
  add(/water retention|retain water|retained water/i.test(lowerPoint),
    'Water retention is soil ability to retain rainwater after it has rained');
  add(/clay.*water retention|highest water retention|waterlogged/i.test(`${lowerPoint} ${compactAudio}`),
    'Clay retains a lot of water because it has smaller particles and air spaces');
  add(/photosynthesis|germination|retained water/i.test(`${lowerPoint} ${compactAudio}`),
    'Retained water enables photosynthesis and germination to take place in soil');
  add(/drainage|waterlogging|water logging/i.test(lowerPoint),
    'Soil drainage is the ability of water to pass downward through soil');
  add(/poor drainage|suffocate|rot/i.test(`${lowerPoint} ${compactAudio}`),
    'Poor drainage causes roots to suffocate due to lack of oxygen');
  add(/crumb structure|crumbs|aggregates/i.test(lowerPoint),
    'Crumb structure arranges soil particles into rounded aggregates for easier air and water movement');
  add(/particle size|soil grains/i.test(lowerPoint),
    'Particle size means individual soil grains, with sand largest and clay finest');
  add(/soil texture|sand.*silt.*clay/i.test(`${lowerPoint} ${compactAudio}`),
    'Soil texture shows the proportion of sand, silt, and clay in a sample');
  add(/porosity|pores/i.test(lowerPoint),
    'Porosity describes pore spaces between particles that allow air and water movement');
  add(/capillarity|rise/i.test(lowerPoint),
    'Capillarity lets water rise through narrow soil spaces against gravity');
  add(/\bpH\b|acidic|alkaline|neutral/i.test(lowerPoint),
    'Soil pH measures acidity or alkalinity on a scale from zero to fourteen');
  add(/lime|calcium carbonate/i.test(lowerPoint),
    'Lime contains calcium carbonate and helps raise acidic soil toward neutral pH');

  const best = candidates
    .map(candidate => cleanBodyClause(candidate))
    .filter(candidate => wordCount(candidate) <= 20)
    .filter(candidate => bodyPointStrictlyMatchesAudio(candidate, audioText))
    .sort((a, b) => wordCount(b) - wordCount(a))[0];

  return best || clean;
}

function enforceDetailedBodyPoints(points: string[], audioText: string, targetCount: number): string[] {
  const output: string[] = [];
  const used = new Set<string>();
  const addPoint = (point: string) => {
    const expanded = expandedBodyPointFromAudio(point, audioText);
    const key = bodyPointKey(expanded);
    if (
      !key ||
      used.has(key) ||
      wordCount(expanded) > 20 ||
      isWeakSummaryBodyPoint(expanded, audioText) ||
      !bodyPointStrictlyMatchesAudio(expanded, audioText)
    ) return;
    output.push(expanded);
    used.add(key);
  };

  points.forEach(addPoint);
  conciseBodyPointsFromAudio(audioText).forEach(addPoint);
  const minimumUsefulCount = Math.min(targetCount, wordCount(audioText) >= 65 ? 4 : 3);
  const averageWords = () => output.length
    ? output.reduce((sum, point) => sum + wordCount(point), 0) / output.length
    : 0;

  if (output.length < minimumUsefulCount || averageWords() < 12) {
    audioDerivedBodyPoints(audioText).forEach(addPoint);
  }

  return output.slice(0, Math.max(targetCount, minimumUsefulCount));
}

function capBodyPointsToAudio(points: string[], audio?: unknown): string[] {
  const audioWords = wordCount(cleanList(audio).join(' '));
  if (audioWords === 0) return points.slice(0, 6);

  const maxBodyWords = Math.max(24, Math.floor(audioWords * 0.75));
  const maxPoints = targetSummaryPointCount(cleanList(audio).join(' '));
  const output: string[] = [];
  let usedWords = 0;

  for (const point of points) {
    const pointWords = wordCount(point);
    if (output.length >= maxPoints) break;
    if (output.length > 0 && usedWords + pointWords > maxBodyWords) continue;
    if (pointWords > audioWords) continue;
    output.push(point);
    usedWords += pointWords;
  }

  if (output.length > 0) return output;
  const safeFallback = points.filter(point => wordCount(point) <= audioWords);
  return safeFallback.length > 0 ? safeFallback.slice(0, 1) : [];
}

function detailedBodyPoints(points?: unknown, audio?: unknown): string[] {
  const originalPoints = normalizeBodyPoints(points)
    .map(point => cleanBodyClause(point))
    .filter(point => !isFrameOrTableBoundaryLine(point))
    .filter(point => !isWeakSummaryBodyPoint(point, cleanList(audio).join(' ')))
    .filter(point => wordCount(point) <= 20);
  if (hasEnoughBodyDetail(originalPoints, audio)) return originalPoints;

  const derivedPoints = audioDerivedBodyPoints(audio);
  if (derivedPoints.length === 0) return originalPoints;

  const merged: string[] = [];
  const used = new Set<string>();
  const addPoint = (point: string) => {
    const key = bodyPointKey(point);
    if (!key || used.has(key)) return;
    merged.push(point);
    used.add(key);
  };

  originalPoints.filter(point => wordCount(point) >= 8 || /[=+\-*/^]/.test(point)).forEach(addPoint);
  derivedPoints.forEach(addPoint);
  originalPoints.forEach(addPoint);

  const audioText = cleanList(audio).join(' ');
  return capBodyPointsToAudio(enforceDetailedBodyPoints(merged, audioText, Math.max(4, derivedPoints.length)), audio);
}

function formatDetailedBodyText(points?: unknown, audio?: unknown): string {
  return detailedBodyPoints(points, audio).map((point, index) => `${index + 1}. ${point}`).join('\n');
}

function meaningfulTokens(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'so', 'to', 'of', 'in', 'on', 'for', 'with', 'by', 'from',
    'is', 'are', 'was', 'were', 'be', 'being', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
    'we', 'you', 'they', 'he', 'she', 'have', 'has', 'had', 'here', 'there', 'basically', 'overall',
    'include', 'includes', 'including', 'such', 'as', 'look', 'looking', 'at',
    'key', 'can', 'means', 'need', 'needs', 'support', 'supports', 'property',
    'observe', 'observed', 'measure', 'measured', 'indicate', 'indicates',
    'show', 'image', 'diagram', 'label', 'labels', 'highlight', 'display', 'animate', 'animation',
    'visual', 'screen', 'arrow', 'callout', 'callouts', 'ost', 'use', 'clean', 'clear', 'simple',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9+\-=/^ ]+/g, ' ')
    .split(/\s+/)
    .map(token => token.replace(/ies$/i, 'y').replace(/s$/i, ''))
    .filter(token => token.length > 2 || /[0-9=+\-]/.test(token))
    .filter(token => !stopWords.has(token));
}

function bodyPointGroundedInAudio(point: string, audioText: string, minimumRatio = 0.7): boolean {
  const pointTokens = meaningfulTokens(point);
  if (pointTokens.length === 0) return true;
  const audioTokens = new Set(meaningfulTokens(audioText));
  if (audioTokens.size === 0) return true;

  const matched = pointTokens.filter(token => audioTokens.has(token)).length;
  return matched / pointTokens.length >= minimumRatio;
}

function bodyPointStrictlyMatchesAudio(point: string, audioText: string): boolean {
  const pointTokens = meaningfulTokens(point);
  if (pointTokens.length === 0) return true;
  const audioTokens = new Set(meaningfulTokens(audioText));
  if (audioTokens.size === 0) return false;

  const matched = pointTokens.filter(token => audioTokens.has(token)).length;
  const ratio = matched / pointTokens.length;
  if (matched < Math.min(2, pointTokens.length)) return false;
  if (wordCount(point) < 10) return ratio >= 0.75;
  return ratio >= 0.58;
}

function cleanLockedAudioBodyCandidate(value: string): string {
  return cleanBodyClause(value)
    .replace(/^\s*here\s*,?\s*/i, '')
    .replace(/^\s*i\s+mean\s+/i, '')
    .replace(/^\s*(?:here,?\s*)?(?:we\s+have|we\s+look\s+at|we\s+are\s+looking\s+at)\s+/i, '')
    .replace(/\bwhich basically\b/ig, '')
    .replace(/\bbasically\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNarrationOnlyBodyCandidate(value: string): boolean {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return true;
  if (/^(hello learners|hello|welcome|thank you|in this session|today we are going|now we are going|we are going|we will|let us|let's)\b/i.test(clean)) return true;
  if (/\b(my name is|your teacher)\b/i.test(clean)) return true;
  if (/^(why|what|how|when|where)\b/i.test(clean) && clean.includes('?')) return true;
  if (wordCount(clean) <= 8 && !/\b(is|are|has|have|include|includes|contain|contains|require|requires|retain|retains|support|supports|mean|means|show|shows)\b/i.test(clean)) return true;
  return false;
}

function isIncompleteBodyPoint(value: string): boolean {
  const clean = value.replace(/\s+/g, ' ').replace(/[.!?]+$/g, '').trim();
  if (!clean || /[=+\-*/^]/.test(clean)) return false;
  const lower = clean.toLowerCase();
  if (/^(?:what|why|how)\s*:/i.test(clean)) return true;
  if (/^(?:what|why|how)\b.+\?$/i.test(clean)) return true;
  if (/^(?:then\s+)?(?:the\s+)?other\s+(?:importance|point|reason)\b/i.test(lower)) return true;
  if (/^(?:is|was|are|were)\s+(?:gotten|obtained|needed|used)\b/i.test(lower)) return true;
  if (/^(?:require|requires|retain|retains|support|supports|contain|contains|can|will|would|should|to)\b/.test(lower)) return true;
  if (/\b(?:in|to|of|for|from|with|and|or|but|as|that|which|because|therefore|then|it|the|a|an)$/i.test(lower)) return true;
  if (/\b(?:we have|therefore,\s*it|ability of water to)$/i.test(lower)) return true;
  return false;
}

function isWeakSummaryBodyPoint(point: string, audioText = ''): boolean {
  const clean = cleanBodyClause(point);
  if (!clean) return true;
  if (isNarrationOnlyBodyCandidate(clean) || isIncompleteBodyPoint(clean)) return true;
  if (/^(?:what|why|how)\s*:/i.test(clean)) return true;
  if (/^(?:then\s+)?(?:the\s+)?other\s+(?:importance|point|reason)\b/i.test(clean)) return true;
  if (/^(?:is|was|are|were)\s+(?:gotten|obtained|needed|used)\b/i.test(clean)) return true;
  if (audioText && bodyPointTooVerbatim(clean, audioText)) return true;
  return false;
}

function targetSummaryPointCount(audioText: string): number {
  const audioWords = wordCount(audioText);
  if (/\bclay soil\b/i.test(audioText) && /\bloam soil\b/i.test(audioText)) return 8;
  if (audioWords >= 220) return 10;
  if (audioWords >= 160) return 9;
  if (audioWords >= 120) return 8;
  if (audioWords >= 80) return 6;
  if (audioWords >= 45) return 4;
  return 3;
}

function sentenceCase(value: string): string {
  const clean = value.replace(/\s+/g, ' ').replace(/^[,;:\-. ]+|[,;:\-. ]+$/g, '').trim();
  if (!clean) return '';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function stripLeadingArticle(value: string): string {
  return value.replace(/^\s*(?:the|a|an)\s+/i, '').trim();
}

function hasLongSharedPhrase(point: string, audioText: string, minWords = 5): boolean {
  const pointWords = normalizeComparable(point).split(' ').filter(Boolean);
  const audioComparable = ` ${normalizeComparable(audioText)} `;
  if (pointWords.length < minWords) return false;

  for (let index = 0; index <= pointWords.length - minWords; index += 1) {
    const phrase = pointWords.slice(index, index + minWords).join(' ');
    if (audioComparable.includes(` ${phrase} `)) return true;
  }

  return false;
}

function bodyPointTooVerbatim(point: string, audioText: string): boolean {
  if (wordCount(point) <= 8) return false;
  return hasLongSharedPhrase(point, audioText, 7);
}

function seededLockedAudioBodyPoints(audioText: string): string[] {
  const compact = audioText.replace(/\s+/g, ' ');
  const points: string[] = [];
  const add = (condition: boolean, point: string) => {
    if (condition) points.push(point);
  };

  add(/\bsoil\b.*natural.*(?:earth|surface|crust)/i.test(compact), 'Soil is a natural earth surface material');
  add(/\bsoil\b.*mixture.*minerals?.*organic matter/i.test(compact), 'Soil is a mixture of minerals and organic matter');
  add(/45\s*%.*minerals?.*50\s*%.*voids?.*5\s*%.*organic/i.test(compact), 'Soil contains minerals, voids, and organic matter');
  add(/organic matter.*(?:living|decayed).*plant.*animal.*(?:remains|remain)/i.test(compact), 'Organic matter includes living and decayed remains');
  add(/\bhumus\b/i.test(compact), 'Decayed organic matter forms humus in soil');
  add(/different types of soil|three types of soil/i.test(compact), 'Soil types are grouped by their properties');
  add(/\bsandy soil\b.*(?:large|coarse)/i.test(compact), 'Sandy soil has large, coarse particles');
  add(/\bsandy soil\b.*(?:gritty|loose|light)/i.test(compact), 'Sandy soil feels loose, light, and gritty');
  add(/water.*drain.*quickly|high water drainage/i.test(compact), 'Water drains quickly through sandy soil');
  add(/low water retention|holds very little water/i.test(compact), 'Sandy soil has low water retention');
  add(/\bconstruction\b/i.test(compact) && /\bsandy soil\b/i.test(compact), 'Sandy soil is useful in construction work');
  add(/experiment.*different particle sizes|different particle sizes.*(?:test tube|boiling tube)/i.test(compact), 'Experiment shows different soil particle sizes');
  add(/different soil samples.*(?:test tube|boiling tube)/i.test(compact), 'Place different soil samples in a test tube');
  add(/\b50\s*grams?\b.*soil sample/i.test(compact), 'Use 50 grams of soil sample');
  add(/\b200\s*cubic\s*centi?met(?:er|re)s?\b.*water/i.test(compact), 'Add 200 cubic centimetres of water');
  add(/sodium bicarbonate.*(?:disperse|separate)|(?:disperse|separate).*sodium bicarbonate/i.test(compact), 'Sodium bicarbonate helps particles disperse and separate');
  add(/shake.*(?:boiling tube|test tube)/i.test(compact), 'Shake the tube containing soil and water');
  add(/settle.*five minutes|five minutes.*observe/i.test(compact), 'Let the mixture settle for about five minutes');
  add(/come and observe|observe.*particles|particles.*observe/i.test(compact), 'Observe the soil layers after settling');
  add(/particles.*settle.*according to.*size/i.test(compact), 'Soil particles settle according to their size');
  add(/gravel.*settle.*bottom/i.test(compact), 'Gravel settles at the bottom first');
  add(/followed by sand.*silt.*clay|sand.*silt.*clay.*lime/i.test(compact), 'Sand, silt, and clay settle in sequence');
  add(/top.*organic matter|organic matter.*top/i.test(compact), 'Organic matter remains near the top layer');
  add(/aggregate separately|separate.*(?:soil layer|sample)/i.test(compact), 'Separated particles reveal visible soil layers');
  add(/\bsoil\s+pH\b.*\blime\b/i.test(compact), 'Chemical properties focus on soil pH and lime in soil');
  add(/\bsoil\s+pH\b.*measure.*acidity.*alkalinity/i.test(compact), 'Soil pH measures acidity and alkalinity in a soil sample');
  add(/\bpH\b.*0\s*to\s*14/i.test(compact), 'Soil pH uses a 0 to 14 scale');
  add(/\bpH\b.*7.*neutral/i.test(compact), 'pH 7 shows neutral soil conditions');
  add(/\bpH\b.*below\s*7.*acidic/i.test(compact), 'pH below 7 indicates acidic soil');
  add(/\bpH\b.*above\s*7.*(?:alkaline|basic)/i.test(compact), 'pH above 7 indicates alkaline or basic soil');
  add(/best\s+pH.*6\s*to\s*7\.5|6\s*to\s*7\.5.*slightly acidic.*neutral/i.test(compact), 'Best crop pH is about 6 to 7.5');
  add(/slightly acidic.*neutral\s+pH/i.test(compact), 'Crops grow best in slightly acidic to neutral soil');
  add(/too acidic.*adding lime|adding lime.*acidic soil/i.test(compact), 'Lime helps raise acidic soil pH');
  add(/lime.*calcium carbonate|calcium carbonate.*lime/i.test(compact), 'Lime contains calcium carbonate compounds');
  add(/alkaline.*raises.*pH|raises.*pH.*neutral/i.test(compact), 'Alkaline lime raises soil pH toward neutral');
  add(/sources of lime.*limestone|weathering of limestone/i.test(compact), 'Limestone weathering supplies lime to soil');
  add(/agricultural lime.*farmers|farmers.*agricultural lime/i.test(compact), 'Farmers can add agricultural lime');
  add(/irrigation.*dissolved calcium|dissolved calcium.*irrigation/i.test(compact), 'Irrigation water may add dissolved calcium');
  add(/prevents.*soil.*acidic.*neutral|adds lime.*neutral/i.test(compact), 'Added lime helps neutralize acidic soil');
  add(/heavy rainfall.*calcium.*magnesium.*leach/i.test(compact), 'Heavy rainfall leaches calcium and magnesium into lower layers');
  add(/fertili[sz]ers?.*increase.*acid/i.test(compact), 'Continuous fertilizer use can increase soil acidity');
  add(/(?:organic matter|dead plant and animal).*increase.*acid/i.test(compact), 'Organic matter decomposition can increase soil acidity');
  add(/high rainfall areas?.*slightly acidic/i.test(compact), 'High rainfall areas may develop slightly acidic soils');
  add(/\blime\b.*calcium carbonate/i.test(compact), 'Lime is calcium carbonate deposited in soil');
  add(/(?:low rainfall|poor drainage|irrigation).*dissolved salts?.*alkalin/i.test(compact), 'Low rainfall, poor drainage, and dissolved salts increase alkalinity');

  return points;
}

function safeCompleteBodyPoint(value: string, maxWords = 20): string {
  const clean = cleanLockedAudioBodyCandidate(value);
  if (!clean || isIncompleteBodyPoint(clean)) return '';
  if (wordCount(clean) <= maxWords) return sentenceCase(clean);

  const splitCandidates = clean
    .split(/\s+(?:and therefore|therefore|however|because|since|while|whereas|whereby|which|that|and then)\s+/i)
    .map(cleanBodyClause)
    .filter(candidate => wordCount(candidate) >= 4 && wordCount(candidate) <= maxWords && !isIncompleteBodyPoint(candidate));
  if (splitCandidates.length > 0) return sentenceCase(splitCandidates[0]);

  const coreMatch = clean.match(/^(.+?\b(?:is|are|has|have|contains?|requires?|allows?|helps?|prevents?|causes?|supports?|forms?|produces?|absorbs?|stores?|protects?|means|refers\s+to)\b\s+.+?)(?:\s+(?:because|since|as|while|whereby|therefore|however|and)\s+.+)$/i);
  if (coreMatch) {
    const core = cleanBodyClause(coreMatch[1]);
    if (wordCount(core) <= maxWords && !isIncompleteBodyPoint(core)) return sentenceCase(core);
  }

  return '';
}

function genericLockedAudioBodyPoint(clean: string): string {
  if (!clean || isIncompleteBodyPoint(clean)) return '';

  const definitionMatch = clean.match(/^(.+?)\s+(?:is|are)\s+(?:the\s+|a\s+|an\s+)?(.+)$/i);
  if (definitionMatch) {
    const subject = sentenceCase(stripLeadingArticle(definitionMatch[1]));
    const description = stripLeadingArticle(definitionMatch[2]);
    const point = `${subject}: ${description}`;
    if (wordCount(point) <= 20 && !isIncompleteBodyPoint(point)) return point;
  }

  const meansMatch = clean.match(/^(.+?)\s+(?:means|refers\s+to)\s+(.+)$/i);
  if (meansMatch) {
    const point = `${sentenceCase(stripLeadingArticle(meansMatch[1]))} means ${stripLeadingArticle(meansMatch[2])}`;
    if (wordCount(point) <= 20 && !isIncompleteBodyPoint(point)) return point;
  }

  const actionMatch = clean.match(/^(.+?)\s+\b(has|have|contains?|requires?|allows?|helps?|prevents?|causes?|supports?|forms?|produces?|absorbs?|stores?|protects?)\b\s+(.+)$/i);
  if (actionMatch) {
    const point = `${sentenceCase(stripLeadingArticle(actionMatch[1]))} ${actionMatch[2].toLowerCase()} ${stripLeadingArticle(actionMatch[3])}`;
    if (wordCount(point) <= 20 && !isIncompleteBodyPoint(point)) return point;
  }

  return safeCompleteBodyPoint(clean);
}

function rephraseLockedAudioBodyPoint(point: string, audioText: string): string {
  const clean = cleanLockedAudioBodyCandidate(point);
  if (!clean) return '';

  const focusMatch = clean.match(/^(?:we\s+)?focus\s+on\s+(.+)$/i);
  if (focusMatch) return `${sentenceCase(stripLeadingArticle(focusMatch[1]))} is the key focus for this screen`;

  const measureMatch = clean.match(/^(.+?)\s+is\s+the\s+measure\s+of\s+(.+)$/i);
  if (measureMatch) return `${sentenceCase(stripLeadingArticle(measureMatch[1]))} measures ${stripLeadingArticle(measureMatch[2])}`;

  if (/soil.*natural.*(?:earth|surface|crust)/i.test(clean)) return 'Soil is a natural earth surface material';
  if (/mixture.*minerals?.*organic matter/i.test(clean)) return 'Soil is a mixture of minerals and organic matter';
  if (/45\s*%.*minerals?.*50\s*%.*voids?.*5\s*%.*organic/i.test(clean)) return 'Soil contains minerals, voids, and organic matter';
  if (/organic matter.*(?:living|decayed).*plant.*animal.*(?:remains|remain)/i.test(clean)) return 'Organic matter includes living and decayed remains';
  if (/\bhumus\b/i.test(clean)) return 'Decayed organic matter forms humus in soil';
  if (/(?:different types of soil|three types of soil)/i.test(clean)) return 'Soil types are grouped by their properties';
  if (/\bsandy soil\b.*(?:large|coarse)/i.test(clean)) return 'Sandy soil has large, coarse particles';
  if (/\bsandy soil\b.*(?:gritty|loose|light)/i.test(clean)) return 'Sandy soil feels loose, light, and gritty';
  if (/water.*drain.*quickly|high water drainage/i.test(clean)) return 'Water drains quickly through sandy soil';
  if (/low water retention|holds very little water/i.test(clean)) return 'Sandy soil has low water retention';
  if (/\bconstruction\b/i.test(clean) && /\bsandy soil\b/i.test(clean)) return 'Sandy soil is useful in construction work';
  if (/experiment.*different particle sizes|different particle sizes.*(?:test tube|boiling tube)/i.test(clean)) return 'Experiment shows different soil particle sizes';
  if (/different soil samples.*(?:test tube|boiling tube)/i.test(clean)) return 'Place different soil samples in a test tube';
  if (/\b50\s*grams?\b.*soil sample/i.test(clean)) return 'Use 50 grams of soil sample';
  if (/\b200\s*cubic\s*centi?met(?:er|re)s?\b.*water/i.test(clean)) return 'Add 200 cubic centimetres of water';
  if (/sodium bicarbonate.*(?:disperse|separate)|(?:disperse|separate).*sodium bicarbonate/i.test(clean)) return 'Sodium bicarbonate helps particles disperse and separate';
  if (/shake.*(?:boiling tube|test tube)/i.test(clean)) return 'Shake the tube containing soil and water';
  if (/settle.*five minutes|five minutes.*observe/i.test(clean)) return 'Let the mixture settle for about five minutes';
  if (/come and observe|observe.*particles|particles.*observe/i.test(clean)) return 'Observe the soil layers after settling';
  if (/particles.*settle.*according to.*size/i.test(clean)) return 'Soil particles settle according to their size';
  if (/gravel.*settle.*bottom/i.test(clean)) return 'Gravel settles at the bottom first';
  if (/followed by sand.*silt.*clay|sand.*silt.*clay.*lime/i.test(clean)) return 'Sand, silt, and clay settle in sequence';
  if (/top.*organic matter|organic matter.*top/i.test(clean)) return 'Organic matter remains near the top layer';
  if (/aggregate separately|separate.*(?:soil layer|sample)/i.test(clean)) return 'Separated particles reveal visible soil layers';
  if (/best\s+pH.*6\s*to\s*7\.5|6\s*to\s*7\.5.*slightly acidic.*neutral/i.test(clean)) return 'Best crop pH is about 6 to 7.5';
  if (/slightly acidic.*neutral\s+pH|^(?:which\s+)?(?:is\s+)?slightly acidic.*neutral/i.test(clean)) return 'Crops grow best in slightly acidic to neutral soil';
  if (/too acidic.*adding lime|adding lime.*acidic soil/i.test(clean)) return 'Lime helps raise acidic soil pH';
  if (/lime.*calcium carbonate|calcium carbonate.*lime/i.test(clean)) return 'Lime contains calcium carbonate compounds';
  if (/alkaline.*raises.*pH|raises.*pH.*neutral/i.test(clean)) return 'Alkaline lime raises soil pH toward neutral';
  if (/sources of lime.*limestone|weathering of limestone/i.test(clean)) return 'Limestone weathering supplies lime to soil';
  if (/agricultural lime.*farmers|farmers.*agricultural lime/i.test(clean)) return 'Farmers can add agricultural lime';
  if (/irrigation.*dissolved calcium|dissolved calcium.*irrigation/i.test(clean)) return 'Irrigation water may add dissolved calcium';
  if (/prevents.*soil.*acidic.*neutral|adds lime.*neutral/i.test(clean)) return 'Added lime helps neutralize acidic soil';
  if (/^lime,?\s+what:? lime/i.test(clean) || /^what are the sources of lime/i.test(clean)) return '';

  if (/\bpH\b.*0\s*to\s*14/i.test(clean)) return 'Soil pH uses a 0 to 14 scale';
  if (/\bpH\b.*below\s*7.*acidic/i.test(clean)) return 'pH below 7 indicates acidic soil';
  if (/\bpH\b.*above\s*7.*(?:alkaline|basic)/i.test(clean)) return 'pH above 7 indicates alkaline or basic soil';
  if (/soil becomes acidic.*heavy rainfall/i.test(clean)) return 'Heavy rainfall can make soil more acidic';
  if (/calcium.*magnesium.*leach/i.test(clean)) return 'Calcium and magnesium leaching increases soil acidity';
  if (/fertili[sz]ers?.*increase.*acid/i.test(clean)) return 'Continuous fertilizer use can increase soil acidity';
  if (/(?:organic matter|dead plant and animal).*increase.*acid/i.test(clean)) return 'Organic matter decomposition can increase soil acidity';
  if (/high rainfall areas?.*slightly acidic/i.test(clean)) return 'High rainfall areas may develop slightly acidic soils';
  if (/become alkaline.*high amount of lime/i.test(clean)) return 'High lime levels make soil alkaline';
  if (/lime is calcium carbonate/i.test(clean)) return 'Lime is calcium carbonate deposited in soil';
  if (/dissolved salts?.*alkalin/i.test(clean)) return 'Dissolved salts can increase soil alkalinity';

  if (/soil texture.*proportion.*sand.*silt.*clay/i.test(clean)) {
    return 'Soil texture shows sand, silt, and clay proportions';
  }

  if (/^soil texture\b/i.test(clean) && /sand.*silt.*clay/i.test(clean)) {
    return 'Soil texture compares sand, silt, and clay';
  }

  if (/best soil texture.*loam soil/i.test(clean) || /loam soil.*average particle size/i.test(clean)) {
    return 'Loam soil has balanced texture and particle size';
  }

  if (/loam soil.*plant growth/i.test(clean)) {
    return 'Loam texture supports plant growth';
  }

  if (/^porosity\b.*amount of pores/i.test(clean)) {
    return 'Porosity means pores between soil particles';
  }

  if (/more.*pores.*higher.*porosity/i.test(clean)) {
    return 'More pores create higher soil porosity';
  }

  if (/air spaces.*circulation of gases/i.test(clean)) {
    return 'Air spaces circulate oxygen, carbon dioxide, and nitrogen';
  }

  if (/capillarity.*water.*rise.*narrow spaces.*gravity/i.test(clean)) {
    return 'Capillarity lets water rise through narrow soil spaces';
  }

  if (/clay soil.*highest capillarity/i.test(clean)) {
    return 'Clay soil has high capillarity because pores are tiny';
  }

  if (/sand soil.*lowest.*capillarity/i.test(clean)) {
    return 'Sand soil has the lowest capillarity';
  }

  if (/air spaces?.*amount of air/i.test(clean)) {
    return 'Soil aeration shows air spaces and air in soil';
  }

  const physicalMatch = clean.match(/^the physical properties of (.+)$/i);
  if (physicalMatch) return `${sentenceCase(stripLeadingArticle(physicalMatch[1]))} has physical properties`;

  const propertyExampleMatch = clean.match(/^properties such as (.+)$/i);
  if (propertyExampleMatch) return `${sentenceCase(stripLeadingArticle(propertyExampleMatch[1]))} is a key property`;

  const nextPropertyMatch = clean.match(/^the next property is (.+)$/i);
  if (nextPropertyMatch) return `${sentenceCase(stripLeadingArticle(nextPropertyMatch[1]))} is another property`;

  const nextPhysicalPropertyMatch = clean.match(/^the next physical property is (.+)$/i);
  if (nextPhysicalPropertyMatch) return `${sentenceCase(stripLeadingArticle(nextPhysicalPropertyMatch[1]))} is another physical property`;

  const finalPhysicalPropertyMatch = clean.match(/^the next physical property.*(?:is|one is)\s+(.+)$/i);
  if (finalPhysicalPropertyMatch) return '';

  const amountInMatch = clean.match(/^(?:the )?amount of (.+?) in (.+)$/i);
  if (amountInMatch) {
    const measure = stripLeadingArticle(amountInMatch[1]);
    const place = stripLeadingArticle(amountInMatch[2]);
    return `${sentenceCase(measure)} in ${place} can be observed`;
  }

  const supportMatch = clean.match(/^(.+?)\s+is\s+(?:very\s+)?important\s+to\s+support\s+(.+)$/i);
  if (supportMatch) {
    const target = stripLeadingArticle(supportMatch[2]).replace(/^life in (?:a\s+)?soil$/i, 'soil life');
    return `${sentenceCase(stripLeadingArticle(supportMatch[1]))} supports ${target}`;
  }

  if (/^plant roots are also living tissues/i.test(clean)) {
    return 'Plant roots need oxygen for aerobic respiration';
  }

  const requireMatch = clean.match(/^(.+?)\s+require[s]?\s+(.+?)\s+to\s+carry\s+out\s+(.+)$/i);
  if (requireMatch) {
    const purpose = stripLeadingArticle(requireMatch[3]).replace(/\s+in\s+the\s+soil.*$/i, '');
    const subject = stripLeadingArticle(requireMatch[1])
      .replace(/\s+that$/i, '')
      .replace(/\s+are\s+also\s+living\s+tissues$/i, '');
    return `${sentenceCase(subject)} need ${stripLeadingArticle(requireMatch[2])} for ${purpose}`;
  }

  const requireNoSubjectMatch = clean.match(/^require[s]?\s+(.+?)\s+to\s+carry\s+out\s+(.+)$/i);
  if (requireNoSubjectMatch) {
    const subject = /aerobic/i.test(requireNoSubjectMatch[2]) && /plant roots/i.test(audioText)
      ? 'Plant roots'
      : 'Soil organisms';
    const purpose = stripLeadingArticle(requireNoSubjectMatch[2]).replace(/\s+in\s+the\s+soil.*$/i, '');
    return `${subject} require ${stripLeadingArticle(requireNoSubjectMatch[1])} for ${purpose}`;
  }

  if (/\bmicroorganisms?\b|\bbacteria\b|\bfungi\b|\bearthworms?\b/i.test(clean)) {
    const terms = ['bacteria', 'fungi', 'earthworms'].filter(term => new RegExp(`\\b${term}\\b`, 'i').test(clean));
    return terms.length > 0
      ? `Soil organisms include ${terms.join(', ')}`
      : 'Soil contains living microorganisms';
  }

  const retentionMatch = clean.match(/^(.+?)\s+is\s+the\s+ability\s+of\s+(.+?)\s+to\s+(.+)$/i);
  if (retentionMatch) {
    const concept = /^this$/i.test(retentionMatch[1]) ? 'Water retention' : sentenceCase(stripLeadingArticle(retentionMatch[1]));
    return `${concept} means ${stripLeadingArticle(retentionMatch[2])} can ${stripLeadingArticle(retentionMatch[3])}`;
  }

  const simplyMeansMatch = clean.match(/^(.+?)\s+simply\s+means\s+the\s+ability\s+of\s+(.+?)\s+to\s+(.+)$/i);
  if (simplyMeansMatch) {
    const concept = sentenceCase(stripLeadingArticle(simplyMeansMatch[1]));
    const subject = stripLeadingArticle(simplyMeansMatch[2]);
    const action = stripLeadingArticle(simplyMeansMatch[3])
      .replace(/\s+downwards?\s+the\s+bottom\s+layers?.*$/i, ' downward through soil')
      .replace(/\s+through\s+a\s+soil\s+sample.*$/i, ' through soil');
    return `${concept} means ${subject} can ${action}`;
  }

  if (/^good drainage prevents water logging/i.test(clean)) {
    return 'Good drainage prevents water logging and root rot';
  }

  if (/^poor drainage.*causes roots to suffocate/i.test(clean)) {
    return 'Poor drainage causes roots to suffocate from low oxygen';
  }

  if (/^soil samples with very good drainage/i.test(clean) && /\bsand soil\b/i.test(clean)) {
    return 'Sand soil has very good drainage';
  }

  if (/^clay soil has poor drainage/i.test(clean)) {
    return 'Clay soil can get waterlogged and suffocate roots';
  }

  if (/^well-structured soil crumbs/i.test(clean)) {
    return 'Well-structured soil crumbs help air and water move';
  }

  if (/^the structure of the soil particles/i.test(clean) || /^crumb structure/i.test(clean)) {
    return 'Crumb structure shows small rounded soil aggregates';
  }

  if (/^particle size simply refers/i.test(clean)) {
    return 'Particle size means the size of individual soil grains';
  }

  if (/^sand soil has the largest particle size/i.test(clean)) {
    return 'Sand has large particles; clay has very fine particles';
  }

  if (/retaining water.*photosynthesis.*germination/i.test(clean)) {
    return 'Retained water supports photosynthesis and germination';
  }

  if (/clay.*highest water retention/i.test(clean)) {
    return 'Clay soil has high water retention';
  }

  if (/sandstone.*highest drainage.*not retain water/i.test(clean)) {
    return 'Sandstone drains fast and retains little water';
  }

  const genericPoint = genericLockedAudioBodyPoint(clean);
  if (genericPoint && (!hasLongSharedPhrase(clean, audioText) || wordCount(genericPoint) <= 20)) return genericPoint;
  if (!hasLongSharedPhrase(clean, audioText)) return safeCompleteBodyPoint(clean);
  return genericPoint;
}

function conciseBodyPointsFromAudio(audio?: unknown): string[] {
  const audioText = cleanList(audio).join(' ');
  if (!audioText.trim()) return [];

  const rawUnits = audioText
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|;\s+|,\s+(?:while|whereas|but|and|so|which|that)\s+/i)
    .map(cleanLockedAudioBodyCandidate)
    .filter(unit => !isNarrationOnlyBodyCandidate(unit))
    .filter(unit => wordCount(unit) >= 4);

  const points: string[] = [];
  const used = new Set<string>();
  const addPoint = (point: string) => {
    const key = bodyPointKey(point);
    if (!key || used.has(key)) return;
    if (isWeakSummaryBodyPoint(point, audioText)) return;
    if (wordCount(point) > 20) return;
    if (!bodyPointGroundedInAudio(point, audioText)) return;
    points.push(point);
    used.add(key);
  };

  seededLockedAudioBodyPoints(audioText).forEach(addPoint);

  for (const unit of rawUnits.flatMap(value => splitCompleteBodyPoint(value))) {
    const point = rephraseLockedAudioBodyPoint(unit, audioText);
    addPoint(point);
    if (points.length >= targetSummaryPointCount(audioText)) break;
  }

  return points;
}

interface LockedBodyPointOptions {
  preferExisting?: boolean;
  detailMode?: boolean;
}

function lockedAudioBodyPoints(points: unknown, audio?: unknown, options: LockedBodyPointOptions = {}): string[] {
  const audioText = cleanList(audio).join(' ');
  if (exactAudioShouldSkipBody(audioText)) return [];
  const audioWords = wordCount(audioText);
  const originalPoints = normalizeBodyPoints(points)
    .map(point => {
      const clean = cleanLockedAudioBodyCandidate(point);
      if (options.detailMode) {
        const preserved = safeCompleteBodyPoint(clean);
        if (preserved) return preserved;
      }
      return rephraseLockedAudioBodyPoint(point, audioText);
    })
    .filter(point => !isNarrationOnlyBodyCandidate(point))
    .filter(point => !isIncompleteBodyPoint(point))
    .filter(point => wordCount(point) <= 20)
    .filter(point => options.detailMode
      ? bodyPointStrictlyMatchesAudio(point, audioText)
      : bodyPointGroundedInAudio(point, audioText, 0.7));
  const derivedPoints = conciseBodyPointsFromAudio(audio);
  const minimumCount = options.detailMode
    ? audioWords >= 160 ? 8 : audioWords >= 110 ? 6 : audioWords >= 70 ? 4 : audioWords >= 35 ? 3 : 2
    : audioWords >= 110 ? 4 : audioWords >= 70 ? 3 : 2;
  const targetCount = Math.min(targetSummaryPointCount(audioText), Math.max(minimumCount, derivedPoints.length, originalPoints.length));

  const output: string[] = [];
  const used = new Set<string>();
  const addPoint = (point: string) => {
    const clean = cleanLockedAudioBodyCandidate(point);
    const key = bodyPointKey(clean);
    if (
      !key ||
      used.has(key) ||
      wordCount(clean) > 20 ||
      isWeakSummaryBodyPoint(clean, audioText) ||
      (!options.detailMode && bodyPointTooVerbatim(clean, audioText))
    ) return;
    if (output.some(existing => bodyPointsSimilar(existing, clean))) return;
    output.push(clean);
    used.add(key);
  };

  const orderedSources = options.preferExisting
    ? [originalPoints, derivedPoints]
    : [derivedPoints, originalPoints];
  orderedSources.forEach(source => source.forEach(addPoint));

  const finalPoints = output.slice(0, targetCount);
  return options.detailMode
    ? enforceDetailedBodyPoints(finalPoints, audioText, targetCount)
    : finalPoints;
}

function formatLockedAudioBodyText(points?: unknown, audio?: unknown): string {
  return lockedAudioBodyPoints(points, audio).map((point, index) => `${index + 1}. ${point}`).join('\n');
}

function normalizeBodyTextInScript(script: string): string {
  const lines = script.split('\n');
  const output: string[] = [];
  let inBodyText = false;
  let bodyPoints: string[] = [];

  const flushBodyPoints = () => {
    if (bodyPoints.length === 0) return;
    normalizeBodyPoints(bodyPoints).forEach((point, index) => {
      output.push(`${index + 1}. ${point}`);
    });
    bodyPoints = [];
  };

  const isNextSection = (line: string) => isVisualizationBoundaryLine(line);

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^Body Text:\s*$/i.test(trimmed)) {
      if (inBodyText) flushBodyPoints();
      output.push(line);
      inBodyText = true;
      continue;
    }

    if (inBodyText) {
      if (!trimmed) {
        flushBodyPoints();
        output.push(line);
        inBodyText = false;
        continue;
      }

      if (isNextSection(trimmed)) {
        flushBodyPoints();
        output.push(line);
        inBodyText = false;
        continue;
      }

      const bodyPoint = cleanBodyClause(trimmed.replace(/^\d+[.)]\s*/, ''));
      if (bodyPoint) bodyPoints.push(bodyPoint);
      continue;
    }

    output.push(line);
  }

  if (inBodyText) flushBodyPoints();
  return output.join('\n');
}

function removeStandaloneThankYouScreen(script: string): string {
  if (!script.includes('<<<ROW>>>')) return script;

  const rows = script.split('<<<ROW>>>').map(row => row.trim()).filter(Boolean);
  if (rows.length < 2) return script;

  const lastRow = rows[rows.length - 1];
  const hasSummaryBeforeLast = rows.slice(0, -1).some(row => /\tSummary\t/i.test(row));
  const isStandaloneThankYou =
    hasSummaryBeforeLast &&
    /\tWide\t/i.test(lastRow) &&
    /thank you/i.test(lastRow) &&
    !/\tSummary\t/i.test(lastRow);

  if (!isStandaloneThankYou) return script;
  return rows.slice(0, -1).join('\n<<<ROW>>>\n');
}

function removeImagePromptSections(script: string): string {
  const lines = script.split('\n');
  const output: string[] = [];
  let inImageSection = false;

  const imageSectionHeader = /^(?:📌\s*)?Image Suggestions?:?\s*$/i;
  const imagePromptLine = /^(?:Image\s*\d*\s*:|AI Image Prompt\s*\d*\s*:|GIF\s*\d*\s*:|(?:SEARCH|PROMPT|URL)\s*:|https?:\/\/)/i;
  const sectionStart = /^(?:<<<ROW>>>|Video Details|Notes to Video Editor|Frame-by-Frame Script|Audio Cues\tFrame|Null Screen Header|Title Text|Body Text|Visual\/Animation Instructions|Audio\/Animation Cues|FONT AND COLOURS:|FRAME TYPES:)/i;

  for (const line of lines) {
    const trimmed = line.trim();

    if (inImageSection) {
      if (sectionStart.test(trimmed)) {
        inImageSection = false;
        output.push(line);
      }
      continue;
    }

    if (imageSectionHeader.test(trimmed) || imagePromptLine.test(trimmed)) {
      inImageSection = true;
      continue;
    }

    output.push(line);
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function finalizeScript(script: string, options: {
  normalizeBody?: boolean;
  enrichImages?: boolean;
} = {}): Promise<string> {
  const shouldNormalizeBody = options.normalizeBody ?? true;
  const bodyNormalized = shouldNormalizeBody ? normalizeBodyTextInScript(script) : script;
  const formattingNormalized = normalizeScriptFormatting(bodyNormalized);
  const sampleEnding = removeStandaloneThankYouScreen(formattingNormalized);
  return removeImagePromptSections(sampleEnding);
}

function summaryAudioWithThankYou(summaryAudio: unknown, thankYou?: string): string[] {
  const cues = cleanList(summaryAudio);
  if (cues.some(cue => /thank\s+you/i.test(cue))) return cues;
  const finalCue = thankYou && /thank\s+you/i.test(thankYou) ? thankYou : 'Thank you!';
  return [...cues, finalCue];
}

function assembleScript(ai: AIOutput, meta: {
  subject: string; chapter: string; topic: string;
  videoTitle: string; teacher: string; learningObjective: string; audience: string;
  preserveAudioCues?: boolean;
}): string {
  const lines: string[] = [];
  const T = '\t';

  // Header
  lines.push('Video Script');
  lines.push(`${meta.videoTitle} | ${meta.audience.split('(')[0].trim()} ${meta.subject}`);

  // Video Details
  lines.push('Video Details');
  lines.push(`Subject${T}${meta.subject}`);
  lines.push(`Chapter${T}${meta.chapter}`);
  lines.push(`Topic${T}${meta.topic}`);
  lines.push(`Video Title${T}${meta.videoTitle}`);
  lines.push(`Alpha Channel Link${T}`);
  lines.push(`Learning Objective${T}${meta.learningObjective}`);
  lines.push(`Number of MCQ${T}`);

  // Notes to Video Editor
  lines.push('Notes to Video Editor');
  lines.push('FONT AND COLOURS:');
  lines.push('• Video Title name – Font: Noto Sans – 36 – Bold - Italics | Subject – 28 – Noto Sans – No Bold');
  lines.push('• Noto Sans Medium for content, Bold for headings, Italic for important words');
  lines.push('• Title: Dark Grey (#303030) | Body text: Light Grey (#474747) | Important words: Blue (#3E7BBF)');
  lines.push('• Font size – Title: 50 | Body text: 35 | All text left-aligned');
  lines.push('');
  lines.push('FRAME TYPES:');
  lines.push('• Intro Screen – PicEd Logo and bg music');
  lines.push('• Title Screen – Video Title name and Subject');
  lines.push('• Wide – Only teacher visible in centre of frame');
  lines.push('• Wide with Image – Teacher with image and text');
  lines.push('• Null – Only screen visible');
  lines.push('• Summary – Teacher with image on LHS');
  lines.push('• Outro Screen – PicEd Logo and bg music');

  // Frame-by-Frame Script header
  lines.push('Frame-by-Frame Script');
  lines.push(`Audio Cues${T}Frame${T}Visualization Comments / Text on Screen`);

  // Use a row separator that won't appear in content
  const ROW_SEP = '\n<<<ROW>>>\n';

  // SCREEN 1: Title Screen
  lines.push(`${T}Title Screen${T}Title Text:\n${meta.videoTitle}  ${meta.subject}\n\nAudio/Animation Cues:\nShow title and subject name`);
  lines.push(ROW_SEP);

  // SCREEN 2: Wide — curiosity + teacher intro (same screen, no board)
  const openingAudio = meta.preserveAudioCues
    ? cleanList([ai.curiosityQuestion]).map((audio, index) => `${index + 1}. ${audio}`).join('\n')
    : `1. ${ai.curiosityQuestion} Hello learners,\n2. My name is ${meta.teacher}, your teacher for ${meta.subject.toLowerCase()}.`;
  lines.push(`${openingAudio}${T}Wide${T}Audio/Animation Cues:\n1. Show teacher in center\n2. Show teacher name and subject`);
  lines.push(ROW_SEP);

  // SCREEN 3: Previously (separate screen)
  const previousAudio = meta.preserveAudioCues
    ? cleanList([ai.previousTopic]).map((audio, index) => `${index + 1}. ${audio}`).join('\n')
    : `1. Previously, we looked at ${ai.previousTopic}.`;
  lines.push(`${previousAudio}${T}Wide with Image${T}Null Screen Header:\nPreviously\n\nBody Text:\n${formatBodyText([`Previously learned: ${meta.preserveAudioCues ? meta.topic : ai.previousTopic} as background for today's lesson`, `Connect earlier learning to today's ${meta.topic} lesson`])}\n\nAudio/Animation Cues:\n1. Show OST with a relevant previous-topic visual`);
  lines.push(ROW_SEP);

  // SCREEN 4: Today (separate screen)
  const todayAudio = cleanList([ai.todayIntro]).map((audio, index) => `${index + 1}. ${audio}`).join('\n');
  lines.push(`${todayAudio}${T}Wide with Image${T}Null Screen Header:\nToday\n\nBody Text:\n${formatBodyText([`Today's topic: ${meta.topic} and its key concepts in this lesson`, `Focus on the key ideas and examples in this lesson`])}\n\nAudio/Animation Cues:\n1. Show OST with the topic title and a clean concept visual`);
  lines.push(ROW_SEP);

  // SCREENS 5-N: Teaching frames
  const teachingFrames = Array.isArray(ai.frames) ? ai.frames : [];
  for (const frame of teachingFrames) {
    const audioCues = cleanList(frame.audio).map((a, i) => `${i + 1}. ${a}`).join('\n');
    
    let viz = '';
    if (frame.header) viz += `Null Screen Header:\n${frame.header}\n\n`;
    const bodyPoints = meta.preserveAudioCues
      ? lockedAudioBodyPoints(frame.body, frame.audio)
      : detailedBodyPoints(frame.body, frame.audio);
    const bodyText = meta.preserveAudioCues
      ? formatLockedAudioBodyText(frame.body, frame.audio)
      : formatDetailedBodyText(frame.body, frame.audio);
    if (bodyText) {
      viz += 'Body Text:\n';
      viz += bodyText;
      viz += '\n\n';
    }
    const visualInstructions = completeVisualInstructionsForBody(
      cleanList(frame.visual),
      cleanList(frame.audio).join(' '),
      bodyPoints
    );
    if (visualInstructions.length > 0) {
      viz += 'Visual/Animation Instructions:\n';
      viz += visualInstructions.map((v, i) => `${i + 1}. ${v}`).join('\n');
      viz += '\n\n';
    }
    lines.push(`${audioCues}${T}${frame.frame || 'Wide with Image'}${T}${viz.trim()}`);
    lines.push(ROW_SEP);
  }

  // SUMMARY screen
  const summaryAudioSource = meta.preserveAudioCues ? cleanList(ai.summaryAudio) : summaryAudioWithThankYou(ai.summaryAudio, ai.thankYou);
  const summaryAudio = summaryAudioSource.map((a, i) => `${i + 1}. ${a}`).join('\n');
  const summaryVisualLines = ['Visual/Animation Instructions:', '1. Bring teacher to centre of frame.'];
  cleanList(ai.summaryLabels).slice(0, 3).forEach((label, i) => {
    summaryVisualLines.push(`${i + 2}. Highlight summary label- ${label}`);
  });
  lines.push(`${summaryAudio}${T}Summary${T}${summaryVisualLines.join('\n')}`);

  return lines.join('\n');
}

function cleanModelScriptText(raw: string): string {
  return raw
    .replace(/```(?:text|json)?\s*/gi, '')
    .replace(/```\s*/gi, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function extractFirstJsonObject(raw: string): string {
  const text = cleanModelScriptText(raw);
  const start = text.indexOf('{');
  if (start < 0) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return '';
}

const REFINE_FIELD_LABELS: Record<RefineField, string> = {
  audioCues: 'Audio Cues',
  frameType: 'Frame column',
  header: 'Null Screen Header / Title Text',
  bodyText: 'Body Text',
  visualInstructions: 'Visual/Animation Instructions',
  imagePrompts: 'Image prompt notes',
};

function fieldInstruction(scope?: RefineScope): string {
  const fields = scope?.fields || [];
  if (fields.length === 0) return 'No specific fields were selected. Make only the smallest necessary edit requested by the user.';

  const selected = fields.map(field => REFINE_FIELD_LABELS[field]).join(', ');
  const blocked = (Object.keys(REFINE_FIELD_LABELS) as RefineField[])
    .filter(field => !fields.includes(field))
    .map(field => REFINE_FIELD_LABELS[field])
    .join(', ');

  return `Selected editable fields: ${selected}.
Do not change these unselected fields: ${blocked || 'none'}.`;
}

function shouldRefineBlock(blockIndex: number, scope?: RefineScope): boolean {
  const indexes = scope?.frameIndexes;
  return !indexes || indexes.length === 0 || indexes.includes(blockIndex);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error && 'message' in error) {
    return String((error as { message?: unknown }).message || '');
  }
  return String(error || '');
}

function isRateLimitError(error: unknown): boolean {
  const status = typeof error === 'object' && error && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : 0;
  return status === 429 || /rate[_ -]?limit|tokens per day|\bTPD\b/i.test(errorMessage(error));
}

function isRequestTooLargeError(error: unknown): boolean {
  const status = typeof error === 'object' && error && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : 0;
  return status === 413 || /request too large|tokens per minute|\bTPM\b/i.test(errorMessage(error));
}

export interface FinalScriptImagePromptOptions {
  topic?: string;
  subject?: string;
  targetAudience?: string;
  sampleScriptReference?: string;
}

interface FinalScriptPromptFrame {
  screenNumber: number;
  frameType: string;
  heading: string;
  text: string;
}

interface FinalScriptPromptBatchResult {
  screens?: Array<{
    screenNumber?: number | string;
    prompts?: unknown;
  }>;
}

async function requestGroqText(
  prompt: string,
  maxCompletionTokens: number,
  temperature = 0.25,
  tooLargeMessage = 'Groq request is too large. Please upload a shorter script or generate prompts for fewer screens.',
  preferRefineKey = false
): Promise<string> {
  if (!isGroqInitialized()) throw new Error('Groq client not initialized.');
  const clients = preferRefineKey && refineGroqClients.length > 0 ? refineGroqClients : groqClients;
  const activeIndex = preferRefineKey && refineGroqClients.length > 0 ? activeRefineGroqClientIndex : activeGroqClientIndex;
  const setActiveClient = preferRefineKey && refineGroqClients.length > 0 ? setActiveRefineGroqClient : setActiveGroqClient;
  const requestText = async (client: Groq, tokens: number): Promise<string> => {
    const c = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_completion_tokens: tokens,
    });
    return c.choices[0]?.message?.content || '';
  };

  let lastLimitError: unknown = null;
  const totalClients = clients.length;
  for (let offset = 0; offset < totalClients; offset += 1) {
    const clientIndex = (activeIndex + offset) % totalClients;
    const client = clients[clientIndex];

    try {
      const text = await requestText(client, maxCompletionTokens);
      setActiveClient(clientIndex);
      return text;
    } catch (error) {
      if (!isRateLimitError(error) && !isRequestTooLargeError(error)) throw error;
      lastLimitError = error;

      if (isRequestTooLargeError(error)) {
        try {
          const retryTokens = Math.min(1800, Math.max(900, Math.floor(maxCompletionTokens / 2)));
          const text = await requestText(client, retryTokens);
          setActiveClient(clientIndex);
          return text;
        } catch (retryError) {
          if (!isRateLimitError(retryError) && !isRequestTooLargeError(retryError)) throw retryError;
          lastLimitError = retryError;
        }
      }
    }
  }

  if (lastLimitError && isRequestTooLargeError(lastLimitError)) throw new Error(tooLargeMessage);
  if (lastLimitError && isRateLimitError(lastLimitError)) {
    throw new Error(totalClients > 1
      ? 'All connected Groq API keys have reached their token/rate limit. Please wait for reset or add another key.'
      : 'Groq token limit is almost used. Please wait for the reset, or add another API key.');
  }
  throw new Error('Groq request failed. Please try again.');
}

function headingFromVisualization(visualization: string): string {
  const lines = visualization.split('\n').map(line => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    if (/^(Null Screen Header|Title Text):?$/i.test(lines[index])) return lines[index + 1] || '';
  }
  const bodyIndex = lines.findIndex(line => /^Body Text:?$/i.test(line));
  if (bodyIndex >= 0) return (lines[bodyIndex + 1] || '').replace(/^\d+[.)]\s*/, '').trim();
  return '';
}

function promptTextForFrame(frame: FrameRow, screenNumber: number): FinalScriptPromptFrame {
  const heading = headingFromVisualization(frame.visualization);
  const text = [
    `SCREEN ${screenNumber}`,
    `Frame: ${frame.frameType || 'Unspecified'}`,
    heading ? `Header: ${heading}` : '',
    'Audio Cues:',
    frame.audioCues || 'N/A',
    'Visualization / Text on Screen:',
    frame.visualization || 'N/A',
  ].filter(Boolean).join('\n');

  return {
    screenNumber,
    frameType: frame.frameType || 'Unspecified',
    heading,
    text: compactPromptText(text, 2600),
  };
}

function fallbackPromptFrames(finalScript: string): FinalScriptPromptFrame[] {
  const clean = finalScript.replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];

  const chunks: string[] = [];
  const paragraphs = clean.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > 2600) {
      chunks.push(current.trim());
      current = '';
    }
    current += `${current ? '\n\n' : ''}${paragraph}`;
  }
  if (current.trim()) chunks.push(current.trim());

  return (chunks.length ? chunks : [compactPromptText(clean, 2600)]).map((text, index) => ({
    screenNumber: index + 1,
    frameType: 'Final Script Section',
    heading: '',
    text: `SCREEN ${index + 1}\nFrame: Final Script Section\n${text}`,
  }));
}

function imagePromptParseMeta(options: FinalScriptImagePromptOptions) {
  return {
    videoTitle: options.topic || 'Final Script',
    subject: options.subject || 'Educational',
    chapter: '',
    topic: options.topic || 'Final Script',
    learningObjective: '',
  };
}

function isLooseFrameTypeLine(line: string): string | null {
  const trimmed = line.replace(/\s+/g, ' ').trim();
  const match = trimmed.match(/^(?:Screen\s*\d+\s*[-:.)]?\s*)?(Title Screen|Wide with Image|Wide|Null|Summary|Intro Screen|Outro Screen)$/i);
  if (!match) return null;
  const value = match[1].toLowerCase();
  if (value === 'title screen') return 'Title Screen';
  if (value === 'wide with image') return 'Wide with Image';
  if (value === 'wide') return 'Wide';
  if (value === 'null') return 'Null';
  if (value === 'summary') return 'Summary';
  if (value === 'intro screen') return 'Intro Screen';
  if (value === 'outro screen') return 'Outro Screen';
  return match[1];
}

function isVisualizationSectionLine(line: string): boolean {
  return /^(Null Screen Header|Title Text|Body Text|Visual\/Animation Instructions|Audio\/Animation Cues|Image Suggestions?):?\s*$/i.test(line.trim());
}

function isVisualizationContinuationLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    isVisualizationSectionLine(trimmed) ||
    /^(?:AI\s*)?Image\s*Prompt\s*\d*\s*:|^Image\s*\d*\s*:|^GIF\s*\d*\s*:|^(?:SEARCH|PROMPT|URL)\s*:|^https?:\/\//i.test(trimmed)
  );
}

function splitLooseVisualizationAndNextAudio(region: string[], hasNextFrame: boolean): {
  visualization: string[];
  nextAudio: string[];
} {
  if (!hasNextFrame) {
    return { visualization: region, nextAudio: [] };
  }

  let seenVisualizationSection = false;
  let seenAnimationSection = false;
  let previousWasBlank = false;

  for (let index = 0; index < region.length; index += 1) {
    const line = region[index];
    const trimmed = line.trim();

    if (!trimmed) {
      previousWasBlank = true;
      continue;
    }

    if (isVisualizationSectionLine(trimmed)) {
      seenVisualizationSection = true;
      if (/^(Visual\/Animation Instructions|Audio\/Animation Cues):?\s*$/i.test(trimmed)) {
        seenAnimationSection = true;
      }
      previousWasBlank = false;
      continue;
    }

    if (
      seenVisualizationSection &&
      seenAnimationSection &&
      previousWasBlank &&
      !isVisualizationContinuationLine(trimmed)
    ) {
      return {
        visualization: region.slice(0, index),
        nextAudio: region.slice(index),
      };
    }

    previousWasBlank = false;
  }

  return { visualization: region, nextAudio: [] };
}

function looseMetadataValue(raw: string, label: string, fallback = ''): string {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sameLine = raw.match(new RegExp(`^${escapedLabel}\\s*[\\t:]\\s*(.+)$`, 'im'));
  if (sameLine?.[1]?.trim()) return sameLine[1].trim();

  const lines = raw.split('\n').map(line => line.trim());
  const labelIndex = lines.findIndex(line => new RegExp(`^${escapedLabel}:?$`, 'i').test(line));
  if (labelIndex < 0) return fallback;

  const stopLabels = /^(Subject|Chapter|Topic|Video Title|Alpha Channel Link|Learning Objective|Number of MCQ|Notes to Video Editor|Frame-by-Frame Script|Audio Cues|Frame|Visualization Comments)/i;
  for (let index = labelIndex + 1; index < lines.length; index += 1) {
    const value = lines[index];
    if (!value) continue;
    if (stopLabels.test(value)) return fallback;
    return value;
  }

  return fallback;
}

function parseFlattenedPicEdScript(raw: string, options: FinalScriptImagePromptOptions): ScriptData {
  const meta = imagePromptParseMeta(options);
  const frameTableMatch = raw.match(/Frame-by-Frame Script[\s\S]*$/i) || raw.match(/Audio Cues\s*\n\s*Frame\s*\n\s*Visualization Comments[\s\S]*$/i);
  if (!frameTableMatch) {
    return { ...parseRawScript('', meta), rawText: raw };
  }

  const tableLines = frameTableMatch[0]
    .split('\n')
    .map(line => line.replace(/\r/g, '').trimEnd());
  const bodyStart = tableLines.findIndex(line => /Visualization Comments/i.test(line));
  const lines = tableLines
    .slice(bodyStart >= 0 ? bodyStart + 1 : 1)
    .filter(line => !/^\s*(Frame-by-Frame Script|Audio Cues|Frame|Visualization Comments \/ Text on Screen)\s*$/i.test(line));

  const frameIndexes: Array<{ index: number; frameType: string }> = [];
  lines.forEach((line, index) => {
    const frameType = isLooseFrameTypeLine(line);
    if (frameType) frameIndexes.push({ index, frameType });
  });

  if (frameIndexes.length === 0) {
    return { ...parseRawScript('', meta), rawText: raw };
  }

  const frames: FrameRow[] = [];
  let pendingAudio = lines.slice(0, frameIndexes[0].index);

  for (let index = 0; index < frameIndexes.length; index += 1) {
    const current = frameIndexes[index];
    const next = frameIndexes[index + 1];
    const region = lines.slice(current.index + 1, next ? next.index : lines.length);
    const split = splitLooseVisualizationAndNextAudio(region, Boolean(next));
    const audioCues = pendingAudio.map(line => line.trim()).filter(Boolean).join('\n').trim();
    const visualization = split.visualization.map(line => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();

    if (audioCues || visualization) {
      frames.push({
        audioCues: audioCues || 'Add the transcript for this frame here',
        frameType: current.frameType,
        visualization,
      });
    }

    pendingAudio = split.nextAudio;
  }

  const notesMatch = raw.match(/Notes to Video Editor[\s\S]*?(?=Frame-by-Frame Script|$)/i);
  const parsedFallback = parseRawScript('', meta);
  const topic = looseMetadataValue(raw, 'Topic', options.topic || meta.topic);
  const videoTitle = looseMetadataValue(raw, 'Video Title', topic || meta.videoTitle);

  return {
    videoTitle,
    subject: looseMetadataValue(raw, 'Subject', options.subject || meta.subject),
    chapter: looseMetadataValue(raw, 'Chapter', meta.chapter),
    topic,
    alphaChannelLink: looseMetadataValue(raw, 'Alpha Channel Link', ''),
    learningObjective: looseMetadataValue(raw, 'Learning Objective', meta.learningObjective),
    numberOfMCQ: looseMetadataValue(raw, 'Number of MCQ', ''),
    editorNotes: notesMatch
      ? notesMatch[0].replace(/.*Notes to Video Editor\s*/i, '').trim()
      : parsedFallback.editorNotes,
    frames,
    rawText: raw,
  };
}

function fallbackScriptDataFromText(raw: string, options: FinalScriptImagePromptOptions): ScriptData {
  const meta = imagePromptParseMeta(options);
  const fallbackFrames = fallbackPromptFrames(raw);
  const parsedFallback = parseRawScript('', meta);

  return {
    videoTitle: looseMetadataValue(raw, 'Video Title', options.topic || meta.videoTitle),
    subject: looseMetadataValue(raw, 'Subject', options.subject || meta.subject),
    chapter: looseMetadataValue(raw, 'Chapter', meta.chapter),
    topic: looseMetadataValue(raw, 'Topic', options.topic || meta.topic),
    alphaChannelLink: looseMetadataValue(raw, 'Alpha Channel Link', ''),
    learningObjective: looseMetadataValue(raw, 'Learning Objective', meta.learningObjective),
    numberOfMCQ: looseMetadataValue(raw, 'Number of MCQ', ''),
    editorNotes: parsedFallback.editorNotes,
    frames: fallbackFrames.map(frame => ({
      audioCues: frame.text.replace(/^SCREEN\s+\d+\s*\nFrame:\s*Final Script Section\s*/i, '').trim(),
      frameType: 'Wide with Image',
      visualization: 'Audio/Animation Cues:\nUse this uploaded final script section for visual planning.',
    })),
    rawText: raw,
  };
}

function parseFinalScriptForImagePrompts(finalScript: string, options: FinalScriptImagePromptOptions): ScriptData {
  const meta = imagePromptParseMeta(options);
  const parsed = parseRawScript(finalScript, meta);
  if (parsed.frames.length > 0) return parsed;

  const loose = parseFlattenedPicEdScript(finalScript, options);
  if (loose.frames.length > 0) return loose;

  return fallbackScriptDataFromText(finalScript, options);
}

function finalScriptPromptFrames(finalScript: string, options: FinalScriptImagePromptOptions): FinalScriptPromptFrame[] {
  const parsed = parseFinalScriptForImagePrompts(finalScript, options);

  if (parsed.frames.length > 0) {
    return parsed.frames.map((frame, index) => promptTextForFrame(frame, index + 1));
  }

  return fallbackPromptFrames(finalScript);
}

function batchPromptFrames(frames: FinalScriptPromptFrame[], maxChars = 6200, maxFrames = 4): FinalScriptPromptFrame[][] {
  const batches: FinalScriptPromptFrame[][] = [];
  let current: FinalScriptPromptFrame[] = [];
  let currentChars = 0;

  for (const frame of frames) {
    const nextChars = frame.text.length;
    if (current.length > 0 && (current.length >= maxFrames || currentChars + nextChars > maxChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(frame);
    currentChars += nextChars;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function isTeacherOnlyFrame(frame: FrameRow): boolean {
  const frameType = frame.frameType.toLowerCase();
  const combined = `${frame.audioCues}\n${frame.visualization}`.toLowerCase();
  const visualization = frame.visualization.toLowerCase();

  if (/(^|\s)(title screen|intro screen|outro screen)(\s|$)/i.test(frame.frameType)) return true;

  const teacherOnlySignal =
    /\b(my name is|hello learners|show teacher|teacher in center|teacher name|teacher visible|your teacher)\b/i.test(combined);
  const contentSignal =
    /body text|null screen header|title text|diagram|image|chart|graph|map|illustration|model|structure|process|cycle|formula|equation|label|callout|highlight|show ost/i.test(visualization);

  return teacherOnlySignal && !contentSignal && (frameType === 'wide' || !/image|summary|null/i.test(frameType));
}

function frameNeedsImagePrompt(frame: FrameRow): boolean {
  if (isTeacherOnlyFrame(frame)) return false;

  const frameType = frame.frameType.toLowerCase();
  const combined = `${frame.audioCues}\n${frame.visualization}`.toLowerCase();
  const bodyPoints = extractBodyPointsFromVisualization(frame.visualization);
  if (bodyPoints.length > 0) return true;
  if (/wide with image|summary|null/i.test(frameType)) return true;

  return /diagram|image|chart|graph|map|illustration|model|structure|process|cycle|formula|equation|label|callout|highlight|show ost/i.test(combined);
}

function scriptConceptsForFrame(frame: FrameRow): string[] {
  const heading = headingFromVisualization(frame.visualization);
  const bodyPoints = extractBodyPointsFromVisualization(frame.visualization);
  const visualLines = frame.visualization
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^(Null Screen Header|Title Text|Body Text|Visual\/Animation Instructions|Audio\/Animation Cues|Image Suggestions?):?/i.test(line))
    .filter(line => !/^(AI Image Prompt|Image\s*\d*\s*:|No image needed|Basis:)/i.test(line))
    .map(line => line.replace(/^\d+[.)]\s*/, '').trim())
    .filter(line => !/^show teacher/i.test(line));
  const audioSentences = frame.audioCues
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(sentence => wordCount(sentence) >= 6)
    .filter(sentence => !/\b(my name is|hello learners|thank you|your teacher)\b/i.test(sentence));

  const concepts = [heading, ...bodyPoints, ...visualLines, ...audioSentences]
    .map(concept => concept.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const seen = new Set<string>();
  return concepts.filter(concept => {
    const key = bodyPointKey(concept);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

function deterministicFrameImagePrompts(
  frame: FrameRow,
  options: FinalScriptImagePromptOptions
): string[] {
  if (!frameNeedsImagePrompt(frame)) return [];

  const concepts = scriptConceptsForFrame(frame);
  if (concepts.length === 0) return [];

  const audience = options.targetAudience || 'the selected age group';
  const subject = options.subject || 'the subject';
  const conceptText = concepts.join('; ');
  return [
    `Create one age-appropriate educational visual for ${audience} based only on this screen: ${conceptText}. Use a clean ${subject} textbook-style diagram or simple instructional illustration. Show only the objects, labels, relationships, steps, or structures already named in the script. Keep labels short and accurate, with a bright uncluttered composition and clear focal area. Avoid invented people, classroom scenes, portraits, logos, watermarks, scanned pages, URLs, decorative backgrounds, and extra text not required by the script.`,
  ];
}

function promptHasInventedTeacherDetails(prompt: string): boolean {
  return /(middle-aged teacher|teacher portrait|teacher standing|teacher in|teacher with|teacher beside|teacher at|standing .*teacher|jovia|katuhaise|whiteboard|biology classroom|casual attire|friendly smile|dark brown skin|skin tone|standing in front)/i.test(prompt);
}

function ensureDetailedImagePrompt(prompt: string, options: FinalScriptImagePromptOptions): string {
  const base = prompt
    .replace(/^\s*(?:AI\s*)?Image\s*Prompt\s*\d*\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (wordCount(base) >= 70) return base;

  const audience = options.targetAudience || 'the selected age group';
  const subject = options.subject || 'the subject';
  return `${base} Use a clear age-appropriate ${subject} educational style for ${audience}, with accurate simple labels, uncluttered composition, high contrast, and a direct focus on the exact concept from this screen. Avoid invented people, unrelated props, logos, watermarks, scanned pages, URLs, and extra decorative text.`;
}

function sanitizeImagePrompts(
  prompts: unknown,
  frame: FrameRow,
  options: FinalScriptImagePromptOptions
): string[] {
  if (!frameNeedsImagePrompt(frame)) return [];

  const rawPrompts = Array.isArray(prompts)
    ? prompts.map(prompt => String(prompt || ''))
    : typeof prompts === 'string'
      ? prompts.split(/\n+/)
      : [];

  const cleaned = rawPrompts
    .map(prompt => prompt.trim())
    .filter(Boolean)
    .filter(prompt => !/^no image needed\b/i.test(prompt))
    .filter(prompt => !/^basis\b/i.test(prompt))
    .filter(prompt => !/https?:\/\//i.test(prompt))
    .filter(prompt => !promptHasInventedTeacherDetails(prompt))
    .map(prompt => ensureDetailedImagePrompt(prompt, options))
    .filter(prompt => wordCount(prompt) >= 25)
    .slice(0, 3);

  return cleaned.length > 0 ? cleaned : deterministicFrameImagePrompts(frame, options);
}

function parseImagePromptBatchResponse(
  response: string,
  data: ScriptData,
  options: FinalScriptImagePromptOptions
): Map<number, string[]> {
  const jsonText = cleanModelScriptText(response).match(/\{[\s\S]*\}/)?.[0] || '';
  const promptMap = new Map<number, string[]>();
  if (!jsonText) return promptMap;

  try {
    const parsed = JSON.parse(jsonText) as FinalScriptPromptBatchResult;
    for (const screen of Array.isArray(parsed.screens) ? parsed.screens : []) {
      const screenNumber = Number(screen.screenNumber);
      const frame = data.frames[screenNumber - 1];
      if (!Number.isFinite(screenNumber) || !frame) continue;
      promptMap.set(screenNumber, sanitizeImagePrompts(screen.prompts, frame, options));
    }
  } catch {
    return promptMap;
  }

  return promptMap;
}

function stripExistingImagePromptLines(visualization: string): string {
  const output: string[] = [];
  let inImageSection = false;
  const imageSectionHeader = /^(?:📌\s*)?Image Suggestions?:?\s*$/i;
  const imageLine = /^(?:AI\s*)?Image\s*Prompt\s*\d*\s*:|^Image\s*\d+\s*:|^GIF\s*\d*\s*:|^(?:SEARCH|PROMPT|URL)\s*:|^https?:\/\//i;
  const nextSection = /^(Null Screen Header|Title Text|Body Text|Visual\/Animation Instructions|Audio\/Animation Cues):?/i;

  for (const line of visualization.split('\n')) {
    const trimmed = line.trim();
    if (inImageSection) {
      if (nextSection.test(trimmed)) {
        inImageSection = false;
        output.push(line);
      }
      continue;
    }

    if (imageSectionHeader.test(trimmed)) {
      inImageSection = true;
      continue;
    }

    if (imageLine.test(trimmed) || /^No image needed\b/i.test(trimmed) || /^Basis\b/i.test(trimmed)) continue;
    output.push(line);
  }

  return output.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function insertImagePromptsIntoVisualization(visualization: string, prompts: string[]): string {
  const clean = stripExistingImagePromptLines(visualization);
  if (prompts.length === 0) return clean;

  const promptLines = prompts.map((prompt, index) => `AI Image Prompt ${index + 1}: ${prompt}`);
  const lines = clean.split('\n');
  const audioCueIndex = lines.findIndex(line => /^Audio\/Animation Cues:?\s*$/i.test(line.trim()));

  if (audioCueIndex < 0) {
    return `${clean}${clean ? '\n\n' : ''}Audio/Animation Cues:\n${promptLines.join('\n')}`.trim();
  }

  let insertAt = audioCueIndex + 1;
  while (insertAt < lines.length) {
    const trimmed = lines[insertAt].trim();
    if (!trimmed) break;
    if (/^(Null Screen Header|Title Text|Body Text|Visual\/Animation Instructions|Audio\/Animation Cues|Image Suggestions?):?/i.test(trimmed)) break;
    insertAt += 1;
  }

  lines.splice(insertAt, 0, ...promptLines);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function scriptDetailValue(data: ScriptData, label: string, fallback = ''): string {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = data.rawText.match(new RegExp(`^${escapedLabel}\\s*[\\t:]\\s*(.*)$`, 'im'));
  return (match?.[1] || fallback || '').trim();
}

function composeFinalScriptWithImagePrompts(data: ScriptData, promptMap: Map<number, string[]>): string {
  const T = '\t';
  const rows = data.frames.map((frame, index) => {
    const prompts = promptMap.get(index + 1) || [];
    const visualization = insertImagePromptsIntoVisualization(frame.visualization, prompts);
    return `${frame.audioCues.trim()}${T}${frame.frameType.trim()}${T}${visualization}`;
  });

  return [
    'Video Script',
    `${data.videoTitle || data.topic || 'Final Script'} | ${data.subject || 'Educational'}`,
    'Video Details',
    `Subject${T}${data.subject || ''}`,
    `Chapter${T}${data.chapter || ''}`,
    `Topic${T}${data.topic || ''}`,
    `Video Title${T}${data.videoTitle || ''}`,
    `Alpha Channel Link${T}${scriptDetailValue(data, 'Alpha Channel Link', data.alphaChannelLink)}`,
    `Learning Objective${T}${data.learningObjective || ''}`,
    `Number of MCQ${T}${scriptDetailValue(data, 'Number of MCQ', data.numberOfMCQ)}`,
    'Notes to Video Editor',
    data.editorNotes || '',
    'Frame-by-Frame Script',
    `Audio Cues${T}Frame${T}Visualization Comments / Text on Screen`,
    rows.join('\n<<<ROW>>>\n'),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildImagePromptSuggestionPrompt(
  frames: FinalScriptPromptFrame[],
  options: FinalScriptImagePromptOptions,
  totalScreens: number
): string {
  const audience = options.targetAudience || 'the learners described by the script';
  const topicLine = options.topic ? `Topic: ${options.topic}` : 'Topic: infer from the uploaded final script';
  const subjectLine = options.subject ? `Subject: ${options.subject}` : 'Subject: infer from the uploaded final script';
  const sampleFormat = compactPromptText(options.sampleScriptReference || '', 3200);
  const screenText = frames.map(frame => frame.text).join('\n\n---\n\n');

  return `You are an educational visual prompt specialist for AI image generation.

Read the final human-edited script text carefully. Return ONLY valid JSON. Do not rewrite the script text.

${topicLine}
${subjectLine}
Audience: ${audience}
Whole script screen count: ${totalScreens}
Screens in this batch: ${frames.map(frame => `Screen ${frame.screenNumber}`).join(', ')}

SAMPLE PICED SCRIPT FORMAT TO MATCH:
${sampleFormat || 'Use PicEd frame format with Audio Cues, Frame, and Visualization Comments / Text on Screen columns.'}

Rules:
- Use only the uploaded script text as the source of truth: audio cues, body text, frame type, and visual/animation notes.
- For each listed screen, decide whether it needs 0, 1, 2, or 3 AI image prompts based on the teaching content.
- Do not force a prompt for title, intro, outro, teacher-only, text-only, or equation-only screens.
- Do not create teacher portraits or classroom scenes unless the script explicitly asks for that exact visual.
- Do not invent a teacher's age, skin color, clothes, expression, classroom, whiteboard, props, or background.
- Do not include image URLs, links, SEARCH:, source names, website names, or real-image references.
- Each prompt must be very detailed, around 80-120 words, and specific enough for an AI image generator.
- Each prompt must stay grounded in the screen: exact concept, age-appropriate educational style, composition, key labels or objects, visual perspective, color/clarity guidance, and what to avoid.
- Avoid scanned book pages, dictionary pages, Google Books pages, watermarks, logos, copyrighted characters, heavy text, clutter, and irrelevant decorative scenes.
- For biology/anatomy/medical content, keep visuals clean, educational, non-gory, and age appropriate.
- Return every listed screen number, even when prompts is an empty array.

Return ONLY this JSON shape:
{
  "screens": [
    { "screenNumber": 1, "prompts": [] },
    { "screenNumber": 2, "prompts": ["detailed grounded prompt"] }
  ]
}

FINAL SCRIPT SCREENS:
${screenText}`;
}

export async function suggestImagePromptsForFinalScript(
  finalScript: string,
  options: FinalScriptImagePromptOptions = {}
): Promise<string> {
  if (!isGroqInitialized()) throw new Error('Groq client not initialized.');
  const data = parseFinalScriptForImagePrompts(finalScript, options);

  const frames = finalScriptPromptFrames(finalScript, options);
  if (frames.length === 0) throw new Error('Please upload or paste a final script first.');

  const promptMap = new Map<number, string[]>();
  for (const batch of batchPromptFrames(frames)) {
    const prompt = buildImagePromptSuggestionPrompt(batch, options, frames.length);
    const response = await requestGroqText(
      prompt,
      groqCompletionBudget(prompt, 5200, 2200),
      0.25,
      'Groq request is too large for this final script. Please split the final script into fewer screens and try again.'
    );
    const batchMap = parseImagePromptBatchResponse(response, data, options);
    for (const frame of batch) {
      const row = data.frames[frame.screenNumber - 1];
      if (!row) continue;
      promptMap.set(
        frame.screenNumber,
        batchMap.has(frame.screenNumber)
          ? batchMap.get(frame.screenNumber) || []
          : deterministicFrameImagePrompts(row, options)
      );
    }
  }

  data.frames.forEach((frame, index) => {
    const screenNumber = index + 1;
    if (!promptMap.has(screenNumber)) {
      promptMap.set(screenNumber, deterministicFrameImagePrompts(frame, options));
    }
  });

  return composeFinalScriptWithImagePrompts(data, promptMap);
}

function refineCompletionBudget(block: string): number {
  const estimatedBlockTokens = Math.ceil(block.length / 4);
  return Math.min(5200, Math.max(2400, estimatedBlockTokens + 2200));
}

interface IndexedBlock {
  block: string;
  index: number;
}

interface BlockColumns {
  audio: string;
  frame: string;
  visualization: string;
}

function blockMarkerStart(index: number): string {
  return `<<<PICED_BLOCK_${index}>>>`;
}

function blockMarkerEnd(index: number): string {
  return `<<<END_PICED_BLOCK_${index}>>>`;
}

function parseBlockColumns(block: string): BlockColumns | null {
  const tableHeader = block.match(/Frame-by-Frame Script[\s\S]*?Audio Cues\tFrame\tVisualization Comments\s*\/\s*Text on Screen\s*\n/i);
  const rowText = tableHeader && typeof tableHeader.index === 'number'
    ? block.slice(tableHeader.index + tableHeader[0].length)
    : block;
  const rowLines = rowText.trim().split('\n');
  const beforeTab: string[] = [];
  const afterTab: string[] = [];
  let tabLine = '';
  let foundTab = false;

  for (const line of rowLines) {
    if (!foundTab && line.includes('\t')) {
      tabLine = line;
      foundTab = true;
    } else if (!foundTab) {
      beforeTab.push(line);
    } else {
      afterTab.push(line);
    }
  }

  if (!tabLine) return null;
  const parts = tabLine.split('\t');
  return {
    audio: [...beforeTab.filter(line => line.trim()), (parts[0] || '').trim()].filter(Boolean).join('\n').trim(),
    frame: (parts[1] || '').trim(),
    visualization: [(parts[2] || '').trim(), ...afterTab.filter(line => line.trim())].filter(Boolean).join('\n').trim(),
  };
}

function composeBlockColumns(columns: BlockColumns): string {
  return `${columns.audio.trim()}\t${columns.frame.trim()}\t${columns.visualization.trim()}`.trim();
}

function cleanVisualizationFormatting(visualization: string): string {
  const output: string[] = [];

  for (const line of visualization.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (output.length > 0 && output[output.length - 1] !== '') output.push('');
      continue;
    }

    if (isFrameOrTableBoundaryLine(trimmed)) continue;
    const cleaned = stripFormattingLeak(trimmed);
    if (!cleaned) continue;
    const inlineSection = cleaned.match(/^(Null Screen Header|Title Text|Body Text|Visual\/Animation Instructions|Audio\/Animation Cues):\s*(.+)$/i);
    if (inlineSection?.[2]?.trim()) {
      output.push(`${inlineSection[1]}:`);
      output.push(inlineSection[2].trim());
      continue;
    }
    output.push(cleaned);
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeScriptFormatting(script: string): string {
  if (!script.includes('<<<ROW>>>')) return script;

  const tableStart = script.search(/Frame-by-Frame Script[\s\S]*?Audio Cues\tFrame\tVisualization Comments\s*\/\s*Text on Screen\s*\n/i);
  const prefix = tableStart >= 0
    ? script.slice(0, tableStart).concat(script.slice(tableStart).match(/Frame-by-Frame Script[\s\S]*?Audio Cues\tFrame\tVisualization Comments\s*\/\s*Text on Screen\s*\n/i)?.[0] || '')
    : '';
  const rowsText = prefix ? script.slice(prefix.length) : script;

  const normalizedRows = rowsText
    .split('<<<ROW>>>')
    .map(block => {
      const trimmed = block.trim();
      const columns = parseBlockColumns(trimmed);
      if (!columns) return trimmed;
      return composeBlockColumns({
        ...columns,
        visualization: cleanVisualizationFormatting(columns.visualization),
      });
    })
    .filter(Boolean)
    .join('\n<<<ROW>>>\n');

  return `${prefix}${normalizedRows}`.trim();
}

function normalizeAudioColumn(audio: string): string {
  const lines = audio
    .split('\n')
    .map(line => line.replace(/^Audio Cues:\s*/i, '').trim())
    .filter(Boolean);

  return lines
    .map((line, index) => /^\d+[.)]\s+/.test(line) ? line : `${index + 1}. ${line}`)
    .join('\n');
}

function extractMisplacedAudioCues(visualization: string): { visualization: string; audio: string } {
  const output: string[] = [];
  const audio: string[] = [];
  let inAudio = false;

  for (const line of visualization.split('\n')) {
    const trimmed = line.trim();
    if (/^Audio Cues:\s*$/i.test(trimmed)) {
      inAudio = true;
      continue;
    }

    if (inAudio) {
      if (isVisualizationBoundaryLine(trimmed)) {
        inAudio = false;
        output.push(line);
      } else if (trimmed) {
        audio.push(trimmed);
      }
      continue;
    }

    output.push(line);
  }

  return {
    visualization: output.join('\n').trim(),
    audio: audio.join('\n').trim(),
  };
}

function hasVisualizationField(fields: RefineField[]): boolean {
  return fields.some(field =>
    field === 'header' ||
    field === 'bodyText' ||
    field === 'visualInstructions' ||
    field === 'imagePrompts'
  );
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function bodyPointKey(point: string): string {
  return point.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function bodyPointsSimilar(a: string, b: string): boolean {
  const aTokens = new Set(meaningfulTokens(a));
  const bTokens = meaningfulTokens(b);
  if (aTokens.size === 0 || bTokens.length === 0) return false;
  const shared = bTokens.filter(token => aTokens.has(token)).length;
  return shared / Math.max(1, Math.min(aTokens.size, bTokens.length)) >= 0.8;
}

function extractBodyPointsFromVisualization(visualization: string): string[] {
  const points: string[] = [];
  let inBody = false;

  for (const line of visualization.split('\n')) {
    const trimmed = line.trim();
    if (/^Body Text:\s*$/i.test(trimmed)) {
      inBody = true;
      continue;
    }

    if (!inBody) continue;
    if (!trimmed) continue;
    if (isVisualizationBoundaryLine(trimmed)) break;
    const point = cleanBodyClause(trimmed.replace(/^\d+[.)]\s*/, '').trim());
    if (point) points.push(point);
  }

  return normalizeBodyPoints(points);
}

function replaceBodyPointsInVisualization(visualization: string, points: string[]): string {
  const lines = visualization.split('\n');
  const output: string[] = [];
  let inBody = false;
  let replaced = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^Body Text:\s*$/i.test(trimmed)) {
      output.push(line);
      points.forEach((point, index) => output.push(`${index + 1}. ${point}`));
      inBody = true;
      replaced = true;
      continue;
    }

    if (inBody) {
      if (!trimmed) continue;
      if (isVisualizationBoundaryLine(trimmed)) {
        inBody = false;
        output.push('');
        output.push(line);
      }
      continue;
    }

    output.push(line);
  }

  return (replaced ? output : lines).join('\n').trim();
}

function replaceVisualInstructionsInVisualization(visualization: string, instructions: string[]): string {
  const lines = visualization.split('\n');
  const output: string[] = [];
  let inVisual = false;
  let replaced = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(Visual\/Animation Instructions|Audio\/Animation Cues):?\s*$/i.test(trimmed)) {
      output.push('Visual/Animation Instructions:');
      instructions.forEach((instruction, index) => output.push(`${index + 1}. ${instruction}`));
      inVisual = true;
      replaced = true;
      continue;
    }

    if (inVisual) {
      if (!trimmed) continue;
      if (isVisualizationBoundaryLine(trimmed)) {
        inVisual = false;
        output.push('');
        output.push(line);
      }
      continue;
    }

    output.push(line);
  }

  if (replaced) return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const visualSection = ['Visual/Animation Instructions:', ...instructions.map((line, index) => `${index + 1}. ${line}`)].join('\n');
  return `${visualization.trim()}${visualization.trim() ? '\n\n' : ''}${visualSection}`.trim();
}

function upsertBodyPointsInVisualization(visualization: string, points: string[]): string {
  if (points.length === 0) return visualization;
  if (/^Body Text:\s*$/im.test(visualization)) {
    return replaceBodyPointsInVisualization(visualization, points);
  }

  const bodySection = ['Body Text:', ...points.map((point, index) => `${index + 1}. ${point}`)];
  const lines = visualization.split('\n');
  const insertBefore = lines.findIndex(line =>
    /^(Visual\/Animation Instructions|Audio\/Animation Cues):?\s*$/i.test(line.trim())
  );

  if (insertBefore >= 0) {
    const output = [
      ...lines.slice(0, insertBefore),
      '',
      ...bodySection,
      '',
      ...lines.slice(insertBefore),
    ];
    return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  return `${visualization.trim()}${visualization.trim() ? '\n\n' : ''}${bodySection.join('\n')}`.trim();
}

function explicitHeaderLines(visualization: string): string[] {
  const lines = visualization.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^(Null Screen Header|Title Text):?\s*$/i.test(trimmed)) {
      const value = stripFormattingLeak(lines[index + 1] || '');
      return value ? [trimmed.replace(/\s*$/, ''), value] : [trimmed.replace(/\s*$/, '')];
    }
  }
  return [];
}

function replaceHeaderInVisualization(visualization: string, header: string): string {
  const cleanHeader = header.replace(/\s+/g, ' ').trim();
  if (!cleanHeader) return visualization;

  const lines = visualization.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!/^(Null Screen Header|Title Text):?\s*$/i.test(trimmed)) continue;

      const output = [...lines];
      const next = output[index + 1]?.trim() || '';
      if (next && !isVisualizationBoundaryLine(next)) {
        output[index + 1] = cleanHeader;
      } else {
        output.splice(index + 1, 0, cleanHeader);
      }
      return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  return `Null Screen Header:\n${cleanHeader}\n\n${visualization.trim()}`.replace(/\n{3,}/g, '\n\n').trim();
}

function heuristicVisualInstructionLines(visualization: string, audio: string, body: string[]): string[] {
  const explicit = extractVisualizationLines(visualization, 'visualInstructions')
    .map(line => stripFormattingLeak(line))
    .filter(Boolean);
  if (explicit.length > 0) return completeVisualInstructionsForBody(explicit, audio, body);

  const inferred = visualization
    .split('\n')
    .map(line => stripFormattingLeak(line.replace(/^\s*\d+[.)]\s*/, '').trim()))
    .filter(Boolean)
    .filter(line => !isVisualizationBoundaryLine(line))
    .filter(line => /\b(show|animate|label|display|illustrate|depict|highlight|callout|zoom|arrow)\b/i.test(line))
    .filter(line => !isNarrationOnlyBodyCandidate(line));

  return completeVisualInstructionsForBody(
    inferred.length > 0 ? inferred : deterministicExactVisual(audio, body),
    audio,
    body
  );
}

function rebuildVisualizationWithBody(visualization: string, points: string[], audio: string): string {
  const sections: string[] = [];
  const header = explicitHeaderLines(visualization);
  if (header.length > 0) sections.push(header.join('\n'));

  sections.push(['Body Text:', ...points.map((point, index) => `${index + 1}. ${point}`)].join('\n'));

  const visuals = heuristicVisualInstructionLines(visualization, audio, points);
  if (visuals.length > 0) {
    sections.push(['Visual/Animation Instructions:', ...visuals.map((line, index) => `${index + 1}. ${line}`)].join('\n'));
  }

  return sections.join('\n\n').trim();
}

function refineLockedAudioCoverageSeeds(audio: string): string[] {
  const text = audio.replace(/\s+/g, ' ').trim();
  const candidates: Array<[boolean, string]> = [
    [
      /medium or average sized particles|particles are balanced/i.test(text),
      'Particle size is medium, average, and balanced',
    ],
    [
      /soft and crumbly|slightly smooth|not sticky/i.test(text),
      'Texture is soft, crumbly, slightly smooth, and not sticky',
    ],
    [
      /average or moderate water retention|drains excess water/i.test(text),
      'Moderate water retention drains excess water and supports growth',
    ],
    [
      /average-sized particles.*average air spaces|proper oxygen supply/i.test(text),
      'Average air spaces supply oxygen to plant roots',
    ],
    [
      /very fertile|humus|good nutrient retention/i.test(text),
      'Humus makes the soil fertile and helps retain nutrients',
    ],
    [
      /easy to cultivate|suitable for most crops|best soil for agriculture/i.test(text),
      'Easy workability makes it suitable for most crops',
    ],
    [
      /clay soil/i.test(text) && /smooth and sticky when wet/i.test(text) && /hard and cracked when dry/i.test(text),
      'Clay soil is smooth and sticky when wet, then hard and cracked when dry',
    ],
    [
      /clay soil/i.test(text) && /high water retention|holds a lot of water/i.test(text) && /poor drainage|low water drainage|waterlogged/i.test(text),
      'Clay soil holds much water and drains poorly, so it may become waterlogged',
    ],
    [
      /clay soil/i.test(text) && /fine particles/i.test(text) && /small air spaces|poor air circulation/i.test(text),
      'Very fine clay particles leave small air spaces and poor air circulation',
    ],
    [
      /poor air circulation|poor aeration/i.test(text) && /roots?.*lack oxygen|lack oxygen.*roots?/i.test(text),
      'Poor air circulation may leave plant roots without enough oxygen',
    ],
    [
      /clay soil/i.test(text) && /mineral nutrients/i.test(text) && /fertile when well managed/i.test(text),
      'Clay soil is rich in mineral nutrients and fertile when well managed',
    ],
    [
      /clay soil/i.test(text) && /difficult to dig when wet|sticky/i.test(text) && /hard when dry/i.test(text),
      'Clay soil is difficult to dig when wet and hard when dry',
    ],
    [
      /loam soil/i.test(text) && /sandy soil/i.test(text) && /silt/i.test(text) && /clay/i.test(text),
      'Loam combines sandy soil, silt, and clay in one mixture',
    ],
    [
      /loam soil/i.test(text) && /benefits of the properties/i.test(text) && /three soil samples/i.test(text),
      'Loam soil gets benefits from all three soil samples',
    ],
    [
      /loam soil/i.test(text) && /good for agriculture/i.test(text) && /balanced/i.test(text),
      'Loam soil is good for agriculture because it is balanced',
    ],
  ];

  return candidates
    .filter(([condition]) => condition)
    .map(([, point]) => point)
    .filter(point => wordCount(point) <= 20 && bodyPointStrictlyMatchesAudio(point, text));
}

function refinedLockedAudioSummaryBodyPoints(audio: string, proposed?: unknown): string[] {
  const audioText = cleanList([audio]).join(' ');
  if (exactAudioShouldSkipBody(audioText)) return [];
  const target = targetSummaryPointCount(audioText);
  const output: string[] = [];
  const used = new Set<string>();
  const add = (point: string) => {
    const clean = cleanBodyClause(point);
    const key = bodyPointKey(clean);
    if (!key || used.has(key) || wordCount(clean) > 20 || isWeakSummaryBodyPoint(clean, audioText)) return;
    if (!bodyPointStrictlyMatchesAudio(clean, audioText)) return;
    if (output.some(existing => bodyPointsSimilar(existing, clean))) return;
    output.push(sentenceCase(clean));
    used.add(key);
  };

  refineLockedAudioCoverageSeeds(audioText).forEach(add);
  sameAudioSummaryBodyPoints(audioText).forEach(add);
  lockedAudioBodyPoints([], audioText, { preferExisting: false, detailMode: true }).forEach(add);

  if (output.length < Math.min(3, target)) {
    sameAudioSummaryBodyPoints(audioText, proposed).forEach(add);
    lockedAudioBodyPoints(proposed, audioText, { preferExisting: false, detailMode: true }).forEach(add);
  }

  return output.slice(0, target);
}

function sanitizeLockedAudioVisualization(visualization: string, audio: string, fields: RefineField[], _feedback = ''): string {
  const headerSafeVisualization = fields.includes('header')
    ? replaceHeaderInVisualization(visualization, exactHeaderFromAudio(audio, 'Key concept'))
    : visualization;
  if (!fields.includes('bodyText')) {
    if (!fields.includes('visualInstructions')) return headerSafeVisualization;
    const existingBody = extractBodyPointsFromVisualization(headerSafeVisualization);
    const bodyForVisuals = existingBody.length > 0 ? existingBody : refinedLockedAudioSummaryBodyPoints(audio, existingBody);
    const visualLines = heuristicVisualInstructionLines(headerSafeVisualization, audio, bodyForVisuals);
    return visualLines.length > 0
      ? replaceVisualInstructionsInVisualization(headerSafeVisualization, visualLines)
      : headerSafeVisualization;
  }
  const existingPoints = extractBodyPointsFromVisualization(headerSafeVisualization);
  const groundedPoints = refinedLockedAudioSummaryBodyPoints(audio, existingPoints);
  if (groundedPoints.length === 0) return headerSafeVisualization;
  const withBody = !/^Body Text:\s*$/im.test(headerSafeVisualization)
    ? rebuildVisualizationWithBody(headerSafeVisualization, groundedPoints, audio)
    : upsertBodyPointsInVisualization(headerSafeVisualization, groundedPoints);
  if (!fields.includes('visualInstructions')) return withBody;
  const visualLines = heuristicVisualInstructionLines(withBody, audio, groundedPoints);
  return visualLines.length > 0 ? replaceVisualInstructionsInVisualization(withBody, visualLines) : withBody;
}

function sanitizeEditableBodyVisualization(visualization: string, audio: string, fields: RefineField[], feedback = ''): string {
  if (!fields.includes('bodyText')) {
    if (!fields.includes('visualInstructions')) return visualization;
    const existingBody = extractBodyPointsFromVisualization(visualization);
    const visualLines = heuristicVisualInstructionLines(visualization, audio, existingBody);
    return visualLines.length > 0
      ? replaceVisualInstructionsInVisualization(visualization, visualLines)
      : visualization;
  }

  const existingPoints = extractBodyPointsFromVisualization(visualization);
  if (!shouldProtectDetailedBody(feedback) && hasEnoughBodyDetail(existingPoints, audio)) {
    if (!fields.includes('visualInstructions')) return visualization;
    const visualLines = heuristicVisualInstructionLines(visualization, audio, existingPoints);
    return visualLines.length > 0
      ? replaceVisualInstructionsInVisualization(visualization, visualLines)
      : visualization;
  }

  const detailedPoints = detailedBodyPoints(existingPoints, [audio]);
  if (detailedPoints.length === 0) return visualization;
  const withBody = !/^Body Text:\s*$/im.test(visualization)
    ? rebuildVisualizationWithBody(visualization, detailedPoints, audio)
    : upsertBodyPointsInVisualization(visualization, detailedPoints);
  if (!fields.includes('visualInstructions')) return withBody;
  const visualLines = heuristicVisualInstructionLines(withBody, audio, detailedPoints);
  return visualLines.length > 0 ? replaceVisualInstructionsInVisualization(withBody, visualLines) : withBody;
}

function shouldProtectDetailedBody(feedback: string): boolean {
  return /DETAIL LEVEL\s*[123]|more detail|more detailed|expand|explain|richer|stronger/i.test(feedback) &&
    !/simplify|shorten|shorter|brief|concise|reduce/i.test(feedback);
}

function detailLevelMinimumWords(feedback: string): number | null {
  if (/DETAIL LEVEL\s*3/i.test(feedback)) return 5;
  if (/DETAIL LEVEL\s*2/i.test(feedback)) return 5;
  if (/DETAIL LEVEL\s*1/i.test(feedback)) return 1;
  return null;
}

function normalizeComparable(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitCountedUnits(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean)
    .flatMap(line => {
      const sentenceUnits = line
        .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
        ?.map(sentence => sentence.trim())
        .filter(sentence => sentence.length > 1) || [];
      return sentenceUnits.length > 0 ? sentenceUnits : [line];
    });
}

function extractVisualizationLines(visualization: string, field: RefineField): string[] {
  const lines = visualization.split('\n');
  const output: string[] = [];
  let inSection = false;
  const sectionStarts: Partial<Record<RefineField, RegExp>> = {
    bodyText: /^Body Text:?\s*$/i,
    visualInstructions: /^(Visual\/Animation Instructions|Audio\/Animation Cues):?\s*$/i,
    imagePrompts: /^(📌\s*)?Image Suggestions?:?\s*$/i,
  };
  const directImageLine = /^(Image\s*\d*\s*:|AI Image Prompt\s*\d*\s*:|GIF\s*\d*\s*:)/i;
  const start = sectionStarts[field];
  if (!start) return output;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (field === 'imagePrompts' && directImageLine.test(trimmed)) {
      output.push(trimmed);
      inSection = true;
      continue;
    }

    if (start.test(trimmed)) {
      inSection = true;
      continue;
    }

    if (!inSection) continue;
    if (isVisualizationBoundaryLine(trimmed) && !start.test(trimmed)) break;
    const cleaned = stripFormattingLeak(trimmed.replace(/^\s*\d+[.)]\s*/, '').trim());
    if (cleaned) output.push(cleaned);
  }

  return output;
}

function sectionUnits(columns: BlockColumns, field: RefineField): string[] {
  if (field === 'audioCues') return splitCountedUnits(columns.audio);
  if (field === 'bodyText') return extractBodyPointsFromVisualization(columns.visualization);
  if (field === 'visualInstructions') {
    return splitCountedUnits(extractVisualizationLines(columns.visualization, field).join('\n'));
  }
  if (field === 'imagePrompts') return extractVisualizationLines(columns.visualization, field);
  return [];
}

function unitExpandedEnough(original: string, proposed: string, minimumAddedWords: number, maxWords?: number): boolean {
  const originalWords = wordCount(original);
  const proposedWords = wordCount(proposed);
  const availableWords = typeof maxWords === 'number' ? Math.max(0, maxWords - originalWords) : minimumAddedWords;
  const requiredWords = Math.min(minimumAddedWords, availableWords);
  const changed = normalizeComparable(original) !== normalizeComparable(proposed);
  if (proposedWords < originalWords) return false;
  if (requiredWords <= 0) return changed && proposedWords >= originalWords;
  return changed && proposedWords >= originalWords + requiredWords;
}

function detailValidationFailures(
  originalBlock: string,
  proposedBlock: string,
  feedback: string,
  fields: RefineField[],
  preserveAudioCues = false
): string[] {
  const minimumAddedWords = detailLevelMinimumWords(feedback);
  if (!minimumAddedWords || !shouldProtectDetailedBody(feedback)) return [];

  const original = parseBlockColumns(originalBlock);
  const proposed = parseBlockColumns(proposedBlock);
  if (!original || !proposed) return [];

  const failures: string[] = [];
  const fieldsToValidate: RefineField[] = ['audioCues', 'bodyText', 'visualInstructions'];
  for (const field of fieldsToValidate) {
    if (!fields.includes(field)) continue;
    const originalUnits = sectionUnits(original, field);
    const proposedUnits = sectionUnits(proposed, field);
    if (originalUnits.length === 0) continue;
    if (preserveAudioCues && field === 'bodyText') {
      const audioWords = wordCount(original.audio);
      const minimumSummaryCount = audioWords >= 120 ? 5 : audioWords >= 80 ? 4 : audioWords >= 45 ? 3 : 2;
      if (proposedUnits.length === 0) failures.push('Body Text is missing after refining around locked Audio Cues');
      if (proposedUnits.some(unit => wordCount(unit) > 20)) failures.push('Body Text contains items longer than 20 words');
      const proposedWords = proposedUnits.reduce((sum, unit) => sum + wordCount(unit), 0);
      const proposedAverageWords = proposedUnits.length > 0 ? proposedWords / proposedUnits.length : 0;
      const shortBodyItems = proposedUnits.filter(unit => wordCount(unit) < 7 && !/[=+\-*/^]/.test(unit));
      if (proposedUnits.length < minimumSummaryCount) {
        failures.push('Body Text does not cover enough key Audio Cue ideas');
      }
      if (proposedAverageWords < 8 || shortBodyItems.length > 0) {
        failures.push('Body Text still contains short label-like points instead of useful summary points');
      }
      const offAudioItems = proposedUnits.filter(unit => !bodyPointStrictlyMatchesAudio(unit, original.audio));
      if (offAudioItems.length > 0) {
        failures.push('Body Text contains points not grounded in the same screen Audio Cues');
      }
      continue;
    }
    if (proposedUnits.length < originalUnits.length) {
      failures.push(`${REFINE_FIELD_LABELS[field]} has fewer counted points/sentences than before`);
      continue;
    }
    if (field === 'bodyText') {
      const offAudioItems = proposedUnits.filter(unit => !bodyPointStrictlyMatchesAudio(unit, proposed.audio || original.audio));
      if (offAudioItems.length > 0) {
        failures.push('Body Text contains points not grounded in the same screen Audio Cues');
      }
    }

    const failedIndexes = originalUnits
      .map((unit, index) => ({ unit, index }))
      .filter(({ unit, index }) => !unitExpandedEnough(
        unit,
        proposedUnits[index] || '',
        minimumAddedWords,
        field === 'bodyText' ? 20 : undefined
      ))
      .map(({ index }) => index + 1);

    if (failedIndexes.length > 0) {
      failures.push(`${REFINE_FIELD_LABELS[field]} item(s) ${failedIndexes.join(', ')} were not expanded`);
    }
  }

  if (fields.includes('imagePrompts')) {
    const originalImages = sectionUnits(original, 'imagePrompts').join('\n');
    const proposedImages = sectionUnits(proposed, 'imagePrompts').join('\n');
    if (originalImages && normalizeComparable(originalImages) === normalizeComparable(proposedImages)) {
      failures.push('Image Suggestions / image prompts did not update with the refined content');
    }
  }

  return failures;
}

function strictDetailRetryNote(failures: string[]): string {
  return `VALIDATION FAILED. The previous response was too small and looked like only highlighting. Fix every issue below:
- ${failures.join('\n- ')}
You must update every counted point/sentence in every editable section, not only the first point. Body Text items must use the available space: write detailed 10-20 word learner-facing points, not 4-8 word labels. Do not make any existing counted item shorter. If a Body Text item already has no room under 20 words, keep that item at least as informative and add a connected extra item for the added detail.`;
}

function keepBodyDetailFromShrinking(originalViz: string, proposedViz: string, feedback: string, fields: RefineField[]): string {
  if (!fields.includes('bodyText') || !shouldProtectDetailedBody(feedback)) return proposedViz;

  const originalPoints = extractBodyPointsFromVisualization(originalViz);
  const proposedPoints = extractBodyPointsFromVisualization(proposedViz);
  if (originalPoints.length === 0) return proposedViz;
  if (proposedPoints.length === 0) {
    return replaceBodyPointsInVisualization(proposedViz, originalPoints);
  }

  const originalWords = originalPoints.reduce((sum, point) => sum + wordCount(point), 0);
  const proposedWords = proposedPoints.reduce((sum, point) => sum + wordCount(point), 0);
  if (proposedPoints.length >= originalPoints.length && proposedWords >= Math.floor(originalWords * 0.9)) {
    return proposedViz;
  }

  const merged = [...proposedPoints];
  const usedKeys = new Set(merged.map(bodyPointKey));
  for (const point of originalPoints) {
    if (merged.length >= originalPoints.length && merged.reduce((sum, value) => sum + wordCount(value), 0) >= originalWords) break;
    const key = bodyPointKey(point);
    if (!usedKeys.has(key)) {
      merged.push(point);
      usedKeys.add(key);
    }
  }

  return replaceBodyPointsInVisualization(proposedViz, merged);
}

function applyScopeToReplacement(originalBlock: string, proposedBlock: string, scope?: RefineScope, feedback = ''): string {
  const fields = scope?.fields || [];
  if (fields.length === 0) return proposedBlock.replace(/<<<ROW>>>/g, '').trim();

  const original = parseBlockColumns(originalBlock);
  const proposed = parseBlockColumns(proposedBlock);
  if (!original || !proposed) return proposedBlock.replace(/<<<ROW>>>/g, '').trim();

  const proposedViz = extractMisplacedAudioCues(cleanVisualizationFormatting(proposed.visualization));
  const detailSafeVisualization = keepBodyDetailFromShrinking(original.visualization, proposedViz.visualization, feedback, fields);
  const cleanVisualization = cleanVisualizationFormatting(detailSafeVisualization);
  const visualization = scope?.preserveAudioCues
    ? sanitizeLockedAudioVisualization(cleanVisualization, original.audio, fields, feedback)
    : sanitizeEditableBodyVisualization(cleanVisualization, fields.includes('audioCues') ? (proposedViz.audio || proposed.audio || original.audio) : original.audio, fields, feedback);
  const audioSource = proposedViz.audio || proposed.audio || original.audio;
  return composeBlockColumns({
    audio: fields.includes('audioCues') ? normalizeAudioColumn(audioSource) : original.audio,
    frame: fields.includes('frameType') ? proposed.frame : original.frame,
    visualization: hasVisualizationField(fields) ? visualization : original.visualization,
  });
}

function compactContextBlock(block: IndexedBlock, label: string): string {
  const columns = parseBlockColumns(block.block);
  const shorten = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 700);
  if (!columns) return `${label} screen ${block.index + 1}: ${shorten(block.block)}`;
  return `${label} screen ${block.index + 1}
Audio: ${shorten(columns.audio)}
Frame: ${columns.frame}
Visual: ${shorten(columns.visualization)}`;
}

function buildNeighborContext(editableBlocks: IndexedBlock[], allBlocks?: IndexedBlock[]): string {
  if (!allBlocks || allBlocks.length === 0) return 'No neighboring slide context available.';
  const byIndex = new Map(allBlocks.map(block => [block.index, block]));
  const context: string[] = [];

  for (const block of editableBlocks) {
    const previous = byIndex.get(block.index - 1);
    const next = byIndex.get(block.index + 1);
    context.push(`For editable screen ${block.index + 1}:`);
    context.push(previous ? compactContextBlock(previous, 'Previous') : 'Previous screen: none');
    context.push(next ? compactContextBlock(next, 'Next') : 'Next screen: none');
  }

  return context.join('\n\n');
}

function buildRefineRules(scope?: RefineScope): string {
  const audioLocked = scope?.preserveAudioCues === true;
  const editableSections = audioLocked
    ? 'Body Text and Visual/Animation or Audio/Animation Cues'
    : 'Body Text, Audio Cues, and Visual/Animation or Audio/Animation Cues';
  const detailExample = audioLocked
    ? 'Example: if Body Text has 3 points, Level 1 adds about 3-6 useful words total to Body Text, Level 2 adds about 15-18, and Level 3 adds about 15-30.'
    : 'Example: if Audio Cues has 3 sentences, Level 1 adds about 3-6 useful words total to Audio Cues, Level 2 adds about 15-18, and Level 3 adds about 15-30.';
  const audioLockRules = audioLocked
    ? `- EXACT AUDIO LOCK: Audio Cues are read-only because narration may already be recorded. Do not change, rewrite, shorten, expand, renumber, move, correct, or paraphrase the first-column Audio Cues.
- Use the locked Audio Cues only as context for improving Body Text, headers, frames, and Visual/Animation Instructions.
- If the user asks to change audio while this lock is on, preserve the Audio Cues exactly and apply any possible connected improvement only to non-audio sections.`
    : `- When Audio Cues are selected, rewrite only the first-column narration for that slide and keep the Frame and Visualization columns stable unless those fields are also selected.`;

  return `STRICT RULES:
- Work like a subject matter expert, not a text appender. Make the selected slide internally coherent and accurate.
- You are editing the generated script only. Never add, paste, summarize, or copy any sample script/reference text into the output.
- Preserve tabs between Audio Cues, Frame, and Visualization columns.
- Audio Cues belong ONLY in the first column before the Frame column tab. Never create an "Audio Cues:" section inside the Visualization column.
${audioLockRules}
- If Audio Cues, Header, or Body Text change, revise the connected Body Text and Visual/Animation Instructions when those fields are editable.
- Preserve the PicEd wording, labels, editor-note wording, font names, font sizes, colours, bullet style, section order, and frame-type names exactly.
- Preserve section names and frame type unless the feedback directly asks to change them.
- Keep unrelated wording stable inside each block.
- ${fieldInstruction(scope)}
- For every selected editable field that exists in a block and is affected by the feedback, apply the change completely and consistently. Do not update one selected part while leaving another selected affected part stale.
- If the feedback contains DETAIL LEVEL 1, 2, or 3, first count the existing points or sentences separately inside each editable section: ${editableSections}.
- After counting each section, calculate expansion from that count. Level 1 = about 1-2 useful words per counted point/sentence, Level 2 = about 5-6 useful words per counted point/sentence, Level 3 = about 5-10 useful words per counted point/sentence.
- ${detailExample}
- Apply that count-based level expansion to ${editableSections} according to the selected screen and context.
- Never update only the first counted point or sentence. Every counted point/sentence in every editable section must be updated at the selected detail level.
- For detail-level requests, rewrite the full editable slide content as one coherent teaching slide, but expand existing counted points/sentences in place before adding new points. Do not satisfy level detail by appending only a few unrelated new points.
- Improve the current text. Preserve every useful existing factual idea unless it is wrong or the user explicitly asks to remove it.
- If the user asks for more detail, the result must be more informative than the original slide, not shorter or more generic.
- Never make an existing counted point/sentence shorter during a detail-level refine. Each updated ${audioLocked ? 'Body Text item and Visual/Animation item' : 'Audio Cue, Body Text item, and Visual/Animation item'} must have at least the original word count, then add the detail required by the selected level where the 20-word Body Text limit allows.
- If an existing Body Text item is already near 20 words, keep that item at least as informative and add a closely connected extra item rather than shortening it.
- If the user provides a specific selected word or sentence, use it as the change target, then update the whole slide around that target wherever it affects ${audioLocked ? 'body, visuals, and images while keeping Audio Cues locked' : 'audio, body, visuals, and images'}.
- Make the rewritten text realistic, age-appropriate, classroom-ready, and aligned to the exact slide's audio, context, and concept.
- Use enough detail to satisfy the user's request, but keep the original PicEd format, rhythm, wording style, and approximate section size.
- ${audioLocked ? 'Body Text and Visual/Animation Instructions must be detailed enough to use directly with the locked Audio Cues.' : 'Audio Cues, Body Text, and Visual/Animation Instructions must be detailed enough to use directly.'} Do not leave any of these sections as generic placeholders when they are editable.
- Body Text must cover the important ideas spoken in the same frame's Audio Cues.
- Body Text and Visual/Animation Instructions must match the same frame's Audio Cues. Do not add facts, benefits, examples, causes, organisms, places, outcomes, or claims that are not present in that frame's Audio Cues.
- Visual/Animation Instructions must keep the first-generated script style and cover each Body Text point. If Body Text has 10 points, create matching visual instructions using concise editor actions like "Show a diagram of...", "Illustrate...", "Highlight...", "Display...", or "Animate...". Do not rewrite them into vague OST/image-number wording during refine.
- Do not paste whole Audio Cue sentences into Body Text. Convert the audio into concise 0-20 word on-screen points, labels, formulas, or equations that directly match the narration.
${audioLocked ? '- Because Audio Cues are locked, non-audio sections must be improved only by summarizing, organizing, labeling, or visualizing the locked narration. Do not add outside subject facts to make it look more detailed.' : ''}
- Body Text may be points, full sentences, formulas, equations, labels, or a mix depending on the subject, screen, and context. Do not force every item to read like a bullet point.
- When adding detail to Body Text, count the existing Body Text points/sentences first, then expand each counted item within the 20-word limit. Add or split items only when needed for clarity, equations, formulas, or the 20-word limit.
- For detail-level refine, Body Text should normally be 10-20 words per item. Do not leave 4-8 word labels like "Air in the soil supports soil life" when the audio contains causes, examples, organisms, or results.
- Do not replace descriptive Body Text with shorter labels. Expand each existing idea into clearer 0-20 word items, and add items only when the audio contains more ideas.
- When Body Text is editable, regenerate the entire Body Text section so all items read like one complete section. Do not leave old weak items unchanged next to new detailed items.
- Do not add Image Suggestions, Image N, image URLs, SEARCH:, PROMPT:, URL:, or AI Image Prompt sections to the script. Keep visual guidance inside Visual/Animation Instructions only.
- End inside the Summary frame like the sample. The final summary audio cue should be "Thank you!" Do not add a separate thank-you Wide frame.`;
}

async function requestRefineText(prompt: string, maxCompletionTokens: number): Promise<string> {
  return requestGroqText(
    prompt,
    maxCompletionTokens,
    0.3,
    'Groq request is too large. Please refine fewer screens at a time, or use a shorter instruction.',
    true
  );
}

async function refineOneBlock(
  block: string,
  blockIndex: number,
  feedback: string,
  scope?: RefineScope,
  allBlocks?: IndexedBlock[]
): Promise<string> {
  if (!isGroqInitialized()) throw new Error('Groq client not initialized.');

  const requestReplacement = async (extraInstruction = ''): Promise<string> => {
    const prompt = `You are a precision PicEd script editor. Return ONLY the full updated text for this one block. Do not return JSON, markdown, explanations, or the <<<ROW>>> separator.

Apply the user's feedback only if it affects this block and the selected editable fields. If no change is needed, return the original block exactly.

${buildRefineRules(scope)}

USER FEEDBACK:
${feedback}
${extraInstruction ? `\n${extraInstruction}` : ''}

READ-ONLY NEIGHBORING SLIDE CONTEXT:
Use this context to maintain continuity with the previous and next slide. Do not edit this context and do not copy it as a new slide.
${buildNeighborContext([{ block, index: blockIndex }], allBlocks)}

BLOCK ${blockIndex}:
${block.trim()}`;

    const rawReplacement = await requestRefineText(prompt, refineCompletionBudget(block));
    return cleanModelScriptText(rawReplacement);
  };

  const applyAndValidate = (replacement: string): { text: string; failures: string[] } => {
    if (!replacement || /^no changes? needed\.?$/i.test(replacement)) {
      return { text: block.trim(), failures: ['No meaningful changes were returned'] };
    }
    const text = applyScopeToReplacement(block, replacement, scope, feedback);
    return {
      text,
      failures: detailValidationFailures(block, text, feedback, scope?.fields || [], scope?.preserveAudioCues),
    };
  };

  let result = applyAndValidate(await requestReplacement());
  if (result.failures.length > 0) {
    result = applyAndValidate(await requestReplacement(strictDetailRetryNote(result.failures)));
  }
  if (result.failures.length > 0) {
    throw new Error(`Refine returned too small an update: ${result.failures.join('; ')}`);
  }
  return result.text;
}

function chunkIndexedBlocks(blocks: IndexedBlock[]): IndexedBlock[][] {
  const chunks: IndexedBlock[][] = [];
  let current: IndexedBlock[] = [];
  let currentChars = 0;

  for (const block of blocks) {
    const nextChars = block.block.length;
    if (current.length > 0 && (current.length >= 2 || currentChars + nextChars > 3200)) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(block);
    currentChars += nextChars;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function batchCompletionBudget(blocks: IndexedBlock[]): number {
  const estimatedBlockTokens = Math.ceil(blocks.reduce((sum, block) => sum + block.block.length, 0) / 4);
  return Math.min(7600, Math.max(3200, estimatedBlockTokens + 2800));
}

function parseBatchRefineResponse(raw: string, blocks: IndexedBlock[], scope?: RefineScope, feedback = ''): Map<number, string> {
  const text = cleanModelScriptText(raw).replace(/<<<ROW>>>/g, '').trim();
  const replacements = new Map<number, string>();

  for (const block of blocks) {
    const start = blockMarkerStart(block.index);
    const end = blockMarkerEnd(block.index);
    const startIndex = text.indexOf(start);
    const endIndex = text.indexOf(end);
    if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
      throw new Error('Refine response was incomplete. Please try fewer screens at a time.');
    }
    const replacement = text.slice(startIndex + start.length, endIndex).trim();
    replacements.set(block.index, replacement ? applyScopeToReplacement(block.block, replacement, scope, feedback) : block.block.trim());
  }

  return replacements;
}

async function refineBlockChunk(
  blocks: IndexedBlock[],
  feedback: string,
  scope?: RefineScope,
  allBlocks?: IndexedBlock[]
): Promise<Map<number, string>> {
  if (blocks.length === 1) {
    return new Map([[blocks[0].index, await refineOneBlock(blocks[0].block, blocks[0].index, feedback, scope, allBlocks)]]);
  }

  const blockText = blocks.map(({ block, index }) => `${blockMarkerStart(index)}
${block.trim()}
${blockMarkerEnd(index)}`).join('\n\n');
  const requestBatchReplacement = async (extraInstruction = ''): Promise<Map<number, string>> => {
    const prompt = `You are a precision PicEd script editor. Return ONLY the updated blocks listed below.

Return every block, even if unchanged. Wrap each returned block with the same block markers:
${blocks.map(({ index }) => `${blockMarkerStart(index)} ... ${blockMarkerEnd(index)}`).join('\n')}

Do not return JSON, markdown, explanations, or the <<<ROW>>> separator.
Apply the user's feedback only where it affects each block and the selected editable fields. If no change is needed for a block, return that original block exactly inside its markers.

${buildRefineRules(scope)}

USER FEEDBACK:
${feedback}
${extraInstruction ? `\n${extraInstruction}` : ''}

READ-ONLY NEIGHBORING SLIDE CONTEXT:
Use this context to keep the selected slides connected to what comes before and after. Do not edit this context and do not copy it as a new slide.
${buildNeighborContext(blocks, allBlocks)}

BLOCKS:
${blockText}`;

    const rawReplacement = await requestRefineText(prompt, batchCompletionBudget(blocks));
    return parseBatchRefineResponse(rawReplacement, blocks, scope, feedback);
  };

  const validationFailures = (replacements: Map<number, string>): string[] => {
    return blocks.flatMap(block => {
      const replacement = replacements.get(block.index) || block.block.trim();
      return detailValidationFailures(block.block, replacement, feedback, scope?.fields || [], scope?.preserveAudioCues)
        .map(reason => `Screen ${block.index + 1}: ${reason}`);
    });
  };

  let replacements = await requestBatchReplacement();
  let failures = validationFailures(replacements);
  if (failures.length > 0) {
    replacements = await requestBatchReplacement(strictDetailRetryNote(failures));
    failures = validationFailures(replacements);
  }
  if (failures.length > 0) {
    throw new Error(`Refine returned too small an update: ${failures.join('; ')}`);
  }

  return replacements;
}

export async function refineScript(
  currentScript: string,
  feedback: string,
  _sampleScripts: ParsedScript[],
  scope?: RefineScope
): Promise<string> {
  if (!isGroqInitialized()) throw new Error('Groq client not initialized.');

  const effectiveScope = scope
    ? {
      ...scope,
      fields: scope.preserveAudioCues
        ? getConnectedRefineFields(scope.fields || []).filter(field => field !== 'audioCues')
        : getConnectedRefineFields(scope.fields || []),
    }
    : undefined;
  const rowSeparator = '<<<ROW>>>';
  const tableHeaderMatch = currentScript.match(/Frame-by-Frame Script[\s\S]*?Audio Cues\tFrame\tVisualization Comments\s*\/\s*Text on Screen\s*\n/i);
  const tableHeaderIndex = tableHeaderMatch?.index ?? -1;
  const hasSeparatedRows = currentScript.includes(rowSeparator) && tableHeaderIndex >= 0;
  const prefixEnd = hasSeparatedRows
    ? tableHeaderIndex + (tableHeaderMatch?.[0].length || 0)
    : 0;
  const scriptPrefix = hasSeparatedRows ? currentScript.slice(0, prefixEnd) : '';
  const blocks = hasSeparatedRows
    ? currentScript.slice(prefixEnd).split(rowSeparator)
    : currentScript.includes(rowSeparator)
      ? currentScript.split(rowSeparator)
      : [currentScript];
  const indexedBlocks = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.trim())
    .filter(({ block }) => !hasSeparatedRows || parseBlockColumns(block) !== null);
  const selectedBlocks = indexedBlocks.filter(({ index }) => shouldRefineBlock(index, effectiveScope));
  const replacements = new Map<number, string>();

  for (const chunk of chunkIndexedBlocks(selectedBlocks)) {
    try {
      const refinedChunk = await refineBlockChunk(chunk, feedback, effectiveScope, indexedBlocks);
      refinedChunk.forEach((replacement, index) => replacements.set(index, replacement));
    } catch (error) {
      console.error('Refine chunk error:', error);
      throw new Error(errorMessage(error) || 'Refine failed. Please try fewer screens/fields at a time.');
    }
  }

  const editedBlocks = blocks.map((block, index) => {
    const edited = replacements.get(index) ?? block;
    if (!effectiveScope?.preserveAudioCues) return edited;

    const originalColumns = parseBlockColumns(block);
    const editedColumns = parseBlockColumns(edited);
    if (!originalColumns || !editedColumns) return edited;

    return composeBlockColumns({
      ...editedColumns,
      audio: originalColumns.audio,
    });
  });
  const refinedRows = editedBlocks
    .map(block => block.trim())
    .filter(Boolean)
    .join(`\n${rowSeparator}\n`);
  const refinedScript = hasSeparatedRows
    ? `${scriptPrefix}${refinedRows}`.trim()
    : refinedRows;
  return finalizeScript(refinedScript, {
    normalizeBody: effectiveScope?.fields?.includes('bodyText'),
    enrichImages: effectiveScope?.fields?.includes('imagePrompts'),
  });
}
