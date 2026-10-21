const { Pool } = require('pg');
const { getCorsHeaders } = require('./cors.js');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Always verify the server certificate (matches lib/lib.js); never depend on NODE_ENV.
      ssl: { rejectUnauthorized: true }
    });
  }
  return pool;
}

exports.getPatientContext = async (event, context) => {
  const requestId = context?.awsRequestId || "unknown";
  const { simulation_group_id, patient_id } = event.queryStringParameters;

  console.log(JSON.stringify({ level: "INFO", requestId, message: "getPatientContext invoked", simulation_group_id, patient_id }));

  if (!simulation_group_id || !patient_id) {
    console.log(JSON.stringify({ level: "WARN", requestId, message: "Missing required parameters", simulation_group_id, patient_id }));
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: "Missing required parameters" })
    };
  }

  try {
    const client = getPool();

    // Get system prompt
    const systemPromptQuery = `
      SELECT system_prompt 
      FROM "simulation_groups" 
      WHERE simulation_group_id = $1
    `;
    const systemPromptResult = await client.query(systemPromptQuery, [simulation_group_id]);

    // Get patient details
    const patientQuery = `
      SELECT patient_name, patient_age, patient_prompt, llm_completion
      FROM "patients" 
      WHERE patient_id = $1
    `;
    const patientResult = await client.query(patientQuery, [patient_id]);

    if (systemPromptResult.rows.length === 0 || patientResult.rows.length === 0) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: "Patient or simulation group not found" })
      };
    }

    const context = {
      system_prompt: systemPromptResult.rows[0].system_prompt,
      patient_name: patientResult.rows[0].patient_name,
      patient_age: patientResult.rows[0].patient_age,
      patient_prompt: patientResult.rows[0].patient_prompt,
      llm_completion: patientResult.rows[0].llm_completion
    };

    console.log(JSON.stringify({ level: "INFO", requestId, message: "Patient context fetched successfully", simulation_group_id, patient_id }));

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify(context)
    };

  } catch (error) {
    console.error(JSON.stringify({ level: "ERROR", requestId, message: "Error fetching patient context", error: error.message, stack: error.stack, simulation_group_id, patient_id }));
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: "Internal server error" })
    };
  }
};