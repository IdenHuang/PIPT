/**
 * Admin API Service
 * 
 * Calls real backend admin API endpoints via API Gateway.
 * Falls back gracefully if API calls fail (for local dev without backend).
 * 
 * Backend endpoints used:
 * - GET  /admin/instructors → list all instructors
 * - GET  /admin/simulation_groups → list all simulation groups
 * - GET  /admin/groupInstructors?simulation_group_id=... → instructors for a group
 * - GET  /admin/instructorGroups?instructor_id=... → groups for an instructor
 * - POST /admin/elevate_instructor (body: {email}) → make user an instructor
 * - POST /admin/lower_instructor (body: {email}) → demote instructor to student
 * - POST /admin/enroll_instructor?simulation_group_id=... (body: {instructor_email}) → assign to group
 * - DELETE /admin/delete_instructor_enrolments (body: {instructor_email}) → remove all enrollments
 * - DELETE /admin/delete_group_instructor_enrolments?simulation_group_id=... → remove all instructors from group
 * - POST /admin/create_simulation_group → create new group
 * - DELETE /admin/delete_group?simulation_group_id=... → delete group
 * - POST /admin/updateGroupAccess → update group settings
 */

import { apiClient } from '@/lib/api-client';
import type { QuestionBankItem } from '@/services/instructorService';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface AdminInstructor {
  user_id: string;
  user_email: string;
  first_name: string;
  last_name: string;
}

export interface RegisteredUser {
  user_id: string;
  user_email: string;
  first_name: string;
  last_name: string;
  roles: string[];
}

export interface AdminSimulationGroup {
  simulation_group_id: string;
  group_name: string;
  group_description: string;
  group_access_code: string;
  group_student_access: boolean;
  system_prompt: string;
  max_messages_per_chat: number | null;
  // admin_voice_enabled: boolean;      // uncomment after migration 005 runs
  // instructor_voice_enabled: boolean;  // uncomment after migration 005 runs
  organization_id?: string;
  persona_count?: number;
  student_count?: number;
  instructor_count?: number;
}

export interface InstructorGroup {
  simulation_group_id: string;
  group_name: string;
  group_description: string;
}

// ─── API Functions ───────────────────────────────────────────────────────────

/**
 * Get all registered non-admin users with their roles.
 * Used by the Configuration page to display users and manage instructor elevation.
 */
export async function getAllUsers(): Promise<RegisteredUser[]> {
  return apiClient.request<RegisteredUser[]>('admin/users');
}

/**
 * Get all users with the instructor role
 */
export async function getAllInstructors(): Promise<AdminInstructor[]> {
  return apiClient.request<AdminInstructor[]>(`admin/instructors`);
}

/**
 * Get all simulation groups, optionally filtered by organization
 */
export async function getAllSimulationGroups(organizationId?: string): Promise<AdminSimulationGroup[]> {
  const query = organizationId
    ? `admin/simulation_groups?organization_id=${encodeURIComponent(organizationId)}`
    : 'admin/simulation_groups';
  return apiClient.request<AdminSimulationGroup[]>(query);
}

/**
 * Get a single simulation group by ID (fetches all and filters).
 */
export async function getSimulationGroup(groupId: string): Promise<AdminSimulationGroup | undefined> {
  const groups = await getAllSimulationGroups();
  return groups.find(g => g.simulation_group_id === groupId);
}

/**
 * Get instructors enrolled in a specific simulation group
 */
export async function getGroupInstructors(simulationGroupId: string): Promise<AdminInstructor[]> {
  return apiClient.request<AdminInstructor[]>(
    `admin/groupInstructors?simulation_group_id=${encodeURIComponent(simulationGroupId)}`
  );
}

/**
 * Get simulation groups an instructor is enrolled in
 */
export async function getInstructorGroups(instructorIdOrEmail: string): Promise<InstructorGroup[]> {
  // If it looks like a UUID, send as instructor_id; otherwise fall back to instructor_email
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instructorIdOrEmail);
  const param = isUuid
    ? `instructor_id=${encodeURIComponent(instructorIdOrEmail)}`
    : `instructor_email=${encodeURIComponent(instructorIdOrEmail)}`;
  return apiClient.request<InstructorGroup[]>(
    `admin/instructorGroups?${param}`
  );
}

/**
 * Elevate a user to instructor role. If the user doesn't exist, creates them as instructor.
 */
export async function elevateToInstructor(email: string): Promise<{ message: string }> {
  return apiClient.request<{ message: string }>(
    `admin/elevate_instructor`,
    { method: 'POST', body: { email } }
  );
}

/**
 * Demote an instructor back to student role and remove all instructor enrollments.
 */
