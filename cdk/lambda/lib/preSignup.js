const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const ssmClient = new SSMClient();
let cachedAllowedDomains = null;

async function getAllowedDomains() {
  if (!cachedAllowedDomains) {
    const parameterName = process.env.ALLOWED_EMAIL_DOMAINS;
    const data = await ssmClient.send(
      new GetParameterCommand({ Name: parameterName, WithDecryption: true })
    );
    cachedAllowedDomains = data.Parameter.Value.split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }
  return cachedAllowedDomains;
}

/**
 * Returns the lowercased domain of an address with exactly one "@" and a
 * non-empty local part and domain, or null. Taking split("@")[1] would let
 * "x@allowed.edu@evil.com" pass as allowed.edu.
 * @param {unknown} email
 * @returns {string|null}
 */
function extractEmailDomain(email) {
  if (typeof email !== "string") return null;
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return parts[1];
}

exports.handler = async (event, context) => {
  const requestId = context?.awsRequestId || "unknown";

  try {
    const allowedDomains = await getAllowedDomains();
    const emailDomain = extractEmailDomain(event.request.userAttributes.email);

    if (!emailDomain || !allowedDomains.includes(emailDomain)) {
      console.error(JSON.stringify({ level: "WARN", requestId, message: "Signup blocked for disallowed domain", emailDomain }));
      throw new Error(`Signup not allowed for email domain: ${emailDomain}`);
    }

    console.log(JSON.stringify({ level: "INFO", requestId, message: "Pre-signup validation passed", emailDomain }));
    return event;
  } catch (error) {
    console.error(JSON.stringify({ level: "ERROR", requestId, message: "Pre-signup validation failed", error: error.message }));
    throw new Error("Error validating email domain during pre-signup.");
  }
};

// Exported for unit testing
exports._extractEmailDomain = extractEmailDomain;
