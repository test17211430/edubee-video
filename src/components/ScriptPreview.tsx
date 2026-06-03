import { useEffect, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Eye, Download, RefreshCw, Copy, Check, Edit3, MessageSquare,
  FileText, Mic, Image, Type, Loader2, Video, Settings, Layout, Printer, AlertCircle, Minimize2
} from 'lucide-react';
import { ParsedScript } from '../types';
import { downloadPDF, downloadWord, parseRawScript } from '../utils/wordGenerator';
import { getConnectedRefineFields, refineScript, isGroqInitialized } from '../utils/groqService';
import type { RefineField } from '../utils/groqService';

interface ScriptPreviewProps {
  generatedScript: string;
  topic: string;
  subject: string;
  sampleScripts: ParsedScript[];
  onRefine: (newScript: string) => void;
  meta?: { chapter?: string; topic?: string; learningObjective?: string; preserveAudioCues?: boolean };
  isFullscreen?: boolean;
  onMinimize?: () => void;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

function getUrl(text: string): string | null {
  return text.match(/https?:\/\/\S+/i)?.[0] || null;
}

const REFINE_FIELD_OPTIONS: Array<{ value: RefineField; label: string }> = [
  { value: 'audioCues', label: 'Audio Cues' },
  { value: 'frameType', label: 'Frame' },
  { value: 'header', label: 'Header' },
  { value: 'bodyText', label: 'Body Text' },
  { value: 'visualInstructions', label: 'Visual Instructions' },
  { value: 'imagePrompts', label: 'Image Prompts' },
];

const WHOLE_SLIDE_REFINE_FIELDS: RefineField[] = [
  'audioCues',
  'header',
  'bodyText',
  'visualInstructions',
];

type DetailLevel = 'level1' | 'level2' | 'level3';

const DETAIL_LEVEL_OPTIONS: Array<{
  value: DetailLevel;
  label: string;
  description: string;
}> = [
  {
    value: 'level1',
    label: 'Level 1',
    description: 'Light improvement with clearer wording and concise supporting points.',
  },
  {
    value: 'level2',
    label: 'Level 2',
    description: 'Moderate detail across the full slide with stronger body and visuals.',
  },
  {
    value: 'level3',
    label: 'Level 3',
    description: 'Deep rewrite of the full slide with richer explanation and visual support.',
  },
];

function getFrameHeading(visualization: string): string {
  const lines = visualization.split('\n').map(line => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    if (/^(Null Screen Header|Title Text):?$/i.test(lines[index])) {
      return lines[index + 1] || '';
    }
  }
  return '';
}

function frameOptionLabel(frameType: string, visualization: string, index: number): string {
  const heading = getFrameHeading(visualization);
  return `Screen ${index + 1}: ${frameType || 'Frame'}${heading ? ` - ${heading}` : ''}`;
}

interface FrameHighlights {
  audioLines: number[];
  frameType: boolean;
  visualizationLines: number[];
}

interface RefineHighlights {
  script: string;
  beforeScript: string;
  summary: string;
  rawLines: number[];
  frames: FrameHighlights[];
}

interface HighlightTarget {
  frameIndex: number;
  field: RefineField;
  label: string;
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

function changedLineIndexes(before: string[], after: string[]): number[] {
  const oldLines = before.map(normalizeLine);
  const newLines = after.map(normalizeLine);
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const dp = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const unchanged = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      unchanged.add(j);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return newLines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => line && !unchanged.has(index))
    .map(({ index }) => index);
}

function scriptSignature(script: string): string {
  return script
    .split('\n')
    .map(normalizeLine)
    .filter(Boolean)
    .join('\n');
}

function changedBlockIndexes(beforeScript: string, afterScript: string): number[] {
  const beforeBlocks = beforeScript.split('<<<ROW>>>').map(normalizeLine);
  const afterBlocks = afterScript.split('<<<ROW>>>').map(normalizeLine);
  return afterBlocks
    .map((block, index) => ({ block, index }))
    .filter(({ block, index }) => block && block !== (beforeBlocks[index] || ''))
    .map(({ index }) => index);
}

function sectionLineIndexes(lines: string[], section: RefineField): number[] {
  if (section === 'audioCues' || section === 'frameType') return [];
  const indexes = new Set<number>();
  const sectionStarts: Record<Exclude<RefineField, 'audioCues' | 'frameType'>, RegExp> = {
    header: /^(Null Screen Header|Title Text):?$/i,
    bodyText: /^Body Text:?$/i,
    visualInstructions: /^(Visual\/Animation Instructions|Audio\/Animation Cues):?$/i,
    imagePrompts: /^(📌|Image Suggestions?:?|Image\s*\d*\s*:|AI Image Prompt\s*\d*\s*:)/i,
  };
  const hardStops = /^(Null Screen Header|Title Text|Body Text|Visual\/Animation Instructions|Audio\/Animation Cues|📌|Image Suggestions?):?$/i;

  for (let index = 0; index < lines.length; index += 1) {
    if (!sectionStarts[section].test(lines[index].trim())) continue;
    indexes.add(index);
    for (let next = index + 1; next < lines.length; next += 1) {
      const trimmed = lines[next].trim();
      if (!trimmed) break;
      if (hardStops.test(trimmed) && !sectionStarts[section].test(trimmed)) break;
      indexes.add(next);
      if (section === 'imagePrompts' && !/^(Image\s*\d*\s*:|AI Image Prompt\s*\d*\s*:)/i.test(trimmed)) break;
    }
  }

  return [...indexes];
}

function fallbackFrameHighlight(frame: { audioCues: string; visualization: string }, fields: RefineField[]): FrameHighlights {
  const vizLines = frame.visualization.split('\n');
  return {
    audioLines: fields.includes('audioCues')
      ? frame.audioCues.split('\n').map((line, index) => line.trim() ? index : -1).filter(index => index >= 0)
      : [],
    frameType: fields.includes('frameType'),
    visualizationLines: fields.flatMap(field => sectionLineIndexes(vizLines, field)),
  };
}

function hasFrameHighlights(frame: FrameHighlights): boolean {
  return frame.frameType || frame.audioLines.length > 0 || frame.visualizationLines.length > 0;
}

function refineFieldLabel(field: RefineField): string {
  return REFINE_FIELD_OPTIONS.find(option => option.value === field)?.label || 'Updated Text';
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] || '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

function buildRefineSummary(params: {
  frames: FrameHighlights[];
  scope?: { frameIndexes?: number[]; fields?: RefineField[] };
  feedback: string;
}): string {
  const selectedFields = params.scope?.fields || [];
  const effectiveFields = getConnectedRefineFields(selectedFields);
  const fieldLabels = effectiveFields.map(refineFieldLabel);
  const connectedLabels = effectiveFields
    .filter(field => !selectedFields.includes(field))
    .map(refineFieldLabel);
  const changedFrames = params.frames
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => hasFrameHighlights(frame))
    .map(({ index }) => index);
  const frameIndexes = changedFrames.length > 0 ? changedFrames : (params.scope?.frameIndexes || []);
  const frameLabel = frameIndexes.length === 0
    ? 'the selected script'
    : frameIndexes.length <= 4
      ? frameIndexes.map(index => `Screen ${index + 1}`).join(', ')
      : `${frameIndexes.length} screens`;
  const request = params.feedback.trim().replace(/\s+/g, ' ').slice(0, 120);
  const connectedText = connectedLabels.length > 0
    ? ` Connected sections were included: ${joinLabels(connectedLabels)}.`
    : '';

