/**
 * Student Service
 * 
 * Calls real backend API endpoints via API Gateway.
 * Falls back to mock data if API calls fail (for local dev without backend).
 */

import { getSimulationGroupColor } from '@/lib/colors';
import { apiClient } from '@/lib/api-client';
import { authService } from '@/lib/auth';
import { setCached } from '@/lib/dataCache';
import type { Socket } from 'socket.io-client';

/**
 * Represents a medical simulation group that students can join
 */
export interface SimulationGroup {
  simulation_group_id: string;              // Unique identifier
  name: string;            // Group name (e.g., "Chronic Pain")
  subtitle: string;        // Always "Medical Simulation Group"
  icon_url?: string;        // Optional icon image URL
  icon_color?: string;      // Fallback color for avatar (hex format)
  student_count?: number;   // Optional count of students (admin view only)
  instructor_count?: number; // Optional count of instructors (admin view only)
  persona_count?: number;   // Optional count of patients (admin view only)
}

/**
 * Represents current user data
 */
export interface UserData {
  name: string;
  email?: string;
  avatarUrl?: string;
}

/**
 * Represents a patient in a simulation group
 */
export interface Patient {
  patient_id: string;            // Unique identifier
  patient_name: string;          // Patient name
  avatarUrl?: string;            // Optional patient image URL
  debrief_status: 'not_started' | 'in_progress' | 'debrief_reached'; // Overall patient case status
  instructor_evaluation: string;  // Instructor evaluation status
  best_coverage: number | null;  // Best key question coverage % across completed chats
  attempt_count: number;         // Total number of chat sessions
  last_accessed: string | null;  // Last time the student interacted with this patient
  mode: 'interview_practice' | 'full_assessment' | 'conversation_only'; // Derived from DTP/Recommendation assignments
}


/**
 * Represents a chat session
 */
export interface Session {
  chat_id: string;
  student_interaction_id: string;
  chat_name: string;
  last_accessed: string;
  notes?: string;
}

/**
 * Student data service — calls real API, throws on failure
 */

/**
 * Represents a case material for physical assessment
 */
export interface StudentCaseMaterial {
  id: string;
  title: string;
  description: string;
  type: 'image' | 'video' | 'document' | 'audio';
  group: string;
}

/**
 * Represents a patient file (e.g., uploaded PDF)
 */
export interface PatientFile {
  id: string;
  filename: string;
  description: string;
  url?: string;
}

/**
 * Represents a patient's detailed info for chat/dashboard views
 */
export interface PatientDetail {
  id: string | undefined;
  name: string;
  age: number;
  gender: string;
  voice_enabled?: boolean;
  imageUrl?: string;
  pronouns?: string;
  sex?: string;
  primaryComplaint?: string;
  avatarUrl?: string;
  mode?: 'interview_practice' | 'full_assessment' | 'conversation_only';
  max_messages_per_chat?: number | null;
}

/**
 * Represents a chat history entry on the patient dashboard
 */
export interface ChatHistoryEntry {
  id: string;
  name: string;
  completionStatus: string;
  score: string | null;
}

/**
 * Represents key questions coverage data per attempt
 */
export interface KeyQuestionsCoverageData {
  attempt: string;
  attemptNumber: number;
  coverage: number;
}

/**
 * Represents AI debrief data
 */
export interface AIDebriefData {
  summary: string;
  questionsAddressed: string[];
  missedKeyQuestionsCount: number;
  missedQuestions: string[];
  missedQuestionsGuidance: string;
  overallScore?: number;
  recommendation?: string;
  recommendationFeedback: {
    strengths: string[];
    areasForImprovement: string[];
  };
  suggestedRewrites: {
    original: string;
    suggested: string;
  }[];
  rubricDescription: string;
  answerKeyComparison?: {
    answerKeyAvailable: boolean;
    correctElements?: string[];
    missingElements?: string[];
    incorrectElements?: string[];
    overallAlignment?: string;
  };
  evaluationIntegrity?: {
    evaluationComplete: boolean;
    degraded: boolean;
    degradedReasons: { component: string; reason: string; impact: string }[];
  };
}

/**
 * Represents a physical assessment activity
 */
export interface AssessmentActivity {
  id: string;
  name: string;
  category: string;
  icon: 'stethoscope' | 'heart' | 'thermometer' | 'eye' | 'ear' | 'activity';
}

/**
 * Represents a chat message (matching database schema)
 */
export interface StudentChatMessage {
  message_id: string;
  chat_id: string;
  sender_type: 'student' | 'ai' | 'system';
  message_content: string;
  sent_at: string;
}



/**
 * Get case materials for student views — requires API call via fetchCaseMaterials
 */
function getCaseMaterials(): StudentCaseMaterial[] {
  return [];
}

/**
 * Get patient files — requires API call via fetchPatientFiles
 */
function getPatientFiles(): PatientFile[] {
  return [];
}

/**
 * Get patient detail by ID — requires API call via fetchPatientDetail
 */
function getPatientDetail(_patientId: string | undefined): PatientDetail {
  return { id: undefined, name: '', age: 0, gender: '' };
}

/**
 * Fetch patient detail from the API.
 * Uses /student/simulation_group_page to get persona data, then picks the matching patient.
 */
