import mammoth from 'mammoth';
import { ParsedScript, ScriptSection, ScriptPatterns, DocumentFormat, ScriptMetadata } from '../types';

export async function parseWordDocument(file: File): Promise<{
  rawText: string;
  sections: ScriptSection[];
  htmlContent: string;
  format: DocumentFormat;
  metadata: ScriptMetadata;
}> {
  const arrayBuffer = await file.arrayBuffer();
  
  // Extract raw text
  const textResult = await mammoth.extractRawText({ arrayBuffer });
  const rawText = textResult.value;
  
  // Extract HTML for styling information
  const htmlResult = await mammoth.convertToHtml({ arrayBuffer });
  const htmlContent = htmlResult.value;
  
  // Detect format from the document
  const format = detectDocumentFormat(rawText, htmlContent);
  
  // Parse sections from the document with detected format
  const sections = extractSections(rawText, format);
  
  // Extract metadata from the document
  const metadata = extractMetadata(rawText, sections);
  
  return { rawText, sections, htmlContent, format, metadata };
}

function detectDocumentFormat(rawText: string, html: string): DocumentFormat {
  // Detect markers used in the document
  const markers = detectMarkers(rawText);
  
  // Analyze HTML for styling
  const sectionStyles = analyzeHtmlStyles(html, markers);
  
  return {
    defaultFontFamily: detectFontFamily(html) || 'Arial',
    defaultFontSize: detectFontSize(html) || 12,
    sectionStyles,
    markers,
    lineSpacing: 1.15,
    paragraphSpacing: 200,
  };
}

function detectMarkers(text: string): DocumentFormat['markers'] {
  const lines = text.split('\n');
  const markers: DocumentFormat['markers'] = {
    title: [],
    subtitle: [],
    narrator: [],
    visual: [],
    image: [],
    transition: [],
    text: [],
  };
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Title markers
    if (trimmed.match(/^(TITLE|Title)[\s:]/)) {
      const marker = trimmed.match(/^(TITLE|Title)[\s:]/)?.[0] || '';
      if (marker && !markers.title.includes(marker)) markers.title.push(marker);
    }
    if (trimmed.match(/^\[TITLE\]/i)) {
      if (!markers.title.includes('[TITLE]')) markers.title.push('[TITLE]');
    }
    
    // Subtitle markers
    if (trimmed.match(/^(SUBTITLE|Sub|Section|SECTION)[\s:]/i)) {
      const marker = trimmed.match(/^(SUBTITLE|Sub|Section|SECTION)[\s:]/i)?.[0] || '';
      if (marker && !markers.subtitle.includes(marker)) markers.subtitle.push(marker);
    }
    if (trimmed.match(/^\[SUBTITLE\]/i)) {
      if (!markers.subtitle.includes('[SUBTITLE]')) markers.subtitle.push('[SUBTITLE]');
    }
    
    // Narrator markers
    if (trimmed.match(/^(NARRATOR|Voice Over|VO|V\.O\.|Narration|NARRATION)[\s:]/i)) {
      const marker = trimmed.match(/^(NARRATOR|Voice Over|VO|V\.O\.|Narration|NARRATION)[\s:]/i)?.[0] || '';
      if (marker && !markers.narrator.includes(marker)) markers.narrator.push(marker);
    }
    if (trimmed.match(/^\[NARRATOR\]/i) || trimmed.match(/^\[VO\]/i)) {
      const m = trimmed.match(/^\[(NARRATOR|VO)\]/i)?.[0] || '';
      if (m && !markers.narrator.includes(m)) markers.narrator.push(m);
    }
    
    // Visual markers
    if (trimmed.match(/^(VISUAL|Visual Cue|On Screen|ON SCREEN|ONSCREEN)[\s:]/i)) {
      const marker = trimmed.match(/^(VISUAL|Visual Cue|On Screen|ON SCREEN|ONSCREEN)[\s:]/i)?.[0] || '';
      if (marker && !markers.visual.includes(marker)) markers.visual.push(marker);
    }
    if (trimmed.match(/^\[VISUAL\]/i) || trimmed.match(/^\[ON\s*SCREEN\]/i)) {
      const m = trimmed.match(/^\[(VISUAL|ON\s*SCREEN)\]/i)?.[0] || '';
      if (m && !markers.visual.includes(m)) markers.visual.push(m);
    }
    
    // Image markers
    if (trimmed.match(/^(IMAGE|IMG|Picture|PICTURE|Graphic|GRAPHIC)[\s:]/i)) {
      const marker = trimmed.match(/^(IMAGE|IMG|Picture|PICTURE|Graphic|GRAPHIC)[\s:]/i)?.[0] || '';
      if (marker && !markers.image.includes(marker)) markers.image.push(marker);
    }
    if (trimmed.match(/^\[IMAGE\]/i)) {
      if (!markers.image.includes('[IMAGE]')) markers.image.push('[IMAGE]');
    }
    
    // Transition markers
    if (trimmed.match(/^(TRANSITION|CUT TO|FADE|DISSOLVE|WIPE)/i)) {
      const marker = trimmed.match(/^(TRANSITION|CUT TO|FADE|DISSOLVE|WIPE)[^a-zA-Z]*/i)?.[0] || '';
      if (marker && !markers.transition.includes(marker)) markers.transition.push(marker);
    }
    if (trimmed.match(/^\[TRANSITION\]/i)) {
      if (!markers.transition.includes('[TRANSITION]')) markers.transition.push('[TRANSITION]');
    }
    
    // Text markers
    if (trimmed.match(/^\[TEXT\]/i)) {
      if (!markers.text.includes('[TEXT]')) markers.text.push('[TEXT]');
    }
    if (trimmed.match(/^(TEXT|On-Screen Text|SUPER)[\s:]/i)) {
      const marker = trimmed.match(/^(TEXT|On-Screen Text|SUPER)[\s:]/i)?.[0] || '';
      if (marker && !markers.text.includes(marker)) markers.text.push(marker);
    }
  }
  
  // Set defaults if no markers detected
  if (markers.title.length === 0) markers.title.push('[TITLE]');
  if (markers.subtitle.length === 0) markers.subtitle.push('[SUBTITLE]');
  if (markers.narrator.length === 0) markers.narrator.push('[NARRATOR]');
  if (markers.visual.length === 0) markers.visual.push('[VISUAL]');
  if (markers.image.length === 0) markers.image.push('[IMAGE]');
  if (markers.transition.length === 0) markers.transition.push('[TRANSITION]');
  if (markers.text.length === 0) markers.text.push('[TEXT]');
  
  return markers;
}

