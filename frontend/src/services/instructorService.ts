/**
 * Instructor Service
 * 
 * Calls real backend API endpoints via API Gateway.
 * Falls back to mock data if API calls fail (for local dev without backend).
 * 
 * DATABASE SCHEMA ALIGNMENT:
 * - Physical Assessment Materials: persona_media table (media_id, persona_id, media_type, url, title, description, created_at)
 * - Chat Attempts: chats table (chat_id, student_interaction_id, chat_name, chat_context_embeddings, last_accessed, notes)
 * - Chat Messages: messages table (message_id, chat_id, user_id, sender_type, message_content, sent_at)
 * - Notes: chats.notes field (text field in chats table)
 * - Key Questions: key_questions table (question_id, rubric_id, question_text, category, order, weight, max_score)
 * - Student Interactions: Links students to personas via student_interaction table
 */

import { getSimulationGroupColor } from '@/lib/colors';
import { apiClient } from '@/lib/api-client';
import { authService } from '@/lib/auth';
import { mockAdminDataService } from '@/services/adminService';
import { mapBackendToQuestionBankItem } from '@/services/adminApiService';
import { type AIDebriefData, type UpdatedDebriefData } from '@/services/studentService';
import { deepParseJson, extractDebriefFromRawJson } from '@/lib/debrief-parser';

/**
 * Represents a simulation group from instructor perspective
 */
export interface InstructorSimulationGroup {
  simulation_group_id: string; // Unique identifier
  group_name: string;            // Group name (e.g., "Pregnancy")
  subtitle: string;        // Always "Medical Simulation Group"
  icon_url?: string;        // Optional icon image URL
  icon_color?: string;      // Fallback color for avatar (hex format)
  group_access_code: string;      // Access code for students to join
  student_count: number;    // Number of students in the group
  instructor_count?: number; // Number of instructors in the group
  persona_count: number;    // Number of patients in the group
  organization_id: string;  // Reference to parent organization
}

/**
 * Represents current user data
 */
export interface UserData {
  name: string;            // User's full name
  avatarUrl?: string;      // Optional profile picture URL
}

/**
 * Represents organization-specific labels for UI display
 */
export interface OrganizationLabels {
  aiPersona: string;              // Singular form (e.g., "Patient", "Law Client")
  aiPersonaPlural: string;        // Plural form (e.g., "Patients", "Law Clients")
  aiPersonaLower: string;         // Lowercase singular (e.g., "patient")
  aiPersonaPluralLower: string;   // Lowercase plural (e.g., "patients")
  userRole: string;               // Singular form (e.g., "Doctor", "Legal Advisor")
  userRolePlural: string;         // Plural form (e.g., "Doctors", "Legal Advisors")
  userRoleLower: string;          // Lowercase singular (e.g., "doctor")
  userRolePluralLower: string;    // Lowercase plural (e.g., "doctors")
}

/**
 * Represents a patient in a simulation group with analytics
 */
export interface PatientAnalytics {
  patient_id: string;                   // Unique identifier
  patient_name: string;                 // Patient name
  instructor_completion_percentage: number; // 0-100
  llm_completion_percentage: number;    // 0-100
  student_message_count: number;        // Number of messages from students
  ai_message_count: number;             // Number of AI responses
  student_access_count: number;         // Number of times students accessed
}

/**
 * Represents message count data for charts
 */
export interface MessageCountData {
  name: string;                         // Label (e.g., "Messages")
  'Student Messages': number;           // Student message count
  'AI Messages': number;                // AI message count
}

/**
 * Represents key question analytics data for charts
 */
export interface KeyQuestionAnalytics {
  questionTitle: string;                // Title of the key question
  studentsAnswered: number;             // Number of students who answered
}

/**
 * Represents average quality score per key question
 */
export interface QuestionPerformanceScore {
  questionTitle: string;                // Title of the key question
  averageScore: number;                 // Average quality score (0-100)
  totalResponses: number;               // Total number of student responses
}

/**
 * Represents per-patient key question coverage for debriefed students
 */
export interface KeyQuestionCoverage {
  patientName: string;                  // Patient/persona name
  avgCoverage: number;                  // Average % of key questions covered (0-100)
  studentsDebriefed: number;            // Number of students who reached debrief
}

/**
 * Represents per-patient DTP coverage for debriefed students
 */
export interface DTPCoverage {
  personaId: string;                    // Persona identifier
  personaName: string;                  // Persona name
  avgCoverage: number;                  // Average % of DTPs covered (0-100)
  studentsDebriefed: number;            // Number of students who reached debrief
}

/**
 * Represents per-patient recommendation coverage for debriefed students
 */
export interface RecommendationCoverage {
  personaId: string;                    // Persona identifier
  personaName: string;                  // Persona name
  avgCoverage: number;                  // Average % of recommendations covered (0-100)
  studentsDebriefed: number;            // Number of students who reached debrief
}

/**
 * Represents per-DTP student match analytics
 */
export interface DTPAnalytics {
  dtpId: string;                        // DTP bank item identifier
  title: string;                        // DTP title from bank
  studentsMatched: number;              // Number of distinct students who matched
}

/**
 * Represents per-recommendation student match analytics
 */
export interface RecommendationAnalytics {
  recommendationId: string;             // Recommendation bank item identifier
  title: string;                        // Recommendation title from bank
  studentsMatched: number;              // Number of distinct students who matched
}

// For Patient Specific Student Progress Status - how many students have not started vs. in progress vs. reached debrief.
export interface StudentProgressStatus {
  status: 'Not Started' | 'In Progress' | 'Debrief Reached';
  students: Array<{ id: string; name: string }>;
}

export interface StudentProgressData {
  status: string;
  count: number;
  students: Array<{ id: string; name: string }>;
  fill: string;
}

/**
 * Represents a bucket in a score distribution histogram
 */
export interface ScoreDistributionBucket {
  range: string;                        // Score range label (e.g., "0-20")
  count: number;                        // Number of students in this range
}

/**
 * Represents a completed chat session for the prompt playground session picker
 */
export interface CompletedSession {
  chatId: string;           // chat_id from chats table
  studentName: string;      // first_name + last_name from users table
  personaName: string;      // persona_name from personas table
  personaId: string;        // persona_id from personas table
  lastAccessed: string;     // ISO timestamp from chats.last_accessed
}

/**
 * Represents a patient for management (maps to personas table in DB)
 */
export interface ManageablePatient {
  patient_id: string;                   // Unique identifier (persona_id in DB)
  simulation_group_id: string;          // Reference to simulation group (simulation_group_id in DB)
  patient_name: string;                 // Patient name (persona_name in DB)
  patient_age: number;                  // Patient age (persona_age in DB)
  patient_gender: string;               // Patient gender (persona_gender in DB)
  patient_number?: number;              // Patient number (persona_number in DB)
  patient_prompt: string;               // Patient prompt for LLM (persona_prompt in DB)
  voice_persona_prompt?: string;         // Voice-specific prompt, falls back to persona_prompt if null (voice_persona_prompt in DB)
  average_wpm?: number;                 // Average words per minute (average_wpm in DB)
  voice_id?: string;                    // Voice ID for TTS (voice_id in DB)
  voice_enabled?: boolean;              // Whether voice mode is enabled for this patient (voice_enabled in DB)
  interaction_mode?: string;            // Interaction mode (interaction_mode in DB)
  llm_completion: boolean;              // Whether LLM evaluation is enabled (derived from settings)
  photo_url?: string;                   // Optional patient photo URL (stored separately or in media)
  mode?: 'interview_practice' | 'full_assessment' | 'conversation_only'; // Derived from Key Questions/DTP/Recommendation assignments
}

/**
 * Represents a global rubric question (maps to key_questions table in DB)
 */
export interface GlobalRubricQuestion {
  id: string;                           // Unique identifier (question_id in DB)
  group_question_id?: string;           // Assignment ID (group_question_id in simulation_group_questions)
  rubric_id?: string;                   // Reference to rubric (rubric_id in DB, null for global)
  title: string;                        // Question title (derived from question_text)
  keyQuestion: string;                  // The key question text (question_text in DB)
  clinicalIntent: string;               // Clinical intent description (stored in category or separate field)
  evaluationCriteria: string;           // Evaluation criteria (stored in separate field)
  required: boolean;                    // Whether required for case completion
  order?: number;                       // Display order (order field in DB)
  weight?: number;                      // Question weight (weight field in DB)
  max_score?: number;                   // Maximum score (max_score field in DB)
}

/**
 * Represents a case material (maps to persona_media table in DB)
 */
export interface CaseMaterial {
  id: string;                           // Unique identifier (media_id in DB)
  title: string;                        // Material title
  description: string;                  // Material description
  materialType: 'kaltura' | 'panopto' | 'h5p'; // Embed provider type (media_type in DB)
  contentUrl?: string;                  // URL to uploaded content (url in DB)
  embedLink?: string;                   // Embed URL (stored in url field)
}

/**
 * Represents a student in a simulation group
 */
export interface Student {
  id: string;                           // Unique identifier
  name: string;                         // Student name
  email: string;                        // Student email
}

/**
 * Represents student details with performance metrics
 */
export interface StudentDetails {
  id: string;                           // Unique identifier
  name: string;                         // Student name
  email: string;                        // Student email
  groupName: string;                    // Simulation group name
  casesAttempted: number;               // Number of cases attempted
  caseCompletionRate: number;           // Completion rate percentage (0-100)
}

/**
 * Represents a chat attempt for a patient (maps to chats table in DB)
 */
export interface RecommendationSubmissionEntry {
  recommendation: string;
  rationale: string;
}

export interface ChatAttempt {
  id: string;                           // Unique identifier (chat_id in DB)
  student_interaction_id: string;       // Reference to student interaction (student_interaction_id in DB)
  attemptNumber: number;                // Attempt number (derived from ordering)
  date: string;                         // Date of attempt (derived from last_accessed in DB)
  completionStatus: 'In Progress' | 'Debrief Reached'; // Status (derived from completion state)
  score: number | null;                 // Score percentage (null if in progress)
  notes?: string;                       // Notes text (notes field in DB)
  dtpSubmission?: string[] | null;      // Student-submitted DTPs (dtp_submission in DB)
  recommendationSubmission?: RecommendationSubmissionEntry[] | null; // Student-submitted recommendations (recommendation_submission in DB)
}

/**
 * Represents a chat message (maps to messages table in DB)
 */
export interface ChatMessage {
  message_id: string;                   // Unique identifier (message_id in DB)
  chat_id: string;                      // Reference to chat (chat_id in DB)
  sender_type: 'student' | 'ai' | 'system'; // Who sent the message (sender_type in DB)
  message_content: string;             // Message text (message_content in DB)
  sent_at: string;                      // Timestamp (sent_at in DB)
}

/**
 * Represents notes for a chat attempt (stored in chats.notes field in DB)
 */
export interface ChatNotes {
  attemptId: string;                    // Chat attempt ID (chat_id in DB)
  notes: string;                        // Notes text (notes field in chats table)
}

