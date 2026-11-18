/**
 * Preservation Property Tests for Instructor Function Database Refactor
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10**
 *
 * This test verifies that non-buggy database operations continue to work correctly.
 * These tests should PASS on UNFIXED code (confirming baseline behavior to preserve).
 *
 * These endpoints use CORRECT naming and should continue working after the fix:
 * - GET /instructor/groups
 * - GET /instructor/view_students
 * - DELETE /instructor/delete_student
 * - GET /instructor/get_prompt
 * - PUT /instructor/prompt
 * - GET /instructor/get_access_code
 * - PUT /instructor/generate_access_code
 * - GET /instructor/get_completion_status
 * - PUT /instructor/toggle_completion
 * - POST /instructor/create_simulation_group
 * - POST /instructor/update_voice_settings
 * - GET /instructor/view_patients
 * - DELETE /instructor/delete_patient
 */

import * as fs from 'fs';
import * as path from 'path';
import * as fc from 'fast-check';

describe('Preservation Property: Non-Buggy Database Operations', () => {
  let instructorFunctionCode: string;

  beforeAll(() => {
    const filePath = path.join(__dirname, '../lambda/lib/instructorFunction.js');
    instructorFunctionCode = fs.readFileSync(filePath, 'utf-8');
  });

  /**
   * Helper: extract the FULL code block for a given endpoint.
   * Uses the switch case labels to delimit endpoint boundaries.
   */
  function getEndpointCode(endpoint: string): string | null {
    const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match from this case label to the next case label or the default/end of switch
    const pattern = new RegExp(
      `case "${escaped}":[\\s\\S]*?(?=\\n\\s*case "|\\n\\s*default:)`,
    );
    const match = instructorFunctionCode.match(pattern);
    return match ? match[0] : null;
  }

  // ─── Individual endpoint preservation tests ───

  describe('GET /instructor/groups - correct table/column naming (Req 3.1, 3.2)', () => {
    test('queries users, enrollments, simulation_groups with correct columns', () => {
      const code = getEndpointCode('GET /instructor/groups');
      expect(code).toBeTruthy();

      expect(code).toContain('"users"');
      expect(code).toContain('"enrollments"');
      expect(code).toContain('"simulation_groups"');
      expect(code).toContain('user_email');
      expect(code).toContain('user_id');
      expect(code).toContain('simulation_group_id');
      expect(code).toContain('enrollment_type');

      expect(code).not.toContain('"sessions"');
    });
  });

  describe('GET /instructor/view_students - correct table/column naming (Req 3.1, 3.3)', () => {
    test('queries enrollments and users with correct columns', () => {
      const code = getEndpointCode('GET /instructor/view_students');
      expect(code).toBeTruthy();

      expect(code).toContain('"enrollments"');
      expect(code).toContain('"users"');
      expect(code).toContain('simulation_group_id');
      expect(code).toContain('enrollment_type');
      expect(code).toContain('user_email');

      expect(code).not.toContain('"sessions"');
    });
  });

  describe('DELETE /instructor/delete_student - correct naming and engagement log (Req 3.4, 3.6, 3.8)', () => {
    test('deletes from enrollments and logs to user_engagement_log with correct columns', () => {
      const code = getEndpointCode('DELETE /instructor/delete_student');
      expect(code).toBeTruthy();

      expect(code).toContain('"users"');
      expect(code).toContain('"enrollments"');
      expect(code).toContain('"user_engagement_log"');
      expect(code).toContain('user_email');
      expect(code).toContain('user_id');
      expect(code).toContain('simulation_group_id');
      expect(code).toContain('enrollment_type');

      // user_engagement_log INSERT uses persona_id column (set to null here, which is correct)
      const engagementInsert = code!.match(
        /INSERT INTO "user_engagement_log"[\s\S]*?;/,
      );
      expect(engagementInsert).toBeTruthy();
      expect(engagementInsert![0]).toContain('persona_id');

      expect(code).not.toContain('"sessions"');
    });
  });

  describe('GET /instructor/get_prompt - correct table naming (Req 3.1, 3.2)', () => {
    test('queries simulation_groups for system_prompt', () => {
      const code = getEndpointCode('GET /instructor/get_prompt');
      expect(code).toBeTruthy();

      expect(code).toContain('"simulation_groups"');
      expect(code).toContain('system_prompt');
      expect(code).toContain('simulation_group_id');

      expect(code).not.toContain('"sessions"');
      expect(code).not.toContain('patient_id');
    });
  });

  describe('PUT /instructor/prompt - correct naming and engagement log (Req 3.1, 3.6, 3.7)', () => {
    test('updates simulation_groups and logs to user_engagement_log', () => {
      const code = getEndpointCode('PUT /instructor/prompt');
      expect(code).toBeTruthy();

      expect(code).toContain('"simulation_groups"');
      expect(code).toContain('"user_engagement_log"');
      expect(code).toContain('"users"');
      expect(code).toContain('system_prompt');
      expect(code).toContain('simulation_group_id');
      expect(code).toContain('user_email');
      expect(code).toContain('engagement_type');
      expect(code).toContain('engagement_details');

      expect(code).not.toContain('"sessions"');
    });

    test('user_engagement_log INSERT uses persona_id column name (fixed code)', () => {
      const code = getEndpointCode('PUT /instructor/prompt');
      expect(code).toBeTruthy();

      // After fix: the prompt endpoint INSERT references persona_id column in engagement log
      const engagementInsert = code!.match(
        /INSERT INTO "user_engagement_log"[\s\S]*?;/,
      );
      expect(engagementInsert).toBeTruthy();
      // After fix, the column list uses persona_id
      expect(engagementInsert![0]).toContain('persona_id');
    });
  });

  describe('GET /instructor/get_access_code - correct table naming (Req 3.1)', () => {
    test('queries simulation_groups for group_access_code', () => {
      const code = getEndpointCode('GET /instructor/get_access_code');
      expect(code).toBeTruthy();

      expect(code).toContain('"simulation_groups"');
      expect(code).toContain('group_access_code');
      expect(code).toContain('simulation_group_id');

      expect(code).not.toContain('"sessions"');
      expect(code).not.toContain('patient_id');
    });
  });

  describe('PUT /instructor/generate_access_code - correct table naming (Req 3.1, 3.7)', () => {
    test('updates simulation_groups with new access code', () => {
      const code = getEndpointCode('PUT /instructor/generate_access_code');
      expect(code).toBeTruthy();

      expect(code).toContain('"simulation_groups"');
      expect(code).toContain('group_access_code');
      expect(code).toContain('simulation_group_id');

      expect(code).not.toContain('"sessions"');
      expect(code).not.toContain('patient_id');
    });
  });

  describe('GET /instructor/get_completion_status - correct table/column naming (Req 3.1, 3.2)', () => {
    test('queries student_interactions, personas, enrollments with correct columns', () => {
      const code = getEndpointCode('GET /instructor/get_completion_status');
      expect(code).toBeTruthy();

      expect(code).toContain('"users"');
      expect(code).toContain('"student_interactions"');
      expect(code).toContain('"personas"');
      expect(code).toContain('"enrollments"');
      expect(code).toContain('user_email');
      expect(code).toContain('user_id');
      expect(code).toContain('is_completed');
      expect(code).toContain('persona_name');
      expect(code).toContain('persona_id');
      expect(code).toContain('simulation_group_id');

      expect(code).not.toContain('"sessions"');
      expect(code).not.toContain('patient_id');
    });
  });

  describe('PUT /instructor/toggle_completion - correct table/column naming (Req 3.1, 3.7)', () => {
    test('updates student_interactions is_completed field', () => {
      const code = getEndpointCode('PUT /instructor/toggle_completion');
      expect(code).toBeTruthy();

      expect(code).toContain('"student_interactions"');
      expect(code).toContain('is_completed');
      expect(code).toContain('student_interaction_id');

      expect(code).not.toContain('"sessions"');
      expect(code).not.toContain('patient_id');
    });
  });

  describe('POST /instructor/create_simulation_group - correct naming (Req 3.1, 3.5, 3.6)', () => {
    test('inserts into simulation_groups and enrollments with correct columns', () => {
      const code = getEndpointCode('POST /instructor/create_simulation_group');
      expect(code).toBeTruthy();

      expect(code).toContain('"users"');
      expect(code).toContain('"simulation_groups"');
      expect(code).toContain('"enrollments"');
      expect(code).toContain('user_email');
      expect(code).toContain('user_id');
      expect(code).toContain('simulation_group_id');
      expect(code).toContain('group_name');
      expect(code).toContain('group_access_code');
      expect(code).toContain('enrollment_type');

      expect(code).not.toContain('"sessions"');
      expect(code).not.toContain('patient_id');
    });
  });

  describe('POST /instructor/update_voice_settings - correct naming (Req 3.1, 3.7)', () => {
    test('updates simulation_groups instructor_voice_enabled field', () => {
      const code = getEndpointCode('POST /instructor/update_voice_settings');
      expect(code).toBeTruthy();

      expect(code).toContain('"simulation_groups"');
      expect(code).toContain('instructor_voice_enabled');
      expect(code).toContain('simulation_group_id');

      expect(code).not.toContain('"sessions"');
      expect(code).not.toContain('patient_id');
    });
  });

  describe('GET /instructor/view_patients - already uses persona_id (Req 3.1, 3.5)', () => {
    test('queries personas table with persona_id column', () => {
      const code = getEndpointCode('GET /instructor/view_patients');
      expect(code).toBeTruthy();

      expect(code).toContain('"personas"');
      expect(code).toContain('persona_id');
      expect(code).toContain('persona_name');
      expect(code).toContain('persona_age');
      expect(code).toContain('persona_gender');
      expect(code).toContain('persona_prompt');
      expect(code).toContain('simulation_group_id');

      // This endpoint already uses correct naming
      expect(code).not.toContain('patient_id');
      expect(code).not.toContain('"sessions"');
    });
  });

  describe('DELETE /instructor/delete_patient - correct variable naming (Req 3.1, 3.8)', () => {
    test('deletes from personas table using persona_id column', () => {
      const code = getEndpointCode('DELETE /instructor/delete_patient');
      expect(code).toBeTruthy();

      expect(code).toContain('"personas"');
      expect(code).toContain('persona_id');

      // The SQL DELETE uses the correct persona_id column
      const deleteQuery = code!.match(/DELETE FROM "personas"[\s\S]*?;/);
      expect(deleteQuery).toBeTruthy();
      expect(deleteQuery![0]).toContain('persona_id');
    });
  });

  // ─── Structural preservation properties ───

  describe('All preserved endpoints return proper HTTP status codes (Req 3.9)', () => {
    const preservedEndpoints = [
      'GET /instructor/groups',
      'GET /instructor/view_students',
      'DELETE /instructor/delete_student',
      'GET /instructor/get_prompt',
      'PUT /instructor/prompt',
      'GET /instructor/get_access_code',
      'PUT /instructor/generate_access_code',
      'GET /instructor/get_completion_status',
      'PUT /instructor/toggle_completion',
      'POST /instructor/create_simulation_group',
      'POST /instructor/update_voice_settings',
      'GET /instructor/view_patients',
      'DELETE /instructor/delete_patient',
    ];

    test.each(preservedEndpoints)(
      '%s sets response.statusCode for success and error paths',
      (endpoint) => {
        const code = getEndpointCode(endpoint);
        expect(code).toBeTruthy();

        // Every endpoint should set statusCode on success
        expect(code).toMatch(/response\.statusCode\s*=\s*\d+/);
        // Every endpoint should handle errors with 500 or 400
        expect(code).toMatch(/response\.statusCode\s*=\s*(400|500)/);
      },
    );
  });

  describe('All preserved endpoints have error handling (Req 3.10)', () => {
    const preservedEndpoints = [
      'GET /instructor/groups',
      'GET /instructor/view_students',
      'DELETE /instructor/delete_student',
      'GET /instructor/get_prompt',
      'PUT /instructor/prompt',
      'GET /instructor/get_access_code',
      'PUT /instructor/generate_access_code',
      'GET /instructor/get_completion_status',
      'PUT /instructor/toggle_completion',
      'POST /instructor/create_simulation_group',
      'POST /instructor/update_voice_settings',
      'GET /instructor/view_patients',
      'DELETE /instructor/delete_patient',
    ];

    test.each(preservedEndpoints)(
      '%s has try/catch error handling with error response',
      (endpoint) => {
        const code = getEndpointCode(endpoint);
        expect(code).toBeTruthy();

        // Should have try/catch
        expect(code).toContain('try {');
        expect(code).toMatch(/catch\s*\(/);

        // Should return error response
        expect(code).toMatch(/JSON\.stringify\(\{.*error/s);
      },
    );
  });

  describe('All preserved endpoints validate required parameters (Req 3.9)', () => {
    const preservedEndpoints = [
      'GET /instructor/groups',
      'GET /instructor/view_students',
      'DELETE /instructor/delete_student',
      'GET /instructor/get_prompt',
      'PUT /instructor/prompt',
      'GET /instructor/get_access_code',
      'PUT /instructor/generate_access_code',
      'GET /instructor/get_completion_status',
      'PUT /instructor/toggle_completion',
      'POST /instructor/create_simulation_group',
      'POST /instructor/update_voice_settings',
      'GET /instructor/view_patients',
      'DELETE /instructor/delete_patient',
    ];

    test.each(preservedEndpoints)(
      '%s checks queryStringParameters before processing',
      (endpoint) => {
        const code = getEndpointCode(endpoint);
        expect(code).toBeTruthy();

        // Should check for query string parameters
        expect(code).toContain('event.queryStringParameters');
      },
    );
  });

  // ─── Property-Based Tests ───

  describe('Property-Based: Preserved endpoints use only valid schema names', () => {
    const preservedEndpoints = [
      'GET /instructor/groups',
      'GET /instructor/view_students',
      'DELETE /instructor/delete_student',
      'GET /instructor/get_prompt',
      'GET /instructor/get_access_code',
      'PUT /instructor/generate_access_code',
      'GET /instructor/get_completion_status',
      'PUT /instructor/toggle_completion',
      'POST /instructor/create_simulation_group',
      'POST /instructor/update_voice_settings',
      'GET /instructor/view_patients',
    ];

    test('preserved endpoints reference only tables that exist in migrations', () => {
      const validTables = [
        'users',
        'simulation_groups',
        'enrollments',
        'personas',
        'persona_data',
        'student_interactions',
        'chats',
        'messages',
        'user_engagement_log',
        'rubrics',
        'key_questions',
      ];

      fc.assert(
        fc.property(
          fc.constantFrom(...preservedEndpoints),
          (endpoint) => {
            const code = getEndpointCode(endpoint);
            if (!code) return true;

            const tableRefs = Array.from(
              code.matchAll(/(?:FROM|JOIN|INTO|UPDATE|DELETE FROM)\s+"(\w+)"/gi),
            ).map((m) => m[1]);

            return tableRefs.every((table) => validTables.includes(table));
          },
        ),
        { numRuns: 11 },
      );
    });

    test('preserved endpoints use correct column names for joins', () => {
      const validJoinColumns = [
        'user_id',
        'simulation_group_id',
        'enrollment_id',
        'persona_id',
        'student_interaction_id',
        'chat_id',
      ];

      fc.assert(
        fc.property(
          fc.constantFrom(...preservedEndpoints),
          (endpoint) => {
            const code = getEndpointCode(endpoint);
            if (!code) return true;

            const joinConditions = Array.from(
              code.matchAll(/ON\s+\w+\.(\w+)\s*=\s*\w+\.(\w+)/gi),
            );

            return joinConditions.every(
              (m) =>
                validJoinColumns.includes(m[1]) &&
                validJoinColumns.includes(m[2]),
            );
          },
        ),
        { numRuns: 11 },
      );
    });
  });

  describe('Property-Based: Preserved endpoints do not reference sessions table', () => {
    const preservedEndpoints = [
      'GET /instructor/groups',
      'GET /instructor/view_students',
      'DELETE /instructor/delete_student',
      'GET /instructor/get_prompt',
      'PUT /instructor/prompt',
      'GET /instructor/get_access_code',
      'PUT /instructor/generate_access_code',
      'GET /instructor/get_completion_status',
      'PUT /instructor/toggle_completion',
      'POST /instructor/create_simulation_group',
      'POST /instructor/update_voice_settings',
      'GET /instructor/view_patients',
      'DELETE /instructor/delete_patient',
    ];

    test('no preserved endpoint references the non-existent sessions table', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...preservedEndpoints),
          (endpoint) => {
            const code = getEndpointCode(endpoint);
            if (!code) return true;

            const hasSessionsTable = /FROM "sessions"|JOIN "sessions"/.test(code);
            return !hasSessionsTable;
          },
        ),
        { numRuns: 13 },
      );
    });
  });

  describe('Property-Based: Preserved endpoints maintain response structure', () => {
    const preservedEndpoints = [
      'GET /instructor/groups',
      'GET /instructor/view_students',
      'DELETE /instructor/delete_student',
      'GET /instructor/get_prompt',
      'PUT /instructor/prompt',
      'GET /instructor/get_access_code',
      'PUT /instructor/generate_access_code',
      'GET /instructor/get_completion_status',
      'PUT /instructor/toggle_completion',
      'POST /instructor/create_simulation_group',
      'POST /instructor/update_voice_settings',
      'GET /instructor/view_patients',
      'DELETE /instructor/delete_patient',
    ];

    test('every preserved endpoint uses JSON.stringify for response body', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...preservedEndpoints),
          (endpoint) => {
            const code = getEndpointCode(endpoint);
            if (!code) return true;

            return /response\.body\s*=\s*JSON\.stringify/.test(code);
          },
        ),
        { numRuns: 13 },
      );
    });
  });
});
