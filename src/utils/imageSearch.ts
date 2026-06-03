// Image helpers for generated scripts.
// Output should contain either one direct image URL or an AI image prompt.
// It should not contain search-result pages that ask the editor to choose an image.

export async function searchImages(query: string, count: number = 2): Promise<string[]> {
  const safeCount = Math.max(1, count);
  const visibleImage = await findVisibleInternetImageUrl(query);
  if (visibleImage) {
    return [visibleImage, ...Array.from({ length: safeCount - 1 }, () => createAiImagePrompt(query))];
  }
  return Array.from({ length: safeCount }, () => createAiImagePrompt(query));
}

interface ImageCandidate {
  url: string;
  title: string;
  source: string;
  width?: number;
  height?: number;
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'before', 'between',
  'biology', 'chapter', 'clean', 'context', 'create', 'diagram', 'educational',
  'for', 'from', 'high', 'image', 'into', 'lesson', 'middle', 'one', 'overview',
  'school', 'science', 'show', 'slide', 'style', 'subject', 'teacher', 'textbook',
  'that', 'the', 'this', 'today', 'using', 'visual', 'with',
]);

const BLOCKED_IMAGE_HOSTS = /(?:gettyimages|istockphoto|shutterstock|alamy|depositphotos|dreamstime|pinterest|facebook|instagram|x\.com|twitter\.com|google\.[^/]+\/search|google\.[^/]+\/imgres|tbm=isch|images\.google)/i;
const BAD_DOCUMENT_IMAGE = /(?:google[_\s-]*books|digitized\s+by\s+google|library\s+book|book\s+scan|scanned\s+page|scan\s+of|page\s+\d+|page[-_]\d+|\/page\d+[-_/]|\.djvu|djvu\/page|medical[_\s-]*dictionary|explanation[_\s-]*of[_\s-]*the[_\s-]*tables|title[_\s-]*page|front\s*cover|cover\s+page|blank\s+page|wellcome[_\s-]*l\d+|internet\s+archive|hathi\s*trust|biodiversity\s+heritage\s+library|ocr|newspaper|manuscript|mostly\s+text)/i;
const USEFUL_VISUAL_HINT = /(?:diagram|illustration|anatomy|structure|cross[-\s]*section|labeled|labelled|model|photo|photograph|micrograph|chart|map|infographic|schematic|cycle|process|layers?|system|organ|cell|tissue)/i;

