import { useState } from 'react';
import { Key, Check, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { getGroqKeyCount, getRefineGroqKeyCount, initializeGroq, isGroqInitialized } from '../utils/groqService';

interface ApiKeyInputProps {
  onKeySet: () => void;
}

export function ApiKeyInput({ onKeySet }: ApiKeyInputProps) {
  const [primaryApiKey, setPrimaryApiKey] = useState('');
  const [backupApiKey, setBackupApiKey] = useState('');
  const [refineApiKey, setRefineApiKey] = useState('');
  const [showPrimaryKey, setShowPrimaryKey] = useState(false);
  const [showBackupKey, setShowBackupKey] = useState(false);
  const [showRefineKey, setShowRefineKey] = useState(false);
  const [error, setError] = useState('');
  const [isSet, setIsSet] = useState(isGroqInitialized());
  const [keyCount, setKeyCount] = useState(getGroqKeyCount());
  const [refineKeyCount, setRefineKeyCount] = useState(getRefineGroqKeyCount());

  const handleSetKey = () => {
    const apiKeys = [primaryApiKey.trim(), backupApiKey.trim()].filter(Boolean);
    const refineApiKeys = [refineApiKey.trim()].filter(Boolean);
    if (apiKeys.length === 0) {
      setError('Please enter Groq API Key 1');
      return;
    }
    
    if ([...apiKeys, ...refineApiKeys].some(key => !key.startsWith('gsk_'))) {
      setError('Invalid API key format. Groq keys start with "gsk_"');
      return;
    }
    
    initializeGroq(apiKeys, refineApiKeys);
    setKeyCount(new Set(apiKeys).size);
    setRefineKeyCount(new Set(refineApiKeys).size);
    setIsSet(true);
    setError('');
    onKeySet();
  };

  if (isSet) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl p-4 flex items-center gap-3">
        <div className="bg-green-100 p-2 rounded-lg">
          <Check className="w-5 h-5 text-green-600" />
        </div>
        <div>
          <p className="font-medium text-green-800">{keyCount} API {keyCount === 1 ? 'Key' : 'Keys'} Connected</p>
          <p className="text-sm text-green-600">
            {refineKeyCount > 0
              ? 'Refine uses its dedicated API key; generation uses the main key set'
              : 'Groq AI will switch keys automatically if one hits a limit'}
          </p>
        </div>
        <button
          onClick={() => {
            setIsSet(false);
            setKeyCount(getGroqKeyCount());
            setRefineKeyCount(getRefineGroqKeyCount());
          }}
          className="ml-auto text-sm text-green-600 hover:text-green-800 underline"
        >
          Change Key
        </button>
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-br from-slate-50 to-slate-100 border border-slate-200 rounded-xl p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="bg-indigo-100 p-2 rounded-lg">
          <Key className="w-5 h-5 text-indigo-600" />
        </div>
        <div>
          <h3 className="font-semibold text-slate-800">Groq API Keys</h3>
          <p className="text-sm text-slate-500">Add generation keys and an optional dedicated refine key</p>
        </div>
      </div>
      
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Groq API Key 1</label>
          <div className="relative">
            <input
              type={showPrimaryKey ? 'text' : 'password'}
              value={primaryApiKey}
              onChange={(e) => setPrimaryApiKey(e.target.value)}
              placeholder="gsk_primary_key"
              className="w-full px-4 py-3 pr-12 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
            />
            <button
              type="button"
              onClick={() => setShowPrimaryKey(!showPrimaryKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              {showPrimaryKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Groq API Key 2</label>
          <div className="relative">
            <input
              type={showBackupKey ? 'text' : 'password'}
              value={backupApiKey}
              onChange={(e) => setBackupApiKey(e.target.value)}
              placeholder="gsk_backup_key_optional"
              className="w-full px-4 py-3 pr-12 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
            />
            <button
              type="button"
              onClick={() => setShowBackupKey(!showBackupKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              {showBackupKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Refine API Key</label>
          <div className="relative">
            <input
              type={showRefineKey ? 'text' : 'password'}
              value={refineApiKey}
              onChange={(e) => setRefineApiKey(e.target.value)}
              placeholder="gsk_refine_key_optional"
              className="w-full px-4 py-3 pr-12 border border-amber-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-amber-500 transition-all bg-amber-50/50"
            />
            <button
              type="button"
              onClick={() => setShowRefineKey(!showRefineKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              {showRefineKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
          <p className="mt-1 text-xs text-amber-700">
            Optional. When provided, only Refine and Force Body Text calls use this key.
          </p>
        </div>
        
        {error && (
          <div className="flex items-center gap-2 text-red-600 text-sm">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
        )}
        
        <button
          onClick={handleSetKey}
          className="w-full bg-indigo-600 text-white py-3 rounded-lg font-medium hover:bg-indigo-700 transition-colors"
        >
          Connect API Keys
        </button>
        
        <p className="text-xs text-slate-500 text-center">
          Get your free API key from{' '}
          <a
            href="https://console.groq.com/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-600 hover:underline"
          >
            console.groq.com
          </a>
        </p>
      </div>
    </div>
  );
}