function analyzeHtmlStyles(html: string, markers: DocumentFormat['markers']): DocumentFormat['sectionStyles'] {
  // Default styles based on common patterns
  const defaultStyles: DocumentFormat['sectionStyles'] = {
    title: {
      fontSize: 24,
      bold: true,
      color: '1A365D',
      alignment: 'center',
      prefix: markers.title[0] || '[TITLE]',
    },
    subtitle: {
      fontSize: 18,
      bold: true,
      color: '2D3748',
      alignment: 'left',
      prefix: markers.subtitle[0] || '[SUBTITLE]',
    },
    narrator: {
      fontSize: 12,
      bold: false,
      color: '000000',
      alignment: 'left',
      prefix: markers.narrator[0] || '[NARRATOR]',
    },
    visual: {
      fontSize: 11,
      italic: true,
      color: '38A169',
      alignment: 'left',
      prefix: markers.visual[0] || '[VISUAL]',
    },
    image: {
      fontSize: 11,
      italic: true,
      color: '805AD5',
      alignment: 'left',
      prefix: markers.image[0] || '[IMAGE]',
    },
    transition: {
      fontSize: 10,
      bold: true,
      color: 'E53E3E',
      alignment: 'center',
      prefix: markers.transition[0] || '[TRANSITION]',
    },
    text: {
      fontSize: 12,
      bold: false,
      color: '000000',
      alignment: 'left',
      prefix: markers.text[0] || '[TEXT]',
    },
  };
  
  // Try to extract actual styles from HTML
  // Look for patterns in the HTML structure
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  // Analyze headings for title styles
  const h1s = doc.querySelectorAll('h1');
  if (h1s.length > 0) {
    defaultStyles.title.fontSize = 24;
    defaultStyles.title.bold = true;
  }
  
  const h2s = doc.querySelectorAll('h2');
  if (h2s.length > 0) {
    defaultStyles.subtitle.fontSize = 18;
    defaultStyles.subtitle.bold = true;
  }
  
  // Check for strong/bold patterns
  const strongs = doc.querySelectorAll('strong, b');
  if (strongs.length > 0) {
    // Analyze which types use bold
  }
  
  // Check for italic patterns
  const italics = doc.querySelectorAll('em, i');
  if (italics.length > 0) {
    // Visual cues often use italics
    defaultStyles.visual.italic = true;
    defaultStyles.image.italic = true;
  }
  
  return defaultStyles;
}

