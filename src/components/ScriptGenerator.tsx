import { useState, useEffect, useCallback } from 'react';
import { Sparkles, BookOpen, Users, Clock, Loader2, AlertCircle, GraduationCap, Target, Mic, ShieldCheck } from 'lucide-react';
import { ParsedScript, GenerationRequest } from '../types';
import { extractTeacherName, generateScript, isGroqInitialized } from '../utils/groqService';
import { BookContentInput } from './BookContentInput';
import { ContentMetadata } from '../utils/contentAnalyzer';

interface ScriptMeta {
  chapter?: string;
  topic?: string;
  learningObjective?: string;
  preserveAudioCues?: boolean;
}

interface ScriptGeneratorProps {
  sampleScripts: ParsedScript[];
  onGenerate: (script: string, topic: string, subject: string, meta?: ScriptMeta) => void;
  isGenerating: boolean;
  setIsGenerating: (value: boolean) => void;
}

const SUBJECTS = [
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

const AUDIENCES = [
  'Elementary School (6-10 years)',
  'Middle School (11-14 years)',
  'High School (15-18 years)',
  'Senior Secondary (16-18 years)',
  'College/University',
  'Adult Learners',
  'General Audience',
];

const DURATIONS = [
  '2-3 minutes',
  '5 minutes',
  '10 minutes',
  '15 minutes',
  '20+ minutes',
];

export function ScriptGenerator({
  sampleScripts,
  onGenerate,
  isGenerating,
  setIsGenerating,
}: ScriptGeneratorProps) {
  const [topic, setTopic] = useState('');
  const [subject, setSubject] = useState('Biology');
  const [chapter, setChapter] = useState('');
  const [bookContent, setBookContent] = useState('');
  const [audience, setAudience] = useState('High School (15-18 years)');
  const [duration, setDuration] = useState('5 minutes');
  const [learningObjective, setLearningObjective] = useState('');
  const [teacherName, setTeacherName] = useState('');
  const [error, setError] = useState('');
  const [streamedContent, setStreamedContent] = useState('');
  const [autoFilled, setAutoFilled] = useState(false);
  const [teacherNameManual, setTeacherNameManual] = useState(false);
  const [preserveAudioCues, setPreserveAudioCues] = useState(false);
  const [strictFrameByFrame, setStrictFrameByFrame] = useState(true);

  // Handle metadata detected from book content
  const handleMetadataDetected = useCallback((metadata: ContentMetadata) => {
    if (metadata.topic && metadata.topic.length > 0) {
      setTopic(metadata.topic);
    }
    if (metadata.subject && SUBJECTS.includes(metadata.subject)) {
      setSubject(metadata.subject);
    }
    if (metadata.targetAudience && AUDIENCES.includes(metadata.targetAudience)) {
      setAudience(metadata.targetAudience);
    }
    if (metadata.estimatedDuration && DURATIONS.includes(metadata.estimatedDuration)) {
      setDuration(metadata.estimatedDuration);
    }
    setAutoFilled(true);
  }, []);

  // Auto-extract teacher name from the uploaded source content only.
  useEffect(() => {
    if (teacherNameManual) return;
    setTeacherName(extractTeacherName(bookContent));
  }, [bookContent, teacherNameManual]);

  // Reset auto-filled indicator when content is cleared
  useEffect(() => {
    if (!bookContent || bookContent.length < 50) {
      setAutoFilled(false);
    }
  }, [bookContent]);

  const handleGenerate = async () => {
    setError('');
    
    if (!isGroqInitialized()) {
      setError('Please connect your Groq API key first');
      return;
    }
    
    if (!topic.trim()) {
      setError('Please enter a topic for the script');
      return;
    }
    
    if (!bookContent.trim()) {
      setError('Please provide content from books or source material');
      return;
    }
    
    if (sampleScripts.length === 0) {
      setError('Please upload at least one sample script for format learning');
      return;
    }
    
    setIsGenerating(true);
    setStreamedContent('');
    
    const request: GenerationRequest = {
      topic,
      subject,
      chapter,
      bookContent,
      targetAudience: audience,
      duration,
      learningObjective,
      teacherName,
      preserveAudioCues,
      strictFrameByFrame,
    };
    
    try {
      const generated = await generateScript(request, sampleScripts, (chunk) => {
        setStreamedContent(chunk);
      });
      
      const m: ScriptMeta = { chapter, topic, learningObjective, preserveAudioCues };
      setStreamedContent(generated);
      onGenerate(generated, topic, subject, m);
    } catch (err) {
      console.error('Generation error:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate script. Please try again.');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-br from-amber-400 to-orange-500 p-2 rounded-lg">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-800">Generate New Script</h3>
            <p className="text-sm text-slate-500">Provide book content and let AI create the script</p>
          </div>
        </div>
        {autoFilled && (
          <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full flex items-center gap-1">
            <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>
            Auto-filled from content
          </span>
        )}
      </div>

      <div className="space-y-5">
        {/* Book Content Input - PRIMARY INPUT */}
        <div className="p-4 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl border border-blue-200">
          <div className="flex items-center gap-2 mb-3">
            <BookOpen className="w-5 h-5 text-blue-600" />
            <span className="font-medium text-blue-800">Step 1: Add Your Source Content</span>
          </div>
          <BookContentInput
            content={bookContent}
            onContentChange={setBookContent}
            onMetadataDetected={handleMetadataDetected}
          />
        </div>

        {/* Auto-detected Settings */}
        <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="w-5 h-5 text-amber-500" />
            <span className="font-medium text-slate-700">Step 2: Review Video Details</span>
            {autoFilled && (
              <span className="text-xs text-slate-500">(auto-filled from your content)</span>
            )}
          </div>

          {/* Video Title / Topic */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Video Title / Topic
            </label>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g., Photosynthesis and Its Process"
              className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all ${
                autoFilled && topic ? 'border-green-300 bg-green-50' : 'border-slate-300'
              }`}
            />
          </div>

          {/* Subject and Chapter Row */}
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                <BookOpen className="w-4 h-4 inline mr-1" />
                Subject
              </label>
              <select
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all bg-white ${
                  autoFilled ? 'border-green-300 bg-green-50' : 'border-slate-300'
                }`}
              >
                {SUBJECTS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                <GraduationCap className="w-4 h-4 inline mr-1" />
                Chapter (Optional)
              </label>
              <input
                type="text"
                value={chapter}
                onChange={(e) => setChapter(e.target.value)}
                placeholder="e.g., Nutrition in Plants"
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
              />
            </div>
          </div>

          {/* Audience and Duration Row */}
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                <Users className="w-4 h-4 inline mr-1" />
                Target Audience
              </label>
              <select
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all bg-white ${
                  autoFilled ? 'border-green-300 bg-green-50' : 'border-slate-300'
                }`}
              >
                {AUDIENCES.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                <Clock className="w-4 h-4 inline mr-1" />
                Video Duration
              </label>
              <select
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all bg-white ${
                  autoFilled ? 'border-green-300 bg-green-50' : 'border-slate-300'
                }`}
              >
                {DURATIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Learning Objective */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">
              <Target className="w-4 h-4 inline mr-1" />
              Learning Objective (Optional)
            </label>
            <input
              type="text"
              value={learningObjective}
              onChange={(e) => setLearningObjective(e.target.value)}
              placeholder="e.g., Understand the process and equation of photosynthesis"
              className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
            />
          </div>

          {/* Teacher Name */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Teacher Name (Optional)
            </label>
            <input
              type="text"
              value={teacherName}
              onChange={(e) => {
                setTeacherNameManual(true);
                setTeacherName(e.target.value);
              }}
              placeholder="e.g., Mr. John Smith"
              className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
            />
          </div>

          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-3">
            <button
              type="button"
              onClick={() => setPreserveAudioCues(value => !value)}
              aria-pressed={preserveAudioCues}
              className={`w-full flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left transition-all ${
                preserveAudioCues
                  ? 'border-amber-500 bg-amber-100 text-amber-900'
                  : 'border-amber-200 bg-white text-slate-700 hover:bg-amber-50'
              }`}
            >
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <span className={`shrink-0 rounded-md p-2 ${preserveAudioCues ? 'bg-amber-500 text-white' : 'bg-amber-100 text-amber-700'}`}>
                  <Mic className="w-4 h-4" />
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold">
                    {preserveAudioCues ? 'Exact Audio Cues Enabled' : 'Keep Audio Cues Exact'}
                  </span>
                  <span className="block text-sm text-slate-600">
                    Use recorded narration exactly; divider lines split screens, otherwise each line becomes one screen.
                  </span>
                </span>
              </span>
              <span className={`shrink-0 text-xs font-semibold px-2 py-1 rounded-full ${preserveAudioCues ? 'bg-amber-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                {preserveAudioCues ? 'ON' : 'OFF'}
              </span>
            </button>

            {preserveAudioCues && (
              <button
                type="button"
                onClick={() => setStrictFrameByFrame(value => !value)}
                aria-pressed={strictFrameByFrame}
                className={`mt-3 w-full flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left transition-all ${
                  strictFrameByFrame
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-900'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className="flex min-w-0 flex-1 items-center gap-3">
                  <span className={`shrink-0 rounded-md p-2 ${strictFrameByFrame ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-700'}`}>
                    <ShieldCheck className="w-4 h-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold">
                      Safe Frame-by-Frame Generation
                    </span>
                    <span className="block text-sm text-slate-600">
                      Builds and validates each screen separately; stops before weak fallback content.
                    </span>
                  </span>
                </span>
                <span className={`shrink-0 text-xs font-semibold px-2 py-1 rounded-full ${strictFrameByFrame ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                  {strictFrameByFrame ? 'ON' : 'OFF'}
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        {/* Generate Button */}
        <button
          onClick={handleGenerate}
          disabled={isGenerating}
          className={`w-full py-4 rounded-xl font-semibold text-lg transition-all flex items-center justify-center gap-2 ${
            isGenerating
              ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
              : 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white hover:from-indigo-700 hover:to-purple-700 shadow-lg hover:shadow-xl'
          }`}
        >
          {isGenerating ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Generating Script...
            </>
          ) : (
            <>
              <Sparkles className="w-5 h-5" />
              Generate Script
            </>
          )}
        </button>

        {/* Status Indicators */}
        <div className="flex items-center justify-center gap-4 text-sm flex-wrap">
          <div className={`flex items-center gap-1 ${sampleScripts.length > 0 ? 'text-green-600' : 'text-slate-400'}`}>
            <div className={`w-2 h-2 rounded-full ${sampleScripts.length > 0 ? 'bg-green-500' : 'bg-slate-300'}`} />
            {sampleScripts.length} format sample{sampleScripts.length !== 1 ? 's' : ''}
          </div>
          <div className={`flex items-center gap-1 ${isGroqInitialized() ? 'text-green-600' : 'text-slate-400'}`}>
            <div className={`w-2 h-2 rounded-full ${isGroqInitialized() ? 'bg-green-500' : 'bg-slate-300'}`} />
            API {isGroqInitialized() ? 'Connected' : 'Not Connected'}
          </div>
          <div className={`flex items-center gap-1 ${bookContent.length > 50 ? 'text-green-600' : 'text-slate-400'}`}>
            <div className={`w-2 h-2 rounded-full ${bookContent.length > 50 ? 'bg-green-500' : 'bg-slate-300'}`} />
            Content {bookContent.length > 50 ? 'Ready' : 'Needed'}
          </div>
        </div>
      </div>

      {/* Live Generation Preview */}
      {isGenerating && streamedContent && (
        <div className="mt-6 p-4 bg-slate-50 rounded-xl border border-slate-200">
          <h4 className="text-sm font-medium text-slate-700 mb-2 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Generating Script...
          </h4>
          <pre className="text-sm text-slate-600 whitespace-pre-wrap font-mono max-h-60 overflow-y-auto">
            {streamedContent}
          </pre>
        </div>
      )}
    </div>
  );
}
