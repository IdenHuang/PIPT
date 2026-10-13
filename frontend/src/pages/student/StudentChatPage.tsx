import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import PageContainer from '@/components/PageContainer';
import UserAvatar from '@/components/UserAvatar';
import { studentService, type StudentChatMessage as Message, type PatientDetail, type StudentCaseMaterial, type PatientFile, type AIDebriefData, type PersonaMedia } from '@/services/studentService';
import { ArrowLeft, Mic, MicOff, Send, FileText, User, CheckCircle, X, Menu, Stethoscope, Flag, ChevronRight, ChevronLeft, Eye, Loader2, ArrowLeftIcon, RotateCcw} from 'lucide-react';
import { SIMULATION_GROUP_COLOR_PALETTE, UI_COLORS } from '@/lib/colors';
import { useState, useRef, useEffect, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SocketIOAudioClient, type VoiceSessionState } from '@/lib/socketio-audio-client';
// CaseMaterialsDialog and PhysicalAssessmentDialog are rendered inline in the sidebar
import ConfirmConcludeDialog from '@/components/ConfirmConcludeDialog';
import PhysicalAssessmentContent, { ImageViewer, isImageFile } from '@/components/PhysicalAssessmentContent';
import ReportIssueDialog from '@/components/ReportIssueDialog';
import AIDebriefDialog from '@/components/AIDebriefDialog';
import { ConcludeModal } from '@/components/ConcludeModal';
import type { UpdatedDebriefData, DebriefChunk1, DebriefChunk2 } from '@/services/studentService';
import { useAuth } from '@/App';
import { authService } from '@/lib/auth';
import { supportsVoiceMode } from '@/lib/browser';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import ResizeHandle from '@/components/ResizeHandle';
import { extractDebriefFromRawJson } from '@/lib/debrief-parser';

/**
 * StudentChatPage Component
 * 
 * Interactive chat interface for medical simulation with AI patient.
 */