/**
 * Represents the full patient data for a student, fetched from student_patients_messages.
 * Keys are patient names, values are arrays of chat attempts with messages and notes.
 */
export interface StudentPatientData {
  patientNames: string[];
  attempts: Record<string, ChatAttempt[]>;
  messages: Record<string, ChatMessage[]>;
  notes: Record<string, string>;
  dtpSubmissions: Record<string, string[] | null>;
  recommendationSubmissions: Record<string, RecommendationSubmissionEntry[] | null>;
}

/**
 * Represents patient creation data
 */
export interface PatientCreateData {
  patient_name: string;                 // persona_name
  patient_age: number;                  // persona_age
  patient_gender: string;               // persona_gender
  patient_prompt: string;               // persona_prompt
  voice_persona_prompt?: string;        // voice_persona_prompt (optional, falls back to persona_prompt)
  patient_number?: number;              // persona_number (optional)
  average_wpm?: number;                 // average_wpm (optional)
  voice_id?: string;                    // voice_id (optional)
  interaction_mode?: string;            // interaction_mode (optional)
}

/**
 * Represents patient update data
 */
export interface PatientUpdateData {
  patient_id: string;                   // persona_id
  patient_name: string;                 // persona_name
  patient_age: number;                  // persona_age
  patient_gender: string;               // persona_gender
  patient_prompt: string;               // persona_prompt
  voice_persona_prompt?: string;        // voice_persona_prompt (optional, falls back to persona_prompt)
  photo_url?: string;                   // Photo URL (stored separately)
  patient_number?: number;              // persona_number (optional)
  average_wpm?: number;                 // average_wpm (optional)
  voice_id?: string;                    // voice_id (optional)
  voice_enabled?: boolean;              // voice_enabled (optional)
  interaction_mode?: string;            // interaction_mode (optional)
  llm_upload_file?: File;               // File upload for LLM
  patient_info_file?: File;             // File upload for patient info
  answer_key_file?: File;               // File upload for answer key
}

/**
 * Question Bank Item - represents a question in the question bank
 * Maps to: question_bank table in DB
 */
export interface QuestionBankItem {
  id: string;                           // question_id
  title: string;                        // title
  questionText: string;                 // question_text (the key question)
  clinicalIntent: string;               // clinical_intent
  evaluationCriteria: string;           // evaluation_criteria
  category?: string;                    // category
  difficultyLevel?: string;             // difficulty_level
  isMandatory: boolean;                 // is_mandatory (maps to 'required' in UI)
  weight?: number;                      // weight
  maxScore?: number;                    // max_score
  isActive: boolean;                    // is_active
  tags: string[];                       // tags (e.g. ['patient_specific', 'Health', 'Physio'])
  usedBySimulationGroups: string[];     // Track which simulation groups are using this question
  usedByPatients?: string[];            // Track which patients are using this question (for patient-specific questions)
}

/**
 * Instructor data service interface
 */
export interface InstructorDataService {
  getSimulationGroups: () => Promise<InstructorSimulationGroup[]>;
  createSimulationGroup: (data: { name: string; description: string; active: boolean }) => Promise<InstructorSimulationGroup>;
  getCurrentUser: () => Promise<UserData>;
  getSimulationGroup: (id: string) => Promise<InstructorSimulationGroup | undefined>;
  getOrganizationLabels: (simulationGroupId: string) => OrganizationLabels;
  getPatientAnalytics: (simulationGroupId: string, startDate?: string, endDate?: string) => Promise<PatientAnalytics[]>;
  getMessageCountData: (patientId: string) => MessageCountData[];
  generateAccessCode: (simulationGroupId: string) => Promise<string>;
  getManageablePatients: (simulationGroupId: string) => Promise<ManageablePatient[]>;
  getPatient: (patientId: string) => ManageablePatient | undefined;
  createPatient: (simulationGroupId: string, patientData: PatientCreateData) => Promise<string>;
  updatePatient: (simulationGroupId: string, patientData: PatientUpdateData) => Promise<void>;
  uploadPatientPhoto: (simulationGroupId: string, patientId: string, photoFile: File) => Promise<string>;
  deletePatientPhoto: (simulationGroupId: string, patientId: string) => Promise<void>;
  fetchProfilePictures: (simulationGroupId: string) => Promise<Record<string, string>>;
  uploadPatientFile: (simulationGroupId: string, patientId: string, file: File, folderType: 'documents' | 'info' | 'answer_key') => Promise<void>;
  deletePatientFile: (simulationGroupId: string, patientId: string, fileName: string, fileType: string, folderType: 'documents' | 'info' | 'answer_key') => Promise<void>;
  fetchPatientUploadedFiles: (simulationGroupId: string, patientId: string) => Promise<{ files: Record<'llm' | 'patientInfo' | 'answerKey', import('@/services/instructorService').UploadedFileInfo[]>; profilePictureUrl: string | null }>;
  getIngestionStatus: (simulationGroupId: string, patientId: string) => Promise<import('@/services/instructorService').IngestionStatusByFolder>;
  updateFileDisplayName: (patientId: string, filename: string, filetype: string, displayName: string) => Promise<void>;
  updatePatientLLMEvaluation: (patientId: string, enabled: boolean) => Promise<void>;
  updatePatientVoiceEnabled: (patientId: string, simulationGroupId: string, enabled: boolean) => Promise<void>;
  deletePatient: (patientId: string) => Promise<void>;
  getGlobalRubricQuestions: (simulationGroupId: string) => GlobalRubricQuestion[];
  addGlobalRubricQuestion: (simulationGroupId: string, question: GlobalRubricQuestion) => void;
  updateGlobalRubricQuestion: (simulationGroupId: string, question: GlobalRubricQuestion) => Promise<any>;
  deleteGlobalRubricQuestion: (simulationGroupId: string, questionId: string) => void;
  getCaseSpecificQuestions: (patientId: string) => GlobalRubricQuestion[];
  addCaseSpecificQuestion: (patientId: string, question: GlobalRubricQuestion) => void;
  updateCaseSpecificQuestion: (patientId: string, question: GlobalRubricQuestion) => void;
  deleteCaseSpecificQuestion: (patientId: string, questionId: string) => void;
  getCaseMaterials: (patientId: string) => Promise<CaseMaterial[]>;
  addCaseMaterial: (patientId: string, material: CaseMaterial) => Promise<CaseMaterial>;
  updateCaseMaterial: (patientId: string, material: CaseMaterial) => Promise<CaseMaterial>;
  deleteCaseMaterial: (patientId: string, materialId: string) => Promise<void>;
  getEvaluationPrompt: (simulationGroupId: string) => Promise<string>;
  getDebriefPrompt: (simulationGroupId: string) => Promise<string>;
  updateSystemPrompt: (simulationGroupId: string, instructorEmail: string, prompt: string) => Promise<void>;
  updateDebriefPrompt: (simulationGroupId: string, instructorEmail: string, prompt: string) => Promise<void>;
  getDefaultDebriefPrompt: () => Promise<string>;
  getDefaultSystemPrompt: () => Promise<string>;
  getDefaultPersonaPrompt: () => Promise<string>;
  getPromptHistory: (simulationGroupId: string, type: 'system' | 'debrief') => Promise<PromptHistoryEntry[]>;
  getStudents: (simulationGroupId: string) => Promise<Student[]>;
  getStudentDetails: (studentId: string, simulationGroupId: string, groupName?: string) => Promise<StudentDetails | undefined>;
  getStudentPatientData: (studentEmail: string, simulationGroupId: string) => Promise<StudentPatientData>;
  getChatAttempts: (studentId: string, patientId: string) => ChatAttempt[];
  getChatMessages: (attemptId: string) => ChatMessage[];
  getChatNotes: (attemptId: string) => string;
  getDefaultPatientPrompt: () => string;
  getGlobalQuestionBank: () => Promise<QuestionBankItem[]>;
  createQuestionBankQuestion: (organizationId: string, data: { title: string; question_text: string; clinical_intent?: string; evaluation_criteria: string; category?: string; difficulty_level?: string; is_mandatory?: boolean; weight?: number; max_score?: number; tags?: string[] }) => Promise<QuestionBankItem>;
  updateQuestionBankQuestion: (questionId: string, data: { title?: string; question_text?: string; clinical_intent?: string; evaluation_criteria?: string; is_mandatory?: boolean; tags?: string[] }) => Promise<QuestionBankItem>;
  getPatientSpecificQuestionBank: () => QuestionBankItem[];
  addToGlobalQuestionBank: (question: QuestionBankItem) => void;
  addToPatientSpecificQuestionBank: (question: QuestionBankItem) => void;
  getPatientCaseSpecificQuestionIds: (patientId: string) => Set<string>;
  updatePatientCaseSpecificQuestions: (patientId: string, questionIds: Set<string>) => void;
  getSimulationGroupsUsingQuestion: (questionId: string, questionType?: 'global' | 'patientSpecific') => string[];
  getPatientsUsingQuestion: (questionId: string) => string[];
  isQuestionInUse: (questionId: string, questionType?: 'global' | 'patientSpecific') => boolean;
  getKeyQuestionAnalytics: (simulationGroupId: string) => Promise<KeyQuestionAnalytics[]>;
  getKeyQuestionCoverage: (simulationGroupId: string, startDate?: string, endDate?: string) => Promise<KeyQuestionCoverage[]>;
  getPatientKeyQuestionAnalytics: (simulationGroupId: string, personaId: string, startDate?: string, endDate?: string) => Promise<KeyQuestionAnalytics[]>;
  getDTPCoverage: (simulationGroupId: string, startDate?: string, endDate?: string) => Promise<DTPCoverage[]>;
  getRecommendationCoverage: (simulationGroupId: string, startDate?: string, endDate?: string) => Promise<RecommendationCoverage[]>;
  getPatientDTPAnalytics: (simulationGroupId: string, personaId: string, startDate?: string, endDate?: string) => Promise<DTPAnalytics[]>;
  getPatientRecommendationAnalytics: (simulationGroupId: string, personaId: string, startDate?: string, endDate?: string) => Promise<RecommendationAnalytics[]>;
  getQuestionPerformanceScores: (simulationGroupId: string) => QuestionPerformanceScore[];
  getScoreDistribution: (simulationGroupId: string, patientId: string) => ScoreDistributionBucket[];
  getSimulationGroupQuestions: (simulationGroupId: string, personaId?: string) => Promise<any[]>;
  assignQuestionToGroup: (simulationGroupId: string, questionIds: string | string[], personaId?: string, options?: { weight_override?: number; max_score_override?: number; order?: number }) => Promise<any>;
  unassignQuestion: (groupQuestionId: string) => Promise<any>;
  updateQuestionAssignment: (groupQuestionId: string, updates: any) => Promise<any>;
  fetchDebrief: (sessionId: string, simulationGroupId: string) => Promise<{ legacy: AIDebriefData; updated: UpdatedDebriefData } | null>;
  getStudentProgress: (simulationGroupId: string, personaId: string, startDate?: string, endDate?: string) => Promise<StudentProgressData[]>;
  getCompletedSessions: (simulationGroupId: string) => Promise<CompletedSession[]>;
  runTestDebrief: (params: { simulationGroupId: string; sessionId: string; personaId: string; debriefPrompt: string }) => Promise<AIDebriefData>;
  runTestChat: (params: { simulationGroupId: string; sessionId: string; personaId: string; systemPrompt: string; messageContent: string; patientPrompt?: string }) => Promise<{ llm_output: string }>;
}