function extractDirectImageUrl(value: string): string {
  const url = value.match(/https?:\/\/\S+/i)?.[0]?.replace(/[),.;]+$/, '') || '';
  if (!url) return '';
  if (BLOCKED_IMAGE_HOSTS.test(url)) return '';
  if (looksLikeBadDocumentUrl(url)) return '';

  const directImageFile = /\.(png|jpe?g|webp|gif|svg)([?#][^\s]*)?$/i.test(url);
  const explicitlyMarked = /^\s*(url|image url|direct image url)\s*:/i.test(value);
  return directImageFile || explicitlyMarked ? url : '';
}

function decodeForMatching(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeBadDocumentUrl(url: string): boolean {
  const decoded = decodeForMatching(url).replace(/[_-]+/g, ' ');
  return BAD_DOCUMENT_IMAGE.test(decoded);
}

function cleanPromptText(description: string, context = ''): string {
  const source = `${context} ${description}`
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[🎨📌]/g, ' ')
    .replace(/\b(prompt|ai image prompt|search|image search|url|image url|direct image url)\s*:/gi, ' ')
    .replace(/\b(detailed|50-word|fifty word|create|showing|style|background|colors?)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s+.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = source.split(/\s+/).filter(Boolean);
  return words.slice(0, 28).join(' ') || 'clear educational diagram';
}

export function createAiImagePrompt(description: string, context = ''): string {
  const prompt = cleanPromptText(description, context);
  return `AI Image Prompt: Create one age-appropriate educational image for ${prompt}. Use a clean textbook diagram style, accurate labels, simple composition, and the slide context.`;
}

function tokenizeForRelevance(text: string): string[] {
  return cleanPromptText(text)
    .toLowerCase()
    .split(/\s+/)
    .map(word => word.replace(/[^a-z0-9+-]/gi, ''))
    .filter(word => word.length > 2 && !STOP_WORDS.has(word));
}

function uniqueCandidates(candidates: ImageCandidate[]): ImageCandidate[] {
  const seen = new Set<string>();
  const unique: ImageCandidate[] = [];
  for (const candidate of candidates) {
    const url = candidate.url.trim();
    if (!url || seen.has(url) || BLOCKED_IMAGE_HOSTS.test(url)) continue;
    seen.add(url);
    unique.push({ ...candidate, url });
  }
  return unique;
}

function relevanceScore(candidate: ImageCandidate, query: string, context = ''): number {
  const desiredTerms = new Set(tokenizeForRelevance(`${query} ${context}`));
  if (desiredTerms.size === 0) return 1;

  const metadata = `${candidate.title} ${candidate.source} ${decodeForMatching(candidate.url)}`;
  const haystack = tokenizeForRelevance(metadata).join(' ');
  let score = 0;
  for (const term of desiredTerms) {
    if (haystack.includes(term)) score += 2;
  }
  if ((candidate.width || 0) >= 300 && (candidate.height || 0) >= 200) score += 1;
  if (USEFUL_VISUAL_HINT.test(metadata)) score += 4;
  return score;
}

function hasUsableSize(candidate: ImageCandidate): boolean {
  const width = candidate.width || 0;
  const height = candidate.height || 0;
  return (width === 0 && height === 0) || (width >= 120 && height >= 120);
}

function isLikelyEducationalVisual(candidate: ImageCandidate, query: string, context = ''): boolean {
  const metadata = `${candidate.title} ${candidate.source} ${decodeForMatching(candidate.url)}`;
  if (BLOCKED_IMAGE_HOSTS.test(candidate.url)) return false;
  if (BAD_DOCUMENT_IMAGE.test(metadata)) return false;

  const width = candidate.width || 0;
  const height = candidate.height || 0;
  const aspectRatio = width > 0 && height > 0 ? Math.max(width, height) / Math.max(1, Math.min(width, height)) : 1;
  if (aspectRatio > 2.2 && !USEFUL_VISUAL_HINT.test(metadata)) return false;

  const coreTerms = tokenizeForRelevance(`${query} ${context}`)
    .filter(term => term.length > 4 && !['prompt', 'image', 'visual', 'slide'].includes(term));
  const haystack = tokenizeForRelevance(metadata).join(' ');
  const hasCoreMatch = coreTerms.length === 0 || coreTerms.some(term => haystack.includes(term));
  return hasCoreMatch || USEFUL_VISUAL_HINT.test(metadata);
}

function tagNames(tags: unknown): string {
  if (!Array.isArray(tags)) return '';
  return tags
    .map(tag => {
      if (typeof tag === 'string') return tag;
      if (tag && typeof tag === 'object' && 'name' in tag) return String((tag as { name?: unknown }).name || '');
      return '';
    })
    .filter(Boolean)
    .join(' ');
}

async function findOpenverseImageCandidates(description: string, context = ''): Promise<ImageCandidate[]> {
  if (typeof fetch === 'undefined') return [];

  const query = cleanPromptText(description, context);
  if (!query) return [];

  const params = new URLSearchParams({
    q: query,
    page_size: '12',
    mature: 'false',
  });

  try {
    const response = await fetch(`https://api.openverse.org/v1/images/?${params.toString()}`);
    if (!response.ok) return [];

    const data = await response.json();
    const results = (data?.results || []) as Array<{
      title?: string;
      creator?: string;
      source?: string;
      url?: string;
      thumbnail?: string;
      width?: number;
      height?: number;
      tags?: unknown;
    }>;

    return results.flatMap(result => {
      const title = [result.title, result.creator, tagNames(result.tags)].filter(Boolean).join(' ');
      const urls = [result.url, result.thumbnail].filter(Boolean) as string[];
      return urls.map(url => ({
        url,
        title,
        source: result.source || 'Openverse',
        width: result.width,
        height: result.height,
      }));
    });
  } catch {
    return [];
  }
}

async function findWikipediaImageCandidates(description: string, context = ''): Promise<ImageCandidate[]> {
  if (typeof fetch === 'undefined') return [];

  const query = cleanPromptText(description, context);
  if (!query) return [];

  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrlimit: '8',
    gsrsearch: query,
    prop: 'pageimages|pageterms',
    piprop: 'thumbnail|original',
    pithumbsize: '900',
  });

  try {
    const response = await fetch(`https://en.wikipedia.org/w/api.php?${params.toString()}`);
    if (!response.ok) return [];

    const data = await response.json();
    const pages = Object.values(data?.query?.pages || {}) as Array<{
      title?: string;
      thumbnail?: { source?: string; width?: number; height?: number };
      original?: { source?: string; width?: number; height?: number };
      terms?: { description?: string[]; label?: string[] };
    }>;

    return pages.flatMap(page => {
      const title = [
        page.title,
        ...(page.terms?.description || []),
        ...(page.terms?.label || []),
      ].filter(Boolean).join(' ');
      const image = page.original?.source ? page.original : page.thumbnail;
      return image?.source ? [{
        url: image.source,
        title,
        source: 'Wikipedia',
        width: image.width,
        height: image.height,
      }] : [];
    });
  } catch {
    return [];
  }
}

