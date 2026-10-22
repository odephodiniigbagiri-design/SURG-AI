# SURG AI: web app with accounts, limits and spend cap

`public/index.html` is the Surg app. `api/` is the server: login, saving progress, and the AI relay that guards your Anthropic key. Deploy the whole folder to Vercel.

## Files
| File | Job |
|---|---|
| `public/index.html` | The app. Inside Claude it runs without accounts; on your own site it shows a login screen. |
| `api/auth.js` | Sign up (one-time invite code) and log in. Passwords are stored as salted hashes. |
| `api/sync.js` | Saves each student's flashcards, study notes, weak areas and profile under their account. |
| `api/chat.js` | Relays questions to Anthropic with the limits and spend cap. |
| `api/_system.js` | Surg's instructions (kept on the server). |
| `api/me.js` | Tells the app which plan a student is on and what is left. |
| `api/checkout.js` | Shows a student how to pay for Pro or Ultra. |
| `api/feedback.js` | Receives thumbs up and down on answers. |
| `api/admin.js` + `public/admin.html` | Your tools: activate plans, look up students, read feedback. |

## Setup (about 30 minutes)
1. **Upstash Redis** (free tier): create a database, copy the REST URL and token.
2. **Vercel**: import this folder. Add the variables from `.env.example`:
   - the AI keys (`BEDROCK_ACCESS_KEY_ID`, `BEDROCK_SECRET_ACCESS_KEY`, `BEDROCK_REGION` for Claude through Amazon Bedrock, or `ANTHROPIC_API_KEY` for Anthropic directly), `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
   - `AUTH_SECRET`: a long random string (40+ characters). Never share it. Changing it logs everyone out.
   - `INVITE_CODES` (optional): a few fixed one-time codes, e.g. `amaka-4f9k,tunde-7q2m`. You can also create any number of codes later on `/admin.html`, with no redeploy.
   - `ADMIN_KEY`: a long secret only you know. It opens `/admin.html`.
   - `PAY_INSTRUCTIONS`: what a student sees after tapping Choose Pro or Choose Ultra (how to pay and how to reach you). `{user}`, `{plan}` and `{price}` are filled in.
3. Redeploy after any change to a variable.
4. **Spend safety on AWS:** create a separate IAM user for Surg that can only call Bedrock (`bedrock:InvokeModel`), and use its keys. In AWS Billing, create a Budget with email alerts at, for example, $10, $20 and $30. AWS Budgets warns you but does not stop spending by itself, so keep `DAILY_BUDGET_USD` and `MONTHLY_BUDGET_USD` low: they are the real cap. (If you use Anthropic's own API instead, load a small prepaid balance and turn auto-reload off.)

## How students use it
Give each student a one-time invite code (create them on `/admin.html`). They open your site, choose "Create an account" and enter a username, a password (8+ characters) and the code. The code is used up and tied to that account. After that they log in with username and password.

## What is saved to the account, and what is not
- **Saved:** flashcards (with review schedule), study notes, topics, session history, weak areas, student profile.
- **Stays on the device only:** chats and the library of uploaded files.
- Logging out clears the device's copy. Logging in on another phone or laptop brings the saved data back.
- Two devices at once: the second one to save is asked whether to load the other device's version or keep its own.

## Limits (all set with variables)
900,000 tokens per student per month (30,000 a day), 6 messages a minute, 8 messages of history, 24,000 characters per request, $3 a day and $30 a month spend caps. Flashcards and the study tools use the same allowance as chat.

## Plans
| | Free trial | Surg Pro ($1.10/month) | Surg Ultra ($6/month) |
|---|---|---|---|
| Tokens per month | same as Pro | 900,000 | 1,800,000 |
| Text chat, all 7 AI modes | yes | yes | yes |
| Flashcards with spaced repetition | yes | yes | yes |
| Study Mode, notes, challenge, planner | yes | yes | yes |
| Voice conversation, read-aloud, hands-free | no | no | yes |
| Private library size | about 4 textbooks | about 4 textbooks | about 8 textbooks |

- **Trial:** 5 days of Pro starts automatically when the student creates an account (`TRIAL_DAYS`). No card is needed. When it ends and nothing is paid, chat and the other AI tools are locked and the Plans page opens. Study Mode, notes and reviewing existing flashcards still work.
- **Library size** is checked in the app on the student's device, since files never leave it.

## Taking payment
There is no payment provider wired in yet, so you activate plans yourself:
1. The student taps Choose Pro or Choose Ultra and sees your `PAY_INSTRUCTIONS` (and a payment-page button if you set `CHECKOUT_URL_PRO` / `CHECKOUT_URL_ULTRA` to payment links from your provider).
2. When you receive the money, open `/admin.html`, enter your admin key and the student's username, and press Grant Pro or Grant Ultra. This gives 30 days. Granting the same plan again adds another 30 days. Granting a different plan starts it now.
3. When a month ends without renewal, the student drops back to "trial ended" and the Plans page opens.

Automatic card billing needs a payment provider that can pay out in your country. A provider's webhook can call the same grant logic in `api/admin.js` later. Check the provider's fixed fee per charge: on a $1.10 plan it takes a much larger share than on $6.

## Feedback
Each answer has thumbs up and down. A thumbs-down asks for a reason (wrong facts, unclear, too long, off topic, other). The question and answer snippet (300 and 600 characters) and the mode are stored, without the username, and the latest 2,000 are kept. Read them at `/admin.html` to see where Surg falls short, then improve `api/_system.js` and the `SYSTEM` text in `public/index.html`.

## Claude on Amazon Bedrock
- Claude Haiku 5.5 is available on Bedrock as `anthropic.claude-haiku-5-5`. The default here is the global inference profile `global.anthropic.claude-haiku-5-5`; use `us.anthropic.claude-haiku-5-5` if you want the US profile. Use region `us-east-1` unless AWS tells you otherwise.
- If a call fails with an access error, open the Bedrock console and make sure access to the Claude model is enabled for the account (Anthropic may ask for a short use-case form the first time), and that the IAM user is allowed to invoke it.
- The charge appears on your AWS bill under the model provider, not under "Amazon Bedrock".
- The server tracks tokens and dollars from the usage AWS returns, so the student allowances and your spend caps work the same as before.

## Hosting notes
- **Upload only this folder** (`api/`, `public/`, `package.json`, `vercel.json`). Do not upload your other apps. Never put keys in any file: add them in Vercel under Settings > Environment Variables. `.env.example` is only a list of names.
- **Vercel plan:** Vercel's free Hobby plan is for personal, non-commercial use only, so charging students needs the Pro plan (about $20 a month).
- **Answer time:** `vercel.json` gives the chat function up to 60 seconds. Without it, Vercel's default is 10 seconds and longer answers would fail.
- **Your own domain** (for example a .com.ng name): in Vercel open Project > Settings > Domains, add the domain, then copy the exact DNS records Vercel shows into your registrar's DNS page. HTTPS is added automatically. It can take from minutes to a day to start working.

## Known gaps
- No password reset or email. To reset someone, delete `acct:<username>` and `code:*` for them in the Upstash console and issue a new code.
- Replies arrive whole, not word by word.
- Plans are activated by hand until a payment provider is connected.
- Tell students that thumbs ratings send a short snippet of the question and answer to you.
- Tested only against a simulated Redis, Anthropic and browser, not live. Test with two or three students first.