export async function lowerInstructor(email: string): Promise<{ message: string }> {
  return apiClient.request<{ message: string }>(
    `admin/lower_instructor`,
    { method: 'POST', body: { email } }
  );
}

/**
 * Elevate an instructor to admin role.
 */
export async function elevateToAdmin(email: string): Promise<{ message: string }> {
  return apiClient.request<{ message: string }>(
    `admin/elevate_admin`,
    { method: 'POST', body: { email } }
  );
}

/**
 * Demote an admin back to instructor role.
 */
export async function lowerAdmin(email: string): Promise<{ message: string }> {
  return apiClient.request<{ message: string }>(
    `admin/lower_admin`,
    { method: 'POST', body: { email } }
  );
}

/**
 * Enroll an instructor in a simulation group.
 * This also creates student_interactions for all patients in the group.
 */
export async function enrollInstructorInGroup(
  simulationGroupId: string,
  instructorEmail: string
): Promise<{ message: string }> {
  return apiClient.request<{ message: string }>(
    `admin/enroll_instructor?simulation_group_id=${encodeURIComponent(simulationGroupId)}`,
    { method: 'POST', body: { instructor_email: instructorEmail } }
  );
}

/**
 * Remove all instructor enrollments for a specific instructor (across all groups).
 */
export async function deleteInstructorEnrollments(instructorEmail: string): Promise<{ message: string }> {
  return apiClient.request<{ message: string }>(
    `admin/delete_instructor_enrolments`,
    { method: 'DELETE', body: { instructor_email: instructorEmail } }
  );
}

/**
 * Remove all instructor enrollments from a specific group.
 */
export async function deleteGroupInstructorEnrollments(simulationGroupId: string): Promise<{ message: string }> {
  return apiClient.request<{ message: string }>(
    `admin/delete_group_instructor_enrolments?simulation_group_id=${encodeURIComponent(simulationGroupId)}`,
    { method: 'DELETE' }
  );
}

/**
 * Add an instructor to a simulation group.
 * Combines elevate (if needed) + enroll in one call sequence.
 */
export async function addInstructorToGroup(
  simulationGroupId: string,
  instructorEmail: string
): Promise<void> {
  // First ensure the user has the instructor role
  await elevateToInstructor(instructorEmail);
  // Then enroll them in the group
  await enrollInstructorInGroup(simulationGroupId, instructorEmail);
}

/**
 * Remove an instructor from a specific simulation group.
 * This removes their enrollment but keeps their instructor role.
 * 
 * Note: The backend doesn't have a single-group unenroll endpoint,
 * so we delete all instructor enrollments and re-enroll in remaining groups.
 * TODO: Add a targeted DELETE /admin/unenroll_instructor endpoint to the backend.
 */
export async function removeInstructorFromGroup(
  simulationGroupId: string,
  instructorEmail: string
): Promise<void> {
  // Get all groups this instructor is in
  const groups = await getInstructorGroups(instructorEmail);
  const remainingGroups = groups.filter(g => g.simulation_group_id !== simulationGroupId);

  // Delete all instructor enrollments
  await deleteInstructorEnrollments(instructorEmail);

  // Re-enroll in remaining groups
  for (const group of remainingGroups) {
    await enrollInstructorInGroup(group.simulation_group_id, instructorEmail);
  }
}

/**
 * Create a new simulation group
 */
export async function createSimulationGroup(params: {
  group_name: string;
  group_description: string;
  group_student_access: boolean;
  system_prompt: string;
  organization_id?: string;
  // admin_voice_enabled?: boolean;      // uncomment after migration 005 runs
  // instructor_voice_enabled?: boolean;  // uncomment after migration 005 runs
}): Promise<AdminSimulationGroup> {
  return apiClient.request<AdminSimulationGroup>(
    `admin/create_simulation_group`,
    {
      method: 'POST',
      body: {
        group_name: params.group_name,
        group_description: params.group_description,
        group_student_access: params.group_student_access,
        system_prompt: params.system_prompt,
        ...(params.organization_id && { organization_id: params.organization_id }),
        // ...(params.admin_voice_enabled !== undefined && { admin_voice_enabled: params.admin_voice_enabled }),
        // ...(params.instructor_voice_enabled !== undefined && { instructor_voice_enabled: params.instructor_voice_enabled }),
      },
    }
  );
}

/**
 * Delete a simulation group and all related records (cascading).
 */
export async function deleteSimulationGroup(simulationGroupId: string): Promise<{ message: string }> {
  return apiClient.request<{ message: string }>(
    `admin/delete_group?simulation_group_id=${encodeURIComponent(simulationGroupId)}`,
    { method: 'DELETE' }
  );
}

/**
 * Update group settings (access, empathy, voice).
 */
