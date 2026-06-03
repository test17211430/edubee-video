// Analyze book content to auto-detect topic, subject, audience, and duration

export interface ContentMetadata {
  topic: string;
  subject: string;
  targetAudience: string;
  estimatedDuration: string;
  wordCount: number;
}

export function analyzeBookContent(content: string): ContentMetadata {
  const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
  
  return {
    topic: extractTopic(content),
    subject: detectSubject(content),
    targetAudience: detectAudience(content),
    estimatedDuration: estimateDuration(wordCount),
    wordCount,
  };
}

function extractTopic(content: string): string {
  const lines = content.split('\n').filter(line => line.trim());
  
  // Look for common title patterns
  for (const line of lines.slice(0, 10)) {
    const trimmed = line.trim();
    
    // Skip very short lines or lines that look like metadata
    if (trimmed.length < 5 || trimmed.length > 100) continue;
    
    // Check for title-like patterns
    // All caps line (likely a heading)
    if (trimmed === trimmed.toUpperCase() && trimmed.length > 5 && trimmed.length < 80) {
      return toTitleCase(trimmed);
    }
    
    // Line ending with colon (likely a section header, skip)
    if (trimmed.endsWith(':')) continue;
    
    // First substantial line that's not a bullet point or number
    if (!trimmed.match(/^[\d\-\*\•\→]/) && trimmed.length > 10 && trimmed.length < 80) {
      // Check if it looks like a title (no period at end, capitalized)
      if (!trimmed.endsWith('.') && trimmed[0] === trimmed[0].toUpperCase()) {
        return trimmed;
      }
    }
  }
  
  // Fallback: Extract key noun phrases from first paragraph
  const firstPara = lines.slice(0, 3).join(' ');
  const keyPhrases = extractKeyPhrases(firstPara);
  if (keyPhrases.length > 0) {
    return keyPhrases[0];
  }
  
  return '';
}

function extractKeyPhrases(text: string): string[] {
  // Look for phrases that could be topics
  const patterns = [
    /(?:introduction to|understanding|basics of|fundamentals of|guide to|learning about|exploring)\s+([A-Za-z\s]+)/gi,
    /(?:what is|definition of|concept of)\s+([A-Za-z\s]+)/gi,
  ];
  
  const phrases: string[] = [];
  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[1] && match[1].trim().length > 3) {
        phrases.push(toTitleCase(match[1].trim()));
      }
    }
  }
  
  return phrases;
}