async function fetchPatientDetail(simulationGroupId: string, patientId: string): Promise<PatientDetail> {
  try {
    const user = await authService.getCurrentUser();
    if (!user) throw new Error('Not authenticated');

    // First try to get files to obtain profile picture
    let profilePictureUrl: string | undefined;
    try {
      const filesData = await apiClient.request<{
        profile_picture_url?: string | null;
      }>(
        `student/get_all_files?simulation_group_id=${encodeURIComponent(simulationGroupId)}&persona_id=${encodeURIComponent(patientId)}&patient_name=patient`
      );
      profilePictureUrl = filesData.profile_picture_url ?? undefined;
    } catch {
      // Profile picture is optional
    }

    const data = await apiClient.request<Array<{
      persona_id: string;
      persona_name: string;
      persona_age: number;
      persona_gender: string;
      voice_enabled?: boolean;
      mode?: 'interview_practice' | 'full_assessment' | 'conversation_only';
      max_messages_per_chat?: number | null;
    }>>(
      `student/simulation_group_page?simulation_group_id=${encodeURIComponent(simulationGroupId)}`
    );

    const persona = data.find(p => p.persona_id === patientId);
    if (persona) {
      return {
        id: patientId,
        name: persona.persona_name,
        age: persona.persona_age,
        gender: persona.persona_gender,
        voice_enabled: persona.voice_enabled !== false,
        imageUrl: profilePictureUrl,
        avatarUrl: profilePictureUrl,
        mode: persona.mode || 'full_assessment',
        max_messages_per_chat: persona.max_messages_per_chat ?? null,
      };
    }
  } catch (error) {
    console.error('Failed to fetch patient detail:', error);
  }
  throw new Error('Failed to load patient details. Please try again.');
}

/**
 * Response shape from /student/get_all_files
 */
interface GetAllFilesResponse {
  document_files: Record<string, { url: string; metadata: string | null; display_name?: string | null }>;
  info_files: Record<string, { url: string; metadata: string | null; display_name?: string | null }>;
  answer_key_files: Record<string, { url: string; metadata: string | null; display_name?: string | null }>;
  profile_picture_url: string | null;
}

/**
 * Fetch patient files from the API via /student/get_all_files.
 * Maps document_files + info_files into PatientFile[].
 */
async function fetchPatientFiles(simulationGroupId: string, patientId: string): Promise<PatientFile[]> {
  try {
    const data = await apiClient.request<GetAllFilesResponse>(
      `student/get_all_files?simulation_group_id=${encodeURIComponent(simulationGroupId)}&persona_id=${encodeURIComponent(patientId)}&patient_name=patient`
    );

    const files: PatientFile[] = [];
    let idx = 1;

    for (const [filename, info] of Object.entries(data.info_files ?? {})) {
      files.push({ id: String(idx++), filename: info.display_name || filename, description: info.metadata ?? 'No description available', url: info.url });
    }

    return files.length > 0 ? files : [];
  } catch (error) {
    console.error('Failed to fetch patient files:', error);
    throw new Error('Failed to load patient files. Please try again.');
  }
}

/**
 * Fetch case materials from the API via /student/get_all_files.
 * Maps the different file categories into StudentCaseMaterial[].
 */
async function fetchCaseMaterials(simulationGroupId: string, patientId: string): Promise<StudentCaseMaterial[]> {
  try {
    const data = await apiClient.request<GetAllFilesResponse>(
      `student/get_all_files?simulation_group_id=${encodeURIComponent(simulationGroupId)}&persona_id=${encodeURIComponent(patientId)}&patient_name=patient`
    );

    const materials: StudentCaseMaterial[] = [];
    let idx = 1;

    const inferType = (filename: string): StudentCaseMaterial['type'] => {
      const ext = filename.split('.').pop()?.toLowerCase() ?? '';
      if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) return 'image';
      if (['mp4', 'mov', 'avi', 'webm'].includes(ext)) return 'video';
      if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return 'audio';
      return 'document';
    };

    for (const [filename, info] of Object.entries(data.document_files ?? {})) {
      materials.push({
        id: String(idx++),
        title: filename,
        description: info.metadata ?? '',
        type: inferType(filename),
        group: 'Documents',
      });
    }
    for (const [filename, info] of Object.entries(data.info_files ?? {})) {
      materials.push({
        id: String(idx++),
        title: filename,
        description: info.metadata ?? '',
        type: inferType(filename),
        group: 'Patient Information',
      });
    }

    return materials.length > 0 ? materials : [];
  } catch (error) {
    console.error('Failed to fetch case materials:', error);
    throw new Error('Failed to load case materials. Please try again.');
  }
}

/**
 * Represents a physical assessment material from the persona_media table
 */
export interface PersonaMedia {
  media_id: string;
  title: string;
  description: string;
  media_type: string;
  url: string;
}

/**
 * Fetch physical assessment materials (persona_media) for a patient from the API.
 */
async function fetchPersonaMedia(patientId: string): Promise<PersonaMedia[]> {
  try {
    const data = await apiClient.request<any[]>(
      `student/persona_media?persona_id=${encodeURIComponent(patientId)}`
    );
    return data.map((row) => ({
      media_id: row.media_id,
      title: row.title || '',
      description: row.description || '',
      media_type: row.media_type || 'other',
      url: row.url || '',
    }));
  } catch (error) {
    console.error('Failed to fetch persona media:', error);
    return [];
  }
}

/**
 * Get chat history entries for patient dashboard — requires API call via fetchChatHistory
 */
function getChatHistory(): ChatHistoryEntry[] {
  return [];
}

/**
 * Fetch chat history (sessions) for a patient from the API via GET /student/patient.
 * Returns ChatHistoryEntry[] mapped from the chats table rows.
 */
