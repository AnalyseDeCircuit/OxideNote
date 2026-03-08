/**
 * Speech Recognition wrapper for voice input
 *
 * Uses the Web Speech API (SpeechRecognition) when available.
 * Falls back gracefully with a "not supported" error on platforms
 * where the API is unavailable (e.g. Tauri WebKit on macOS).
 *
 * Note: On macOS WebKit, the SpeechRecognition constructor may exist
 * but the service is blocked, resulting in a "service-not-allowed"
 * error. We treat this the same as "not supported".
 */

// ── Type declarations for Web Speech API ────────────────────

interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
  readonly resultIndex: number;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

// ─── Check availability ─────────────────────────────────────

export function isSpeechRecognitionSupported(): boolean {
  return !!(
    (window as unknown as Record<string, unknown>).SpeechRecognition ||
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition
  );
}

// ─── Create a SpeechRecognition instance ─────────────────────

function createRecognition(): SpeechRecognition | null {
  const SpeechRecognitionCtor = (window as unknown as Record<string, unknown>).SpeechRecognition ||
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) return null;
  return new (SpeechRecognitionCtor as new () => SpeechRecognition)();
}

// ─── Voice input controller ─────────────────────────────────

export interface VoiceInputCallbacks {
  onResult: (transcript: string, isFinal: boolean) => void;
  onError: (error: string) => void;
  onEnd: () => void;
  onStart: () => void;
}

let activeRecognition: SpeechRecognition | null = null;

/**
 * Start voice input. Returns a stop function.
 * Throws if the platform does not support speech recognition.
 */
export function startVoiceInput(
  lang: string,
  callbacks: VoiceInputCallbacks
): () => void {
  // Stop any existing session
  if (activeRecognition) {
    activeRecognition.abort();
    activeRecognition = null;
  }

  const recognition = createRecognition();
  if (!recognition) {
    callbacks.onError('not_supported');
    return () => {};
  }

  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => callbacks.onStart();

  recognition.onresult = (event) => {
    // Process results starting from the latest
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      callbacks.onResult(result[0].transcript, result.isFinal);
    }
  };

  recognition.onerror = (event) => {
    // "service-not-allowed" and "not-allowed" mean the platform
    // does not permit speech recognition (common in Tauri WebKit).
    // Treat these as "not supported" for a clearer user message.
    if (event.error === 'service-not-allowed' || event.error === 'not-allowed') {
      callbacks.onError('not_supported');
    } else {
      callbacks.onError(event.error);
    }
  };

  recognition.onend = () => {
    activeRecognition = null;
    callbacks.onEnd();
  };

  activeRecognition = recognition;

  // recognition.start() may throw synchronously on platforms where
  // the speech service is blocked (e.g. Tauri WebKit on macOS).
  try {
    recognition.start();
  } catch {
    activeRecognition = null;
    callbacks.onError('not_supported');
    return () => {};
  }

  return () => {
    recognition.stop();
    activeRecognition = null;
  };
}

/**
 * Stop any active voice input session.
 */
export function stopVoiceInput(): void {
  if (activeRecognition) {
    activeRecognition.stop();
    activeRecognition = null;
  }
}
