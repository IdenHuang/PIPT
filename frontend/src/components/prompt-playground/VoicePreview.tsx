import { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Square, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UI_COLORS } from '@/lib/colors';
import { authService } from '@/lib/auth';
import LoadingIndicator from '@/components/LoadingIndicator';
import { io, type Socket } from 'socket.io-client';
import { appConfig } from '@/config/aws-config';
import { getVoicesByAccent } from '@/lib/voice-constants';
import { attachSocketReauth } from '@/lib/socket-reauth';

// ---------------------------------------------------------------------------
// Build grouped voice data from shared constants (preserving locale for keys)
// ---------------------------------------------------------------------------

interface VoiceOptionWithLocale {
  id: string;
  name: string;
  gender: 'Feminine' | 'Masculine';
  locale: string;
}

interface VoiceGroup {
  language: string;
  voices: VoiceOptionWithLocale[];
}

const ACCENT_TO_LOCALE: Record<string, string> = {
  'English (US)': 'en-US',
  'English (UK)': 'en-GB',
  'English (AU)': 'en-AU',
  'English (IN)': 'en-IN',
};

const VOICE_GROUPS: VoiceGroup[] = getVoicesByAccent().map((g) => ({
  language: g.accent,
  voices: g.voices.map((v) => ({
    ...v,
    locale: ACCENT_TO_LOCALE[v.accent] || 'en-US',
  })),
}));

// Flat list for lookups
const ALL_VOICES = VOICE_GROUPS.flatMap((g) =>
  g.voices.map((v) => ({ ...v, language: g.language }))
);

// Unique key per voice entry (id can repeat across locales, e.g. kiara)
function vKey(id: string, locale: string) {
  return `${id}-${locale}`;
}

type PreviewState = 'idle' | 'connecting' | 'ready' | 'recording' | 'playing' | 'error';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface VoicePreviewProps {
  /** Currently selected voice ID (e.g. "tiffany"). When provided, the component acts as a controlled selector. */
  value?: string;
  /** Called when the user selects a different voice. Receives the voice id (e.g. "tiffany"). */
  onChange?: (voiceId: string) => void;
}

