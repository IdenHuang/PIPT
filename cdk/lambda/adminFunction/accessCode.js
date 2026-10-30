const crypto = require("crypto");

const ACCESS_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Generates a simulation-group access code using a CSPRNG.
 * crypto.randomInt draws from the OS secure random source and is free of
 * modulo bias, unlike Math.random().
 * https://nodejs.org/api/crypto.html#cryptorandomintmin-max-callback
 *
 * @param {number} length - Number of code characters (excluding dashes)
 * @returns {string} Code grouped in blocks of 4, e.g. "ABCD-EFGH"
 */
function generateAccessCode(length) {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += ACCESS_CODE_ALPHABET[crypto.randomInt(ACCESS_CODE_ALPHABET.length)];
  }
  return code.match(/.{1,4}/g).join("-");
}

module.exports = { generateAccessCode };
