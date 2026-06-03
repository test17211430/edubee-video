// ── Types ────────────────────────────────────────────────────────
export interface FrameRow { audioCues: string; frameType: string; visualization: string; }
export interface ScriptData {
  videoTitle: string; subject: string; chapter: string; topic: string;
  alphaChannelLink: string; learningObjective: string; numberOfMCQ: string;
  editorNotes: string; frames: FrameRow[]; rawText: string;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(/\n+/).map(item => item.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
  }
  return [];
}

function formatNumbered(values: unknown): string {
  return asList(values).map((value, index) => `${index + 1}. ${value}`).join('\n');
}

function formatBody(values: unknown): string {
  const body = asList(values).map((value, index) => `${index + 1}. ${value}`).join('\n');
  return body ? `Body Text:\n${body}` : '';
}

function formatImages(values: unknown): string {
  const images = asList(values).map((value, index) => {
    if (/^image\s*\d*\s*:/i.test(value) || /^AI Image Prompt\s*\d*\s*:/i.test(value)) return value;
    return `Image ${index + 1}: ${value}`;
  }).join('\n');
  return images ? `Image Suggestions:\n${images}` : '';
}

function parseJsonFallback(raw: string): FrameRow[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return [];

  try {
    const data = JSON.parse(trimmed) as {
      curiosityQuestion?: string;
      previousTopic?: string;
      previousImages?: unknown;
      todayIntro?: string;
      todayImage?: unknown;
      frames?: Array<{
        audio?: unknown;
        frame?: string;
        header?: string;
        body?: unknown;
        visual?: unknown;
        images?: unknown;
      }>;
      summaryAudio?: unknown;
      summaryImages?: unknown;
    };

    const rows: FrameRow[] = [];

    if (data.curiosityQuestion) {
      rows.push({
        audioCues: `1. ${data.curiosityQuestion}`,
        frameType: 'Wide',
        visualization: 'Audio/Animation Cues:\n1. Show teacher in center',
      });
    }

    if (data.previousTopic) {
      rows.push({
        audioCues: `1. Previously, we looked at ${data.previousTopic}.`,
        frameType: 'Wide with Image',
        visualization: [
          'Null Screen Header:',
          'Previously',
          '',
          formatBody([data.previousTopic]),
          '',
          formatImages(data.previousImages),
        ].filter(Boolean).join('\n'),
      });
    }

    if (data.todayIntro) {
      rows.push({
        audioCues: `1. ${data.todayIntro}`,
        frameType: 'Wide with Image',
        visualization: [
          'Null Screen Header:',
          'Today',
          '',
          formatImages(data.todayImage),
        ].filter(Boolean).join('\n'),
      });
    }

    for (const frame of Array.isArray(data.frames) ? data.frames : []) {
      rows.push({
        audioCues: formatNumbered(frame.audio),
        frameType: frame.frame || 'Wide with Image',
        visualization: [
          frame.header ? `Null Screen Header:\n${frame.header}` : '',
          formatBody(frame.body),
          asList(frame.visual).length ? `Visual/Animation Instructions:\n${formatNumbered(frame.visual)}` : '',
          formatImages(frame.images),
        ].filter(Boolean).join('\n\n'),
      });
    }

    if (asList(data.summaryAudio).length || asList(data.summaryImages).length) {
      rows.push({
        audioCues: formatNumbered(data.summaryAudio),
        frameType: 'Summary',
        visualization: [
          'Visual/Animation Instructions:',
          '1. Bring teacher to centre of frame.',
          formatImages(data.summaryImages),
        ].filter(Boolean).join('\n'),
      });
    }

    return rows;
  } catch {
    return [];
  }
}