async function fetchChatHistory(simulationGroupId: string, patientId: string): Promise<ChatHistoryEntry[]> {
  try {
    const user = await authService.getCurrentUser();
    if (!user) throw new Error('Not authenticated');

    const data = await apiClient.request<Array<{
      chat_id: string;
      student_interaction_id: string;
      chat_name: string | null;
      last_accessed: string | null;
      notes: string | null;
      status: string | null;
      overall_score: number | null;
    }>>(
      `student/patient?simulation_group_id=${encodeURIComponent(simulationGroupId)}&patient_id=${encodeURIComponent(patientId)}`
    );

    if (!Array.isArray(data) || data.length === 0) return [];

    // Sort by last_accessed descending so the most recent chat appears first
    data.sort((a, b) => {
      const dateA = a.last_accessed ? new Date(a.last_accessed).getTime() : 0;
      const dateB = b.last_accessed ? new Date(b.last_accessed).getTime() : 0;
      return dateB - dateA;
    });

    return data.map((chat, index) => {
      const dateStr = chat.last_accessed
        ? new Date(chat.last_accessed).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '';

      let displayName = chat.chat_name;
      if (displayName) {
        // Check if the name contains a large number (epoch timestamp)
        const timestampMatch = displayName.match(/(\d{10,13})/);
        if (timestampMatch) {
          const ts = Number(timestampMatch[1]);
          const parsed = new Date(ts < 1e12 ? ts * 1000 : ts); // handle seconds vs ms
          if (!isNaN(parsed.getTime())) {
            const formatted = parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            + ' ' + parsed.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
            displayName = displayName.replace(timestampMatch[1], formatted);
          }
        }
      }

      return {
        id: chat.chat_id,
        name: displayName || `Attempt ${index + 1}${dateStr ? ` - ${dateStr}` : ''}`,
        completionStatus: chat.status === 'concluded' ? 'Complete' : 'In Progress',
        score: chat.overall_score != null ? `${Math.round(chat.overall_score)}%` : null,
      };
    });
  } catch (error) {
    console.error('Failed to fetch chat history from API:', error);
    throw new Error('Failed to load chat history. Please try again.');
  }
}

/**
 * Fetch messages for an existing chat session via GET /student/get_messages.
 */