  return `Updated ${joinLabels(fieldLabels) || 'the selected sections'} on ${frameLabel}.${connectedText} Basis: "${request || 'refine request'}", same-slide content, previous/next slide flow, and the 20-word Body Text rule.`;
}

function buildHighlights(beforeScript: string, afterScript: string, meta: {
  topic: string; subject: string; chapter?: string; learningObjective?: string;
}, scope?: { frameIndexes?: number[]; fields?: RefineField[] }, feedback = ''): RefineHighlights {
  const parseMeta = {
    videoTitle: meta.topic,
    subject: meta.subject,
    chapter: meta.chapter || '',
    topic: meta.topic,
    learningObjective: meta.learningObjective || '',
  };
  const before = parseRawScript(beforeScript, parseMeta);
  const after = parseRawScript(afterScript, parseMeta);

  const highlights: RefineHighlights = {
    script: afterScript,
    beforeScript,
    summary: '',
    rawLines: changedLineIndexes(beforeScript.split('\n'), afterScript.split('\n')),
    frames: after.frames.map((frame, index) => {
      const oldFrame = before.frames[index];
      return {
        audioLines: changedLineIndexes(oldFrame?.audioCues.split('\n') || [], frame.audioCues.split('\n')),
        frameType: normalizeLine(oldFrame?.frameType || '') !== normalizeLine(frame.frameType || ''),
        visualizationLines: changedLineIndexes(oldFrame?.visualization.split('\n') || [], frame.visualization.split('\n')),
      };
    }),
  };

  const fields = scope?.fields || [];
  const changedBlocks = changedBlockIndexes(beforeScript, afterScript);
  highlights.frames = highlights.frames.map((frameHighlight, index) => {
    if (hasFrameHighlights(frameHighlight)) return frameHighlight;
    const isChangedBlock = changedBlocks.includes(index);
    const isSelectedFrame = !scope?.frameIndexes || scope.frameIndexes.includes(index);
    if (!isChangedBlock || !isSelectedFrame || fields.length === 0) return frameHighlight;
    return fallbackFrameHighlight(after.frames[index], fields);
  });
  highlights.summary = buildRefineSummary({
    frames: highlights.frames,
    scope,
    feedback,
  });

  return highlights;
}

function highlightStyle(enabled: boolean): CSSProperties | undefined {
  return enabled
    ? {
      backgroundColor: '#FEF08A',
      boxShadow: '0 0 0 2px #F59E0B inset',
      borderRadius: '4px',
      paddingLeft: '4px',
      paddingRight: '4px',
      cursor: 'pointer',
    }
    : undefined;
}

function fieldForVisualizationLine(visualization: string, lineIndex: number): RefineField {
  const lines = visualization.split('\n').map(line => line.trim());
  let current: RefineField = 'visualInstructions';

  for (let index = 0; index <= lineIndex; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (/^(Null Screen Header|Title Text):?$/i.test(line)) current = 'header';
    else if (/^Body Text:?$/i.test(line)) current = 'bodyText';
    else if (/^(Visual\/Animation Instructions|Audio\/Animation Cues):?$/i.test(line)) current = 'visualInstructions';
    else if (/^(📌|Image Suggestions?:?|Image\s*\d*\s*:|AI Image Prompt\s*\d*\s*:)/i.test(line)) current = 'imagePrompts';
  }

  return current;
}

function targetLabel(frame: { frameType: string; visualization: string }, frameIndex: number, field: RefineField): string {
  const fieldLabel = refineFieldLabel(field);
  return `${frameOptionLabel(frame.frameType, frame.visualization, frameIndex)} · ${fieldLabel}`;
}