export async function updateGroupAccess(params: {
  simulation_group_id: string;
  access: boolean;
  // admin_voice_enabled?: boolean;      // uncomment after migration 005 runs
  // instructor_voice_enabled?: boolean;  // uncomment after migration 005 runs
}): Promise<{ message: string }> {
  const queryParams = new URLSearchParams({
    simulation_group_id: params.simulation_group_id,
    access: String(params.access),
    // ...(params.admin_voice_enabled !== undefined && { admin_voice_enabled: String(params.admin_voice_enabled) }),
    // ...(params.instructor_voice_enabled !== undefined && { instructor_voice_enabled: String(params.instructor_voice_enabled) }),
  });

  return apiClient.request<{ message: string }>(
    `admin/updateGroupAccess?${queryParams.toString()}`,
    { method: 'POST' }
  );
}

/**
 * Regenerate the access code for a simulation group.
 */
export async function regenerateAccessCode(simulationGroupId: string): Promise<{ access_code: string }> {
  return apiClient.request<{ access_code: string }>(
    `admin/regenerate_access_code?simulation_group_id=${encodeURIComponent(simulationGroupId)}`,
    { method: 'POST' }
  );
}

/**
 * Update the message limit for a simulation group.
 * Pass null for unlimited messages.
 */
export async function updateGroupMessageLimit(
  simulationGroupId: string,
  maxMessagesPerChat: number | null
): Promise<{ message: string; max_messages_per_chat: number | null }> {
  return apiClient.request<{ message: string; max_messages_per_chat: number | null }>(
    `admin/update_group_message_limit?simulation_group_id=${encodeURIComponent(simulationGroupId)}`,
    {
      method: 'POST',
      body: { max_messages_per_chat: maxMessagesPerChat },
    }
  );
}


// ─── Organization API Functions ──────────────────────────────────────────────

export interface AdminOrganization {
  organization_id: string;
  name: string;
  description: string | null;
  type: string | null;
  ai_persona: string;
  user_role: string;
  icon_color: string;
  system_prompt: string | null;
  created_at: string;
}

/**
 * Get all organizations
 */
export async function getOrganizations(): Promise<AdminOrganization[]> {
  return apiClient.request<AdminOrganization[]>('admin/organizations');
}

/**
 * Get a single organization by ID
 */
export async function getOrganization(organizationId: string): Promise<AdminOrganization> {
  return apiClient.request<AdminOrganization>(
    `admin/organization?organization_id=${encodeURIComponent(organizationId)}`
  );
}

/**
 * Create a new organization
 */
export async function createOrganization(params: {
  name: string;
  description?: string;
  type?: string;
  ai_persona?: string;
  user_role?: string;
  icon_color?: string;
  system_prompt?: string;
}): Promise<AdminOrganization> {
  return apiClient.request<AdminOrganization>('admin/create_organization', {
    method: 'POST',
    body: params,
  });
}

/**
 * Update an existing organization
 */
export async function updateOrganization(
  organizationId: string,
  params: {
    name?: string;
    description?: string;
    type?: string;
    ai_persona?: string;
    user_role?: string;
    icon_color?: string;
    system_prompt?: string;
  }
): Promise<AdminOrganization> {
  return apiClient.request<AdminOrganization>(
    `admin/update_organization?organization_id=${encodeURIComponent(organizationId)}`,
    {
      method: 'PUT',
      body: params,
    }
  );
}

/**
 * Delete an organization and all related records (cascading).
 */
export async function deleteOrganization(organizationId: string): Promise<{ message: string }> {
  return apiClient.request<{ message: string }>(
    `admin/delete_organization?organization_id=${encodeURIComponent(organizationId)}`,
    { method: 'DELETE' }
  );
}


// ─── Question Bank API Functions ─────────────────────────────────────────────

/**
 * Map a snake_case backend question_bank row to a camelCase QuestionBankItem.
 */
export function mapBackendToQuestionBankItem(row: any): QuestionBankItem {
  return {
    id: row.question_id,
    title: row.title,
    questionText: row.question_text,
    clinicalIntent: row.clinical_intent || '',
    evaluationCriteria: row.evaluation_criteria,
    category: row.category,
    difficultyLevel: row.difficulty_level,
    isMandatory: row.is_mandatory ?? false,
    weight: row.weight,
    maxScore: row.max_score,
    isActive: row.is_active ?? true,
    tags: Array.isArray(row.tags) ? row.tags : [],
    usedBySimulationGroups: [],
  };
}

/**
 * Get all question bank questions for an organization.
 */
export async function getQuestionBankQuestions(organizationId: string): Promise<QuestionBankItem[]> {
  const rows = await apiClient.request<any[]>(
    `admin/question_bank?organization_id=${encodeURIComponent(organizationId)}`
  );
  return rows.map(mapBackendToQuestionBankItem);
}

