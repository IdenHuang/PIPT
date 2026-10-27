/**
 * Authoritative persona/system prompt for a voice session.
 *
 * The voice agent's prompt must come from the server, never from the socket
 * client. This fetches GET /student/patient_context (studentFunction verifies
 * enrollment and that the persona belongs to the group) and fails closed: a
 * missing input, a non-2xx response, a network error or an unusable body all
 * return { ok: false } so the caller can end the session. There is deliberately
 * no fallback to client-supplied values.
 *
 * @param {object} args
 * @param {string|undefined} args.endpoint - API Gateway stage URL (TEXT_GENERATION_ENDPOINT)
 * @param {unknown} args.simulationGroupId
 * @param {unknown} args.patientId
 * @param {unknown} args.token - verified Cognito ID token from the socket handshake
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<
 *   | { ok: true, context: { patient_name: string, patient_prompt: string, system_prompt: string, llm_completion: boolean } }
 *   | { ok: false, reason: string }
 * >}
 */
async function fetchPatientContext(
  { endpoint, simulationGroupId, patientId, token },
  fetchImpl = fetch,
) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    return { ok: false, reason: "endpoint_not_configured" };
  }
  if (
    typeof simulationGroupId !== "string" || simulationGroupId.length === 0 ||
    typeof patientId !== "string" || patientId.length === 0
  ) {
    return { ok: false, reason: "missing_ids" };
  }
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "missing_token" };
  }

  const base = endpoint.replace(/\/+$/, "");
  const url =
    `${base}/student/patient_context` +
    `?simulation_group_id=${encodeURIComponent(simulationGroupId)}` +
    `&patient_id=${encodeURIComponent(patientId)}`;

  let body;
  try {
    const resp = await fetchImpl(url, { headers: { Authorization: token } });
    if (!resp.ok) {
      return { ok: false, reason: `http_${resp.status}` };
    }
    body = await resp.json();
  } catch {
    return { ok: false, reason: "fetch_error" };
  }

  if (!body || typeof body !== "object") {
    return { ok: false, reason: "invalid_body" };
  }

  // A 200 from the handler always carries the persona row; anything without a
  // persona name is not a patient_context response.
  if (typeof body.persona_name !== "string" || body.persona_name.length === 0) {
    return { ok: false, reason: "invalid_body" };
  }

  // Voice mode prefers the voice-specific persona prompt. An instructor may
  // leave both empty; that is still server-authored, so it is not an error.
  const patientPrompt = body.voice_persona_prompt || body.persona_prompt || "";

  return {
    ok: true,
    context: {
      // studentFunction returns the name as persona_name.
      patient_name: body.persona_name,
      patient_prompt: typeof patientPrompt === "string" ? patientPrompt : "",
      system_prompt: typeof body.system_prompt === "string" ? body.system_prompt : "",
      llm_completion: body.llm_completion === true,
    },
  };
}

module.exports = { fetchPatientContext };
