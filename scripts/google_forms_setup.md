# Google Forms copy/update script

1. In Google Cloud, enable the Google Drive API and Google Forms API for a project you control.
2. Create an OAuth client for a desktop app.
3. Download the OAuth client JSON and save it as `credentials/google-oauth-client.json`.
4. Run `npm install`.
5. Run:

```powershell
npm run copy-google-form -- --source-form-url "https://docs.google.com/forms/d/FORM_ID/edit"
```

Optional flags:

```powershell
npm run copy-google-form -- `
  --source-form-url "https://docs.google.com/forms/d/FORM_ID/edit" `
  --copy-title "Oscars 2026 Ballot" `
  --data "site/data/oscars_2026_dashboard.json"
```

Notes:

- The first run opens a browser for Google OAuth and saves a refresh token to `credentials/google-token.json`.
- The script copies the source form first, then updates supported choice-based questions in the copy.
- Question titles are matched against Oscar category names from the local dashboard JSON. Unmatched questions are reported for manual review.
- If a question already has quiz grading configured, the script leaves grading untouched and warns so you can review the answer key manually.