/**
 * Get simulation groups for the current instructor
 */
async function getSimulationGroups(): Promise<InstructorSimulationGroup[]> {
  try {
    const user = await authService.getCurrentUser();
    if (!user?.email) throw new Error('Not authenticated');

    const data = await apiClient.request<any[]>(
      `instructor/groups`
    );

    return data.map((group, index) => ({
      simulation_group_id: group.simulation_group_id,
      group_name: group.group_name,
      subtitle: 'Medical Simulation Group',
      icon_color: group.icon_color || getSimulationGroupColor(index),
      group_access_code: group.group_access_code || '',
      student_count: group.student_count || 0,
      instructor_count: group.instructor_count || 0,
      persona_count: group.persona_count || 0,
      organization_id: group.organization_id || '',
    }));
  } catch (error) {
    console.error('Failed to fetch instructor groups:', error);
    throw new Error('Failed to load simulation groups. Please try again.');
  }
}

/**
 * Create a new simulation group
 */
async function createSimulationGroup(data: { name: string; description: string; active: boolean }): Promise<InstructorSimulationGroup> {
  const user = await authService.getCurrentUser();
  if (!user?.email) throw new Error('Not authenticated');

  const result = await apiClient.request<any>(
    `instructor/create_simulation_group`,
    {
      method: 'POST',
      body: {
        group_name: data.name,
        group_description: data.description,
        group_student_access: data.active,
      },
    }
  );

  return {
    simulation_group_id: result.simulation_group_id,
    group_name: result.group_name,
    subtitle: 'Medical Simulation Group',
    icon_color: getSimulationGroupColor(0),
    group_access_code: result.group_access_code || '',
    student_count: 0,
    persona_count: 0,
    organization_id: result.organization_id || '',
  };
}

// In-memory data structures for questions (populated via API or add functions)
const globalRubricQuestions: Record<string, GlobalRubricQuestion[]> = {};
const caseSpecificQuestions: Record<string, GlobalRubricQuestion[]> = {};

/**
 * Get current instructor user data
 */
async function getCurrentUser(): Promise<UserData> {
  try {
    const user = await authService.getCurrentUser();
    if (!user?.email) throw new Error('Not authenticated');

    const data = await apiClient.request<{ name: string }>(
      `student/get_name`
    );

    return {
      name: data.name || user.email,
      avatarUrl: undefined,
    };
  } catch (error) {
    console.error('Failed to fetch user name:', error);
    throw new Error('Failed to load user data. Please try again.');
  }
}

/**
 * Get a specific simulation group by ID
 */
async function getSimulationGroup(id: string): Promise<InstructorSimulationGroup | undefined> {
  try {
    const groups = await getSimulationGroups();
    return groups.find(group => group.simulation_group_id === id);
  } catch (error) {
    console.error('Failed to fetch simulation group:', error);
    return undefined;
  }
}

/**
 * Get organization-specific labels for UI display
 */
function getOrganizationLabels(_simulationGroupId: string): OrganizationLabels {
  const organizations = mockAdminDataService.getOrganizations();
  const organization = organizations.length > 0 ? organizations[0] : undefined;

  const aiPersona = organization?.ai_persona || 'Patient';
  const userRole = organization?.user_role || 'Doctor';

  return {
    aiPersona,
    aiPersonaPlural: `${aiPersona}s`,
    aiPersonaLower: aiPersona.toLowerCase(),
    aiPersonaPluralLower: `${aiPersona}s`.toLowerCase(),
    userRole,
    userRolePlural: `${userRole}s`,
    userRoleLower: userRole.toLowerCase(),
    userRolePluralLower: `${userRole}s`.toLowerCase(),
  };
}

/**
 * Get patient analytics for a simulation group
 */
async function getPatientAnalytics(
  simulationGroupId: string,
  startDate: string = '',
  endDate: string = ''
): Promise<PatientAnalytics[]> {
  try {
    let url = `instructor/analytics?simulation_group_id=${encodeURIComponent(simulationGroupId)}`;
    if (startDate) url += `&start_date=${encodeURIComponent(startDate)}`;
    if (endDate) url += `&end_date=${encodeURIComponent(endDate)}`;

    const data = await apiClient.request<any[]>(url);

    return data.map((patient: any) => ({
      patient_id: patient.persona_id,
      patient_name: patient.persona_name,
      instructor_completion_percentage: Number(patient.instructor_completion_percentage) || 0,
      llm_completion_percentage: Number(patient.ai_score_percentage) || 0,
      student_message_count: Number(patient.student_message_count) || 0,
      ai_message_count: Number(patient.ai_message_count) || 0,
      student_access_count: Number(patient.access_count) || 0,
    }));
  } catch (error) {
    console.error('Failed to fetch patient analytics:', error);
    throw new Error('Failed to load patient analytics. Please try again.');
  }
}

/**
 * Get message count data for charts
 */
function getMessageCountData(_patientId: string): MessageCountData[] {
  return [];
}

/**
 * Get key question analytics data for charts
 * Returns data showing how many students answered each key question
 *
 * FIX: Changed from async to sync to match InstructorDataService interface.
 */
async function getKeyQuestionAnalytics(simulationGroupId: string): Promise<KeyQuestionAnalytics[]> {
  try {
    const [questions, interactions] = await Promise.all([
      getSimulationGroupQuestions(simulationGroupId),
      apiClient.request<any[]>(
        `instructor/question_interactions?simulation_group_id=${encodeURIComponent(simulationGroupId)}`,
        { method: 'GET' }
      ),
    ]);

    if (!questions || questions.length === 0) return [];

    return questions.map((q: any) => {
      const questionId = q.question_id;
      const studentIds = new Set(
        (interactions || [])
          .filter((i: any) => i.question_id === questionId && (i.was_asked || i.is_correct != null))
          .map((i: any) => i.student_id)
      );
      return {
        questionTitle: (q.title || q.question_text || '').length > 30
          ? (q.title || q.question_text || '').substring(0, 27) + '...'
          : (q.title || q.question_text || ''),
        studentsAnswered: studentIds.size,
      };
    });
  } catch (error) {
    console.error('Failed to fetch key question analytics:', error);
    return [];
  }
}

/**
 * Get per-patient key question coverage for students who reached debrief
 */
async function getKeyQuestionCoverage(simulationGroupId: string, startDate: string = '', endDate: string = ''): Promise<KeyQuestionCoverage[]> {
  try {
    let url = `instructor/key_question_coverage?simulation_group_id=${encodeURIComponent(simulationGroupId)}`;
    if (startDate) url += `&start_date=${encodeURIComponent(startDate)}`;
    if (endDate) url += `&end_date=${encodeURIComponent(endDate)}`;

    const data = await apiClient.request<any[]>(url, { method: 'GET' });
    return data.map((row: any) => ({
      patientName: (row.persona_name || '').length > 30
        ? row.persona_name.substring(0, 27) + '...'
        : (row.persona_name || ''),
      avgCoverage: Math.round(Number(row.avg_coverage) || 0),
      studentsDebriefed: Number(row.students_debriefed) || 0,
    }));
  } catch (error) {
    console.error('Failed to fetch key question coverage:', error);
    return [];
  }
}

/**
 * Get per-question student-asked counts for a specific patient.
 * Uses COUNT(DISTINCT student_id) so multiple attempts by the same student count once.
 */
async function getPatientKeyQuestionAnalytics(simulationGroupId: string, personaId: string, startDate: string = '', endDate: string = ''): Promise<KeyQuestionAnalytics[]> {
  try {
    let url = `instructor/patient_key_question_analytics?simulation_group_id=${encodeURIComponent(simulationGroupId)}&persona_id=${encodeURIComponent(personaId)}`;
    if (startDate) url += `&start_date=${encodeURIComponent(startDate)}`;
    if (endDate) url += `&end_date=${encodeURIComponent(endDate)}`;

    const data = await apiClient.request<any[]>(url, { method: 'GET' });
    return data.map((row: any) => ({
      questionTitle: (row.question_title || '').length > 30
        ? row.question_title.substring(0, 27) + '...'
        : (row.question_title || ''),
      studentsAnswered: Number(row.students_answered) || 0,
    }));
  } catch (error) {
    console.error('Failed to fetch patient key question analytics:', error);
    return [];
  }
}

/**
 * Get DTP coverage per persona for a simulation group
 * Returns average DTP coverage percentage and students debriefed per persona
 */
async function getDTPCoverage(simulationGroupId: string, startDate: string = '', endDate: string = ''): Promise<DTPCoverage[]> {
  try {
    let url = `instructor/dtp_coverage?simulation_group_id=${encodeURIComponent(simulationGroupId)}`;
    if (startDate) url += `&start_date=${encodeURIComponent(startDate)}`;
    if (endDate) url += `&end_date=${encodeURIComponent(endDate)}`;

    const data = await apiClient.request<any[]>(url, { method: 'GET' });
    return data.map((row: any) => ({
      personaId: row.persona_id || '',
      personaName: (row.persona_name || '').length > 30
        ? row.persona_name.substring(0, 27) + '...'
        : (row.persona_name || ''),
      avgCoverage: Math.round(Number(row.avg_dtp_coverage) || 0),
      studentsDebriefed: Number(row.students_debriefed) || 0,
    }));
  } catch (error) {
    console.error('Failed to fetch DTP coverage:', error);
    return [];
  }
}

/**
 * Get recommendation coverage per persona for a simulation group
 * Returns average recommendation coverage percentage and students debriefed per persona
 */
async function getRecommendationCoverage(simulationGroupId: string, startDate: string = '', endDate: string = ''): Promise<RecommendationCoverage[]> {
  try {
    let url = `instructor/recommendation_coverage?simulation_group_id=${encodeURIComponent(simulationGroupId)}`;
    if (startDate) url += `&start_date=${encodeURIComponent(startDate)}`;
    if (endDate) url += `&end_date=${encodeURIComponent(endDate)}`;

    const data = await apiClient.request<any[]>(url, { method: 'GET' });
    return data.map((row: any) => ({
      personaId: row.persona_id || '',
      personaName: (row.persona_name || '').length > 30
        ? row.persona_name.substring(0, 27) + '...'
        : (row.persona_name || ''),
      avgCoverage: Math.round(Number(row.avg_recommendation_coverage) || 0),
      studentsDebriefed: Number(row.students_debriefed) || 0,
    }));
  } catch (error) {
    console.error('Failed to fetch recommendation coverage:', error);
    return [];
  }
}

/**
 * Get per-patient DTP analytics - count of distinct students who matched each DTP
 */
