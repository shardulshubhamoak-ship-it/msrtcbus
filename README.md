# MSRTC ST Bus Depot & QR App

Offline-first web app for MSRTC depots and conductors. Conductors create a **QR code** for each bus, the depot **scans** it to register the bus, and the app **announces** it in **Marathi, Hindi and English**. Everything the app stores is saved to **`db.json`** by the included server.

## Files (keep all five in one folder)

| File | What it is |
|---|---|
| `index.html` | The whole app (screens, PIN verification, help training). Edit this file and refresh the browser to change the app. |
| `server.js` | The server. Serves the app over **HTTP and HTTPS** and saves all data to `db.json`. No extra packages needed. |
| `db.json` | The database. Every account, QR code, register entry, notice and audit log is saved here. |
| `package.json` | Project file. Lets you start the server with `npm start`. |
| `README.md` | This guide. |

## Requirements

- [Node.js](https://nodejs.org) **16 or newer**. Nothing else to install (no `npm install` needed).

## Quick start

1. Put the five files in one folder.
2. Open a terminal in that folder and run:

   ```
   node server.js
   ```

   (or `npm start`)
3. The console prints the addresses to use. The app opens in your browser the first time.

The server restarts itself if it crashes. Press **Ctrl+C** to stop it for real.

## Opening the app

| Where | Address | Notes |
|---|---|---|
| This computer | `http://localhost:8080` | Camera works on `localhost`. |
| Phones / other devices | `https://192.168.x.x:8443` (the "Other devices" address printed in the console) | Must be on the same Wi-Fi. |

- A phone can only use the **camera** (QR scan) on an `https://` address. If you type the `http://...:8080` address on a phone, the server sends you to the HTTPS one.
- The HTTPS certificate is created automatically and is **self-signed**, so the first time a phone opens it a warning appears. Tap **Advanced -> Proceed** (once per phone).
- The certificate is stored in the `certs` folder. It is renewed automatically if the computer's Wi-Fi address changes. To use your own certificate, put `cert.pem` and `key.pem` in `certs`.

## How data is saved (`db.json`)

- Open the app **from the server address** (above). Every change - new account, QR code, bus scan, notice, platform edit, audit log - is saved to `db.json` about a second later. The "Online - Syncing" badge at the top shows it is connected.
- If you open `index.html` directly as a file, nothing reaches `db.json`.
- The app also keeps a copy on each device, so it keeps working **offline**. Data entered offline is sent to `db.json` automatically when the server is reachable again.
- Changes made on one device appear on the others after they sync. Deleting an account also removes it from `db.json`.
- `db.json` holds these lists: `users`, `qrCodes`, `depotRegister`, `notices`, `auditLogs`. The file shipped with the app contains one sample staff account and one sample notice.

**Backup:** copy `db.json`. **Restore or move to another computer:** stop the server, put the saved `db.json` next to `server.js`, start the server.

**Keep `db.json` private.** It contains hashed passwords and PIN hashes (never the PIN itself). Do not email or post it.

## Using the app

- **Help button** (red, bottom right): step-by-step training in English, Marathi and Hindi for everyone, staff and depot admins, plus common questions.
- **Bus condition:** when a QR is created (staff or depot) a **Bus Condition** box is filled: overall condition, fire extinguisher, stepney, broken window glass, other equipment / remarks. It travels inside the QR, shows on the QR, in the register, in the Excel export and in **See My Bus** (condition + last depot + registration time).
- **Passenger (no login):** the home page has a **Passenger - See My Bus** card. A passenger types a bus number and sees ONLY the depot where the bus was last registered and the time. Nothing else of the app is reachable. It reads the server's public endpoint `GET /public/bus?q=` (min 3 characters, max 5 buses, 40 searches/minute per address; needs internet; it works without the sync key and exposes only bus number, depot and time).
- **See My Bus (depot):** also shows the driver and conductor (name + tappable mobile number) who registered the bus at its first station (earliest registration of the same service and route within 24 hours before the last one).
- **QR logo:** the bus QR shows the MSRTC ST logo in the middle (the logo already inside the app). The QR uses error-correction level M so it still scans with the logo on. To change the logo, replace `window.MSRTC_LOGO` in `index.html`.
- **Passenger (no login):** the home page has a Passenger - See My Bus card. It shows only the last depot and time of a bus (server endpoint `/public/bus`), nothing else.
- **Staff / Conductor:** create a bus QR, view saved QR codes, change a platform number, read the depot notice board.
- **Depot Admin:**
  - Scan bus QR codes and register them.
  - **See All Register History:** pick a date to see every bus registered that day (export to Excel, announce any row).
  - **Announcements:** pick any register entry, then **Replay Announcement**.
  - Create depot QR codes, publish notices (and delete your own published notices from **My Published Notices** - only the publisher, and only after the publisher's PIN is verified), see where a bus was last registered, view audit logs.
- **PIN:** a 6-digit PIN is required when **creating** any account (Staff or Depot). It is asked at the **Depot console login**, and the conductor who created a bus QR enters it when the depot scans the QR. Staff login uses username and password only. See the PIN section.

## Deleting things

- **One bus QR code:** every QR card has a **Delete** button. A conductor can delete only the QR codes of his own account; the depot can delete any QR in its list. The **PIN of the account that created the QR** must be typed and verified. A wrong, missing or cancelled PIN leaves the QR untouched.
- **One wrong depot register entry:** every row of the register has a **Delete** button (depot manager only). The entry is deleted **only after the depot manager's own PIN is verified**. A wrong or cancelled PIN leaves the entry untouched. The result is written to the audit log.
- **Delete All My Data (keep my account)** (Manage Account): removes the bus QR codes, notices and activity logs created by that account. **Depot register entries are never deleted by it.** Needs typing `DELETE` and then that account's PIN; a wrong PIN deletes nothing. Notices published before this version have no owner recorded and are not touched.
- **Delete My Account Permanently:** removes only the account itself (and its PIN data on the server).

Server copies are deleted too; if the phone is offline the deletion is queued and sent at the next sync. Copies already downloaded to *other* phones are not removed from those phones.

## PIN verification (server-verified, works offline too)

**The app uses a 6-digit PIN for every verification. There is no fingerprint step any more.** The PIN is created when the account is created (Create Account asks for **PIN + Repeat PIN**). It is asked wherever verification is needed: **Depot login** (tap **Verify PIN**), when the depot scans a bus QR (the conductor who created it types his PIN), deleting a QR / register entry / all my data, and editing or deleting the account. The code that opens the app (lock screen) is separate.

| | Registration | Verification |
|---|---|---|
| Where | Create account (PIN is compulsory), **Manage Account -> Set / change PIN** | Depot login, bus scan (conductor), account edit / delete, delete my data, deleting a QR or a register entry |
| Needs server | **Yes (online only)** | Online (server checks) or **offline** (see below) |
| Server call | `/bio/pin/set` | `/bio/pin/verify` |

- **Wrong PIN:** 5 wrong tries lock the PIN for a while (checked on the server). A wrong or cancelled PIN means nothing is deleted and nothing is registered.
- **Bound to the Employee ID:** the PIN belongs to that ID only. The Employee ID cannot be renamed after the PIN is set. The server keeps only a salted hash (PBKDF2), never the PIN.
- **Offline (no server):** the PIN is checked against a verifier saved (encrypted with a non-exportable key) on the phone when it was last online, valid **7 days** (`BIO_OFFLINE_DAYS`). Every offline check is stored as a signed proof and **re-checked by the server at the next sync** (`/bio/offline-proofs`).
- **Forgot the PIN:** **Forgot password / PIN trouble?** on the login window (e-mail code), log in, then **Manage Account -> Set / change PIN**.
- Accounts created before this version (with fingerprints only) have no PIN yet: use the e-mail code once, then set a PIN in Manage Account.
- Depot users can see every employee's status in **Manage Account -> Employee verification status (server)**.

Known limit: a PIN that is changed on the server can still work offline until the saved verifier expires (max 7 days). Fingerprint / biometric sign-in is no longer used by the app.

## Settings (optional)

Set as environment variables before starting.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `HTTPS_PORT` | `8443` | HTTPS port |
| `HTTPS` | on | `HTTPS=0` turns HTTPS off |
| `HOST` | `0.0.0.0` | Network interface to listen on |
| `DATA_FILE` | `./db.json` | Where all data is saved |
| `APP_FILE` | `./index.html` | App file to serve |
| `CERT_FILE`, `KEY_FILE` | `./certs/...` | Your own TLS certificate and key |
| `NO_SUPERVISOR` | off | `NO_SUPERVISOR=1` disables auto-restart |
| `NO_BROWSER` | off | `NO_BROWSER=1` stops the browser opening on first start |

Windows examples: Command Prompt `set PORT=9000 && node server.js`; PowerShell `$env:PORT=9000; node server.js`.

**Email OTP (optional):** the server can email one-time codes. Set the `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` (and optionally `SMTP_FROM`) variables, or edit the `DEPOT_GMAIL` block near the top of `server.js` with each depot's Gmail App Password. Without this, codes are only printed in the server console (test mode). See the comments at the top of `server.js` for details.

## Troubleshooting

| Problem | Fix |
|---|---|
| Camera does not start on a phone | Use the `https://` address, allow camera permission, close other apps using the camera. |
| Nothing saves to `db.json` | Open the app from the server address, not from the file. Check the console for errors. |
| "Port already in use" | Another copy is running. Close it, or set `PORT` / `HTTPS_PORT` to free ports. |
| Phone cannot reach the server | Same Wi-Fi? Allow Node.js through the computer's firewall for ports 8080 and 8443. |
| PIN will not verify | Type exactly the 6 digits. After 5 wrong tries wait; or use Forgot password / PIN trouble and set a new PIN. |
| Announcement has no sound | Turn up the volume and install Marathi / Hindi text-to-speech voices on the phone. |

## Green screen / camera does not scan (computer webcam)

Many USB webcams show a **green picture** at 1920x1080. The scanner now starts at 1280x720 on computers, watches the live picture, and if it turns green it automatically retries at 640x480 and then tries other cameras. If it is still green: close Zoom/Teams/other apps using the camera, then in Chrome open `chrome://settings/system`, switch **off** "Use graphics acceleration when available", restart Chrome.

## Email verification code (OTP) - why no mail arrived, and how to fix it

The server sends the verification code by e-mail. It needs a sender account; the sender is **shardulshubhamoak@gmail.com** (already in `mail-settings.json`). Nothing is sent until a password / key is added:

* **Render FREE plan (your Render address):** Render blocks every SMTP port (25, 465, 587) on free services, so Gmail SMTP can NOT work there. Use the HTTPS mail API instead:
  1. Make a free account at brevo.com (300 mails/day), open *Senders, Domains & Dedicated IPs* > *Senders* and add `shardulshubhamoak@gmail.com`; click the link Brevo mails to that address.
  2. Brevo > *SMTP & API* > *API keys* > create a key (starts with `xkeysib-`).
  3. Render > your service > *Environment*: add `BREVO_API_KEY` = the key and `MAIL_SENDER` = `shardulshubhamoak@gmail.com`. Save (the service restarts). The server log then says "Email OTP: Brevo HTTPS API".
* **Own PC or a paid Render plan:** Gmail > Google Account > Security > 2-Step Verification ON > App passwords > create one, then put the 16 letters in `mail-settings.json` ("appPassword") or in the `SMTP_PASS` environment variable (`SMTP_USER` = the Gmail address). Never write the password anywhere else.

Mails sent through Brevo with a Gmail sender may land in Spam the first time: check the Spam folder.

## Starting from zero

`db.json` is empty (0 users, 0 QR codes, 0 register rows, 0 notices, 0 logs) and there are no backups. The first time a phone opens the app with the new server address (`APP_SERVER_URL`, now https://msrtcbus.onrender.com) it asks once: OK = erase the old data on that phone and start from zero, Cancel = keep and upload it. Fingerprints are tied to the web address, so accounts must be created again on the new address.