// ── Parse raw AI text → structured data ──────────────────────────
export function parseRawScript(raw: string, meta: {
  videoTitle: string; subject: string; chapter: string;
  topic: string; learningObjective: string;
}): ScriptData {
  const frames: FrameRow[] = [];

  // Strategy 1: <<<ROW>>> separated (assembled by our code — most reliable)
  if (raw.includes('<<<ROW>>>')) {
    const frameTableStart = raw.search(/Frame-by-Frame Script|Audio Cues\t/i);
    const tableText = frameTableStart > -1 ? raw.substring(frameTableStart) : raw;
    
    // Split into rows
    const rows = tableText.split('<<<ROW>>>').filter(r => r.trim());
    
    for (const row of rows) {
      // Skip header rows
      if (row.includes('Frame-by-Frame Script') && !row.includes('\t')) continue;
      if (row.trim().startsWith('Audio Cues') && row.includes('Visualization')) continue;
      
      // Find the FIRST line that has tabs — that's our column split
      const rowLines = row.split('\n').filter(line => {
        const trimmed = line.trim();
        if (/^Frame-by-Frame Script$/i.test(trimmed)) return false;
        if (/^Audio Cues\s*\t\s*Frame\s*\t\s*Visualization Comments\s*\/\s*Text on Screen$/i.test(trimmed)) return false;
        return true;
      });
      let tabLine = '';
      const beforeTab: string[] = [];
      const afterTab: string[] = [];
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
      
      if (tabLine) {
        const parts = tabLine.split('\t');
        // Audio = any lines before the tab line + the first column
        const audioParts = [...beforeTab.filter(l => l.trim()), (parts[0] || '').trim()].filter(Boolean);
        const audioCues = audioParts.join('\n').trim();
        const frameType = (parts[1] || '').trim();
        // Visualization = third column + any lines after the tab line
        const vizParts = [(parts[2] || '').trim(), ...afterTab.filter(l => l.trim())].filter(Boolean);
        const visualization = vizParts.join('\n').trim();
        
        if (audioCues || frameType || visualization) {
          frames.push({ audioCues, frameType, visualization });
        }
      }
    }
  }

  // Strategy 2: Tab-separated rows (original PicEd format from uploaded files)
  if (frames.length === 0) {
    const frameTableStart = raw.search(/Frame-by-Frame Script|Audio Cues\t/i);
    if (frameTableStart > -1) {
      const tableText = raw.substring(frameTableStart);
      const lines = tableText.split('\n');
      let currentAudio = '';
      let currentFrame = '';
      let currentViz = '';
      let headerSkipped = false;
      
      for (const line of lines) {
        if (!headerSkipped) {
          if (line.includes('Audio Cues') && (line.includes('Frame') || line.includes('Visualization'))) {
            headerSkipped = true; continue;
          }
          if (line.trim().startsWith('Frame-by-Frame')) continue;
        }
        if (line.includes('\t')) {
          if (currentAudio || currentFrame || currentViz) {
            frames.push({ audioCues: currentAudio.trim(), frameType: currentFrame.trim(), visualization: currentViz.trim() });
          }
          const parts = line.split('\t');
          currentAudio = (parts[0] || '').trim();
          currentFrame = (parts[1] || '').trim();
          currentViz = (parts[2] || '').trim();
          headerSkipped = true;
        } else {
          if (headerSkipped && line.trim()) currentViz += '\n' + line;
        }
      }
      if (currentAudio || currentFrame || currentViz) {
        frames.push({ audioCues: currentAudio.trim(), frameType: currentFrame.trim(), visualization: currentViz.trim() });
      }
    }
  }
  
  // Fallback: try ---FRAME--- delimiters
  if (frames.length === 0) {
    const frameRegex = /---\s*FRAME\s*---([\s\S]*?)---\s*END\s*FRAME\s*---/gi;
    let match;
    while ((match = frameRegex.exec(raw)) !== null) {
      const content = match[1].trim();
      if (!content) continue;
      
      let audioCues = '', frameType = '', visualization = '';
      
      if (content.includes('===COL===')) {
        const cols = content.split('===COL===');
        audioCues = (cols[0] || '').replace(/^Audio Cues:\s*/i, '').trim();
        frameType = (cols[1] || '').replace(/^Frame\s*Type:\s*/i, '').trim();
        visualization = (cols[2] || '').trim();
      } else {
        const cLines = content.split('\n');
        let section: 'a' | 'v' = 'a';
        const aL: string[] = [], vL: string[] = [];
        for (const l of cLines) {
          const t = l.trim();
          if (/^Frame\s*Type:\s*/i.test(t) || /^(Title Screen|Wide with Image|Wide|Summary|Null)$/i.test(t)) {
            frameType = t.replace(/^Frame\s*Type:\s*/i, ''); section = 'v'; continue;
          }
          if (/^(Null Screen|Body Text|Visual\/|Audio\/Animation|Title Text|Image|📌|🎨)/i.test(t)) section = 'v';
          if (section === 'a') aL.push(t); else vL.push(t);
        }
        audioCues = aL.filter(Boolean).join('\n').replace(/^Audio Cues:\s*/i, '').trim();
        visualization = vL.filter(Boolean).join('\n');
      }
      
      if (audioCues || frameType || visualization) {
        frames.push({ audioCues, frameType, visualization });
      }
    }
  }

  if (frames.length === 0) {
    frames.push(...parseJsonFallback(raw));
  }

  // Extract metadata from text before frames
  let editorNotes = `FONT AND COLOURS:\n• Video Title name – Font: Noto Sans – 36 – Bold - Italics | Subject – 28 – Noto Sans – No Bold\n• Noto Sans Medium for content, Bold for headings, Italic for important words\n• Title: Dark Grey (#303030) | Body text: Light Grey (#474747) | Important words: Blue (#3E7BBF)\n• Font size – Title: 50 | Body text: 35 | All text left-aligned\n\nFRAME TYPES:\n• Intro Screen – PicEd Logo and bg music\n• Title Screen – Video Title name and Subject\n• Wide – Only teacher visible in centre of frame\n• Wide with Image – Teacher with image and text\n• Null – Only screen visible\n• Summary – Teacher with image on LHS\n• Outro Screen – PicEd Logo and bg music`;
  const notesMatch = raw.match(/Notes to Video Editor[\s\S]*?(?=Frame-by-Frame|$)/i);
  if (notesMatch) editorNotes = notesMatch[0].replace(/.*Notes to Video Editor\s*/i, '').trim();

  let videoTitle = meta.videoTitle, subject = meta.subject;
  let chapter = meta.chapter, topic = meta.topic, learningObjective = meta.learningObjective;

  const sm = raw.match(/Subject\s*[\t:]\s*(.+)/i); if (sm) subject = sm[1].trim();
  const cm = raw.match(/Chapter\s*[\t:]\s*(.+)/i); if (cm) chapter = cm[1].trim();
  const tm = raw.match(/Topic\s*[\t:]\s*(.+)/i); if (tm) topic = tm[1].trim();
  const vm = raw.match(/Video Title\s*[\t:]\s*(.+)/i); if (vm) videoTitle = vm[1].trim();
  const om = raw.match(/Learning Objective\s*[\t:]\s*(.+)/i); if (om) learningObjective = om[1].trim();

  return {
    videoTitle: videoTitle || topic, subject, chapter, topic, 
    alphaChannelLink: '', learningObjective, numberOfMCQ: '',
    editorNotes, frames, rawText: raw,
  };
}