async function getPatientDTPAnalytics(simulationGroupId: string, personaId: string, startDate: string = '', endDate: string = ''): Promise<DTPAnalytics[]> {
  try {
    let url = `instructor/patient_dtp_analytics?simulation_group_id=${encodeURIComponent(simulationGroupId)}&persona_id=${encodeURIComponent(personaId)}`;
    if (startDate) url += `&start_date=${encodeURIComponent(startDate)}`;
    if (endDate) url += `&end_date=${encodeURIComponent(endDate)}`;

    const data = await apiClient.request<any[]>(url, { method: 'GET' });
    return data.map((row: any) => ({
      dtpId: row.dtp_id || '',
      title: (row.title || '').length > 30
        ? row.title.substring(0, 27) + '...'
        : (row.title || ''),
      studentsMatched: Number(row.students_matched) || 0,
    }));
  } catch (error) {
    console.error('Failed to fetch patient DTP analytics:', error);
    return [];
  }
}

/**
 * Get per-patient recommendation analytics - count of distinct students who matched each recommendation
 */
async function getPatientRecommendationAnalytics(simulationGroupId: string, personaId: string, startDate: string = '', endDate: string = ''): Promise<RecommendationAnalytics[]> {
  try {
    let url = `instructor/patient_recommendation_analytics?simulation_group_id=${encodeURIComponent(simulationGroupId)}&persona_id=${encodeURIComponent(personaId)}`;
    if (startDate) url += `&start_date=${encodeURIComponent(startDate)}`;
    if (endDate) url += `&end_date=${encodeURIComponent(endDate)}`;

    const data = await apiClient.request<any[]>(url, { method: 'GET' });
    return data.map((row: any) => ({
      recommendationId: row.recommendation_id || '',
      title: (row.title || '').length > 30
        ? row.title.substring(0, 27) + '...'
        : (row.title || ''),
      studentsMatched: Number(row.students_matched) || 0,
    }));
  } catch (error) {
    console.error('Failed to fetch patient recommendation analytics:', error);
    return [];
  }
}

/**
 * Get average quality score per key question
 *
 * FIX: Changed from async to sync to match InstructorDataService interface.
 */
function getQuestionPerformanceScores(simulationGroupId: string): QuestionPerformanceScore[] {
  const rubricQuestions = getGlobalRubricQuestions(simulationGroupId);

  return rubricQuestions.map((q, index) => {
    const baseScore = 55 + Math.sin(index * 2.3) * 20 + Math.cos(index * 1.1) * 15;
    const score = Math.round(Math.min(95, Math.max(40, baseScore)));
    const responses = Math.max(2, Math.floor(10 * (0.5 + Math.sin(index * 1.5) * 0.3)));
    return {
      questionTitle: q.title.length > 30 ? q.title.substring(0, 27) + '...' : q.title,
      averageScore: score,
      totalResponses: responses
    };
  });
}

/**
 * Get score distribution as a histogram
 * Returns buckets: 0-20, 21-40, 41-60, 61-80, 81-100
 *
 * FIX: Added missing simulationGroupId parameter to match InstructorDataService interface.
 */
function getScoreDistribution(_simulationGroupId: string, patientId: string): ScoreDistributionBucket[] {
  const seed = patientId.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);

  const buckets = [
    { range: '0–20', base: 1 },
    { range: '21–40', base: 3 },
    { range: '41–60', base: 7 },
    { range: '61–80', base: 9 },
    { range: '81–100', base: 5 },
  ];

  return buckets.map((b, i) => ({
    range: b.range,
    count: Math.max(0, b.base + Math.floor(Math.sin(seed + i * 2.1) * 4))
  }));
}

/**
 * Generate a new access code for a simulation group
 *
 * FIX: Changed to async to match InstructorDataService interface (Promise<string>).
 */
async function generateAccessCode(simulationGroupId: string): Promise<string> {
  const result = await apiClient.request<{ access_code: string }>(
    `instructor/generate_access_code?simulation_group_id=${encodeURIComponent(simulationGroupId)}`,
    { method: 'PUT' }
  );
  return result.access_code;
}

/**
 * Get manageable patients for a simulation group
 * Maps to: personas table filtered by simulation_group_id
 */
async function getManageablePatients(simulationGroupId: string): Promise<ManageablePatient[]> {
  try {
    const data = await apiClient.request<any[]>(
      `instructor/view_patients?simulation_group_id=${encodeURIComponent(simulationGroupId)}`
    );

    return data.map((patient) => ({
      id: patient.persona_id,
      patient_id: patient.persona_id,
      simulation_group_id: patient.simulation_group_id,
      name: patient.persona_name,
      patient_name: patient.persona_name,
      age: patient.persona_age,
      patient_age: patient.persona_age,
      gender: patient.persona_gender,
      patient_gender: patient.persona_gender,
      patient_number: patient.persona_number,
      patient_prompt: patient.persona_prompt,
      voice_persona_prompt: patient.voice_persona_prompt || undefined,
      average_wpm: patient.average_wpm,
      voice_id: patient.voice_id,
      voice_enabled: patient.voice_enabled !== false,
      interaction_mode: patient.interaction_mode,
      llmEvaluationEnabled: patient.llm_completion || false,
      llm_completion: patient.llm_completion || false,
      photo_url: patient.photo_url,
      mode: patient.mode || 'full_assessment',
    }));
  } catch (error) {
    console.error('Failed to fetch manageable patients:', error);
    throw new Error('Failed to load patients. Please try again.');
  }
}

/**
 * Get a specific patient by ID
 */
function getPatient(_patientId: string): ManageablePatient | undefined {
  return undefined;
}

/**
 * Create a new patient
 */
async function createPatient(simulationGroupId: string, patientData: PatientCreateData): Promise<string> {
  try {
    const user = await authService.getCurrentUser();
    if (!user?.email) throw new Error('Not authenticated');

    const queryParams = new URLSearchParams({
      simulation_group_id: simulationGroupId,
      persona_name: patientData.patient_name,
      persona_number: patientData.patient_number?.toString() || '1',
      persona_age: patientData.patient_age.toString(),
      persona_gender: patientData.patient_gender,
    });

    if (patientData.voice_id) {
      queryParams.append('voice_id', patientData.voice_id);
    }

    const result = await apiClient.request<{ persona_id: string }>(
      `instructor/create_patient?${queryParams.toString()}`,
      {
        method: 'POST',
        body: {
          persona_prompt: patientData.patient_prompt || '',
          ...(patientData.voice_persona_prompt ? { voice_persona_prompt: patientData.voice_persona_prompt } : {}),
        },
      }
    );
    return result.persona_id;
  } catch (error) {
    console.error('Failed to create patient:', error);
    throw error;
  }
}

/**
 * Update patient information
 */
async function updatePatient(simulationGroupId: string, patientData: PatientUpdateData): Promise<void> {
  try {
    const user = await authService.getCurrentUser();
    if (!user?.email) throw new Error('Not authenticated');

    const queryParams = new URLSearchParams({
      persona_id: patientData.patient_id,
      simulation_group_id: simulationGroupId,
    });

    await apiClient.request(`instructor/edit_patient?${queryParams.toString()}`, {
      method: 'PUT',
      body: {
        persona_name: patientData.patient_name,
        persona_age: patientData.patient_age,
        persona_gender: patientData.patient_gender,
        persona_prompt: patientData.patient_prompt,
        voice_persona_prompt: patientData.voice_persona_prompt !== undefined ? patientData.voice_persona_prompt : undefined,
        voice_enabled: patientData.voice_enabled,
        voice_id: patientData.voice_id,
      },
    });

    if (patientData.llm_upload_file) {
      await uploadFileToS3(simulationGroupId, patientData.patient_id, patientData.llm_upload_file, 'documents');
    }
    if (patientData.patient_info_file) {
      await uploadFileToS3(simulationGroupId, patientData.patient_id, patientData.patient_info_file, 'info');
    }
    if (patientData.answer_key_file) {
      await uploadFileToS3(simulationGroupId, patientData.patient_id, patientData.answer_key_file, 'answer_key');
    }
  } catch (error) {
    console.error('Failed to update patient:', error);
    throw error;
  }
}

/**
 * Get a presigned URL and upload a file to S3
 */
async function uploadFileToS3(
  simulationGroupId: string,
  patientId: string,
  file: File,
  folderType: 'documents' | 'info' | 'answer_key' | 'profile_picture'
): Promise<void> {
  const lastDot = file.name.lastIndexOf('.');
  const fileName = lastDot > 0 ? file.name.substring(0, lastDot) : file.name;
  const fileType = lastDot > 0 ? file.name.substring(lastDot + 1).toLowerCase() : '';

  const queryParams = new URLSearchParams({
    simulation_group_id: simulationGroupId,
    patient_id: patientId,
    patient_name: patientId,
    file_name: fileName,
    file_type: fileType,
    folder_type: folderType,
  });

  const data = await apiClient.request<{ url: string; fields: Record<string, string> }>(
    `instructor/generate_presigned_url?${queryParams.toString()}`
  );

  const formData = new FormData();
  // Append all policy fields first (order matters for S3 POST)
  for (const [key, value] of Object.entries(data.fields)) {
    formData.append(key, value);
  }
  // File must be the last field
  formData.append('file', file);

  const response = await fetch(data.url, {
    method: 'POST',
    body: formData,
    mode: 'cors',
  });

  // S3 POST may return a 2xx status on success (for example 200 when
  // success_action_status is configured by the backend). Treat any non-2xx
  // response as a failure.
  if (!response.ok) {
    throw new Error(`Upload failed with status ${response.status}`);
  }
}

/**
 * Upload a patient file (document, info, or answer key) to S3
 */
async function uploadPatientFile(
  simulationGroupId: string,
  patientId: string,
  file: File,
  folderType: 'documents' | 'info' | 'answer_key'
): Promise<void> {
  await uploadFileToS3(simulationGroupId, patientId, file, folderType);
}

/**
 * Delete a patient file (document, info, or answer key) from S3 and clean up embeddings
 */
async function deletePatientFile(
  simulationGroupId: string,
  patientId: string,
  fileName: string,
  fileType: string,
  folderType: 'documents' | 'info' | 'answer_key'
): Promise<void> {
  const queryParams = new URLSearchParams({
    simulation_group_id: simulationGroupId,
    persona_id: patientId,
    file_name: fileName,
    file_type: fileType,
    folder_type: folderType,
  });

  await apiClient.request(
    `instructor/delete_file?${queryParams.toString()}`,
    { method: 'DELETE' }
  );
}

/**
 * Ingestion status of an uploaded file, as tracked in persona_data.ingestion_status.
 * 'queued' is a synthetic client-side state for files whose S3 event hasn't yet
 * produced a DB row (the ingestion Lambda runs asynchronously after upload).
 */
export type IngestionStatus = 'not processing' | 'processing' | 'completed' | 'error';
export type IngestionStatusOrQueued = IngestionStatus | 'queued';

/**
 * Per-folder ingestion status map: { "record.pdf": "completed", ... }
 */
export interface IngestionStatusByFolder {
  documents: Record<string, IngestionStatus>;
  info: Record<string, IngestionStatus>;
  answer_key: Record<string, IngestionStatus>;
}

/**
 * Fetch ingestion status for every uploaded file of a patient, grouped by folder.
 * Used by the editor to poll live status after a document upload.
 */