async function fetchMessages(sessionId: string): Promise<StudentChatMessage[]> {
  try {
    const data = await apiClient.request<Array<{
      message_id: string;
      chat_id: string;
      sender_type: string;
      message_content: string;
      sent_at: string;
      user_id?: string;
    }>>(
      `student/get_messages?session_id=${encodeURIComponent(sessionId)}`
    );

    if (!Array.isArray(data)) return [];

    const mapped = data.map((msg) => ({
      message_id: msg.message_id,
      chat_id: msg.chat_id,
      sender_type: (msg.sender_type as 'student' | 'ai' | 'system') || 'ai',
      message_content: msg.message_content,
      sent_at: msg.sent_at,
    }));

    // Deduplicate by sender_type + message_content (backend may insert the same message twice with different IDs)
    // Also filter out the system prompt that kicks off the AI patient conversation
    const seen = new Set<string>();
    return mapped.filter((msg) => {
      if (msg.message_content.trim().startsWith('Begin the conversation as the patient:')) return false;
      const key = `${msg.sender_type}::${msg.message_content.trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (error) {
    console.error('Failed to fetch messages:', error);
    return [];
  }
}

// Import debrief parser functions from consolidated module (used locally in fetchDebrief)
import { deepParseJson, extractDebriefFromRawJson } from '@/lib/debrief-parser';
// Re-export for backward compatibility with existing consumers
export { deepParseJson, extractDebriefFromRawJson };

/**
 * Fetch AI debrief for a concluded session via GET /student/get_debrief.
 */
export async function fetchDebrief(sessionId: string): Promise<AIDebriefData | null> {
  try {
    const user = await authService.getCurrentUser();
    if (!user?.email) throw new Error('Not authenticated');

    console.log('[fetchDebrief] start', { sessionId, email: user.email });

    const maxAttempts = 6;
    const baseDelayMs = 400;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      console.log('[fetchDebrief] request attempt', { attempt: attempt + 1, maxAttempts });

      const data = await apiClient.request<{ generated_text?: any; status?: string; error?: string }>(
        `student/get_debrief?session_id=${encodeURIComponent(sessionId)}`
      );

      console.log('[fetchDebrief] response meta', {
        attempt: attempt + 1,
        status: data?.status,
        hasGeneratedText: Boolean(data?.generated_text),
        error: data?.error,
        generatedTextType: typeof data?.generated_text,
      });

      if (data?.status === 'generating') {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.log('[fetchDebrief] generating -> retrying after delay', { delayMs: delay, attempt: attempt + 1 });
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (!data?.generated_text) {
        console.log('[fetchDebrief] no generated_text, returning null');
        return null;
      }

      let raw = data.generated_text;

      if (typeof raw === 'string') {
        console.log('[fetchDebrief] generated_text is a string, will parse');
      } else {
        console.log('[fetchDebrief] generated_text is already an object');
      }

      const rawPreview = typeof raw === 'string' ? raw.slice(0, 200) : JSON.stringify(raw).slice(0, 200);
      console.log('[fetchDebrief] raw generated_text preview', rawPreview);

      let debrief = deepParseJson(raw);

      console.log('[fetchDebrief] after deepParseJson', {
        parsed: Boolean(debrief),
        keys: debrief ? Object.keys(debrief).slice(0, 20) : [],
        summaryType: debrief ? typeof debrief.summary : undefined,
      });

      if (!debrief || typeof debrief !== 'object') {
        console.log('[fetchDebrief] parsed debrief is null/invalid, returning null');
        return null;
      }

      // Check if summary contains '{' instead of strictly starting with it
      if (
        debrief.summary &&
        typeof debrief.summary === 'string' &&
        debrief.summary.includes('{')
      ) {
        console.log('[fetchDebrief] summary contains { -> attempting to extract and repair');
        
        // USE THE REPAIR FUNCTION HERE
        const extracted = extractDebriefFromRawJson(debrief.summary);

        if (extracted && typeof extracted === 'object') {
          debrief = { ...debrief, ...extracted } as Record<string, any>;
          console.log('[fetchDebrief] replaced debrief with repaired JSON from summary');
        } else {
           console.log('[fetchDebrief] advanced repair failed, falling back to basic extraction');
        }
      }

      // Final fallback if summary somehow remains a JSON string with leading/trailing spaces
      if (typeof debrief.summary === 'string' && debrief.summary.includes('{')) {
        try {
          const firstBrace = debrief.summary.indexOf('{');
          const lastBrace = debrief.summary.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            const summaryObj = JSON.parse(debrief.summary.substring(firstBrace, lastBrace + 1));
            if (summaryObj.summary) {
              debrief.summary = summaryObj.summary;
            }
          }
        } catch (e) {
          console.warn('[fetchDebrief] could not parse summary as JSON, extracting text', e);
          const m = debrief.summary.match(/"summary"\s*:\s*"([^"]+)"/);
          if (m) {
            debrief.summary = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
            console.log('[fetchDebrief] extracted summary via regex from truncated JSON');
          } else {
            debrief.summary = 'AI debrief summary could not be fully parsed. Please try concluding the session again.';
            console.log('[fetchDebrief] summary was unparseable JSON, replaced with fallback message');
          }
        }
      }

      const addressedQuestions = (debrief.questions_addressed || []).map(
        (q: string | { question_text?: string }) =>
          typeof q === 'string' ? q : (q.question_text || 'Unknown question')
      );
      const missedQuestions = (debrief.questions_missed || []).map(
        (q: string | { question_text?: string }) =>
          typeof q === 'string' ? q : (q.question_text || 'Unknown question')
      );

      const mapped: AIDebriefData = {
        summary: typeof debrief.summary === 'string' ? debrief.summary : '',
        questionsAddressed: addressedQuestions,
        missedKeyQuestionsCount: missedQuestions.length,
        missedQuestions: missedQuestions,
        missedQuestionsGuidance: typeof debrief.reasoning_gaps === 'string' ? debrief.reasoning_gaps : '',
        overallScore: typeof debrief.overall_score === 'number' ? debrief.overall_score : undefined,
        recommendation: typeof debrief.recommendation === 'string' ? debrief.recommendation : undefined,
        recommendationFeedback: {
          strengths: debrief.recommendation_feedback?.strengths || [],
          areasForImprovement: debrief.recommendation_feedback?.areas_for_improvement || [],
        },
        suggestedRewrites: (debrief.suggested_rewrites || []).map(
          (r: { original_message?: string; suggested_rewrite?: string }) => ({
            original: r.original_message || '',
            suggested: r.suggested_rewrite || '',
          })
        ),
        rubricDescription: 'Compare your recommendations with the answer key provided by your instructor.',
        answerKeyComparison: debrief.answer_key_comparison ? {
          answerKeyAvailable: debrief.answer_key_comparison.answer_key_available ?? false,
          correctElements: debrief.answer_key_comparison.correct_elements,
          missingElements: debrief.answer_key_comparison.missing_elements,
          incorrectElements: debrief.answer_key_comparison.incorrect_elements,
          overallAlignment: debrief.answer_key_comparison.overall_alignment,
        } : undefined,
        evaluationIntegrity: debrief.evaluation_integrity ? {
          evaluationComplete: debrief.evaluation_integrity.evaluation_complete ?? true,
          degraded: debrief.evaluation_integrity.degraded ?? false,
          degradedReasons: (debrief.evaluation_integrity.degraded_reasons || []).map(
            (r: { component?: string; reason?: string; impact?: string }) => ({
              component: r.component || '',
              reason: r.reason || '',
              impact: r.impact || '',
            })
          ),
        } : undefined,
      };

      console.log('[fetchDebrief] mapped result', {
        summaryPreview: mapped.summary.slice(0, 200),
        addressedCount: mapped.questionsAddressed.length,
        missedCount: mapped.missedQuestions.length,
      });

      return mapped;
    }

    console.log('[fetchDebrief] exhausted retries, returning null', { sessionId });
    return null;
  } catch (error) {
    console.error('[fetchDebrief] failed', { sessionId, error });
    return null;
  }
}

/**
 * Get key questions coverage data — no longer available without API
 */
function getKeyQuestionsCoverageData(): KeyQuestionsCoverageData[] {
  return [];
}

/**
 * Get AI debrief data — requires API call via fetchDebrief
 */
function getAIDebriefData(): AIDebriefData | null {
  return null;
}

/**
 * Get physical assessment activities — requires API call via fetchPersonaMedia
 */
function getAssessmentActivities(): AssessmentActivity[] {
  return [];
}

/**
 * Get chat history messages for read-only view — requires API call via fetchMessages
 */
function getChatHistoryMessages(_chatId: string): StudentChatMessage[] {
  return [];
}

/**
 * Get saved note for a chat — requires API call via fetchNotes
 */
function getSavedNote(): string {
  return '';
}

/**
 * Fetch notes for a session from the API
 */
async function fetchNotes(sessionId: string): Promise<string> {
  try {
    const data = await apiClient.request<{ notes: string | null }>(
      `student/get_notes?session_id=${encodeURIComponent(sessionId)}`
    );
    return data.notes || '';
  } catch (error) {
    console.error('Failed to fetch notes:', error);
    return '';
  }
}

/**
 * Update (save) notes for a session
 */
async function updateNotes(sessionId: string, notes: string): Promise<boolean> {
  try {
    await apiClient.request(
      `student/update_notes?session_id=${encodeURIComponent(sessionId)}`,
      { method: 'PUT', body: { notes } }
    );
    return true;
  } catch (error) {
    console.error('Failed to save notes:', error);
    return false;
  }
}

/**
 * Get simulation groups — calls API, falls back to mock
 */
async function getSimulationGroups(): Promise<SimulationGroup[]> {
  try {
    const user = await authService.getCurrentUser();
    if (!user) throw new Error('Not authenticated');

    const data = await apiClient.request<SimulationGroup[]>(
      `student/simulation_group`
    );
    return data.map((g: any, i: number) => ({
      simulation_group_id: g.simulation_group_id,
      name: g.group_name,
      subtitle: 'Medical Simulation Group',
      icon_color: g.icon_color || getSimulationGroupColor(i),
      access_code: g.group_access_code || '',
      student_count: g.student_count || 0,
      instructor_count: g.instructor_count || 0,
      persona_count: g.persona_count || 0,
      organization_id: g.organization_id || '',
    }));

  } catch (error) {
    console.error('Failed to fetch simulation groups:', error);
    throw new Error('Failed to load simulation groups. Please try again.');
  }
}

/**
 * Get current user data
 */
async function getCurrentUser(): Promise<UserData | null> {
  try {
    const user = await authService.getCurrentUser();
    if (!user) return null;
    return { name: user.username || user.email, email: user.email };
  } catch (error) {
    console.error('Failed to get current user:', error);
    return null;
  }
}

/**
 * Get patients for a simulation group
 */
async function getPatients(simulationGroupId: string): Promise<Patient[]> {
  try {
    const user = await authService.getCurrentUser();
    if (!user) throw new Error('Not authenticated');

    // Fetch all three data sources in parallel (3 requests instead of 1 + 2N)
    const [data, profilePicsMap, statsMap] = await Promise.all([
      // 1. Patient list (existing endpoint)
      apiClient.request<any[]>(
        `student/simulation_group_page?simulation_group_id=${encodeURIComponent(simulationGroupId)}`
      ),
      // 2. Batch profile pictures (existing endpoint, previously unused by students)
      apiClient.request<Record<string, string>>(
        `student/get_profile_pictures?simulation_group_id=${encodeURIComponent(simulationGroupId)}`,
        { method: 'POST' }
      ).catch(() => ({} as Record<string, string>)),
      // 3. Batch chat stats (new endpoint)
      apiClient.request<Record<string, {
        attempt_count: number;
        best_coverage: number | null;
        has_active_chat: boolean;
        last_chat_accessed: string | null;
      }>>(
        `student/group_patient_stats?simulation_group_id=${encodeURIComponent(simulationGroupId)}`
      ).catch(() => ({} as Record<string, { attempt_count: number; best_coverage: number | null; has_active_chat: boolean; last_chat_accessed: string | null }>)),
    ]);

    // Deduplicate by persona_id (backend may return multiple rows from different enrollments)
    const seen = new Set<string>();
    const uniqueData = data.filter((p) => {
      if (seen.has(p.persona_id)) return false;
      seen.add(p.persona_id);
      return true;
    });

    const result: Patient[] = uniqueData.map((p) => {
      const stats = statsMap[p.persona_id] || { attempt_count: 0, best_coverage: null, has_active_chat: false, last_chat_accessed: null };
      let debriefStatus: Patient['debrief_status'];
      if (p.is_completed) {
        debriefStatus = 'debrief_reached';
      } else if (stats.has_active_chat) {
        debriefStatus = 'in_progress';
      } else {
        debriefStatus = 'not_started';
      }

      return {
        patient_id: p.persona_id,
        patient_name: p.persona_name,
        avatarUrl: profilePicsMap[p.persona_id] || undefined,
        debrief_status: debriefStatus,
        instructor_evaluation: p.persona_score > 0 ? 'Evaluated' : 'Not Evaluated',
        best_coverage: stats.best_coverage != null ? Math.round(stats.best_coverage) : null,
        attempt_count: stats.attempt_count,
        last_accessed: stats.last_chat_accessed,
        mode: p.mode || 'full_assessment',
      };
    });

    // Cache for stale-while-revalidate so returning to this group renders instantly.
    setCached(`student:patients:${simulationGroupId}`, result);
    return result;
  } catch (error) {
    console.error('Failed to fetch patients:', error);
    throw new Error('Failed to load patients. Please try again.');
  }
}

/**
 * Join a simulation group by access code
 */
async function joinGroup(accessCode: string, enrollmentType?: string): Promise<{ success: boolean }> {
  try {
    const user = await authService.getCurrentUser();
    if (!user) throw new Error('Not authenticated');

    let url = `student/enroll_student?group_access_code=${encodeURIComponent(accessCode)}`;
    if (enrollmentType) {
      url += `&enrollment_type=${encodeURIComponent(enrollmentType)}`;
    }

    await apiClient.request(url, { method: 'POST' });
    return { success: true };
  } catch (error) {
    console.error('Failed to join group:', error);
    return { success: false };
  }
}

/**
 * Create a new session
 */
async function createSession(simulationGroupId: string, patientId: string, sessionName: string): Promise<Session | null> {
  try {
    const user = await authService.getCurrentUser();
    if (!user) throw new Error('Not authenticated');

    const data = await apiClient.request<Session[]>(
      `student/create_session?simulation_group_id=${encodeURIComponent(simulationGroupId)}&patient_id=${encodeURIComponent(patientId)}&session_name=${encodeURIComponent(sessionName)}`,
      { method: 'POST' }
    );

    return data[0] || null;
  } catch (error) {
    console.error('Failed to create session:', error);
    return null;
  }
}

/**
 * Send a message and get the AI response via text generation
 */
async function sendMessage(
  simulationGroupId: string,
  patientId: string,
  sessionId: string,
  messageContent: string
): Promise<{ llm_output: string }> {
  const result = await apiClient.request<{ llm_output: string }>(
    `student/text_generation?simulation_group_id=${encodeURIComponent(simulationGroupId)}&patient_id=${encodeURIComponent(patientId)}&session_id=${encodeURIComponent(sessionId)}`,
    {
      method: 'POST',
      body: { message_content: messageContent },
    }
  );
  return result;
}

/**
 * Send a message with real-time streaming via the ECS Socket.IO server.
 *
 * Emits a 'text-generation' event to the socket server, which calls the
 * text generation Lambda. The Lambda POSTs chunks back to the socket server,
 * which relays them as 'text-stream' events on this connection.
 *
 * Returns a cancel function to stop listening for events.
 */
async function sendMessageStreaming(
  simulationGroupId: string,
  patientId: string,
  sessionId: string,
  messageContent: string,
  callbacks: {
    onChunk: (text: string) => void;
    onDone: (fullText: string) => void;
    onError: (error: Error) => void;
    onSessionComplete?: () => void;
  },
  socket?: Socket | null,
): Promise<() => void> {
  if (!socket || !socket.connected) {
    // No socket available — fall back to non-streaming REST call
    console.warn('No socket connection, falling back to non-streaming');
    sendMessage(simulationGroupId, patientId, sessionId, messageContent)
      .then((res) => callbacks.onDone(res.llm_output))
      .catch((e) => callbacks.onError(e instanceof Error ? e : new Error(String(e))));
    return () => {};
  }

  const handler = (data: { type: string; content: string }) => {
    switch (data.type) {
      case 'chunk':
        callbacks.onChunk(data.content);
        break;
      case 'end':
        callbacks.onDone(data.content);
        // Don't clean up yet — session_complete may follow shortly
        setTimeout(cleanup, 3000);
        break;
      case 'session_complete':
        callbacks.onSessionComplete?.();
        cleanup();
        break;
      case 'error':
        callbacks.onError(new Error(data.content));
        cleanup();
        break;
      // 'start' and 'empathy' are informational — ignore
    }
  };

  const cleanup = () => {
    socket.off('text-stream', handler);
  };

  // Listen for chunks before emitting the request
  socket.on('text-stream', handler);

  // Get the auth token to pass to the socket server
  const token = await authService.getIdToken();

  // Emit the text generation request to the ECS socket server
  socket.emit('text-generation', {
    simulation_group_id: simulationGroupId,
    patient_id: patientId,
    session_id: sessionId,
    message: messageContent,
    token: token || '',
  });

  return cleanup;
}

/**
 * Conclude a student interaction session.
 * Saves the recommendation, marks the session as concluded, and triggers debrief generation.
 * For interview_practice patients, recommendation can be null.
 */
async function concludeInteraction(
  simulationGroupId: string,
  patientId: string,
  sessionId: string,
  recommendation: string | null
): Promise<{ success: boolean; debrief_triggered?: boolean; patient_mode?: string }> {
  try {
    const result = await apiClient.request<{ message: string; chat: any; debrief_triggered: boolean; patient_mode: string }>(
      `student/conclude_interaction?session_id=${encodeURIComponent(sessionId)}&simulation_group_id=${encodeURIComponent(simulationGroupId)}&patient_id=${encodeURIComponent(patientId)}`,
      {
        method: 'POST',
        body: recommendation ? { recommendation } : {},
      }
    );
    return { success: true, debrief_triggered: result.debrief_triggered, patient_mode: result.patient_mode };
  } catch (error) {
    console.error('Failed to conclude interaction:', error);
    return { success: false };
  }
}

async function deleteSession(
  simulationGroupId: string,
  patientId: string,
  sessionId: string
): Promise<boolean> {
  try {
    const user = await authService.getCurrentUser();
    if (!user) throw new Error('Not authenticated');

    await apiClient.request(
      `student/delete_session?session_id=${encodeURIComponent(sessionId)}&simulation_group_id=${encodeURIComponent(simulationGroupId)}&patient_id=${encodeURIComponent(patientId)}`,
      { method: 'DELETE' }
    );
    return true;
  } catch (error) {
    console.error('Failed to delete session:', error);
    return false;
  }
}

/**
 * Fetch the presigned URL for the first answer key file from the API.
 * Returns the URL string or null if no answer key files exist.
 */
async function fetchAnswerKeyUrl(simulationGroupId: string, patientId: string): Promise<string | null> {
  try {
    const data = await apiClient.request<GetAllFilesResponse>(
      `student/get_all_files?simulation_group_id=${encodeURIComponent(simulationGroupId)}&persona_id=${encodeURIComponent(patientId)}&patient_name=patient`
    );

    const answerKeyEntries = Object.values(data.answer_key_files ?? {});
    if (answerKeyEntries.length > 0 && answerKeyEntries[0].url) {
      return answerKeyEntries[0].url;
    }
    return null;
  } catch (error) {
    console.error('Failed to fetch answer key URL:', error);
    return null;
  }
}

/**
 * Fetch the voice_id assigned to a patient (persona) from the API.
 */
async function fetchPatientVoiceId(patientId: string): Promise<string | null> {
  try {
    const data = await apiClient.request<{ voice_id?: string }>(
      `student/patient_voice_id?patient_id=${encodeURIComponent(patientId)}`
    );
    return data.voice_id || null;
  } catch (error) {
    console.warn('[fetchPatientVoiceId] Failed to fetch voice_id:', error);
    return null;
  }
}

/**
 * Submit debrief helpfulness feedback for an AI debrief session.
 * Sends a POST request to the backend to persist the student's feedback.
 */
async function submitDebriefFeedback(
  simulationGroupId: string,
  patientId: string,
  chatId: string,
  isHelpful: boolean,
  comment?: string
): Promise<{ feedback_id: string }> {
  try {
    const result = await apiClient.request<{ feedback_id: string }>(
      'student/debrief_feedback',
      {
        method: 'POST',
        body: {
          simulation_group_id: simulationGroupId,
          persona_id: patientId,
          chat_id: chatId,
          is_helpful: isHelpful,
          ...(comment !== undefined && { comment }),
        },
      }
    );
    return { feedback_id: result.feedback_id };
  } catch (error) {
    console.error('Failed to submit debrief feedback:', error);
    throw new Error('Failed to submit feedback. Please try again.');
  }
}

/**
 * Submit an issue report for a patient simulation.
 * Sends a POST request to the backend to persist the student's issue report.
 */
async function submitIssueReport(
  simulationGroupId: string,
  patientId: string,
  chatId: string,
  issueCategories: string[],
  details?: string
): Promise<{ report_id: string }> {
  try {
    const result = await apiClient.request<{ report_id: string }>(
      'student/issue_report',
      {
        method: 'POST',
        body: {
          simulation_group_id: simulationGroupId,
          persona_id: patientId,
          chat_id: chatId,
          issue_categories: issueCategories,
          ...(details !== undefined && { details }),
        },
      }
    );
    return { report_id: result.report_id };
  } catch (error) {
    console.error('Failed to submit issue report:', error);
    throw new Error('Failed to submit issue report. Please try again.');
  }
}

// ─── Answer Key Debrief Comparison: Interfaces ───────────────────────────────

/**
 * Student DTP submission — array of identified drug therapy problems
 */
export interface DTPSubmission {
  entries: string[];
}

/**
 * A single recommendation/rationale pair submitted by the student
 */
export interface RecommendationSubmissionEntry {
  recommendation: string;
  rationale: string;
}

/**
 * Student recommendation submission — array of recommendation/rationale pairs
 */
export interface RecommendationSubmission {
  entries: RecommendationSubmissionEntry[];
}

/**
 * Per-section score for debrief sections (key questions, DTPs, recommendations)
 */
export interface SectionScore {
  matched: number;
  total: number;
  percentage: number; // 0-100, rounded to nearest integer
}

/**
 * Debrief Chunk 1 — interview summary and key question coverage (available immediately)
 */
export interface DebriefChunk1 {
  summary: string;
  questionsAddressed: string[];
  questionsAddressedCount: number;
  questionsMissed: string[];
  questionsMissedCount: number;
  suggestedRewrites: { original: string; suggested: string }[];
  keyQuestionsScore: SectionScore | null;
  guidanceKeyQuestions: string | null; // Reflective questions for missed KQs
}

/**
 * A single DTP comparison item showing match status
 */
export interface DTPComparisonItem {
  dtpText: string;
  status: 'matched' | 'missed' | 'additional';
  matchedWith?: string;
}

/**
 * A single Recommendation comparison item showing match status
 */
export interface RecommendationComparisonItem {
  recommendationText: string;
  status: 'matched' | 'missed' | 'additional';
  matchedWith?: string;
  rationaleRating?: 'full_credit' | 'partial_credit' | 'no_credit';
  rationaleExplanation?: string;
}

/**
 * Debrief Chunk 2 — DTP comparison and recommendation comparison (available after processing delay)
 */
export interface DebriefChunk2 {
  dtpComparison: {
    overview: string;
    matched: DTPComparisonItem[];
    missed: DTPComparisonItem[]; // Text hidden — only count shown
    additional: DTPComparisonItem[];
    score: SectionScore | null;
    guidance: string | null; // Reflective questions for missed DTPs
  };
  recommendationsComparison: {
    overview: string;
    matched: RecommendationComparisonItem[];
    missed: RecommendationComparisonItem[]; // Text hidden — only count shown
    additional: RecommendationComparisonItem[];
    score: SectionScore | null;
    guidance: string | null; // Reflective questions for missed recs
  };
}

/**
 * Updated debrief data with two-chunk structure
 */
export interface UpdatedDebriefData {
  chunk1: DebriefChunk1;
  chunk2: DebriefChunk2 | null;
  dtpSubmission: string[] | null;
  recommendationSubmission: { recommendation: string; rationale: string }[] | null;
  evaluationIntegrity?: {
    evaluationComplete: boolean;
    degraded: boolean;
    degradedReasons: { component: string; reason: string; impact: string }[];
  };
}

/**
 * Request payload for the updated conclude interaction with submissions
 */
export interface ConcludeInteractionRequest {
  sessionId: string;
  simulationGroupId: string;
  patientId: string;
  dtpSubmission: DTPSubmission;
  recommendationSubmission: RecommendationSubmission;
}

// ─── Answer Key Debrief Comparison: In-Memory Store ──────────────────────────

/** In-memory store for conclude submissions, keyed by sessionId */
const concludeSubmissionsStore = new Map<string, ConcludeInteractionRequest>();

// ─── Conclude With Submissions ───────────────────────────────────────────────
// Two conclude paths exist:
//   1. concludeInteraction() — interview_practice patients, no submissions
//   2. concludeWithSubmissions() — full_assessment patients, sends structured
//      DTPs + recommendations that the debrief Lambda matches against
//      instructor-defined expected items via embedding cosine similarity

/**
 * Conclude an interaction with DTP and Recommendation submissions.
 * Sends submissions to the backend where they are persisted and used for
 * embedding-based matching during debrief generation.
 */
async function concludeWithSubmissions(
  request: ConcludeInteractionRequest
): Promise<{ success: true }> {
  // Keep local store for potential frontend use (e.g., optimistic UI)
  concludeSubmissionsStore.set(request.sessionId, request);

  // Build a combined recommendation text from the structured entries for backward compat
  const recommendationText = request.recommendationSubmission.entries
    .filter((e) => e.recommendation.trim().length > 0)
    .map((e, i) => {
      const recLine = `${i + 1}. ${e.recommendation}`;
      return e.rationale ? `${recLine}\n   Rationale: ${e.rationale}` : recLine;
    })
    .join('\n');

  await apiClient.request<{ message: string; chat: any; debrief_triggered: boolean; patient_mode: string }>(
    `student/conclude_interaction?session_id=${encodeURIComponent(request.sessionId)}&simulation_group_id=${encodeURIComponent(request.simulationGroupId)}&patient_id=${encodeURIComponent(request.patientId)}`,
    {
      method: 'POST',
      body: {
        recommendation: recommendationText,
        dtpSubmission: request.dtpSubmission,
        recommendationSubmission: request.recommendationSubmission,
      },
    }
  );

  return { success: true };
}

/**
 * Fetch the updated two-chunk debrief for a session.
 * Calls the real GET /student/get_debrief endpoint and parses the response
 * into the two-chunk structure:
 *   - chunk1: interview summary + key questions + suggested rewrites (always present)
 *   - chunk2: DTP/Rec comparison (only for full_assessment patients, null otherwise)
 *
 * The same debrief JSON is stored in the DB regardless of patient mode — the
 * presence/absence of dtp_comparison and recommendations_comparison keys
 * determines whether chunk2 is populated or null.
 */
async function fetchUpdatedDebrief(sessionId: string): Promise<UpdatedDebriefData> {
  const user = await authService.getCurrentUser();
  if (!user?.email) throw new Error('Not authenticated');

  const maxAttempts = 8;
  const baseDelayMs = 500;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const data = await apiClient.request<{ generated_text?: any; status?: string; error?: string; dtp_submission?: any; recommendation_submission?: any }>(
      `student/get_debrief?session_id=${encodeURIComponent(sessionId)}`
    );

    if (data?.status === 'generating') {
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    if (!data?.generated_text) {
      throw new Error('No debrief data available');
    }

    let debrief = typeof data.generated_text === 'string'
      ? JSON.parse(data.generated_text)
      : data.generated_text;

    // Parse nested string if double-encoded
    if (typeof debrief === 'string') {
      debrief = JSON.parse(debrief);
    }

    // Build chunk1 from key question data
    const questionsAddressed = (debrief.questions_addressed || []).map(
      (q: string | { question_text?: string }) =>
        typeof q === 'string' ? q : (q.question_text || 'Unknown question')
    );
    const questionsMissed = (debrief.questions_missed || []).map(
      (q: string | { question_text?: string }) =>
        typeof q === 'string' ? q : (q.question_text || 'Unknown question')
    );

    // Parse section scores from debrief JSON
    const sectionScores = debrief.section_scores || {};
    const guidanceData = debrief.guidance || {};

    const chunk1: DebriefChunk1 = {
      summary: typeof debrief.summary === 'string' ? debrief.summary : '',
      questionsAddressed,
      questionsAddressedCount: questionsAddressed.length,
      questionsMissed,
      questionsMissedCount: questionsMissed.length,
      suggestedRewrites: (debrief.suggested_rewrites || []).map(
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

    // Build chunk2 from DTP/Rec comparison data (null if not present)
    let chunk2: DebriefChunk2 | null = null;

    if (debrief.dtp_comparison || debrief.recommendations_comparison) {
      const dtpRaw = debrief.dtp_comparison || { matched: [], missed: [], additional: [] };
      const recRaw = debrief.recommendations_comparison || { matched: [], missed: [], additional: [] };

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
            ? {
                matched: sectionScores.dtps.matched,
                total: sectionScores.dtps.total,
                percentage: sectionScores.dtps.percentage,
              }
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
            ? {
                matched: sectionScores.recommendations.matched,
                total: sectionScores.recommendations.total,
                percentage: sectionScores.recommendations.percentage,
              }
            : null,
          guidance: guidanceData.recommendations || null,
        },
      };
    }

    const dtpSubmission = Array.isArray(data.dtp_submission) ? data.dtp_submission : null;
    const recommendationSubmission = Array.isArray(data.recommendation_submission) ? data.recommendation_submission : null;

    // Map evaluation integrity metadata
    const evaluationIntegrity = debrief.evaluation_integrity ? {
      evaluationComplete: debrief.evaluation_integrity.evaluation_complete ?? true,
      degraded: debrief.evaluation_integrity.degraded ?? false,
      degradedReasons: (debrief.evaluation_integrity.degraded_reasons || []).map(
        (r: { component?: string; reason?: string; impact?: string }) => ({
          component: r.component || '',
          reason: r.reason || '',
          impact: r.impact || '',
        })
      ),
    } : undefined;

    return { chunk1, chunk2, dtpSubmission, recommendationSubmission, evaluationIntegrity };
  }

  throw new Error('Debrief generation timed out');
}

/**
 * Test helper — resets the in-memory conclude submissions store.
 * Only intended for use in tests.
 */
export function _resetConcludeStore(): void {
  concludeSubmissionsStore.clear();
}

/**
 * Student service — public API used by pages
 */
export const studentService = {
  getSimulationGroups,
  getCurrentUser,
  getPatients,
  joinGroup,
  createSession,
  deleteSession,
  concludeInteraction,
  concludeWithSubmissions,
  fetchUpdatedDebrief,
  sendMessage,
  sendMessageStreaming,
  getPatientDetail,
  getCaseMaterials,
  getPatientFiles,
  getChatHistory,
  getKeyQuestionsCoverageData,
  getAIDebriefData,
  getAssessmentActivities,
  getChatHistoryMessages,
  getSavedNote,
  fetchPatientDetail,
  fetchPatientFiles,
  fetchCaseMaterials,
  fetchChatHistory,
  fetchMessages,
  fetchAnswerKeyUrl,
  fetchDebrief,
  fetchPersonaMedia,
  fetchNotes,
  updateNotes,
  fetchPatientVoiceId,
  submitDebriefFeedback,
  submitIssueReport,
};