function StudentChatPage() {
  const navigate = useNavigate();
  const { groupId, patientId, chatId: routeChatId } = useParams();
  const location = useLocation();
  const adminReturnUrl = (location.state as any)?.adminReturnUrl as string | undefined;
  
  // Load user data from auth context
  const { user: authUser } = useAuth();
  const user = { name: authUser?.email || 'Student', avatarUrl: undefined };
  
  // Patient data, case materials, and patient files loaded from API
  const [patient, setPatient] = useState<PatientDetail>({ id: patientId, name: 'Loading...', age: 0, gender: '' });
  const [, setCaseMaterials] = useState<StudentCaseMaterial[]>([]);
  const [patientFiles, setPatientFiles] = useState<PatientFile[]>([]);

  // Fetch patient detail, case materials, and patient files from real API
  useEffect(() => {
    if (!groupId || !patientId) return;
    let cancelled = false;

    studentService.fetchPatientDetail(groupId, patientId).then((data) => {
      if (!cancelled) setPatient(data);
    });
    studentService.fetchCaseMaterials(groupId, patientId).then((data) => {
      if (!cancelled) setCaseMaterials(data);
    });
    studentService.fetchPatientFiles(groupId, patientId).then((data) => {
      if (!cancelled) setPatientFiles(data);
    });

    return () => { cancelled = true; };
  }, [groupId, patientId]);

  // State for dialogs
  const [isConfirmConcludeOpen, setIsConfirmConcludeOpen] = useState(false);
  const [isConcludeModalOpen, setIsConcludeModalOpen] = useState(false);
  const [isReportIssueOpen, setIsReportIssueOpen] = useState(false);
  const [isAIDebriefOpen, setIsAIDebriefOpen] = useState(false);

  // Session lifecycle status
  const [sessionStatus, setSessionStatus] = useState<'active' | 'generating_debrief' | 'concluded'>('active');
  const [debriefData, setDebriefData] = useState<AIDebriefData | null>(null);
  const [updatedDebriefData, setUpdatedDebriefData] = useState<UpdatedDebriefData | undefined>(undefined);

  // Session completed — patient ended the conversation, student must conclude
  const [sessionCompleted, setSessionCompleted] = useState(false);

  // Message limit reached — student has hit the max messages for this conversation
  const [messageLimitReached, setMessageLimitReached] = useState(false);

  // State for content sidebar (physical assessment only)
  const [contentSidebarType, setContentSidebarType] = useState<'physical-assessment' | null>(null);
  const [personaMedia, setPersonaMedia] = useState<PersonaMedia[]>([]);
  const [personaMediaLoading, setPersonaMediaLoading] = useState(false);

  // Fetch persona media when physical assessment sidebar opens
  useEffect(() => {
    if (contentSidebarType !== 'physical-assessment' || !patientId) return;
    let cancelled = false;
    setPersonaMediaLoading(true);
    studentService.fetchPersonaMedia(patientId).then((data) => {
      if (!cancelled) {
        setPersonaMedia(data);
        setPersonaMediaLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [contentSidebarType, patientId]);

  // State for patient information sidebar
  const [isPatientInfoSidebarOpen, setIsPatientInfoSidebarOpen] = useState(false);
  const [selectedPatientFile, setSelectedPatientFile] = useState<PatientFile | null>(null);

  // State for note (single note per chat, auto-saves)
  const [noteText, setNoteText] = useState('');
  const noteLoadedRef = useRef(false);

  const handleNoteChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setNoteText(e.target.value);
  };

  // State for voice mode
  const [isVoiceModeActive, setIsVoiceModeActive] = useState(false);

  // WebRTC voice session state
  const [voiceSessionState, setVoiceSessionState] = useState<VoiceSessionState>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const audioClientRef = useRef<SocketIOAudioClient | null>(null);
  const socketRef = useRef<Socket | null>(null);

  // Ref for polling interval during voice mode
  const voicePollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Real-time voice bubble tracking
  const currentVoiceBubbleRef = useRef<{ id: string; role: 'user' | 'assistant' } | null>(null);
  const lastVoiceRoleRef = useRef<string | null>(null);

  // Session ID — set by createSession (new chat) or from route (existing chat)
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Whether the AI is currently streaming a text response (used to disable input controls)
  const [isAiResponding, setIsAiResponding] = useState(false);

  /**
   * Clean up voice session and Socket.IO connection.
   */
  const cleanupVoiceSession = useCallback(() => {
    if (audioClientRef.current) {
      audioClientRef.current.disconnect();
      audioClientRef.current = null;
    }
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    if (voicePollIntervalRef.current) {
      clearInterval(voicePollIntervalRef.current);
      voicePollIntervalRef.current = null;
    }
    setVoiceSessionState('idle');
    setVoiceError(null);
    setIsMuted(false);
  }, []);

  /**
   * Start a voice session when the mic button is clicked.
   */
  const handleStartVoiceMode = useCallback(() => {
    if (sessionCompleted || isAiResponding) return;
    setIsVoiceModeActive(true);
    setVoiceError(null);
    setVoiceSessionState('connecting');

    // Reuse the existing Socket.IO connection (created on mount)
    if (!socketRef.current || !socketRef.current.connected) {
      // Socket not ready — try to connect now as fallback
      const socketUrl = import.meta.env.VITE_SOCKET_URL || '';
      socketRef.current = io(socketUrl, {
        transports: ['websocket'],
        // Fresh token per (re)connection attempt — see mount effect for rationale.
        auth: (cb) => {
          authService.getIdToken()
            .then((token) => cb({ token: token || '' }))
            .catch(() => cb({ token: '' }));
        },
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
        timeout: 60000,
      });
      startAudioClient();
      return;
    }

    startAudioClient();

    async function startAudioClient() {
    if (!socketRef.current) {
      setVoiceError('Socket connection not available.');
      setVoiceSessionState('error');
      return;
    }

    // Fetch the patient's assigned voice_id from the DB before starting the session
    let voiceId: string | undefined;
    if (patientId) {
      const fetchedVoiceId = await studentService.fetchPatientVoiceId(patientId);
      if (fetchedVoiceId) {
        voiceId = fetchedVoiceId;
      }
    }

    const client = new SocketIOAudioClient({
      socket: socketRef.current,
      onStateChange: (state) => {
        setVoiceSessionState(state);
        if (state === 'disconnected' || state === 'error') {
          setIsVoiceModeActive(false);
        }
      },
      onError: (error) => {
        const msg = error.message || '';
        if (msg.includes('Permission denied') || msg.includes('NotAllowedError')) {
          setVoiceError('Microphone access was denied. Please allow microphone permission in your browser settings and try again.');
        } else {
          setVoiceError(msg);
        }
        setVoiceSessionState('error');
      },
      onSessionEnded: (_reason, message) => {
        // Server closed the voice session (e.g. Bedrock 60s timeout)
        setIsVoiceModeActive(false);
        setVoiceSessionState('idle');
        setVoiceError(message || 'Voice had an issue. Please reconnect to continue where you left off.');
        audioClientRef.current = null;
        // Reset voice bubble tracking so next session starts fresh
        currentVoiceBubbleRef.current = null;
        lastVoiceRoleRef.current = null;
      },
      onTurnStart: (role) => {
        // Only create a new bubble when the role actually changes
        if (role === lastVoiceRoleRef.current) return;
        lastVoiceRoleRef.current = role;

        const senderType = role === 'user' ? 'student' : 'ai';
        const bubbleId = `voice-${role}-${Date.now()}`;
        currentVoiceBubbleRef.current = { id: bubbleId, role };

        setMessages((prev) => [...prev, {
          message_id: bubbleId,
          chat_id: chatId,
          sender_type: senderType,
          message_content: '',
          sent_at: new Date().toISOString(),
        }]);
      },
      onTextMessage: (text, role) => {
        // Filter out system messages
        if (text.includes('Nova Sonic ready')) return;

        // If no bubble exists for this role, create one on the fly
        if (!currentVoiceBubbleRef.current || currentVoiceBubbleRef.current.role !== role) {
          const senderType = role === 'user' ? 'student' : 'ai';
          const bubbleId = `voice-${role}-${Date.now()}`;
          currentVoiceBubbleRef.current = { id: bubbleId, role };
          lastVoiceRoleRef.current = role;

          setMessages((prev) => [...prev, {
            message_id: bubbleId,
            chat_id: chatId,
            sender_type: senderType,
            message_content: text,
            sent_at: new Date().toISOString(),
          }]);
          return;
        }

        // Append text to the active bubble
        const bubbleId = currentVoiceBubbleRef.current.id;
        setMessages((prev) =>
          prev.map((m) =>
            m.message_id === bubbleId
              ? { ...m, message_content: m.message_content + (m.message_content ? ' ' : '') + text }
              : m
          )
        );
      },
    });

    audioClientRef.current = client;
    client.connect({
      session_id: sessionId || routeChatId || '',
      patient_name: patient?.name || '',
      patient_id: patientId || '',
      simulation_group_id: groupId || '',
      voice_id: voiceId || '',
    }).then(() => {
      // Listen for session completion from voice mode
      if (socketRef.current) {
        socketRef.current.on('diagnosis-complete', () => {
          // Lock input immediately so the student can't send more messages
          setSessionCompleted(true);

          // Poll until all queued audio has finished playing before disconnecting.
          const disconnectWhenAudioDone = () => {
            const client = audioClientRef.current;
            const playbackCtx = client ? (client as unknown as { playbackContext: AudioContext | null }).playbackContext : null;
            const nextPlay = client ? (client as unknown as { nextPlayTime: number }).nextPlayTime : 0;
            const now = playbackCtx ? playbackCtx.currentTime : 0;
            const remainingAudio = nextPlay - now;

            if (remainingAudio > 0.1) {
              // Audio is still playing — check again after it should be done (+ 1s buffer)
              setTimeout(disconnectWhenAudioDone, (remainingAudio + 1) * 1000);
              return;
            }

            // All audio finished — tear down the session
            cleanupVoiceSession();
            setIsVoiceModeActive(false);
            currentVoiceBubbleRef.current = null;
            lastVoiceRoleRef.current = null;
            // Final fetch to replace real-time bubbles with persisted DB messages
            const sid = sessionId || routeChatId || '';
            if (sid) {
              studentService.fetchMessages(sid).then((msgs) => {
                if (msgs.length > 0) {
                  setMessages(msgs);
                  // Safety net: re-confirm sessionCompleted from DB messages
                  // in case state was lost during voice cleanup
                  const wasCompleted = msgs.some((m) =>
                    m.sender_type === 'ai' && (
                      m.message_content.includes('SESSION COMPLETED') ||
                      m.message_content.includes('You may continue practicing with other patients')
                    )
                  );
                  if (wasCompleted) {
                    setSessionCompleted(true);
                  }
                }
              });
            }
          };

          // Initial delay gives Nova Sonic time to finish speaking the goodbye
          setTimeout(disconnectWhenAudioDone, 8000);
        });
      }

      // DB polling removed — real-time text events populate bubbles during voice mode.
      // Messages are fetched from DB when voice mode ends (handleStopVoiceMode).
    }).catch((err) => {
      console.error('[VoiceMode] Failed to connect:', err);
      const msg = err instanceof Error ? err.message : 'Failed to start voice session';
      if (msg.includes('Permission denied') || msg.includes('NotAllowedError')) {
        setVoiceError('Microphone access was denied. Please allow microphone permission in your browser settings and try again.');
      } else {
        setVoiceError(msg);
      }
      setVoiceSessionState('error');
    });
    } // end startAudioClient
  }, [patient, routeChatId, patientId, groupId, sessionId, isAiResponding]);

  /**
   * Stop the voice session when the X button is clicked.
   */
  const handleStopVoiceMode = useCallback(() => {
    cleanupVoiceSession();
    setIsVoiceModeActive(false);
    // Reset voice bubble tracking
    currentVoiceBubbleRef.current = null;
    lastVoiceRoleRef.current = null;
    // Final fetch to replace real-time bubbles with persisted DB messages
    const sid = sessionId || routeChatId || '';
    if (sid) {
      studentService.fetchMessages(sid).then((msgs) => {
        if (msgs.length > 0) {
          setMessages(msgs);
          // Re-check for session completion in case the marker was persisted
          // but the real-time event was missed (e.g. user clicked stop late)
          const wasCompleted = msgs.some((m) =>
            m.sender_type === 'ai' && (
              m.message_content.includes('SESSION COMPLETED') ||
              m.message_content.includes('You may continue practicing with other patients')
            )
          );
          if (wasCompleted) {
            setSessionCompleted(true);
          }
        }
      });
    }
  }, [cleanupVoiceSession, sessionId, routeChatId]);

  // Clean up WebRTC and socket on unmount or navigation away
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (audioClientRef.current) {
        audioClientRef.current.disconnect();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      cleanupVoiceSession();
      if (socketRef.current) {
        socketRef.current.off('diagnosis-complete');
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [cleanupVoiceSession]);

  // State for sidebar visibility
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);

  // Resizable sidebars
  const {
    width: patientInfoWidth,
    sidebarRef: patientInfoRef,
    handleMouseDown: onPatientInfoDrag,
  } = useResizablePanel({ defaultWidth: 320, minWidth: 250, maxWidth: 700, direction: 'left' });
  const {
    width: physicalAssessmentWidth,
    sidebarRef: physicalAssessmentRef,
    handleMouseDown: onPhysicalAssessmentDrag,
  } = useResizablePanel({ defaultWidth: 384, minWidth: 250, maxWidth: 700, direction: 'right' });

  // State for chat
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatId = `chat-${groupId}-${patientId}`; // Mock chat ID

  // Check message limit whenever messages change
  useEffect(() => {
    const maxMessages = patient?.max_messages_per_chat;
    if (maxMessages == null || messageLimitReached) return;

    const studentMessageCount = messages.filter(m => m.sender_type === 'student').length;
    if (studentMessageCount >= maxMessages) {
      setMessageLimitReached(true);
      // If in voice mode, let the AI finish responding before disconnecting.
      // This mirrors the diagnosis-complete pattern: lock input immediately,
      // wait for remaining audio playback, then tear down the connection.
      if (voiceSessionState === 'active' || voiceSessionState === 'connecting') {
        // Wait an initial 8s for the AI response to arrive and start playing,
        // then poll until all queued audio has finished before disconnecting.
        const disconnectWhenAudioDone = () => {
          const client = audioClientRef.current;
          const playbackCtx = client ? (client as unknown as { playbackContext: AudioContext | null }).playbackContext : null;
          const nextPlay = client ? (client as unknown as { nextPlayTime: number }).nextPlayTime : 0;
          const now = playbackCtx ? playbackCtx.currentTime : 0;
          const remainingAudio = nextPlay - now;

          if (remainingAudio > 0.1) {
            // Audio is still playing — check again after it should be done (+ 1s buffer)
            setTimeout(disconnectWhenAudioDone, (remainingAudio + 1) * 1000);
            return;
          }

          // All audio finished — tear down the session
          cleanupVoiceSession();
          setIsVoiceModeActive(false);
          currentVoiceBubbleRef.current = null;
          lastVoiceRoleRef.current = null;
          // Fetch persisted messages (with cleaned transcripts) from DB
          const sid = sessionId || routeChatId || '';
          if (sid) {
            studentService.fetchMessages(sid).then((msgs) => {
              if (msgs.length > 0) {
                setMessages(msgs);
              }
            });
          }
        };

        // Initial delay gives the AI time to generate and start streaming its response
        setTimeout(disconnectWhenAudioDone, 8000);
      }
    }
  }, [messages, patient?.max_messages_per_chat, messageLimitReached, voiceSessionState, cleanupVoiceSession, sessionId, routeChatId]);

  // Guard to prevent duplicate session creation (React StrictMode double-mount)
  const sessionCreationRef = useRef(false);
  // Ref to track if AI greeting has been triggered
  const greetingTriggeredRef = useRef(false);

  // Create a session on mount (new chat) or use existing session ID from route
  useEffect(() => {
    if (!groupId || !patientId) return;
    let cancelled = false;

    if (routeChatId) {
      // Resuming an existing session — set the ID and load messages + debrief
      setSessionId(routeChatId);
      studentService.fetchMessages(routeChatId).then((msgs) => {
        if (!cancelled && msgs.length > 0) {
          setMessages(msgs);
          // Check if the session was already completed (patient said goodbye).
          // Scan all AI messages (not just the last) so we don't miss the
          // marker if extra messages were appended after the completion one.
          const wasCompleted = msgs.some((m) =>
            m.sender_type === 'ai' && (
              m.message_content.includes('SESSION COMPLETED') ||
              m.message_content.includes('You may continue practicing with other patients')
            )
          );
          if (wasCompleted) {
            setSessionCompleted(true);
          }
        }
      });
      // Only fetch the debrief if this session was actually concluded.
      // Previously fetchDebrief ran unconditionally on every resume, and its
      // internal retry-on-'generating' loop then polled get_debrief repeatedly
      // for sessions that were never concluded. Gate on the chat's concluded
      // status from the patient session list first.
      studentService.fetchChatHistory(groupId, patientId).then((history) => {
        if (cancelled) return;
        const entry = history.find((h) => h.id === routeChatId);
        if (entry?.completionStatus !== 'Complete') return; // not concluded — no debrief yet
        setSessionStatus('concluded');
        studentService.fetchDebrief(routeChatId).then((data) => {
          if (!cancelled && data) {
            setDebriefData(data);
          }
        });
      }).catch((err) => {
        console.warn('Failed to check session status before fetching debrief:', err);
      });
    } else if (!sessionCreationRef.current) {
      // New chat — create a fresh session (guarded against StrictMode double-mount)
      sessionCreationRef.current = true;
      studentService.createSession(groupId, patientId, `Session ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`).then((session) => {
        if (session) {
          setSessionId(session.chat_id);
        }
      });
    }

    return () => { cancelled = true; };
  }, [groupId, patientId, routeChatId]);

  // Establish Socket.IO connection on mount for text streaming (and voice reuse)
  const [socketConnected, setSocketConnected] = useState(false);
  useEffect(() => {
    if (socketRef.current?.connected) return;

    const socketUrl = import.meta.env.VITE_SOCKET_URL || '';
    let cancelled = false;

    const socket = io(socketUrl, {
      transports: ['websocket'],
      // Provide auth as a function so Socket.IO fetches a FRESH Cognito ID
      // token before every (re)connection attempt and waits for it. The
      // previous approach set socket.auth asynchronously inside a
      // 'reconnect_attempt' handler, which raced the reconnect and could send
      // an expired token → "Authentication failed" (and the ping-timeout
      // reconnects made this frequent).
      auth: (cb) => {
        authService.getIdToken()
          .then((token) => cb({ token: token || '' }))
          .catch(() => cb({ token: '' }));
      },
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 60000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      if (!cancelled) setSocketConnected(true);
    });

    socket.on('disconnect', (reason) => {
      setSocketConnected(false);
      console.warn('Socket disconnected:', reason);
    });

    socket.on('connect_error', (err) => {
      console.warn('Socket.IO connection error:', err.message);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Load notes from API when session is available
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    noteLoadedRef.current = false;

    studentService.fetchNotes(sessionId).then((notes) => {
      if (!cancelled) {
        setNoteText(notes);
        noteLoadedRef.current = true;
      }
    });

    return () => { cancelled = true; };
  }, [sessionId]);

  // Auto-save note with debounce
  useEffect(() => {
    if (!noteLoadedRef.current || !sessionId) return;
    
    const timeoutId = setTimeout(() => {
      studentService.updateNotes(sessionId, noteText);
    }, 1000);

    return () => clearTimeout(timeoutId);
  }, [noteText, sessionId]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Trigger AI greeting when a new session is created (not a resumed chat)
  useEffect(() => {
    if (!sessionId || !groupId || !patientId || routeChatId || greetingTriggeredRef.current) return;
    if (!socketConnected) return; // Wait for socket to be ready
    greetingTriggeredRef.current = true;

    setIsAiResponding(true);
    const aiGreetingId = `msg-greeting-${Date.now()}`;
    let greetingAdded = false;

    studentService.sendMessageStreaming(
      groupId, patientId, sessionId, '',
      {
        onChunk: (text) => {
          if (!greetingAdded) {
            greetingAdded = true;
            setMessages([{
              message_id: aiGreetingId,
              chat_id: chatId,
              sender_type: 'ai',
              message_content: text,
              sent_at: new Date().toISOString(),
            }]);
          } else {
            setMessages((prev) =>
              prev.map((m) =>
                m.message_id === aiGreetingId
                  ? { ...m, message_content: m.message_content + text }
                  : m
              )
            );
          }
        },
        onDone: (fullText) => {
          if (!greetingAdded) {
            setMessages([{
              message_id: aiGreetingId,
              chat_id: chatId,
              sender_type: 'ai',
              message_content: fullText || 'Hi there. I\'m here for my appointment.',
              sent_at: new Date().toISOString(),
            }]);
          } else {
            setMessages((prev) =>
              prev.map((m) =>
                m.message_id === aiGreetingId
                  ? { ...m, message_content: fullText || m.message_content }
                  : m
              )
            );
          }
          setIsAiResponding(false);
        },
        onError: (error) => {
          console.error('AI greeting error:', error);
          setMessages([{
            message_id: aiGreetingId,
            chat_id: chatId,
            sender_type: 'ai',
            message_content: 'I\'m having trouble connecting right now. Please try starting the conversation again.',
            sent_at: new Date().toISOString(),
          }]);
          setIsAiResponding(false);
        },
        onSessionComplete: () => {
          setSessionCompleted(true);
        },
      },
      socketRef.current,
    ).catch((err) => {
      console.error('AI greeting streaming failed:', err);
      setMessages([{
        message_id: aiGreetingId,
        chat_id: chatId,
        sender_type: 'ai',
        message_content: 'I\'m having trouble connecting right now. Please try starting the conversation again.',
        sent_at: new Date().toISOString(),
      }]);
      setIsAiResponding(false);
    });
  }, [sessionId, socketConnected]);

  /**
   * Handle sign out event
   */
  const handleSignOut = () => {
    navigate('/login');
  };

  /**
   * Handle back to patient dashboard
   */
  const handleBackToPatientDashboard = () => {
    navigate(`/patients/${groupId}/${patientId}`, { state: { adminReturnUrl } });
  };

  /**
   * Handle conclude interaction confirmation
   */
  const handleConcludeInteraction = async (recommendations: string) => {
    if (!groupId || !patientId || !sessionId) return;

    setIsConfirmConcludeOpen(false);
    setSessionStatus('generating_debrief');

    // Call the conclude API
    const result = await studentService.concludeInteraction(groupId, patientId, sessionId, recommendations);

    if (!result.success) {
      console.error('Failed to conclude interaction');
      setSessionStatus('active');
      return;
    }

    // Listen for the debrief result via AppSync subscription
    // The backend publishes a "debrief" event when generation is complete
    try {
      const { subscribeToTextStream } = await import('@/lib/appsync-client');
      const unsubscribe = await subscribeToTextStream(sessionId, (event) => {
        if (event.type === 'debrief') {
          try {
            let parsed = JSON.parse(event.content);
            
            // Safety net: if the backend JSON parse failed, the entire LLM output
            // ends up in the "summary" field as a raw JSON string. Detect this and
            // extract the structured data from it.
            if (
              parsed.summary &&
              typeof parsed.summary === 'string' &&
              parsed.summary.trimStart().startsWith('{') &&
              (!parsed.questions_addressed || parsed.questions_addressed.length === 0)
            ) {
              const extracted = extractDebriefFromRawJson(parsed.summary);
              if (extracted) {
                parsed = extracted;
              }
            }

            // questions_addressed may be strings (legacy) or objects with question_text (enhanced)
            const addressedQuestions = (parsed.questions_addressed || []).map(
              (q: string | { question_text?: string; quality_assessment?: string }) =>
                typeof q === 'string' ? q : (q.question_text || 'Unknown question')
            );
            const missedQuestions = (parsed.questions_missed || []).map(
              (q: string | { question_text?: string }) =>
                typeof q === 'string' ? q : (q.question_text || 'Unknown question')
            );
            setDebriefData({
              summary: parsed.summary || '',
              questionsAddressed: addressedQuestions,
              missedKeyQuestionsCount: missedQuestions.length,
              missedQuestions: missedQuestions,
              missedQuestionsGuidance: parsed.reasoning_gaps || '',
              overallScore: typeof parsed.overall_score === 'number' ? parsed.overall_score : undefined,
              recommendation: typeof parsed.recommendation === 'string' ? parsed.recommendation : undefined,
              recommendationFeedback: {
                strengths: parsed.recommendation_feedback?.strengths || [],
                areasForImprovement: parsed.recommendation_feedback?.areas_for_improvement || [],
              },
              suggestedRewrites: (parsed.suggested_rewrites || []).map(
                (r: { original_message?: string; suggested_rewrite?: string }) => ({
                  original: r.original_message || '',
                  suggested: r.suggested_rewrite || '',
                })
              ),
              rubricDescription: 'Compare your recommendations with the answer key provided by your instructor.',
              answerKeyComparison: parsed.answer_key_comparison ? {
                answerKeyAvailable: parsed.answer_key_comparison.answer_key_available ?? false,
                correctElements: parsed.answer_key_comparison.correct_elements,
                missingElements: parsed.answer_key_comparison.missing_elements,
                incorrectElements: parsed.answer_key_comparison.incorrect_elements,
                overallAlignment: parsed.answer_key_comparison.overall_alignment,
              } : undefined,
            });
            setSessionStatus('concluded');
            setIsAIDebriefOpen(true);
          } catch (e) {
            console.error('Failed to parse debrief data:', e);
            setSessionStatus('concluded');
          }
          unsubscribe();
        }
      });
    } catch (err) {
      console.error('Failed to subscribe for debrief:', err);
      // Even if subscription fails, the session is concluded — debrief can be fetched later
      setSessionStatus('concluded');
    }
  };

  /**
   * Handle the new two-step conclude modal completion.
   * Called after ConcludeModal successfully submits DTP + Recommendation data.
   * Subscribes to AppSync for progressive debrief_chunk1 and debrief_chunk2 events.
   */
  const handleConcludeWithSubmissions = async (dtpSubmission: string[], recommendationSubmission: { recommendation: string; rationale: string }[]) => {
    if (!groupId || !patientId || !sessionId) return;

    setSessionStatus('generating_debrief');

    try {
      const { subscribeToTextStream } = await import('@/lib/appsync-client');
      const unsubscribe = await subscribeToTextStream(sessionId, (event) => {
        if (event.type === 'debrief_chunk1') {
          try {
            const content = typeof event.content === 'string' ? JSON.parse(event.content) : event.content;

            // Parse chunk1 fields from the event payload
            const questionsAddressed = (content.questions_addressed || []).map(
              (q: string | { question_text?: string }) =>
                typeof q === 'string' ? q : (q.question_text || 'Unknown question')
            );

            const chunk1: DebriefChunk1 = {
              summary: typeof content.summary === 'string' ? content.summary : '',
              questionsAddressed,
              questionsAddressedCount: questionsAddressed.length,
              questionsMissed: [],
              questionsMissedCount: content.questions_missed_count ?? 0,
              suggestedRewrites: (content.suggested_rewrites || []).map(
                (r: { original_message?: string; suggested_rewrite?: string }) => ({
                  original: r.original_message || '',
                  suggested: r.suggested_rewrite || '',
                })
              ),
              keyQuestionsScore: content.key_questions_score
                ? {
                    matched: content.key_questions_score.matched,
                    total: content.key_questions_score.total,
                    percentage: content.key_questions_score.percentage,
                  }
                : null,
              guidanceKeyQuestions: content.guidance_key_questions || null,
            };

            // Set chunk1 immediately, chunk2 as null to trigger loading state
            setUpdatedDebriefData({ chunk1, chunk2: null, dtpSubmission: dtpSubmission.length > 0 ? dtpSubmission : null, recommendationSubmission: recommendationSubmission.length > 0 ? recommendationSubmission : null });
            setSessionStatus('concluded');
            setIsAIDebriefOpen(true);
          } catch (e) {
            console.error('Failed to parse debrief_chunk1:', e);
          }
        } else if (event.type === 'debrief_chunk2') {
          try {
            const content = typeof event.content === 'string' ? JSON.parse(event.content) : event.content;

            const dtpRaw = content.dtp_comparison || { matched: [], missed_count: 0, additional: [] };
            const recRaw = content.recommendations_comparison || { matched: [], missed_count: 0, additional: [] };
            const sectionScores = content.section_scores || {};
            const guidanceData = content.guidance || {};

            // Also check for inline score/guidance on the comparison objects
            const dtpScore = dtpRaw.score || sectionScores.dtps || null;
            const recScore = recRaw.score || sectionScores.recommendations || null;
            const dtpGuidance = dtpRaw.guidance || guidanceData.dtps || null;
            const recGuidance = recRaw.guidance || guidanceData.recommendations || null;

            const chunk2: DebriefChunk2 = {
              dtpComparison: {
                overview: `You identified ${dtpRaw.matched?.length || 0} out of ${(dtpRaw.matched?.length || 0) + (dtpRaw.missed_count || 0)} expected drug therapy problems.`,
                matched: (dtpRaw.matched || []).map((m: any) => ({
                  dtpText: m.instructor_text || '',
                  status: 'matched' as const,
                  matchedWith: m.student_text || '',
                })),
                missed: Array.from({ length: dtpRaw.missed_count || 0 }, () => ({
                  dtpText: '',
                  status: 'missed' as const,
                })),
                additional: (dtpRaw.additional || []).map((m: any) => ({
                  dtpText: m.student_text || '',
                  status: 'additional' as const,
                })),
                score: dtpScore
                  ? { matched: dtpScore.matched, total: dtpScore.total, percentage: dtpScore.percentage }
                  : null,
                guidance: dtpGuidance,
              },
              recommendationsComparison: {
                overview: `You matched ${recRaw.matched?.length || 0} out of ${(recRaw.matched?.length || 0) + (recRaw.missed_count || 0)} expected recommendations.`,
                matched: (recRaw.matched || []).map((m: any) => ({
                  recommendationText: m.instructor_text || '',
                  status: 'matched' as const,
                  matchedWith: m.student_text || '',
                  rationaleRating: m.rationale_rating || undefined,
                  rationaleExplanation: m.rationale_explanation || undefined,
                })),
                missed: Array.from({ length: recRaw.missed_count || 0 }, () => ({
                  recommendationText: '',
                  status: 'missed' as const,
                })),
                additional: (recRaw.additional || []).map((m: any) => ({
                  recommendationText: m.student_text || '',
                  status: 'additional' as const,
                })),
                score: recScore
                  ? { matched: recScore.matched, total: recScore.total, percentage: recScore.percentage }
                  : null,
                guidance: recGuidance,
              },
            };

            // Merge chunk2 with existing chunk1 without re-rendering chunk1
            setUpdatedDebriefData((prev) => {
              if (!prev) return prev ?? undefined;
              // Also update chunk1 with summary/rewrites/guidance from chunk2 if provided
              const updatedChunk1 = { ...prev.chunk1 };
              if (content.summary && typeof content.summary === 'string' && content.summary.length > 0) {
                updatedChunk1.summary = content.summary;
              }
              if (content.suggested_rewrites && content.suggested_rewrites.length > 0) {
                updatedChunk1.suggestedRewrites = content.suggested_rewrites.map(
                  (r: { original_message?: string; suggested_rewrite?: string }) => ({
                    original: r.original_message || '',
                    suggested: r.suggested_rewrite || '',
                  })
                );
              }
              if (content.guidance_key_questions) {
                updatedChunk1.guidanceKeyQuestions = content.guidance_key_questions;
              }
              return { chunk1: updatedChunk1, chunk2, dtpSubmission: prev.dtpSubmission ?? (dtpSubmission.length > 0 ? dtpSubmission : null), recommendationSubmission: prev.recommendationSubmission ?? (recommendationSubmission.length > 0 ? recommendationSubmission : null) };
            });

            // Unsubscribe after receiving chunk2 (final event)
            unsubscribe();
          } catch (e) {
            console.error('Failed to parse debrief_chunk2:', e);
          }
        } else if (event.type === 'debrief') {
          // Full debrief fallback — for late joiners or page refreshes
          try {
            const parsed = typeof event.content === 'string' ? JSON.parse(event.content) : event.content;

            const questionsAddressed = (parsed.questions_addressed || []).map(
              (q: string | { question_text?: string }) =>
                typeof q === 'string' ? q : (q.question_text || 'Unknown question')
            );
            const questionsMissed = (parsed.questions_missed || []).map(
              (q: string | { question_text?: string }) =>
                typeof q === 'string' ? q : (q.question_text || 'Unknown question')
            );
            const sectionScores = parsed.section_scores || {};
            const guidanceData = parsed.guidance || {};

            const chunk1: DebriefChunk1 = {
              summary: typeof parsed.summary === 'string' ? parsed.summary : '',
              questionsAddressed,
              questionsAddressedCount: questionsAddressed.length,
              questionsMissed,
              questionsMissedCount: questionsMissed.length,
              suggestedRewrites: (parsed.suggested_rewrites || []).map(
                (r: { original_message?: string; suggested_rewrite?: string }) => ({
                  original: r.original_message || '',
                  suggested: r.suggested_rewrite || '',
                })
              ),
              keyQuestionsScore: sectionScores.key_questions
                ? {
                    matched: sectionScores.key_questions.matched,
                    total: sectionScores.key_questions.total,
                    percentage: sectionScores.key_questions.percentage,
                  }
                : null,
              guidanceKeyQuestions: guidanceData.key_questions || null,
            };

            let chunk2: DebriefChunk2 | null = null;
            if (parsed.dtp_comparison || parsed.recommendations_comparison) {
              const dtpRaw = parsed.dtp_comparison || { matched: [], missed: [], additional: [] };
              const recRaw = parsed.recommendations_comparison || { matched: [], missed: [], additional: [] };

              chunk2 = {
                dtpComparison: {
                  overview: `You identified ${dtpRaw.matched?.length || 0} out of ${(dtpRaw.matched?.length || 0) + (dtpRaw.missed?.length || 0)} expected drug therapy problems.`,
                  matched: (dtpRaw.matched || []).map((m: any) => ({
                    dtpText: m.instructor_text || '',
                    status: 'matched' as const,
                    matchedWith: m.student_text || '',
                  })),
                  missed: (dtpRaw.missed || []).map((_m: any) => ({
                    dtpText: '',
                    status: 'missed' as const,
                  })),
                  additional: (dtpRaw.additional || []).map((m: any) => ({
                    dtpText: m.student_text || '',
                    status: 'additional' as const,
                  })),
                  score: sectionScores.dtps
                    ? { matched: sectionScores.dtps.matched, total: sectionScores.dtps.total, percentage: sectionScores.dtps.percentage }
                    : null,
                  guidance: guidanceData.dtps || null,
                },
                recommendationsComparison: {
                  overview: `You matched ${recRaw.matched?.length || 0} out of ${(recRaw.matched?.length || 0) + (recRaw.missed?.length || 0)} expected recommendations.`,
                  matched: (recRaw.matched || []).map((m: any) => ({
                    recommendationText: m.instructor_text || '',
                    status: 'matched' as const,
                    matchedWith: m.student_text || '',
                    rationaleRating: m.rationale_rating || undefined,
                    rationaleExplanation: m.rationale_explanation || undefined,
                  })),
                  missed: (recRaw.missed || []).map((_m: any) => ({
                    recommendationText: '',
                    status: 'missed' as const,
                  })),
                  additional: (recRaw.additional || []).map((m: any) => ({
                    recommendationText: m.student_text || '',
                    status: 'additional' as const,
                  })),
                  score: sectionScores.recommendations
                    ? { matched: sectionScores.recommendations.matched, total: sectionScores.recommendations.total, percentage: sectionScores.recommendations.percentage }
                    : null,
                  guidance: guidanceData.recommendations || null,
                },
              };
            }

            setUpdatedDebriefData({ chunk1, chunk2, dtpSubmission: dtpSubmission.length > 0 ? dtpSubmission : null, recommendationSubmission: recommendationSubmission.length > 0 ? recommendationSubmission : null });
            setSessionStatus('concluded');
            setIsAIDebriefOpen(true);
            unsubscribe();
          } catch (e) {
            console.error('Failed to parse full debrief:', e);
            setSessionStatus('concluded');
            unsubscribe();
          }
        }
      });
    } catch (err) {
      console.error('Failed to subscribe for debrief chunks:', err);
      // Fallback to polling approach if subscription fails
      try {
        const debrief = await studentService.fetchUpdatedDebrief(sessionId);
        setUpdatedDebriefData(debrief);
        setSessionStatus('concluded');
        setIsAIDebriefOpen(true);
      } catch (fetchErr) {
        console.error('Failed to fetch updated debrief:', fetchErr);
        setSessionStatus('concluded');
      }
    }
  };

  // Ref to hold the cancel function for an in-flight streaming request
  const cancelStreamRef = useRef<(() => void) | null>(null);

  // Clean up any in-flight stream on unmount
  useEffect(() => {
    return () => { cancelStreamRef.current?.(); };
  }, []);

  /**
   * Handle sending a message — uses AppSync streaming for real-time chunks
   */
  const handleSendMessage = async () => {
    if (!inputMessage.trim() || !groupId || !patientId || !sessionId || isAiResponding || sessionCompleted || messageLimitReached) return;

    // Create student message
    const studentMessage: Message = {
      message_id: `msg-${Date.now()}`,
      chat_id: chatId,
      sender_type: 'student',
      message_content: inputMessage,
      sent_at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, studentMessage]);
    const messageText = inputMessage;
    setInputMessage('');
    setIsAiResponding(true);

    // Create a placeholder AI message that will be progressively filled
    const aiMessageId = `msg-${Date.now() + 1}`;
    const aiMessage: Message = {
      message_id: aiMessageId,
      chat_id: chatId,
      sender_type: 'ai',
      message_content: '',
      sent_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, aiMessage]);

    try {
      const cancel = await studentService.sendMessageStreaming(
        groupId, patientId, sessionId, messageText,
        {
          onChunk: (text) => {
            // Append chunk to the AI message in-place
            setMessages((prev) =>
              prev.map((m) =>
                m.message_id === aiMessageId
                  ? { ...m, message_content: m.message_content + text }
                  : m
              )
            );
          },
          onDone: (fullText) => {
            // Finalize with the complete text (in case chunks were missed)
            setMessages((prev) =>
              prev.map((m) =>
                m.message_id === aiMessageId
                  ? { ...m, message_content: fullText || m.message_content }
                  : m
              )
            );
            setIsAiResponding(false);
            cancelStreamRef.current = null;
          },
          onError: (error) => {
            console.error('Streaming error:', error);
            const errorMsg = error.message || '';
            const isLimitError = errorMsg.toLowerCase().includes('limit') || 
                                 errorMsg.toLowerCase().includes('maximum') ||
                                 errorMsg.includes('MESSAGE_LIMIT_REACHED') ||
                                 errorMsg.includes('403');
            
            if (isLimitError) {
              // Remove the placeholder AI message and show limit notification
              setMessages((prev) => prev.filter((m) => m.message_id !== aiMessageId));
              setMessageLimitReached(true);
            } else {
              setMessages((prev) =>
                prev.map((m) =>
                  m.message_id === aiMessageId
                    ? { ...m, message_content: m.message_content || 'Sorry, something went wrong. Please try again.' }
                    : m
                )
              );
            }
            setIsAiResponding(false);
            cancelStreamRef.current = null;
          },
          onSessionComplete: () => {
            setSessionCompleted(true);
          },
        },
        socketRef.current,
      );
      cancelStreamRef.current = cancel;
    } catch (error) {
      console.error('Failed to start streaming:', error);
      setMessages((prev) =>
        prev.map((m) =>
          m.message_id === aiMessageId
            ? { ...m, message_content: 'Sorry, something went wrong. Please try again.' }
            : m
        )
      );
      setIsAiResponding(false);
    }
  };

  /**
   * Handle Enter key press
   */
  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSendMessage();
    }
  };

  /**
   * Format timestamp for display
   */
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };

  return (
    <PageContainer>
      {/* Confirm Conclude Dialog (legacy) */}
      <ConfirmConcludeDialog
        isOpen={isConfirmConcludeOpen}
        onCancel={() => setIsConfirmConcludeOpen(false)}
        onConfirm={handleConcludeInteraction}
      />

      {/* New Two-Step Conclude Modal */}
      <ConcludeModal
        open={isConcludeModalOpen}
        onOpenChange={setIsConcludeModalOpen}
        sessionId={sessionId || ''}
        simulationGroupId={groupId || ''}
        patientId={patientId || ''}
        onConcluded={handleConcludeWithSubmissions}
        mode={patient.mode || 'full_assessment'}
      />

      {/* Report Issue Dialog */}
      <ReportIssueDialog
        isOpen={isReportIssueOpen}
        onClose={() => setIsReportIssueOpen(false)}
        simulationGroupId={groupId}
        patientId={patientId}
        chatId={sessionId || routeChatId}
      />

      {/* AI Debrief Dialog */}
      <AIDebriefDialog
        isOpen={isAIDebriefOpen}
        onClose={() => setIsAIDebriefOpen(false)}
        data={debriefData}
        updatedDebriefData={updatedDebriefData}
        simulationGroupId={groupId}
        patientId={patientId}
        chatId={sessionId || routeChatId}
        showAnswerKey={false}
        patientMode={patient.mode || 'full_assessment'}
      />

      {/* Full-screen generating debrief overlay */}
      {sessionStatus === 'generating_debrief' && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.45)',
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
          }}
        >
          <Loader2 className="w-12 h-12 animate-spin" style={{ color: '#fff' }} />
          <p className="text-lg font-medium" style={{ color: '#fff' }}>
            Generating Debrief...
          </p>
        </div>
      )}

      {/* Header */}
      <header className="flex-shrink-0 flex border-b border-border items-center justify-between py-6 px-8" style={{ backgroundColor: UI_COLORS.header.background }}>
        <div className="flex items-center gap-4">
          {/* Sidebar Toggle Button */}
          <button
            onClick={() => setIsSidebarVisible(!isSidebarVisible)}
            className="p-2 rounded-lg transition-colors"
            style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
            aria-label="Toggle sidebar"
          >
            <Menu className="w-5 h-5" />
          </button>

          <UserAvatar
            name={user.name}
            imageUrl={user.avatarUrl}
            size="medium"
          />
          <div className="flex flex-col items-start gap-0.5">
            <h1 className="font-bold tracking-tight leading-tight text-2xl" style={{ color: UI_COLORS.text.heading }}>
              AI Patient
            </h1>
            <button
              onClick={handleBackToPatientDashboard}
              className="font-normal text-sm flex items-center gap-1 bg-transparent border-0 cursor-pointer p-0 transition-colors"
              style={{ color: UI_COLORS.text.body }}
              onMouseEnter={(e) => e.currentTarget.style.color = UI_COLORS.text.heading}
              onMouseLeave={(e) => e.currentTarget.style.color = UI_COLORS.text.body}
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Patient Dashboard
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {adminReturnUrl && (
            <Button
              variant="default"
              onClick={() => navigate(adminReturnUrl)}
              className="px-6 transition-colors"
              style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
            >
              Back to Admin View
            </Button>
          )}
          <Button
            variant="default"
            onClick={handleSignOut}
            className="px-6 transition-colors"
            style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
          >
            Sign Out
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Sidebar */}
        <aside 
          className="flex flex-col transition-all duration-300 ease-in-out"
          aria-hidden={!isSidebarVisible}
          style={{ 
            backgroundColor: UI_COLORS.background.white, 
            borderRightWidth: isSidebarVisible ? '1px' : '0px', 
            borderRightStyle: 'solid', 
            borderRightColor: UI_COLORS.border.default,
            width: isSidebarVisible ? '16rem' : '0rem',
            minWidth: isSidebarVisible ? '16rem' : '0rem',
            overflow: 'hidden',
            opacity: isSidebarVisible ? 1 : 0,
            pointerEvents: isSidebarVisible ? 'auto' : 'none',
          }}
        >
          {/* Patient Info */}
          <div className="p-6 flex-shrink-0" style={{ borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: UI_COLORS.border.default }}>
            <h2 className="font-semibold text-lg mb-1 whitespace-nowrap" style={{ color: UI_COLORS.text.heading }}>{patient.name}</h2>
            <p className="text-sm whitespace-nowrap" style={{ color: UI_COLORS.text.body }}>{patient.gender}, {patient.age} years old</p>
          </div>

          {/* Notes Section - flexible, takes remaining space between patient info and buttons */}
          <div className="p-4 flex flex-col flex-1 min-h-0" style={{ borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: UI_COLORS.border.default }}>
            <h3 className="font-semibold text-sm mb-2 whitespace-nowrap flex-shrink-0" style={{ color: UI_COLORS.text.heading }}>Notes</h3>
            <p className="text-xs mb-2 whitespace-nowrap flex-shrink-0" style={{ color: UI_COLORS.text.muted }}>This note saves automatically!</p>
            
            {/* Note Textarea - Auto-saves */}
            <textarea
              value={noteText}
              onChange={handleNoteChange}
              placeholder="Type your notes here..."
              maxLength={5000}
              className="w-full px-3 py-2 rounded-lg resize-none focus:outline-none focus:ring-2 flex-1"
              style={{ 
                borderWidth: '1px', 
                borderStyle: 'solid', 
                borderColor: UI_COLORS.border.default,
                outlineColor: UI_COLORS.border.medium,
                minHeight: '80px',
              }}
            />
            <div className="flex justify-end px-1">
              <span className="text-xs" style={{ color: noteText.length >= 450 ? UI_COLORS.status.error : UI_COLORS.text.muted }}>
                {noteText.length}/500
              </span>
            </div>
          </div>

          {/* Sidebar Buttons - always visible at bottom */}
          <div className="flex flex-col gap-3 p-4 flex-shrink-0">
            <Button
              variant="outline"
              className="w-full justify-start transition-colors border-0 whitespace-nowrap"
              style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
              onClick={() => setIsPatientInfoSidebarOpen(true)}
            >
              <User className="w-5 h-5 mr-2" />
              Patient Information
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start transition-colors border-0 whitespace-nowrap"
              style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
              onClick={() => setContentSidebarType('physical-assessment')}
            >
              <Stethoscope className="w-5 h-5 mr-2" />
              Physical Assessment
            </Button>
            {(sessionStatus === 'active' && patient.mode !== 'conversation_only') && (
              <Button
                variant="outline"
                className="w-full justify-start text-white hover:opacity-90 border-0 whitespace-nowrap"
                style={{ backgroundColor: SIMULATION_GROUP_COLOR_PALETTE[1] }}
                onClick={() => setIsConcludeModalOpen(true)}
              >
                <CheckCircle className="w-5 h-5 mr-2" />
                Conclude Interaction
              </Button>
            )}
            {(sessionStatus === 'generating_debrief' || sessionStatus === 'concluded') && (
              <Button
                variant="outline"
                className="w-full justify-start text-white hover:opacity-90 border-0 whitespace-nowrap"
                style={{ backgroundColor: SIMULATION_GROUP_COLOR_PALETTE[2], opacity: sessionStatus === 'generating_debrief' ? 0.6 : 1 }}
                onClick={() => sessionStatus === 'concluded' && setIsAIDebriefOpen(true)}
                disabled={sessionStatus === 'generating_debrief'}
              >
                <Eye className="w-5 h-5 mr-2" />
                {sessionStatus === 'generating_debrief' ? 'Generating Debrief...' : 'View AI Debrief'}
              </Button>
            )}
            <Button
              variant="outline"
              className="w-full justify-start text-white hover:opacity-90 border-0 whitespace-nowrap"
              style={{ backgroundColor: SIMULATION_GROUP_COLOR_PALETTE[1] }}
              onClick={() => setIsReportIssueOpen(true)}
            >
              <Flag className="w-5 h-5 mr-2" />
              Report Issue
            </Button>
          </div>
        </aside>

        {/* Patient Information Sidebar - Slides from right of notes sidebar */}
        <aside 
          ref={patientInfoRef as React.RefObject<HTMLElement>}
          className="flex flex-col flex-shrink-0 relative"
          aria-hidden={!isPatientInfoSidebarOpen}
          style={{ 
            backgroundColor: UI_COLORS.background.white, 
            borderRightWidth: isPatientInfoSidebarOpen ? '1px' : '0px', 
            borderRightStyle: 'solid', 
            borderRightColor: UI_COLORS.border.default,
            width: isPatientInfoSidebarOpen ? `${patientInfoWidth}px` : '0px',
            minWidth: isPatientInfoSidebarOpen ? `${patientInfoWidth}px` : '0px',
            overflowY: isPatientInfoSidebarOpen ? 'auto' : 'hidden',
            overflowX: 'hidden',
            opacity: isPatientInfoSidebarOpen ? 1 : 0,
            pointerEvents: isPatientInfoSidebarOpen ? 'auto' : 'none',
            transition: 'opacity 0.3s ease-in-out',
          }}
        >
          {/* Drag handle for resizing */}
          {isPatientInfoSidebarOpen && (
            <ResizeHandle onMouseDown={onPatientInfoDrag} direction="left" />
          )}
          {/* Header with close button */}
          {isPatientInfoSidebarOpen && (
            <div className="p-4 flex items-center justify-between flex-shrink-0" style={{ borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: UI_COLORS.border.default }}>
              <h2 className="font-semibold text-lg whitespace-nowrap" style={{ color: UI_COLORS.text.heading }}>
                Patient Information
              </h2>
              <button
                onClick={() => { setIsPatientInfoSidebarOpen(false); setSelectedPatientFile(null); }}
                className="p-2 rounded-lg transition-colors"
                style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
                aria-label="Close patient information sidebar"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              
            </div>
           
          )}

          {/* Content Area - Patient info files with inline PDF viewer */}
          <div className="p-4" style={{ borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: UI_COLORS.border.default }}>
              <div className="flex items-center gap-3 px-4 py-4 rounded-lg" style={{ backgroundColor: UI_COLORS.background.hoverLight }}>
                <p className="text-xs mt-0.5" style={{ color: UI_COLORS.text.muted }}>Drag the handle on the right of this panel to resize it.</p>
              </div>
            </div>
          <div className="flex-1 overflow-y-auto p-4">
            {isPatientInfoSidebarOpen && (
              selectedPatientFile ? (
                <div className="flex flex-col h-full">
                  <button
                    onClick={() => setSelectedPatientFile(null)}
                    className="flex items-center gap-1 text-sm mb-3 bg-transparent border-0 cursor-pointer p-0 transition-colors"
                    style={{ color: UI_COLORS.text.body }}
                    onMouseEnter={(e) => e.currentTarget.style.color = UI_COLORS.text.heading}
                    onMouseLeave={(e) => e.currentTarget.style.color = UI_COLORS.text.body}
                  >
                    <ArrowLeftIcon className="w-4 h-4" />
                    Back to files
                  </button>
                  <h4 className="font-semibold text-sm mb-2" style={{ color: UI_COLORS.text.heading }}>
                    {selectedPatientFile.filename}
                  </h4>
                  {selectedPatientFile.url && (
                      <a
                        href={selectedPatientFile.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-sm px-3 py-1 rounded transition-colors no-underline"
                        style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
                      >
                        Open in new tab
                      </a>
                    )}
                  {selectedPatientFile.url ? (
                    isImageFile(selectedPatientFile.filename) || isImageFile(selectedPatientFile.url) ? (
                      <ImageViewer url={selectedPatientFile.url} title={selectedPatientFile.filename} />
                    ) : (
                      <iframe
                        src={selectedPatientFile.url}
                        title={selectedPatientFile.filename}
                        className="w-full flex-1 rounded border"
                        style={{ borderColor: UI_COLORS.border.default, minHeight: '400px' }}
                        referrerPolicy="no-referrer"
                      />
                    )
                  ) : (
                    <p className="text-xs" style={{ color: UI_COLORS.text.muted }}>No preview available for this file.</p>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {patientFiles.length === 0 ? (
                    <p className="text-sm" style={{ color: UI_COLORS.text.muted }}>No patient information files uploaded.</p>
                  ) : (
                    patientFiles.map((file) => (
                      <div
                        key={file.id}
                        onClick={() => setSelectedPatientFile(file)}
                        className="p-4 rounded-lg cursor-pointer transition-colors"
                        style={{ backgroundColor: UI_COLORS.background.hoverLight }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hover}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hoverLight}
                      >
                        <div className="flex items-start gap-3">
                          <FileText className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: UI_COLORS.text.muted }} />
                          <div className="flex-1">
                            <h4 className="font-semibold text-sm mb-1" style={{ color: UI_COLORS.text.heading }}>
                              {file.filename}
                            </h4>
                            <p className="text-xs" style={{ color: UI_COLORS.text.body }}>
                              {file.description}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )
            )}
          </div>
        </aside>

        {/* Chat Area */}
        <div 
          className="flex-1 flex flex-col transition-all duration-300 ease-in-out"
          style={{
            marginRight: contentSidebarType ? `${physicalAssessmentWidth}px` : '0px',
          }}
        >
          {/* Chat Messages Area */}
          <div className="flex-1 overflow-y-auto p-6">
            {messages.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                {isAiResponding ? (
                  <div className="flex items-center gap-3">
                    <div className="flex-shrink-0">
                      <UserAvatar
                        name={patient.name}
                        imageUrl={patient.imageUrl}
                        size="small"
                      />
                    </div>
                    <div
                      className="rounded-lg rounded-bl-none px-4 py-3"
                      style={{ backgroundColor: UI_COLORS.background.hoverLight }}
                    >
                      <div className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full animate-bounce" style={{ backgroundColor: UI_COLORS.text.muted, animationDelay: '0ms' }} />
                        <span className="w-2 h-2 rounded-full animate-bounce" style={{ backgroundColor: UI_COLORS.text.muted, animationDelay: '150ms' }} />
                        <span className="w-2 h-2 rounded-full animate-bounce" style={{ backgroundColor: UI_COLORS.text.muted, animationDelay: '300ms' }} />
                      </div>
                    </div>
                  </div>
                ) : (
                  <p style={{ color: UI_COLORS.text.light }}>Start a conversation with the AI patient...</p>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((message) => (
                  <div
                    key={message.message_id}
                    className={`flex gap-3 ${message.sender_type === 'student' ? 'justify-end' : 'justify-start'}`}
                  >
                    {/* Avatar for AI patient (left side) */}
                    {message.sender_type !== 'student' && (
                      <div className="flex-shrink-0">
                        <UserAvatar
                          name={patient.name}
                          imageUrl={patient.imageUrl}
                          size="small"
                        />
                      </div>
                    )}

                    {/* Message bubble */}
                    <div
                      className={`max-w-[70%] rounded-lg px-4 py-3 ${
                        message.sender_type === 'student' ? 'rounded-br-none' : 'rounded-bl-none'
                      }`}
                      style={{
                        backgroundColor: message.sender_type === 'student'
                          ? SIMULATION_GROUP_COLOR_PALETTE[2]
                          : UI_COLORS.background.hoverLight,
                        color: message.sender_type === 'student' ? UI_COLORS.button.text : UI_COLORS.text.heading,
                      }}
                    >
                      {message.sender_type === 'ai' && message.message_content === '' && isAiResponding ? (
                        <div className="flex items-center gap-1 py-1">
                          <span className="w-2 h-2 rounded-full animate-bounce" style={{ backgroundColor: UI_COLORS.text.muted, animationDelay: '0ms' }} />
                          <span className="w-2 h-2 rounded-full animate-bounce" style={{ backgroundColor: UI_COLORS.text.muted, animationDelay: '150ms' }} />
                          <span className="w-2 h-2 rounded-full animate-bounce" style={{ backgroundColor: UI_COLORS.text.muted, animationDelay: '300ms' }} />
                        </div>
                      ) : (
                        <p className="text-sm leading-relaxed">{message.message_content}</p>
                      )}
                      <p
                        className="text-xs mt-1"
                        style={{
                          color: message.sender_type === 'student' ? UI_COLORS.button.text : UI_COLORS.text.muted,
                          opacity: message.sender_type === 'student' ? 0.8 : 1,
                        }}
                      >
                        {formatTime(message.sent_at)}
                      </p>
                    </div>

                    {/* Avatar for student (right side) */}
                    {message.sender_type === 'student' && (
                      <div className="flex-shrink-0">
                        <UserAvatar
                          name={user.name}
                          imageUrl={user.avatarUrl}
                          size="small"
                        />
                      </div>
                    )}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Message Input Area — only shown when session is active */}
          {sessionStatus === 'active' && !sessionCompleted && (
            <div className="p-6" style={{ borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: UI_COLORS.border.default }}>
              {isVoiceModeActive ? (
                /* Voice mode controls — replaces text input */
                <div className="flex items-center gap-3">
                  {/* Voice status indicator */}
                  <div className="flex-1 flex items-center gap-3 px-4 py-3 rounded-lg" style={{ backgroundColor: UI_COLORS.background.hoverLight }}>
                    {voiceSessionState === 'connecting' ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" style={{ color: SIMULATION_GROUP_COLOR_PALETTE[1] }} />
                        <span className="text-sm" style={{ color: UI_COLORS.text.body }}>Connecting...</span>
                      </>
                    ) : voiceSessionState === 'error' ? (
                      <>
                        <span className="text-sm" style={{ color: '#ef4444' }}>{voiceError || 'Connection error'}</span>
                        <button
                          onClick={() => { cleanupVoiceSession(); handleStartVoiceMode(); }}
                          className="ml-auto p-2 rounded-full transition-colors"
                          style={{ backgroundColor: UI_COLORS.button.primary }}
                          aria-label="Retry voice connection"
                        >
                          <RotateCcw className="w-4 h-4 text-white" />
                        </button>
                      </>
                    ) : (
                      <>
                        {/* Animated bars */}
                        <div className="flex items-center gap-0.5">
                          {[...Array(4)].map((_, i) => (
                            <div
                              key={i}
                              className="w-0.5 rounded-full animate-pulse"
                              style={{
                                backgroundColor: SIMULATION_GROUP_COLOR_PALETTE[1],
                                height: `${10 + Math.random() * 10}px`,
                                animationDelay: `${i * 0.15}s`,
                              }}
                            />
                          ))}
                        </div>
                        <span className="text-sm" style={{ color: UI_COLORS.text.body }}>
                          {isMuted ? 'Microphone muted' : 'Voice mode active — speak naturally'}
                        </span>
                      </>
                    )}
                  </div>

                  {/* Mute/Unmute — only when active */}
                  {voiceSessionState === 'active' && (
                    <button
                      onClick={() => {
                        if (!audioClientRef.current) return;
                        audioClientRef.current.toggleMute();
                        setIsMuted(!isMuted);
                      }}
                      className="p-3 rounded-full transition-colors"
                      style={{ backgroundColor: isMuted ? '#ef4444' : UI_COLORS.button.secondary, color: isMuted ? '#ffffff' : UI_COLORS.button.text }}
                      aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                    >
                      {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                    </button>
                  )}

                  {/* Stop voice mode */}
                  <button
                    onClick={handleStopVoiceMode}
                    className="p-3 rounded-full transition-colors"
                    style={{ backgroundColor: SIMULATION_GROUP_COLOR_PALETTE[1] }}
                    aria-label="Stop voice mode"
                  >
                    <X className="w-5 h-5 text-white" />
                  </button>
                </div>
              ) : (
                /* Text input mode */
                <div className="flex items-center gap-3">
                  {patient.voice_enabled !== false && (
                  <div className="relative">
                  <button
                    onClick={handleStartVoiceMode}
                    disabled={!sessionId || !patient?.name || patient.name === 'Loading...' || isAiResponding || messageLimitReached}
                    className="p-3 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
                    onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover; }}
                    onMouseLeave={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary; }}
                    aria-label="Voice input"
                    title={!supportsVoiceMode() ? 'Voice works best on Chrome or Edge' : !sessionId ? 'Waiting for session...' : !patient?.name || patient.name === 'Loading...' ? 'Loading patient...' : isAiResponding ? 'Waiting for AI response...' : 'Start voice mode'}
                  >
                    <Mic className="w-5 h-5" />
                  </button>
                  {!supportsVoiceMode() && (
                    <span
                      className="absolute -top-1 -right-1 w-3.5 h-3.5 flex items-center justify-center rounded-full text-[8px] font-bold"
                      style={{ backgroundColor: '#f59e0b', color: '#ffffff' }}
                      title="Voice mode works best on Chrome or Edge"
                    >
                      !
                    </span>
                  )}
                  </div>
                  )}
                  
                  {messageLimitReached && (
                    <div className="flex-1 flex items-center gap-3 px-4 py-3 rounded-lg" style={{ backgroundColor: UI_COLORS.background.hoverLight }}>
                      <Flag className="w-5 h-5 flex-shrink-0" style={{ color: UI_COLORS.text.muted }} />
                      <div className="flex-1">
                        <p className="text-sm font-medium" style={{ color: UI_COLORS.text.heading }}>
                          You have reached the message limit of {patient?.max_messages_per_chat} for this interaction.
                        </p>
                        <p className="text-xs mt-0.5" style={{ color: UI_COLORS.text.muted }}>
                          Conclude your interaction to receive your AI debrief. Please reach out to your instructor if you have any questions.
                        </p>
                      </div>
                    </div>
                  )}

                  {!messageLimitReached && (
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      value={inputMessage}
                      onChange={(e) => setInputMessage(e.target.value)}
                      onKeyPress={handleKeyPress}
                      placeholder="Type your message..."
                      disabled={messageLimitReached}
                      className="w-full px-4 py-3 pr-12 rounded-lg focus:outline-none focus:ring-2"
                      style={{ 
                        borderWidth: '1px', 
                        borderStyle: 'solid', 
                        borderColor: UI_COLORS.border.default,
                        outlineColor: UI_COLORS.border.medium
                      }}
                    />
                    <button
                      onClick={handleSendMessage}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
                      onMouseEnter={(e) => !inputMessage.trim() ? null : e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
                      aria-label="Send message"
                      disabled={!inputMessage.trim() || isAiResponding || !sessionId || messageLimitReached}
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Session completed — patient ended the conversation */}
          {sessionStatus === 'active' && sessionCompleted && (
            <div className="p-6" style={{ borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: UI_COLORS.border.default }}>
              <div className="flex items-center gap-3 px-4 py-4 rounded-lg" style={{ backgroundColor: UI_COLORS.background.hoverLight }}>
                <CheckCircle className="w-5 h-5 flex-shrink-0" style={{ color: SIMULATION_GROUP_COLOR_PALETTE[1] }} />
                <div className="flex-1">
                  <p className="text-sm font-medium" style={{ color: UI_COLORS.text.heading }}>
                    The patient has ended the conversation.
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: UI_COLORS.text.muted }}>
                    Please conclude the interaction using the sidebar and submit your recommendations.
                  </p>
                </div>
              </div>
            </div>
          )}
          <div className="p-6" style={{ borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: UI_COLORS.border.default }}>
              <div className="flex items-center gap-3 px-4 py-4 rounded-lg" style={{ backgroundColor: UI_COLORS.background.hoverLight }}>
                <p className="text-xs mt-0.5" style={{ color: UI_COLORS.text.muted }}>Troubleshooting Tips: Choose either voice or text for your interaction. If the your mic or audio becomes unresponsive, click "Back to Patient Dashboard" at the top of the screen, then load back into this interaction.</p>
              </div>
            </div>
          {/* Generating Debrief indicator */}
          {sessionStatus === 'generating_debrief' && (
            <div className="p-8 flex items-center justify-center" style={{ borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: UI_COLORS.border.default }}>
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: UI_COLORS.text.muted }} />
                <p className="text-base" style={{ color: UI_COLORS.text.body }}>
                  Generating debrief...
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Content Sidebar (Case Materials or Physical Assessment) - Slides from right edge */}
        <aside 
          ref={physicalAssessmentRef as React.RefObject<HTMLElement>}
          className="flex flex-col absolute top-0 bottom-0 right-0 z-30 overflow-y-auto"
          aria-hidden={!contentSidebarType}
          style={{ 
            backgroundColor: UI_COLORS.background.white, 
            borderLeftWidth: '1px', 
            borderLeftStyle: 'solid', 
            borderLeftColor: UI_COLORS.border.default,
            width: `${physicalAssessmentWidth}px`,
            transform: contentSidebarType ? 'translateX(0)' : 'translateX(100%)',
            boxShadow: contentSidebarType ? '-4px 0 6px rgba(0, 0, 0, 0.1)' : 'none',
            transition: 'transform 0.3s ease-in-out, box-shadow 0.3s ease-in-out',
          }}
        >
          {/* Drag handle for resizing */}
          {contentSidebarType && (
            <ResizeHandle onMouseDown={onPhysicalAssessmentDrag} direction="right" />
          )}
          {/* Header with close button */}
          {contentSidebarType && (
            <div className="p-4 flex items-center justify-between" style={{ borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: UI_COLORS.border.default }}>
              <h2 className="font-semibold text-lg whitespace-nowrap" style={{ color: UI_COLORS.text.heading }}>
                Physical Assessment
              </h2>
              <button
                onClick={() => setContentSidebarType(null)}
                className="p-2 rounded-lg transition-colors"
                style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
                aria-label="Close content sidebar"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}

          {/* Content Area */}
          <div className="p-4" style={{ borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: UI_COLORS.border.default }}>
              <div className="flex items-center gap-3 px-4 py-4 rounded-lg" style={{ backgroundColor: UI_COLORS.background.hoverLight }}>
                <p className="text-xs mt-0.5" style={{ color: UI_COLORS.text.muted }}>Drag the handle on the left of this panel to resize it.</p>
              </div>
            </div>
          <div className="flex-1 overflow-y-auto p-4">
            {contentSidebarType === 'physical-assessment' && (
              <PhysicalAssessmentContent materials={personaMedia} loading={personaMediaLoading} />
            )}
          </div>
        </aside>
      </div>
    </PageContainer>
  );
}

export default StudentChatPage;