async function getIngestionStatus(
  simulationGroupId: string,
  patientId: string
): Promise<IngestionStatusByFolder> {
  const queryParams = new URLSearchParams({
    persona_id: patientId,               // endpoint expects persona_id, not patient_id
    simulation_group_id: simulationGroupId,
  });

  try {
    const data = await apiClient.request<{ byFolder?: Partial<IngestionStatusByFolder> }>(
      `instructor/ingestion_status?${queryParams.toString()}`
    );
    return {
      documents: data.byFolder?.documents ?? {},
      info: data.byFolder?.info ?? {},
      answer_key: data.byFolder?.answer_key ?? {},
    };
  } catch (error) {
    console.error('Failed to fetch ingestion status:', error);
    return { documents: {}, info: {}, answer_key: {} };
  }
}

/**
 * Represents an uploaded file with its display name and metadata.
 */
export interface UploadedFileInfo {
  filename: string;
  displayName: string | null;
  metadata: string | null;
  url: string;
  folderType: 'documents' | 'info' | 'answer_key';
  /** Ingestion status from the DB, available on initial file load. */
  ingestionStatus: IngestionStatus | null;
}

/**
 * Fetch all uploaded files for a patient, grouped by folder type.
 * Uses the same get_all_files endpoint as the student side.
 */
async function fetchPatientUploadedFiles(
  simulationGroupId: string,
  patientId: string
): Promise<{ files: Record<'llm' | 'patientInfo' | 'answerKey', UploadedFileInfo[]>; profilePictureUrl: string | null }> {
  try {
    const data = await apiClient.request<{
      document_files: Record<string, { url: string; metadata: string | null; display_name?: string | null; ingestion_status?: string | null }>;
      info_files: Record<string, { url: string; metadata: string | null; display_name?: string | null; ingestion_status?: string | null }>;
      answer_key_files: Record<string, { url: string; metadata: string | null; display_name?: string | null; ingestion_status?: string | null }>;
      profile_picture_url?: string | null;
    }>(
      `instructor/get_all_files?simulation_group_id=${encodeURIComponent(simulationGroupId)}&persona_id=${encodeURIComponent(patientId)}&patient_name=${encodeURIComponent(patientId)}`
    );

    const validStatuses: IngestionStatus[] = ['not processing', 'processing', 'completed', 'error'];
    const mapFiles = (files: Record<string, { url: string; metadata: string | null; display_name?: string | null; ingestion_status?: string | null }>, folderType: 'documents' | 'info' | 'answer_key'): UploadedFileInfo[] =>
      Object.entries(files ?? {}).map(([filename, info]) => ({
        filename,
        displayName: info.display_name ?? null,
        metadata: info.metadata ?? null,
        url: info.url,
        folderType,
        ingestionStatus: (validStatuses.includes(info.ingestion_status as IngestionStatus) ? info.ingestion_status as IngestionStatus : null),
      }));

    return {
      files: {
        llm: mapFiles(data.document_files, 'documents'),
        patientInfo: mapFiles(data.info_files, 'info'),
        answerKey: mapFiles(data.answer_key_files, 'answer_key'),
      },
      profilePictureUrl: data.profile_picture_url ?? null,
    };
  } catch (error) {
    console.error('Failed to fetch uploaded files:', error);
    return { files: { llm: [], patientInfo: [], answerKey: [] }, profilePictureUrl: null };
  }
}

/**
 * Update the display name for an uploaded file via PUT /instructor/update_metadata.
 */
async function updateFileDisplayName(
  patientId: string,
  filename: string,
  filetype: string,
  displayName: string
): Promise<void> {
  try {
    const user = await authService.getCurrentUser();
    if (!user?.email) throw new Error('Not authenticated');

    const queryParams = new URLSearchParams({
      persona_id: patientId,
      filename: filename,
      filetype: filetype,
    });

    await apiClient.request(`instructor/update_metadata?${queryParams.toString()}`, {
      method: 'PUT',
      body: {
        metadata: null,
        display_name: displayName || null,
      },
    });
  } catch (error) {
    console.error('Failed to update file display name:', error);
    throw error;
  }
}

/**
 * Upload patient photo — normalizes filename to {patientId}_profile_pic.png
 * so retrieval via getProfilePictures Lambda works consistently.
 */
async function uploadPatientPhoto(simulationGroupId: string, patientId: string, photoFile: File): Promise<string> {
  // Normalize to a consistent filename so upload and retrieval keys match.
  // The presigned URL lambda hardcodes ContentType: image/png for profile_picture,
  // so the MIME type here must match to avoid a signature mismatch on upload.
  const normalizedFile = new File([photoFile], `${patientId}_profile_pic.png`, { type: 'image/png' });
  await uploadFileToS3(simulationGroupId, patientId, normalizedFile, 'profile_picture');
  return '';
}

/**
 * Delete patient photo from S3
 */
async function deletePatientPhoto(simulationGroupId: string, patientId: string): Promise<void> {
  const queryParams = new URLSearchParams({
    simulation_group_id: simulationGroupId,
    persona_id: patientId,
    patient_name: patientId,
    file_name: `${patientId}_profile_pic`,
    file_type: 'png',
    folder_type: 'profile_picture',
  });

  await apiClient.request(
    `instructor/delete_file?${queryParams.toString()}`,
    { method: 'DELETE' }
  );
}

/**
 * Fetch profile picture URLs for all patients in a simulation group
 */
async function fetchProfilePictures(simulationGroupId: string): Promise<Record<string, string>> {
  try {
    const data = await apiClient.request<Record<string, string>>(
      `instructor/get_profile_pictures?simulation_group_id=${encodeURIComponent(simulationGroupId)}`,
      { method: 'POST' }
    );
    return data;
  } catch (error) {
    console.error('Failed to fetch profile pictures:', error);
    return {};
  }
}

/**
 * Update patient LLM evaluation setting
 */
async function updatePatientLLMEvaluation(patientId: string, enabled: boolean): Promise<void> {
  try {
    const user = await authService.getCurrentUser();
    if (!user?.email) throw new Error('Not authenticated');

    await apiClient.request(
      `instructor/toggle_llm_completion?persona_id=${encodeURIComponent(patientId)}`,
      {
        method: 'PUT',
        body: {
          llm_completion: enabled,
        },
      }
    );
  } catch (error) {
    console.error('Failed to update LLM evaluation:', error);
    throw error;
  }
}

/**
 * Toggle voice mode for a specific patient.
 * Uses the edit_patient endpoint with only voice_enabled in the body.
 * The backend treats undefined fields as no-change for other columns.
 */
async function updatePatientVoiceEnabled(patientId: string, simulationGroupId: string, enabled: boolean): Promise<void> {
  try {
    const user = await authService.getCurrentUser();
    if (!user?.email) throw new Error('Not authenticated');

    // Fetch current patient data so we can send the required fields
    const patients = await getManageablePatients(simulationGroupId);
    const patient = patients.find(p => p.patient_id === patientId);
    if (!patient) throw new Error('Patient not found');

    const queryParams = new URLSearchParams({
      persona_id: patientId,
      simulation_group_id: simulationGroupId,
    });

    await apiClient.request(`instructor/edit_patient?${queryParams.toString()}`, {
      method: 'PUT',
      body: {
        persona_name: patient.patient_name,
        persona_age: patient.patient_age,
        persona_gender: patient.patient_gender,
        persona_prompt: patient.patient_prompt,
        voice_enabled: enabled,
      },
    });
  } catch (error) {
    console.error('Failed to update voice enabled:', error);
    throw error;
  }
}

/**
 * Delete a patient
 */
async function deletePatient(patientId: string): Promise<void> {
  try {
    const user = await authService.getCurrentUser();
    if (!user?.email) throw new Error('Not authenticated');

    await apiClient.request(
      `instructor/delete_patient?persona_id=${encodeURIComponent(patientId)}`,
      {
        method: 'DELETE',
      }
    );
  } catch (error) {
    console.error('Failed to delete patient:', error);
    throw error;
  }
}

/**
 * Get global rubric questions for a simulation group
 */
function getGlobalRubricQuestions(_simulationGroupId: string): GlobalRubricQuestion[] {
  return [];
}

/**
 * Add a new global rubric question
 */
function addGlobalRubricQuestion(simulationGroupId: string, question: GlobalRubricQuestion): void {
  if (!globalRubricQuestions[simulationGroupId]) {
    globalRubricQuestions[simulationGroupId] = [];
  }

  const existingQuestion = globalRubricQuestions[simulationGroupId].find(q => q.id === question.id);
  if (existingQuestion) {
    console.log(`Question ${question.id} already exists in simulation group ${simulationGroupId}, skipping duplicate add`);
    return;
  }

  globalRubricQuestions[simulationGroupId].push(question);
}

/**
 * Update a global rubric question
 */
async function updateGlobalRubricQuestion(_simulationGroupId: string, question: GlobalRubricQuestion): Promise<any> {
  return apiClient.request<any>(
    `instructor/question_bank?question_id=${encodeURIComponent(question.id)}`,
    {
      method: 'PUT',
      body: {
        title: question.title,
        question_text: question.keyQuestion,
        evaluation_criteria: question.evaluationCriteria,
        clinical_intent: question.clinicalIntent,
        is_mandatory: question.required,
      },
    }
  );
}

/**
 * Delete a global rubric question
 */
function deleteGlobalRubricQuestion(simulationGroupId: string, questionId: string): void {
  const questions = globalRubricQuestions[simulationGroupId];
  if (questions) {
    globalRubricQuestions[simulationGroupId] = questions.filter(q => q.id !== questionId);
  }
}

/**
 * Get evaluation prompt for a simulation group
 */
async function getEvaluationPrompt(simulationGroupId: string): Promise<string> {
  try {
    const data = await apiClient.request<{ system_prompt: string }>(
      `instructor/get_prompt?simulation_group_id=${encodeURIComponent(simulationGroupId)}`
    );

    return data.system_prompt || '';
  } catch (error) {
    console.error('Failed to fetch evaluation prompt:', error);
    // FIX: Return empty string instead of [] as any
    return '';
  }
}

/**
 * Get debrief prompt for a simulation group
 */
async function getDebriefPrompt(simulationGroupId: string): Promise<string> {
  try {
    const data = await apiClient.request<{ debrief_prompt: string }>(
      `instructor/get_debrief_prompt?simulation_group_id=${encodeURIComponent(simulationGroupId)}`
    );
    return data.debrief_prompt || '';
  } catch (error) {
    console.error('Failed to fetch debrief prompt:', error);
    return '';
  }
}

/**
 * Update system prompt for a simulation group
 */
async function updateSystemPrompt(
  simulationGroupId: string,
  _instructorEmail: string,
  prompt: string
): Promise<void> {
  await apiClient.request(
    `instructor/prompt?simulation_group_id=${encodeURIComponent(simulationGroupId)}`,
    { method: 'PUT', body: { prompt } }
  );
}

/**
 * Update debrief prompt for a simulation group
 */
