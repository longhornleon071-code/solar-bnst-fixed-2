Solar BNST — corrected project files

Requirements:
- Node.js 22 or newer (uses node:sqlite)
- No npm packages required

Run:
1. Keep server.mjs and the public folder together.
2. In a terminal, run: node server.mjs
3. Open: http://localhost:8787

Important:
- On first run, the owner setup code is printed in the terminal. Enter it on the First-time setup screen.
- Do not open public/index.html directly as a file; the app needs the API server.
- Google sign-in is optional. Set GOOGLE_CLIENT_ID in the environment to enable it.
- Back up solar-bnst.db before updating an existing deployment.
