import { useState } from 'react';
import mammoth from 'mammoth';
import { AlertCircle, Check, Copy, FileUp, Image as ImageIcon, Loader2, Sparkles, Users } from 'lucide-react';
import { ParsedScript } from '../types';
import { isGroqInitialized, suggestImagePromptsForFinalScript } from '../utils/groqService';

interface FinalScriptImagePromptsProps {
  topic?: string;
  subject?: string;
  targetAudience?: string;
  sampleScripts?: ParsedScript[];
}

const AUDIENCES = [
  'Elementary School (6-10 years)',
  'Middle School (11-14 years)',
  'High School (15-18 years)',
  'Senior Secondary (16-18 years)',
  'College/University',
  'Adult Learners',
  'General Audience',
];

async function readFinalScriptFile(file: File): Promise<string> {
  const isText = file.name.toLowerCase().endsWith('.txt');
  if (isText) return file.text();

  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
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

export function FinalScriptImagePrompts({
  topic,
  subject,
  targetAudience,
  sampleScripts = [],
}: FinalScriptImagePromptsProps) {
  const [scriptText, setScriptText] = useState('');
  const [fileName, setFileName] = useState('');
  const [suggestions, setSuggestions] = useState('');
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [audience, setAudience] = useState(targetAudience || 'Middle School (11-14 years)');

  const handleFile = async (file?: File) => {
    if (!file) return;
    setError('');
    setSuggestions('');
    setCopied(false);
    try {
      const text = await readFinalScriptFile(file);
      if (!text.trim()) {
        setError('Could not read text from this file.');
        return;
      }
      setScriptText(text);
      setFileName(file.name);
    } catch (err) {
      console.error('Final script read error:', err);
      setError('Could not read this final script. Please upload a .docx or .txt file.');
    }
  };

  const handleSuggest = async () => {
    setError('');
    setCopied(false);

    if (!isGroqInitialized()) {
      setError('Please connect your Groq API key first.');
      return;
    }

    if (!scriptText.trim()) {
      setError('Upload or paste the final script first.');
      return;
    }

    setIsWorking(true);
    try {
      const result = await suggestImagePromptsForFinalScript(scriptText, {
        topic,
        subject,
        targetAudience: audience,
        sampleScriptReference: sampleScripts[0]?.rawText || '',
      });
      setSuggestions(result);
    } catch (err) {
      console.error('Image prompt suggestion error:', err);
      setError(err instanceof Error ? err.message : 'Could not suggest image prompts.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleCopy = async () => {
    if (!suggestions) return;
    await copyText(suggestions);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-6">
      <div className="flex items-center justify-between gap-4 mb-5">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-br from-cyan-500 to-blue-600 p-2 rounded-lg">
            <ImageIcon className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-800">Final Script With Image Prompts</h3>
            <p className="text-sm text-slate-500">Upload the edited script and generate the full three-column script with grounded prompts</p>
          </div>
        </div>
        {fileName && (
          <span className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded-full border border-blue-200">
            {fileName}
          </span>
        )}
      </div>

      <div className="space-y-4">
        <label className="block rounded-xl border-2 border-dashed border-blue-200 bg-blue-50/60 p-5 text-center cursor-pointer hover:bg-blue-50 transition-colors">
          <FileUp className="w-8 h-8 text-blue-600 mx-auto mb-2" />
          <span className="block font-medium text-slate-800">Upload final script</span>
          <span className="block text-sm text-slate-500">Word .docx or plain text</span>
          <input
            type="file"
            accept=".docx,.doc,.txt"
            className="hidden"
            onChange={event => {
              void handleFile(event.target.files?.[0]);
              event.currentTarget.value = '';
            }}
          />
        </label>

        <textarea
          value={scriptText}
          onChange={event => {
            setScriptText(event.target.value);
            setFileName('');
            setSuggestions('');
            setCopied(false);
            if (error) setError('');
          }}
          rows={8}
          placeholder="Or paste the final edited script here."
          className="w-full px-4 py-3 border border-slate-300 rounded-xl resize-y focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
        />

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">
            <Users className="w-4 h-4 inline mr-1" />
            Age Group
          </label>
          <select
            value={audience}
            onChange={event => {
              setAudience(event.target.value);
              setSuggestions('');
              setCopied(false);
              if (error) setError('');
            }}
            className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all bg-white"
          >
            {AUDIENCES.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        <button
          type="button"
          onClick={handleSuggest}
          disabled={isWorking || !scriptText.trim()}
          className={`w-full py-3 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
            isWorking || !scriptText.trim()
              ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
              : 'bg-gradient-to-r from-blue-600 to-cyan-600 text-white hover:from-blue-700 hover:to-cyan-700 shadow-lg hover:shadow-xl'
          }`}
        >
          {isWorking ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Reading Final Script...
            </>
          ) : (
            <>
              <Sparkles className="w-5 h-5" />
              Generate Final Script
            </>
          )}
        </button>

        {suggestions && (
          <div className="rounded-xl border border-blue-200 bg-slate-50 overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 bg-white border-b border-blue-100">
              <span className="font-semibold text-slate-800">Final Script With Image Prompts</span>
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-200 text-slate-700 text-sm font-medium hover:bg-slate-300"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap p-4 text-sm leading-6 text-slate-700 font-sans">
              {suggestions}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
