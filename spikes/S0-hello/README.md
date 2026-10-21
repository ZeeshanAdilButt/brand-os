# S0: Windows Hello from a headless daemon (spike T0.0)

**Status: RUN on 2026-10-20, result below: Windows Hello is not available on this PC (DeviceNotPresent), so approval mode is click.** The original procedure follows, for a PC that has Hello. Running the script pops a real Windows Hello dialog; Claude never runs it.

## Question

Can a Node process started the way the content-powerhouse daemon will be (Task Scheduler at logon, no visible console) show a Windows Hello dialog **in front** that you can complete, and get back an honest `Verified`? The whole approval design (spec section 2.6, rule 2) depends on the answer.

`verify.ps1` is a Windows PowerShell 5.1 script (`powershell.exe`, not `pwsh`). It calls WinRT `UserConsentVerifier.CheckAvailabilityAsync()`, then `RequestVerificationAsync(<prompt>)`, and prints one line of JSON, for example:

```
{"availability":"Available","result":"Verified"}
```

`result` is `Verified`, `Canceled`, `DeviceNotPresent`, `NotConfiguredForUser`, `DisabledByPolicy`, `DeviceBusy`, `RetriesExhausted`, `NotRequested` (Hello was not available, so no dialog was shown) or `Error` (the script threw; it then also has an `error` field and exits 1). Only `Available` + `Verified` is a yes.

## Procedure (about 15 minutes)

Replace `<repo>` with `<repo>` (the space in the path is on purpose).

### (a) Interactive console

In Windows PowerShell 5.1 (Start menu, "Windows PowerShell", not "PowerShell 7"):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<repo>\spikes\S0-hello\verify.ps1" -Prompt "content-powerhouse test"
```

Complete the dialog (face, fingerprint or PIN). Expect `{"availability":"Available","result":"Verified"}`. Run it again and cancel: expect `Canceled`.

### (b) Node `execFile` with a path that has spaces

Save this as `hello-from-node.mjs` in your temp folder (outside the repo). It is used for both (b) and (c). It runs the spike script the way the daemon will (absolute Windows PowerShell 5.1 path, args array, 120 s timeout, `windowsHide: true`) and writes its result to `hello-result.json` next to it, because a headless run has no console to read:

```js
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const script = '<repo>\\spikes\\S0-hello\\verify.ps1';
const out = join(tmpdir(), 'hello-result.json');
const started = Date.now();
writeFileSync(out, JSON.stringify({ state: 'started', at: new Date().toISOString() }));

execFile(
  powershell,
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Prompt', 'content-powerhouse test'],
  { timeout: 120_000, windowsHide: true },
  (err, stdout, stderr) => {
    const result = {
      state: 'finished',
      ms: Date.now() - started,
      err: err ? { message: err.message, code: err.code, killed: err.killed } : null,
      stdout,
      stderr,
    };
    writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(result);
  },
);
```

Run it from Windows PowerShell:

```powershell
node "$env:TEMP\hello-from-node.mjs"
Get-Content "$env:TEMP\hello-result.json"
```

Record whether the dialog came to the front, and what `stdout` says.

### (c) Started the way the daemon will be (Task Scheduler at logon, headless console)

The daemon's real launch (T0.21) is `conhost.exe --headless "<node.exe>" "<daemon main.js>"`, started by a Task Scheduler logon task. **This is the form to test.** Do not run `node.exe` directly as the task action: that gives the process a visible console, which the daemon will not have, and a pass would prove nothing. (`New-ScheduledTaskSettingsSet -Hidden` only hides the task in the Task Scheduler library; it does not hide or remove any process window.)

Create the task so it runs as you, only when you are logged on, then start it manually:

```powershell
$node    = (Get-Command node).Source          # full path to node.exe
$script  = "$env:TEMP\hello-from-node.mjs"
$action  = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless `"$node`" `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -Hidden
Register-ScheduledTask -TaskName "cph-s0-hello" -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName "cph-s0-hello"
```

Then wait for the dialog (there is no console), complete it, and read `Get-Content "$env:TEMP\hello-result.json"`. Also test once by signing out and back in, so the AtLogOn trigger itself starts it. Delete the task afterwards: `Unregister-ScheduledTask -TaskName "cph-s0-hello" -Confirm:$false`.

Does the Hello dialog appear in front? Can you complete it? If (c) fails, try in this order and record each:

1. `IUserConsentVerifierInterop::RequestVerificationForWindowAsync` with the foreground window handle (the Win32 call that takes an `HWND`).
2. A tiny visible helper window that owns the dialog.

### Also record

- Time from start to dialog on screen (target under 2 s).
- What `Canceled` looks like (stdout and exit code).
- Leave the dialog open past 120 s and record what happens: the `err` (killed / signal), what `stdout` says, and whether the dialog disappears or stays on screen after node gave up.
- Whether computer-use / claude-in-chrome can see the dialog or interact with it. It must not be able to supply a face, fingerprint or PIN. (A screenshot is fine; supplying the credential is not.)

## Results (fill in)

| Variant | Dialog in front? | Completed? | stdout | Time to dialog | Notes |
|---|---|---|---|---|---|
| (a) interactive console | no dialog | no | DeviceNotPresent | n/a | DeviceNotPresent on the owner's PC 2026-10-20; approval mode set to click |
| (b) Node execFile, path with spaces | | | | | |
| (c) Task Scheduler, hidden | | | | | |
| (c) interop with foreground HWND (only if needed) | | | | | |
| (c) visible helper window (only if needed) | | | | | |
| Cancel | | | | | |
| computer-use can interact with the dialog? | | | | | |

Run by: ____  Date: ____  Windows build: ____

## Decision rule

- **Works in (c)** (dialog in front, completable, honest `Verified`): T0.13b implements `presence.verify()` with this script (already copied to `packages/daemon/src/gate/hello.ps1`), and Hello is mandatory.
- **Fails in (c) but works with the interop call or a helper window:** keep T0.13b, change `hello.ps1` to use that technique, and re-run (c).
- **Fails:** build `ElicitationPresence` (MCP `elicitInput`, Claude Code 2.1.76 or later) as the Phase 0 approval channel, and replace the dashboard Approve buttons with "Approve in Claude Code". Tell the owner about the weaker residual risk (spec R1).

Decision: Windows Hello is not available on this PC, so `approval.mode` defaults to `click` (the dashboard click, or an answer to the approval prompt in Claude Code via `approve_in_chat`). `hello` mode stays in the code for a PC that has Hello.
