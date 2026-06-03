export interface ScriptSection {
  type: 'title' | 'subtitle' | 'narrator' | 'visual' | 'text' | 'transition' | 'image' | 'frame' | 'audio_cue' | 'video_details' | 'editor_notes';
  content: string;
  style?: SectionStyle;
  frameType?: string; // Title Screen, Wide, Wide with Image, Null, Summary
  visualInstructions?: string;
  imageUrls?: string[];
  bodyText?: string[];
  headerText?: string;
}

export interface SectionStyle {
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  alignment?: 'left' | 'center' | 'right';
  prefix?: string;
}

export interface VideoDetails {
  subject: string;
  chapter: string;
  topic: string;
  videoTitle: string;
  alphaChannelLink?: string;
  learningObjective: string;
  numberOfMCQ?: number;
}

export interface EditorNotes {
  fontAndColors: string;
  frameTypes: string[];
}

export interface FrameScript {
  audioCues: string[];
  frameType: string;
  headerText?: string;
  bodyText?: string[];
  visualInstructions?: string[];
  imageUrls?: string[];
}

export interface DocumentFormat {
  defaultFontFamily: string;
  defaultFontSize: number;
  sectionStyles: {
    title: SectionStyle;
    subtitle: SectionStyle;
    narrator: SectionStyle;
    visual: SectionStyle;
    image: SectionStyle;
    transition: SectionStyle;
    text: SectionStyle;
  };
  markers: {
    title: string[];
    subtitle: string[];
    narrator: string[];
    visual: string[];
    image: string[];
    transition: string[];
    text: string[];
  };
  lineSpacing: number;
  paragraphSpacing: number;
  
  // PicEd specific format
  isPicEdFormat?: boolean;
  frameTypes?: string[];
  editorNotes?: EditorNotes;
}

export interface ScriptMetadata {
  title: string;
  subject: string;
  chapter?: string;
  topic?: string;
  targetAudience: string;
  estimatedDuration: string;
  wordCount: number;
  sectionCount: number;
  learningObjective?: string;
}

export interface ParsedScript {
  id: string;
  name: string;
  subject: string;
  sections: ScriptSection[];
  rawText: string;
  htmlContent: string;
  patterns: ScriptPatterns;
  format: DocumentFormat;
  metadata: ScriptMetadata;
  
  // PicEd specific
  videoDetails?: VideoDetails;
  editorNotes?: EditorNotes;
  frameScripts?: FrameScript[];
}

export interface ScriptPatterns {
  introPattern: string;
  sectionFormat: string;
  narratorStyle: string;
  visualCues: string[];
  transitionPhrases: string[];
  conclusionPattern: string;
  commonPhrases: string[];
}

export interface GenerationRequest {
  topic: string;
  subject: string;
  chapter?: string;
  bookContent: string;
  targetAudience: string;
  duration: string;
  learningObjective?: string;
  teacherName?: string;
  preserveAudioCues?: boolean;
  strictFrameByFrame?: boolean;
}

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface BookContentSource {
  type: 'text' | 'word' | 'image';
  content: string;
  fileName?: string;
}
