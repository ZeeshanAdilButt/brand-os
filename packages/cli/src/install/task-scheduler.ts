import { join } from 'node:path';

export const TASK_NAME = 'content-powerhouse daemon';

/**
 * The single place that decides how the daemon is launched. `conhost.exe --headless` gives node a
 * console with no window (matches spikes/S0-hello README, variant c). UNVERIFIED until the T0.0
 * spike is run: if Windows Hello cannot surface from a headless console, change only this.
 */
export const LAUNCH_EXECUTABLE = 'conhost.exe';
export function launchArguments(nodePath: string, daemonMain: string): string {
  return `--headless "${nodePath}" "${daemonMain}"`;
}

export function daemonMainPath(repoRoot: string): string {
  return join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface TaskXmlOptions {
  nodePath: string;
  daemonMain: string;
  /** `DOMAIN\user`; when absent the trigger fires for any user and the principal is the installer. */
  userId?: string;
}

/**
 * Task Scheduler XML: runs at logon of the installing user, only while that user is logged on
 * (interactive token, least privilege), starts a missed run when it can, never starts a second
 * copy, and restarts a failed run up to 3 times, a minute apart (the daemon logs why it died).
 */
export function buildTaskXml(options: TaskXmlOptions): string {
  const user = options.userId === undefined ? '' : `\n      <UserId>${xml(options.userId)}</UserId>`;
  const principalUser = options.userId === undefined ? '' : `\n      <UserId>${xml(options.userId)}</UserId>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts the content-powerhouse daemon (127.0.0.1:4646) at logon.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${user}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${principalUser}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(LAUNCH_EXECUTABLE)}</Command>
      <Arguments>${xml(launchArguments(options.nodePath, options.daemonMain))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** schtasks reads a task file reliably only as UTF-16 LE with a byte order mark. */
export function encodeTaskXml(text: string): Uint8Array {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

export function taskXmlPath(stateDir: string): string {
  return join(stateDir, 'content-powerhouse-daemon.task.xml');
}

/** The args array for `schtasks`; the XML path is one element, spaces and all. */
export function schtasksCreateArgs(xmlPath: string): string[] {
  return ['/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F'];
}
