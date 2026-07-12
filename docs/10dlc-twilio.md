# A2P 10DLC registration — 1st Fire Protection

Before the OS (or anyone) can send SMS from a US local number, Twilio requires an
**A2P 10DLC** registration through The Campaign Registry (TCR): a **Brand** (who we are)
and a **Campaign** (what we send + how customers consented).

Every field below is pre-filled from the founder layer
(`server/src/config/constants.ts` → `server/src/config/tenDLC.ts`) **except** the few
facts only the business owns. Those show `⟨NEEDS INPUT⟩` and are supplied via `.env`
(no code change) — see the bottom of this page.

Live values are served at **`GET /api/10dlc`** (`{ brand, campaign, ready, missing }`).

---

## 1. Brand registration

| Field | Value |
|---|---|
| Legal business name | **1st FP Services, LLC** |
| Brand / DBA name | 1st Fire Protection |
| Business type | Private company (for-profit) — `PRIVATE_PROFIT` |
| EIN / Tax ID | `⟨NEEDS INPUT⟩` → set `TWILIO_A2P_EIN` |
| EIN issuing country | US |
| D-U-N-S (optional) | `TWILIO_A2P_DUNS` if you have it |
| Industry / vertical | Construction (fire protection / life safety) — `CONSTRUCTION` |
| Website | https://1stfpcompanies.com |
| Street | 11550 N North Loop Rd, Bldg 1 #1 |
| City / State / ZIP | San Antonio, TX 78216 |
| Country | US |
| Authorized contact | Chris Holcomb, Chief Operating Officer *(confirm / override via env)* |
| Contact email | dispatch@1stfpcompanies.com |
| Contact phone | +1 210-377-3473 |
| Regions of operation | USA — Central & South Texas |

> **EIN is required** and must exactly match the IRS record for *1st FP Services, LLC*.
> A mismatch is the #1 cause of a rejected brand. Confirm the authorized contact is a
> real person who can attest to the registration.

---

## 2. Campaign registration

| Field | Value |
|---|---|
| Use case | **Mixed** (customer care) — `MIXED` |
| Description | Transactional customer-care messages to existing customers: inspection/service appointment reminders, invoice/payment reminders, and post-service review requests. Recipients are our own customers who provided their mobile number and consented during scheduling or on a signed work order. |
| Embedded links | Yes (payment + review links) |
| Embedded phone numbers | Yes (210-377-FIRE) |
| Age-gated / lending / affiliate | No |

**Sample messages** (must match what we actually send):

1. `Hi {{name}}, this is 1st Fire Protection. Your annual fire-sprinkler inspection at {{site}} is scheduled for {{date}}. Reply C to confirm or call 210-377-FIRE to reschedule. Reply STOP to opt out.`
2. `Hi {{name}}, 1st Fire Protection here — invoice {{invoice}} for {{amount}} is now due. Pay securely at {{link}} or call 210-377-3473 with questions. Reply STOP to opt out.`
3. `Thanks for choosing 1st Fire Protection, {{name}}! If we kept you safe today, a quick review means a lot: {{link}}. Reply STOP to opt out.`

**Opt-in flow** (the most-scrutinized field):

> Customers provide their mobile number and agree to receive service and account text
> messages when they schedule work by phone (verbal consent captured by our office) or by
> signing a 1st Fire Protection work order / service agreement that includes an SMS-consent
> clause. No numbers are purchased, rented, or shared. Message frequency varies; message and
> data rates may apply.

**Keywords / auto-replies:**

| | Keywords | Reply |
|---|---|---|
| Opt-in | START, YES, UNSTOP | *"You're subscribed to service & account alerts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel."* |
| Opt-out | STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT | *"You're unsubscribed and will get no more messages. Reply START to resubscribe."* |
| Help | HELP, INFO | *"Support: call 210-377-3473 or email dispatch@1stfpcompanies.com. Msg & data rates may apply. Reply STOP to cancel."* |

> **Consent proof:** TCR/carriers may ask for evidence of the opt-in. Keep the work order
> SMS-consent clause and/or a screenshot of the online scheduling consent on file. If we do
> **not** yet capture SMS consent in writing, add the clause before submitting — describing a
> flow we don't actually run is the fastest way to a permanent rejection.

---

## 3. What the operator must supply

Add to `.env` (or the deploy environment) — no code change needed:

```bash
TWILIO_A2P_EIN=123456789          # REQUIRED — IRS EIN, 9 digits no dash
# optional / defaults already sensible:
TWILIO_A2P_DUNS=
TWILIO_A2P_CONTACT_FIRST=Chris
TWILIO_A2P_CONTACT_LAST=Holcomb
TWILIO_A2P_CONTACT_TITLE=Chief Operating Officer
TWILIO_A2P_CONTACT_EMAIL=dispatch@1stfpcompanies.com
TWILIO_A2P_CONTACT_PHONE=+12103773473
```

Then `GET /api/10dlc` returns `ready: true` with an empty `missing` list.

## 4. Submitting

Register in the **Twilio Console → Messaging → Regulatory Compliance → A2P 10DLC**
(Brand first, then Campaign), or via the Trust Hub API using the values above. Standard-brand
vetting + campaign approval typically takes a few business days.
