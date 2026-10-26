/**
 * Recommendations Bank Service
 *
 * CRUD and assignment operations for Recommendation items.
 * Calls real backend API endpoints via apiClient.
 */

import { apiClient } from '@/lib/api-client';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface RecommendationItem {
  id: string;                    // UUID
  organizationId: string;        // Parent organization
  title: string;                 // Short descriptive title
  recommendationText: string;    // The expected recommendation
  evaluationCriteria: string;    // How to evaluate student's recommendation
  rationale: string;             // Clinical rationale for this recommendation
  tags: string[];                // Filtering tags (e.g., 'patient_specific')
  isActive: boolean;             // Whether the item is active
  createdAt: string;             // ISO timestamp
}

export interface RecommendationAssignment {
  groupRecommendationId: string;
  recommendationId: string;
  simulationGroupId: string;
  personaId?: string;
  sortOrder: number;
  addedAt: string;
  // Joined fields from recommendations_bank
  title?: string;
  recommendationText?: string;
  evaluationCriteria?: string;
  rationale?: string;
  isActive?: boolean;
}

// ─── Mapping Functions ───────────────────────────────────────────────────────

/**
 * Maps a backend snake_case row to the camelCase RecommendationItem interface.
 */
export function mapBackendToRecommendationItem(row: Record<string, unknown>): RecommendationItem {
  return {
    id: row.recommendation_id as string,
    organizationId: row.organization_id as string,
    title: row.title as string,
    recommendationText: row.recommendation_text as string,
    evaluationCriteria: (row.evaluation_criteria as string) || '',
    rationale: (row.rationale as string) || '',
    tags: (row.tags as string[]) || [],
    isActive: row.is_active !== false,
    createdAt: row.created_at as string,
  };
}

/**
 * Maps a backend snake_case assignment row to the camelCase RecommendationAssignment interface.
 */
function mapBackendToRecommendationAssignment(row: Record<string, unknown>): RecommendationAssignment {
  return {
    groupRecommendationId: row.group_recommendation_id as string,
    recommendationId: row.recommendation_id as string,
    simulationGroupId: row.simulation_group_id as string,
    personaId: row.persona_id as string | undefined,
    sortOrder: (row.sort_order as number) || 0,
    addedAt: row.added_at as string,
    title: row.title as string | undefined,
    recommendationText: row.recommendation_text as string | undefined,
    evaluationCriteria: row.evaluation_criteria as string | undefined,
    rationale: row.rationale as string | undefined,
    isActive: row.is_active as boolean | undefined,
  };
}

// ─── Service Functions ───────────────────────────────────────────────────────

/**
 * List all Recommendation items for a given organization (admin use).
 */
export async function listRecommendationItems(organizationId: string): Promise<RecommendationItem[]> {
  const rows = await apiClient.request<Record<string, unknown>[]>(
    `admin/recommendations_bank?organization_id=${organizationId}`
  );
  return rows.map(mapBackendToRecommendationItem);
}

/**
 * List all active Recommendation items for a given organization (instructor use, read-only).
 */
export async function listRecommendationItemsAsInstructor(organizationId: string): Promise<RecommendationItem[]> {
  const rows = await apiClient.request<Record<string, unknown>[]>(
    `instructor/recommendations_bank?organization_id=${organizationId}`
  );
  return rows.map(mapBackendToRecommendationItem);
}

/**
 * Create a new Recommendation item for an organization.
 */
export async function createRecommendationItem(
  organizationId: string,
  data: Omit<RecommendationItem, 'id' | 'organizationId' | 'createdAt' | 'isActive'> & { tags?: string[] }
): Promise<RecommendationItem> {
  const row = await apiClient.request<Record<string, unknown>>(
    `admin/recommendations_bank?organization_id=${organizationId}`,
    {
      method: 'POST',
      body: {
        title: data.title,
        recommendation_text: data.recommendationText,
        evaluation_criteria: data.evaluationCriteria || null,
        rationale: data.rationale || null,
        tags: data.tags || [],
      },
    }
  );
  return mapBackendToRecommendationItem(row);
}

/**
 * Update an existing Recommendation item.
 */
export async function updateRecommendationItem(
  organizationId: string,
  itemId: string,
  data: Partial<Pick<RecommendationItem, 'title' | 'recommendationText' | 'evaluationCriteria' | 'rationale' | 'tags' | 'isActive'>>
): Promise<RecommendationItem> {
  const row = await apiClient.request<Record<string, unknown>>(
    `admin/recommendations_bank?organization_id=${encodeURIComponent(organizationId)}&recommendation_id=${encodeURIComponent(itemId)}`,
    {
      method: 'PUT',
      body: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.recommendationText !== undefined && { recommendation_text: data.recommendationText }),
        ...(data.evaluationCriteria !== undefined && { evaluation_criteria: data.evaluationCriteria }),
        ...(data.rationale !== undefined && { rationale: data.rationale }),
        ...(data.tags !== undefined && { tags: data.tags }),
        ...(data.isActive !== undefined && { is_active: data.isActive }),
      },
    }
  );
  return mapBackendToRecommendationItem(row);
}