function detectFontFamily(html: string): string | null {
  const fontMatch = html.match(/font-family:\s*['"]?([^'";\}]+)/i);
  return fontMatch ? fontMatch[1].trim() : null;
}

function detectFontSize(html: string): number | null {
  const sizeMatch = html.match(/font-size:\s*(\d+)/i);
  return sizeMatch ? parseInt(sizeMatch[1]) : null;
}

function extractSections(rawText: string, format: DocumentFormat): ScriptSection[] {
  const sections: ScriptSection[] = [];
  const lines = rawText.split('\n').filter(line => line.trim());
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    
    // Check for each type of marker
    let matched = false;
    
    // Title
    for (const marker of format.markers.title) {
      const regex = new RegExp(`^${escapeRegex(marker)}\\s*`, 'i');
      if (trimmedLine.match(regex)) {
        sections.push({
          type: 'title',
          content: trimmedLine.replace(regex, '').trim(),
          style: { ...format.sectionStyles.title, prefix: marker }
        });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    
    // Subtitle
    for (const marker of format.markers.subtitle) {
      const regex = new RegExp(`^${escapeRegex(marker)}\\s*`, 'i');
      if (trimmedLine.match(regex)) {
        sections.push({
          type: 'subtitle',
          content: trimmedLine.replace(regex, '').trim(),
          style: { ...format.sectionStyles.subtitle, prefix: marker }
        });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    
    // Narrator
    for (const marker of format.markers.narrator) {
      const regex = new RegExp(`^${escapeRegex(marker)}\\s*`, 'i');
      if (trimmedLine.match(regex)) {
        sections.push({
          type: 'narrator',
          content: trimmedLine.replace(regex, '').trim(),
          style: { ...format.sectionStyles.narrator, prefix: marker }
        });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    
    // Visual
    for (const marker of format.markers.visual) {
      const regex = new RegExp(`^${escapeRegex(marker)}\\s*`, 'i');
      if (trimmedLine.match(regex)) {
        sections.push({
          type: 'visual',
          content: trimmedLine.replace(regex, '').trim(),
          style: { ...format.sectionStyles.visual, prefix: marker }
        });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    
    // Image
    for (const marker of format.markers.image) {
      const regex = new RegExp(`^${escapeRegex(marker)}\\s*`, 'i');
      if (trimmedLine.match(regex)) {
        sections.push({
          type: 'image',
          content: trimmedLine.replace(regex, '').trim(),
          style: { ...format.sectionStyles.image, prefix: marker }
        });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    
    // Transition
    for (const marker of format.markers.transition) {
      const regex = new RegExp(`^${escapeRegex(marker)}\\s*`, 'i');
      if (trimmedLine.match(regex)) {
        sections.push({
          type: 'transition',
          content: trimmedLine.replace(regex, '').trim() || marker.replace(/[\[\]]/g, ''),
          style: { ...format.sectionStyles.transition, prefix: marker }
        });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    
    // Text
    for (const marker of format.markers.text) {
      const regex = new RegExp(`^${escapeRegex(marker)}\\s*`, 'i');
      if (trimmedLine.match(regex)) {
        sections.push({
          type: 'text',
          content: trimmedLine.replace(regex, '').trim(),
          style: { ...format.sectionStyles.text, prefix: marker }
        });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    
    // Default to text
    sections.push({
      type: 'text',
      content: trimmedLine,
      style: format.sectionStyles.text
    });
  }
  
  return sections;
}

function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function analyzePatterns(scripts: ParsedScript[]): ScriptPatterns {
  const allSections = scripts.flatMap(s => s.sections);
  const allText = scripts.map(s => s.rawText).join('\n');
  
  // Extract common patterns
  const introPatterns = scripts.map(s => {
    const firstFewSections = s.sections.slice(0, 5);
    return firstFewSections.map(sec => `${sec.style?.prefix || sec.type.toUpperCase()} ${sec.content.substring(0, 50)}...`).join('\n');
  });
  
  const conclusionPatterns = scripts.map(s => {
    const lastFewSections = s.sections.slice(-5);
    return lastFewSections.map(sec => `${sec.style?.prefix || sec.type.toUpperCase()} ${sec.content.substring(0, 50)}...`).join('\n');
  });
  
  // Find transition phrases
  const transitionPhrases = allSections
    .filter(s => s.type === 'transition')
    .map(s => s.content);
  
  // Find visual cue patterns
  const visualCues = allSections
    .filter(s => s.type === 'visual' || s.type === 'image')
    .map(s => s.content);
  
  // Extract common phrases (appearing multiple times)
  const phrases = extractCommonPhrases(allText);
  
  // Analyze narrator style
  const narratorSections = allSections.filter(s => s.type === 'narrator');
  const narratorStyle = analyzeNarratorStyle(narratorSections.map(s => s.content));
  
  // Analyze section format
  const sectionTypes = allSections.map(s => s.type);
  const sectionFormat = analyzeSectionFormat(sectionTypes);
  
  return {
    introPattern: introPatterns[0] || '',
    sectionFormat,
    narratorStyle,
    visualCues: [...new Set(visualCues)].slice(0, 10),
    transitionPhrases: [...new Set(transitionPhrases)].slice(0, 10),
    conclusionPattern: conclusionPatterns[0] || '',
    commonPhrases: phrases.slice(0, 20)
  };
}

function extractCommonPhrases(text: string): string[] {
  const phrases: Map<string, number> = new Map();
  const sentences = text.split(/[.!?]+/);
  
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    for (let len = 3; len <= 5 && len <= words.length; len++) {
      for (let i = 0; i <= words.length - len; i++) {
        const phrase = words.slice(i, i + len).join(' ').toLowerCase();
        if (phrase.length > 10) {
          phrases.set(phrase, (phrases.get(phrase) || 0) + 1);
        }
      }
    }
  }
  
  return Array.from(phrases.entries())
    .filter(([_, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([phrase]) => phrase);
}

function analyzeNarratorStyle(narratorContent: string[]): string {
  if (narratorContent.length === 0) return 'conversational';
  
  const allContent = narratorContent.join(' ').toLowerCase();
  const characteristics: string[] = [];
  
  if (allContent.includes('let\'s') || allContent.includes('we\'ll') || allContent.includes('let us')) {
    characteristics.push('inclusive/collaborative');
  }
  if (allContent.includes('imagine') || allContent.includes('think about') || allContent.includes('consider')) {
    characteristics.push('thought-provoking');
  }
  if (allContent.includes('simply') || allContent.includes('basically') || allContent.includes('essentially')) {
    characteristics.push('simplified explanations');
  }
  if (allContent.includes('interestingly') || allContent.includes('surprisingly') || allContent.includes('amazingly')) {
    characteristics.push('engaging/enthusiastic');
  }
  if (allContent.includes('first') || allContent.includes('second') || allContent.includes('next') || allContent.includes('finally')) {
    characteristics.push('structured/sequential');
  }
  
  return characteristics.length > 0 ? characteristics.join(', ') : 'clear and educational';
}

function analyzeSectionFormat(sectionTypes: string[]): string {
  const typeSequence = sectionTypes.slice(0, 20);
  const pattern = typeSequence.reduce((acc, type, i) => {
    if (i === 0) return type;
    if (typeSequence[i - 1] !== type) return acc + ' → ' + type;
    return acc;
  }, '');
  
  return pattern || 'title → narrator → visual → text';
}

export function generateFormatDescription(patterns: ScriptPatterns, sampleScripts: ParsedScript[]): string {
  let description = `SCRIPT FORMAT SPECIFICATIONS:\n\n`;
  
  // Include the exact markers from the sample scripts
  if (sampleScripts.length > 0) {
    const format = sampleScripts[0].format;
    description += `EXACT MARKERS TO USE:\n`;
    description += `- Title marker: ${format.markers.title[0]}\n`;
    description += `- Subtitle marker: ${format.markers.subtitle[0]}\n`;
    description += `- Narrator marker: ${format.markers.narrator[0]}\n`;
    description += `- Visual marker: ${format.markers.visual[0]}\n`;
    description += `- Image marker: ${format.markers.image[0]}\n`;
    description += `- Transition marker: ${format.markers.transition[0]}\n`;
    description += `- Text marker: ${format.markers.text[0]}\n\n`;
  }
  
  description += `1. SECTION FLOW:\n${patterns.sectionFormat}\n\n`;
  
  description += `2. INTRODUCTION PATTERN:\n${patterns.introPattern}\n\n`;
  
  description += `3. NARRATOR STYLE:\n${patterns.narratorStyle}\n\n`;
  
  if (patterns.transitionPhrases.length > 0) {
    description += `4. TRANSITION PHRASES USED:\n${patterns.transitionPhrases.map(p => `- ${p}`).join('\n')}\n\n`;
  }
  
  if (patterns.visualCues.length > 0) {
    description += `5. VISUAL CUE EXAMPLES:\n${patterns.visualCues.slice(0, 5).map(v => `- ${v}`).join('\n')}\n\n`;
  }
  
  description += `6. CONCLUSION PATTERN:\n${patterns.conclusionPattern}\n\n`;
  
  if (patterns.commonPhrases.length > 0) {
    description += `7. COMMONLY USED PHRASES:\n${patterns.commonPhrases.slice(0, 10).map(p => `- "${p}"`).join('\n')}\n\n`;
  }
  
  // Add sample script excerpts with exact formatting
  if (sampleScripts.length > 0) {
    description += `8. SAMPLE SCRIPT EXCERPT (FOLLOW THIS EXACT FORMAT):\n`;
    const sample = sampleScripts[0];
    description += sample.sections.slice(0, 15).map(s => {
      const prefix = s.style?.prefix || `[${s.type.toUpperCase()}]`;
      return `${prefix} ${s.content}`;
    }).join('\n');
  }
  
  return description;
}

export function getDefaultFormat(): DocumentFormat {
  return {
    defaultFontFamily: 'Arial',
    defaultFontSize: 12,
    sectionStyles: {
      title: { fontSize: 24, bold: true, color: '1A365D', alignment: 'center', prefix: '[TITLE]' },
      subtitle: { fontSize: 18, bold: true, color: '2D3748', alignment: 'left', prefix: '[SUBTITLE]' },
      narrator: { fontSize: 12, bold: false, color: '000000', alignment: 'left', prefix: '[NARRATOR]' },
      visual: { fontSize: 11, italic: true, color: '38A169', alignment: 'left', prefix: '[VISUAL]' },
      image: { fontSize: 11, italic: true, color: '805AD5', alignment: 'left', prefix: '[IMAGE]' },
      transition: { fontSize: 10, bold: true, color: 'E53E3E', alignment: 'center', prefix: '[TRANSITION]' },
      text: { fontSize: 12, bold: false, color: '000000', alignment: 'left', prefix: '[TEXT]' },
    },
    markers: {
      title: ['[TITLE]'],
      subtitle: ['[SUBTITLE]'],
      narrator: ['[NARRATOR]'],
      visual: ['[VISUAL]'],
      image: ['[IMAGE]'],
      transition: ['[TRANSITION]'],
      text: ['[TEXT]'],
    },
    lineSpacing: 1.15,
    paragraphSpacing: 200,
  };
}

export function extractMetadata(rawText: string, sections: ScriptSection[]): ScriptMetadata {
  // Extract title from first title section or first line
  const titleSection = sections.find(s => s.type === 'title');
  const title = titleSection?.content || sections[0]?.content?.substring(0, 100) || 'Untitled';
  
  // Detect subject from content
  const subject = detectSubjectFromContent(rawText);
  
  // Calculate word count
  const wordCount = rawText.split(/\s+/).filter(w => w.length > 0).length;
  
  // Estimate duration based on word count and sections
  // Average speaking rate: 130-150 words per minute for educational content
  const estimatedDuration = estimateDuration(wordCount, sections.length);
  
  // Detect target audience from language complexity
  const targetAudience = detectTargetAudience(rawText, sections);
  
  return {
    title,
    subject,
    targetAudience,
    estimatedDuration,
    wordCount,
    sectionCount: sections.length,
  };
}

function detectSubjectFromContent(text: string): string {
  const lowerText = text.toLowerCase();
  
  // Biology keywords
  if (lowerText.match(/\b(cell|dna|rna|protein|organism|species|evolution|genetics|photosynthesis|mitosis|meiosis|enzyme|bacteria|virus|ecology|anatomy|physiology)\b/)) {
    return 'Biology';
  }
  
  // Physics keywords
  if (lowerText.match(/\b(force|velocity|acceleration|momentum|energy|wave|frequency|electric|magnetic|quantum|relativity|gravity|newton|thermodynamics|optics)\b/)) {
    return 'Physics';
  }
  
  // Chemistry keywords
  if (lowerText.match(/\b(element|compound|molecule|atom|reaction|bond|acid|base|ion|electron|proton|neutron|periodic|oxidation|reduction|solution)\b/)) {
    return 'Chemistry';
  }
  
  // Mathematics keywords
  if (lowerText.match(/\b(equation|formula|theorem|algebra|calculus|geometry|trigonometry|derivative|integral|matrix|vector|polynomial|function|graph)\b/)) {
    return 'Mathematics';
  }
  
  // History keywords
  if (lowerText.match(/\b(century|war|empire|civilization|revolution|ancient|medieval|colonial|independence|dynasty|king|queen|president|treaty)\b/)) {
    return 'History';
  }
  
  // Geography keywords
  if (lowerText.match(/\b(continent|country|climate|weather|ocean|mountain|river|population|latitude|longitude|ecosystem|biome|tectonic|erosion)\b/)) {
    return 'Geography';
  }
  
  // Computer Science keywords
  if (lowerText.match(/\b(algorithm|programming|code|software|database|network|computer|binary|data|function|variable|loop|array|object)\b/)) {
    return 'Computer Science';
  }
  
  // Economics keywords
  if (lowerText.match(/\b(economy|market|supply|demand|inflation|gdp|trade|investment|fiscal|monetary|budget|tax|price|cost)\b/)) {
    return 'Economics';
  }
  
  return 'General';
}

function estimateDuration(wordCount: number, sectionCount: number): string {
  // Educational video speaking rate: ~130 words per minute
  // Add time for visuals/transitions: ~10 seconds per visual/transition
  const speakingMinutes = wordCount / 130;
  const visualTime = sectionCount * 0.15; // ~10 seconds average per section for visuals
  const totalMinutes = speakingMinutes + visualTime;
  
  if (totalMinutes <= 3) {
    return '2-3 minutes';
  } else if (totalMinutes <= 6) {
    return '5 minutes';
  } else if (totalMinutes <= 12) {
    return '10 minutes';
  } else if (totalMinutes <= 18) {
    return '15 minutes';
  } else {
    return '20+ minutes';
  }
}

function detectTargetAudience(text: string, sections: ScriptSection[]): string {
  const lowerText = text.toLowerCase();
  const narratorContent = sections
    .filter(s => s.type === 'narrator')
    .map(s => s.content)
    .join(' ')
    .toLowerCase();
  
  // Calculate average sentence length
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const avgSentenceLength = sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) / Math.max(sentences.length, 1);
  
  // Calculate vocabulary complexity (approximate)
  const words = text.toLowerCase().split(/\s+/);
  const longWords = words.filter(w => w.length > 8).length;
  const complexityRatio = longWords / Math.max(words.length, 1);
  
  // Check for simple/child-friendly indicators
  const hasSimpleLanguage = narratorContent.includes('let\'s learn') || 
                            narratorContent.includes('fun fact') ||
                            narratorContent.includes('boys and girls') ||
                            narratorContent.includes('kids');
  
  // Check for advanced/college-level indicators
  const hasAdvancedLanguage = lowerText.includes('furthermore') ||
                              lowerText.includes('consequently') ||
                              lowerText.includes('notwithstanding') ||
                              lowerText.includes('hypothesis') ||
                              lowerText.includes('methodology');
  
  // Determine audience based on indicators
  if (hasSimpleLanguage || (avgSentenceLength < 12 && complexityRatio < 0.05)) {
    return 'Elementary School (6-10 years)';
  } else if (avgSentenceLength < 15 && complexityRatio < 0.1) {
    return 'Middle School (11-14 years)';
  } else if (hasAdvancedLanguage || complexityRatio > 0.2) {
    return 'College/University';
  } else if (avgSentenceLength > 20 || complexityRatio > 0.15) {
    return 'Adult Learners';
  } else {
    return 'High School (15-18 years)';
  }
}

export function getDefaultMetadata(): ScriptMetadata {
  return {
    title: '',
    subject: 'General',
    targetAudience: 'High School (15-18 years)',
    estimatedDuration: '5 minutes',
    wordCount: 0,
    sectionCount: 0,
  };
}