async function findCommonsImageCandidates(description: string, context = ''): Promise<ImageCandidate[]> {
  if (typeof fetch === 'undefined') return [];

  const query = cleanPromptText(description, context);
  if (!query) return [];

  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrnamespace: '6',
    gsrlimit: '8',
    gsrsearch: query,
    prop: 'imageinfo',
    iiprop: 'url|mime|size',
    iiurlwidth: '900',
  });

  try {
    const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`);
    if (!response.ok) return [];

    const data = await response.json();
    const pages = Object.values(data?.query?.pages || {}) as Array<{
      imageinfo?: Array<{ url?: string; thumburl?: string; mime?: string; width?: number; height?: number }>;
      title?: string;
    }>;

    const candidates: ImageCandidate[] = [];
    for (const page of pages) {
      const info = page.imageinfo?.[0];
      if (!info?.mime?.startsWith('image/')) continue;
      const url = info.thumburl || info.url || '';
      if (!url) continue;
      candidates.push({
        url,
        title: page.title || query,
        source: 'Wikimedia Commons',
        width: info.width,
        height: info.height,
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

async function findVisibleInternetImageUrl(description: string, context = ''): Promise<string> {
  if (typeof fetch === 'undefined') return '';

  const query = cleanPromptText(description, context);
  if (!query) return '';

  const providerResults = await Promise.allSettled([
    findOpenverseImageCandidates(query, context),
    findWikipediaImageCandidates(query, context),
    findCommonsImageCandidates(query, context),
  ]);

  const candidates = uniqueCandidates(
    providerResults.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  )
    .filter(hasUsableSize)
    .filter(candidate => isLikelyEducationalVisual(candidate, query, context))
    .map(candidate => ({
      candidate,
      score: relevanceScore(candidate, query, context),
    }))
    .filter(({ score }) => score >= 3)
    .sort((a, b) => b.score - a.score)
    .map(({ candidate }) => candidate)
    .slice(0, 24);

  for (const candidate of candidates) {
    if (await isVisibleImageUrl(candidate.url, 5000)) return candidate.url;
  }

  return '';
}

export function formatImageReference(index: number, description: string, context = ''): string {
  const cleanDescription = String(description || '').trim().replace(/^🎨\s*/, '');
  const directImageUrl = extractDirectImageUrl(cleanDescription);
  if (directImageUrl) return `Image ${index}: ${directImageUrl}`;

  const promptText = cleanDescription.replace(/^\s*(search|image search|prompt|ai image prompt)\s*:/i, '').trim() || context || 'relevant educational visual';
  return `AI Image Prompt ${index}: ${createAiImagePrompt(promptText, context).replace(/^AI Image Prompt:\s*/i, '')}`;
}

export function formatImageReferences(images: string[] | undefined, context = ''): string {
  const cleanImages = (images || []).map(img => String(img || '').trim()).filter(Boolean);
  return cleanImages.map((img, index) => formatImageReference(index + 1, img, context)).join('\n');
}

export function ensureDirectImagesOrPrompts(script: string): string {
  const lines = script.split('\n');
  const enrichedLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^Image\s*\d*\s+Google Images\s*:/i.test(trimmed) || /google\.[^/]+\/search|tbm=isch/i.test(trimmed)) {
      continue;
    }

    const oldPromptMatch = trimmed.match(/^Image\s*(\d+)?\s+Prompt\s*:\s*(.+)$/i);
    if (oldPromptMatch) {
      enrichedLines.push(formatImageReference(Number(oldPromptMatch[1] || '1'), oldPromptMatch[2]));
      continue;
    }

    const imageMatch = trimmed.match(/^Image\s*(\d+)?\s*:\s*(.+)$/i);
    if (imageMatch) {
      enrichedLines.push(formatImageReference(Number(imageMatch[1] || '1'), imageMatch[2]));
      continue;
    }

    const promptMatch = trimmed.match(/^(?:🎨\s*)?AI Image Prompt\s*(\d+)?\s*:\s*(.+)$/i);
    if (promptMatch) {
      enrichedLines.push(line);
      continue;
    }

    enrichedLines.push(line);
  }

  return enrichedLines.join('\n');
}

function getNearbyContext(lines: string[], imageLineIndex: number): string {
  const start = Math.max(0, imageLineIndex - 12);
  const contextLines = lines
    .slice(start, imageLineIndex)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^Image\s*\d*\s*:/i.test(line))
    .filter(line => !/^AI Image Prompt\s*\d*\s*:/i.test(line))
    .filter(line => !/^Audio\/Animation Cues:?$/i.test(line))
    .filter(line => !/^Visual\/Animation Instructions:?$/i.test(line))
    .map(line => line.replace(/https?:\/\/\S+/gi, '').replace(/^\d+[.)]\s*/, '').trim())
    .filter(Boolean);

  return contextLines.slice(-6).join(' ');
}

function canValidateImagesInBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.Image !== 'undefined';
}

function isVisibleImageUrl(url: string, timeoutMs = 7000): Promise<boolean> {
  if (!canValidateImagesInBrowser()) return Promise.resolve(true);

  return new Promise(resolve => {
    const image = new window.Image();
    const finish = (valid: boolean) => {
      image.onload = null;
      image.onerror = null;
      resolve(valid);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);

    image.onload = () => {
      window.clearTimeout(timer);
      finish(image.naturalWidth > 0 || image.naturalHeight > 0);
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      finish(false);
    };
    image.referrerPolicy = 'no-referrer';
    image.decoding = 'async';
    image.src = url;
  });
}

export async function ensureVisibleImagesOrPrompts(script: string): Promise<string> {
  const normalizedScript = ensureDirectImagesOrPrompts(script);
  if (!canValidateImagesInBrowser()) return normalizedScript;

  const lines = normalizedScript.split('\n');
  const checkedLines = await Promise.all(lines.map(async (line, index) => {
    const trimmed = line.trim();
    const promptMatch = trimmed.match(/^(?:🎨\s*)?AI Image Prompt\s*(\d+)?\s*:\s*(.+)$/i);
    if (promptMatch) {
      const imageNumber = Number(promptMatch[1] || '1');
      const context = getNearbyContext(lines, index);
      const internetUrl = await findVisibleInternetImageUrl(promptMatch[2], context);
      return internetUrl ? `Image ${imageNumber}: ${internetUrl}` : line;
    }

    const imageMatch = trimmed.match(/^Image\s*(\d+)?\s*:\s*(.+)$/i);
    if (!imageMatch) return line;

    const imageNumber = Number(imageMatch[1] || '1');
    const context = getNearbyContext(lines, index);
    const directUrl = extractDirectImageUrl(imageMatch[2]);
    if (!directUrl) {
      const internetUrl = await findVisibleInternetImageUrl(imageMatch[2], context);
      return internetUrl ? `Image ${imageNumber}: ${internetUrl}` : formatImageReference(imageNumber, imageMatch[2], context);
    }

    const isVisible = await isVisibleImageUrl(directUrl);
    if (isVisible) return `Image ${imageNumber}: ${directUrl}`;

    const internetUrl = await findVisibleInternetImageUrl(imageMatch[2], context);
    if (internetUrl) return `Image ${imageNumber}: ${internetUrl}`;

    return formatImageReference(
      imageNumber,
      `image for ${context || imageMatch[2]}`,
      context
    );
  }));

  return checkedLines.join('\n');
}

// Post-process generated script: find image placeholders and try to replace with real images
export async function enrichScriptWithImages(script: string): Promise<string> {
  return ensureVisibleImagesOrPrompts(script);
}