async function updateDebriefPrompt(
  simulationGroupId: string,
  _instructorEmail: string,
  prompt: string
): Promise<void> {
  await apiClient.request(
    `instructor/debrief_prompt?simulation_group_id=${encodeURIComponent(simulationGroupId)}`,
    { method: 'PUT', body: { prompt } }
  );
}

/**
 * Get the default debrief prompt
 */
async function getDefaultDebriefPrompt(): Promise<string> {
  try {
    const data = await apiClient.request<{ default_debrief_prompt: string }>(
      'instructor/get_default_debrief_prompt'
    );
    return data.default_debrief_prompt || '';
  } catch (error) {
    console.error('Failed to fetch default debrief prompt:', error);
    return '';
  }
}

/**
 * Get the default system prompt
 */
async function getDefaultSystemPrompt(): Promise<string> {
  try {
    const data = await apiClient.request<{ default_system_prompt: string }>(
      'instructor/get_default_system_prompt'
    );
    return data.default_system_prompt || '';
  } catch (error) {
    console.error('Failed to fetch default system prompt:', error);
    return '';
  }
}

/**
 * Get the default persona prompt
 */
async function getDefaultPersonaPrompt(): Promise<string> {
  try {
    const data = await apiClient.request<{ default_persona_prompt: string }>(
      'instructor/get_default_persona_prompt'
    );
    return data.default_persona_prompt || '';
  } catch (error) {
    console.error('Failed to fetch default persona prompt:', error);
    return '';
  }
}

/**
 * Prompt history entry from the backend
 */
export interface PromptHistoryEntry {
  id: string;
  text: string;
  saved_at: string;
  modified_by_email: string | null;
  modified_by_first_name: string | null;
  modified_by_last_name: string | null;
}

/**
 * Get prompt history for a simulation group
 */
async function getPromptHistory(simulationGroupId: string, type: 'system' | 'debrief'): Promise<PromptHistoryEntry[]> {
  try {
    const data = await apiClient.request<PromptHistoryEntry[]>(
      `instructor/get_prompt_history?simulation_group_id=${encodeURIComponent(simulationGroupId)}&type=${type}`
    );
    return data || [];
  } catch (error) {
    console.error(`Failed to fetch ${type} prompt history:`, error);
    return [];
  }
}

/**
 * Get students for a simulation group
 */
async function getStudents(simulationGroupId: string): Promise<Student[]> {
  try {
    const data = await apiClient.request<any[]>(
      `instructor/view_students?simulation_group_id=${encodeURIComponent(simulationGroupId)}`
    );

    return data.map((student) => ({
      id: student.user_id || student.user_email,
      name: `${student.first_name} ${student.last_name}`.trim() || student.username,
      email: student.user_email,
    }));
  } catch (error) {
    console.error('Failed to fetch students:', error);
    throw new Error('Failed to load students. Please try again.');
  }
}

/**
 * Get student details by ID
 *
 * Fetches real student data from the backend using the student's email and simulation group ID.
 * Computes casesAttempted and caseCompletionRate from student_patients_messages endpoint.
 * Falls back to mock data if API calls fail.
 */
async function getStudentDetails(studentId: string, simulationGroupId: string, groupNameOverride?: string): Promise<StudentDetails | undefined> {
  // Step 1: Get basic student info (name, email) from the students list
  let studentName = '';
  let studentEmail = '';
  let studentUuid = '';
  let groupName = groupNameOverride || '';

  try {
    const students = await getStudents(simulationGroupId);
    const student = students.find(s => s.id === studentId) || students.find(s => s.email === studentId);
    if (!student) {
      console.warn('Student not found in group');
      return undefined;
    }
    studentName = student.name;
    studentEmail = student.email;
    studentUuid = student.id;
  } catch (error) {
    console.error('Failed to fetch students list:', error);
    return undefined;
  }

  // Step 2: Get group name if not provided
  if (!groupName) {
    try {
      const group = await getSimulationGroup(simulationGroupId);
      groupName = group?.group_name || '';
    } catch {
      groupName = '';
    }
  }

  // Step 3: Get cases attempted and completion rate from student_patients_messages
  // chat.status === 'concluded' means debrief was reached
  let totalChats = 0;
  let completedChats = 0;
  try {
    const patientData = await apiClient.request<Record<string, any[]>>(
      `instructor/student_patients_messages?student_id=${encodeURIComponent(studentUuid)}&simulation_group_id=${encodeURIComponent(simulationGroupId)}`
    );

    for (const pName of Object.keys(patientData)) {
      const chats = patientData[pName];
      if (Array.isArray(chats)) {
        totalChats += chats.length;
        completedChats += chats.filter((chat: any) => chat.status === 'concluded').length;
      }
    }
  } catch (error) {
    console.warn('Failed to fetch student patient messages, stats will show 0:', error);
  }

  const caseCompletionRate = totalChats > 0 ? Math.round((completedChats / totalChats) * 100) : 0;

  return {
    id: studentUuid,
    name: studentName,
    email: studentEmail,
    groupName,
    casesAttempted: totalChats,
    caseCompletionRate,
  };
}

/**
 * Fetch all patient data for a student from the backend.
 * Returns structured data with patient names, chat attempts, messages, and notes.
 */
async function getStudentPatientData(studentId: string, simulationGroupId: string): Promise<StudentPatientData> {
  const empty: StudentPatientData = { patientNames: [], attempts: {}, messages: {}, notes: {}, dtpSubmissions: {}, recommendationSubmissions: {} };

  try {
    const raw = await apiClient.request<Record<string, any[]>>(
      `instructor/student_patients_messages?student_id=${encodeURIComponent(studentId)}&simulation_group_id=${encodeURIComponent(simulationGroupId)}`
    );

    const patientNames = Object.keys(raw);
    const attempts: Record<string, ChatAttempt[]> = {};
    const messages: Record<string, ChatMessage[]> = {};
    const notes: Record<string, string> = {};
    const dtpSubmissions: Record<string, string[] | null> = {};
    const recommendationSubmissions: Record<string, RecommendationSubmissionEntry[] | null> = {};

    for (const patientName of patientNames) {
      const chats = raw[patientName];
      if (!Array.isArray(chats)) continue;

      // Build attempt objects with a raw timestamp for sorting
      const unsorted = chats.map((chat: any, index: number) => {
        const attemptId = chat.chatId || chat.chatName || `chat-${index}`;

        // Filter out "Begin the conversation as the patient" messages and deduplicate
        const seen = new Set<string>();
        const chatMessages: ChatMessage[] = (chat.messages || [])
          .filter((msg: any) => {
            if (typeof msg.message_content === 'string' && msg.message_content.trim().startsWith('Begin the conversation as the patient:')) return false;
            const key = `${msg.sender_type}::${(msg.message_content || '').trim()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((msg: any, msgIdx: number) => ({
            message_id: `${attemptId}-msg-${msgIdx}`,
            chat_id: attemptId,
            sender_type: msg.sender_type as 'student' | 'ai' | 'system',
            message_content: msg.message_content,
            sent_at: msg.sent_at ? new Date(msg.sent_at).toLocaleString() : '',
          }));

        messages[attemptId] = chatMessages;
        notes[attemptId] = chat.notes || '';
        dtpSubmissions[attemptId] = Array.isArray(chat.dtpSubmission) ? chat.dtpSubmission : null;
        recommendationSubmissions[attemptId] = Array.isArray(chat.recommendationSubmission) ? chat.recommendationSubmission : null;

        // Derive date from the first message timestamp (session start)
        const firstMsg = chat.messages?.[0];
        const rawTimestamp = firstMsg?.sent_at ? new Date(firstMsg.sent_at).getTime() : 0;
        const dateStr = rawTimestamp
          ? new Date(rawTimestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : '';

        // Format name like student view: "Session Mar 23, 2026"
        let displayName = chat.chatName || '';
        if (displayName) {
          const timestampMatch = displayName.match(/(\d{10,13})/);
          if (timestampMatch) {
            const ts = Number(timestampMatch[1]);
            const parsed = new Date(ts < 1e12 ? ts * 1000 : ts);
            if (!isNaN(parsed.getTime())) {
              displayName = `Session ${parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} ${parsed.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
            }
          }
        }
        if (!displayName && dateStr) {
          const fallbackDate = new Date(firstMsg?.sent_at);
          const timeStr = !isNaN(fallbackDate.getTime())
            ? ' ' + fallbackDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
            : '';
          displayName = `Session ${dateStr}${timeStr}`;
        }

        const isCompleted = chat.status === 'concluded';

        return {
          rawTimestamp,
          attempt: {
            id: attemptId,
            student_interaction_id: '',
            attemptNumber: 0, // will be assigned after sorting
            date: dateStr,
            completionStatus: isCompleted ? 'Debrief Reached' as const : 'In Progress' as const,
            score: null,
            notes: chat.notes || '',
            displayName,
          } as ChatAttempt & { displayName: string },
        };
      });

      // Sort most recent first
      unsorted.sort((a, b) => b.rawTimestamp - a.rawTimestamp);

      // Assign attempt numbers (most recent = highest number)
      const patientAttempts: ChatAttempt[] = unsorted.map((item, idx) => ({
        ...item.attempt,
        attemptNumber: unsorted.length - idx,
        date: item.attempt.displayName || item.attempt.date,
      }));

      attempts[patientName] = patientAttempts;
    }

    return { patientNames, attempts, messages, notes, dtpSubmissions, recommendationSubmissions };
  } catch (error) {
    console.error('Failed to fetch student patient data:', error);
    return empty;
  }
}

/**
 * Get chat attempts for a student and patient
 */
function getChatAttempts(_studentId: string, _patientId: string): ChatAttempt[] {
  return [];
}

/**
 * Get chat messages for an attempt
 */
function getChatMessages(_attemptId: string): ChatMessage[] {
  return [];
}

/**
 * Get notes for an attempt
 *
 * FIX: Return empty string instead of [] as any to match string return type.
 */
function getChatNotes(_attemptId: string): string {
  return '';
}

/**
 * Get case-specific questions for a patient
 */
function getCaseSpecificQuestions(_patientId: string): GlobalRubricQuestion[] {
  return [];
}

/**
 * Add a new case-specific question
 *
 * FIX: Changed from async to sync (void) to match InstructorDataService interface.
 * Removed async getManageablePatients call that was called with empty string anyway.
 */
function addCaseSpecificQuestion(patientId: string, question: GlobalRubricQuestion): void {
  if (!caseSpecificQuestions[patientId]) {
    caseSpecificQuestions[patientId] = [];
  }

  const existingQuestion = caseSpecificQuestions[patientId].find(q => q.id === question.id);
  if (existingQuestion) {
    console.log(`Question ${question.id} already exists for patient ${patientId}, skipping duplicate add`);
    return;
  }

  caseSpecificQuestions[patientId].push(question);
}

/**
 * Update a case-specific question
 */