/**
 * Create a new question bank question for an organization.
 * created_by is derived server-side from the authorizer context (Cognito sub).
 */
export async function createQuestionBankQuestion(
  organizationId: string,
  questionData: any
): Promise<QuestionBankItem> {
  const row = await apiClient.request<any>(
    `admin/question_bank?organization_id=${encodeURIComponent(organizationId)}`,
    {
      method: 'POST',
      body: questionData,
    }
  );
  return mapBackendToQuestionBankItem(row);
}

/**
 * Update an existing question bank question.
 */
export async function updateQuestionBankQuestion(
  organizationId: string,
  questionId: string,
  questionData: any
): Promise<QuestionBankItem> {
  const row = await apiClient.request<any>(
    `admin/question_bank?organization_id=${encodeURIComponent(organizationId)}&question_id=${encodeURIComponent(questionId)}`,
    {
      method: 'PUT',
      body: questionData,
    }
  );
  return mapBackendToQuestionBankItem(row);
}

/**
 * Delete (soft-delete) a question bank question.
 */
export async function deleteQuestionBankQuestion(
  organizationId: string,
  questionId: string
): Promise<{ message: string }> {
  return apiClient.request<{ message: string }>(
    `admin/question_bank?organization_id=${encodeURIComponent(organizationId)}&question_id=${encodeURIComponent(questionId)}`,
    { method: 'DELETE' }
  );
}

// ─── Threshold Configuration ─────────────────────────────────────────────────

export interface ThresholdConfig {
  key_question_threshold: number | null;
  dtp_threshold: number | null;
  recommendation_threshold: number | null;
}

/**
 * Get the matching thresholds configured for an organization.
 * NULL values indicate "use system default (0.55)".
 */
export async function getOrganizationThresholds(organizationId: string): Promise<ThresholdConfig> {
  return apiClient.request<ThresholdConfig>(
    `admin/organization_thresholds?organization_id=${encodeURIComponent(organizationId)}`
  );
}

/**
 * Update matching thresholds for an organization.
 * Supports partial updates — only provided fields are changed.
 * Pass explicit null to reset a threshold to default behavior.
 */
export async function updateOrganizationThresholds(
  organizationId: string,
  params: Partial<ThresholdConfig>
): Promise<ThresholdConfig> {
  return apiClient.request<ThresholdConfig>(
    `admin/organization_thresholds?organization_id=${encodeURIComponent(organizationId)}`,
    {
      method: 'PUT',
      body: params,
    }
  );
}

// ─── Issue Reports & Debrief Feedback ────────────────────────────────────────

export interface IssueReport {
  report_id: string;
  simulation_group_id: string;
  persona_id: string;
  chat_id: string;
  user_id: string;
  issue_categories: string[];
  details: string | null;
  submitted_at: string;
  student_email: string | null;
  student_first_name: string | null;
  student_last_name: string | null;
  patient_name: string | null;
}

export interface DebriefFeedback {
  feedback_id: string;
  simulation_group_id: string;
  persona_id: string;
  chat_id: string;
  user_id: string;
  is_helpful: boolean;
  comment: string | null;
  submitted_at: string;
  student_email: string | null;
  student_first_name: string | null;
  student_last_name: string | null;
  patient_name: string | null;
}

/**
 * Get all issue reports for a simulation group.
 */
export async function getIssueReports(
  simulationGroupId: string
): Promise<IssueReport[]> {
  return apiClient.request<IssueReport[]>(
    `admin/issue_reports?simulation_group_id=${encodeURIComponent(simulationGroupId)}`
  );
}

/**
 * Delete an issue report by ID.
 */
export async function deleteIssueReport(
  reportId: string
): Promise<{ message: string }> {
  return apiClient.request<{ message: string }>(
    `admin/issue_report?report_id=${encodeURIComponent(reportId)}`,
    { method: 'DELETE' }
  );
}

/**
 * Get all debrief feedback for a simulation group.
 */
export async function getDebriefFeedback(
  simulationGroupId: string
): Promise<DebriefFeedback[]> {
  return apiClient.request<DebriefFeedback[]>(
    `admin/debrief_feedback?simulation_group_id=${encodeURIComponent(simulationGroupId)}`
  );
}

/**
 * Delete a debrief feedback entry by ID.
 */
export async function deleteDebriefFeedback(
  feedbackId: string
): Promise<{ message: string }> {
  return apiClient.request<{ message: string }>(
    `admin/debrief_feedback?feedback_id=${encodeURIComponent(feedbackId)}`,
    { method: 'DELETE' }
  );
}