/**
 * Content fields an instructor may submit when creating a Recommendation item.
 */
export interface InstructorRecommendationWriteFields {
  title: string;
  recommendationText: string;
  evaluationCriteria: string;
  rationale: string;
  tags: string[];
}

/**
 * Create a new Recommendation item through the instructor-scoped route.
 *
 * The active flag is deliberately never sent: instructor reads filter on active
 * rows only, so writing that flag would amount to a soft delete.
 */
export async function createRecommendationItemAsInstructor(
  organizationId: string,
  data: InstructorRecommendationWriteFields
): Promise<RecommendationItem> {
  const row = await apiClient.request<Record<string, unknown>>(
    `instructor/recommendations_bank?organization_id=${encodeURIComponent(organizationId)}`,
    {
      method: 'POST',
      body: {
        title: data.title,
        recommendation_text: data.recommendationText,
        evaluation_criteria: data.evaluationCriteria,
        rationale: data.rationale,
        tags: data.tags,
      },
    }
  );
  return mapBackendToRecommendationItem(row);
}

/**
 * Update an existing Recommendation item through the instructor-scoped route.
 *
 * Each content field is included only when defined, so an omitted field keeps
 * its stored value server-side. The active flag is never sent.
 */
export async function updateRecommendationItemAsInstructor(
  itemId: string,
  data: Partial<InstructorRecommendationWriteFields>
): Promise<RecommendationItem> {
  const row = await apiClient.request<Record<string, unknown>>(
    `instructor/recommendations_bank?recommendation_id=${encodeURIComponent(itemId)}`,
    {
      method: 'PUT',
      body: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.recommendationText !== undefined && { recommendation_text: data.recommendationText }),
        ...(data.evaluationCriteria !== undefined && { evaluation_criteria: data.evaluationCriteria }),
        ...(data.rationale !== undefined && { rationale: data.rationale }),
        ...(data.tags !== undefined && { tags: data.tags }),
      },
    }
  );
  return mapBackendToRecommendationItem(row);
}

/**
 * Delete a Recommendation item by ID.
 */
export async function deleteRecommendationItem(organizationId: string, itemId: string): Promise<void> {
  await apiClient.request(`admin/recommendations_bank?organization_id=${encodeURIComponent(organizationId)}&recommendation_id=${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
  });
}

/**
 * Assign a Recommendation item to an entire simulation group (group-level assignment).
 */
export async function assignRecommendationToGroup(
  recommendationId: string,
  simulationGroupId: string
): Promise<RecommendationAssignment> {
  const row = await apiClient.request<Record<string, unknown>>(
    `instructor/simulation_group_recommendations?simulation_group_id=${simulationGroupId}`,
    {
      method: 'POST',
      body: { recommendation_id: recommendationId },
    }
  );
  return mapBackendToRecommendationAssignment(row);
}

/**
 * Assign a Recommendation item to a specific patient within a simulation group.
 */
export async function assignRecommendationToPatient(
  recommendationId: string,
  simulationGroupId: string,
  patientId: string
): Promise<RecommendationAssignment> {
  const row = await apiClient.request<Record<string, unknown>>(
    `instructor/simulation_group_recommendations?simulation_group_id=${simulationGroupId}`,
    {
      method: 'POST',
      body: { recommendation_id: recommendationId, persona_id: patientId },
    }
  );
  return mapBackendToRecommendationAssignment(row);
}

/**
 * Retrieve Recommendation assignments for a simulation group, optionally filtered by persona.
 * Returns items in sort order.
 */
export async function getAssignedRecommendations(
  simulationGroupId: string,
  patientId?: string
): Promise<RecommendationAssignment[]> {
  let endpoint = `instructor/simulation_group_recommendations?simulation_group_id=${simulationGroupId}`;
  if (patientId) {
    endpoint += `&persona_id=${patientId}`;
  }
  const rows = await apiClient.request<Record<string, unknown>[]>(endpoint);
  return rows.map(mapBackendToRecommendationAssignment);
}

/**
 * Reorder Recommendation assignments within a simulation group.
 * Accepts an array of {group_recommendation_id, sort_order} pairs.
 */
export async function reorderRecommendations(
  simulationGroupId: string,
  order: Array<{ group_recommendation_id: string; sort_order: number }>
): Promise<RecommendationAssignment[]> {
  const rows = await apiClient.request<Record<string, unknown>[]>(
    `instructor/simulation_group_recommendations?simulation_group_id=${simulationGroupId}`,
    {
      method: 'PUT',
      body: { order },
    }
  );
  return rows.map(mapBackendToRecommendationAssignment);
}

/**
 * Unassign a Recommendation from a simulation group by its assignment record ID.
 */
export async function unassignRecommendation(groupRecommendationId: string): Promise<void> {
  await apiClient.request(
    `instructor/simulation_group_recommendations?group_recommendation_id=${encodeURIComponent(groupRecommendationId)}`,
    { method: 'DELETE' }
  );
}
