import { useState, useCallback } from 'react';
import { Upload, FileText, X, CheckCircle, AlertCircle, Loader2, Wand2 } from 'lucide-react';
import { ParsedScript, ScriptSection } from '../types';
import { parseWordDocument, analyzePatterns, getDefaultFormat } from '../utils/wordParser';
import { PHOTOSYNTHESIS_SAMPLE_SCRIPT } from '../data/photosynthesisSample';

// Demo sample script in PicEd format
const DEMO_SCRIPT_CONTENT = PHOTOSYNTHESIS_SAMPLE_SCRIPT;

function parseDemoContent(): ScriptSection[] {
  // For PicEd format, we just store raw text sections
  const sections: ScriptSection[] = [];
  sections.push({ type: 'title', content: 'Photosynthesis and Its Process | Senior 2 Biology' });
  sections.push({ type: 'text', content: 'PicEd Format Demo — Frame-by-Frame Script' });
  return sections;
}

interface SampleUploaderProps {
  sampleScripts: ParsedScript[];
  onScriptsUpdate: (scripts: ParsedScript[]) => void;
}

export function SampleUploader({ sampleScripts, onScriptsUpdate }: SampleUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    setIsProcessing(true);
    setError('');
    
    const newScripts: ParsedScript[] = [];
    
    for (const file of Array.from(files)) {
      if (!file.name.endsWith('.docx') && !file.name.endsWith('.doc')) {
        setError('Please upload Word documents (.docx or .doc files)');
        continue;
      }
      
      try {
        const { rawText, sections, htmlContent, format, metadata } = await parseWordDocument(file);
        
        const script: ParsedScript = {
          id: `script-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          name: file.name,
          subject: metadata.subject,
          sections,
          rawText,
          htmlContent,
          format,
          metadata,
          patterns: analyzePatterns([{ 
            id: '', 
            name: '', 
            subject: metadata.subject, 
            sections, 
            rawText,
            htmlContent,
            format,
            metadata,
            patterns: {} as ParsedScript['patterns'] 
          }]),
        };
        
        newScripts.push(script);
      } catch (err) {
        console.error('Error parsing file:', err);
        setError(`Failed to parse ${file.name}`);
      }
    }
    
    if (newScripts.length > 0) {
      onScriptsUpdate([...sampleScripts, ...newScripts]);
    }
    
    setIsProcessing(false);
  }, [sampleScripts, onScriptsUpdate]);

  const loadDemoScript = () => {
    const sections = parseDemoContent();
    const defaultFormat = getDefaultFormat();
    defaultFormat.isPicEdFormat = true;
    defaultFormat.frameTypes = ['Intro Screen', 'Title Screen', 'Wide', 'Wide with Image', 'Null', 'Summary', 'Outro Screen'];
    const demoMetadata = {
      title: 'Photosynthesis and Its Process',
      subject: 'Biology',
      chapter: 'Nutrition in Plants',
      topic: 'Photosynthesis',
      targetAudience: 'Senior Secondary (16-18 years)',
      estimatedDuration: '10 minutes',
      wordCount: DEMO_SCRIPT_CONTENT.split(/\s+/).length,
      sectionCount: sections.length,
      learningObjective: 'Meaning and equation of photosynthesis and its implications',
    };
    const demoScript: ParsedScript = {
      id: `demo-${Date.now()}`,
      name: 'PicEd_Photosynthesis_Script.docx',
      subject: 'Biology',
      sections,
      rawText: DEMO_SCRIPT_CONTENT,
      htmlContent: '',
      format: defaultFormat,
      metadata: demoMetadata,
      patterns: analyzePatterns([{
        id: '',
        name: '',
        subject: 'Biology',
        sections,
        rawText: DEMO_SCRIPT_CONTENT,
        htmlContent: '',
        format: defaultFormat,
        metadata: demoMetadata,
        patterns: {} as ParsedScript['patterns']
      }]),
    };
    onScriptsUpdate([...sampleScripts, demoScript]);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const removeScript = (id: string) => {
    onScriptsUpdate(sampleScripts.filter(s => s.id !== id));
  };

  return (
    <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="bg-purple-100 p-2 rounded-lg">
          <Upload className="w-5 h-5 text-purple-600" />
        </div>
        <div>
          <h3 className="font-semibold text-slate-800">Sample Scripts</h3>
          <p className="text-sm text-slate-500">Upload your existing scripts for format learning</p>
        </div>
      </div>

      {/* Upload Zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer ${
          isDragging
            ? 'border-purple-500 bg-purple-50'
            : 'border-slate-300 hover:border-purple-400 hover:bg-slate-50'
        }`}
      >
        <input
          type="file"
          accept=".docx,.doc"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
          id="file-upload"
        />
        <label htmlFor="file-upload" className="cursor-pointer">
          {isProcessing ? (
            <div className="flex flex-col items-center">
              <Loader2 className="w-10 h-10 text-purple-500 animate-spin mb-3" />
              <p className="text-slate-600">Processing documents...</p>
            </div>
          ) : (
            <div className="flex flex-col items-center">
              <div className="bg-purple-100 p-4 rounded-full mb-3">
                <FileText className="w-8 h-8 text-purple-600" />
              </div>
              <p className="font-medium text-slate-700 mb-1">
                Drop Word documents here or click to upload
              </p>
              <p className="text-sm text-slate-500">
                Upload .docx files containing your script format
              </p>
            </div>
          )}
        </label>
      </div>

      {/* Demo Button */}
      {sampleScripts.length === 0 && (
        <div className="mt-4">
          <button
            onClick={loadDemoScript}
            className="w-full flex items-center justify-center gap-2 py-3 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-lg font-medium hover:from-amber-600 hover:to-orange-600 transition-all"
          >
            <Wand2 className="w-5 h-5" />
            Load Demo Script (Try without uploading)
          </button>
          <p className="text-xs text-center text-slate-500 mt-2">
            Use a pre-made biology script to test the platform
          </p>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="mt-4 flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg">
          <AlertCircle className="w-5 h-5" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {/* Uploaded Scripts List */}
      {sampleScripts.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-medium text-slate-700">Learned Scripts ({sampleScripts.length})</h4>
            <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full flex items-center gap-1">
              <CheckCircle className="w-3 h-3" />
              Format Analyzed
            </span>
          </div>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {sampleScripts.map((script) => (
              <div
                key={script.id}
                className="flex items-center justify-between bg-slate-50 rounded-lg p-3 group"
              >
                <div className="flex items-center gap-3">
                  <FileText className="w-5 h-5 text-slate-400" />
                  <div>
                    <p className="font-medium text-slate-700 text-sm">{script.name}</p>
                    <p className="text-xs text-slate-500">
                      {script.sections.length} sections • {script.subject} • {script.format.markers.narrator[0]} format
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => removeScript(script.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-100 rounded transition-all"
                >
                  <X className="w-4 h-4 text-red-500" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Learned Format Preview - Sample scripts are for FORMAT learning only */}
      {sampleScripts.length > 0 && (
        <div className="mt-4 p-4 bg-gradient-to-br from-purple-50 to-indigo-50 rounded-xl border border-purple-200">
          <h4 className="font-medium text-purple-800 mb-2 flex items-center gap-2">
            <span className="text-lg">📝</span>
            Learned Script Format
          </h4>
          <p className="text-xs text-purple-600 mb-3">
            This format will be used when generating new scripts
          </p>
          <div className="text-sm text-slate-600 space-y-2">
            <p className="flex items-center gap-2">
              <span className="font-medium text-purple-700">Markers:</span>
              <code className="bg-white px-2 py-0.5 rounded text-xs">{sampleScripts[0].format.markers.narrator[0]}</code>
              <code className="bg-white px-2 py-0.5 rounded text-xs">{sampleScripts[0].format.markers.visual[0]}</code>
              <code className="bg-white px-2 py-0.5 rounded text-xs">{sampleScripts[0].format.markers.image[0]}</code>
            </p>
            <p>
              <span className="font-medium text-purple-700">Narrator Style:</span>{' '}
              {analyzePatterns(sampleScripts).narratorStyle || 'Educational'}
            </p>
            <p>
              <span className="font-medium text-purple-700">Section Types:</span>{' '}
              {[...new Set(sampleScripts.flatMap(s => s.sections.map(sec => sec.type)))].join(', ')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// detectSubject is now handled by extractMetadata in wordParser.ts