// ── Build HTML ───────────────────────────────────────────────────
function buildHtml(data: ScriptData): string {
  const esc = (s: string) => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const linkify = (s: string) => esc(s).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" style="color:#1155cc;text-decoration:underline;">$1</a>'
  );

  const noteLines = data.editorNotes.split('\n').map(l => {
    const t = l.trim();
    if (!t) return '';
    if (t.endsWith(':') && !t.startsWith('•')) return `<p style="font-weight:700;margin:8px 0 2px;">${linkify(t)}</p>`;
    return `<p style="margin:2px 0;">${linkify(t)}</p>`;
  }).join('');

  const frameRows = data.frames.map((f, i) => {
    const bg = i % 2 === 0 ? '#ffffff' : '#F5F7FA';
    const audioHtml = f.audioCues.split('\n').map(l => `<p style="margin:2px 0;">${linkify(l.trim())}</p>`).join('');
    const vizHtml = f.visualization.split('\n').map(l => {
      const t = l.trim();
      if (!t) return '';
      const isH = /^(Null Screen Header|Body Text|Visual\/Animation|Audio\/Animation|Title Text|Image Suggestion|📌)/i.test(t);
      const isImg = /^(Image\s*\d*\s*:|GIF\s*\d*\s*:|🎨)/i.test(t) || t.startsWith('http');
      const isPrompt = /^AI Image Prompt\s*\d*\s*:/i.test(t);
      if (isH) return `<p style="font-weight:700;color:#303030;margin:6px 0 2px;">${linkify(t)}</p>`;
      if (isImg) return `<p style="color:#3E7BBF;font-style:italic;font-size:9px;word-break:break-all;margin:2px 0;">${linkify(t)}</p>`;
      if (isPrompt) return `<p style="color:#805AD5;font-style:italic;font-size:9px;margin:2px 0;">${linkify(t)}</p>`;
      return `<p style="margin:2px 0;">${linkify(t)}</p>`;
    }).join('');
    return `<tr style="background:${bg};"><td style="padding:8px 10px;border:1px solid #ccc;vertical-align:top;width:40%;">${audioHtml}</td><td style="padding:8px 6px;border:1px solid #ccc;vertical-align:top;width:15%;text-align:center;color:#3E7BBF;font-weight:700;font-size:10px;">${esc(f.frameType)}</td><td style="padding:8px 10px;border:1px solid #ccc;vertical-align:top;width:45%;">${vizHtml || '<span style="color:#999;">—</span>'}</td></tr>`;
  }).join('');

  return `<div style="font-family:'Noto Sans',Arial,sans-serif;color:#474747;font-size:11px;max-width:780px;margin:0 auto;padding:20px;">
<h1 style="text-align:center;font-size:24px;color:#303030;margin:0 0 4px;">Video Script</h1>
<p style="text-align:center;font-size:14px;color:#303030;font-weight:700;font-style:italic;margin:0 0 20px;">${esc(data.videoTitle)} | ${esc(data.subject)}</p>
<h2 style="font-size:14px;color:#303030;border-bottom:2px solid #3E7BBF;padding-bottom:4px;margin:16px 0 8px;">Video Details</h2>
<table style="width:100%;border-collapse:collapse;font-size:11px;">
${([['Subject',data.subject],['Chapter',data.chapter],['Topic',data.topic],['Video Title',data.videoTitle],['Alpha Channel Link',data.alphaChannelLink],['Learning Objective',data.learningObjective],['Number of MCQ',data.numberOfMCQ]] as [string,string][]).map(([k,v])=>`<tr><td style="padding:5px 8px;border:1px solid #ccc;font-weight:700;width:30%;background:#D6E4F0;color:#303030;">${esc(k)}</td><td style="padding:5px 8px;border:1px solid #ccc;">${esc(v||'')}</td></tr>`).join('')}
</table>
<h2 style="font-size:14px;color:#303030;border-bottom:2px solid #3E7BBF;padding-bottom:4px;margin:20px 0 8px;">Notes to Video Editor</h2>
<div style="font-size:10px;">${noteLines}</div>
<h2 style="font-size:14px;color:#303030;border-bottom:2px solid #3E7BBF;padding-bottom:4px;margin:20px 0 8px;">Frame-by-Frame Script</h2>
<table style="width:100%;border-collapse:collapse;font-size:10px;"><thead><tr style="background:#2C3E50;color:#fff;"><th style="padding:8px 10px;border:1px solid #2C3E50;text-align:left;width:40%;">Audio Cues</th><th style="padding:8px 6px;border:1px solid #2C3E50;text-align:center;width:15%;">Frame</th><th style="padding:8px 10px;border:1px solid #2C3E50;text-align:left;width:45%;">Visualization Comments / Text on Screen</th></tr></thead><tbody>${frameRows}</tbody></table>
</div>`;
}

