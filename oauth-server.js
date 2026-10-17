const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { escapeHtml } = require('./utils/html-escape');
const {
  HTML_SECURITY_HEADERS,
  createOAuthSession,
  secretsMatch,
  isLoopbackHostHeader
} = require('./utils/oauth-security');

const CALLBACK_PORT = 8080;

class OAuthServer {
  constructor() {
    this.app = express();
    this.app.disable('x-powered-by');
    this.server = null;
    this.session = null;
    this.setupRoutes();
  }

  setupRoutes() {
    // Reject DNS-rebinding requests and send safe headers on every page.
    this.app.use((req, res, next) => {
      if (!isLoopbackHostHeader(req.headers.host, CALLBACK_PORT)) {
        return res.status(400).send('Bad request');
      }
      res.set(HTML_SECURITY_HEADERS);
      return next();
    });

    this.app.get('/auth/callback', async (req, res) => {
      const { code, error, state } = req.query;

      // Only the login this process started can finish it; the state is single-use.
      const session = this.session;
      if (!session || !secretsMatch(session.state, typeof state === 'string' ? state : '')) {
        res.status(400).send('<h1>❌ Unexpected request</h1><p>This authorization response does not belong to the current login. Start the login again from the terminal.</p>');
        return;
      }
      this.session = null;

      if (error) {
        res.status(400).send(`<h1>❌ Authentication Error</h1><p>${escapeHtml(error)}</p>`);
        return;
      }

      if (typeof code !== 'string' || !code) {
        res.status(400).send('<h1>❌ No Authorization Code</h1><p>No authorization code received</p>');
        return;
      }

      try {
        // Exchange code for tokens
        await this.exchangeCodeForTokens(code, session.codeVerifier);
        
        res.send(`
          <h1>🎉 Authentication Successful!</h1>
          <p>Your YouTube Automation Agent has been successfully authorized!</p>
          <p>You can close this window and return to the terminal.</p>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
            h1 { color: #4CAF50; }
          </style>
        `);
        
        console.log(chalk.green('\n✅ Authentication successful! Starting YouTube Automation Agent...'));
        
        // Close the server after successful auth
        setTimeout(() => {
          this.server.close();
          this.startMainApplication();
        }, 2000);
        
      } catch (exchangeError) {
        // Details stay in the terminal; the browser only gets a generic message.
        console.error(chalk.red('Token exchange failed:'), exchangeError);
        res.status(500).send('<h1>❌ Token Exchange Failed</h1><p>See the terminal for details.</p>');
      }
    });

    this.app.get('/', (req, res) => {
      res.send(`
        <h1>🎬 YouTube Automation Agent</h1>
        <p>OAuth callback server is running...</p>
        <p>Please complete the authorization process.</p>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        </style>
      `);
    });
  }

  async exchangeCodeForTokens(code, codeVerifier) {
    const credentialsPath = path.join(__dirname, 'config', 'credentials.json');
    const tokensPath = path.join(__dirname, 'config', 'tokens.json');
    
    const credentials = JSON.parse(fs.readFileSync(credentialsPath));
    
    const oauth2Client = new google.auth.OAuth2(
      credentials.youtube.client_id,
      credentials.youtube.client_secret,
      credentials.youtube.redirect_uris[0]
    );

    const { tokens } = await oauth2Client.getToken({ code, codeVerifier });
    
    // Save tokens
    const tokenData = {
      youtube: tokens
    };
    
    fs.writeFileSync(tokensPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
    fs.chmodSync(tokensPath, 0o600);
    console.log(chalk.green('✅ Tokens saved successfully!'));
  }

  async startMainApplication() {
    console.log(chalk.cyan('\n🚀 Starting YouTube Automation Agent...'));
    
    // Import and start the main application
    const { spawn } = require('child_process');
    const mainApp = spawn('node', ['index.js'], {
      stdio: 'inherit',
      cwd: __dirname
    });
    
    mainApp.on('close', (code) => {
      console.log(chalk.yellow(`Main application exited with code ${code}`));
    });
  }

  start() {
    this.server = this.app.listen(CALLBACK_PORT, '127.0.0.1', () => {
      console.log(chalk.cyan(`\n🔐 OAuth callback server started on http://localhost:${CALLBACK_PORT}`));
      this.generateAuthUrl().catch(error => {
        console.error(chalk.red('Could not start the OAuth login:'), error.message);
        this.server.close();
        process.exitCode = 1;
      });
    });
  }

  async generateAuthUrl() {
    const credentialsPath = path.join(__dirname, 'config', 'credentials.json');
    const credentials = JSON.parse(fs.readFileSync(credentialsPath));
    
    const oauth2Client = new google.auth.OAuth2(
      credentials.youtube.client_id,
      credentials.youtube.client_secret,
      credentials.youtube.redirect_uris[0]
    );

    // One-time state + PKCE pair for this login.
    this.session = await createOAuthSession(oauth2Client);

    const scopes = [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
      'https://www.googleapis.com/auth/youtube.force-ssl'
    ];

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
      state: this.session.state,
      code_challenge: this.session.codeChallenge,
      code_challenge_method: 'S256'
    });

    console.log(chalk.cyan.bold('\n🎬 YouTube Automation Agent - OAuth Setup'));
    console.log(chalk.gray('═'.repeat(60)));
    console.log(chalk.cyan('\n🔗 Please visit this URL to authorize the application:'));
    console.log(chalk.blue.underline(authUrl));
    console.log(chalk.yellow('\nAfter authorization, you will be redirected back automatically.'));
    console.log(chalk.gray('The OAuth server will handle the rest!'));
  }
}

if (require.main === module) {
  const oauthServer = new OAuthServer();
  oauthServer.start();
}

module.exports = { OAuthServer };