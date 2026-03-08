/**
 * AudioRecorder — In-app audio recording component
 *
 * Uses the browser's MediaRecorder API to capture audio from the
 * user's microphone. Detects the best supported audio mimeType
 * at runtime (webm → mp4 → ogg → default) to work across
 * different WebView engines (Chromium, WebKit, etc.).
 *
 * States: idle → recording → processing → idle
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { saveAttachment } from '@/lib/api';
import { toast } from '@/hooks/useToast';
import { Mic, Square } from 'lucide-react';

interface AudioRecorderProps {
  /** Called with the relative path of the saved audio attachment */
  onSaved: (relativePath: string) => void;
}

type RecordingState = 'idle' | 'recording' | 'processing';

// Preferred mimeType candidates in order of preference
const MIME_CANDIDATES: { mimeType: string; extension: string }[] = [
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
  { mimeType: 'audio/webm', extension: 'webm' },
  { mimeType: 'audio/mp4', extension: 'm4a' },
  { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' },
  { mimeType: 'audio/ogg', extension: 'ogg' },
];

/** Detect the best audio format supported by this WebView engine */
function detectAudioFormat(): { mimeType: string | null; extension: string } {
  if (typeof MediaRecorder === 'undefined') {
    return { mimeType: null, extension: 'webm' };
  }
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate.mimeType)) {
      return candidate;
    }
  }
  // Let the browser choose its default if nothing matched
  return { mimeType: null, extension: 'webm' };
}

/** Map a MIME type string to a file extension, with a fallback */
function extensionForMime(mime: string, fallback: string): string {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('webm')) return 'webm';
  return fallback;
}

export function AudioRecorder({ onSaved }: AudioRecorderProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<RecordingState>('idle');
  const [duration, setDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const streamRef = useRef<MediaStream | null>(null);
  const actualMimeRef = useRef<string>('audio/webm');
  const actualExtRef = useRef<string>('webm');

  // Cleanup on unmount: stop recording, release microphone, clear timer
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Start recording from the default microphone
  const handleStart = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Detect the best supported audio format for this platform
      const { mimeType, extension } = detectAudioFormat();

      const recorderOptions: MediaRecorderOptions = {};
      if (mimeType) recorderOptions.mimeType = mimeType;

      const recorder = new MediaRecorder(stream, recorderOptions);
      // Store the actual mimeType chosen by the recorder, then derive
      // the file extension from it to avoid extension/format mismatch
      actualMimeRef.current = recorder.mimeType || mimeType || 'audio/webm';
      actualExtRef.current = extensionForMime(actualMimeRef.current, extension);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        setState('processing');
        clearInterval(timerRef.current);

        // Stop all tracks to release the microphone
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        // Build the audio blob and convert to base64
        const blob = new Blob(chunksRef.current, { type: actualMimeRef.current });
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
        const base64 = btoa(binary);

        // Save via attachment API with the correct file extension
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `recording-${timestamp}.${actualExtRef.current}`;
        try {
          const relPath = await saveAttachment(base64, filename);
          onSaved(relPath);
          toast({ title: t('audio.saved'), description: relPath });
        } catch (err) {
          toast({ title: t('audio.saveFailed'), description: String(err), variant: 'error' });
        }

        setState('idle');
        setDuration(0);
      };

      recorder.start(500); // collect data every 500ms
      setState('recording');
      setDuration(0);

      // Duration timer
      timerRef.current = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);
    } catch (err) {
      toast({ title: t('audio.micError'), description: String(err), variant: 'error' });
    }
  }, [onSaved, t]);

  // Stop the current recording
  const handleStop = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  // Format seconds as mm:ss
  const formatDuration = (s: number) => {
    const min = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${min}:${sec}`;
  };

  return (
    <div className="inline-flex items-center gap-1.5">
      {state === 'idle' && (
        <button
          onClick={handleStart}
          className="px-2 py-1 text-xs rounded border border-theme-border hover:bg-theme-hover text-muted-foreground flex items-center gap-1"
          title={t('audio.startRecording')}
        >
          <Mic size={14} className="shrink-0" /> {t('audio.record')}
        </button>
      )}

      {state === 'recording' && (
        <>
          <span className="text-xs text-red-400 animate-pulse">● REC</span>
          <span className="text-xs text-muted-foreground font-mono">{formatDuration(duration)}</span>
          <button
            onClick={handleStop}
            className="px-2 py-1 text-xs rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30"
            title={t('audio.stopRecording')}
          >
            <Square size={12} className="shrink-0 fill-current" /> {t('audio.stop')}
          </button>
        </>
      )}

      {state === 'processing' && (
        <span className="text-xs text-muted-foreground">{t('audio.processing')}</span>
      )}
    </div>
  );
}