function selectedTextMatchesFrame(frame: { audioCues: string; frameType: string; visualization: string }, selectedText: string): boolean {
  const selected = normalizeLine(selectedText).toLowerCase();
  if (!selected) return false;
  const haystack = normalizeLine(`${frame.audioCues} ${frame.frameType} ${frame.visualization}`).toLowerCase();
  if (haystack.includes(selected)) return true;

  const selectedWords = selected.split(/\s+/).filter(word => word.length > 2);
  if (selectedWords.length < 3) return false;
  const matchedWords = selectedWords.filter(word => haystack.includes(word)).length;
  return matchedWords / selectedWords.length >= 0.75;
}

function detailLevelInstruction(level: DetailLevel, preserveAudioCues: boolean): string {
  const sections = preserveAudioCues
    ? 'Body Text and Visual/Animation or Audio/Animation Cues'
    : 'Body Text, Audio Cues, and Visual/Animation or Audio/Animation Cues';
  const levelExampleSection = preserveAudioCues ? 'Body Text' : 'Audio Cues';

  if (level === 'level3') {
    return `DETAIL LEVEL 3: first count how many points or sentences exist in each editable section: ${sections}. Then expand each counted point or sentence with about 5-10 useful words where context allows. Example: if ${levelExampleSection} has 3 sentences, add about 15-30 total useful words across that editable section. Keep existing ideas and order. Add new items only if the subject matter truly needs them. Body Text items must stay within 20 words and may be points, sentences, formulas, equations, or labels depending on the screen and subject.`;
  }
  if (level === 'level2') {
    return `DETAIL LEVEL 2: first count how many points or sentences exist in each editable section: ${sections}. Then expand each counted point or sentence with about 5-6 useful words where context allows. Example: if ${levelExampleSection} has 3 sentences, add about 15-18 total useful words across that editable section. Preserve existing ideas and order. Add or split items only when needed for clarity or the 20-word Body Text limit. Body Text may be points, sentences, formulas, equations, or labels depending on the screen and subject.`;
  }
  return `DETAIL LEVEL 1: first count how many points or sentences exist in each editable section: ${sections}. Then expand each counted point or sentence with about 1-2 useful words where context allows. Example: if ${levelExampleSection} has 3 sentences, add about 3-6 total useful words across that editable section. Preserve existing ideas, order, and item count unless a small fix is needed. Body Text must stay within 20 words and may be points, sentences, formulas, equations, or labels depending on the screen and subject.`;
}

function buildWholeSlideRefineInstruction(
  feedback: string,
  level: DetailLevel,
  targetText: string,
  preserveAudioCues: boolean
): string {
  const target = targetText.trim()
    ? `\nSPECIFIC SELECTED WORD/SENTENCE TO CHANGE: "${targetText.trim()}". Update that concept everywhere it affects the selected slide, ${preserveAudioCues ? 'excluding Audio Cues because they are locked' : 'including audio'}, body text, and visual instructions.`
    : '';
  const audioLock = preserveAudioCues
    ? '\nEXACT AUDIO LOCK: Do not change, rewrite, shorten, expand, renumber, move, or correct any Audio Cues. Treat Audio Cues as already-recorded narration and build only the non-audio slide sections around them.'
    : '';

  return `${detailLevelInstruction(level, preserveAudioCues)}
USER CHANGE REQUEST: ${feedback.trim()}
Improve the existing slide text. Preserve all useful existing facts, expand or clarify them, and do not shorten the slide unless the user asks to simplify.
Rewrite the whole selected slide as one connected teaching unit, but first count the existing points/sentences in each editable section and expand those counted units in place before adding new items. Do not make any existing counted ${preserveAudioCues ? 'Body Text item or Visual/Animation item' : 'Audio Cue, Body Text item, or Visual/Animation item'} shorter. Keep the same PicEd table format. Body Text must be regenerated as a complete section that covers the ${preserveAudioCues ? 'locked audio' : 'improved audio'}, stays within the 20-word limit for each item, and can use points, sentences, formulas, equations, or labels according to the subject and screen context. For detail refine, Body Text should normally be 10-20 words per item; avoid short labels when the audio contains details, causes, examples, organisms, or results. Body Text and Visual/Animation Instructions must match the same frame Audio Cues only; do not add facts, benefits, examples, organisms, or claims that are not spoken in that frame. Do not paste whole Audio Cue sentences into Body Text. Keep Visual/Animation Instructions in the same first-generated style: short editor actions like "Show a diagram of...", "Illustrate...", "Highlight...", "Display...", or "Animate..." instead of vague OST/image-number wording. Do not add Image Suggestions, image links, or AI image prompt sections to the script.${audioLock}${target}`;
}

