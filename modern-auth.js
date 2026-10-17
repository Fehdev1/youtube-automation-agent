const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const http = require('http');
const { URL } = require('url');
const { escapeHtml } = require('./utils/html-escape');
const {
  HTML_SECURITY_HEADERS,
  createOAuthSession,
  secretsMatch,
  isLoopbackHostHeader
} = require('./utils/oauth-security');

function sendHtml(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...HTML_SECURITY_HEADERS });
  res.end(body);
}

class ModernAuth {
  constructor() {
    this.credentialsPath = path.join(__dirname, 'config', 'credentials.json');
    this.tokensPath = path.join(__dirname, 'config', 'tokens.json');
    this.server = null;
    this.session = null;
  }

  async authenticate() {
    console.log(chalk.cyan.bold('\n🔐 YouTube Authentication (Modern Flow)'));
    console.log(chalk.gray('═'.repeat(60)));
    
    try {
      const credentials = JSON.parse(fs.readFileSync(this.credentialsPath));
      
      const redirect = this.resolveRedirect(credentials);
      const redirectUri = redirect.uri;
      
      const oauth2Client = new google.auth.OAuth2(
        credentials.youtube.client_id,
        credentials.youtube.client_secret,
        redirectUri
      );

      const scopes = [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube',
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/yt-analytics.readonly',
        'https://www.googleapis.com/auth/youtube.force-ssl'
      ];

      const authResult = new Promise((resolve, reject) => {
        this.resolveAuth = resolve;
        this.rejectAuth = reject;
        this.authTimeout = setTimeout(() => {
          this.cleanup();
          reject(new Error('Authentication timeout (5 minutes)'));
        }, 300000);
      });

      // One-time state + PKCE pair for this login. It must exist before the server starts.
      this.session = await createOAuthSession(oauth2Client);

      // Start a temporary local server at the exact redirect URI used in the OAuth request.
      await this.startTempServer(redirect, oauth2Client);
      
      // Generate auth URL
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent',
        state: this.session.state,
        code_challenge: this.session.codeChallenge,
        code_challenge_method: 'S256'
      });

      console.log(chalk.cyan('🔗 Please visit this URL to authorize:'));
      console.log(chalk.blue(authUrl));

      // Best effort: open the URL in the default browser
      const { exec } = require('child_process');
      const openCommands = {
        win32: `start "" "${authUrl}"`,
        darwin: `open "${authUrl}"`,
        linux: `xdg-open "${authUrl}"`
      };
      if (openCommands[process.platform]) {
        exec(openCommands[process.platform], () => {});
      }
      console.log(chalk.yellow(`\n⚡ A temporary server is running on port ${redirect.port}`));
      console.log(chalk.yellow('After authorization, you\'ll be redirected automatically.'));
      console.log(chalk.gray('Waiting for authorization...'));
      