function updateCaseSpecificQuestion(_patientId: string, question: GlobalRubricQuestion): void {
  // Update the question in the question bank via API
  apiClient.request<any>(
    `instructor/question_bank?question_id=${question.id}`,
    {
      method: 'PUT',
      body: {
        title: question.title,
        question_text: question.keyQuestion,
        evaluation_criteria: question.evaluationCriteria,
        clinical_intent: question.clinicalIntent,
        is_mandatory: question.required,
      },
    }
  ).catch((err) => console.error('Failed to update case-specific question:', err));
}

/**
 * Delete a case-specific question
 *
 * FIX: Changed from async to sync (void) to match InstructorDataService interface.
 * Removed async getManageablePatients calls that used an empty string group ID.
 */
function deleteCaseSpecificQuestion(patientId: string, questionId: string): void {
  // Remove from local cache
  const questions = caseSpecificQuestions[patientId];
  if (questions) {
    // Find the group_question_id from the cached question before removing
    const question = questions.find(q => q.id === questionId);
    if (question?.group_question_id) {
      // Unassign via real API call
      apiClient.request<any>(
        `instructor/simulation_group_questions?group_question_id=${question.group_question_id}`,
        { method: 'DELETE' }
      ).catch((err) => console.error('Failed to delete case-specific question assignment:', err));
    }
    caseSpecificQuestions[patientId] = questions.filter(q => q.id !== questionId);
  }
}

/**
 * Get case materials for a patient
 */
async function getCaseMaterials(patientId: string): Promise<CaseMaterial[]> {
  try {
    const data = await apiClient.request<any[]>(
      `instructor/persona_media?persona_id=${encodeURIComponent(patientId)}`
    );
    return data.map((row) => ({
      id: row.media_id,
      title: row.title || '',
      description: row.description || '',
      materialType: (row.media_type || 'kaltura') as CaseMaterial['materialType'],
      contentUrl: '',
      embedLink: row.url || '',
    }));
  } catch (error) {
    console.error('Failed to fetch case materials:', error);
    return [];
  }
}

/**
 * Add a new case material
 */
async function addCaseMaterial(patientId: string, material: CaseMaterial): Promise<CaseMaterial> {
  const data = await apiClient.request<any>(
    `instructor/persona_media?persona_id=${encodeURIComponent(patientId)}`,
    {
      method: 'POST',
      body: {
        title: material.title,
        description: material.description,
        media_type: material.materialType,
        url: material.embedLink || material.contentUrl || '',
      },
    }
  );
  return {
    id: data.media_id,
    title: data.title || '',
    description: data.description || '',
    materialType: (data.media_type || 'kaltura') as CaseMaterial['materialType'],
    contentUrl: '',
    embedLink: data.url || '',
  };
}

/**
 * Update a case material
 */
async function updateCaseMaterial(_patientId: string, material: CaseMaterial): Promise<CaseMaterial> {
  const data = await apiClient.request<any>(
    `instructor/persona_media?media_id=${encodeURIComponent(material.id)}`,
    {
      method: 'PUT',
      body: {
        title: material.title,
        description: material.description,
        media_type: material.materialType,
        url: material.embedLink || material.contentUrl || '',
      },
    }
  );
  return {
    id: data.media_id,
    title: data.title || '',
    description: data.description || '',
    materialType: (data.media_type || 'kaltura') as CaseMaterial['materialType'],
    contentUrl: '',
    embedLink: data.url || '',
  };
}

/**
 * Delete a case material
 */
async function deleteCaseMaterial(_patientId: string, materialId: string): Promise<void> {
  await apiClient.request(
    `instructor/persona_media?media_id=${encodeURIComponent(materialId)}`,
    { method: 'DELETE' }
  );
}

/**
 * Get the default patient prompt
 */
function getDefaultPatientPrompt(): string {
  return '';
}

/**
 * Get global question bank
 */
async function getGlobalQuestionBank(): Promise<QuestionBankItem[]> {
  try {
    const rows = await apiClient.request<any[]>('instructor/question_bank');
    return rows.map(mapBackendToQuestionBankItem);
  } catch (error) {
    console.error('Failed to fetch global question bank from API:', error);
    throw new Error('Failed to load question bank. Please try again.');
  }
}

/**
 * Create a new question in the global question bank
 */
async function createQuestionBankQuestion(
  organizationId: string,
  data: {
    title: string;
    question_text: string;
    clinical_intent?: string;
    evaluation_criteria: string;
    category?: string;
    difficulty_level?: string;
    is_mandatory?: boolean;
    weight?: number;
    max_score?: number;
    tags?: string[];
  }
): Promise<QuestionBankItem> {
  const response = await apiClient.request<any>(
    `instructor/question_bank?organization_id=${encodeURIComponent(organizationId)}`,
    { method: 'POST', body: data }
  );
  return mapBackendToQuestionBankItem(response);
}

/**
 * Update an existing question in the global question bank
 */
async function updateQuestionBankQuestion(
  questionId: string,
  data: {
    title?: string;
    question_text?: string;
    clinical_intent?: string;
    evaluation_criteria?: string;
    is_mandatory?: boolean;
    tags?: string[];
  }
): Promise<QuestionBankItem> {
  const response = await apiClient.request<any>(
    `instructor/question_bank?question_id=${encodeURIComponent(questionId)}`,
    { method: 'PUT', body: data }
  );
  return mapBackendToQuestionBankItem(response);
}

/**
 * Get patient-specific question bank — requires API
 */
function getPatientSpecificQuestionBank(): QuestionBankItem[] {
  return [];
}

/**
 * Add a question to the global question bank
 */
function addToGlobalQuestionBank(_question: QuestionBankItem): void {
  // No-op: question bank is managed via API
}

/**
 * Add a question to the patient-specific question bank
 */
function addToPatientSpecificQuestionBank(_question: QuestionBankItem): void {
  // No-op: question bank is managed via API
}

/**
 * Get patient's case-specific question IDs
 */
function getPatientCaseSpecificQuestionIds(patientId: string): Set<string> {
  const questions = caseSpecificQuestions[patientId] || [];
  return new Set(questions.map(q => q.id));
}

/**
 * Update patient's case-specific questions based on question IDs
 */
function updatePatientCaseSpecificQuestions(patientId: string, questionIds: Set<string>): void {
  console.log(`Updating patient ${patientId} case-specific questions:`, Array.from(questionIds));
}

/**
 * Get simulation groups using a specific question
 */
function getSimulationGroupsUsingQuestion(_questionId: string, _questionType: 'global' | 'patientSpecific' = 'global'): string[] {
  return [];
}

/**
 * Get patients using a specific patient-specific question
 */
function getPatientsUsingQuestion(_questionId: string): string[] {
  return [];
}

/**
 * Check if a question is used by any simulation group
 */
function isQuestionInUse(questionId: string, questionType: 'global' | 'patientSpecific' = 'global'): boolean {
  const groups = getSimulationGroupsUsingQuestion(questionId, questionType);
  return groups.length > 0;
}

/**
 * Get questions assigned to a simulation group, optionally filtered by persona
 */
async function getSimulationGroupQuestions(simulationGroupId: string, personaId?: string): Promise<any[]> {
  let endpoint = `instructor/simulation_group_questions?simulation_group_id=${simulationGroupId}`;
  if (personaId) {
    endpoint += `&persona_id=${personaId}`;
  }
  return apiClient.request<any[]>(endpoint);
}

/**
 * Assign one or more questions to a simulation group (persona_id is optional for global assignments).
 * Accepts a single questionId string or an array of questionIds for batch assignment.
 */
async function assignQuestionToGroup(
  simulationGroupId: string,
  questionIds: string | string[],
  personaId?: string,
  options?: { weight_override?: number; max_score_override?: number; order?: number }
): Promise<any> {
  const ids = Array.isArray(questionIds) ? questionIds : [questionIds];
  return apiClient.request<any>(
    `instructor/simulation_group_questions?simulation_group_id=${simulationGroupId}`,
    {
      method: 'POST',
      body: {
        question_id: ids,
        ...(personaId ? { persona_id: personaId } : {}),
        ...options,
      },
    }
  );
}

/**
 * Unassign a question from a simulation group
 */
async function unassignQuestion(groupQuestionId: string): Promise<any> {
  return apiClient.request<any>(
    `instructor/simulation_group_questions?group_question_id=${groupQuestionId}`,
    { method: 'DELETE' }
  );
}

/**
 * Update a question assignment (weight, max score, order)
 */
async function updateQuestionAssignment(groupQuestionId: string, updates: any): Promise<any> {
  return apiClient.request<any>(
    `instructor/simulation_group_questions?group_question_id=${groupQuestionId}`,
    { method: 'PUT', body: updates }
  );
}

/**
 * Fetch AI debrief for a concluded session via GET /instructor/get_debrief.
 */
