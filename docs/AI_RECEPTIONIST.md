# AI Receptionist — baseline ("before") and plan

Captured to anchor the before/after story. All call figures are **real**, pulled live from
Microsoft Graph PSTN call records (`getPstnCalls`) via the tenant Entra app, and the routing map
is from Teams admin (`Get-CsAutoAttendant` / `Get-CsCallQueue` / `Get-CsPhoneNumberAssignment`).

- **Data window:** 2026-05-07 → 2026-08-05 (91 days)
- **Telephony:** Microsoft Teams Phone (Calling Plans) — Auto Attendants + Call Queues per office
- **Snapshot owner:** re-pull anytime via `GET /api/teams/pstn-analytics?days=90`

---

## 1. The "before" — how reception works today

Every office follows one shape:

```
Main # → Auto Attendant (greeting) → Call Queue (rings agents by Teams presence)
       → overflow / timeout / no-agent → SHARED VOICEMAIL
After hours → separate after-hours flow → after-hours queue OR external forward OR voicemail
```

There is **no triage, no lead capture, no callback** — a call the queue can't answer in seconds
falls to a voicemail beep. Only **Accounting** has a real menu (0 Accounting / 1 Safety & Training
/ 2 HR & Payroll / dial-by-name).

| Office | Main # | Inbound / mo* | Main-queue agents | Load |
|---|---|---|---|---|
| San Antonio (HQ) | 210-377-3473 | ~408 | 4 | moderate |
| McAllen | 956-682-3473 | ~298 | **1** (+backups) | **very high** |
| Austin | 512-312-9768 | ~184 | 4 | low |
| Waco | 254-327-3744 | ~171 | 3 | low |
| College Station | 979-978-6563 | ~67 | **1** | high |
| Lubbock | 806-216-7634 | ~55 | **1** | moderate |
| Accounting | 726-223-5130 | ~45 | IVR menu | — |
| Houston | 346-372-8684 | ~13 | 1 | trivial |

\* Monthly = 91-day totals scaled to 30 days. 91-day inbound totals: SA 1,238 · McAllen 904 ·
Austin 558 · Waco 520 · College Station 202 · Lubbock 166 · Accounting 137 · Houston 40.

### Baseline metrics (91 days)
- **Inbound: 3,765** (~41/day). **Outbound: 703.** Inbound outnumbers outbound **5.4 : 1**.
- **Avg call length: ~124 s (~2 min).**
- **Peak load: 8 a.m.–3 p.m. CT, peaking 10 a.m.** (busiest hour ≈ 5–6 calls across all offices).
- **After-hours inbound: 217** (weekday before 7a / after 6p, or weekends) — ~72/mo.
  - Weekend: **120**. True overnight (10p–6a): **27**.
  - By office: San Antonio 81 · Waco 51 · Austin 38 · McAllen 37 · College Station 5 · Accounting 3 · Lubbock 2 · Houston 0.

---

## 2. What the data exposes (the case for the move)

1. **Single-agent offices drown, then dump to voicemail.** McAllen takes ~10 calls/day into a
   *one-agent* main queue; College Station and Lubbock ring a single agent too. When that person is
   on a call or away, Teams presence-routing overflows to voicemail in seconds — leads die there.
2. **Every office dead-ends in shared voicemail.** No classification of *why* someone called
   (new job / existing customer / emergency / vendor / billing), no capture into ServiceTrade.
3. **Reception is a huge, under-instrumented surface** — ~1,240 inbound calls/month, 5:1 inbound,
   and today it's a black hole: no record of who called, why, or whether we ever called back.
4. **After-hours is an external dependency that underperforms.** ~72 after-hours calls/mo, and
   **95% of them (207 of 217) hit the four offices the outside dispatch center covers**
   (San Antonio, Waco, Austin, McAllen). The other offices have little/no after-hours coverage.
   Fire protection is 24/7 emergency work — these are the highest-stakes calls, handled by a vendor
   Devon rates as poor.

---

## 3. The plan

### Insertion approach (keeps Teams intact, low risk)
Do **not** rip out Auto Attendants / Call Queues. Insert the AI at the **dead-ends**: a queue's
overflow / timeout / no-agent action is redirected to the **AI line** (a Teams-forwarded number,
Vapi/Twilio) instead of shared voicemail. The AI answers as that office, classifies the call,
captures the lead into ServiceTrade, and **warm-transfers back into the right Teams queue/person**
(we hold the full direct-number + queue map). Same pattern the codebase already assumes
(Vapi + Twilio forward into Teams).

### Rollout order
- **Pilot: San Antonio first** (HQ, highest volume ≈ 408/mo). *No pilot has started yet.*
- Then the single-agent pain points where overflow is worst: **McAllen**, then College Station /
  Lubbock. Deprioritize Houston (~13/mo).

### In-house after-hours dispatch (replace the external vendor)
Stand up an **AI dispatch** that covers **all** offices 24/7:
- Knows **which office was dialed** (the DID → city) and greets accordingly.
- Reads **caller ID → looks up the customer/site in ServiceTrade** to identify who's calling.
- Confirms with the caller ("Did our **[City]** office service you?") and **transfers to that
  office's on-call**; Teams already has per-office after-hours / on-call queues to hand to.
- **Triages emergency severity** and escalates into Teams; logs the incident against the account.
- Removes the outside dispatch cost + quality problem; extends real coverage to every office.

---

## 4. Metrics to beat (the "after" scorecard)
Measure the pilot against these baselines:
- Inbound answered vs. sent-to-voicemail (target: ~0% unanswered with the AI catching overflow).
- New-lead calls captured into ServiceTrade (today: ~0 from voicemail).
- After-hours calls handled in-house vs. lost/handed to the external vendor.
- Average speed-to-answer and callback rate.
- Per-office call volume + intent mix (net-new visibility we don't have today).

> Deeper cut still to pull: **answered-vs-voicemail rate per office** (needs `callRecords` session
> parsing) to put a hard dollar figure on leads currently lost to the beep.