      // The server will handle the rest
      return authResult;
      
    } catch (error) {
      this.cleanup();
      console.error(chalk.red('Authentication failed:'), error.message);
      throw error;
    }
  }

  resolveRedirect(credentials) {
    const explicitRedirect = process.env.YOUTUBE_REDIRECT_URI;
    const configured = [explicitRedirect, ...(credentials.youtube?.redirect_uris || [])].filter(Boolean);
    const legacyGeneratedRedirect = /^http:\/\/localhost:8080\/(?:oauth2callback|callback)\/?$/i;
    let redirect = null;
    for (const value of configured) {
      if (!explicitRedirect && legacyGeneratedRedirect.test(value)) continue;
      try {
        const candidate = new URL(value);
        if (candidate.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(candidate.hostname)) {
          redirect = candidate;
          break;
        }
      } catch (_error) {
        // Ignore obsolete out-of-band and malformed redirect values.
      }
    }
    redirect ||= new URL('http://127.0.0.1/');
    if (!redirect.port) redirect.port = String(8000 + Math.floor(Math.random() * 1000));
    return {
      uri: redirect.toString(),
      hostname: redirect.hostname,
      port: Number(redirect.port),
      pathname: redirect.pathname || '/'
    };
  }

  async startTempServer(redirect, oauth2Client) {
    this.server = http.createServer(async (req, res) => {
      if (!isLoopbackHostHeader(req.headers.host, redirect.port)) {
        sendHtml(res, 400, '<h1>Bad request</h1>');
        return;
      }

      let url;
      try {
        url = new URL(req.url, redirect.uri);
      } catch (_error) {
        sendHtml(res, 400, '<h1>Bad request</h1>');
        return;
      }

      if (url.pathname !== redirect.pathname) {
        sendHtml(res, 200, `
          <html>
            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
              <h1>🎬 YouTube Automation Agent</h1>
              <p>Waiting for OAuth callback...</p>
              <p>Please complete the authorization in the other tab.</p>
            </body>
          </html>
        `);
        return;
      }

      // Only the login this process started can finish it. Anything else is ignored
      // (not treated as a failed login), so a stray request cannot cancel or hijack it.
      const session = this.session;
      if (!session || !secretsMatch(session.state, url.searchParams.get('state'))) {
        sendHtml(res, 400, '<h1>❌ Unexpected request</h1><p>This authorization response does not belong to the current login. Start the login again from the terminal.</p>');
        return;
      }
      this.session = null; // the state is single-use

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        sendHtml(res, 400, `
          <h1>❌ Authorization Error</h1>
          <p>${escapeHtml(error)}</p>
          <p>You can close this window.</p>
        `);
        this.rejectAuth(new Error(`Authorization error: ${String(error).slice(0, 200)}`));
        return;
      }

      if (!code) {
        sendHtml(res, 400, '<h1>❌ No Authorization Code</h1><p>No authorization code received.</p>');
        this.rejectAuth(new Error('Authorization response did not include a code'));
        return;
      }

      try {
        const { tokens } = await oauth2Client.getToken({ code, codeVerifier: session.codeVerifier });

        // Save tokens
        const tokenData = { youtube: tokens };
        fs.writeFileSync(this.tokensPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
        fs.chmodSync(this.tokensPath, 0o600);

        sendHtml(res, 200, `
          <html>
            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
              <h1 style="color: #4CAF50;">🎉 Authentication Successful!</h1>
              <p>Your YouTube Automation Agent has been authorized!</p>
              <p>You can close this window and return to the terminal.</p>
            </body>
          </html>
        `);

        console.log(chalk.green('\n✅ Authentication successful!'));
        this.cleanup();
        this.resolveAuth(tokens);
      } catch (tokenError) {
        // Details stay in the terminal; the browser only gets a generic message.
        sendHtml(res, 500, '<h1>❌ Token Exchange Failed</h1><p>See the terminal for details.</p>');
        this.rejectAuth(tokenError);
      }
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(redirect.port, redirect.hostname, resolve);
    });
    console.log(chalk.gray(`Temporary OAuth server started on ${redirect.uri}`));
  }
  
  cleanup() {
    if (this.authTimeout) {
      clearTimeout(this.authTimeout);
      this.authTimeout = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  async testAuthentication() {
    try {
      const tokens = JSON.parse(fs.readFileSync(this.tokensPath));
      const credentials = JSON.parse(fs.readFileSync(this.credentialsPath));
      
      const oauth2Client = new google.auth.OAuth2(
        credentials.youtube.client_id,
        credentials.youtube.client_secret
      );
      
      oauth2Client.setCredentials(tokens.youtube);
      
      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
      const response = await youtube.channels.list({
        part: 'snippet',
        mine: true
      });
      
      if (response.data.items && response.data.items.length > 0) {
        const channel = response.data.items[0];
        console.log(chalk.green(`✅ Connected to channel: ${channel.snippet.title}`));
        console.log(chalk.gray(`   Channel ID: ${channel.id}`));
        console.log(chalk.gray(`   Subscribers: ${channel.statistics?.subscriberCount || 'Hidden'}`));
        return true;
      } else {
        console.log(chalk.red('❌ No channel found'));
        return false;
      }
    } catch (error) {
      console.error(chalk.red('Authentication test failed:'), error.message);
      return false;
    }
  }
}

async function runAuth() {
  const auth = new ModernAuth();
  
  try {
    await auth.authenticate();
    
    console.log(chalk.cyan('\n🧪 Testing authentication...'));
    const success = await auth.testAuthentication();
    
    if (success) {
      console.log(chalk.green.bold('\n🎉 Authentication Complete!'));
      console.log(chalk.cyan('Your YouTube automation is ready!'));
      console.log(chalk.yellow('\n📋 Next Steps:'));
      console.log(chalk.white('1. Run: npm start'));
      console.log(chalk.white('2. Visit: http://localhost:3456'));
      console.log(chalk.white('3. Your first video will be generated within 24 hours!'));
    } else {
      console.log(chalk.red('\n❌ Authentication test failed.'));
    }
  } catch (error) {
    console.error(chalk.red('\nAuthentication failed:'), error.message);
    if (error.message.includes('timeout')) {
      console.log(chalk.yellow('\n💡 Try again - the authorization window might have closed.'));
    }
    process.exit(1);
  }
}

if (require.main === module) {
  runAuth();
}

module.exports = { ModernAuth };
