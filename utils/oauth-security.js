'use strict';

const crypto = require('crypto');

// Headers for the small HTML pages shown by the temporary OAuth callback servers.
// The callback URL carries the authorization code, so it must never leak through
// the Referer header or be cached, framed, or sniffed as another content type.
const HTML_SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"
});

// One-time login session: `state` ties the callback to the login this process
// started (protects against login CSRF), and the PKCE verifier proves the same
// process that started the login is the one redeeming the code.
async function createOAuthSession(oauth2Client) {
  const { codeVerifier, codeChallenge } = await oauth2Client.generateCodeVerifierAsync();
  return {
    state: crypto.randomBytes(32).toString('hex'),
    codeVerifier,
    codeChallenge
  };
}

// Constant-time comparison that is safe for inputs of different lengths.
function secretsMatch(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

// Accept only Host headers that point at this machine's loopback address on the
// expected port. A hostname such as evil.example resolving to 127.0.0.1 (DNS
// rebinding) is therefore rejected.
function isLoopbackHostHeader(hostHeader, port) {
  if (typeof hostHeader !== 'string') return false;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i.exec(hostHeader.trim());
  if (!match) return false;
  const requestPort = match[2] ? Number(match[2]) : 80;
  return requestPort === Number(port);
}

module.exports = {
  HTML_SECURITY_HEADERS,
  createOAuthSession,
  secretsMatch,
  isLoopbackHostHeader
};