// ── Downloads ────────────────────────────────────────────────────
export function downloadPDF(title: string, subject: string, rawScript: string, meta?: { chapter?: string; topic?: string; learningObjective?: string }): void {
  const data = parseRawScript(rawScript, { videoTitle: title, subject, chapter: meta?.chapter || '', topic: meta?.topic || title, learningObjective: meta?.learningObjective || '' });
  const html = buildHtml(data);
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow popups to download PDF'); return; }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>@media print{body{margin:0;padding:0;}}</style></head><body>${html}</body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

export function downloadWord(title: string, subject: string, rawScript: string, meta?: { chapter?: string; topic?: string; learningObjective?: string }): void {
  const data = parseRawScript(rawScript, { videoTitle: title, subject, chapter: meta?.chapter || '', topic: meta?.topic || title, learningObjective: meta?.learningObjective || '' });
  const html = buildHtml(data);
  const blob = new Blob([`<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><style>@page{size:A4;margin:15mm;}body{font-family:'Noto Sans',Arial,sans-serif;font-size:11px;color:#474747;}table{border-collapse:collapse;width:100%;}td,th{border:1px solid #ccc;padding:5px 8px;vertical-align:top;}</style></head><body>${html}</body></html>`], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${title.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_')}_Script.doc`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

export function exportRawScript(raw: string): string { return raw; }
