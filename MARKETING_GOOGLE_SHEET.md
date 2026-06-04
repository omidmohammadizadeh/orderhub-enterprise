# Wiring the marketing contact form to your Google Sheet

The contact form on `/` POSTs leads straight to a Google Sheet — no backend,
no Zapier, no extra subscription. Setup is a one-time five-minute job.

## 1. Open the sheet

Use the sheet you already shared:
<https://docs.google.com/spreadsheets/d/1BMvQ2W2mg4dQR9ExrWqDQKsqFheL-ChUsqHgfS1SYOA/edit>

Make sure tab 1 (or whichever tab you want leads on) has these headers in
row 1, left to right:

```
Submitted At | Name | Restaurant | Phone | Email | Locations | Message | Source
```

You can rename them later — the script writes by column order, not by
header text.

## 2. Add the Apps Script

From the sheet: **Extensions → Apps Script**. Replace whatever is in
`Code.gs` with:

```javascript
function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var data = JSON.parse(e.postData.contents);
    sheet.appendRow([
      data.submittedAt || new Date().toISOString(),
      data.name || "",
      data.restaurant || "",
      data.phone || "",
      data.email || "",
      data.locations || "",
      data.message || "",
      data.source || "",
    ]);
    return ContentService
      .createTextOutput(JSON.stringify({ status: "ok" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

Click **Save** (disk icon).

## 3. Deploy it as a Web App

1. Top-right: **Deploy → New deployment**
2. Click the gear icon next to "Select type" → **Web app**
3. Configuration:
   - Description: `Order Hub contact form webhook`
   - Execute as: **Me** (your Google account)
   - Who has access: **Anyone**
4. **Deploy**
5. Google will prompt to authorise the script. Approve.
6. Copy the **Web app URL** — looks like
   `https://script.google.com/macros/s/AKfycb…/exec`

## 4. Add the URL to Render

- Render dashboard → `orderhub-web` service → **Environment**
- Add a new variable:
  - Key: `NEXT_PUBLIC_CONTACT_WEBHOOK_URL`
  - Value: the Web app URL you copied
- **Save Changes** — Render redeploys (~3 min)

That's it. Test by submitting the contact form on the homepage and
checking the sheet — a new row should appear within ~5 seconds.

## Updating the script later

If you change the script, you must **redeploy** for the change to take
effect. **Deploy → Manage deployments → ✏️ (pencil) → New version →
Deploy**. The URL stays the same — no need to update Render.

## WhatsApp "Chat with us" button

While you're in Render env vars, add one more for the floating
WhatsApp bubble in the bottom-right corner:

- Key: `NEXT_PUBLIC_WHATSAPP_NUMBER`
- Value: your support number, **digits only, no `+` or spaces**.
  Example: `447900123456` for `+44 7900 123456`.

When unset, the bubble is hidden so you can ship the site before you
have a number ready.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Form shows "Got it — thank you!" but no row appears | The script wasn't redeployed after editing — see "Updating the script later" |
| Form opens your email client instead of submitting | `NEXT_PUBLIC_CONTACT_WEBHOOK_URL` is empty on Render |
| Rows appear but in the wrong sheet tab | The script targets `getSheets()[0]` — drag the lead sheet to the leftmost position, or change the index |
| 401 / 403 in DevTools | "Who has access" wasn't set to **Anyone** when you deployed |