export function ScriptPreview({
  generatedScript, topic, subject, sampleScripts, onRefine, meta, isFullscreen = false, onMinimize,
}: ScriptPreviewProps) {
  const [viewMode, setViewMode] = useState<'formatted' | 'raw'>('formatted');
  const [copied, setCopied] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [showRefinePanel, setShowRefinePanel] = useState(false);
  const [refineError, setRefineError] = useState('');
  const [selectedFrameIndexes, setSelectedFrameIndexes] = useState<number[]>([]);
  const [detailLevel, setDetailLevel] = useState<DetailLevel>('level2');
  const [selectedTargetText, setSelectedTargetText] = useState('');
  const [refineHighlights, setRefineHighlights] = useState<RefineHighlights | null>(null);
  const [reviewTarget, setReviewTarget] = useState<HighlightTarget | null>(null);
  const [lastRefineFeedback, setLastRefineFeedback] = useState('');
  const [refineProgress, setRefineProgress] = useState(0);
  const [preserveRefineAudioCues, setPreserveRefineAudioCues] = useState(Boolean(meta?.preserveAudioCues));

  const parsed = parseRawScript(generatedScript || '', {
    videoTitle: topic, subject,
    chapter: meta?.chapter || '', topic: meta?.topic || topic,
    learningObjective: meta?.learningObjective || '',
  });
  const activeHighlights = refineHighlights?.script === generatedScript ? refineHighlights : null;
  const showRefineProgress = isRefining || refineProgress === 100;
  const hasSpecificRefineTarget = selectedFrameIndexes.length > 0 || Boolean(selectedTargetText.trim());
  const canRunRefine = Boolean(feedback.trim() || hasSpecificRefineTarget);
  const wholeSlideRefineFields = preserveRefineAudioCues
    ? WHOLE_SLIDE_REFINE_FIELDS.filter(field => field !== 'audioCues')
    : WHOLE_SLIDE_REFINE_FIELDS;

  useEffect(() => {
    setPreserveRefineAudioCues(Boolean(meta?.preserveAudioCues));
  }, [meta?.preserveAudioCues]);

  useEffect(() => {
    if (!isRefining) return;
    setRefineProgress(current => current > 0 && current < 100 ? current : 8);
    const timer = window.setInterval(() => {
      setRefineProgress(current => {
        if (current >= 95) return current;
        if (current < 55) return Math.min(55, current + 7);
        if (current < 82) return Math.min(82, current + 4);
        return Math.min(95, current + 2);
      });
    }, 450);

    return () => window.clearInterval(timer);
  }, [isRefining]);

  const handleCopy = async () => {
    await copyText(generatedScript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadWord = () => {
    downloadWord(topic, subject, generatedScript, meta);
  };

  const handleDownloadPDF = () => {
    downloadPDF(topic, subject, generatedScript, meta);
  };

  const captureSelectedText = (event?: ReactMouseEvent<HTMLElement>, frameIndex?: number): void => {
    const selected = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() || '';
    if (!selected) return;
    setSelectedTargetText(selected.slice(0, 500));

    const selectedFrameIndex = (() => {
      if (typeof frameIndex === 'number') return frameIndex;
      const target = event?.target instanceof HTMLElement ? event.target : null;
      const frameElement = target?.closest<HTMLElement>('[data-frame-index]');
      const domFrameIndex = frameElement?.dataset.frameIndex ? Number(frameElement.dataset.frameIndex) : NaN;
      if (Number.isInteger(domFrameIndex)) return domFrameIndex;
      return parsed.frames.findIndex(frame => selectedTextMatchesFrame(frame, selected));
    })();

    if (selectedFrameIndex >= 0) {
      setSelectedFrameIndexes([selectedFrameIndex]);
    }
    if (refineError) setRefineError('');
  };

  const handleDiscardRefine = () => {
    if (!activeHighlights) return;
    onRefine(activeHighlights.beforeScript);
    setRefineHighlights(null);
    setReviewTarget(null);
    setRefineProgress(0);
    setRefineError('');
  };

  const selectHighlight = (target: HighlightTarget): void => {
    setReviewTarget(target);
  };

  const handleRegenerateHighlighted = async () => {
    if (!reviewTarget) {
      setRefineError('Click a highlighted updated part first.');
      return;
    }
    if (!isGroqInitialized()) {
      setRefineError('Please connect your Groq API key first.');
      return;
    }

    setRefineError('');
    setRefineProgress(8);
    setIsRefining(true);
    try {
      if (preserveRefineAudioCues && reviewTarget.field === 'audioCues') {
        setRefineError('Audio Cues are locked for this script. Select Body Text, Visual Instructions, Header, or Frame instead.');
        setRefineProgress(0);
        return;
      }
      const regenerateInstruction = `Regenerate this highlighted updated ${reviewTarget.label} and any connected slide sections needed for consistency. Make it more realistic, age-appropriate, clear, and aligned to this slide, the previous slide, and the next slide. Preserve the exact PicEd format and keep unrelated text unchanged. Previous refine request: ${lastRefineFeedback || feedback || 'Improve this highlighted update.'}`;
      const requestedFields = preserveRefineAudioCues
        ? [reviewTarget.field].filter(field => field !== 'audioCues')
        : [reviewTarget.field];
      const effectiveFields = getConnectedRefineFields(requestedFields);
      const refined = await refineScript(generatedScript, `${regenerateInstruction}${preserveRefineAudioCues ? '\nDo not change any Audio Cues. They are locked because the narration may already be recorded.' : ''}`, sampleScripts, {
        frameIndexes: [reviewTarget.frameIndex],
        fields: requestedFields,
        preserveAudioCues: preserveRefineAudioCues,
      });

      if (scriptSignature(refined) === scriptSignature(generatedScript)) {
        setRefineError('Regenerate completed, but no visible changes were returned. Try adding a more specific note.');
        setRefineProgress(0);
        return;
      }

      setRefineHighlights(buildHighlights(generatedScript, refined, {
        topic: meta?.topic || topic,
        subject,
        chapter: meta?.chapter,
        learningObjective: meta?.learningObjective,
      }, {
        frameIndexes: [reviewTarget.frameIndex],
        fields: effectiveFields,
      }, regenerateInstruction));
      setViewMode('formatted');
      setRefineProgress(100);
      onRefine(refined);
      setReviewTarget(null);
    } catch (error) {
      console.error('Regenerate highlighted update error:', error);
      setRefineError(error instanceof Error ? error.message : 'Regenerate failed. Please try again.');
      setRefineProgress(0);
    } finally {
      setIsRefining(false);
    }
  };

  const handleRefine = async () => {
    setRefineError('');
    if (!canRunRefine) {
      setRefineError('Select a screen or describe what you want to refine.');
      return;
    }
    if (!isGroqInitialized()) {
      setRefineError('Please connect your Groq API key first.');
      return;
    }

    setRefineProgress(8);
    setIsRefining(true);
    try {
      const pastedTargetFrameIndex = selectedTargetText.trim()
        ? parsed.frames.findIndex(frame => selectedTextMatchesFrame(frame, selectedTargetText))
        : -1;
      const frameIndexes = selectedFrameIndexes.length > 0
        ? selectedFrameIndexes
        : pastedTargetFrameIndex >= 0
          ? [pastedTargetFrameIndex]
          : undefined;
      const selectedLevel = DETAIL_LEVEL_OPTIONS.find(option => option.value === detailLevel)?.label || 'Selected detail level';
      const effectiveFeedback = feedback.trim() || `${selectedLevel}: make the selected screen more detailed.`;
      const refineInstruction = buildWholeSlideRefineInstruction(effectiveFeedback, detailLevel, selectedTargetText, preserveRefineAudioCues);
      const effectiveFields = getConnectedRefineFields(wholeSlideRefineFields);
      const refined = await refineScript(generatedScript, refineInstruction, sampleScripts, {
        frameIndexes,
        fields: wholeSlideRefineFields,
        preserveAudioCues: preserveRefineAudioCues,
      });
      if (scriptSignature(refined) === scriptSignature(generatedScript)) {
        setRefineError('Refine completed, but no visible changes were returned. Select the exact screen/field and describe the needed change.');
        setRefineProgress(0);
        return;
      }
      setRefineHighlights(buildHighlights(generatedScript, refined, {
        topic: meta?.topic || topic,
        subject,
        chapter: meta?.chapter,
        learningObjective: meta?.learningObjective,
      }, {
        frameIndexes,
        fields: effectiveFields,
      }, refineInstruction));
      setLastRefineFeedback(refineInstruction);
      setReviewTarget(null);
      setViewMode('formatted');
      setRefineProgress(100);
      onRefine(refined);
      setFeedback('');
      setSelectedTargetText('');
      setShowRefinePanel(false);
    } catch (error) {
      console.error('Refine error:', error);
      setRefineError(error instanceof Error ? error.message : 'Refine failed. Please try again.');
      setRefineProgress(0);
    } finally {
      setIsRefining(false);
    }
  };

  const handleForceBodyText = async () => {
    setRefineError('');
    if (!isGroqInitialized()) {
      setRefineError('Please connect your Groq API key first.');
      return;
    }

    setRefineProgress(8);
    setIsRefining(true);
    try {
      const pastedTargetFrameIndex = selectedTargetText.trim()
        ? parsed.frames.findIndex(frame => selectedTextMatchesFrame(frame, selectedTargetText))
        : -1;
      const frameIndexes = selectedFrameIndexes.length > 0
        ? selectedFrameIndexes
        : pastedTargetFrameIndex >= 0
          ? [pastedTargetFrameIndex]
          : undefined;
      const forceInstruction = `${detailLevelInstruction('level3', true)}
FORCE BODY TEXT UPDATE:
For every selected slide, rebuild the complete Body Text section from that same slide's locked Audio Cues. Keep Audio Cues unchanged.
Body Text must be more detailed than the current body text, but each item must remain 0-20 words.
Use the available limit: each normal Body Text item should be 10-20 words, not a short 4-8 word label.
Use PPT-style educational points: rephrased, concise, classroom-ready, and slightly detailed. Do not copy Audio Cue sentences.
Do not include timestamps, edit notes, "cut the clip", speaker filler, or narration phrases.
Cover all important audio ideas, especially later/end-screen steps, observations, materials, results, causes, and conclusions.
After rebuilding Body Text, rewrite Visual/Animation Instructions so they directly match the new Body Text and the locked Audio Cues.
Keep the PicEd three-column script format exactly.`;
      const forceFields: RefineField[] = ['bodyText', 'visualInstructions'];
      const refined = await refineScript(generatedScript, forceInstruction, sampleScripts, {
        frameIndexes,
        fields: forceFields,
        preserveAudioCues: true,
      });

      if (scriptSignature(refined) === scriptSignature(generatedScript)) {
        setRefineError('Force Body Text completed, but no visible changes were returned. Select the exact end screens and try again.');
        setRefineProgress(0);
        return;
      }

      const effectiveFields = getConnectedRefineFields(forceFields);
      setRefineHighlights(buildHighlights(generatedScript, refined, {
        topic: meta?.topic || topic,
        subject,
        chapter: meta?.chapter,
        learningObjective: meta?.learningObjective,
      }, {
        frameIndexes,
        fields: effectiveFields,
      }, forceInstruction));
      setLastRefineFeedback(forceInstruction);
      setReviewTarget(null);
      setViewMode('formatted');
      setRefineProgress(100);
      onRefine(refined);
      setShowRefinePanel(false);
    } catch (error) {
      console.error('Force Body Text error:', error);
      setRefineError(error instanceof Error ? error.message : 'Force Body Text failed. Please try selected screens only.');
      setRefineProgress(0);
    } finally {
      setIsRefining(false);
    }
  };

  if (!generatedScript) {
    return (
      <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8">
        <div className="text-center py-12">
          <div className="bg-slate-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
            <Eye className="w-8 h-8 text-slate-400" />
          </div>
          <h3 className="text-lg font-medium text-slate-600 mb-2">No Script Generated Yet</h3>
          <p className="text-slate-500 text-sm">Upload a sample script format, provide book content, and click Generate.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-white shadow-lg border border-slate-200 overflow-hidden ${isFullscreen ? 'h-full flex flex-col rounded-xl' : 'rounded-2xl'}`}>
      {/* Header */}
      <div className="bg-gradient-to-r from-[#2C3E50] to-[#34495E] p-4 text-white">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Video className="w-6 h-6" />
            <div>
              <h3 className="font-bold text-lg">{parsed.videoTitle || 'Generated Script'}</h3>
              <p className="text-sm text-white/70">{parsed.subject} • {parsed.frames.length} frames</p>
            </div>
          </div>
          <div className="bg-white/20 rounded-lg p-1 flex text-sm">
            <button onClick={() => setViewMode('formatted')}
              className={`px-3 py-1 rounded ${viewMode === 'formatted' ? 'bg-white text-slate-800' : 'text-white/80'}`}>
              Formatted
            </button>
            <button onClick={() => setViewMode('raw')}
              className={`px-3 py-1 rounded ${viewMode === 'raw' ? 'bg-white text-slate-800' : 'text-white/80'}`}>
              Raw
            </button>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="p-3 bg-slate-50 border-b border-slate-200 flex flex-wrap gap-2">
        <button onClick={handleDownloadWord}
          className="flex items-center gap-2 px-4 py-2 bg-[#3E7BBF] text-white rounded-lg font-medium hover:bg-[#356BA8] transition-all text-sm">
          <Download className="w-4 h-4" /> Download Word
        </button>
        <button onClick={handleDownloadPDF}
          className="flex items-center gap-2 px-4 py-2 bg-[#E74C3C] text-white rounded-lg font-medium hover:bg-[#C0392B] transition-all text-sm">
          <Printer className="w-4 h-4" /> Download PDF
        </button>
        <button onClick={handleCopy}
          className="flex items-center gap-2 px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-all text-sm">
          {copied ? <><Check className="w-4 h-4 text-green-600" /> Copied!</> : <><Copy className="w-4 h-4" /> Copy</>}
        </button>
        <button onClick={() => {
          setShowRefinePanel(!showRefinePanel);
          setRefineError('');
        }}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all text-sm ${showRefinePanel ? 'bg-amber-500 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}`}>
          <Edit3 className="w-4 h-4" /> Refine
        </button>
        {isFullscreen && onMinimize && (
          <button onClick={onMinimize}
            className="ml-auto flex items-center gap-2 px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-all text-sm">
            <Minimize2 className="w-4 h-4" /> Minimize
          </button>
        )}
      </div>

      {/* Refine panel */}
      {showRefinePanel && (
        <div className="p-4 bg-amber-50 border-b border-amber-200">
          <div className="flex items-start gap-3">
            <MessageSquare className="w-5 h-5 text-amber-600 mt-1 flex-shrink-0" />
            <div className="flex-1">
              <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3 mb-3">
                <div>
                  <label className="block text-xs font-semibold text-amber-900 mb-1">
                    Screens / Slides
                  </label>
                  <div className="max-h-44 overflow-y-auto rounded-lg border border-amber-300 bg-white p-2 space-y-2">
                    <label className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer ${
                      selectedFrameIndexes.length === 0 ? 'bg-amber-100 text-amber-900' : 'text-slate-700'
                    }`}>
                      <input
                        type="checkbox"
                        checked={selectedFrameIndexes.length === 0}
                        onChange={() => {
                          setSelectedFrameIndexes([]);
                          if (refineError) setRefineError('');
                        }}
                        className="h-4 w-4 rounded border-amber-300 text-amber-600 focus:ring-amber-500"
                      />
                      All screens
                    </label>
                    {parsed.frames.map((frame, index) => {
                      const checked = selectedFrameIndexes.includes(index);
                      return (
                        <label
                          key={index}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer ${
                            checked ? 'bg-amber-100 text-amber-900' : 'text-slate-700'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setSelectedFrameIndexes(current => {
                                return current.includes(index)
                                  ? current.filter(value => value !== index)
                                  : [...current, index].sort((a, b) => a - b);
                              });
                              if (refineError) setRefineError('');
                            }}
                            className="h-4 w-4 rounded border-amber-300 text-amber-600 focus:ring-amber-500"
                          />
                          <span className="leading-tight">{frameOptionLabel(frame.frameType, frame.visualization, index)}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <span className="block text-xs font-semibold text-amber-900 mb-1">
                    Detail Level
                  </span>
                  <div className="grid gap-2">
                    {DETAIL_LEVEL_OPTIONS.map(option => {
                      const checked = detailLevel === option.value;
                      return (
                        <label
                          key={option.value}
                          className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer ${
                            checked
                              ? 'bg-amber-100 border-amber-400 text-amber-900'
                              : 'bg-white border-amber-200 text-slate-700'
                          }`}
                        >
                          <input
                            type="radio"
                            name="detailLevel"
                            checked={checked}
                            onChange={() => {
                              setDetailLevel(option.value);
                              if (refineError) setRefineError('');
                            }}
                            className="mt-0.5 h-4 w-4 border-amber-300 text-amber-600 focus:ring-amber-500"
                          />
                          <span>
                            <span className="block font-semibold">{option.label}</span>
                            <span className="block text-xs leading-snug opacity-80">{option.description}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPreserveRefineAudioCues(value => !value);
                  if (refineError) setRefineError('');
                }}
                aria-pressed={preserveRefineAudioCues}
                className={`mb-3 flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-all ${
                  preserveRefineAudioCues
                    ? 'border-amber-500 bg-amber-100 text-amber-950'
                    : 'border-amber-200 bg-white text-slate-700 hover:bg-amber-50'
                }`}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className={`shrink-0 rounded-md p-1.5 ${preserveRefineAudioCues ? 'bg-amber-500 text-white' : 'bg-amber-100 text-amber-700'}`}>
                    <Mic className="w-4 h-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold">
                      {preserveRefineAudioCues ? 'Audio Cues Locked During Refine' : 'Keep Audio Cues Exact During Refine'}
                    </span>
                    <span className="block text-xs text-slate-600">
                      Use this when narration is already recorded; refine will update only non-audio slide sections.
                    </span>
                  </span>
                </span>
                <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${preserveRefineAudioCues ? 'bg-amber-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                  {preserveRefineAudioCues ? 'ON' : 'OFF'}
                </span>
              </button>
              <div className="mb-3 rounded-lg border border-amber-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-semibold text-amber-900">
                    Specific word / sentence to change
                  </span>
                  <button
                    type="button"
                    onMouseDown={event => event.preventDefault()}
                    onClick={event => captureSelectedText(event)}
                    className="px-2 py-1 text-xs font-medium text-amber-800 border border-amber-300 rounded hover:bg-amber-50"
                  >
                    Use selected text
                  </button>
                </div>
                <textarea
                  value={selectedTargetText}
                  onChange={e => {
                    setSelectedTargetText(e.target.value);
                    if (refineError) setRefineError('');
                  }}
                  rows={2}
                  placeholder="Optional: select text in the script, click Use selected text, or paste a word/sentence here."
                  className="w-full px-3 py-2 border border-amber-200 rounded-lg text-sm resize-none focus:ring-2 focus:ring-amber-500"
                />
                <p className="mt-1 text-xs text-amber-700">
                  Optional. Leave blank to refine the whole selected screen. Selecting script text auto-selects that screen.
                </p>
              </div>
              <textarea value={feedback} onChange={e => {
                setFeedback(e.target.value);
                if (refineError) setRefineError('');
              }} rows={3}
                placeholder="What should change on the whole selected slide? e.g., make dermis structure clearer and more detailed."
                className="w-full px-3 py-2 border border-amber-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-amber-500" />
              {refineError && (
                <div className="mt-2 flex items-center gap-2 text-sm text-red-600">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{refineError}</span>
                </div>
              )}
              <div className="flex gap-2 mt-2">
                <button onClick={handleRefine} disabled={isRefining || !canRunRefine}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                  {isRefining ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refine
                </button>
                <button onClick={handleForceBodyText} disabled={isRefining}
                  className="flex items-center gap-2 px-4 py-2 bg-[#3E7BBF] text-white rounded-lg text-sm font-medium hover:bg-[#356BA8] disabled:opacity-50">
                  {isRefining ? <Loader2 className="w-4 h-4 animate-spin" /> : <Type className="w-4 h-4" />} Force Body Text
                </button>
                <button onClick={() => setShowRefinePanel(false)}
                  className="px-4 py-2 text-amber-700 hover:bg-amber-100 rounded-lg text-sm">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showRefineProgress && (
        <div className="p-3 bg-amber-50 border-b border-amber-200 text-sm">
          <div className="flex items-center justify-between gap-3 mb-2">
            <span className="font-semibold text-amber-900">
              {refineProgress >= 100 ? 'AI refine complete. Ready to review.' : 'AI is refining connected slide content...'}
            </span>
            <span className="font-semibold text-amber-900">{Math.round(refineProgress)}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-amber-100">
            <div
              className="h-full rounded-full bg-amber-600 transition-all duration-500"
              style={{ width: `${refineProgress}%` }}
            />
          </div>
        </div>
      )}

      {activeHighlights && (
        <div className="p-3 bg-yellow-50 border-b border-yellow-200 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold text-yellow-900">Is the highlighted updated script text correct?</p>
              <p className="text-yellow-800">
                Click a highlighted box to regenerate that exact part, or confirm if it is good.
              </p>
              <p className="mt-2 text-yellow-900">
                <span className="font-semibold">AI update summary:</span> {activeHighlights.summary}
              </p>
              {reviewTarget && (
                <p className="mt-1 text-yellow-900">
                  Selected: <span className="font-semibold">{reviewTarget.label}</span>
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => {
                  setRefineHighlights(null);
                  setReviewTarget(null);
                  setRefineProgress(0);
                }}
                className="px-3 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700"
              >
                Correct
              </button>
              <button
                onClick={handleDiscardRefine}
                disabled={isRefining}
                className="px-3 py-2 bg-white text-yellow-900 border border-yellow-300 rounded-lg font-medium hover:bg-yellow-100 disabled:opacity-50"
              >
                Discard changes
              </button>
              <button
                onClick={handleRegenerateHighlighted}
                disabled={isRefining || !reviewTarget}
                className="px-3 py-2 bg-amber-600 text-white rounded-lg font-medium disabled:opacity-50"
              >
                {isRefining ? 'Regenerating...' : 'Regenerate selected'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className={`${isFullscreen ? 'flex-1 min-h-0' : 'max-h-[650px]'} overflow-y-auto`} onMouseUp={event => captureSelectedText(event)}>
        {viewMode === 'formatted' ? (
          <div className="p-5 space-y-6">
            {/* Video Details */}
            <div>
              <h4 className="text-sm font-bold text-[#303030] mb-2 flex items-center gap-2 border-b-2 border-[#3E7BBF] pb-1">
                <Settings className="w-4 h-4 text-[#3E7BBF]" /> Video Details
              </h4>
              <div className="border border-slate-200 rounded-lg overflow-hidden text-sm">
                {([
                  ['Subject', parsed.subject],
                  ['Chapter', parsed.chapter],
                  ['Topic', parsed.topic],
                  ['Video Title', parsed.videoTitle],
                  ['Learning Objective', parsed.learningObjective],
                ] as [string, string][]).map(([k, v], i) => (
                  <div key={k} className={`flex ${i % 2 === 0 ? 'bg-[#D6E4F0]/40' : 'bg-white'}`}>
                    <div className="w-1/3 px-3 py-2 font-semibold text-[#303030] border-r border-slate-200">{k}</div>
                    <div className="w-2/3 px-3 py-2 text-[#474747]">{v || '—'}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Frame-by-Frame */}
            <div>
              <h4 className="text-sm font-bold text-[#303030] mb-2 flex items-center gap-2 border-b-2 border-[#3E7BBF] pb-1">
                <Layout className="w-4 h-4 text-[#3E7BBF]" /> Frame-by-Frame Script
              </h4>
              <div className="flex bg-[#2C3E50] text-white text-xs font-bold rounded-t-lg overflow-hidden">
                <div className="w-[40%] px-3 py-2">Audio Cues</div>
                <div className="w-[15%] px-3 py-2 text-center">Frame</div>
                <div className="w-[45%] px-3 py-2">Visualization Comments / Text on Screen</div>
              </div>
              {parsed.frames.map((frame, i) => (
                <div
                  key={i}
                  data-frame-index={i}
                  onMouseUp={event => captureSelectedText(event, i)}
                  className={`flex border-b border-slate-200 text-sm ${i % 2 === 1 ? 'bg-[#F5F7FA]' : 'bg-white'}`}
                >
                  <div className="w-[40%] px-3 py-3 border-r border-slate-200">
                    {frame.audioCues.split('\n').map((line, j) => (
                      <p
                        key={j}
                        style={highlightStyle(Boolean(activeHighlights?.frames[i]?.audioLines.includes(j)))}
                        onClick={() => {
                          if (activeHighlights?.frames[i]?.audioLines.includes(j)) {
                            selectHighlight({ frameIndex: i, field: 'audioCues', label: targetLabel(frame, i, 'audioCues') });
                          }
                        }}
                        className="text-[#474747] mb-1 leading-relaxed"
                      >
                        {line}
                      </p>
                    ))}
                  </div>
                  <div className="w-[15%] px-2 py-3 border-r border-slate-200 flex items-start justify-center">
                    <span
                      style={highlightStyle(Boolean(activeHighlights?.frames[i]?.frameType))}
                      onClick={() => {
                        if (activeHighlights?.frames[i]?.frameType) {
                          selectHighlight({ frameIndex: i, field: 'frameType', label: targetLabel(frame, i, 'frameType') });
                        }
                      }}
                      className="text-[#3E7BBF] font-bold text-xs text-center leading-tight"
                    >
                      {frame.frameType}
                    </span>
                  </div>
                  <div className="w-[45%] px-3 py-3">
                    {frame.visualization.split('\n').map((line, j) => {
                      const t = line.trim();
                      if (!t) return null;
                      const url = getUrl(t);
                      const isHeader = /^(Null Screen Header|Body Text|Visual\/Animation|Audio\/Animation|Title Text|Image Suggestion|📌)/i.test(t);
                      const isImg = /^(Image\s*\d*\s*:|GIF\s*\d*\s*:)/i.test(t) || Boolean(url);
                      const isPrompt = /^(🎨|AI Image Prompt)/i.test(t);
                      const isHighlighted = Boolean(activeHighlights?.frames[i]?.visualizationLines.includes(j));
                      return (
                        <p
                          key={j}
                          style={highlightStyle(isHighlighted)}
                          onClick={() => {
                            if (isHighlighted) {
                              const field = fieldForVisualizationLine(frame.visualization, j);
                              selectHighlight({ frameIndex: i, field, label: targetLabel(frame, i, field) });
                            }
                          }}
                          className={`mb-1 leading-relaxed ${
                          isHeader ? 'font-bold text-[#303030]' :
                          isImg ? 'text-[#3E7BBF] italic text-xs break-all' :
                          isPrompt ? 'text-purple-600 italic text-xs' :
                          'text-[#474747]'
                        }`}
                        >
                          {url ? (
                            <a href={url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                              {t}
                            </a>
                          ) : t}
                        </p>
                      );
                    })}
                  </div>
                </div>
              ))}
              {parsed.frames.length === 0 && (
                <div className="border border-t-0 border-slate-200 rounded-b-lg p-4">
                  <p className="text-sm text-slate-500 mb-2">Raw script output:</p>
                  <pre className="whitespace-pre-wrap font-mono text-xs text-slate-700 bg-slate-50 p-3 rounded">
                    {generatedScript}
                  </pre>
                </div>
              )}
            </div>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-sm text-slate-700 p-5 bg-slate-50">
            {generatedScript.split('\n').map((line, index) => (
              <span key={index} style={highlightStyle(Boolean(activeHighlights?.rawLines.includes(index)))}>
                {line}
                {index < generatedScript.split('\n').length - 1 ? '\n' : ''}
              </span>
            ))}
          </pre>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 bg-slate-50 border-t border-slate-200 flex flex-wrap gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1"><FileText className="w-3.5 h-3.5" /> ~{generatedScript.split(/\s+/).length} words</span>
        <span className="flex items-center gap-1"><Layout className="w-3.5 h-3.5" /> {parsed.frames.length} frames</span>
        <span className="flex items-center gap-1"><Mic className="w-3.5 h-3.5" /> Audio cues</span>
        <span className="flex items-center gap-1"><Image className="w-3.5 h-3.5" /> Visuals + Images</span>
        <span className="flex items-center gap-1"><Type className="w-3.5 h-3.5" /> Body text</span>
      </div>
    </div>
  );
}
