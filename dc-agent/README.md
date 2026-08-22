# DC agent (on-prem AD inventory)

A read-only agent that runs on a domain controller, reads Active Directory, and posts a snapshot to
the OS. The OS mirrors it and compares it against the employee record to surface accounts that need
cleanup (terminated but still enabled, terminated but still in groups, missing title or mobile, and
enabled accounts with no matching employee). You see all of this on the **Active Directory** page
under Company.

The agent does two things each run: it inventories AD (read-only) and posts the snapshot, then it
pulls any pending write jobs from the OS (for example, create a new-hire account) and runs them,
posting each result back. It is outbound-only: the DC polls the OS, nothing reaches into the DC.

## What it needs

- A domain controller (or any domain-joined Windows host with the `ActiveDirectory` PowerShell
  module) that can reach `https://first-fp-os.fly.dev` outbound over 443.
- A shared token that matches `AGENT_TOKEN` on the server.
- **A run account with the right permissions:**
  - Inventory alone needs only **read** access to the directory.
  - To run **create-user jobs** the account also needs rights to create user objects in the target
    OU and to modify the mapped groups. The clean way is a dedicated service account with delegated
    control over the new-hire OU (Create/Delete user objects) and write membership on the relevant
    groups. Running the task as `SYSTEM` (the computer account) will inventory fine but cannot create
    users, so create jobs will come back as access-denied.

## Setup

1. On the server, set the agent token (a long random string):

   ```
   fly secrets set AGENT_TOKEN='<paste a long random string here>' -a first-fp-os
   ```

2. On the DC, test connectivity and auth:

   ```powershell
   $env:AGENT_TOKEN = '<the same token>'
   .\collect-ad-inventory.ps1 -Ping
   ```

   You should see `OK - reached ... as an authorized agent`.

3. Run a real inventory once and check the Active Directory page in the OS:

   ```powershell
   .\collect-ad-inventory.ps1
   ```

   To scope the read to one container instead of the whole domain, add
   `-SearchBase 'OU=Users,DC=1stfp,DC=local'`.

4. Schedule it every 15 minutes. Store the token in the task rather than a live environment
   variable. Run this in an elevated PowerShell, editing the path and token:

   ```powershell
   $script = 'C:\dc-agent\collect-ad-inventory.ps1'
   $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
     -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Token 'PASTE_TOKEN_HERE'"
   $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
     -RepetitionInterval (New-TimeSpan -Minutes 15)
   Register-ScheduledTask -TaskName '1stFP-AD-Inventory' -Action $action -Trigger $trigger `
     -RunLevel Highest -Description 'Read-only AD inventory for 1st Fire Protection OS'
   ```

   Run it under a dedicated service account with **read** rights to AD. Phase 1 needs nothing more.

## Security notes

- The DC only makes **outbound** HTTPS calls. Nothing opens an inbound port to the domain
  controller.
- The token is a bearer credential. Keep it out of source control, rotate it by setting a new
  `AGENT_TOKEN` on the server and updating the scheduled task.
- The agent reads AD read-only. It cannot change the directory in this phase.

## Files

- `collect-ad-inventory.ps1` - the agent. Reads AD, posts the snapshot. Supports `-Ping`,
  `-SearchBase`, `-Token`, and `-OsBaseUrl`.