async function fetchInstructorDebrief(sessionId: string, simulationGroupId: string): Promise<{ legacy: AIDebriefData; updated: UpdatedDebriefData } | null> {
  try {
    const data = await apiClient.request<{ generated_text?: any; status?: string; error?: string }>(
      `instructor/get_debrief?session_id=${encodeURIComponent(sessionId)}&simulation_group_id=${encodeURIComponent(simulationGroupId)}`
    );

    if (!data?.generated_text) return null;

    let debrief = deepParseJson(data.generated_text);
    if (!debrief || typeof debrief !== 'object') return null;

    if (debrief.summary && typeof debrief.summary === 'string' && debrief.summary.includes('{')) {
      const extracted = extractDebriefFromRawJson(debrief.summary);
      if (extracted && typeof extracted === 'object') {
        debrief = { ...debrief, ...extracted } as Record<string, any>;
      }
    }

    if (typeof debrief.summary === 'string' && debrief.summary.includes('{')) {
      try {
        const firstBrace = debrief.summary.indexOf('{');
        const lastBrace = debrief.summary.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          const summaryObj = JSON.parse(debrief.summary.substring(firstBrace, lastBrace + 1));
          if (summaryObj.summary) debrief.summary = summaryObj.summary;
        }
      } catch {
        const m = debrief.summary.match(/"summary"\s*:\s*"([^"]+)"/);
        if (m) {
          debrief.summary = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
        } else {
          debrief.summary = 'AI debrief summary could not be fully parsed.';
        }
      }
    }

    const toStrArray = (arr: any[]) => arr.map(
      (q: string | { question_text?: string }) => typeof q === 'string' ? q : (q.question_text || 'Unknown question')
    );
    const addressedQuestions = toStrArray(debrief.questions_addressed || []);
    const missedQuestions = toStrArray(debrief.questions_missed || []);

    const legacy: AIDebriefData = {
      summary: typeof debrief.summary === 'string' ? debrief.summary : '',
      questionsAddressed: addressedQuestions,
      missedKeyQuestionsCount: missedQuestions.length,
      missedQuestions,
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

    // Build chunk1 (key questions)
    const sectionScores = debrief.section_scores || {};
    const guidanceData = debrief.guidance || {};
    const chunk1 = {
      summary: legacy.summary,
      questionsAddressed: addressedQuestions,
      questionsAddressedCount: addressedQuestions.length,
      questionsMissed: missedQuestions,
      questionsMissedCount: missedQuestions.length,
      suggestedRewrites: legacy.suggestedRewrites,
      keyQuestionsScore: sectionScores.key_questions
        ? { matched: sectionScores.key_questions.matched, total: sectionScores.key_questions.total, percentage: sectionScores.key_questions.percentage }
        : null,
      guidanceKeyQuestions: guidanceData.key_questions || null,
    };

    // Build chunk2 (DTP/rec comparison) — null for interview_practice sessions
    let chunk2: UpdatedDebriefData['chunk2'] = null;
    if (debrief.dtp_comparison || debrief.recommendations_comparison) {
      const dtpRaw = debrief.dtp_comparison || { matched: [], missed: [], additional: [] };
      const recRaw = debrief.recommendations_comparison || { matched: [], missed: [], additional: [] };
      chunk2 = {
        dtpComparison: {
          overview: `Student identified ${dtpRaw.matched?.length || 0} out of ${(dtpRaw.matched?.length || 0) + (dtpRaw.missed?.length || 0)} expected drug therapy problems.`,
          matched: (dtpRaw.matched || []).map((m: any) => ({ dtpText: m.instructor_text || '', status: 'matched' as const, matchedWith: m.student_text || '' })),
          missed: (dtpRaw.missed || []).map((_m: any) => ({ dtpText: '', status: 'missed' as const })),
          additional: (dtpRaw.additional || []).map((m: any) => ({ dtpText: m.student_text || '', status: 'additional' as const })),
          score: sectionScores.dtps
            ? { matched: sectionScores.dtps.matched, total: sectionScores.dtps.total, percentage: sectionScores.dtps.percentage }
            : null,
          guidance: guidanceData.dtps || null,
        },
        recommendationsComparison: {
          overview: `Student matched ${recRaw.matched?.length || 0} out of ${(recRaw.matched?.length || 0) + (recRaw.missed?.length || 0)} expected recommendations.`,
          matched: (recRaw.matched || []).map((m: any) => ({ recommendationText: m.instructor_text || '', status: 'matched' as const, matchedWith: m.student_text || '', rationaleRating: m.rationale_rating || undefined, rationaleExplanation: m.rationale_explanation || undefined })),
          missed: (recRaw.missed || []).map((_m: any) => ({ recommendationText: '', status: 'missed' as const })),
          additional: (recRaw.additional || []).map((m: any) => ({ recommendationText: m.student_text || '', status: 'additional' as const })),
          score: sectionScores.recommendations
            ? { matched: sectionScores.recommendations.matched, total: sectionScores.recommendations.total, percentage: sectionScores.recommendations.percentage }
            : null,
          guidance: guidanceData.recommendations || null,
        },
      };
    }

    return { legacy, updated: { chunk1, chunk2, dtpSubmission: null, recommendationSubmission: null, evaluationIntegrity: legacy.evaluationIntegrity } };
  } catch (error) {
    console.error('[fetchInstructorDebrief] failed', { sessionId, error });
    return null;
  }
}

/**
 * Get student progress buckets for a specific persona
 * Not Started / In Progress / Debrief Reached
 */
async function getStudentProgress(simulationGroupId: string, personaId: string, startDate: string = '', endDate: string = ''): Promise<StudentProgressData[]> {
  try {
    let url = `instructor/student_progress?simulation_group_id=${encodeURIComponent(simulationGroupId)}&persona_id=${encodeURIComponent(personaId)}`;
    if (startDate) url += `&start_date=${encodeURIComponent(startDate)}`;
    if (endDate) url += `&end_date=${encodeURIComponent(endDate)}`;

    const data = await apiClient.request<StudentProgressData[]>(url);
    return data;
  } catch (error) {
    console.error('Failed to fetch student progress:', error);
    return [
      { status: 'Not Started', count: 0, students: [], fill: '#94a3b8' },
      { status: 'In Progress', count: 0, students: [], fill: '#f59e0b' },
      { status: 'Debrief Reached', count: 0, students: [], fill: '#22c55e' },
    ];
  }
}

/**
 * Get completed chat sessions for the prompt playground session picker.
 * Returns sessions where the student has reached the debrief stage.
 */
async function getCompletedSessions(simulationGroupId: string): Promise<CompletedSession[]> {
  try {
    const data = await apiClient.request<any[]>(
      `instructor/completed_sessions?simulation_group_id=${encodeURIComponent(simulationGroupId)}`
    );

    return data.map((session: any) => ({
      chatId: session.chat_id,
      studentName: `${session.first_name || ''} ${session.last_name || ''}`.trim(),
      personaName: session.persona_name,
      personaId: session.persona_id,
      lastAccessed: session.last_accessed,
    }));
  } catch (error) {
    console.error('Failed to fetch completed sessions:', error);
    return [];
  }
}

/**
 * Run a test debrief with a custom prompt against a completed session.
 * Calls POST /student/text_generation?mode=test_debrief with the prompt in the request body.
 * The backend runs the debrief pipeline without persisting results.
 */
async function runTestDebrief(params: {
  simulationGroupId: string;
  sessionId: string;
  personaId: string;
  debriefPrompt: string;
}): Promise<AIDebriefData> {
  const { simulationGroupId, sessionId, personaId, debriefPrompt } = params;

  const endpoint = `student/text_generation?mode=test_debrief&simulation_group_id=${encodeURIComponent(simulationGroupId)}&session_id=${encodeURIComponent(sessionId)}&patient_id=${encodeURIComponent(personaId)}`;

  const data = await apiClient.request<any>(endpoint, {
    method: 'POST',
    body: { debrief_prompt: debriefPrompt },
  });

  if (data?.error) {
    throw new Error(data.error);
  }

  let debrief = deepParseJson(data);
  if (!debrief || typeof debrief !== 'object') {
    throw new Error('Failed to parse test debrief response');
  }

  // Apply the same summary repair logic used in fetchInstructorDebrief
  if (debrief.summary && typeof debrief.summary === 'string' && debrief.summary.includes('{')) {
    const extracted = extractDebriefFromRawJson(debrief.summary);
    if (extracted && typeof extracted === 'object') {
      debrief = { ...debrief, ...extracted } as Record<string, any>;
    }
  }

  if (typeof debrief.summary === 'string' && debrief.summary.includes('{')) {
    try {
      const firstBrace = debrief.summary.indexOf('{');
      const lastBrace = debrief.summary.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const summaryObj = JSON.parse(debrief.summary.substring(firstBrace, lastBrace + 1));
        if (summaryObj.summary) debrief.summary = summaryObj.summary;
      }
    } catch {
      const m = debrief.summary.match(/"summary"\s*:\s*"([^"]+)"/);
      if (m) {
        debrief.summary = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
      } else {
        debrief.summary = 'AI debrief summary could not be fully parsed.';
      }
    }
  }

  const toStrArray = (arr: any[]) => arr.map(
    (q: string | { question_text?: string }) => typeof q === 'string' ? q : (q.question_text || 'Unknown question')
  );
  const addressedQuestions = toStrArray(debrief.questions_addressed || []);
  const missedQuestions = toStrArray(debrief.questions_missed || []);

  return {
    summary: typeof debrief.summary === 'string' ? debrief.summary : '',
    questionsAddressed: addressedQuestions,
    missedKeyQuestionsCount: missedQuestions.length,
    missedQuestions,
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
  };
}

/**
 * Run a test chat message with a custom system prompt against a persona.
 * Calls POST /student/text_generation?mode=test_system_prompt with the system prompt and message in the body.
 * The backend runs the chat pipeline using the provided system prompt instead of the DB-stored one.
 */
async function runTestChat(params: {
  simulationGroupId: string;
  sessionId: string;
  personaId: string;
  systemPrompt: string;
  messageContent: string;
  patientPrompt?: string;
}): Promise<{ llm_output: string }> {
  const { simulationGroupId, sessionId, personaId, systemPrompt, messageContent, patientPrompt } = params;

  const endpoint = `student/text_generation?mode=test_system_prompt&simulation_group_id=${encodeURIComponent(simulationGroupId)}&session_id=${encodeURIComponent(sessionId)}&patient_id=${encodeURIComponent(personaId)}`;

  const body: Record<string, string> = { system_prompt: systemPrompt, message_content: messageContent };
  if (patientPrompt !== undefined && patientPrompt.trim() !== '') {
    body.patient_prompt = patientPrompt;
  }

  const data = await apiClient.request<any>(endpoint, {
    method: 'POST',
    body,
  });

  if (data?.error) {
    throw new Error(data.error);
  }

  return { llm_output: data.llm_output || '' };
}

/**
 * Instructor data service object
 */
export const instructorService: InstructorDataService = {
  getSimulationGroups,
  createSimulationGroup,
  getCurrentUser,
  getSimulationGroup,
  getOrganizationLabels,
  getPatientAnalytics,
  getMessageCountData,
  generateAccessCode,
  getManageablePatients,
  getPatient,
  createPatient,
  updatePatient,
  uploadPatientPhoto,
  deletePatientPhoto,
  fetchProfilePictures,
  uploadPatientFile,
  deletePatientFile,
  fetchPatientUploadedFiles,
  getIngestionStatus,
  updateFileDisplayName,
  updatePatientLLMEvaluation,
  updatePatientVoiceEnabled,
  deletePatient,
  getGlobalRubricQuestions,
  addGlobalRubricQuestion,
  updateGlobalRubricQuestion,
  deleteGlobalRubricQuestion,
  getCaseSpecificQuestions,
  addCaseSpecificQuestion,
  updateCaseSpecificQuestion,
  deleteCaseSpecificQuestion,
  getCaseMaterials,
  addCaseMaterial,
  updateCaseMaterial,
  deleteCaseMaterial,
  getEvaluationPrompt,
  getDebriefPrompt,
  updateSystemPrompt,
  updateDebriefPrompt,
  getDefaultDebriefPrompt,
  getDefaultSystemPrompt,
  getDefaultPersonaPrompt,
  getPromptHistory,
  getStudents,
  getStudentDetails,
  getStudentPatientData,
  getChatAttempts,
  getChatMessages,
  getChatNotes,
  getDefaultPatientPrompt,
  getGlobalQuestionBank,
  createQuestionBankQuestion,
  updateQuestionBankQuestion,
  getPatientSpecificQuestionBank,
  addToGlobalQuestionBank,
  addToPatientSpecificQuestionBank,
  getPatientCaseSpecificQuestionIds,
  updatePatientCaseSpecificQuestions,
  getSimulationGroupsUsingQuestion,
  getPatientsUsingQuestion,
  isQuestionInUse,
  getKeyQuestionAnalytics,
  getKeyQuestionCoverage,
  getPatientKeyQuestionAnalytics,
  getDTPCoverage,
  getRecommendationCoverage,
  getPatientDTPAnalytics,
  getPatientRecommendationAnalytics,
  getQuestionPerformanceScores,
  getScoreDistribution,
  getSimulationGroupQuestions,
  assignQuestionToGroup,
  unassignQuestion,
  updateQuestionAssignment,
  fetchDebrief: fetchInstructorDebrief,
  getStudentProgress: getStudentProgress,
  getCompletedSessions,
  runTestDebrief,
  runTestChat,
};

// Keep backward-compatible export
export const mockInstructorDataService = instructorService;