export default function VoicePreview({ value, onChange }: VoicePreviewProps = {}) {
  // Derive initial key from controlled value prop, or fall back to default
  const getKeyFromId = (id: string | undefined) => {
    if (!id) return 'tiffany-en-US';
    const match = ALL_VOICES.find((v) => v.id === id);
    return match ? vKey(match.id, match.locale) : 'tiffany-en-US';
  };

  const [selectedKey, setSelectedKey] = useState(() => getKeyFromId(value));
  const [previewState, setPreviewState] = useState<PreviewState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Sync internal state when controlled value changes externally
  useEffect(() => {
    if (value !== undefined) {
      setSelectedKey(getKeyFromId(value));
    }
  }, [value]);

  const handleVoiceSelect = useCallback((key: string) => {
    setSelectedKey(key);
    // Extract voice id from the composite key and notify parent
    const voice = ALL_VOICES.find((v) => vKey(v.id, v.locale) === key);
    if (voice && onChange) {
      onChange(voice.id);
    }
  }, [onChange]);

  const selected = ALL_VOICES.find((v) => vKey(v.id, v.locale) === selectedKey) ?? ALL_VOICES[0];
  const canChangeVoice = previewState === 'idle' || previewState === 'error';

  // Refs for cleanup
  const socketRef = useRef<Socket | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopMic = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (micCtxRef.current) {
      micCtxRef.current.close().catch(() => {});
      micCtxRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    stopMic();
    if (socketRef.current) {
      socketRef.current.emit('stop-voice-preview', {});
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    if (playbackCtxRef.current) {
      playbackCtxRef.current.close().catch(() => {});
      playbackCtxRef.current = null;
    }
    nextPlayTimeRef.current = 0;
  }, [stopMic]);

  useEffect(() => cleanup, [cleanup]);

  const playAudioChunk = useCallback((base64Data: string) => {
    const ctx = playbackCtxRef.current;
    if (!ctx) return;

    const raw = atob(base64Data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now, nextPlayTimeRef.current);
    source.start(startAt);
    nextPlayTimeRef.current = startAt + buffer.duration;
  }, []);

  // ── Connect ───────────────────────────────────────────────────────────────
  const handleConnect = useCallback(async () => {
    cleanup();
    setPreviewState('connecting');
    setErrorMessage(null);

    try {
      playbackCtxRef.current = new AudioContext({ sampleRate: 24000 });
      if (playbackCtxRef.current.state === 'suspended') {
        await playbackCtxRef.current.resume();
      }
      nextPlayTimeRef.current = 0;

      const token = await authService.getIdToken();
      if (!token) throw new Error('Not authenticated');

      const socketUrl = appConfig.socket.url;
      if (!socketUrl) throw new Error('Socket server URL not configured');

      const socket = io(socketUrl, {
        transports: ['websocket'],
        // Function form so a reconnect fetches a current token, not this one.
        auth: (cb) => {
          authService.getIdToken()
            .then((t) => cb({ token: t || '' }))
            .catch(() => cb({ token: '' }));
        },
      });
      socketRef.current = socket;
      // The cached token can be within a minute or two of expiry; renew it so
      // the server doesn't end the preview part-way through.
      attachSocketReauth(socket, {
        onExpired: (message) => {
          setErrorMessage(message);
          setPreviewState('error');
          cleanup();
        },
      });

      socket.on('audio-chunk', (data: { data: string }) => {
        stopMic();
        setPreviewState('playing');
        playAudioChunk(data.data);

        if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
        autoStopTimerRef.current = setTimeout(() => {
          setPreviewState('ready');
        }, 2000);
      });

      socket.on('voice-preview-ready', () => setPreviewState('ready'));

      socket.on('voice-preview-done', () => {
        setPreviewState('idle');
        cleanup();
      });

      socket.on('nova-error', (data: { error: string }) => {
        setErrorMessage(data.error);
        setPreviewState('error');
        cleanup();
      });

      socket.on('connect_error', (err: Error) => {
        setErrorMessage(err.message || 'Failed to connect to voice server');
        setPreviewState('error');
        cleanup();
      });

      socket.emit('voice-preview', { voice_id: selected.id });

      // Safety timeout — 60s max session
      autoStopTimerRef.current = setTimeout(() => {
        setPreviewState('idle');
        cleanup();
      }, 60000);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to start preview');
      setPreviewState('error');
      cleanup();
    }
  }, [selected, cleanup, playAudioChunk]);

  // ── Record ────────────────────────────────────────────────────────────────
  const handleStartRecording = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      micStreamRef.current = stream;

      const micCtx = new AudioContext({ sampleRate: 16000 });
      micCtxRef.current = micCtx;

      const source = micCtx.createMediaStreamSource(stream);
      const processor = micCtx.createScriptProcessor(4096, 1, 1);

      socket.emit('voice-preview-start-audio');
      setPreviewState('recording');

      processor.onaudioprocess = (e) => {
        const f32 = e.inputBuffer.getChannelData(0);
        const i16 = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
          const s = Math.max(-1, Math.min(1, f32[i]));
          i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        socket.emit('voice-preview-audio', {
          data: btoa(String.fromCharCode(...new Uint8Array(i16.buffer))),
        });
      };

      source.connect(processor);
      processor.connect(micCtx.destination);
      processorRef.current = processor;
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Microphone access denied');
      setPreviewState('error');
    }
  }, []);

  const handleStopRecording = useCallback(() => {
    socketRef.current?.emit('voice-preview-end-audio');
    stopMic();
    setPreviewState('ready');
  }, [stopMic]);

  const handleDisconnect = useCallback(() => {
    cleanup();
    setPreviewState('idle');
  }, [cleanup]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-4xl space-y-6">
      {/* Header + Controls side by side */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium mb-1" style={{ color: UI_COLORS.text.body }}>
            Voice Preview
          </h2>
          <p className="text-sm" style={{ color: UI_COLORS.text.muted }}>
            These voices are provided by Amazon Nova Sonic 2. Select a voice, connect, then tap the mic and say hello to hear how it sounds.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0 pt-1">
          {previewState === 'idle' || previewState === 'error' ? (
            <Button
              onClick={handleConnect}
              className="px-6 gap-2 transition-colors"
              style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primary)}
            >
              <Volume2 className="w-4 h-4" />
              Connect
            </Button>
          ) : previewState === 'connecting' ? (
            <LoadingIndicator size="sm" message="Connecting..." />
          ) : previewState === 'ready' ? (
            <div className="flex items-center gap-3">
              <Button
                onClick={handleStartRecording}
                className="px-6 gap-2 transition-colors"
                style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primary)}
              >
                <Mic className="w-4 h-4" />
                Tap to Speak
              </Button>
              <Button
                onClick={handleDisconnect}
                variant="outline"
                className="px-4 gap-2"
                style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}
              >
                <Square className="w-4 h-4" />
                Disconnect
              </Button>
            </div>
          ) : previewState === 'recording' ? (
            <Button
              onClick={handleStopRecording}
              className="px-6 gap-2 transition-colors animate-pulse"
              style={{ backgroundColor: UI_COLORS.status.error, color: '#fff' }}
            >
              <Mic className="w-4 h-4" />
              Click to Stop
            </Button>
          ) : previewState === 'playing' ? (
            <div className="flex items-center gap-2">
              <div className="flex items-end gap-1">
                {[14, 22, 16, 26, 18].map((h, i) => (
                  <div
                    key={i}
                    className="w-1 rounded-full"
                    style={{
                      backgroundColor: UI_COLORS.button.primary,
                      height: `${h}px`,
                      animation: `loadingPulse 1.2s ease-in-out ${i * 0.15}s infinite`,
                    }}
                  />
                ))}
              </div>
              <span className="text-sm font-medium" style={{ color: UI_COLORS.text.body }}>
                {selected.name} ({selected.language})
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {previewState === 'recording' && (
        <div className="flex items-center gap-2">
          <div className="flex items-end gap-1">
            {[14, 22, 16, 26, 18].map((h, i) => (
              <div
                key={i}
                className="w-1 rounded-full"
                style={{
                  backgroundColor: UI_COLORS.status.error,
                  height: `${h}px`,
                  animation: `loadingPulse 1.2s ease-in-out ${i * 0.15}s infinite`,
                }}
              />
            ))}
          </div>
          <span className="text-sm" style={{ color: UI_COLORS.status.error }}>Listening...</span>
        </div>
      )}

      {errorMessage && (
        <p className="text-sm" style={{ color: UI_COLORS.status.error }}>
          {errorMessage}
        </p>
      )}

      {/* Voice Selection — grouped by accent */}
      <div className="space-y-4">
        {VOICE_GROUPS.map((group) => (
          <div key={group.language}>
            <label className="text-sm font-medium mb-2 block" style={{ color: UI_COLORS.text.heading }}>
              {group.language}
            </label>
            <div className="flex flex-wrap gap-3">
              {group.voices.map((voice) => {
                const key = vKey(voice.id, voice.locale);
                const isSelected = selectedKey === key;
                return (
                  <button
                    key={key}
                    onClick={() => canChangeVoice && handleVoiceSelect(key)}
                    disabled={!canChangeVoice}
                    className="rounded-lg p-3 text-left transition-all"
                    style={{
                      backgroundColor: isSelected ? UI_COLORS.background.tableHeader : UI_COLORS.background.white,
                      borderWidth: '2px',
                      borderStyle: 'solid',
                      borderColor: isSelected ? UI_COLORS.button.primary : UI_COLORS.border.default,
                      cursor: canChangeVoice ? 'pointer' : 'default',
                      opacity: !canChangeVoice && !isSelected ? 0.5 : 1,
                      minWidth: '140px',
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                        style={{
                          backgroundColor: isSelected ? UI_COLORS.button.primary : UI_COLORS.border.light,
                        }}
                      >
                        <Volume2
                          className="w-4 h-4"
                          style={{ color: isSelected ? '#fff' : UI_COLORS.text.muted }}
                        />
                      </div>
                      <div>
                        <p className="font-semibold text-sm" style={{ color: UI_COLORS.text.heading }}>
                          {voice.name}
                        </p>
                        <p className="text-xs" style={{ color: UI_COLORS.text.muted }}>
                          {voice.gender}
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {errorMessage && previewState !== 'idle' && (
        <p className="text-sm" style={{ color: UI_COLORS.status.error }}>
          {errorMessage}
        </p>
      )}

      <style>{`
        @keyframes loadingPulse {
          0%, 100% { transform: scaleY(1); opacity: 0.5; }
          50% { transform: scaleY(1.8); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