function toTitleCase(str: string): string {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function detectSubject(content: string): string {
  const lowerContent = content.toLowerCase();
  const explicitSubject = extractExplicitSubject(content);
  if (explicitSubject) return explicitSubject;
  
  // Count keyword matches for each subject
  const subjectKeywords: Record<string, string[]> = {
    'Biology': ['cell', 'dna', 'rna', 'protein', 'organism', 'species', 'evolution', 'genetics', 
                'photosynthesis', 'mitosis', 'meiosis', 'enzyme', 'bacteria', 'virus', 'ecology', 
                'anatomy', 'physiology', 'chromosome', 'gene', 'plant', 'animal', 'tissue', 'organ',
                'respiration', 'metabolism', 'chlorophyll', 'nucleus', 'membrane'],
    'Physics': ['force', 'velocity', 'acceleration', 'momentum', 'energy', 'wave', 'frequency', 
                'electric', 'magnetic', 'quantum', 'relativity', 'gravity', 'newton', 'thermodynamics', 
                'optics', 'motion', 'mass', 'power', 'voltage', 'current', 'resistance', 'friction',
                'kinetic', 'potential', 'electromagnetic', 'photon', 'atom'],
    'Chemistry': ['element', 'compound', 'molecule', 'atom', 'reaction', 'bond', 'acid', 'base', 
                  'ion', 'electron', 'proton', 'neutron', 'periodic', 'oxidation', 'reduction', 
                  'solution', 'chemical', 'mole', 'valence', 'covalent', 'ionic', 'catalyst',
                  'equilibrium', 'concentration', 'ph'],
    'Mathematics': ['equation', 'formula', 'theorem', 'algebra', 'calculus', 'geometry', 'trigonometry', 
                    'derivative', 'integral', 'matrix', 'vector', 'polynomial', 'function', 'graph',
                    'number', 'variable', 'coefficient', 'quadratic', 'linear', 'exponential',
                    'logarithm', 'probability', 'statistics', 'angle', 'triangle'],
    'History': ['century', 'war', 'empire', 'civilization', 'revolution', 'ancient', 'medieval', 
                'colonial', 'independence', 'dynasty', 'king', 'queen', 'president', 'treaty',
                'battle', 'conquest', 'era', 'period', 'historical', 'kingdom'],
    'Geography': ['continent', 'country', 'climate', 'weather', 'ocean', 'mountain', 'river', 
                  'population', 'latitude', 'longitude', 'ecosystem', 'biome', 'tectonic', 'erosion',
                  'region', 'terrain', 'atmosphere', 'environment', 'map', 'location'],
    'Computer Science': ['algorithm', 'programming', 'code', 'software', 'database', 'network', 
                         'computer', 'binary', 'data', 'function', 'variable', 'loop', 'array', 
                         'object', 'class', 'method', 'api', 'server', 'client', 'html', 'css'],
    'Economics': ['economy', 'market', 'supply', 'demand', 'inflation', 'gdp', 'trade', 'investment', 
                  'fiscal', 'monetary', 'budget', 'tax', 'price', 'cost', 'profit', 'revenue',
                  'economic', 'finance', 'capital', 'interest'],
    'Environmental Science': ['environment', 'pollution', 'conservation', 'sustainable', 'ecosystem',
                              'biodiversity', 'carbon', 'emission', 'renewable', 'climate change',
                              'global warming', 'recycle', 'waste', 'deforestation', 'endangered'],
  };
  
  const scores: Record<string, number> = {};
  
  for (const [subject, keywords] of Object.entries(subjectKeywords)) {
    scores[subject] = 0;
    for (const keyword of keywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      const matches = lowerContent.match(regex);
      if (matches) {
        scores[subject] += matches.length;
      }
    }
  }
  
  // Find subject with highest score
  let maxScore = 0;
  let detectedSubject = 'General';
  
  for (const [subject, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      detectedSubject = subject;
    }
  }
  
  // Only return detected subject if we have enough confidence.
  return maxScore >= 3 ? detectedSubject : 'General';
}

const KNOWN_SUBJECTS = [
  'Biology',
  'Physics',
  'Chemistry',
  'Mathematics',
  'History',
  'Geography',
  'Computer Science',
  'Economics',
  'Environmental Science',
  'English',
  'General',
  'Other',
];

function canonicalSubject(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  for (const subject of KNOWN_SUBJECTS) {
    if (cleaned.includes(subject.toLowerCase())) return subject;
  }

  if (/\blife science\b|\banatomy\b|\bphysiology\b/.test(cleaned)) return 'Biology';
  if (/\bmaths?\b|\balgebra\b|\bgeometry\b/.test(cleaned)) return 'Mathematics';
  if (/\bcs\b|\bcomputing\b|\binformation technology\b/.test(cleaned)) return 'Computer Science';
  if (/\benvironment\b|\becology\b/.test(cleaned)) return 'Environmental Science';
  return '';
}

function extractExplicitSubject(content: string): string {
  const lines = content.split(/\r?\n/).slice(0, 80);
  for (const line of lines) {
    const match = line.match(/\b(?:subject|discipline|course subject)\s*[:\-]\s*([^\n\r]{2,80})/i);
    if (!match) continue;
    const subject = canonicalSubject(match[1]);
    if (subject) return subject;
  }
  return '';
}

function detectAudience(content: string): string {
  const explicitAudience = extractExplicitAudience(content);
  if (explicitAudience) return explicitAudience;

  const lowerContent = content.toLowerCase();
  
  // Calculate metrics
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const words = content.split(/\s+/).filter(w => w.length > 0);
  
  if (sentences.length === 0 || words.length === 0) {
    return 'High School (15-18 years)';
  }
  
  // Average sentence length
  const avgSentenceLength = words.length / sentences.length;
  
  // Vocabulary complexity (words with 3+ syllables or 8+ characters)
  const complexWords = words.filter(w => w.length > 8).length;
  const complexityRatio = complexWords / words.length;
  
  // Check for simple language indicators
  const hasSimpleIndicators = lowerContent.includes('let\'s learn') || 
                              lowerContent.includes('fun fact') ||
                              lowerContent.includes('did you know') ||
                              lowerContent.includes('for kids') ||
                              lowerContent.includes('boys and girls') ||
                              lowerContent.includes('easy to understand');
  
  // Check for advanced language indicators
  const hasAdvancedIndicators = lowerContent.includes('furthermore') ||
                                lowerContent.includes('consequently') ||
                                lowerContent.includes('notwithstanding') ||
                                lowerContent.includes('hypothesis') ||
                                lowerContent.includes('methodology') ||
                                lowerContent.includes('theoretical framework') ||
                                lowerContent.includes('empirical') ||
                                lowerContent.includes('dissertation');

  const hasWorkplaceAudienceIndicators = lowerContent.includes('adult learners') ||
                                lowerContent.includes('working professionals') ||
                                lowerContent.includes('workplace training') ||
                                lowerContent.includes('corporate employees') ||
                                lowerContent.includes('job seekers') ||
                                lowerContent.includes('employability training');
  
  // Determine audience
  if (hasSimpleIndicators || (avgSentenceLength < 12 && complexityRatio < 0.05)) {
    return 'Elementary School (6-10 years)';
  } else if (hasWorkplaceAudienceIndicators) {
    return 'Adult Learners';
  } else if (avgSentenceLength < 15 && complexityRatio < 0.1) {
    return 'Middle School (11-14 years)';
  } else if (hasAdvancedIndicators || complexityRatio > 0.2) {
    return 'College/University';
  } else if (avgSentenceLength > 25 || complexityRatio > 0.18) {
    return 'Adult Learners';
  } else {
    return 'High School (15-18 years)';
  }
}

function audienceFromAgeRange(minAge: number, maxAge: number): string {
  if (maxAge <= 10) return 'Elementary School (6-10 years)';
  if (minAge >= 11 && maxAge <= 14) return 'Middle School (11-14 years)';
  if (minAge >= 16 && maxAge <= 18) return 'Senior Secondary (16-18 years)';
  if (minAge >= 15 && maxAge <= 18) return 'High School (15-18 years)';
  if (minAge >= 18 && maxAge <= 24) return 'College/University';
  if (minAge >= 18) return 'Adult Learners';
  if (maxAge <= 14) return 'Middle School (11-14 years)';
  return 'High School (15-18 years)';
}

function audienceFromGradeRange(minGrade: number, maxGrade: number): string {
  if (maxGrade <= 5) return 'Elementary School (6-10 years)';
  if (minGrade >= 6 && maxGrade <= 8) return 'Middle School (11-14 years)';
  if (minGrade >= 11 && maxGrade <= 12) return 'Senior Secondary (16-18 years)';
  if (minGrade >= 9 && maxGrade <= 12) return 'High School (15-18 years)';
  if (minGrade >= 13) return 'College/University';
  return 'High School (15-18 years)';
}

function extractExplicitAudience(content: string): string {
  const source = content.replace(/[–—]/g, '-');
  const snippet = source.split(/\r?\n/).slice(0, 120).join('\n');
  const lowerSnippet = snippet.toLowerCase();

  const agePatterns = [
    /\b(?:target\s+age|age\s+group|ages?|aged|students?\s+aged|learners?\s+aged)\s*[:\-]?\s*(\d{1,2})\s*(?:-|to)\s*(\d{1,2})\s*(?:years?|yrs?|year\s*olds?)?/gi,
    /\b(?:target\s+audience|audience|learners?|students?)\b[^\n\r]{0,80}?(\d{1,2})\s*(?:-|to)\s*(\d{1,2})\s*(?:years?|yrs?|year\s*olds?)/gi,
  ];

  for (const pattern of agePatterns) {
    for (const match of snippet.matchAll(pattern)) {
      const minAge = Number(match[1]);
      const maxAge = Number(match[2]);
      if (Number.isFinite(minAge) && Number.isFinite(maxAge)) {
        return audienceFromAgeRange(Math.min(minAge, maxAge), Math.max(minAge, maxAge));
      }
    }
  }

  const gradePattern = /\b(?:grade|class|standard|std)\s*[:\-]?\s*(\d{1,2})(?:\s*(?:-|to)\s*(\d{1,2}))?/gi;
  for (const match of snippet.matchAll(gradePattern)) {
    const first = Number(match[1]);
    const second = Number(match[2] || match[1]);
    if (Number.isFinite(first) && Number.isFinite(second)) {
      return audienceFromGradeRange(Math.min(first, second), Math.max(first, second));
    }
  }

  if (/\belementary school\b|\bprimary school\b|\bfor kids\b/.test(lowerSnippet)) return 'Elementary School (6-10 years)';
  if (/\bmiddle school\b|\bjunior school\b/.test(lowerSnippet)) return 'Middle School (11-14 years)';
  if (/\bsenior secondary\b|\bclass\s*(?:11|12)\b|\bgrade\s*(?:11|12)\b/.test(lowerSnippet)) return 'Senior Secondary (16-18 years)';
  if (/\bhigh school\b|\bsecondary school\b/.test(lowerSnippet)) return 'High School (15-18 years)';
  if (/\bcollege\b|\buniversity\b|\bundergraduate\b/.test(lowerSnippet)) return 'College/University';
  if (/\badult learners\b|\bworking professionals\b|\bcorporate employees\b|\bjob seekers\b/.test(lowerSnippet)) return 'Adult Learners';
  if (/\bgeneral audience\b/.test(lowerSnippet)) return 'General Audience';

  return '';
}

function estimateDuration(wordCount: number): string {
  // Educational video speaking rate: ~120-140 words per minute
  // We use 130 as average, plus add 30% for pauses, visuals, etc.
  const effectiveWPM = 100; // words per minute considering pauses and visuals
  const minutes = wordCount / effectiveWPM;
  
  if (minutes <= 3) {
    return '2-3 minutes';
  } else if (minutes <= 6) {
    return '5 minutes';
  } else if (minutes <= 12) {
    return '10 minutes';
  } else if (minutes <= 18) {
    return '15 minutes';
  } else {
    return '20+ minutes';
  }
}
