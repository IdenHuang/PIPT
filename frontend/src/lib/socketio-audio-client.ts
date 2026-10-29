/**
 * Socket.IO Audio Client
 *
 * Captures microphone audio via Web Audio API, resamples to 16kHz mono PCM,
 * base64-encodes it, and sends it over Socket.IO as `audio-input` events.
 * Receives `audio-chunk` events (base64 24kHz PCM) and plays them back.
 *
 * This replaces WebRTCClient for the AgentCore WebSocket voice path.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SocketLike {
  emit(event: string, ...args: unknown[]): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener?: (...args: unknown[]) => void): void;
}

export type VoiceSessionState = 'idle' | 'connecting' | 'active' | 'disconnected' | 'error';

export interface SocketIOAudioClientConfig {
  socket: SocketLike;
  onStateChange: (state: VoiceSessionState) => void;
  onError: (error: Error) => void;
  onTextMessage?: (text: string, role: 'user' | 'assistant') => void;
  onTurnStart?: (role: 'user' | 'assistant') => void;
  /** Called when the server ends the voice session (e.g. Bedrock 60s timeout). */
  onSessionEnded?: (reason: string, message: string) => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Wait this long for `nova-started` (longer than the server's 60s limit). */
const CONNECT_TIMEOUT_MS = 75000;

export class SocketIOAudioClient {
  private config: SocketIOAudioClientConfig;
  private state: VoiceSessionState = 'idle';
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private playbackContext: AudioContext | null = null;
  private muted = false;

  // Bound listeners for cleanup
  private boundOnAudioChunk: ((...args: unknown[]) => void) | null = null;
  private boundOnNovaStarted: ((...args: unknown[]) => void) | null = null;
  private boundOnNovaError: ((...args: unknown[]) => void) | null = null;
  private boundOnTextMessage: ((...args: unknown[]) => void) | null = null;
  private boundOnTurnStart: ((...args: unknown[]) => void) | null = null;
  private boundOnSessionEnded: ((...args: unknown[]) => void) | null = null;
  private boundOnAudioFlush: ((...args: unknown[]) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: SocketIOAudioClientConfig) {
    this.config = config;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Start a voice session:
   * 1. Capture mic audio
   * 2. Emit `start-nova-sonic` with session config
   * 3. Wait for `nova-started` from server
   * 4. Begin streaming audio frames
   */
  async connect(sessionConfig: Record<string, unknown> = {}): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot connect: current state is "${this.state}"`);
    }

    this.setState('connecting');

    try {
      // 1. Capture mono mic audio
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000 },
      });

      // 2. Set up playback context for incoming audio
      this.playbackContext = new AudioContext({ sampleRate: 24000 });
      this.nextPlayTime = 0;

      // 3. Wire up Socket.IO listeners
      this.boundOnNovaStarted = () => {
        this.clearConnectTimer();
        this.setState('active');
        // Start audio capture only after Nova Sonic is ready
        // to avoid dropping early frames
        this.startCapture().catch((err) => {
          this.fail(err instanceof Error ? err.message : String(err));
        });
      };
      this.boundOnAudioChunk = (data: unknown) => {
        const msg = data as { data: string };
        this.playAudioChunk(msg.data);
      };
      this.boundOnNovaError = (data: unknown) => {
        const msg = data as { error: string };
        this.fail(msg.error);
      };

      this.config.socket.on('nova-started', this.boundOnNovaStarted);
      this.config.socket.on('audio-chunk', this.boundOnAudioChunk);
      this.config.socket.on('nova-error', this.boundOnNovaError);

      // The guardrail blocked (or couldn't screen) the AI reply: stop any of
      // its audio that is still queued for playback.
      this.boundOnAudioFlush = () => {
        this.flushPlaybackQueue();
      };
      this.config.socket.on('audio-flush', this.boundOnAudioFlush);

      // Listen for server-side session end (e.g. Bedrock 60s timeout)
      this.boundOnSessionEnded = (data: unknown) => {
        const msg = data as { reason: string; message: string };
        this.cleanup();
        this.setState('disconnected');
        if (this.config.onSessionEnded) {
          this.config.onSessionEnded(msg.reason || 'unknown', msg.message || 'Voice session ended');
        }
      };
      this.config.socket.on('voice-session-ended', this.boundOnSessionEnded);

      // Listen for voice transcription text messages
      if (this.config.onTextMessage) {
        this.boundOnTextMessage = (data: unknown) => {
          const msg = data as { text: string; role?: string };
          if (msg.text && this.config.onTextMessage) {
            const role = msg.role === 'user' ? 'user' : 'assistant';
            this.config.onTextMessage(msg.text, role);
          }
        };
        this.config.socket.on('text-message', this.boundOnTextMessage);
      }

      // Listen for turn-start signals to create new chat bubbles
      if (this.config.onTurnStart) {
        this.boundOnTurnStart = (data: unknown) => {
          const msg = data as { role?: string };
          if (this.config.onTurnStart) {
            const role = msg.role === 'user' ? 'user' : 'assistant';
            // When the user starts speaking, flush any queued AI audio so
            // the interruption feels instant instead of the AI finishing
            // its buffered response before going quiet.
            if (role === 'user') {
              this.flushPlaybackQueue();
            }
            this.config.onTurnStart(role);
          }
        };
        this.config.socket.on('turn-start', this.boundOnTurnStart);
      }

      // 4. Tell the server to start the session
      this.config.socket.emit('start-nova-sonic', sessionConfig);

      // Don't sit on "connecting" forever if nova-started never arrives
      // (e.g. the socket dropped mid-start). The server gives up at 60s.
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (this.state === 'connecting') {
          this.fail('Voice took too long to connect. Please try again.');
        }
      }, CONNECT_TIMEOUT_MS);

    } catch (err) {
      this.cleanup();
      this.setState('error');
      throw err;
    }
  }

  disconnect(): void {
    this.config.socket.emit('stop-nova-sonic', {});
    this.cleanup();
    this.setState('disconnected');
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach((t) => {
        t.enabled = !this.muted;
      });
    }
    // Signal the server so Nova Sonic gets proper audio content boundaries
    if (this.muted) {
      this.config.socket.emit('end-audio');
    }
    return this.muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  getState(): VoiceSessionState {
    return this.state;
  }

  // -----------------------------------------------------------------------
  // Audio capture — mic → 16kHz PCM → base64 → Socket.IO
  // -----------------------------------------------------------------------

  private async startCapture(): Promise<void> {
    if (!this.mediaStream) return;

    this.audioContext = new AudioContext({ sampleRate: 16000 });

    // Register the audio worklet processor inline via a Blob URL
    const processorCode = `
      class PCMProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0];
          if (input && input[0] && input[0].length > 0) {
            // Convert Float32 to Int16
            const float32 = input[0];
            const int16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
              const s = Math.max(-1, Math.min(1, float32[i]));
              int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            this.port.postMessage(int16.buffer, [int16.buffer]);
          }
          return true;
        }
      }
      registerProcessor('pcm-processor', PCMProcessor);
    `;
    const blob = new Blob([processorCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    await this.audioContext.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');

    // Send start_audio once, then stream chunks
    let started = false;
    this.workletNode.port.onmessage = (event: MessageEvent) => {
      if (this.muted) {
        started = false; // reset so unmute triggers a fresh start_audio
        return;
      }

      if (!started) {
        this.config.socket.emit('audio-input', { data: '', type: 'start' });
        started = true;
      }

      // Base64-encode the Int16 PCM buffer
      const buffer = event.data as ArrayBuffer;
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const b64 = btoa(binary);

      this.config.socket.emit('audio-input', { data: b64 });
    };

    source.connect(this.workletNode);
    // Don't connect to destination — we don't want to hear our own mic
    this.workletNode.connect(this.audioContext.destination);
  }

  // -----------------------------------------------------------------------
  // Audio playback — base64 24kHz PCM → AudioContext
  // -----------------------------------------------------------------------

  private nextPlayTime = 0;

  /**
   * Flush all queued AI audio so the user's interruption feels instant.
   * Called when the user starts speaking — closes the current playback
   * context and creates a fresh one, dropping any scheduled-but-unplayed
   * audio buffers.
   */
  private flushPlaybackQueue(): void {
    if (this.playbackContext) {
      this.playbackContext.close().catch(() => {});
    }
    this.playbackContext = new AudioContext({ sampleRate: 24000 });
    this.nextPlayTime = 0;
  }

  private playAudioChunk(b64Data: string): void {
    if (!this.playbackContext) return;

    try {
      const binaryStr = atob(b64Data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      // Convert Int16 PCM to Float32
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }

      // Create an AudioBuffer and schedule it after the previous chunk
      const audioBuffer = this.playbackContext.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const source = this.playbackContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.playbackContext.destination);

      const now = this.playbackContext.currentTime;
      const startTime = Math.max(now, this.nextPlayTime);
      source.start(startTime);
      this.nextPlayTime = startTime + audioBuffer.duration;
    } catch (err) {
      console.warn('Failed to play audio chunk:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * End this session with an error. Tells the server to stop (abandoning a
   * start that is still connecting) and removes this client's socket
   * listeners. Without the cleanup, a failed client stayed subscribed and
   * reacted to the next session's events, e.g. ending it on its
   * `voice-session-ended` or starting a second mic capture on `nova-started`.
   */
  private fail(message: string): void {
    this.config.socket.emit('stop-nova-sonic', {});
    this.cleanup();
    this.config.onError(new Error(message));
    this.setState('error');
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private cleanup(): void {
    this.clearConnectTimer();

    // Stop audio capture
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.playbackContext) {
      this.playbackContext.close().catch(() => {});
      this.playbackContext = null;
    }

    // Remove Socket.IO listeners
    if (this.boundOnAudioChunk) {
      this.config.socket.off('audio-chunk', this.boundOnAudioChunk);
      this.boundOnAudioChunk = null;
    }
    if (this.boundOnNovaStarted) {
      this.config.socket.off('nova-started', this.boundOnNovaStarted);
      this.boundOnNovaStarted = null;
    }
    if (this.boundOnNovaError) {
      this.config.socket.off('nova-error', this.boundOnNovaError);
      this.boundOnNovaError = null;
    }
    if (this.boundOnTextMessage) {
      this.config.socket.off('text-message', this.boundOnTextMessage);
      this.boundOnTextMessage = null;
    }
    if (this.boundOnTurnStart) {
      this.config.socket.off('turn-start', this.boundOnTurnStart);
      this.boundOnTurnStart = null;
    }
    if (this.boundOnSessionEnded) {
      this.config.socket.off('voice-session-ended', this.boundOnSessionEnded);
      this.boundOnSessionEnded = null;
    }
    if (this.boundOnAudioFlush) {
      this.config.socket.off('audio-flush', this.boundOnAudioFlush);
      this.boundOnAudioFlush = null;
    }

    this.muted = false;
  }

  private setState(next: VoiceSessionState): void {
    if (this.state === next) return;
    this.state = next;
    this.config.onStateChange(next);
  }
}
